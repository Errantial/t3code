import {
  ProviderDriverKind,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2TurnItem,
} from "@t3tools/contracts";
import {
  CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16,
  ChatGptBrowserProviderV1Error,
  ChatGptBrowserProviderV1EventSequence,
  chatGptBrowserProviderOperationIdForAttempt,
  type ChatGptBrowserHostPort,
  type ChatGptBrowserProviderOperationId,
  type ChatGptBrowserProviderV1CoreEvent,
  type ChatGptBrowserProviderV1TerminalStatus,
  type ChatGptBrowserProviderV1Transport,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import {
  CHATGPT_BROWSER_S8_FEATURE,
  prepareChatGptBrowserAttachments,
  resolveChatGptBrowserSelection,
  s8FeatureMessage,
  type ChatGptBrowserS8ApprovalSnapshot,
  type ChatGptBrowserS8FeatureTransport,
} from "./features.ts";
import {
  ChatGptBrowserOperationStore,
  type ChatGptBrowserOperationStoreError,
  registerChatGptBrowserProviderEventCheckpoint,
} from "./operationRecovery.ts";

export const CHATGPT_BROWSER_DRIVER_KIND = ProviderDriverKind.make("chatgptBrowser");

export const ChatGptBrowserProviderCapabilitiesV2 = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: false,
    supportsModelSwitchInSession: false,
    supportsProviderSwitchingViaHandoff: false,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: false,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: false,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: false,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: false,
    streamsToolOutput: false,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: false,
    emitsToolStarted: false,
    emitsToolCompleted: false,
    emitsToolOutput: false,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: false,
    supportsFileChangeApproval: false,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: false,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: false,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: false,
    exposesSubagentThreadIds: false,
    emitsSubagentLifecycle: false,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: false,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: false,
    supportsDeltaHandoff: false,
    supportsFullThreadHandoff: false,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: false,
  },
  identity: {
    nativeThreadIds: "none",
    nativeTurnIds: "none",
    nativeItemIds: "none",
    nativeRequestIds: "none",
  },
  runtimePolicy: { enforcement: "client-boundary" },
} satisfies OrchestrationV2ProviderCapabilities;

export interface ChatGptBrowserAdapterV2Options {
  readonly instanceId: ProviderAdapter.ProviderAdapterV2["Service"]["instanceId"];
  readonly defaultCwd: string;
  readonly host: ChatGptBrowserHostPort;
  readonly resolveAttachmentPath?: (
    attachment: ProviderAdapter.ProviderAdapterV2TurnMessage["attachments"][number],
  ) => string | null;
}

interface ActiveApproval {
  readonly documentId: string;
  readonly cardId: string;
  readonly request: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: Extract<OrchestrationV2TurnItem, { type: "approval_request" }>;
}

interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly operationId: ChatGptBrowserProviderOperationId;
  providerTurn: OrchestrationV2ProviderTurn;
  assistantMessage: OrchestrationV2ConversationMessage | undefined;
  assistantItemOrdinal: number | undefined;
  terminal:
    | {
        readonly sequence: number;
        readonly status: ChatGptBrowserProviderV1TerminalStatus;
        readonly error?: ChatGptBrowserProviderV1Error;
      }
    | undefined;
  interruptRequested: boolean;
  finished: boolean;
  nextItemOrdinal: number;
  approval?: ActiveApproval;
}

const isTransportError = Schema.is(ChatGptBrowserProviderV1Error);

function failureFromTransport(
  error: ChatGptBrowserProviderV1Error,
): OrchestrationV2ProviderFailure {
  const failureClass =
    error.code === "rate_limited"
      ? "usage_limit"
      : error.code === "auth_required"
        ? "permission_error"
        : error.code === "protocol_mismatch" || error.code === "invalid_state"
          ? "validation_error"
          : error.code === "browser_unavailable"
            ? "transport_error"
            : "provider_error";
  return makeProviderFailure({
    class: failureClass,
    message: error.message,
    code: error.code,
    retryable: error.retryable,
  });
}

function transportFailureBreaksThread(error: ChatGptBrowserProviderV1Error): boolean {
  return error.code === "protocol_mismatch" || error.code === "browser_unavailable";
}

