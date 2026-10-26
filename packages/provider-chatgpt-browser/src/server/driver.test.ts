import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import {
  CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
  type ChatGptBrowserHostPort,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import { ChatGptBrowserHostError } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import { ChatGptBrowserDriver } from "./driver.ts";
import { ChatGptBrowserHost, type ChatGptBrowserHostStatus } from "./host.ts";
import { layerMemory as layerMemoryOperationStore } from "./operationRecovery.ts";

const instanceId = ProviderInstanceId.make("chatgptBrowser");
const driverInput = {
  instanceId,
  displayName: "ChatGPT Browser",
  environment: [],
  enabled: true,
  config: ChatGptBrowserDriver.defaultConfig(),
} as const;

const hostIdentity = {
  target: "windows-x64" as const,
  browserRevision: "chromium-1223",
  providerReleaseVersion: "native-test",
  extensionVersion: "2.1.39.1",
};
const testCrypto = Crypto.make({
  randomBytes: (size) => new Uint8Array(size),
  digest: (_algorithm, data) => Effect.succeed(data),
});

const layerForStatus = (
  status: Effect.Effect<ChatGptBrowserHostStatus, ChatGptBrowserHostError>,
  authenticate: Effect.Effect<ChatGptBrowserHostStatus, ChatGptBrowserHostError> = status,
) =>
  Layer.mergeAll(
    Layer.succeed(
      ProviderHost.ProviderHost,
      ProviderHost.ProviderHost.of({
        paths: {
          cwd: "C:\\workspace",
          baseDir: "C:\\t3-test",
          stateDir: "C:\\t3-test\\userdata",
          providerStatusCacheDir: "C:\\t3-test\\caches",
          attachmentsDir: "C:\\t3-test\\attachments",
        },
        settings: {
          get: Effect.die("provider status test does not read global settings"),
          withSnapshot: () => Effect.die("provider status test does not read global settings"),
          changes: Stream.empty,
          subscribe: Effect.succeed(Stream.empty),
        },
        shouldRunBackgroundWork: () => Effect.succeed(false),
        resolveAttachmentPath: () => null,
        credentials: () => Effect.die("provider status test does not read credentials"),
      }),
    ),
    IdAllocator.layer,
    layerMemoryOperationStore,
    Layer.succeed(Crypto.Crypto, testCrypto),
    Layer.succeed(ChatGptBrowserHost, {
      readiness: status.pipe(Effect.map((value) => value.identity)),
      status,
      authenticate,
      open: Effect.die("provider status must not open the durable browser session"),
    }),
  );

describe("ChatGptBrowserDriver", () => {
  it("registers the frozen driver-global operation concurrency policy", () => {
    expect(ChatGptBrowserDriver.metadata.operationConcurrency).toEqual(
      CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
    );
  });

  it("keeps the built-in provider disabled by default", () => {
    expect(ChatGptBrowserDriver.defaultConfig().enabled).toBe(false);
  });

  it.effect("reports the validated bundled browser runtime as ready and selectable", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* ChatGptBrowserDriver.create(driverInput);
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot).toMatchObject({
          instanceId,
          driver: "chatgptBrowser",
          enabled: true,
          installed: true,
          version: "2.1.39.1",
          status: "ready",
          auth: { status: "authenticated", canLogout: false },
          setup: { canAuthenticate: true, canInstall: false },
        });
      }).pipe(
        Effect.provide(
          layerForStatus(
            Effect.succeed({
              identity: hostIdentity,
              authentication: "authenticated",
              availability: "ready",
            }),
          ),
        ),
      ),
    ),
  );

  it.effect(
    "reports a stale managed extension as reconnecting without a terminal provider error",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const instance = yield* ChatGptBrowserDriver.create(driverInput);
          const snapshot = yield* instance.snapshot.refresh;
          expect(snapshot).toMatchObject({
            installed: true,
            status: "warning",
            auth: { status: "authenticated", canLogout: false },
            message:
              "ChatGPT Browser is reconnecting to the managed extension. ChatGPT may still be working.",
          });
        }).pipe(
          Effect.provide(
            layerForStatus(
              Effect.succeed({
                identity: hostIdentity,
                authentication: "authenticated",
                availability: "recovering",
              }),
            ),
          ),
        ),
      ),
  );

  it.effect("reports launch/prerequisite failures as unavailable rather than not installed", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* ChatGptBrowserDriver.create(driverInput);
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot).toMatchObject({
          installed: true,
          status: "error",
          message:
            "ChatGPT Browser failed its managed runtime readiness check (checking-browser-prerequisites).",
        });
      }).pipe(
        Effect.provide(
          layerForStatus(
            Effect.fail(
              new ChatGptBrowserHostError({ operation: "checking-browser-prerequisites" }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("reports a missing bundled release distinctly from a launch failure", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const instance = yield* ChatGptBrowserDriver.create(driverInput);
        const snapshot = yield* instance.snapshot.refresh;
        expect(snapshot).toMatchObject({
          installed: false,
          status: "error",
          message: "The bundled ChatGPT Browser runtime could not be resolved.",
        });
      }).pipe(
        Effect.provide(
          layerForStatus(
            Effect.fail(
              new ChatGptBrowserHostError({ operation: "resolving-native-browser-release" }),
            ),
          ),
        ),
      ),
    ),
  );

  it.effect("keeps a logged-out managed profile unselectable and signs in through T3 auth", () =>
    Effect.scoped(
      Effect.gen(function* () {
        let signedIn = false;
        let authenticateCalls = 0;
        const status = Effect.sync(() => ({
          identity: hostIdentity,
          authentication: signedIn ? ("authenticated" as const) : ("unauthenticated" as const),
          availability: "ready" as const,
        }));
        const authenticate = Effect.sync(() => {
          authenticateCalls += 1;
          signedIn = true;
          return {
            identity: hostIdentity,
            authentication: "authenticated" as const,
            availability: "ready" as const,
          };
        });
        const instance = yield* ChatGptBrowserDriver.create(driverInput).pipe(
          Effect.provide(layerForStatus(status, authenticate)),
        );
        expect(yield* instance.snapshot.refresh).toMatchObject({
          status: "warning",
          auth: { status: "unauthenticated", canLogout: false },
          setup: { canAuthenticate: true, canInstall: false },
          message: "Sign in to ChatGPT in the managed ChatGPT Browser profile.",
        });

        const started = yield* instance.auth!.start("owner");
        expect(started.phase).toBe("starting");
        const succeeded = yield* instance.auth!.subscribe("owner").pipe(
          Stream.filter((state) => state.phase === "succeeded"),
          Stream.runHead,
          Effect.map(Option.getOrThrow),
        );
        expect(succeeded.message).toBe("Sign-in complete.");
        expect(authenticateCalls).toBe(1);
        expect(yield* instance.snapshot.getSnapshot).toMatchObject({
          status: "ready",
          auth: { status: "authenticated", canLogout: false },
        });
      }),
    ),
  );
});
