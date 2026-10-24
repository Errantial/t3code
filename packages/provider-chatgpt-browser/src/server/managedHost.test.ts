import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId } from "@t3tools/contracts";
import type { ChatGptBrowserHostPort } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";

import { makeFakeChatGptBrowserProviderV1Transport } from "../testing.ts";
import { shareChatGptBrowserHost } from "./managedHost.ts";

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
        const physical: ChatGptBrowserHostPort = {
          open: Effect.sync(() => {
            opens += 1;
            return {
              identity: {
                target: "windows-x64" as const,
                browserRevision: "browser-test",
                providerReleaseVersion: "provider-test",
                extensionVersion: "extension-test",
              },
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
});
