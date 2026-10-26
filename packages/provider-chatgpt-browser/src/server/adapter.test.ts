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
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
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

  it.effect("projects live assistant revisions and tool lifecycle into stable turn items", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-live-stream");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const finalText = "Answer";
        const scriptedEvents: ReadonlyArray<ChatGptBrowserProviderV1CoreEvent> = [
          {
            providerOperationId: operationId,
            sequence: seq(1),
            payload: {
              type: "assistant.revision",
              itemId: "assistant-a",
              ordinal: 0,
              text: "Working",
            },
          },
          {
            providerOperationId: operationId,
            sequence: seq(2),
            payload: {
              type: "tool.revision",
              itemId: "tool-a",
              ordinal: 1,
              toolName: "web.run",
              title: "Browsing Python.org",
              status: "running",
            },
          },
          {
            providerOperationId: operationId,
            sequence: seq(3),
            payload: {
              type: "assistant.revision",
              itemId: "assistant-a",
              ordinal: 0,
              text: "Working more",
            },
          },
          {
            providerOperationId: operationId,
            sequence: seq(4),
            payload: {
              type: "tool.revision",
              itemId: "tool-a",
              ordinal: 1,
              toolName: "web.run",
              title: "Browsed Python.org",
              output: "Python 3.15.1\nhttps://www.python.org/downloads/",
              status: "completed",
            },
          },
          {
            providerOperationId: operationId,
            sequence: seq(5),
            payload: {
              type: "assistant.revision",
              itemId: "assistant-b",
              ordinal: 2,
              text: "Answer",
            },
          },
          {
            providerOperationId: operationId,
            sequence: seq(6),
            payload: {
              type: "assistant.final",
              itemId: "assistant-b",
              ordinal: 2,
              contentHash: "fake-final-content",
              contentLength: finalText.length,
            },
          },
          {
            providerOperationId: operationId,
            sequence: seq(7),
            payload: { type: "operation.terminal", status: "completed" },
          },
          {
            providerOperationId: operationId,
            sequence: seq(8),
            payload: { type: "operation.drained", terminalSequence: seq(7) },
          },
        ];
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: scriptedEvents,
          finalText,
        });
        const operationStore = yield* memoryOperationStore();
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
        yield* runtime.startTurn(turnInput(providerThread, attemptId));
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.tap(checkpointChatGptBrowserProviderEvent),
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const turnItems = events.flatMap((event) =>
          event.type === "turn_item.updated" ? [event.turnItem] : [],
        );
        const firstAssistant = turnItems.filter(
          (
            item,
          ): item is Extract<(typeof turnItems)[number], { readonly type: "assistant_message" }> =>
            item.type === "assistant_message" && item.nativeItemRef?.nativeId === "assistant-a",
        );
        expect(
          firstAssistant.map((item) => [item.text, item.streaming, item.ordinal]),
        ).toContainEqual(["Working more", true, 2]);
        expect(firstAssistant.at(-1)).toMatchObject({
          type: "assistant_message",
          text: "Working more",
          streaming: false,
          status: "completed",
          ordinal: 2,
        });
        const toolItems = turnItems.filter(
          (item) => item.type === "dynamic_tool" && item.nativeItemRef?.nativeId === "tool-a",
        );
        expect(toolItems.map((item) => [item.status, item.ordinal])).toEqual([
          ["running", 4],
          ["completed", 4],
        ]);
        expect(toolItems.at(-1)).toMatchObject({
          type: "dynamic_tool",
          toolName: "web.run",
          title: "Browsed Python.org",
          output: "Python 3.15.1\nhttps://www.python.org/downloads/",
          status: "completed",
          ordinal: 4,
        });
        expect(
          turnItems.findLast(
            (item) =>
              item.type === "assistant_message" && item.nativeItemRef?.nativeId === "assistant-b",
          ),
        ).toMatchObject({
          type: "assistant_message",
          text: "Answer",
          streaming: false,
          status: "completed",
          ordinal: 6,
        });
        expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 8 });
      }),
    ),
  );

  it.effect(
    "rehydrates checkpointed live items on restart so terminal cleanup cannot leave thinking behind",
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const attemptId = RunAttemptId.make("attempt-chatgpt-browser-restart-live-items");
          const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
          const operationStore = yield* memoryOperationStore();
          const fake = makeFakeChatGptBrowserProviderV1Transport({
            providerSessionId,
            initialOperationId: operationId,
            events: [
              {
                providerOperationId: operationId,
                sequence: seq(1),
                payload: {
                  type: "assistant.revision",
                  itemId: "assistant-before-restart",
                  ordinal: 0,
                  text: "Partial answer",
                },
              },
              {
                providerOperationId: operationId,
                sequence: seq(2),
                payload: {
                  type: "tool.revision",
                  itemId: "tool-before-restart",
                  ordinal: 1,
                  toolName: "web.run",
                  title: "Browsing",
                  status: "running",
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
            ],
          });
          const originalRuntime = yield* openRuntime({
            host: host(fake.transport),
            operationStore,
          });
          const originalThread = yield* originalRuntime.ensureThread({
            threadId,
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          const projectedThread: OrchestrationV2ProviderThread = {
            ...originalThread,
            status: "active",
          };
          yield* operationStore.prepare({
            attemptId,
            providerOperationId: operationId,
            providerSessionId,
            providerThreadId: projectedThread.id,
          });
          yield* operationStore.advanceHighWater({
            attemptId,
            providerOperationId: operationId,
            sequence: seq(2),
          });

          const recoveredRuntime = yield* openRuntime({
            host: host(fake.transport),
            operationStore,
          });
          const resumed = yield* recoveredRuntime.resumeThread({
            providerThread: projectedThread,
            threadId,
            modelSelection: { instanceId, model: "default" },
            runtimePolicy: {
              runtimeMode: "full-access",
              interactionMode: "default",
              cwd: "/workspace",
            },
          });
          yield* recoveredRuntime.startTurn(turnInput(resumed, attemptId));
          const events = Array.from(
            yield* recoveredRuntime.events.pipe(
              Stream.tap(checkpointChatGptBrowserProviderEvent),
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            ),
          );
          const turnItems = events.flatMap((event) =>
            event.type === "turn_item.updated" ? [event.turnItem] : [],
          );
          const providerTurns = events.flatMap((event) =>
            event.type === "provider_turn.updated" ? [event.providerTurn] : [],
          );
          const providerThreads = events.flatMap((event) =>
            event.type === "provider_thread.updated" ? [event.providerThread] : [],
          );
          expect(fake.calls.sentOperationIds).toEqual([]);
          expect(fake.calls.replayAfter[0]).toBe(0);
          expect(
            turnItems.findLast(
              (item) =>
                item.type === "assistant_message" &&
                item.nativeItemRef?.nativeId === "assistant-before-restart",
            ),
          ).toMatchObject({
            type: "assistant_message",
            text: "Partial answer",
            streaming: false,
            status: "completed",
          });
          expect(
            turnItems.findLast(
              (item) =>
                item.type === "dynamic_tool" &&
                item.nativeItemRef?.nativeId === "tool-before-restart",
            ),
          ).toMatchObject({
            type: "dynamic_tool",
            status: "completed",
          });
          expect(providerTurns.at(-1)).toMatchObject({ status: "completed" });
          expect(providerThreads.at(-1)).toMatchObject({ status: "idle" });
          expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
          expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
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

  it.effect("replays again when a concurrent sync advances high-water after an empty page", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-concurrent-replay-advance");
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
          { events: [], highWater: seq(2) },
          { events: scriptedEvents.slice(2), highWater: seq(4) },
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
                highWater: seq(4),
                state: "drained" as const,
                terminalStatus: "completed" as const,
                terminalSequence: seq(3),
                drainedThrough: seq(4),
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

        expect(fake.calls.replayAfter).toEqual([0, 2, 2]);
        expect(events.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
      }),
    ),
  );

  it.effect("rebinds a projected thread after restart and recovers without sending again", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-restart-rebind");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          initialOperationId: operationId,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        const originalRuntime = yield* openRuntime({ host: host(fake.transport), operationStore });
        const originalThread = yield* originalRuntime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        const projectedThread: OrchestrationV2ProviderThread = {
          ...originalThread,
          nativeThreadRef: {
            driver: originalThread.driver,
            nativeId: "historical-chatgpt-conversation",
            strength: "strong",
          },
          status: "active",
        };
        yield* operationStore.prepare({
          attemptId,
          providerOperationId: operationId,
          providerSessionId,
          providerThreadId: projectedThread.id,
        });

        const recoveredRuntime = yield* openRuntime({ host: host(fake.transport), operationStore });
        const resumed = yield* recoveredRuntime.resumeThread({
          providerThread: projectedThread,
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        expect(resumed).toMatchObject({
          id: projectedThread.id,
          providerSessionId,
          appThreadId: threadId,
          nativeThreadRef: projectedThread.nativeThreadRef,
          status: "idle",
        });

        yield* recoveredRuntime.startTurn(turnInput(resumed, attemptId));
        yield* recoveredRuntime.events.pipe(
          Stream.filter((event) => event.type === "turn.terminal"),
          Stream.runHead,
        );

        expect(fake.calls.queriedOperationIds).toEqual([operationId]);
        expect(fake.calls.sentOperationIds).toEqual([]);
        expect(fake.calls.replayAfter).toEqual([0]);
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

  it.effect(
    "rehydrates from bounded replay without regressing the durable consumer high-water",
    () =>
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
          const projected = Array.from(
            yield* runtime.events.pipe(
              Stream.tap(checkpointChatGptBrowserProviderEvent),
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            ),
          );
          const assistantItems = projected.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );

          expect(fake.calls.sentOperationIds).toEqual([]);
          expect(fake.calls.replayAfter).toEqual([0]);
          expect(new Set(assistantItems.map((item) => item.id)).size).toBe(1);
          expect(assistantItems.at(-1)).toMatchObject({
            text: "hello",
            streaming: false,
            status: "completed",
          });
          expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
        }),
      ),
  );

  it.effect(
    "replays stale rows idempotently while keeping the durable consumer high-water monotonic",
    () =>
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
          const projected = Array.from(
            yield* runtime.events.pipe(
              Stream.tap(checkpointChatGptBrowserProviderEvent),
              Stream.takeUntil((event) => event.type === "turn.terminal"),
              Stream.runCollect,
            ),
          );
          const assistantItems = projected.flatMap((event) =>
            event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
              ? [event.turnItem]
              : [],
          );

          expect(projected.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
          expect(fake.calls.sentOperationIds).toEqual([]);
          expect(fake.calls.replayAfter).toEqual([0]);
          expect(new Set(assistantItems.map((item) => item.id)).size).toBe(1);
          expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
        }),
      ),
  );

  it.effect("settles a late assistant final as interrupted after a cancelled terminal", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-cancel-late-final");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const operationStore = yield* memoryOperationStore();
        const finalText = "partial assistant text";
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
              payload: {
                type: "assistant.revision",
                itemId: "assistant-late",
                ordinal: 1,
                text: "partial assistant",
              },
            },
            {
              providerOperationId: operationId,
              sequence: seq(3),
              payload: {
                type: "assistant.final",
                itemId: "assistant-late",
                ordinal: 1,
                contentHash: "fake-final-content",
                contentLength: finalText.length,
              },
            },
            {
              providerOperationId: operationId,
              sequence: seq(4),
              payload: { type: "operation.drained", terminalSequence: seq(1) },
            },
          ],
          finalText,
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
        const projected = Array.from(
          yield* runtime.events.pipe(
            Stream.tap(checkpointChatGptBrowserProviderEvent),
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const assistantItems = projected.flatMap((event) =>
          event.type === "turn_item.updated" && event.turnItem.type === "assistant_message"
            ? [event.turnItem]
            : [],
        );

        expect(fake.calls.cancelledOperationIds).toEqual([operationId]);
        expect(assistantItems.at(-1)).toMatchObject({
          text: finalText,
          streaming: false,
          status: "interrupted",
        });
        expect(projected.at(-1)).toMatchObject({ type: "turn.terminal", status: "interrupted" });
        expect(yield* operationStore.get(attemptId)).toMatchObject({ consumerHighWater: 4 });
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

  it.live("recovers a retryable replay interruption without resending the exact operation", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const recoveryLogs: string[] = [];
        const recoveryLogger = Logger.make(({ message }) => {
          recoveryLogs.push(String([message].flat()[0]));
        });
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-replay-error");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const replayError: ChatGptBrowserProviderV1Error = {
          code: "browser_unavailable",
          retryable: true,
          message: "Browser connection closed.",
        };
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        let replayInterrupted = false;
        const recoveringTransport = {
          ...fake.transport,
          replay: (request: Parameters<typeof fake.transport.replay>[0]) => {
            if (!replayInterrupted) {
              replayInterrupted = true;
              fake.calls.replayAfter.push(request.after);
              return Effect.fail(replayError);
            }
            return fake.transport.replay(request);
          },
        };
        const runtime = yield* openRuntime({ host: host(recoveringTransport) });
        const providerThread = yield* runtime.ensureThread({
          threadId,
          modelSelection: { instanceId, model: "default" },
          runtimePolicy: {
            runtimeMode: "full-access",
            interactionMode: "default",
            cwd: "/workspace",
          },
        });
        yield* runtime
          .startTurn(turnInput(providerThread, attemptId))
          .pipe(Effect.provide(Logger.layer([recoveryLogger])));
        const events = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        const sessionStatuses = events.flatMap((event) =>
          event.type === "provider_session.updated" ? [event.providerSession] : [],
        );

        expect(fake.calls.sentOperationIds).toEqual([operationId]);
        expect(fake.calls.replayAfter.slice(0, 2)).toEqual([0, 0]);
        expect(sessionStatuses).toEqual(
          expect.arrayContaining([
            expect.objectContaining({
              status: "starting",
              lastError: null,
            }),
            expect.objectContaining({ status: "running", lastError: null }),
          ]),
        );
        expect(events.at(-1)).toMatchObject({
          type: "turn.terminal",
          status: "completed",
        });
        expect(recoveryLogs).toEqual(
          expect.arrayContaining([
            "ChatGPT Browser transport interrupted; retrying exact operation",
            "ChatGPT Browser transport recovered exact operation",
          ]),
        );
      }),
    ),
  );

  it.live("stops retrying exact cancellation after the turn finishes", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const attemptId = RunAttemptId.make("attempt-chatgpt-browser-cancel-recovery-finished");
        const operationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);
        const replayGate = yield* Deferred.make<void>();
        const cancelAttempted = yield* Deferred.make<void>();
        const retryableError: ChatGptBrowserProviderV1Error = {
          code: "browser_unavailable",
          retryable: true,
          message: "Browser connection closed.",
        };
        const fake = makeFakeChatGptBrowserProviderV1Transport({
          providerSessionId,
          events: coreEvents(operationId, "hello"),
          finalText: "hello",
        });
        let cancelCalls = 0;
        const transport = {
          ...fake.transport,
          replay: (request: Parameters<typeof fake.transport.replay>[0]) =>
            Deferred.await(replayGate).pipe(Effect.andThen(fake.transport.replay(request))),
          cancel: (_request: Parameters<typeof fake.transport.cancel>[0]) =>
            Effect.gen(function* () {
              cancelCalls += 1;
              yield* Deferred.succeed(cancelAttempted, undefined);
              return yield* Effect.fail(retryableError);
            }),
        };
        const runtime = yield* openRuntime({ host: host(transport) });
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
        const started = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "provider_turn.updated"),
            Stream.runCollect,
          ),
        );
        const providerTurn = started.findLast((event) => event.type === "provider_turn.updated");
        expect(providerTurn?.type).toBe("provider_turn.updated");
        if (providerTurn?.type !== "provider_turn.updated") return;

        const interruptFiber = yield* runtime
          .interruptTurn({ providerThread, providerTurnId: providerTurn.providerTurn.id })
          .pipe(Effect.exit, Effect.forkScoped);
        yield* Deferred.await(cancelAttempted);
        yield* Deferred.succeed(replayGate, undefined);
        const terminal = Array.from(
          yield* runtime.events.pipe(
            Stream.takeUntil((event) => event.type === "turn.terminal"),
            Stream.runCollect,
          ),
        );
        expect(terminal.at(-1)).toMatchObject({ type: "turn.terminal", status: "completed" });
        const interrupted = yield* Fiber.join(interruptFiber).pipe(Effect.timeout("1 second"));
        expect(interrupted._tag).toBe("Failure");
        expect(cancelCalls).toBe(1);
        expect(fake.calls.sentOperationIds).toEqual([operationId]);
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
