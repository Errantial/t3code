import { describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
  CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16,
  CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL,
  CHATGPT_BROWSER_PROVIDER_V1_VERSION,
  ChatGptBrowserProviderV1ReadFinalContentRequest,
  ChatGptBrowserProviderV1RequestEnvelope,
  type ChatGptBrowserProviderV1FeatureHandler,
  chatGptBrowserProviderOperationIdForAttempt,
} from "./chatgptBrowserProviderV1.ts";
import { providerOperationConcurrencyKey } from "./driver.ts";

describe("ChatGPT browser provider-v1 contract", () => {
  it("derives one stable provider operation id from the T3 run attempt", () => {
    const attemptId = RunAttemptId.make("attempt-42");

    expect(chatGptBrowserProviderOperationIdForAttempt(attemptId)).toBe(
      "chatgpt-browser:attempt-42",
    );
    expect(chatGptBrowserProviderOperationIdForAttempt(attemptId)).toBe(
      chatGptBrowserProviderOperationIdForAttempt(attemptId),
    );
    expect(chatGptBrowserProviderOperationIdForAttempt(RunAttemptId.make("attempt-43"))).not.toBe(
      chatGptBrowserProviderOperationIdForAttempt(attemptId),
    );
  });

  it("fails closed when the core request envelope version does not match provider-v1", () => {
    const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
      RunAttemptId.make("attempt-42"),
    );
    const decode = Schema.decodeUnknownSync(ChatGptBrowserProviderV1RequestEnvelope);
    const request = {
      protocol: CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL,
      version: CHATGPT_BROWSER_PROVIDER_V1_VERSION,
      requestId: "request-1",
      message: {
        type: "operation.send",
        providerOperationId,
        providerSessionId: ProviderSessionId.make("provider-session-1"),
        text: "hello",
      },
    } as const;

    expect(decode(request)).toEqual(request);
    expect(() => decode({ ...request, version: 2 })).toThrow();
  });

  it("bounds final assistant content reads for exact-operation recovery", () => {
    const decode = Schema.decodeUnknownSync(ChatGptBrowserProviderV1ReadFinalContentRequest);
    const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
      RunAttemptId.make("attempt-final"),
    );

    expect(
      decode({
        type: "assistant.read_final",
        providerOperationId,
        offset: 65_536,
        limit: CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16,
      }),
    ).toEqual({
      type: "assistant.read_final",
      providerOperationId,
      offset: 65_536,
      limit: CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16,
    });
    expect(() =>
      decode({
        type: "assistant.read_final",
        providerOperationId,
        offset: 0,
        limit: CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16 + 1,
      }),
    ).toThrow();
    expect(() =>
      decode({ type: "assistant.read_final", providerOperationId, offset: 0, limit: 1 }),
    ).toThrow();
  });

  it.effect("lets capability schemas attach through the feature handler seam", () =>
    Effect.gen(function* () {
      type ApprovalPayload = { readonly decision: "allow" | "deny" };
      const handler: ChatGptBrowserProviderV1FeatureHandler<
        "approval.answer",
        ApprovalPayload,
        string
      > = {
        feature: "approval.answer",
        handle: (message) => Effect.succeed(message.payload.decision),
      };

      expect(
        yield* handler.handle({
          type: "feature.message",
          feature: "approval.answer",
          payload: { decision: "allow" },
        }),
      ).toBe("allow");
    }),
  );

  it("freezes ChatGPT browser admission at one operation across driver instances", () => {
    const driverKind = ProviderDriverKind.make("chatgptBrowser");
    const first = providerOperationConcurrencyKey({
      policy: CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
      driverKind,
      instanceId: ProviderInstanceId.make("first"),
    });
    const second = providerOperationConcurrencyKey({
      policy: CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
      driverKind,
      instanceId: ProviderInstanceId.make("second"),
    });

    expect(CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY).toEqual({
      scope: "driver",
      supportedConcurrency: 1,
    });
    expect(first).toBe(second);
    expect(first).toBe("driver:chatgptBrowser");
  });
});
