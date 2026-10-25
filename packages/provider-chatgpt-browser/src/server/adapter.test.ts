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
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { makeFakeChatGptBrowserProviderV1Transport } from "../testing.ts";
import { makeChatGptBrowserAdapterV2 } from "./adapter.ts";
import {
  ChatGptBrowserOperationStore,
  checkpointChatGptBrowserProviderEvent,
  layerMemory as layerMemoryOperationStore,
  type ChatGptBrowserOperationStoreShape,
} from "./operationRecovery.ts";

const instanceId = ProviderInstanceId.make("chatgptBrowser");
const providerSessionId = ProviderSessionId.make("provider-session-chatgpt-browser-test");
const threadId = ThreadId.make("thread-chatgpt-browser-test");

const host = (
  transport: ReturnType<typeof makeFakeChatGptBrowserProviderV1Transport>["transport"],
): ChatGptBrowserHostPort => ({
  readiness: Effect.succeed({
    target: "windows-x64",
    browserRevision: "browser-test",
    providerReleaseVersion: "provider-test",
    extensionVersion: "extension-test",
  }),
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

function memoryOperationStore() {
  return ChatGptBrowserOperationStore.pipe(Effect.provide(layerMemoryOperationStore));
}

function openRuntime(input: {
  readonly host: ChatGptBrowserHostPort;
  readonly operationStore?: ChatGptBrowserOperationStoreShape;
}) {
  return Effect.gen(function* () {
    const operationStore = input.operationStore ?? (yield* memoryOperationStore());
    const adapter = yield* makeChatGptBrowserAdapterV2({
      instanceId,
      defaultCwd: "/workspace",
      host: input.host,
    }).pipe(Effect.provideService(ChatGptBrowserOperationStore, operationStore));
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
        expect(fake.calls.callOrder.slice(0, 2)).toEqual(["feature", "send"]);
        expect(fake.calls.featureMessages[0]).toMatchObject({
          type: "feature.message",
          feature: "chatgpt-browser.s8",
          providerOperationId: operationId,
          payload: {
            kind: "operation.configure",
            selection: {
              requestedModel: "default",
              selectedModel: "gpt-6-thinking",
              selectedReasoningEffort: "medium",
            },
          },
        });
        expect(fake.calls.replayAfter).toEqual([0]);
        expect(fake.calls.finalReadOffsets).toEqual([0]);
        const finalMessage = events.findLast((event) => event.type === "message.updated");
        expect(
          finalMessage?.type === "message.updated" ? finalMessage.message : undefined,
        ).toMatchObject({ text: finalText, streaming: false });
        const assistantNodes = events.filter(
          (event) => event.type === "node.updated" && event.node.kind === "assistant_message",
        );
        expect(assistantNodes).toHaveLength(2);
        expect(assistantNodes[0]).toMatchObject({
          type: "node.updated",
          node: { status: "running", completedAt: null },
        });
        expect(assistantNodes.at(-1)).toMatchObject({
          type: "node.updated",
          node: { status: "completed" },
        });
        const assistantItems = events.filter(
          (event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message",
        );
        expect(assistantItems).toHaveLength(2);
        expect(assistantItems[0]).toMatchObject({
          type: "turn_item.updated",
          turnItem: { text: "hel", streaming: true, status: "running" },
        });
        expect(assistantItems.at(-1)).toMatchObject({
          type: "turn_item.updated",
          turnItem: { text: finalText, streaming: false, status: "completed" },
        });
        const firstAssistantItem = assistantItems[0];
        const finalAssistantItem = assistantItems.at(-1);
        if (
          finalMessage?.type !== "message.updated" ||
          firstAssistantItem?.type !== "turn_item.updated" ||
          firstAssistantItem.turnItem.type !== "assistant_message" ||
          finalAssistantItem?.type !== "turn_item.updated" ||
          finalAssistantItem.turnItem.type !== "assistant_message"
        ) {
          throw new Error("Expected assistant projection events");
        }
        expect(firstAssistantItem.turnItem.id).toBe(finalAssistantItem.turnItem.id);
        expect(firstAssistantItem.turnItem.ordinal).toBe(finalAssistantItem.turnItem.ordinal);
        expect(finalAssistantItem.turnItem.messageId).toBe(finalMessage.message.id);
        expect(finalAssistantItem.turnItem.nodeId).toBe(finalMessage.message.nodeId);
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
      }),
    ),
  );

  it.live("waits through a terminal settlement gap before the drain event arrives", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-terminal-gap");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const finalText = "hello";
        const scriptedEvents = coreEvents(operationId, finalText);
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: scriptedEvents,
          finalText,
        });
        const operationStore = yield* memoryOperationStore();
        let sent = false;
        let replayIndex = 0;
        const replayPages = [
          { events: scriptedEvents.slice(0, 2), highWater: seq(2) },
          { events: scriptedEvents.slice(2, 3), highWater: seq(3) },
          { events: [], highWater: seq(3) },
          { events: scriptedEvents.slice(3), highWater: seq(4) },
        ] as const;
        const transport = {
          ...fake.transport,
          send: (request: Parameters<typeof fake.transport.send>[0]) =>
            fake.transport.send(request).pipe(Effect.tap(() => Effect.sync(() => (sent = true)))),
          queryOperation: (request: Parameters<typeof fake.transport.queryOperation>[0]) =>
            Effect.sync(() => {
              fake.calls.queriedOperationIds.push(request.providerOperationId);
              if (!sent) {
                return {
                  providerOperationId: request.providerOperationId,
                  providerSessionId,
                  nativeIdentity: {},
                  highWater: seq(0),
                  state: "unknown" as const,
                };
              }
              return {
                providerOperationId: request.providerOperationId,
                providerSessionId,
                nativeIdentity: {},
                highWater: seq(3),
                state: "terminal" as const,
                terminalStatus: "completed" as const,
                terminalSequence: seq(3),
              };
            }),
          replay: (request: Parameters<typeof fake.transport.replay>[0]) =>
            Effect.sync(() => {
              fake.calls.replayAfter.push(request.after);
              const page = replayPages[Math.min(replayIndex, replayPages.length - 1)]!;
              replayIndex += 1;
              return {
                providerOperationId: request.providerOperationId,
                events: page.events,
                highWater: page.highWater,
              };
            }),
        };
        const runtime = yield* openRuntime({ host: host(transport), operationStore });
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
          Stream.tap(checkpointChatGptBrowserProviderEvent),
          Stream.takeUntil((event) => event.type === "turn.terminal"),
          Stream.runCollect,
        );

        expect(fake.calls.replayAfter).toEqual([0, 2, 3, 3]);
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
      }),
    ),
  );

  it.effect("persists the operation before send and only sends after authoritative unknown", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-before-send");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        const runtime = yield* openRuntime({
          host: host(fake.transport),
          operationStore,
        });
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
        const stored = yield* operationStore.get(attemptId);

        expect(stored).toMatchObject({
          providerOperationId: operationId,
          providerSessionId,
          providerThreadId: providerThread.id,
          consumerHighWater: 0,
        });
        expect(fake.calls.queriedOperationIds).toEqual([operationId]);
        expect(fake.calls.sentOperationIds).toEqual([operationId]);
      }),
    ),
  );

  it.effect(
    "requests exact cancellation when send fails after provider ownership may be claimed",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const attemptId = RunAttemptId.make("attempt-chatgpt-browser-send-failure-cleanup");
          const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
          const operationStore = yield* memoryOperationStore();
          const fake = makeFakeChatGptBrowserProviderV1Transport({
            providerSessionId,
            events: [],
            sendError: {
              code: "browser_unavailable",
              retryable: true,
              message: "lost after provider claim",
            },
          });
          const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });

          const started = yield* Effect.exit(
            runtime.startTurn(turnInput(providerThread, attemptId)),
          );

          expect(started._tag).toBe("Failure");
          expect(fake.calls.sentOperationIds).toEqual([operationId]);
          expect(fake.calls.cancelledOperationIds).toEqual([operationId]);
          expect(yield* operationStore.get(attemptId)).toMatchObject({ cancelRequested: true });
        }),
      ),
  );

  it.effect("recovers an accepted unacked operation without sending it again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-accepted-unacked");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          initialOperationId: operationId,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* operationStore.prepare({
          attemptId,
          providerOperationId: operationId,
          providerSessionId,
          providerThreadId: providerThread.id,
        });

        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );

        expect(fake.calls.queriedOperationIds).toEqual([operationId]);
        expect(fake.calls.sentOperationIds).toEqual([]);
        expect(fake.calls.replayAfter).toEqual([0]);
      }),
    ),
  );

  it.effect("resumes replay after the durable consumer high-water", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-drained-unconsumed");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          initialOperationId: operationId,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* operationStore.prepare({
          attemptId,
          providerOperationId: operationId,
          providerSessionId,
          providerThreadId: providerThread.id,
        });
        yield* operationStore.advanceHighWater({
          attemptId,
          providerOperationId: operationId,
          sequence: seq(2),
        });

        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.tap(checkpointChatGptBrowserProviderEvent),
          Stream.runHead,
        );

        expect(fake.calls.sentOperationIds).toEqual([]);
        expect(fake.calls.replayAfter).toEqual([2]);
        expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
      }),
    ),
  );

  it.effect("ignores stale replay rows at or below the durable high-water", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-stale-event");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          initialOperationId: operationId,
          replayIncludesStale: true,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* operationStore.prepare({
          attemptId,
          providerOperationId: operationId,
          providerSessionId,
          providerThreadId: providerThread.id,
        });
        yield* operationStore.advanceHighWater({
          attemptId,
          providerOperationId: operationId,
          sequence: seq(2),
        });

        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        const terminal = yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );

        expect(terminal._tag).toBe("Some");
        expect(fake.calls.replayAfter).toEqual([2]);
      }),
    ),
  );

  it.effect("reissues only the exact durable cancellation after recovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-exact-cancel");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          initialOperationId: operationId,
          events: [
            {
              providerOperationId: operationId,
              sequence: seq(1),
              payload: { type: "operation.terminal", status: "cancelled" },
            },
            {
              providerOperationId: operationId,
              sequence: seq(2),
              payload: { type: "operation.drained", terminalSequence: seq(1) },
            },
          ],
        });
        const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* operationStore.prepare({
          attemptId,
          providerOperationId: operationId,
          providerSessionId,
          providerThreadId: providerThread.id,
        });
        yield* operationStore.requestCancel({ attemptId, providerOperationId: operationId });

        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        yield* runtime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );

        expect(fake.calls.cancelledOperationIds).toEqual([operationId]);
        expect(fake.calls.sentOperationIds).toEqual([]);
      }),
    ),
  );

  it.effect(
    "does not create browser work when a durably cancelled exact operation is unknown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const attemptId = RunAttemptId.make(
            "attempt-chatgpt-browser-cancelled-before-provider-proof",
          );
          const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
          const operationStore = yield* memoryOperationStore();
          const fake = makeFakeChatGptBrowserProviderV1Transport({ providerSessionId, events: [] });
          const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          yield* operationStore.prepare({
            attemptId,
            providerOperationId: operationId,
            providerSessionId,
            providerThreadId: providerThread.id,
          });
          yield* operationStore.requestCancel({ attemptId, providerOperationId: operationId });

          const started = yield* Effect.exit(
            runtime.startTurn(turnInput(providerThread, attemptId)),
          );

          expect(started._tag).toBe("Failure");
          expect(fake.calls.queriedOperationIds).toEqual([operationId]);
          expect(fake.calls.sentOperationIds).toEqual([]);
          expect(fake.calls.cancelledOperationIds).toEqual([]);
        }),
      ),
  );

  it.effect(
    "does not recreate a previously prepared operation when provider state is unknown",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const attemptId = RunAttemptId.make("attempt-chatgpt-browser-recovery-provider-unknown");
          const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
          const operationStore = yield* memoryOperationStore();
          const fake = makeFakeChatGptBrowserProviderV1Transport({ providerSessionId, events: [] });
          const runtime = yield* openRuntime({ host: host(fake.transport), operationStore });
          const providerThread = yield* runtime.ensureThread({
            threadId,
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          yield* operationStore.prepare({
            attemptId,
            providerOperationId: operationId,
            providerSessionId,
            providerThreadId: providerThread.id,
          });

          const started = yield* Effect.exit(
            runtime.startTurn(turnInput(providerThread, attemptId)),
          );

          expect(started._tag).toBe("Failure");
          expect(fake.calls.queriedOperationIds).toEqual([operationId]);
          expect(fake.calls.sentOperationIds).toEqual([]);
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
            readiness: Effect.fail(new ChatGptBrowserHostError({ operation: "readiness" })),
            open: Effect.fail(new ChatGptBrowserHostError({ operation: "open" })),
          },
        }).pipe(Effect.provide(Layer.merge(IdAllocator.layer, layerMemoryOperationStore)));
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
