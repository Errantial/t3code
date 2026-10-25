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
import type { ChatGptBrowserHostService, ChatGptBrowserHostStatus } from "./host.ts";

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

export function makeReusableChatGptBrowserAuthentication(options: {
  readonly open: Effect.Effect<ChatGptBrowserHostSession, ChatGptBrowserHostError>;
  readonly openInteractive: Effect.Effect<ChatGptBrowserHostSession, ChatGptBrowserHostError>;
  readonly authenticateSession: (
    session: ChatGptBrowserHostSession,
  ) => Effect.Effect<ChatGptBrowserHostStatus, ChatGptBrowserHostError>;
}) {
  let retained: ChatGptBrowserHostSession | null = null;
  const authenticate = Effect.suspend(() => {
    if (retained) return options.authenticateSession(retained);
    return Effect.acquireUseRelease(
      options.openInteractive,
      (session) =>
        options.authenticateSession(session).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              retained = session;
            }),
          ),
        ),
      (session) =>
        Effect.suspend(() =>
          retained === session ? Effect.void : session.close.pipe(Effect.ignore),
        ),
    );
  });
  const open = Effect.suspend(() => {
    const session = retained;
    if (!session) return options.open;
    retained = null;
    return Effect.succeed(session);
  });
  const shutdown = Effect.suspend(() => {
    const session = retained;
    if (!session) return Effect.void;
    retained = null;
    return session.close.pipe(Effect.ignore);
  });
  return { authenticate, open, shutdown };
}

/**
 * T3 provider sessions are logical conversations; the managed Chromium process is environment
 * infrastructure. Share one physical host session across those logical sessions and let the
 * T3-owned driver admission policy decide which exact operation may run.
 */
export function shareChatGptBrowserHost(
  host: ChatGptBrowserHostService,
): ChatGptBrowserHostService {
  const lock = Semaphore.makeUnsafe(1);
  let current: { readonly session: ChatGptBrowserHostSession; refs: number } | null = null;

  return {
    // Status/readiness may need to open a short-lived probe browser when no physical session is
    // active. Serialize those acquisitions with provider-session/auth acquisition so the core
    // host's one-browser `requireIdle` fence never sees two legitimate T3 callers racing to open
    // the same managed profile. The fence itself remains fail-closed and concurrency stays one.
    readiness: lock.withPermit(host.readiness),
    status: lock.withPermit(host.status),
    authenticate: lock.withPermit(host.authenticate),
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
  let activeBroker: NativeChatGptBrowserBroker | null = null;
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
            activeBroker = binding.broker;
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
          if (activeBroker === binding.broker) activeBroker = null;
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
  // The resolved provider release is immutable for this host instance. Activate and validate it
  // once before exposing any status/auth/session operation, while no persistent browser session
  // can be open. This removes prepare-vs-open interleavings; `shareChatGptBrowserHost` separately
  // serializes the live status/readiness/auth/session acquisitions that can open the profile.
  yield* managed.prepareRelease;

  const statusForSession = Effect.fn("ChatGptBrowser.statusForSession")(function* (
    session: ChatGptBrowserHostSession,
  ) {
    const broker = activeBroker;
    if (!broker) return yield* hostError("finding-native-browser-broker");
    const authentication =
      broker.authenticationStatus() === "unknown"
        ? yield* Effect.tryPromise({
            try: (signal) => broker.waitForAuthenticationStatus(signal),
            catch: (cause) => hostError("waiting-for-chatgpt-authentication-status", cause),
          }).pipe(
            Effect.timeoutOrElse({
              duration: "10 seconds",
              orElse: () => Effect.succeed("unknown" as const),
            }),
          )
        : broker.authenticationStatus();
    return { identity: session.identity, authentication } satisfies ChatGptBrowserHostStatus;
  });
  const probeStatus = Effect.suspend(() =>
    activeBroker
      ? Effect.succeed({
          identity: options.release.identity,
          authentication: activeBroker.authenticationStatus(),
        } satisfies ChatGptBrowserHostStatus)
      : Effect.acquireUseRelease(managed.open, statusForSession, (session) =>
          session.close.pipe(Effect.ignore),
        ),
  );
  const interactiveArgs = [
    ...(options.release.browserArgs ?? []).filter(
      (argument) => argument !== "--start-minimized" && !argument.startsWith("--window-position="),
    ),
    "--window-position=80,80",
  ];
  const reusableAuthentication = makeReusableChatGptBrowserAuthentication({
    open: managed.open,
    openInteractive: managed.openWithBrowserArgs(interactiveArgs, { visible: true }),
    authenticateSession: (session) =>
      Effect.gen(function* () {
        const broker = activeBroker;
        if (!broker) return yield* hostError("finding-native-browser-broker");
        if (broker.authenticationStatus() !== "authenticated") {
          yield* Effect.tryPromise({
            try: (signal) => broker.waitForAuthentication(signal),
            catch: (cause) => hostError("waiting-for-chatgpt-sign-in", cause),
          });
        }
        return yield* statusForSession(session);
      }),
  });

  return {
    ...managed,
    readiness: probeStatus.pipe(Effect.map((status) => status.identity)),
    status: probeStatus,
    authenticate: reusableAuthentication.authenticate,
    open: reusableAuthentication.open,
    shutdown: reusableAuthentication.shutdown,
  } satisfies ChatGptBrowserManagedHost &
    ChatGptBrowserHostService & { readonly shutdown: Effect.Effect<void> };
});
