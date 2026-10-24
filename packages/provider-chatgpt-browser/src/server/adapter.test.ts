import { describe, expect, it } from "@effect/vitest";
import {
  MessageId,
  NodeId,
  ProviderInstanceId,
  ProviderSessionId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ProviderThread,
} from "@t3tools/contracts";
import {
  ChatGptBrowserProviderV1EventSequence,
  ChatGptBrowserHostError,
  chatGptBrowserProviderOperationIdForAttempt,
  type ChatGptBrowserHostPort,
  type ChatGptBrowserProviderV1CoreEvent,
  type ChatGptBrowserProviderV1Error,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { makeFakeChatGptBrowserProviderV1Transport } from "../testing.ts";
import { makeChatGptBrowserAdapterV2 } from "./adapter.ts";

const instanceId = ProviderInstanceId.make("chatgptBrowser");
const providerSessionId = ProviderSessionId.make("provider-session-chatgpt-browser-test");
const threadId = ThreadId.make("thread-chatgpt-browser-test");

const host = (
  transport: ReturnType<typeof makeFakeChatGptBrowserProviderV1Transport>["transport"],
): ChatGptBrowserHostPort => ({
  open: Effect.succeed({
    identity: {
      target: "linux-x64",
      browserRevision: "test-browser",
      providerReleaseVersion: "test-provider",
      extensionVersion: "test-extension",
    },
    transport,
    close: Effect.void,
  }),
});

const seq = ChatGptBrowserProviderV1EventSequence.make;

function coreEvents(
  operationId: ReturnType<typeof chatGptBrowserProviderOperationIdForAttempt>,
  finalText: string,
): ReadonlyArray<ChatGptBrowserProviderV1CoreEvent> {
  return [
    {
      providerOperationId: operationId,
      sequence: seq(1),
      payload: { type: "assistant.delta", text: "hel" },
    },
    {
      providerOperationId: operationId,
      sequence: seq(2),
      payload: {
        type: "assistant.final",
        contentHash: "fake-final-content",
        contentLength: finalText.length,
      },
    },
    {
      providerOperationId: operationId,
      sequence: seq(3),
      payload: { type: "operation.terminal", status: "completed" },
    },
    {
      providerOperationId: operationId,
      sequence: seq(4),
      payload: { type: "operation.drained", terminalSequence: seq(3) },
    },
  ];
}

function turnInput(
  providerThread: OrchestrationV2ProviderThread,
  attemptId: RunAttemptId,
): ProviderAdapter.ProviderAdapterV2TurnInput {
  return {
    appThread: {} as ProviderAdapter.ProviderAdapterV2TurnInput["appThread"],
    threadId,
    runId: RunId.make("run-chatgpt-browser-test"),
    runOrdinal: 1,
    providerTurnOrdinal: 1,
    attemptId,
    rootNodeId: NodeId.make("node-chatgpt-browser-test"),
    providerThread,
    message: {
      messageId: MessageId.make("message-chatgpt-browser-test"),
      text: "hello",
      attachments: [],
      createdBy: "user",
      creationSource: "web",
    } as ProviderAdapter.ProviderAdapterV2TurnMessage,
    modelSelection: { instanceId, model: "default" },
    runtimePolicy: {
      runtimeMode: "full-access",
      interactionMode: "default",
      cwd: "/workspace",
    },
  };
}

function openRuntime(input: { readonly host: ChatGptBrowserHostPort }) {
  return Effect.gen(function* () {
    const adapter = yield* makeChatGptBrowserAdapterV2({
      instanceId,
      defaultCwd: "/workspace",
      host: input.host,
    });
    return yield* adapter.openSession({
      threadId,
      providerSessionId,
      modelSelection: { instanceId, model: "default" },
      runtimePolicy: {
        runtimeMode: "full-access",
        interactionMode: "default",
        cwd: "/workspace",
      },
    });
  }).pipe(Effect.provide(IdAllocator.layer));
}

describe("ChatGPT Browser ProviderAdapterV2", () => {
  it.effect("maps one frozen provider-v1 operation through final read and drain", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-success");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const finalText = "hello";
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: coreEvents(operationId, finalText),
          finalText,
        });
        const runtime = yield* openRuntime({ host: host(fake.transport) });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );

        expect(fake.calls.sentOperationIds).toEqual([operationId]);
        expect(fake.calls.replayAfter).toEqual([0]);
        expect(fake.calls.finalReadOffsets).toEqual([0]);
        const finalMessage = events.findLast((event) => event.type === "message.updated");
        expect(
          finalMessage?.type === "message.updated" ? finalMessage.message : undefined,
        ).toMatchObject({ text: finalText, streaming: false });
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      }),
    ),
  );

  it.effect("maps a drained provider failure to a V2 failure item and terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-rate-limit");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const error: ChatGptBrowserProviderV1Error = {
          code: "rate_limited",
          retryable: true,
          message: "Try again later.",
        };
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: [
            {
              providerOperationId: operationId,
              sequence: seq(1),
              payload: { type: "operation.terminal", status: "failed", error },
            },
            {
              providerOperationId: operationId,
              sequence: seq(2),
              payload: { type: "operation.drained", terminalSequence: seq(1) },
            },
          ],
        });
        const runtime = yield* openRuntime({ host: host(fake.transport) });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        const events = yield* runtime.events.pipe(
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );
        const failureItem = events.find((event) => event.type === "turn_item.updated");
        const terminal = events.findLast((event) => event.type === "turn.terminal");

        expect(
          failureItem?.type === "turn_item.updated" ? failureItem.turnItem : undefined,
        ).toMatchObject({
          type: "error",
          failure: { class: "usage_limit", code: "rate_limited", retryable: true },
        });
        expect(terminal).toMatchObject({
          type: "turn.terminal",
          status: "failed",
          failure: { class: "usage_limit", code: "rate_limited" },
          threadDisposition: "reusable",
        });
      }),
    ),
  );

  it.effect("fails a replay transport outage through the V2 terminal path", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-replay-error");
        const replayError: ChatGptBrowserProviderV1Error = {
          code: "browser_unavailable",
          retryable: true,
          message: "Browser connection closed.",
        };
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: [],
          replayError,
        });
        const runtime = yield* openRuntime({ host: host(fake.transport) });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );

        expect(terminal._tag).toBe("Some");
        if (terminal._tag === "Some") {
          expect(terminal.value).toMatchObject({
            type: "turn.terminal",
            status: "failed",
            failure: { class: "transport_error", code: "browser_unavailable" },
            threadDisposition: "broken",
          });
        }
      }),
    ),
  );

  it.effect("surfaces an unavailable host as an open-session error", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const adapter = yield* makeChatGptBrowserAdapterV2({
          instanceId,
          defaultCwd: "/workspace",
          host: {
            open: Effect.fail(new ChatGptBrowserHostError({ operation: "open" })),
          },
        }).pipe(Effect.provide(IdAllocator.layer));
        const result = yield* Effect.flip(
          adapter.openSession({
            threadId,
            providerSessionId,
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          }),
        );
        expect(result._tag).toBe("ProviderAdapterOpenSessionError");
      }),
    ),
  );
});
