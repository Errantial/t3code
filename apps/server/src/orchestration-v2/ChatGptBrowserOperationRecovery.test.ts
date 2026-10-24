import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import {
  NodeId,
  ProjectId,
  ProviderInstanceId,
  ProviderSessionId,
  ProviderThreadId,
  RunAttemptId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import {
  CHATGPT_BROWSER_DRIVER_KIND,
  ChatGptBrowserOperationStore,
  layerMemoryChatGptBrowserOperationStore,
} from "@t3tools/provider-chatgpt-browser/server";
import {
  ChatGptBrowserProviderV1EventSequence,
  chatGptBrowserProviderOperationIdForAttempt,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ChatGptBrowserOperationStoreLive from "./ChatGptBrowserOperationStore.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

it.effect(
  "persists exact operation identity, monotonic high-water, and cancellation in SQLite",
  () => {
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const layer = ChatGptBrowserOperationStoreLive.layer.pipe(Layer.provideMerge(database));
    const attemptId = RunAttemptId.make("attempt:chatgpt-browser:sqlite");
    const providerSessionId = ProviderSessionId.make("provider-session:chatgpt-browser:sqlite");
    const providerThreadId = ProviderThreadId.make("provider-thread:chatgpt-browser:sqlite");
    const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(attemptId);

    return Effect.gen(function* () {
      yield* runMigrations();
      const store = yield* ChatGptBrowserOperationStore;
      yield* store.prepare({ attemptId, providerOperationId, providerSessionId, providerThreadId });
      yield* store.advanceHighWater({
        attemptId,
        providerOperationId,
        sequence: ChatGptBrowserProviderV1EventSequence.make(4),
      });
      yield* store.advanceHighWater({
        attemptId,
        providerOperationId,
        sequence: ChatGptBrowserProviderV1EventSequence.make(2),
      });
      yield* store.requestCancel({ attemptId, providerOperationId });

      assert.deepInclude(yield* store.get(attemptId), {
        attemptId,
        providerOperationId,
        providerSessionId,
        providerThreadId,
        consumerHighWater: ChatGptBrowserProviderV1EventSequence.make(4),
        cancelRequested: true,
      });
    }).pipe(Effect.provide(layer));
  },
);

function recoveryProjection(input: { readonly status: "starting" | "running" }) {
  const threadId = ThreadId.make(`thread:chatgpt-browser:recovery:${input.status}`);
  const runId = RunId.make(`run:chatgpt-browser:recovery:${input.status}`);
  const attemptId = RunAttemptId.make(`attempt:chatgpt-browser:recovery:${input.status}`);
  const providerThreadId = ProviderThreadId.make(
    `provider-thread:chatgpt-browser:recovery:${input.status}`,
  );
  const providerSessionId = ProviderSessionId.make(
    `provider-session:chatgpt-browser:recovery:${input.status}`,
  );
  const providerInstanceId = ProviderInstanceId.make("chatgptBrowser");
  const rootNodeId = NodeId.make(`node:chatgpt-browser:recovery:${input.status}`);
  const projection = {
    thread: { id: threadId, projectId: ProjectId.make("project:chatgpt-browser:recovery") },
    runs: [
      {
        id: runId,
        threadId,
        status: input.status,
        providerInstanceId,
        providerThreadId,
        activeAttemptId: attemptId,
        rootNodeId,
        queuePosition: null,
        completedAt: null,
      },
    ],
    attempts: [
      {
        id: attemptId,
        runId,
        providerThreadId,
        providerInstanceId,
        status: input.status === "running" ? "running" : "pending",
      },
    ],
    nodes: [],
    subagents: [],
    runtimeRequests: [],
    providerSessions: [
      {
        id: providerSessionId,
        driver: CHATGPT_BROWSER_DRIVER_KIND,
        providerInstanceId,
        status: "running",
      },
    ],
    providerThreads: [
      {
        id: providerThreadId,
        driver: CHATGPT_BROWSER_DRIVER_KIND,
        providerInstanceId,
        providerSessionId,
        status: "active",
      },
    ],
    providerTurns: [],
    messages: [],
    turnItems: [],
    contextHandoffs: [],
    contextTransfers: [],
  } as unknown as OrchestrationV2ThreadProjection;
  return { projection, threadId, runId, attemptId, providerThreadId, providerSessionId };
}

function recoveryLayer(input: {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly committed: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]>;
  readonly cancelUnsettled: Array<{ readonly effectTypes: ReadonlyArray<string> }>;
}) {
  const deps = Layer.mergeAll(
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getRecoveryThreadIds: () => Effect.succeed([input.projection.thread.id]),
      getRuntimeRecoveryProjection: () => Effect.succeed(input.projection as never),
    }),
    Layer.mock(EventSink.EventSinkV2)({
      commitCommand: (command) => {
        input.committed.push(command);
        return Effect.succeed({ committed: true, cancelledEffectCount: 1 } as never);
      },
    }),
    IdAllocator.layer,
    Layer.mock(EffectWorker.OrchestrationEffectWorkerV2)({
      runRecoveryOnce: Effect.succeed(false),
    }),
    Layer.mock(EffectOutbox.EffectOutboxV2)({
      cancelUnsettled: (request) => {
        input.cancelUnsettled.push(request);
        return Effect.succeed([]);
      },
      signalCancellations: () => Effect.void,
      reconcileAfterProcessLoss: Effect.succeed({ requeued: 0, cancelled: 0 }),
    }),
    layerMemoryChatGptBrowserOperationStore,
  );
  return ProviderRuntimeRecovery.layer.pipe(
    Layer.provide(ServerSettings.layerTest()),
    Layer.provideMerge(deps),
  );
}