export const makeChatGptBrowserAdapterV2 = Effect.fn("makeChatGptBrowserAdapterV2")(function* (
  options: ChatGptBrowserAdapterV2Options,
) {
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const operationStore = yield* ChatGptBrowserOperationStore;
  const protocolError = (detail: string, cause?: unknown) =>
    new ProviderAdapter.ProviderAdapterProtocolError({
      driver: CHATGPT_BROWSER_DRIVER_KIND,
      detail,
      ...(cause === undefined ? {} : { cause }),
    });

  return ProviderAdapter.ProviderAdapterV2.of({
    instanceId: options.instanceId,
    driver: CHATGPT_BROWSER_DRIVER_KIND,
    getCapabilities: () => Effect.succeed(ChatGptBrowserProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed(turnScopedSelectionTransition()),
    openSession: Effect.fn("ChatGptBrowserAdapterV2.openSession")(function* (input) {
      if (input.runtimePolicy.interactionMode === "plan") {
        return yield* protocolError(
          "ChatGPT Browser does not expose dedicated Plan mode in provider-v1",
        );
      }
      try {
        resolveChatGptBrowserSelection(input.modelSelection);
      } catch (cause) {
        return yield* protocolError(
          "ChatGPT Browser model or reasoning selection is unsupported",
          cause,
        );
      }

      const scope = yield* Effect.scope;
      const hostSession = yield* options.host.open.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      yield* Effect.addFinalizer(() => hostSession.close.pipe(Effect.ignore));
      const transport = hostSession.transport;
      const featureTransport = transport as ChatGptBrowserProviderV1Transport &
        Partial<ChatGptBrowserS8FeatureTransport>;
      const identity = yield* transport.identity.pipe(
        Effect.mapError(
          (cause) =>
            new ProviderAdapter.ProviderAdapterOpenSessionError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              cause,
            }),
        ),
      );
      if (!identity.ready) {
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          providerSessionId: input.providerSessionId,
          cause: "ChatGPT Browser provider-v1 transport is not ready.",
        });
      }
      if (
        !identity.features.includes(CHATGPT_BROWSER_S8_FEATURE) ||
        typeof featureTransport.feature !== "function"
      ) {
        return yield* new ProviderAdapter.ProviderAdapterOpenSessionError({
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          providerSessionId: input.providerSessionId,
          cause: "ChatGPT Browser S8 feature transport is unavailable.",
        });
      }
      const feature = featureTransport.feature;

      const now = yield* DateTime.now;
      let session: OrchestrationV2ProviderSession = {
        id: input.providerSessionId,
        driver: CHATGPT_BROWSER_DRIVER_KIND,
        providerInstanceId: options.instanceId,
        status: "ready",
        cwd: input.runtimePolicy.cwd ?? options.defaultCwd,
        model: input.modelSelection.model,
        capabilities: ChatGptBrowserProviderCapabilitiesV2,
        createdAt: now,
        updatedAt: now,
        lastError: null,
      };
      let thread: OrchestrationV2ProviderThread | undefined;
      let active: ActiveTurn | undefined;
      const events = yield* Queue.unbounded<
        ProviderAdapter.ProviderAdapterV2Event,
        ProviderAdapter.ProviderAdapterV2Error | Cause.Done
      >();
      const commands = yield* Semaphore.make(1);

      const emit = (
        event: ProviderAdapter.ProviderAdapterV2Event,
        checkpoint?: Effect.Effect<void, ChatGptBrowserOperationStoreError>,
      ) =>
        Effect.sync(() => {
          if (checkpoint !== undefined) {
            registerChatGptBrowserProviderEventCheckpoint(event, checkpoint);
          }
        }).pipe(Effect.andThen(Queue.offer(events, event)), Effect.asVoid);
      const updateSession = Effect.fnUntraced(function* (
        status: OrchestrationV2ProviderSession["status"],
        lastError: string | null = null,
      ) {
        session = { ...session, status, lastError, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_session.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          providerSession: session,
        });
      });
      const updateThread = Effect.fnUntraced(function* (
        patch: Partial<OrchestrationV2ProviderThread>,
      ) {
        if (thread === undefined) return;
        thread = { ...thread, ...patch, updatedAt: yield* DateTime.now };
        yield* emit({
          type: "provider_thread.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          providerThread: thread,
        });
      });
      const ensureBoundThread = Effect.fnUntraced(function* (
        args: ProviderAdapter.ProviderAdapterV2EnsureThreadInput,
      ) {
        const timestamp = yield* DateTime.now;
        const existing = args.existingProviderThread;
        thread = existing
          ? {
              ...existing,
              providerSessionId: input.providerSessionId,
              status: "idle",
              updatedAt: timestamp,
            }
          : {
              id: idAllocator.derive.providerThread({
                driver: CHATGPT_BROWSER_DRIVER_KIND,
                providerInstanceId: options.instanceId,
                nativeThreadId: `app-thread:${args.threadId}`,
              }),
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerInstanceId: options.instanceId,
              providerSessionId: input.providerSessionId,
              appThreadId: args.threadId,
              ownerNodeId: null,
              nativeThreadRef: null,
              nativeConversationHeadRef: null,
              status: "idle",
              firstRunOrdinal: null,
              lastRunOrdinal: null,
              handoffIds: [],
              forkedFrom: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            };
        yield* emit({
          type: "provider_thread.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          providerThread: thread,
        });
        return thread;
      });

      const updateAssistant = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        text: string,
        streaming: boolean,
        checkpointSequence?: ChatGptBrowserProviderV1EventSequence,
      ) {
        const timestamp = yield* DateTime.now;
        const previous = turn.assistantMessage;
        const nativeItemId = `assistant:${turn.operationId}`;
        const nativeItemRef = {
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          nativeId: nativeItemId,
          strength: "weak" as const,
        };
        const nodeId = idAllocator.derive.nodeFromProviderItem({
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          nativeItemId,
        });
        const messageId =
          previous?.id ??
          idAllocator.derive.messageFromProviderItem({
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            nativeItemId,
          });
        const turnItemId = idAllocator.derive.turnItemFromProviderItem({
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          nativeItemId,
        });
        const itemOrdinal = turn.assistantItemOrdinal ?? turn.nextItemOrdinal++;
        turn.assistantItemOrdinal = itemOrdinal;
        const startedAt = previous?.createdAt ?? timestamp;
        const completedAt = streaming ? null : timestamp;
        const node: OrchestrationV2ExecutionNode = {
          id: nodeId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          parentNodeId: turn.input.rootNodeId,
          rootNodeId: turn.input.rootNodeId,
          kind: "assistant_message",
          status: streaming ? "running" : "completed",
          countsForRun: false,
          providerThreadId: turn.providerTurn.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef,
          runtimeRequestId: null,
          checkpointScopeId: null,
          startedAt,
          completedAt,
        };
        const message: OrchestrationV2ConversationMessage = {
          id: messageId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          role: "assistant",
          text,
          attachments: [],
          streaming,
          createdBy: "agent",
          creationSource: "provider",
          createdAt: startedAt,
          updatedAt: timestamp,
        };
        turn.assistantMessage = message;
        const turnItem: Extract<OrchestrationV2TurnItem, { type: "assistant_message" }> = {
          id: turnItemId,
          threadId: turn.input.threadId,
          runId: turn.input.runId,
          nodeId,
          providerThreadId: turn.providerTurn.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          nativeItemRef,
          parentItemId: null,
          ordinal: itemOrdinal,
          status: streaming ? "running" : "completed",
          title: null,
          startedAt,
          completedAt,
          updatedAt: timestamp,
          type: "assistant_message",
          messageId,
          text,
          streaming,
        };
        yield* emit({
          type: "node.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          node,
        });
        yield* emit({
          type: "message.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          message,
        });
        yield* emit(
          {
            type: "turn_item.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            turnItem,
          },
          checkpointSequence === undefined
            ? undefined
            : operationStore.advanceHighWater({
                attemptId: turn.input.attemptId,
                providerOperationId: turn.operationId,
                sequence: checkpointSequence,
              }),
        );
      });

      const readFinalText = Effect.fnUntraced(function* (
        transport: ChatGptBrowserProviderV1Transport,
        turn: ActiveTurn,
        event: Extract<ChatGptBrowserProviderV1CoreEvent["payload"], { type: "assistant.final" }>,
      ) {
        let offset = 0;
        let text = "";
        do {
          const remaining = Math.max(2, event.contentLength - offset);
          const limit = Math.min(CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16, remaining);
          const chunk = yield* transport.readFinalContent({
            type: "assistant.read_final",
            providerOperationId: turn.operationId,
            offset,
            limit,
          });
          if (
            chunk.providerOperationId !== turn.operationId ||
            chunk.offset !== offset ||
            chunk.contentHash !== event.contentHash ||
            chunk.totalLength !== event.contentLength
          ) {
            return yield* protocolError(
              "ChatGPT Browser final content identity changed during read",
            );
          }
          const nextOffset = offset + chunk.text.length;
          if (nextOffset > event.contentLength || (!chunk.complete && nextOffset === offset)) {
            return yield* protocolError("ChatGPT Browser final content read did not make progress");
          }
          if (!chunk.complete && nextOffset === event.contentLength) {
            return yield* protocolError(
              "ChatGPT Browser final content reached its declared length without completing",
            );
          }
          text += chunk.text;
          offset = nextOffset;
          if (chunk.complete) {
            if (offset !== event.contentLength) {
              return yield* protocolError(
                "ChatGPT Browser final content length did not match its event",
              );
            }
            break;
          }
        } while (offset < event.contentLength);
        if (offset !== event.contentLength) {
          return yield* protocolError(
            "ChatGPT Browser final content ended before its declared length",
          );
        }
        return text;
      });

      const finishTurn = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        status: "completed" | "cancelled" | "interrupted" | "failed",
        failure?: OrchestrationV2ProviderFailure,
        disposition: "reusable" | "broken" = "reusable",
        checkpointSequence?: ChatGptBrowserProviderV1EventSequence,
      ) {
        if (turn.finished || active !== turn) return;
        turn.finished = true;
        const completedAt = yield* DateTime.now;
        if (turn.assistantMessage?.streaming) {
          yield* updateAssistant(turn, turn.assistantMessage.text, false);
        }
        if (turn.approval) {
          yield* emit({
            type: "runtime_request.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            threadId: turn.input.threadId,
            runtimeRequest: {
              ...turn.approval.request,
              status: "expired",
              resolvedAt: completedAt,
            },
          });
          yield* emit({
            type: "node.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            node: { ...turn.approval.node, status: "cancelled", completedAt },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            turnItem: {
              ...turn.approval.turnItem,
              status: "cancelled",
              completedAt,
              updatedAt: completedAt,
            },
          });
          delete turn.approval;
        }
        turn.providerTurn = { ...turn.providerTurn, status, completedAt };
        yield* emit({
          type: "provider_turn.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          threadId: turn.input.threadId,
          providerTurn: turn.providerTurn,
        });
        yield* updateThread({
          status: disposition === "broken" ? "error" : "idle",
          lastRunOrdinal: turn.input.runOrdinal,
        });
        yield* updateSession(
          disposition === "broken" ? "error" : "ready",
          failure?.message ?? null,
        );
        active = undefined;
        if (status === "failed" && failure !== undefined) {
          const failureItem = makeProviderFailureTurnItem({
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId: turn.input.rootNodeId,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            itemOrdinal: turn.nextItemOrdinal++,
            failure,
            occurredAt: completedAt,
          });
          yield* emit({
            type: "turn_item.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            turnItem: failureItem,
          });
          const terminalEvent: ProviderAdapter.ProviderAdapterV2Event = {
            type: "turn.terminal",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            runOrdinal: turn.input.runOrdinal,
            failureItemOrdinal: failureItem.ordinal,
            status: "failed",
            failure,
            threadDisposition: disposition,
          };
          yield* emit(
            terminalEvent,
            checkpointSequence === undefined
              ? undefined
              : operationStore.advanceHighWater({
                  attemptId: turn.input.attemptId,
                  providerOperationId: turn.operationId,
                  sequence: checkpointSequence,
                }),
          );
          return;
        }
        const terminalEvent: ProviderAdapter.ProviderAdapterV2Event = {
          type: "turn.terminal",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          providerThreadId: turn.providerTurn.providerThreadId,
          providerTurnId: turn.providerTurn.id,
          runOrdinal: turn.input.runOrdinal,
          status: status === "failed" ? "cancelled" : status,
          failure: null,
          threadDisposition: disposition,
        };
        yield* emit(
          terminalEvent,
          checkpointSequence === undefined
            ? undefined
            : operationStore.advanceHighWater({
                attemptId: turn.input.attemptId,
                providerOperationId: turn.operationId,
                sequence: checkpointSequence,
              }),
        );
      });

      const consumeOperation = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        initialCursor: ChatGptBrowserProviderV1EventSequence,
      ) {
        let cursor = initialCursor;
        let drained = false;
        let drainedSequence: ChatGptBrowserProviderV1EventSequence | undefined;
        while (!drained) {
          const page = yield* transport.replay({
            type: "events.replay",
            providerOperationId: turn.operationId,
            after: cursor,
          });
          if (page.providerOperationId !== turn.operationId) {
            return yield* protocolError("ChatGPT Browser replay returned a different operation");
          }
          let pageAdvanced = false;
          for (const event of page.events) {
            if (
              drained ||
              event.providerOperationId !== turn.operationId ||
              event.sequence > page.highWater
            ) {
              return yield* protocolError("ChatGPT Browser replay event order is invalid");
            }
            // Replay is cursor-based, but an implementation can defensively include an already
            // committed row. T3's durable consumer high-water is authoritative for this process;
            // stale/duplicate rows at or below it have no work left to project.
            if (event.sequence <= cursor) continue;
            pageAdvanced = true;
            cursor = event.sequence;
            switch (event.payload.type) {
              case "assistant.delta":
                yield* updateAssistant(
                  turn,
                  `${turn.assistantMessage?.text ?? ""}${event.payload.text}`,
                  true,
                );
                break;
              case "assistant.final":
                yield* updateAssistant(
                  turn,
                  yield* readFinalText(transport, turn, event.payload),
                  false,
                  event.sequence,
                );
                break;
              case "operation.terminal":
                if (turn.terminal !== undefined) {
                  return yield* protocolError(
                    "ChatGPT Browser replay emitted more than one terminal event",
                  );
                }
                turn.terminal = {
                  sequence: event.sequence,
                  status: event.payload.status,
                  ...(event.payload.error === undefined ? {} : { error: event.payload.error }),
                };
                break;
              case "operation.drained":
                if (
                  turn.terminal === undefined ||
                  event.payload.terminalSequence !== turn.terminal.sequence
                ) {
                  return yield* protocolError(
                    "ChatGPT Browser drain did not reference the observed terminal event",
                  );
                }
                drained = true;
                drainedSequence = event.sequence;
                break;
            }
          }
          if (page.highWater < cursor) {
            return yield* protocolError("ChatGPT Browser replay high-water moved backwards");
          }
          if (!drained && !pageAdvanced) {
            const snapshot = yield* transport.queryOperation({
              type: "operation.query",
              providerOperationId: turn.operationId,
            });
            if (snapshot.providerOperationId !== turn.operationId) {
              return yield* protocolError("ChatGPT Browser query returned a different operation");
            }
            // Provider-v1 publishes terminal before the T3-owned settlement fence can seal drain.
            // During that interval replay is allowed to return an empty page at the same high-water:
            // the terminal row was already observed locally, and the only remaining work is to wait
            // for its matching drain row. Do not busy-spin while the settlement fence is pending.
            if (
              turn.terminal !== undefined &&
              snapshot.state === "terminal" &&
              page.highWater === cursor
            ) {
              yield* Effect.sleep("50 millis");
              continue;
            }
            return yield* protocolError(
              `ChatGPT Browser replay made no progress before drain (state ${snapshot.state})`,
            );
          }
        }

        const terminal = turn.terminal;
        if (terminal === undefined) {
          return yield* protocolError("ChatGPT Browser drained without a terminal event");
        }
        if (terminal.status === "failed") {
          const failure = terminal.error
            ? failureFromTransport(terminal.error)
            : makeProviderFailure({
                class: "provider_error",
                message: "ChatGPT Browser operation failed.",
              });
          yield* finishTurn(
            turn,
            "failed",
            failure,
            terminal.error && transportFailureBreaksThread(terminal.error) ? "broken" : "reusable",
            drainedSequence,
          );
        } else if (terminal.status === "cancelled") {
          yield* finishTurn(
            turn,
            turn.interruptRequested ? "interrupted" : "cancelled",
            undefined,
            "reusable",
            drainedSequence,
          );
        } else {
          yield* finishTurn(turn, "completed", undefined, "reusable", drainedSequence);
        }
      });

      const failBackground = Effect.fnUntraced(function* (turn: ActiveTurn, cause: unknown) {
        if (turn.finished || active !== turn) return;
        const transportError = isTransportError(cause) ? cause : undefined;
        const failure = transportError
          ? failureFromTransport(transportError)
          : makeProviderFailure({
              class: "transport_error",
              message: "ChatGPT Browser transport failed while replaying the operation.",
              code: "transport_error",
              retryable: false,
            });
        yield* finishTurn(
          turn,
          "failed",
          failure,
          transportError && !transportFailureBreaksThread(transportError) ? "reusable" : "broken",
        );
      });

      const publishApproval = Effect.fnUntraced(function* (
        turn: ActiveTurn,
        snapshot: ChatGptBrowserS8ApprovalSnapshot,
      ) {
        const approval = snapshot.approval;
        if (!approval) {
          if (turn.approval) {
            const expiredAt = yield* DateTime.now;
            yield* emit({
              type: "runtime_request.updated",
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              threadId: turn.input.threadId,
              runtimeRequest: {
                ...turn.approval.request,
                status: "expired",
                resolvedAt: expiredAt,
              },
            });
            yield* emit({
              type: "node.updated",
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              node: { ...turn.approval.node, status: "cancelled", completedAt: expiredAt },
            });
            yield* emit({
              type: "turn_item.updated",
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              turnItem: {
                ...turn.approval.turnItem,
                status: "cancelled",
                completedAt: expiredAt,
                updatedAt: expiredAt,
              },
            });
            delete turn.approval;
          }
          return;
        }
        const same =
          turn.approval?.documentId === approval.documentId &&
          turn.approval.cardId === approval.cardId;
        if (!same) {
          if (turn.approval) {
            const staleAt = yield* DateTime.now;
            yield* emit({
              type: "runtime_request.updated",
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              threadId: turn.input.threadId,
              runtimeRequest: {
                ...turn.approval.request,
                status: "expired",
                resolvedAt: staleAt,
              },
            });
          }
          const createdAt = yield* DateTime.now;
          const nativeRequestId = `${approval.documentId}:${approval.cardId}`;
          const requestId = yield* idAllocator.allocate.runtimeRequest({
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            providerTurnId: turn.providerTurn.id,
            nativeRequestId,
          });
          const nodeId = idAllocator.derive.approvalNode({ requestId });
          const node: OrchestrationV2ExecutionNode = {
            id: nodeId,
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            parentNodeId: turn.input.rootNodeId,
            rootNodeId: turn.input.rootNodeId,
            kind: "approval_request",
            status: "waiting",
            countsForRun: false,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: {
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              nativeId: nativeRequestId,
              strength: "weak",
            },
            runtimeRequestId: requestId,
            checkpointScopeId: null,
            startedAt: createdAt,
            completedAt: null,
          };
          const request: OrchestrationV2RuntimeRequest = {
            id: requestId,
            nodeId,
            providerTurnId: turn.providerTurn.id,
            nativeRequestRef: {
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              nativeId: nativeRequestId,
              strength: "weak",
            },
            kind: "permission",
            status: "pending",
            responseCapability: { type: "live", providerSessionId: input.providerSessionId },
            createdAt,
            resolvedAt: null,
          };
          const turnItem: ActiveApproval["turnItem"] = {
            id: idAllocator.derive.approvalTurnItem({ requestId }),
            threadId: turn.input.threadId,
            runId: turn.input.runId,
            nodeId,
            providerThreadId: turn.providerTurn.providerThreadId,
            providerTurnId: turn.providerTurn.id,
            nativeItemRef: node.nativeItemRef,
            parentItemId: null,
            ordinal: turn.nextItemOrdinal++,
            status: "waiting",
            title: null,
            startedAt: createdAt,
            completedAt: null,
            updatedAt: createdAt,
            type: "approval_request",
            requestId,
            requestKind: "permission",
            prompt: approval.lines.join("\n"),
            options: [
              { decision: "accept", label: approval.allow ? "Allow" : "Continue" },
              { decision: "decline", label: "Deny" },
            ],
          };
          turn.approval = {
            documentId: approval.documentId,
            cardId: approval.cardId,
            request,
            node,
            turnItem,
          };
          yield* emit({ type: "node.updated", driver: CHATGPT_BROWSER_DRIVER_KIND, node });
          yield* emit({
            type: "runtime_request.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            threadId: turn.input.threadId,
            runtimeRequest: request,
          });
          yield* emit({ type: "turn_item.updated", driver: CHATGPT_BROWSER_DRIVER_KIND, turnItem });
        }
        if (approval.outcome && turn.approval) {
          const completedAt = yield* DateTime.now;
          const clicked = approval.outcome === "clicked";
          yield* emit({
            type: "runtime_request.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            threadId: turn.input.threadId,
            runtimeRequest: {
              ...turn.approval.request,
              status: clicked ? "resolved" : "expired",
              resolvedAt: completedAt,
            },
          });
          yield* emit({
            type: "node.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            node: {
              ...turn.approval.node,
              status: clicked ? "completed" : "cancelled",
              completedAt,
            },
          });
          yield* emit({
            type: "turn_item.updated",
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            turnItem: {
              ...turn.approval.turnItem,
              status: clicked ? "completed" : "cancelled",
              completedAt,
              updatedAt: completedAt,
            },
          });
          delete turn.approval;
        }
      });

      const watchApprovals = Effect.fnUntraced(function* (turn: ActiveTurn) {
        while (!turn.finished && active === turn) {
          const snapshot = yield* feature(
            s8FeatureMessage(turn.operationId, { kind: "approval.read" }),
          ).pipe(
            Effect.map((value) => value as ChatGptBrowserS8ApprovalSnapshot),
            Effect.catch(() => Effect.succeed(undefined)),
          );
          if (snapshot) yield* publishApproval(turn, snapshot);
          yield* Effect.sleep("200 millis");
        }
      });

      const start = Effect.fnUntraced(function* (args: ProviderAdapter.ProviderAdapterV2TurnInput) {
        if (thread?.id !== args.providerThread.id) {
          return yield* protocolError("ChatGPT Browser turn targeted an unbound provider thread");
        }
        if (active !== undefined) {
          return yield* protocolError("ChatGPT Browser already has an active operation");
        }
        let selection;
        try {
          selection = resolveChatGptBrowserSelection(args.modelSelection);
        } catch (cause) {
          return yield* protocolError(
            "ChatGPT Browser model or reasoning selection is unsupported",
            cause,
          );
        }

        const operationId = chatGptBrowserProviderOperationIdForAttempt(args.attemptId);
        const existingRecovery = yield* operationStore.get(args.attemptId);
        const recovery = yield* operationStore.prepare({
          attemptId: args.attemptId,
          providerOperationId: operationId,
          providerSessionId: input.providerSessionId,
          providerThreadId: args.providerThread.id,
        });
        const snapshot = yield* transport
          .queryOperation({
            type: "operation.query",
            providerOperationId: operationId,
          })
          .pipe(
            Effect.catchIf(
              (error) => error.code === "operation_unknown",
              () =>
                Effect.succeed({
                  providerOperationId: operationId,
                  providerSessionId: input.providerSessionId,
                  nativeIdentity: {},
                  highWater: ChatGptBrowserProviderV1EventSequence.make(0),
                  state: "unknown" as const,
                }),
            ),
          );
        if (snapshot.providerOperationId !== operationId) {
          return yield* protocolError("ChatGPT Browser query returned a different operation");
        }
        if (
          snapshot.state !== "unknown" &&
          snapshot.providerSessionId !== input.providerSessionId
        ) {
          return yield* protocolError("ChatGPT Browser operation belongs to a different session");
        }
        if (snapshot.state === "unknown") {
          if (recovery.cancelRequested) {
            return yield* protocolError(
              "ChatGPT Browser operation is unknown after durable cancellation was requested; recovery will not create new browser work",
            );
          }
          if (existingRecovery !== undefined) {
            return yield* protocolError(
              "ChatGPT Browser exact operation is unknown during recovery; missing provider state is not proof browser work never started",
            );
          }
          const attachments = yield* Effect.tryPromise({
            try: () =>
              prepareChatGptBrowserAttachments({
                attachments: args.message.attachments,
                resolvePath: options.resolveAttachmentPath ?? (() => null),
              }),
            catch: (cause) => protocolError("ChatGPT Browser attachment preparation failed", cause),
          });
          yield* feature(
            s8FeatureMessage(operationId, {
              kind: "operation.configure",
              selection,
              attachments,
            }),
          ).pipe(
            Effect.mapError((cause) =>
              protocolError("ChatGPT Browser S8 operation configuration failed", cause),
            ),
          );
          const receipt = yield* transport
            .send({
              type: "operation.send",
              providerOperationId: operationId,
              providerSessionId: input.providerSessionId,
              text: args.message.text,
            })
            .pipe(
              Effect.tapError(() =>
                Effect.gen(function* () {
                  // A failed send can still have crossed provider-v1's durable claim boundary.
                  // Persist cancellation intent first, then cancel only this exact operation if
                  // browser/provider state proves it exists. Unknown ownership is left untouched;
                  // an authorized-but-unacked send remains fail-closed in the native broker.
                  yield* operationStore.requestCancel({
                    attemptId: args.attemptId,
                    providerOperationId: operationId,
                  });
                  const owned = yield* transport
                    .queryOperation({
                      type: "operation.query",
                      providerOperationId: operationId,
                    })
                    .pipe(Effect.catch(() => Effect.succeed(undefined)));
                  if (
                    owned === undefined ||
                    owned.state === "unknown" ||
                    owned.state === "terminal" ||
                    owned.state === "drained" ||
                    owned.providerSessionId !== input.providerSessionId
                  ) {
                    return;
                  }
                  yield* transport
                    .cancel({ type: "operation.cancel", providerOperationId: operationId })
                    .pipe(Effect.ignore);
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      "Failed to retire ChatGPT Browser operation after send error",
                      {
                        providerOperationId: operationId,
                        runAttemptId: args.attemptId,
                        cause,
                      },
                    ),
                  ),
                ),
              ),
            );
          if (
            receipt.providerOperationId !== operationId ||
            receipt.providerSessionId !== input.providerSessionId
          ) {
            return yield* protocolError(
              "ChatGPT Browser send receipt identity did not match the request",
            );
          }
        }

        const persisted = yield* operationStore.get(args.attemptId);
        if (
          persisted === undefined ||
          persisted.providerOperationId !== operationId ||
          persisted.providerSessionId !== input.providerSessionId ||
          persisted.providerThreadId !== args.providerThread.id
        ) {
          return yield* protocolError(
            "ChatGPT Browser durable operation identity changed during recovery",
          );
        }

        const startedAt = yield* DateTime.now;
        const providerTurn: OrchestrationV2ProviderTurn = {
          id: idAllocator.derive.providerTurn({
            driver: CHATGPT_BROWSER_DRIVER_KIND,
            nativeTurnId: operationId,
          }),
          providerThreadId: args.providerThread.id,
          nodeId: args.rootNodeId,
          runAttemptId: args.attemptId,
          nativeTurnRef: null,
          ordinal: args.providerTurnOrdinal,
          status: "running",
          startedAt,
          completedAt: null,
        };
        const turn: ActiveTurn = {
          input: args,
          operationId,
          providerTurn,
          assistantMessage: undefined,
          assistantItemOrdinal: undefined,
          terminal: undefined,
          interruptRequested: recovery.cancelRequested,
          finished: false,
          nextItemOrdinal: 1,
        };
        active = turn;
        yield* updateSession("running");
        yield* updateThread({
          status: "active",
          firstRunOrdinal: thread?.firstRunOrdinal ?? args.runOrdinal,
          lastRunOrdinal: args.runOrdinal,
        });
        yield* emit({
          type: "provider_turn.updated",
          driver: CHATGPT_BROWSER_DRIVER_KIND,
          threadId: args.threadId,
          providerTurn,
        });
        if (recovery.cancelRequested) {
          const cancelled = yield* transport.cancel({
            type: "operation.cancel",
            providerOperationId: operationId,
          });
          if (cancelled.providerOperationId !== operationId) {
            return yield* protocolError("ChatGPT Browser cancel returned a different operation");
          }
        }
        yield* watchApprovals(turn).pipe(Effect.forkIn(scope));
        yield* consumeOperation(turn, persisted.consumerHighWater).pipe(
          Effect.catch((cause) => failBackground(turn, cause)),
          Effect.forkIn(scope),
        );
      });

      yield* Effect.addFinalizer(() => Queue.end(events).pipe(Effect.ignore));

      return {
        instanceId: options.instanceId,
        driver: CHATGPT_BROWSER_DRIVER_KIND,
        providerSessionId: input.providerSessionId,
        providerSession: session,
        events: Stream.fromQueue(events),
        ensureThread: (args) =>
          ensureBoundThread(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterEnsureThreadError({
                  driver: CHATGPT_BROWSER_DRIVER_KIND,
                  threadId: args.threadId,
                  cause,
                }),
            ),
          ),
        resumeThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterResumeThreadError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerSessionId: input.providerSessionId,
              providerThreadId: args.providerThread.id,
              cause: "ChatGPT Browser restart reconciliation is not part of provider-v1 S1.",
            }),
          ),
        startTurn: (args) =>
          start(args).pipe(
            commands.withPermits(1),
            Effect.mapError(
              (cause) =>
                new ProviderAdapter.ProviderAdapterTurnStartError({
                  driver: CHATGPT_BROWSER_DRIVER_KIND,
                  threadId: args.threadId,
                  providerThreadId: args.providerThread.id,
                  runId: args.runId,
                  cause,
                }),
            ),
          ),
        steerTurn: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterSteerRunUnsupportedError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerThreadId: args.providerThread.id,
            }),
          ),
        interruptTurn: Effect.fn("ChatGptBrowserAdapterV2.interruptTurn")(
          function* (args) {
            const turn = active;
            if (turn === undefined || turn.providerTurn.id !== args.providerTurnId) {
              return yield* protocolError("ChatGPT Browser turn is no longer active");
            }
            turn.interruptRequested = true;
            yield* operationStore.requestCancel({
              attemptId: turn.input.attemptId,
              providerOperationId: turn.operationId,
            });
            const snapshot = yield* transport.cancel({
              type: "operation.cancel",
              providerOperationId: turn.operationId,
            });
            if (snapshot.providerOperationId !== turn.operationId) {
              return yield* protocolError("ChatGPT Browser cancel returned a different operation");
            }
          },
          (effect, args) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterInterruptError({
                    driver: CHATGPT_BROWSER_DRIVER_KIND,
                    providerThreadId: args.providerThread.id,
                    providerTurnId: args.providerTurnId,
                    cause,
                  }),
              ),
            ),
        ),
        respondToRuntimeRequest: Effect.fn("ChatGptBrowserAdapterV2.respondToRuntimeRequest")(
          function* (args) {
            const turn = active;
            const approval = turn?.approval;
            if (!turn || !approval || approval.request.id !== args.requestId) {
              return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CHATGPT_BROWSER_DRIVER_KIND,
                requestId: args.requestId,
                cause: "ChatGPT Browser approval request is no longer active.",
              });
            }
            if (args.decision !== "accept" && args.decision !== "decline") {
              return yield* new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                driver: CHATGPT_BROWSER_DRIVER_KIND,
                requestId: args.requestId,
                cause: "ChatGPT Browser approvals support only one-time Allow or Deny.",
              });
            }
            const token = `${String(args.requestId)}:${approval.cardId}`.slice(0, 64);
            yield* feature(
              s8FeatureMessage(turn.operationId, {
                kind: "approval.answer",
                documentId: approval.documentId,
                cardId: approval.cardId,
                token,
                choice: args.decision === "accept" ? "allow" : "deny",
              }),
            ).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderAdapter.ProviderAdapterRuntimeRequestResponseError({
                    driver: CHATGPT_BROWSER_DRIVER_KIND,
                    requestId: args.requestId,
                    cause,
                  }),
              ),
            );
          },
        ),
        readThreadSnapshot: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterReadThreadSnapshotError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerThreadId: args.providerThread.id,
              cause: "ChatGPT Browser provider-v1 does not expose thread snapshots.",
            }),
          ),
        rollbackThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterRollbackThreadError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerThreadId: args.providerThread.id,
              checkpointId: args.target.checkpointId,
              cause: "ChatGPT Browser provider-v1 does not expose conversation rollback.",
            }),
          ),
        forkThread: (args) =>
          Effect.fail(
            new ProviderAdapter.ProviderAdapterForkThreadError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              providerThreadId: args.sourceProviderThread.id,
              cause: "ChatGPT Browser provider-v1 does not expose native conversation forks.",
            }),
          ),
      } satisfies ProviderAdapter.ProviderAdapterV2SessionRuntime;
    }),
  });
});
