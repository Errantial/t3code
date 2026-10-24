// @effect-diagnostics nodeBuiltinImport:off -- The managed provider state root is a native host path supplied by T3.
import * as NodePath from "node:path";

import {
  chatGptBrowserManagedExtensionBuildId,
  makeChatGptBrowserHost,
  type ChatGptBrowserManagedHost,
  type ChatGptBrowserManagedReleaseDescriptor,
  type ChatGptBrowserManagedReleaseSource,
} from "@t3tools/provider-core/server/chatgptBrowserHost";
import {
  makeChatGptBrowserPlatformForHost,
  type ChatGptBrowserHostPlatformOptions,
} from "@t3tools/provider-core/server/chatgptBrowserPlatform";
import {
  ChatGptBrowserHostError,
  type ChatGptBrowserHostPort,
  type ChatGptBrowserHostSession,
  type ChatGptBrowserPlatformPort,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";

import {
  startNativeChatGptBrowserBroker,
  type NativeChatGptBrowserBroker,
} from "./nativeBrowser.ts";
import {
  type ChatGptBrowserProviderBrowserObservation,
  makeDurableChatGptBrowserRuntime,
  type ChatGptBrowserProviderSecretsPort,
  type ChatGptBrowserProviderSettlementPort,
} from "./runtime.ts";

export interface NativeManagedChatGptBrowserHostOptions {
  readonly rootDirectory: string;
  readonly release: ChatGptBrowserManagedReleaseSource;
  readonly settlement: ChatGptBrowserProviderSettlementPort;
  readonly ports?: ReadonlyArray<number>;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly environment?: NodeJS.ProcessEnv;
  readonly allowBrowserRevisionChange?: (input: {
    readonly active: ChatGptBrowserManagedReleaseDescriptor;
    readonly candidate: ChatGptBrowserManagedReleaseDescriptor;
  }) => Effect.Effect<boolean, ChatGptBrowserHostError>;
}

const hostError = (operation: string, cause?: unknown) =>
  new ChatGptBrowserHostError({ operation, ...(cause === undefined ? {} : { cause }) });

/**
 * T3 provider sessions are logical conversations; the managed Chromium process is environment
 * infrastructure. Share one physical host session across those logical sessions and let the
 * T3-owned driver admission policy decide which exact operation may run.
 */
export function shareChatGptBrowserHost(host: ChatGptBrowserHostPort): ChatGptBrowserHostPort {
  const lock = Semaphore.makeUnsafe(1);
  let current: { readonly session: ChatGptBrowserHostSession; refs: number } | null = null;

  return {
    open: lock.withPermit(
      Effect.gen(function* () {
        if (current === null) current = { session: yield* host.open, refs: 0 };
        const shared = current;
        shared.refs += 1;
        let closed = false;
        const close = lock.withPermit(
          Effect.suspend(() => {
            if (closed) return Effect.void;
            closed = true;
            shared.refs -= 1;
            if (shared.refs > 0) return Effect.void;
            if (current === shared) current = null;
            return shared.session.close;
          }),
        );
        return {
          identity: shared.session.identity,
          transport: shared.session.transport,
          close,
        } satisfies ChatGptBrowserHostSession;
      }),
    ),
  };
}

function secretsFor(platform: ChatGptBrowserPlatformPort): ChatGptBrowserProviderSecretsPort {
  return {
    read: (key) => Effect.runPromise(platform.readSecret(key)),
    write: (key, value) => Effect.runPromise(platform.writeSecret({ key, value })),
    delete: (key) => Effect.runPromise(platform.deleteSecret(key)),
  };
}

function verifyBrowserIdentity(
  release: ChatGptBrowserManagedReleaseSource,
  identity: Awaited<ReturnType<NativeChatGptBrowserBroker["waitForSession"]>>["identity"],
): void {
  if (
    identity.extensionVersion !== release.identity.extensionVersion ||
    identity.extensionBuildId !== chatGptBrowserManagedExtensionBuildId(release.identity) ||
    identity.ready !== true
  ) {
    throw new Error("provider_v1_extension_identity_mismatch");
  }
}

export const makeNativeManagedChatGptBrowserHost = Effect.fn(
  "ChatGptBrowser.makeNativeManagedHost",
)(function* (options: NativeManagedChatGptBrowserHostOptions) {
  const basePlatform = yield* makeChatGptBrowserPlatformForHost({
    rootDirectory: options.rootDirectory,
    ...(options.platform ? { platform: options.platform } : {}),
    ...(options.architecture ? { architecture: options.architecture } : {}),
    ...(options.environment ? { environment: options.environment } : {}),
  } satisfies ChatGptBrowserHostPlatformOptions);
  const secrets = secretsFor(basePlatform);
  interface BrokerBinding {
    readonly broker: NativeChatGptBrowserBroker;
    acceptObservation?: (observation: ChatGptBrowserProviderBrowserObservation) => Promise<void>;
  }
  const brokers = new Map<string, BrokerBinding>();
  const stateDirectory = NodePath.join(options.rootDirectory, "provider-state");

  const platform: ChatGptBrowserPlatformPort = {
    ...basePlatform,
    launchBrowser: (input) =>
      Effect.gen(function* () {
        const expectedExtensionBuildId = chatGptBrowserManagedExtensionBuildId(
          options.release.identity,
        );
        const isBuildMismatch = (cause: unknown) =>
          cause instanceof Error && cause.message === "provider_v1_extension_build_mismatch";

        // Start the loopback authority before Chromium. MV3 workers may be suspended almost
        // immediately after startup; if the browser starts first, its initial provider-v1 probe
        // can miss the listener and the next guaranteed wake is the 30-second alarm. Prebinding
        // makes cold bootstrap deterministic and also removes that race after browser restart.
        //
        // Chromium keeps an unpacked MV3 worker cached even when the stable extension files are
        // updated in place. The stale worker reports its embedded build, receives a mismatch, and
        // calls runtime.reload(); command-line --load-extension is then absent until Chromium is
        // restarted. Relaunch exactly once from the same durable profile/current extension path.
        // Launch one ordinary ChatGPT page. Its managed content script is loaded only after
        // Chromium has registered the unpacked extension and therefore provides a deterministic
        // MV3-worker wake without racing a chrome-extension:// URL against extension startup.
        const wakeUrl = "https://chatgpt.com/";
        for (let attempt = 0; attempt < 2; attempt += 1) {
          let binding!: BrokerBinding;
          binding = {
            broker: yield* Effect.tryPromise({
              try: () =>
                startNativeChatGptBrowserBroker({
                  secrets,
                  ...(options.ports ? { ports: options.ports } : {}),
                  readyTimeoutMs: 45_000,
                  expectedExtensionBuildId,
                  persistObservation: (observation) => {
                    if (!binding.acceptObservation) {
                      return Promise.reject(new Error("provider_observation_sink_not_ready"));
                    }
                    return binding.acceptObservation(observation);
                  },
                }),
              catch: (cause) => hostError("starting-native-browser-broker", cause),
            }),
          };
          const process = yield* basePlatform
            .launchBrowser({
              ...input,
              args: [...input.args, wakeUrl],
            })
            .pipe(
              Effect.onError(() =>
                Effect.tryPromise({
                  try: () => binding.broker.close(),
                  catch: () => undefined,
                }).pipe(Effect.ignore),
              ),
            );
          const ready = yield* Effect.result(
            Effect.tryPromise({
              try: () => binding.broker.waitForSession(),
              catch: (cause) => hostError("waiting-for-native-browser-provider", cause),
            }),
          );
          if (Result.isSuccess(ready)) {
            verifyBrowserIdentity(options.release, ready.success.identity);
            brokers.set(process.opaqueId, binding);
            return process;
          }

          yield* Effect.all([
            Effect.tryPromise({ try: () => binding.broker.close(), catch: () => undefined }).pipe(
              Effect.ignore,
            ),
            basePlatform.stopBrowser(process).pipe(Effect.ignore),
          ]);
          if (attempt === 0 && isBuildMismatch(ready.failure.cause)) continue;
          return yield* ready.failure;
        }
        return yield* Effect.fail(hostError("waiting-for-native-browser-provider"));
      }),
    stopBrowser: (handle) =>
      Effect.gen(function* () {
        const binding = brokers.get(handle.opaqueId);
        if (binding) {
          yield* Effect.tryPromise({
            try: () => binding.broker.close(),
            catch: (cause) => hostError("closing-native-browser-broker", cause),
          }).pipe(Effect.ignore);
          brokers.delete(handle.opaqueId);
        }
        yield* basePlatform.stopBrowser(handle);
      }),
  };

  const validateCandidate = (input: { readonly process: { readonly opaqueId: string } }) =>
    Effect.tryPromise({
      try: async () => {
        const binding = brokers.get(input.process.opaqueId);
        if (!binding) throw new Error("provider_v1_browser_broker_missing");
        const session = await binding.broker.waitForSession();
        verifyBrowserIdentity(options.release, session.identity);
      },
      catch: (cause) => hostError("validating-native-browser-provider", cause),
    });

  const managed = makeChatGptBrowserHost({
    platform,
    release: options.release,
    validateCandidate,
    connectTransport: (input) =>
      Effect.tryPromise({
        try: async () => {
          const binding = brokers.get(input.process.opaqueId);
          if (!binding) throw new Error("provider_v1_browser_broker_missing");
          const session = await binding.broker.waitForSession();
          verifyBrowserIdentity(options.release, session.identity);
          const durable = makeDurableChatGptBrowserRuntime({
            stateDirectory,
            browser: session,
            settlement: options.settlement,
          });
          binding.acceptObservation = durable.acceptObservation;
          return durable.transport;
        },
        catch: (cause) => hostError("connecting-native-browser-provider", cause),
      }),
    ...(options.allowBrowserRevisionChange
      ? { allowBrowserRevisionChange: options.allowBrowserRevisionChange }
      : {}),
  });

  return managed satisfies ChatGptBrowserManagedHost;
});
