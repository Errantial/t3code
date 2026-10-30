import type { ProviderSessionId } from "@t3tools/contracts";
import {
  ChatGptBrowserProviderV1EventSequence,
  type ChatGptBrowserProviderOperationId,
  type ChatGptBrowserProviderV1CoreEvent,
  type ChatGptBrowserProviderV1Error,
  type ChatGptBrowserProviderV1OperationSnapshot,
  type ChatGptBrowserProviderV1ProtocolIdentity,
  type ChatGptBrowserProviderV1Transport,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";

import type { ChatGptBrowserS8FeatureTransport } from "./server/features.ts";

export interface FakeChatGptBrowserProviderV1Script {
  readonly providerSessionId: ProviderSessionId;
  readonly events: ReadonlyArray<ChatGptBrowserProviderV1CoreEvent>;
  readonly initialOperationId?: ChatGptBrowserProviderOperationId;
  readonly replayIncludesStale?: boolean;
  readonly finalText?: string;
  readonly finalContentHash?: string;
  readonly sendError?: ChatGptBrowserProviderV1Error;
  readonly replayError?: ChatGptBrowserProviderV1Error;
}

export interface FakeChatGptBrowserProviderV1Calls {
  readonly sentOperationIds: Array<ChatGptBrowserProviderOperationId>;
  readonly queriedOperationIds: Array<ChatGptBrowserProviderOperationId>;
  readonly cancelledOperationIds: Array<ChatGptBrowserProviderOperationId>;
  readonly replayAfter: Array<number>;
  readonly finalReadOffsets: Array<number>;
  readonly featureMessages: Array<unknown>;
  readonly callOrder: Array<"feature" | "send">;
}

export function makeFakeChatGptBrowserProviderV1Transport(
  script: FakeChatGptBrowserProviderV1Script,
): {
  readonly transport: ChatGptBrowserProviderV1Transport & ChatGptBrowserS8FeatureTransport;
  readonly calls: FakeChatGptBrowserProviderV1Calls;
} {
  const calls: FakeChatGptBrowserProviderV1Calls = {
    sentOperationIds: [],
    queriedOperationIds: [],
    cancelledOperationIds: [],
    replayAfter: [],
    finalReadOffsets: [],
    featureMessages: [],
    callOrder: [],
  };
  let operationId: ChatGptBrowserProviderOperationId | undefined = script.initialOperationId;
  const highWater = script.events.at(-1)?.sequence ?? ChatGptBrowserProviderV1EventSequence.make(0);
  const terminal = script.events.findLast((event) => event.payload.type === "operation.terminal");
  const drained = script.events.findLast((event) => event.payload.type === "operation.drained");
  const finalText = script.finalText ?? "";
  const finalContentHash = script.finalContentHash ?? "fake-final-content";

  const snapshot = (): ChatGptBrowserProviderV1OperationSnapshot => {
    if (operationId === undefined) {
      throw new Error("Fake ChatGPT Browser transport has not received an operation.");
    }
    if (
      terminal?.payload.type === "operation.terminal" &&
      drained?.payload.type === "operation.drained"
    ) {
      return {
        providerOperationId: operationId,
        providerSessionId: script.providerSessionId,
        nativeIdentity: {},
        highWater,
        state: "drained",
        terminalStatus: terminal.payload.status,
        terminalSequence: terminal.sequence,
        drainedThrough: drained.sequence,
        ...(terminal.payload.error === undefined ? {} : { error: terminal.payload.error }),
      };
    }
    if (terminal?.payload.type === "operation.terminal") {
      return {
        providerOperationId: operationId,
        providerSessionId: script.providerSessionId,
        nativeIdentity: {},
        highWater,
        state: "terminal",
        terminalStatus: terminal.payload.status,
        terminalSequence: terminal.sequence,
        ...(terminal.payload.error === undefined ? {} : { error: terminal.payload.error }),
      };
    }
    return {
      providerOperationId: operationId,
      providerSessionId: script.providerSessionId,
      nativeIdentity: {},
      highWater,
      state: "running",
    };
  };

  const identity = {
    protocol: "provider-v1",
    version: 1,
    browserInstanceId: "fake-browser",
    providerInstanceId: "fake-provider",
    extensionVersion: "0.0.0-test",
    extensionBuildId: "test-build",
    ready: true,
    features: ["chatgpt-browser.s8"],
  } as unknown as ChatGptBrowserProviderV1ProtocolIdentity;

  return {
    calls,
    transport: {
      identity: Effect.succeed(identity),
      send: Effect.fn("send")(function* (request) {
        calls.callOrder.push("send");
        calls.sentOperationIds.push(request.providerOperationId);
        operationId = request.providerOperationId;
        if (script.sendError !== undefined) return yield* Effect.fail(script.sendError);
        return {
          type: "operation.send_receipt" as const,
          providerOperationId: request.providerOperationId,
          providerSessionId: request.providerSessionId,
          state: "running" as const,
          nativeIdentity: {},
          highWater,
        };
      }),
      queryOperation: (request) =>
        Effect.sync(() => {
          calls.queriedOperationIds.push(request.providerOperationId);
          if (operationId === undefined) {
            return {
              providerOperationId: request.providerOperationId,
              providerSessionId: script.providerSessionId,
              nativeIdentity: {},
              highWater: ChatGptBrowserProviderV1EventSequence.make(0),
              state: "unknown" as const,
            };
          }
          return snapshot();
        }),
      replay: Effect.fn("replay")(function* (request) {
        calls.replayAfter.push(request.after);
        if (script.replayError !== undefined) return yield* Effect.fail(script.replayError);
        return {
          providerOperationId: request.providerOperationId,
          events: script.replayIncludesStale
            ? script.events
            : script.events.filter((event) => event.sequence > request.after),
          highWater,
        };
      }),
      cancel: (request) =>
        Effect.sync(() => {
          calls.cancelledOperationIds.push(request.providerOperationId);
          return snapshot();
        }),
      readFinalContent: (request) =>
        Effect.sync(() => {
          calls.finalReadOffsets.push(request.offset);
          const text = finalText.slice(request.offset, request.offset + request.limit);
          const nextOffset = request.offset + text.length;
          return {
            type: "assistant.final_chunk" as const,
            providerOperationId: request.providerOperationId,
            offset: request.offset,
            text,
            totalLength: finalText.length,
            contentHash: finalContentHash,
            complete: nextOffset === finalText.length,
          };
        }),
      feature: (message: unknown) =>
        Effect.sync(() => {
          calls.callOrder.push("feature");
          calls.featureMessages.push(message);
          return { ok: true };
        }),
    },
  };
}