it.effect("requeues only the exact journaled ChatGPT Browser attempt after process loss", () => {
  const state = recoveryProjection({ status: "running" });
  const committed: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
  const cancelUnsettled: Array<{ readonly effectTypes: ReadonlyArray<string> }> = [];
  const layer = recoveryLayer({ projection: state.projection, committed, cancelUnsettled });
  const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(state.attemptId);

  return Effect.gen(function* () {
    const store = yield* ChatGptBrowserOperationStore;
    yield* store.prepare({
      attemptId: state.attemptId,
      providerOperationId,
      providerSessionId: state.providerSessionId,
      providerThreadId: state.providerThreadId,
    });
    const summary =
      yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");

    assert.equal(summary.terminalizedRuns, 0);
    assert.equal(summary.stoppedSessions, 0);
    assert.equal(committed.length, 1);
    const command = committed[0];
    assert.equal(command?.events.length, 1);
    assert.equal(command?.events[0]?.type, "run.updated");
    if (command?.events[0]?.type === "run.updated") {
      assert.equal(command.events[0].payload.status, "starting");
      assert.equal(command.events[0].payload.activeAttemptId, state.attemptId);
    }
    assert.deepEqual(
      command?.effects.map((effect) => effect.request),
      [{ type: "chatgpt-browser-operation.recover", runId: state.runId }],
    );
    assert.equal(cancelUnsettled.length, 0);
  }).pipe(Effect.provide(layer));
});

it.effect(
  "preserves an ambiguous running ChatGPT Browser attempt without creating fallback work",
  () => {
    const state = recoveryProjection({ status: "running" });
    const committed: Array<Parameters<EventSink.EventSinkV2["Service"]["commitCommand"]>[0]> = [];
    const cancelUnsettled: Array<{ readonly effectTypes: ReadonlyArray<string> }> = [];
    const layer = recoveryLayer({ projection: state.projection, committed, cancelUnsettled });

    return Effect.gen(function* () {
      const summary =
        yield* (yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService).reconcile("startup");

      assert.equal(summary.terminalizedRuns, 0);
      assert.equal(summary.stoppedSessions, 0);
      assert.equal(committed.length, 0);
      assert.equal(cancelUnsettled.length, 1);
      assert.deepEqual(cancelUnsettled[0]?.effectTypes, [
        "provider-turn.start",
        "provider-turn.interrupt",
        "provider-turn.steer",
        "provider-turn.restart",
        "runtime-request.respond",
      ]);
    }).pipe(Effect.provide(layer));
  },
);
