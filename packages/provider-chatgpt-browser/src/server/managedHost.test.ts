import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import { makeFakeChatGptBrowserProviderV1Transport } from "../testing.ts";
import type { ChatGptBrowserHostService } from "./host.ts";
import {
  makeReusableChatGptBrowserAuthentication,
  shareChatGptBrowserHost,
} from "./managedHost.ts";

describe("shared managed ChatGPT browser host", () => {
  it.effect(
    "shares one physical browser across logical provider sessions until the last closes",
    () =>
      Effect.gen(function* () {
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId: ProviderSessionId.make("provider-session-shared-host"),
          events: [],
        });
        let opens = 0;
        let closes = 0;
        const identity = {
          target: "windows-x64" as const,
          browserRevision: "browser-test",
          providerReleaseVersion: "provider-test",
          extensionVersion: "extension-test",
        };
        const physical: ChatGptBrowserHostService = {
          readiness: Effect.succeed(identity),
          status: Effect.succeed({
            identity,
            authentication: "authenticated",
            availability: "ready",
          }),
          authenticate: Effect.succeed({
            identity,
            authentication: "authenticated",
            availability: "ready",
          }),
          open: Effect.sync(() => {
            opens += 1;
            return {
              identity,
              transport: fake.transport,
              close: Effect.sync(() => {
                closes += 1;
              }),
            };
          }),
        };
        const shared = shareChatGptBrowserHost(physical);

        const first = yield* shared.open;
        const second = yield* shared.open;
        expect(opens).toBe(1);
        expect(first.transport).toBe(second.transport);

        yield* first.close;
        expect(closes).toBe(0);
        yield* second.close;
        expect(closes).toBe(1);

        const third = yield* shared.open;
        expect(opens).toBe(2);
        yield* third.close;
        expect(closes).toBe(2);
      }),
  );

  it.effect("serializes a probing status call with provider-session acquisition", () =>
    Effect.gen(function* () {
      const fake = makeFakeChatGptBrowserProviderV1Transport({
        providerSessionId: ProviderSessionId.make("provider-session-status-open-race"),
        events: [],
      });
      const identity = {
        target: "windows-x64" as const,
        browserRevision: "browser-test",
        providerReleaseVersion: "provider-test",
        extensionVersion: "extension-test",
      };
      const statusEntered = yield* Deferred.make<void>();
      const releaseStatus = yield* Deferred.make<void>();
      let probeOpen = false;
      let opens = 0;
      const physical: ChatGptBrowserHostService = {
        readiness: Effect.succeed(identity),
        status: Effect.gen(function* () {
          probeOpen = true;
          yield* Deferred.succeed(statusEntered, undefined);
          yield* Deferred.await(releaseStatus);
          probeOpen = false;
          return {
            identity,
            authentication: "authenticated" as const,
            availability: "ready" as const,
          };
        }),
        authenticate: Effect.succeed({
          identity,
          authentication: "authenticated",
          availability: "ready",
        }),
        open: Effect.sync(() => {
          if (probeOpen) throw new Error("opening-browser-while-browser-open");
          opens += 1;
          return {
            identity,
            transport: fake.transport,
            close: Effect.void,
          };
        }),
      };
      const shared = shareChatGptBrowserHost(physical);

      const statusFiber = yield* Effect.forkChild(shared.status);
      yield* Deferred.await(statusEntered);
      const openFiber = yield* Effect.forkChild(shared.open);
      yield* Effect.yieldNow;
      expect(opens).toBe(0);

      yield* Deferred.succeed(releaseStatus, undefined);
      expect(yield* Fiber.join(statusFiber)).toEqual({
        identity,
        authentication: "authenticated",
        availability: "ready",
      });
      const session = yield* Fiber.join(openFiber);
      expect(opens).toBe(1);
      yield* session.close;
    }),
  );

  it.effect("adopts the authenticated browser without closing or relaunching it", () =>
    Effect.gen(function* () {
      const fake = makeFakeChatGptBrowserProviderV1Transport({
        providerSessionId: ProviderSessionId.make("provider-session-auth-adoption"),
        events: [],
      });
      const identity = {
        target: "windows-x64" as const,
        browserRevision: "browser-test",
        providerReleaseVersion: "provider-test",
        extensionVersion: "extension-test",
      };
      let normalOpens = 0;
      let interactiveOpens = 0;
      let closes = 0;
      const makeSession = (): ChatGptBrowserHostService["open"] extends Effect.Effect<
        infer A,
        unknown
      >
        ? A
        : never => ({
        identity,
        transport: fake.transport,
        close: Effect.sync(() => {
          closes += 1;
        }),
      });
      const reusable = makeReusableChatGptBrowserAuthentication({
        open: Effect.sync(() => {
          normalOpens += 1;
          return makeSession();
        }),
        openInteractive: Effect.sync(() => {
          interactiveOpens += 1;
          return makeSession();
        }),
        authenticateSession: (session) =>
          Effect.succeed({
            identity: session.identity,
            authentication: "authenticated",
            availability: "ready",
          }),
      });
      const physical: ChatGptBrowserHostService = {
        readiness: Effect.succeed(identity),
        status: Effect.succeed({
          identity,
          authentication: "authenticated",
          availability: "ready",
        }),
        authenticate: reusable.authenticate,
        open: reusable.open,
      };
      const shared = shareChatGptBrowserHost(physical);

      expect(yield* shared.authenticate).toEqual({
        identity,
        authentication: "authenticated",
        availability: "ready",
      });
      expect(interactiveOpens).toBe(1);
      expect(normalOpens).toBe(0);
      expect(closes).toBe(0);

      const first = yield* shared.open;
      const second = yield* shared.open;
      expect(interactiveOpens).toBe(1);
      expect(normalOpens).toBe(0);
      expect(first.transport).toBe(second.transport);
      expect(closes).toBe(0);

      yield* first.close;
      expect(closes).toBe(0);
      yield* second.close;
      expect(closes).toBe(1);
    }),
  );

  it.effect("closes the interactive browser when authentication fails", () =>
    Effect.gen(function* () {
      const fake = makeFakeChatGptBrowserProviderV1Transport({
        providerSessionId: ProviderSessionId.make("provider-session-auth-failure"),
        events: [],
      });
      const identity = {
        target: "windows-x64" as const,
        browserRevision: "browser-test",
        providerReleaseVersion: "provider-test",
        extensionVersion: "extension-test",
      };
      let closes = 0;
      const session = {
        identity,
        transport: fake.transport,
        close: Effect.sync(() => {
          closes += 1;
        }),
      };
      const reusable = makeReusableChatGptBrowserAuthentication({
        open: Effect.succeed(session),
        openInteractive: Effect.succeed(session),
        authenticateSession: () => Effect.fail(new Error("sign-in failed") as unknown as never),
      });

      expect(yield* Effect.result(reusable.authenticate)).toMatchObject({ _tag: "Failure" });
      expect(closes).toBe(1);
    }),
  );

  it.effect("closes a retained authenticated browser when the host shuts down", () =>
    Effect.gen(function* () {
      const fake = makeFakeChatGptBrowserProviderV1Transport({
        providerSessionId: ProviderSessionId.make("provider-session-auth-shutdown"),
        events: [],
      });
      const identity = {
        target: "windows-x64" as const,
        browserRevision: "browser-test",
        providerReleaseVersion: "provider-test",
        extensionVersion: "extension-test",
      };
      let closes = 0;
      const session = {
        identity,
        transport: fake.transport,
        close: Effect.sync(() => {
          closes += 1;
        }),
      };
      const reusable = makeReusableChatGptBrowserAuthentication({
        open: Effect.succeed(session),
        openInteractive: Effect.succeed(session),
        authenticateSession: () =>
          Effect.succeed({
            identity,
            authentication: "authenticated" as const,
            availability: "ready" as const,
          }),
      });

      expect(yield* reusable.authenticate).toEqual({
        identity,
        authentication: "authenticated",
        availability: "ready",
      });
      expect(closes).toBe(0);
      yield* reusable.shutdown;
      expect(closes).toBe(1);
      yield* reusable.shutdown;
      expect(closes).toBe(1);
    }),
  );
});
