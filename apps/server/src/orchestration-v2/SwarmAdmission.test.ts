import * as SourceControlProviderRegistry from "../sourceControl/SourceControlProviderRegistry.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type ModelSelection,
  NodeId,
  type OrchestrationV2Command,
  type OrchestratorMcpFailure,
  OrchestratorMcpFailure as OrchestratorMcpFailureClass,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  type ServerProvider,
  SwarmId,
  type SwarmCreateInput,
  type SwarmMemberInput,
  ThreadId,
  TurnItemId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as CheckpointStore from "../checkpointing/CheckpointStore.ts";
import * as ServerConfig from "../config.ts";
import type { McpInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistryTestkit from "../mcp/McpSessionRegistry.testkit.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectEnrichmentService from "../project/ProjectEnrichmentService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ProviderInstanceRegistry from "../provider/ProviderInstanceRegistry.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SwarmService from "../swarm/SwarmService.ts";
import * as SwarmStore from "../swarm/SwarmStore.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as WorkspacePaths from "../workspace/WorkspacePaths.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as RuntimeLayer from "./runtimeLayer.ts";
import * as ThreadCommandExecutor from "./ThreadCommandExecutor.ts";
import * as ThreadLaunchService from "./ThreadLaunchService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";
import { withCreationProvenance } from "./ThreadManagementService.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderTurnStartServiceTestkit from "./ProviderTurnStartService.testkit.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";

// Swarm members queued past the concurrency caps are admitted after the architect's turn ended,
// against the run that anchored their swarm (v1.2.1 plan §4.2, SW-A0).

const layerPlatformTest = Layer.merge(
  NodeServices.layer,
  Layer.mock(SourceControlProviderRegistry.SourceControlProviderRegistry)({
    resolveLink: () => Effect.die("unused title link"),
  }),
);
const layerServerConfig = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3-orchestration-v2-swarm-admission-",
});
const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const driver = ProviderDriverKind.make("codex");
const providerInstance = {
  instanceId: modelSelection.instanceId,
  driverKind: driver,
  continuationIdentity: { driverKind: driver, continuationKey: "codex:test" },
  displayName: "Codex test",
  enabled: true,
  snapshot: { getSnapshot: Effect.succeed({}) } as unknown as ProviderInstance["snapshot"],
  orchestrationAdapter: {
    instanceId: modelSelection.instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: () => Effect.die("sessions are not used by swarm admission tests"),
  } as ProviderAdapter.ProviderAdapterV2["Service"],
  textGeneration: {} as ProviderInstance["textGeneration"],
} satisfies ProviderInstance;

const layerTest = Layer.mergeAll(
  RuntimeLayer.layer,
  RuntimeLayer.layerEventSink,
  ThreadCommandExecutor.layer,
  ProjectionStore.layer,
  EffectOutbox.layer,
  ProviderContinuationRequests.layer,
).pipe(
  Layer.provideMerge(RuntimeLayer.layerProjectService),
  Layer.provide(
    Layer.mock(WorkspacePaths.WorkspacePaths)({
      normalizeWorkspaceRoot: (workspaceRoot) => Effect.succeed(workspaceRoot),
    }),
  ),
  Layer.provide(ProviderTurnStartServiceTestkit.layer),
  Layer.provide(
    Layer.succeed(ProjectEnrichmentService.ProjectEnrichmentService, {
      peek: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      request: () => Effect.void,
      readRepositoryIdentity: () => Effect.succeed(null),
      getAvailable: () =>
        Effect.succeed({
          repositoryIdentity: null,
          faviconPath: null,
          repositoryIdentityResolved: false,
        }),
      invalidate: () => Effect.void,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(McpSessionRegistryTestkit.layer),
  Layer.provide(McpProviderSessions.layer),
  Layer.provide(SqlitePersistence.layerMemory),
  Layer.provide(
    CheckpointStore.layer.pipe(
      Layer.provide(
        VcsDriverRegistry.layer.pipe(
          Layer.provide(VcsProcess.layer),
          Layer.provide(layerServerConfig),
          Layer.provide(layerPlatformTest),
        ),
      ),
    ),
  ),
  Layer.provide(layerServerConfig),
  Layer.provide(ServerSettings.layerTest()),
  Layer.provide(
    Layer.succeed(ProviderInstanceRegistry.ProviderInstanceRegistry, {
      getInstance: (instanceId) =>
        Effect.succeed(instanceId === providerInstance.instanceId ? providerInstance : undefined),
      listInstances: Effect.succeed([providerInstance]),
      listUnavailable: Effect.succeed([]),
      streamChanges: Stream.empty,
      subscribeChanges: Effect.never,
    }),
  ),
  Layer.provide(layerPlatformTest),
);

const providerThreadIdOf = (threadId: ThreadId) =>
  ProviderThreadId.make(`provider-thread:${threadId}`);

const writeProviderThread = (threadId: ThreadId, ownerNodeId: NodeId) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:provider-thread:${threadId}`),
          type: "provider-thread.updated",
          threadId,
          driver,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: providerThreadIdOf(threadId),
            driver,
            providerInstanceId: modelSelection.instanceId,
            providerSessionId: null,
            appThreadId: threadId,
            ownerNodeId,
            nativeThreadRef: { driver, nativeId: `native:${threadId}`, strength: "strong" },
            nativeConversationHeadRef: null,
            status: "active",
            firstRunOrdinal: 1,
            lastRunOrdinal: 1,
            handoffIds: [],
            forkedFrom: null,
            createdAt: now,
            updatedAt: now,
          },
        },
      ],
    });
  });

/** A live provider turn on `threadId`, written the way the runtime projects one. */
const startRun = (input: {
  readonly threadId: ThreadId;
  readonly ordinal: number;
  readonly status?: OrchestrationV2Run["status"];
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const now = yield* DateTime.now;
    const runId = RunId.make(`run:${input.threadId}:${input.ordinal}`);
    const rootNodeId = NodeId.make(`node:${input.threadId}:${input.ordinal}`);
    yield* sink.write({
      events: [
        {
          id: EventId.make(`event:run:${runId}`),
          type: "run.updated",
          threadId: input.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: runId,
            threadId: input.threadId,
            ordinal: input.ordinal,
            providerInstanceId: modelSelection.instanceId,
            modelSelection,
            providerThreadId: providerThreadIdOf(input.threadId),
            userMessageId: MessageId.make(`message:${runId}`),
            rootNodeId,
            activeAttemptId: null,
            status: input.status ?? "running",
            requestedAt: now,
            startedAt: now,
            completedAt: null,
            checkpointId: null,
            contextHandoffId: null,
          },
        },
        {
          id: EventId.make(`event:root:${runId}`),
          type: "node.updated",
          threadId: input.threadId,
          runId,
          nodeId: rootNodeId,
          providerInstanceId: modelSelection.instanceId,
          occurredAt: now,
          payload: {
            id: rootNodeId,
            threadId: input.threadId,
            runId,
            parentNodeId: null,
            rootNodeId,
            kind: "root_turn",
            status: "running",
            countsForRun: true,
            providerThreadId: providerThreadIdOf(input.threadId),
            providerTurnId: null,
            nativeItemRef: null,
            runtimeRequestId: null,
            checkpointScopeId: null,
            startedAt: now,
            completedAt: null,
          },
        },
      ],
    });
    return (yield* orchestrator.getThreadProjection(input.threadId)).runs.find(
      (run) => run.id === runId,
    )!;
  });

/** Ends a run as the provider runtime would, optionally with the assistant's final text. */
const endRun = (input: {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly status?: "completed" | "failed" | "interrupted";
  readonly text?: string;
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const now = yield* DateTime.now;
    const run = (yield* orchestrator.getThreadProjection(input.threadId)).runs.find(
      (candidate) => candidate.id === input.runId,
    )!;
    yield* sink.write({
      events: [
        ...(input.text === undefined
          ? []
          : [
              {
                id: EventId.make(`event:result:${run.id}`),
                type: "message.updated" as const,
                threadId: input.threadId,
                runId: run.id,
                occurredAt: now,
                payload: {
                  id: MessageId.make(`message:result:${run.id}`),
                  threadId: input.threadId,
                  runId: run.id,
                  nodeId: null,
                  role: "assistant" as const,
                  text: input.text,
                  attachments: [],
                  streaming: false,
                  createdBy: "agent" as const,
                  creationSource: "server" as const,
                  createdAt: now,
                  updatedAt: now,
                },
              },
            ]),
        {
          id: EventId.make(`event:end:${run.id}:${input.status ?? "completed"}`),
          type: "run.updated",
          threadId: input.threadId,
          runId: run.id,
          occurredAt: now,
          payload: {
            ...run,
            status: input.status ?? "completed",
            startedAt: run.startedAt ?? now,
            completedAt: now,
          },
        },
      ],
    });
  });

const seedArchitect = (name: string) =>
  Effect.gen(function* () {
    const projects = yield* ProjectService.ProjectService;
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const threadId = ThreadId.make(`thread:${name}`);
    const projectId = ProjectId.make(`project:${name}`);
    yield* projects.create({
      commandId: CommandId.make(`command:project:${name}`),
      projectId,
      title: "Swarm admission",
      workspaceRoot: `/workspace/${name}`,
    });
    yield* orchestrator.dispatch({
      type: "thread.create",
      createdBy: "user",
      creationSource: "web",
      commandId: CommandId.make(`command:create:${name}`),
      threadId,
      projectId,
      title: "Architect",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
    });
    yield* writeProviderThread(threadId, NodeId.make(`node:${threadId}:1`));
    const anchor = yield* startRun({ threadId, ordinal: 1 });
    return { threadId, anchor };
  });

const anchorSwarm = (threadId: ThreadId, runId: RunId, swarmId: SwarmId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.dispatch({
      type: "swarm.anchor",
      commandId: CommandId.make(`swarm-anchor:${swarmId}`),
      threadId,
      runId,
      swarmId,
    });
  });

const memberCommand = (input: {
  readonly threadId: ThreadId;
  readonly anchor: OrchestrationV2Run;
  readonly swarmId: SwarmId | undefined;
  readonly key: string;
}) =>
  ({
    type: "delegated_task.request",
    createdBy: "agent",
    creationSource: input.swarmId === undefined ? "mcp" : "server",
    commandId: CommandId.make(
      `swarm-admit:${input.threadId}:${input.swarmId ?? "live"}:${input.key}:1`,
    ),
    parentThreadId: input.threadId,
    parentRunId: input.anchor.id,
    parentNodeId: input.anchor.rootNodeId!,
    task: `Do part ${input.key}.`,
    title: input.key,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    completionWake: "always",
    ...(input.swarmId === undefined ? {} : { swarmAdmission: { swarmId: input.swarmId } }),
  }) satisfies Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>;

/** Dispatches a member and returns its task and child ids. */
const admit = (input: Parameters<typeof memberCommand>[0]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const result = yield* orchestrator.dispatch(memberCommand(input));
    const task = result.storedEvents.flatMap((stored) =>
      stored.event.type === "subagent.updated" ? [stored.event.payload] : [],
    )[0]!;
    const child = yield* orchestrator.getThreadProjection(task.childThreadId!);
    return { taskId: task.id, childThreadId: task.childThreadId!, childRun: child.runs[0]! };
  });

const admissionError = (input: Parameters<typeof memberCommand>[0]) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const exit = yield* orchestrator.dispatch(memberCommand(input)).pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(exit), "the admission should be refused");
    return Exit.isFailure(exit) ? String(exit.cause) : "";
  });

/** Ends a member's child run with `text` and waits for the parent to record its result. */
const finishMember = (input: {
  readonly parentThreadId: ThreadId;
  readonly taskId: NodeId;
  readonly childThreadId: ThreadId;
  readonly runId: RunId;
  readonly text: string;
}) =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const afterSequence = yield* sink.latestSequence();
    yield* endRun({ threadId: input.childThreadId, runId: input.runId, text: input.text });
    yield* sink.stream({ afterSequence, eventType: "subagent.updated" }).pipe(
      Stream.filter(
        (stored) =>
          stored.event.type === "subagent.updated" &&
          stored.event.payload.id === input.taskId &&
          stored.event.payload.status === "completed",
      ),
      Stream.take(1),
      Stream.runDrain,
      Effect.timeout(Duration.seconds(10)),
    );
  });

/** The next completion wake offered for `threadId`. */
const takeWake = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const requests = yield* ProviderContinuationRequests.ProviderContinuationRequests;
    let wake = yield* requests.take;
    while (wake.threadId !== threadId) wake = yield* requests.take;
    return wake;
  }).pipe(Effect.timeout(Duration.seconds(10)));

/** Delivers the anchor's pending wake the way ProviderContinuationService does. */
const deliverWake = (threadId: ThreadId, parentRunId: RunId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const parent = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
      (run) => run.id === parentRunId,
    )!;
    const delivery = parent.delegatedCompletion!.delivery!;
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      createdBy: "agent",
      creationSource: "server",
      commandId: CommandId.make(`command:deliver:${delivery.messageId}`),
      threadId,
      messageId: delivery.messageId,
      text: "Delegated task completed",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      delegatedCompletion: {
        parentRunId,
        generation: delivery.generation,
        taskIds: delivery.taskIds,
      },
    });
    yield* orchestrator.resumeQueuedRuns;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    return {
      run: projection.runs.find((run) => run.userMessageId === delivery.messageId)!,
      text: projection.messages.find((message) => message.id === delivery.messageId)?.text ?? "",
      taskIds: delivery.taskIds,
    };
  });

it.layer(layerTest)("swarm admission after the anchor run (SW-A0)", (it) => {
  it.effect(
    "Q1: admits against a completed anchor and wakes the architect like an async child",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, anchor } = yield* seedArchitect("q1");
        const swarmId = SwarmId.make("swarm:q1");
        yield* anchorSwarm(threadId, anchor.id, swarmId);
        // The member the caps let in at swarm_create goes through today's live path.
        const live = yield* admit({ threadId, anchor, swarmId: undefined, key: "live" });
        yield* endRun({ threadId, runId: anchor.id });

        const late = yield* admit({ threadId, anchor, swarmId, key: "late" });

        const parent = yield* orchestrator.getThreadProjection(threadId);
        const task = parent.subagents.find((row) => row.id === late.taskId)!;
        const liveTask = parent.subagents.find((row) => row.id === live.taskId)!;
        assert.equal(task.runId, anchor.id);
        assert.equal(task.parentNodeId, anchor.rootNodeId);
        assert.equal(task.status, "running");
        assert.equal(task.origin, liveTask.origin);
        assert.equal(task.completionWake, "always");
        assert.equal(
          parent.nodes.find((node) => node.id === late.taskId)?.runId,
          anchor.id,
          "the subagent node joins the anchor run",
        );
        assert.equal(
          parent.turnItems.find(
            (item) => item.type === "subagent" && item.subagentId === late.taskId,
          )?.runId,
          anchor.id,
        );
        const child = yield* orchestrator.getThreadProjection(late.childThreadId);
        assert.deepEqual(child.thread.lineage, {
          parentThreadId: threadId,
          relationshipToParent: "subagent",
          rootThreadId: threadId,
        });
        assert.deepEqual(child.thread.forkedFrom, { type: "node", nodeId: late.taskId });
        assert.equal(child.runs.length, 1);
        assert.equal(
          child.contextTransfers.find((transfer) => transfer.type === "subagent_spawn")
            ?.targetRunId,
          late.childRun.id,
        );
        assert.equal(
          parent.runs.find((run) => run.id === anchor.id)?.delegatedCompletion?.swarmIds?.[0],
          swarmId,
        );

        // Both members wake the architect through the anchor's cohort, one delivery each.
        yield* finishMember({
          parentThreadId: threadId,
          taskId: live.taskId,
          childThreadId: live.childThreadId,
          runId: live.childRun.id,
          text: "live member done",
        });
        const firstWake = yield* takeWake(threadId);
        assert.equal(firstWake.delegatedCompletion?.parentRunId, anchor.id);
        const first = yield* deliverWake(threadId, anchor.id);
        assert.deepEqual(first.taskIds, [live.taskId]);
        yield* endRun({ threadId, runId: first.run.id });

        yield* finishMember({
          parentThreadId: threadId,
          taskId: late.taskId,
          childThreadId: late.childThreadId,
          runId: late.childRun.id,
          text: "late member done",
        });
        const secondWake = yield* takeWake(threadId);
        assert.equal(secondWake.delegatedCompletion?.parentRunId, anchor.id);
        assert.isAbove(
          secondWake.delegatedCompletion!.generation,
          firstWake.delegatedCompletion!.generation,
        );
        const second = yield* deliverWake(threadId, anchor.id);
        assert.deepEqual(second.taskIds, [late.taskId]);
        assert.include(second.text, "late member done");
        assert.notEqual(second.run.status, "queued");
        const cohort = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === anchor.id,
        )!.delegatedCompletion!;
        assert.equal(cohort.disposition, "open");
        assert.deepEqual(cohort.swarmIds, [swarmId], "planning keeps the anchor marker");
      }),
  );

  it.effect("Q1: admits after a failed anchor run, as the plan requires", () =>
    Effect.gen(function* () {
      const { threadId, anchor } = yield* seedArchitect("q1-failed");
      const swarmId = SwarmId.make("swarm:q1-failed");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id, status: "failed" });
      const late = yield* admit({ threadId, anchor, swarmId, key: "after-failure" });
      yield* finishMember({
        parentThreadId: threadId,
        taskId: late.taskId,
        childThreadId: late.childThreadId,
        runId: late.childRun.id,
        text: "done after the architect failed",
      });
      assert.equal((yield* takeWake(threadId)).delegatedCompletion?.parentRunId, anchor.id);
    }),
  );

  it.effect("Q1: today's path still refuses an ended parent run without swarmAdmission", () =>
    Effect.gen(function* () {
      const { threadId, anchor } = yield* seedArchitect("q1-plain");
      yield* anchorSwarm(threadId, anchor.id, SwarmId.make("swarm:q1-plain"));
      yield* endRun({ threadId, runId: anchor.id });
      const error = yield* admissionError({ threadId, anchor, swarmId: undefined, key: "plain" });
      assert.include(error, "is not active");
    }),
  );

  it.effect("Q2: a Stop on the anchor run refuses every later admission", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-anchor");
      const swarmId = SwarmId.make("swarm:q2-anchor");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:q2-anchor-stop"),
        threadId,
      });
      const stopped = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === anchor.id,
      )!;
      // holdStoppedThread stops every anchored cohort, even one with only queued rows.
      assert.equal(stopped.delegatedCompletion?.disposition, "stopped");
      assert.deepEqual(stopped.delegatedCompletion?.swarmIds, [swarmId]);
      assert.include(
        yield* admissionError({ threadId, anchor, swarmId, key: "while-stopping" }),
        "no longer admits members",
      );
      yield* endRun({ threadId, runId: anchor.id, status: "interrupted" });
      assert.include(
        yield* admissionError({ threadId, anchor, swarmId, key: "after-stop" }),
        "no longer admits members",
      );
    }),
  );

  it.effect("Q2: a Stop with no live run, after the anchor completed, refuses admission", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-idle");
      const swarmId = SwarmId.make("swarm:q2-idle");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:q2-idle-stop"),
        threadId,
      });
      const anchorRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === anchor.id,
      )!;
      assert.equal(anchorRun.delegatedCompletion?.disposition, "stopped");
      assert.include(
        yield* admissionError({ threadId, anchor, swarmId, key: "after-idle-stop" }),
        "no longer admits members",
      );
    }),
  );

  it.effect(
    "Q2: a Stop during a later architect run refuses admission once every member was delivered",
    () =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, anchor } = yield* seedArchitect("q2-later");
        const swarmId = SwarmId.make("swarm:q2-later");
        yield* anchorSwarm(threadId, anchor.id, swarmId);
        const member = yield* admit({ threadId, anchor, swarmId: undefined, key: "first" });
        yield* endRun({ threadId, runId: anchor.id });
        yield* finishMember({
          parentThreadId: threadId,
          taskId: member.taskId,
          childThreadId: member.childThreadId,
          runId: member.childRun.id,
          text: "first member done",
        });
        yield* takeWake(threadId);
        const wake = yield* deliverWake(threadId, anchor.id);
        yield* endRun({ threadId, runId: wake.run.id });
        const later = yield* startRun({ threadId, ordinal: wake.run.ordinal + 1 });

        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("command:q2-later-stop"),
          threadId,
        });

        const projection = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          projection.subagents.find((task) => task.id === member.taskId)?.completionDelivery?.state,
          "delivered",
        );
        // Stop interrupts only the later run, but still stops the anchored cohort.
        assert.equal(
          projection.runs.find((run) => run.id === anchor.id)?.delegatedCompletion?.disposition,
          "stopped",
        );
        assert.isTrue(
          projection.turnItems.some(
            (item) => item.type === "run_interrupt_request" && item.runId === later.id,
          ),
        );
        assert.isFalse(
          projection.turnItems.some(
            (item) => item.type === "run_interrupt_request" && item.runId === anchor.id,
          ),
        );
        assert.include(
          yield* admissionError({ threadId, anchor, swarmId, key: "queued-row" }),
          "no longer admits members",
        );
      }),
  );

  it.effect("Q2: an interrupt of the swarm's wake turn leaves the anchor open and admitting", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-wake-interrupt");
      const swarmId = SwarmId.make("swarm:q2-wake-interrupt");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      const member = yield* admit({ threadId, anchor, swarmId: undefined, key: "first" });
      yield* endRun({ threadId, runId: anchor.id });
      yield* finishMember({
        parentThreadId: threadId,
        taskId: member.taskId,
        childThreadId: member.childThreadId,
        runId: member.childRun.id,
        text: "first member done",
      });
      yield* takeWake(threadId);
      const wake = yield* deliverWake(threadId, anchor.id);
      // What /goal, skipped compaction, and t3_thread_interrupt dispatch: no holdQueue.
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("command:q2-wake-interrupt"),
        threadId,
        runId: wake.run.id,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.runs.find((run) => run.id === anchor.id)?.delegatedCompletion?.disposition,
        "open",
      );
      const late = yield* admit({ threadId, anchor, swarmId, key: "after-interrupt" });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === late.taskId,
        )?.runId,
        anchor.id,
      );
    }),
  );

  it.effect("Q2: an interrupt of a later non-wake turn leaves the swarm admitting", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-later-interrupt");
      const swarmId = SwarmId.make("swarm:q2-later-interrupt");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });
      const messageId = MessageId.make("message:q2-later-interrupt");
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        createdBy: "user",
        creationSource: "web",
        commandId: CommandId.make("command:q2-later-interrupt-message"),
        threadId,
        messageId,
        text: "Unrelated work",
        attachments: [],
        modelSelection,
        dispatchMode: { type: "queue_after_active" },
      });
      yield* orchestrator.resumeQueuedRuns;
      const later = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.userMessageId === messageId,
      )!;
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make("command:q2-later-interrupt"),
        threadId,
        runId: later.id,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === anchor.id)
          ?.delegatedCompletion?.disposition,
        "open",
      );
      yield* admit({ threadId, anchor, swarmId, key: "after-later-interrupt" });
    }),
  );

  it.effect("Q2: a wake run that ends cancelled re-delivers its swarm tasks", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const { threadId, anchor } = yield* seedArchitect("q2-wake-cancelled");
      const swarmId = SwarmId.make("swarm:q2-wake-cancelled");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      const member = yield* admit({ threadId, anchor, swarmId: undefined, key: "first" });
      yield* endRun({ threadId, runId: anchor.id });
      yield* finishMember({
        parentThreadId: threadId,
        taskId: member.taskId,
        childThreadId: member.childThreadId,
        runId: member.childRun.id,
        text: "first member done",
      });
      const firstOffer = yield* takeWake(threadId);
      const wake = yield* deliverWake(threadId, anchor.id);
      // A restart cancels the running wake the way reconciliation records it.
      const now = yield* DateTime.now;
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (row) => row.id === wake.run.id,
      )!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:q2-wake-cancelled"),
            type: "run.updated",
            threadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "cancelled", completedAt: now },
          },
        ],
      });
      const again = yield* takeWake(threadId);
      assert.equal(again.delegatedCompletion?.parentRunId, anchor.id);
      assert.notEqual(
        again.delegatedCompletion?.messageId,
        firstOffer.delegatedCompletion?.messageId,
      );
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((row) => row.id === anchor.id)
          ?.delegatedCompletion?.delivery?.taskIds,
        [member.taskId],
      );
    }),
  );

  it.effect("Q2: a wake run that ends interrupted leaves its swarm tasks delivered", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-wake-interrupted");
      const swarmId = SwarmId.make("swarm:q2-wake-interrupted");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      const member = yield* admit({ threadId, anchor, swarmId: undefined, key: "first" });
      yield* endRun({ threadId, runId: anchor.id });
      yield* finishMember({
        parentThreadId: threadId,
        taskId: member.taskId,
        childThreadId: member.childThreadId,
        runId: member.childRun.id,
        text: "first member done",
      });
      yield* takeWake(threadId);
      const wake = yield* deliverWake(threadId, anchor.id);
      yield* endRun({ threadId, runId: wake.run.id, status: "interrupted" });
      yield* orchestrator.recoverDelegatedTasks;
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(
        projection.subagents.find((task) => task.id === member.taskId)?.completionDelivery?.state,
        "delivered",
      );
      assert.isNull(
        projection.runs.find((row) => row.id === anchor.id)?.delegatedCompletion?.delivery ?? null,
      );
    }),
  );

  it.effect("Q2: a client run.interrupt with holdQueue that fails leaves the swarm running", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-failed-stop");
      const swarmId = SwarmId.make("swarm:q2-failed-stop");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      // The seeded run has no attempt, so the interrupt fails before holdStoppedThread.
      const exit = yield* orchestrator
        .dispatch({
          type: "run.interrupt",
          commandId: CommandId.make("command:q2-failed-stop"),
          threadId,
          runId: anchor.id,
          holdQueue: true,
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === anchor.id)
          ?.delegatedCompletion?.disposition,
        "open",
      );
      yield* admit({ threadId, anchor, swarmId, key: "after-failed-stop" });
    }),
  );

  it.effect("Q2: Stop on the architect stops a member that is in a verify-retry run", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q2-verify");
      const swarmId = SwarmId.make("swarm:q2-verify");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });
      const member = yield* admit({ threadId, anchor, swarmId, key: "verifying" });
      yield* finishMember({
        parentThreadId: threadId,
        taskId: member.taskId,
        childThreadId: member.childThreadId,
        runId: member.childRun.id,
        text: "claimed done",
      });
      yield* takeWake(threadId);
      // A verify retry is a second turn on the member's thread.
      yield* writeProviderThread(member.childThreadId, member.childRun.rootNodeId!);
      const retry = yield* startRun({ threadId: member.childThreadId, ordinal: 2 });

      const stopCommandId = CommandId.make("command:q2-verify-stop");
      yield* orchestrator.dispatch({ type: "thread.stop", commandId: stopCommandId, threadId });
      // The parent's Stop queues delegated-tasks.stop; this harness runs no effect daemon, so
      // the test makes the call the EffectWorker makes for it (EffectWorker.ts:555).
      const outbox = yield* EffectOutbox.EffectOutboxV2;
      const queued = yield* outbox.listByCommandId(stopCommandId);
      assert.isTrue(queued.some((effect) => effect.request.type === "delegated-tasks.stop"));
      const threads = yield* ThreadManagementService.ThreadManagementService;
      yield* threads.stopDelegatedTasks({ threadId, commandId: stopCommandId });
      const child = yield* orchestrator.getThreadProjection(member.childThreadId);
      assert.isTrue(
        child.turnItems.some(
          (item) => item.type === "run_interrupt_request" && item.runId === retry.id,
        ),
        "the verify-retry run is interrupted",
      );
    }),
  );

  it.effect("Q3: admission against the old anchor still wakes after later architect turns", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q3");
      const swarmId = SwarmId.make("swarm:q3");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });
      // Two later turns of the user's own; the third is live when the member finishes.
      const second = yield* startRun({ threadId, ordinal: 2 });
      yield* endRun({ threadId, runId: second.id });
      const third = yield* startRun({ threadId, ordinal: 3 });
      yield* endRun({ threadId, runId: third.id });
      const fourth = yield* startRun({ threadId, ordinal: 4 });

      const late = yield* admit({ threadId, anchor, swarmId, key: "after-turns" });
      yield* finishMember({
        parentThreadId: threadId,
        taskId: late.taskId,
        childThreadId: late.childThreadId,
        runId: late.childRun.id,
        text: "member done after later turns",
      });
      const wake = yield* takeWake(threadId);
      assert.equal(wake.delegatedCompletion?.parentRunId, anchor.id);
      const delivered = yield* deliverWake(threadId, anchor.id);
      // The architect is busy in its fourth turn, so the wake queues behind it.
      assert.equal(delivered.run.status, "queued");
      assert.isAbove(delivered.run.ordinal, fourth.ordinal);
      assert.include(delivered.text, "member done after later turns");
      yield* endRun({ threadId, runId: fourth.id });
      yield* orchestrator.resumeQueuedRuns;
      assert.notEqual(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find(
          (run) => run.id === delivered.run.id,
        )?.status,
        "queued",
      );
    }),
  );

  it.effect("Q4: admissions serialize on the parent lock and their time is measured", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q4");
      const swarmId = SwarmId.make("swarm:q4");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });
      const keys = Array.from({ length: 12 }, (_, index) => `m${index}`);
      const timings: Array<number> = [];
      // Parallel callers, as a scheduler tick and the panel's Retry may race.
      yield* Effect.forEach(
        keys,
        (key) =>
          Effect.gen(function* () {
            // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- measurement only, printed behind T3_SWARM_SPIKE_TIMINGS; nothing asserts on it
            const started = performance.now();
            yield* admit({ threadId, anchor, swarmId, key });
            // oxlint-disable-next-line t3code/no-wall-clock-in-tests -- measurement only, printed behind T3_SWARM_SPIKE_TIMINGS; nothing asserts on it
            timings.push(performance.now() - started);
          }),
        { concurrency: "unbounded", discard: true },
      );
      const parent = yield* orchestrator.getThreadProjection(threadId);
      const tasks = parent.subagents.filter((task) => task.runId === anchor.id);
      assert.equal(tasks.length, keys.length);
      // Each admission read the subagents its predecessors wrote: titles carry distinct ordinals.
      assert.equal(new Set(tasks.map((task) => task.childThreadId)).size, keys.length);
      const ordinals = parent.turnItems
        .filter((item) => item.type === "subagent")
        .map((item) => item.ordinal);
      assert.equal(new Set(ordinals).size, keys.length);
      if (process.env.T3_SWARM_SPIKE_TIMINGS === "1") {
        const sorted = timings.toSorted((left, right) => left - right);
        process.stderr.write(
          `SWARM-SPIKE admission ms ${JSON.stringify({
            count: sorted.length,
            min: sorted[0],
            median: sorted[Math.floor(sorted.length / 2)],
            max: sorted.at(-1),
            perAdmission: sorted.at(-1)! / sorted.length,
          })}
`,
        );
      }
    }),
  );

  it.effect("Q5: a late member's card joins the anchor run with the thread's newest ordinal", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("q5");
      const swarmId = SwarmId.make("swarm:q5");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      const live = yield* admit({ threadId, anchor, swarmId: undefined, key: "live" });
      yield* endRun({ threadId, runId: anchor.id });
      yield* startRun({ threadId, ordinal: 2 });
      const before = (yield* orchestrator.getThreadProjection(threadId)).turnItems;
      const newest = Math.max(...before.map((item) => item.ordinal));
      const late = yield* admit({ threadId, anchor, swarmId, key: "late" });
      const items = (yield* orchestrator.getThreadProjection(threadId)).turnItems;
      const card = (taskId: NodeId) =>
        items.find((item) => item.type === "subagent" && item.subagentId === taskId)!;
      assert.equal(card(late.taskId).runId, anchor.id);
      assert.equal(card(late.taskId).providerTurnId, card(live.taskId).providerTurnId);
      assert.isAbove(card(late.taskId).ordinal, newest);
    }),
  );

  it.effect("Q6: a client's swarmAdmission is stripped, and unknown swarms are refused", () =>
    Effect.gen(function* () {
      const { threadId, anchor } = yield* seedArchitect("q6");
      const swarmId = SwarmId.make("swarm:q6");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });

      // ws.ts stamps every client command with the user's provenance.
      const { completionWake: _wake, ...unheld } = memberCommand({
        threadId,
        anchor,
        swarmId,
        key: "forged",
      });
      const forged = yield* withCreationProvenance(
        { ...unheld, completionWake: "always" },
        { createdBy: "user", creationSource: "server" },
      );
      assert.notProperty(forged, "swarmAdmission");
      // A held wake is reserved for the server, so a client sending one is refused.
      const held = yield* withCreationProvenance(
        { ...unheld, completionWake: "held" },
        { createdBy: "user", creationSource: "web" },
      ).pipe(Effect.flip);
      assert.equal(held._tag, "ThreadManagementClientCommandError");
      assert.include(held.message, "Invalid request");
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const forgedExit = yield* orchestrator.dispatch(forged).pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(forgedExit));
      assert.include(String(Exit.isFailure(forgedExit) ? forgedExit.cause : ""), "is not active");

      // Without the strip, a client's provenance alone is refused.
      const userExit = yield* orchestrator
        .dispatch({
          ...memberCommand({ threadId, anchor, swarmId, key: "user" }),
          createdBy: "user",
        })
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(userExit));
      assert.include(
        String(Exit.isFailure(userExit) ? userExit.cause : ""),
        "created by the server",
      );

      assert.include(
        yield* admissionError({
          threadId,
          anchor,
          swarmId: SwarmId.make("swarm:unknown"),
          key: "unknown",
        }),
        "is not the anchor of swarm",
      );

      // A swarm anchored on another run cannot borrow this one.
      const second = yield* startRun({ threadId, ordinal: 2 });
      const other = SwarmId.make("swarm:q6-other");
      yield* anchorSwarm(threadId, second.id, other);
      assert.include(
        yield* admissionError({ threadId, anchor, swarmId: other, key: "borrowed" }),
        "is not the anchor of swarm",
      );
    }),
  );

  it.effect("swarm.anchor needs a live run and refuses after Stop or on an archived thread", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("anchor-guard");
      yield* endRun({ threadId, runId: anchor.id });
      const ended = yield* anchorSwarm(threadId, anchor.id, SwarmId.make("swarm:ended")).pipe(
        Effect.exit,
      );
      assert.isTrue(Exit.isFailure(ended));

      const second = yield* startRun({ threadId, ordinal: 2 });
      yield* anchorSwarm(threadId, second.id, SwarmId.make("swarm:archived"));
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("command:anchor-guard-archive"),
        threadId,
      });
      assert.include(
        yield* admissionError({
          threadId,
          anchor: second,
          swarmId: SwarmId.make("swarm:archived"),
          key: "archived",
        }),
        "is not active",
      );
    }),
  );

  it.effect("wake-policy refuses held and completionDetail until swarm release lands", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, anchor } = yield* seedArchitect("held-refused");
      const member = yield* admit({ threadId, anchor, swarmId: undefined, key: "held" });
      for (const [name, change] of [
        ["held", { completionWake: "held" as const }],
        ["detail", { completionWake: "settled_only" as const, completionDetail: "digest" }],
      ] as const) {
        const exit = yield* orchestrator
          .dispatch({
            type: "delegated_task.wake-policy",
            commandId: CommandId.make(`command:held-refused:${name}`),
            parentThreadId: threadId,
            taskId: member.taskId,
            ...change,
          })
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit), name);
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "not supported");
      }
      const task = (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
        (row) => row.id === member.taskId,
      );
      assert.equal(task?.completionWake, "always");
    }),
  );

  it.effect("Q8: thread.stop disarms a member's armed usage-limit continuation", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const { threadId, anchor } = yield* seedArchitect("q8");
      const swarmId = SwarmId.make("swarm:q8");
      yield* anchorSwarm(threadId, anchor.id, swarmId);
      yield* endRun({ threadId, runId: anchor.id });
      const member = yield* admit({ threadId, anchor, swarmId, key: "limited" });
      const now = yield* DateTime.now;
      const resetAt = DateTime.formatIso(DateTime.add(now, { minutes: 5 }));
      const run = (yield* orchestrator.getThreadProjection(member.childThreadId)).runs[0]!;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:q8-failed"),
            type: "run.updated",
            threadId: member.childThreadId,
            runId: run.id,
            occurredAt: now,
            payload: { ...run, status: "failed", startedAt: now, completedAt: now },
          },
          {
            id: EventId.make("event:q8-error"),
            type: "turn-item.updated",
            threadId: member.childThreadId,
            runId: run.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("turn-item:q8-error"),
              type: "error",
              threadId: member.childThreadId,
              runId: run.id,
              nodeId: run.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 2,
              status: "failed",
              title: "Usage limit reached",
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              failure: {
                class: "usage_limit",
                message: "Plan limit reached.",
                code: "usageLimitExceeded",
                retryable: null,
                resetAt,
              },
            },
          },
        ],
      });
      const shellOf = Effect.gen(function* () {
        return (yield* orchestrator.getShellSnapshot()).threads.find(
          (thread) => thread.id === member.childThreadId,
        )!;
      });
      const arm = limitRecoveryCommand(yield* shellOf, true, DateTime.toEpochMillis(now));
      assert(arm?.type === "thread.metadata.update");
      yield* orchestrator.dispatch(arm);
      assert.isTrue((yield* shellOf).limitRecovery?.autoResume);

      // stopMember's thread.stop on a member with no live run.
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:q8-stop"),
        threadId: member.childThreadId,
      });
      const stopped = yield* shellOf;
      assert.isFalse(stopped.limitRecovery?.autoResume);
      assert.equal(stopped.limitRecovery?.runId, run.id);
      assert.equal(stopped.limitRecovery?.resetAt, resetAt);
      // Neither the worker's candidate query nor its resume command picks the thread up.
      assert.isUndefined(
        (yield* projections.getLimitRecoveryCandidates({
          now: DateTime.add(now, { minutes: 10 }),
          autoResume: true,
          snooze: false,
        })).find((row) => row.id === member.childThreadId),
      );
      assert.isNull(limitRecoveryCommand(stopped, true, DateTime.toEpochMillis(now) + 10 * 60_000));
    }),
  );
});

// Q7: SW-A5 releases a held task by making it a terminal "always" task, which plans delivery
// through planDelegatedCompletionDelivery exactly as a terminal async child does today.
const RESULT_BYTES = 1_000; // about a 1 KB SW-A5 digest
const TITLE = "t".repeat(64); // SW-A5 cuts wake-label titles to 64 characters

const finishedMembers = (input: { readonly name: string; readonly k: number }) =>
  Effect.gen(function* () {
    const { threadId, anchor } = yield* seedArchitect(input.name);
    const members = yield* Effect.forEach(
      Array.from({ length: input.k }, (_, index) => index),
      (index) =>
        admit({ threadId, anchor, swarmId: undefined, key: `${TITLE.slice(0, 60)}${index}` }),
    );
    yield* endRun({ threadId, runId: anchor.id });
    const finish = (index: number) =>
      finishMember({
        parentThreadId: threadId,
        taskId: members[index]!.taskId,
        childThreadId: members[index]!.childThreadId,
        runId: members[index]!.childRun.id,
        text: `${index}:`.padEnd(RESULT_BYTES, "r"),
      });
    return { threadId, anchor, members, finish };
  });

const pointerCount = (text: string) => text.split("Use task_status with taskId").length - 1;

const reportWakes = (label: string, wakes: ReadonlyArray<{ text: string; taskIds: unknown[] }>) =>
  Effect.sync(() => {
    if (process.env.T3_SWARM_SPIKE_TIMINGS !== "1") return;
    process.stderr.write(
      `SWARM-SPIKE wakes ${label} ${JSON.stringify({
        wakes: wakes.length,
        tasksPerWake: wakes.map((wake) => wake.taskIds.length),
        bytesPerWake: wakes.map((wake) => Buffer.byteLength(wake.text)),
        pointersPerWake: wakes.map((wake) => pointerCount(wake.text)),
      })}
`,
    );
  });

it.layer(layerTest)("swarm release and the shared wake budget (SW-A0 Q7)", (it) => {
  it.effect.each([4, 12])("k = %i released together with the architect idle: one wake", (k) =>
    Effect.gen(function* () {
      const { threadId, anchor, members, finish } = yield* finishedMembers({
        name: `q7-idle-${k}`,
        k,
      });
      for (let index = 0; index < k; index += 1) yield* finish(index);
      const offer = yield* takeWake(threadId);
      const wake = yield* deliverWake(threadId, anchor.id);
      assert.equal(offer.delegatedCompletion?.messageId, wake.run.userMessageId);
      assert.deepEqual(
        wake.taskIds,
        members.map((member) => member.taskId),
      );
      assert.equal(pointerCount(wake.text), 0);
      assert.isAtMost(Buffer.byteLength(wake.text), 16_000 + k * 2);
      yield* reportWakes(`idle k=${k}`, [{ text: wake.text, taskIds: [...wake.taskIds] }]);
    }),
  );

  it.effect.each([4, 12])(
    "k = %i: releases joining a queued delivery re-render its wake, one wake",
    (k) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, anchor, members, finish } = yield* finishedMembers({
          name: `q7-busy-${k}`,
          k,
        });
        const busy = yield* startRun({ threadId, ordinal: 2 });
        yield* finish(0);
        yield* takeWake(threadId);
        const wake = yield* deliverWake(threadId, anchor.id);
        assert.equal(wake.run.status, "queued");
        for (let index = 1; index < k; index += 1) yield* finish(index);
        const projection = yield* orchestrator.getThreadProjection(threadId);
        const delivery = projection.runs.find((run) => run.id === anchor.id)!.delegatedCompletion!
          .delivery!;
        const message = projection.messages.find((row) => row.id === delivery.messageId)!;
        assert.deepEqual(
          delivery.taskIds,
          members.map((member) => member.taskId),
        );
        assert.deepEqual(message.delegatedCompletion?.taskIds, delivery.taskIds);
        for (let index = 0; index < k; index += 1) assert.include(message.text, `${index}:rrr`);
        assert.equal(pointerCount(message.text), 0);
        yield* reportWakes(`busy k=${k}`, [{ text: message.text, taskIds: [...delivery.taskIds] }]);
        yield* endRun({ threadId, runId: busy.id });
        yield* orchestrator.resumeQueuedRuns;
      }),
  );

  it.effect.each([4, 12])(
    "k = %i: releases while the delivery runs stay pending and form the next wake",
    (k) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, anchor, members, finish } = yield* finishedMembers({
          name: `q7-running-${k}`,
          k,
        });
        yield* finish(0);
        yield* takeWake(threadId);
        const first = yield* deliverWake(threadId, anchor.id);
        assert.notEqual(first.run.status, "queued");
        for (let index = 1; index < k; index += 1) yield* finish(index);
        const pending = (yield* orchestrator.getThreadProjection(threadId)).subagents.filter(
          (task) => task.completionDelivery?.state === "pending",
        );
        assert.equal(pending.length, k - 1);
        yield* endRun({ threadId, runId: first.run.id });
        yield* takeWake(threadId);
        const second = yield* deliverWake(threadId, anchor.id);
        // The terminal-run collector gathers pending tasks by id, not by member ordinal.
        const rest = members.slice(1).map((member) => String(member.taskId));
        assert.deepEqual([...second.taskIds].map(String), rest.toSorted());
        assert.equal(pointerCount(second.text), 0);
        yield* reportWakes(`running k=${k}`, [
          { text: first.text, taskIds: [...first.taskIds] },
          { text: second.text, taskIds: [...second.taskIds] },
        ]);
      }),
  );

  it.effect(
    "one wake shares DELEGATED_RESULT_INLINE_BYTES: oversized results become pointers",
    () =>
      Effect.gen(function* () {
        const { threadId, anchor, members } = yield* finishedMembers({ name: "q7-budget", k: 12 });
        for (const [index, member] of members.entries()) {
          yield* finishMember({
            parentThreadId: threadId,
            taskId: member.taskId,
            childThreadId: member.childThreadId,
            runId: member.childRun.id,
            text: `${index}:`.padEnd(2_048, "r"),
          });
        }
        yield* takeWake(threadId);
        const wake = yield* deliverWake(threadId, anchor.id);
        assert.equal(wake.taskIds.length, 12);
        // 16,000 bytes hold seven 2 KB results with their labels; the rest are pointers.
        assert.equal(pointerCount(wake.text), 5);
        yield* reportWakes("budget k=12 at 2 KB", [
          { text: wake.text, taskIds: [...wake.taskIds] },
        ]);
      }),
  );
});

// SW-A3: swarm_create, admission, and the scheduler on the real orchestrator. The scheduler is
// driven by `tick`, and child completion by terminal run events.

const prepareRuns: Array<string> = [];
/** What placement reads as provider health; tests change it. */
let providerHealth: ReadonlyArray<ServerProvider> = [];
const layerSwarm = SwarmService.layer.pipe(
  Layer.provideMerge(SwarmStore.layer.pipe(Layer.provide(SqlitePersistence.layerMemory))),
  Layer.provide(
    Layer.succeed(ThreadLaunchService.ThreadLaunchService, {
      prepareRun: (input: { readonly threadId: ThreadId }) =>
        Effect.sync(() => {
          prepareRuns.push(input.threadId);
        }),
    } as unknown as ThreadLaunchService.ThreadLaunchService["Service"]),
  ),
  Layer.provide(
    Layer.succeed(ProviderRegistry.ProviderRegistry, {
      getProviders: Effect.sync(() => providerHealth),
    } as unknown as ProviderRegistry.ProviderRegistry["Service"]),
  ),
  Layer.provideMerge(ServerSettings.layerTest({ swarmV2Enabled: true, swarmMaxConcurrent: 2 })),
  Layer.provideMerge(layerTest),
);

const resolverCalls: Array<string> = [];
const instanceIds = (...names: ReadonlyArray<string>) =>
  names.map((name) => ProviderInstanceId.make(name));

// Instance "claude-*" uses another driver, and "no-model" does not offer the model.
const resolver: SwarmService.SwarmTargetResolver = {
  resolveTarget: (_parent, target) =>
    Effect.gen(function* () {
      resolverCalls.push(JSON.stringify(target ?? null));
      const instanceId = target?.providerInstanceId ?? modelSelection.instanceId;
      if (instanceId === "no-model") {
        return yield* new OrchestratorMcpFailureClass({
          code: "model_unavailable",
          message: `Model ${target?.model} is not advertised by provider ${instanceId}.`,
        });
      }
      return {
        modelSelection: {
          instanceId: ProviderInstanceId.make(instanceId),
          model: target?.model ?? modelSelection.model,
        },
        supportedRuntimeModes: undefined,
        driver: instanceId.startsWith("claude") ? ProviderDriverKind.make("claudeAgent") : driver,
      };
    }),
  resolveWorktreeBase: () => Effect.succeed("0000000000000000000000000000000000000000"),
};

const scopeFor = (threadId: ThreadId): McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:swarm"),
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
  requestNamespace: `ns:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `session:${threadId}`,
    providerInstanceId: modelSelection.instanceId,
  },
  client: undefined,
});

const members = (count: number, overrides: Partial<SwarmMemberInput> = {}) =>
  Array.from({ length: count }, (_, index) => ({
    key: `m${index}`,
    title: `Member ${index}`,
    task: `Do part ${index}.`,
    ...overrides,
  }));

const createSwarm = (threadId: ThreadId, input: Omit<SwarmCreateInput, "title">) =>
  Effect.gen(function* () {
    const swarms = yield* SwarmService.SwarmService;
    return yield* swarms.create({
      scope: scopeFor(threadId),
      input: { title: "Swarm", ...input },
      resolver,
    });
  });

const createError = (threadId: ThreadId, input: Omit<SwarmCreateInput, "title">) =>
  createSwarm(threadId, input).pipe(Effect.flip);

const rows = (swarmId: SwarmId) =>
  Effect.gen(function* () {
    const store = yield* SwarmStore.SwarmStore;
    return yield* store.listMembers(swarmId);
  });

/** Tests share one database and cap; a finished test's swarm stops counting toward the cap. */
const retire = (swarmId: SwarmId) =>
  Effect.gen(function* () {
    const store = yield* SwarmStore.SwarmStore;
    const updatedAt = DateTime.formatIso(yield* DateTime.now);
    for (const row of yield* store.listMembers(swarmId)) {
      yield* store.updateMember({
        swarmId,
        memberKey: row.memberKey,
        patch: { status: "cancelled", updatedAt },
      });
    }
    yield* store.updateSwarm(swarmId, { status: "cancelled", updatedAt });
  });

const slotCount = (list: ReadonlyArray<SwarmStore.SwarmMemberRecord>) =>
  list.filter((row) => row.status === "launching" || row.status === "running").length;

it.layer(layerSwarm)("swarm_create, admission, and the scheduler (SW-A3)", (it) => {
  it.effect("6 members with cap 2: at most 2 run, and late admissions follow the anchor", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const swarms = yield* SwarmService.SwarmService;
      const { threadId, anchor } = yield* seedArchitect("a3-cap");
      const result = yield* createSwarm(threadId, {
        members: members(6, { interactionMode: "plan" }),
      });
      assert.equal(result.members.length, 6);
      assert.deepEqual(
        result.members.map((row) => row.status),
        ["launching", "launching", "queued", "queued", "queued", "queued"],
      );
      assert.deepEqual(
        result.members.slice(2).map((row) => row.queueReason),
        ["global_cap", "global_cap", "global_cap", "global_cap"],
      );
      assert.isDefined(result.members[0]?.childThreadId);
      assert.deepEqual(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === anchor.id)
          ?.delegatedCompletion?.swarmIds,
        [result.swarmId],
      );
      yield* endRun({ threadId, runId: anchor.id });

      let peak = 0;
      for (let round = 0; round < 6; round += 1) {
        const list = yield* rows(result.swarmId);
        peak = Math.max(peak, slotCount(list));
        assert.isAtMost(slotCount(list), 2);
        const running = list.find((row) => row.status === "launching" || row.status === "running");
        if (running === undefined) break;
        yield* finishMember({
          parentThreadId: threadId,
          taskId: running.taskId!,
          childThreadId: running.childThreadId!,
          runId: running.childRunId!,
          text: `${running.memberKey} done`,
        });
        yield* swarms.tick;
      }
      assert.equal(peak, 2, "two members run at once after the anchor ended");
      const final = yield* rows(result.swarmId);
      assert.deepEqual(
        final.map((row) => row.status),
        Array(6).fill("claimed_done"),
      );
      const parent = yield* orchestrator.getThreadProjection(threadId);
      for (const row of final) {
        const task = parent.subagents.find((candidate) => candidate.id === row.taskId);
        assert.equal(task?.runId, anchor.id, row.memberKey);
        assert.equal(task?.completionWake, "held");
      }
      yield* retire(result.swarmId);
    }),
  );

  it.effect("replays a retried call, and resolves each distinct target once", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedArchitect("a3-replay");
      resolverCalls.length = 0;
      const input = {
        clientRequestId: "replay-1",
        members: [
          ...members(2, { target: { model: "gpt-5.4" }, interactionMode: "plan" }),
          {
            key: "other",
            title: "Other",
            task: "Other.",
            target: { model: "gpt-5.5" },
            interactionMode: "plan" as const,
          },
        ],
      };
      const first = yield* createSwarm(threadId, input);
      assert.equal(resolverCalls.length, 2);
      const second = yield* createSwarm(threadId, input);
      assert.equal(second.swarmId, first.swarmId);
      assert.equal(resolverCalls.length, 2);
      assert.equal((yield* rows(first.swarmId)).length, 3);
      yield* retire(first.swarmId);
    }),
  );

  it.effect("refuses remote, nested, unsupported, and invalid swarms before launching", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedArchitect("a3-refusals");
      const code = (error: OrchestratorMcpFailure) => error.code;
      assert.equal(
        code(
          yield* createError(threadId, {
            members: members(1, { target: { environmentId: EnvironmentId.make("env:remote") } }),
          }),
        ),
        "capability_denied",
      );
      assert.equal(
        code(
          yield* createError(threadId, {
            map: { task: "t", title: "t", rows: [{ key: "r" }] },
          }),
        ),
        "capability_denied",
      );
      assert.equal(
        code(yield* createError(threadId, { members: members(1), wakePolicy: "batch" })),
        "capability_denied",
      );
      assert.equal(
        code(yield* createError(threadId, { members: [...members(1), ...members(1)] })),
        "invalid_request",
      );
      assert.equal(
        code(yield* createError(threadId, { members: members(1), maxConcurrent: 3 })),
        "invalid_request",
      );
      assert.equal(
        code(
          yield* createError(threadId, {
            members: members(1, { interactionMode: "plan", verify: { argv: ["pnpm", "test"] } }),
          }),
        ),
        "invalid_request",
      );
      // Verify passes the create-time mode check, then waits for its runner (SW-A6).
      assert.equal(
        code(yield* createError(threadId, { members: members(1, { verify: { argv: ["x"] } }) })),
        "capability_denied",
      );
      const shared = yield* createError(threadId, { members: members(2) });
      assert.equal(shared.code, "invalid_request");
      assert.include(shared.message, `isolation: "worktree"`);
      // A shared writer in another active swarm of this architect counts too.
      const solo = yield* createSwarm(threadId, { members: members(1), maxConcurrent: 1 });
      const second = yield* createError(threadId, {
        members: [{ key: "next", title: "Next", task: "Next." }],
      });
      assert.equal(second.code, "invalid_request");
      assert.include(second.message, "'m0'");
      yield* retire(solo.swarmId);

      // A member may start its own swarm only with allowNestedSwarm.
      const parent = yield* createSwarm(threadId, {
        members: [{ key: "lead", title: "Lead", task: "Lead.", interactionMode: "plan" }],
      });
      const lead = parent.members[0]!.childThreadId!;
      assert.equal(
        code(yield* createError(lead, { members: members(1, { interactionMode: "plan" }) })),
        "capability_denied",
      );
      yield* retire(parent.swarmId);
    }),
  );

  it.effect("caps modes at the architect's, lowers them at late admission, and never raises", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const swarms = yield* SwarmService.SwarmService;
      const { threadId, anchor } = yield* seedArchitect("a3-modes");
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:a3-modes-auto"),
        threadId,
        runtimeMode: "auto",
      });
      const escalation = yield* createError(threadId, {
        members: members(1, { runtimeMode: "full-access", interactionMode: "plan" }),
      });
      assert.equal(escalation.code, "runtime_mode_escalation_denied");

      const result = yield* createSwarm(threadId, {
        maxConcurrent: 1,
        members: members(2, { interactionMode: "plan" }),
      });
      assert.deepEqual(
        result.members.map((row) => [row.status, row.runtimeMode, row.interactionMode]),
        [
          ["launching", "auto", "plan"],
          ["queued", "auto", "plan"],
        ],
      );
      yield* endRun({ threadId, runId: anchor.id });
      // The architect narrows; the queued member starts narrower, and a later widening is ignored.
      yield* orchestrator.dispatch({
        type: "thread.runtime-mode.set",
        commandId: CommandId.make("command:a3-modes-approval"),
        threadId,
        runtimeMode: "approval-required",
      });
      const first = (yield* rows(result.swarmId))[0]!;
      yield* finishMember({
        parentThreadId: threadId,
        taskId: first.taskId!,
        childThreadId: first.childThreadId!,
        runId: first.childRunId!,
        text: "first done",
      });
      yield* swarms.tick;
      const second = (yield* rows(result.swarmId))[1]!;
      assert.equal(second.status, "launching");
      assert.equal(second.effectiveRuntimeMode, "approval-required");
      assert.equal(
        (yield* orchestrator.getThreadProjection(second.childThreadId!)).thread.runtimeMode,
        "approval-required",
      );
      yield* retire(result.swarmId);
    }),
  );

  it.effect("calls prepareRun for worktree members, also after a late admission", () =>
    Effect.gen(function* () {
      const swarms = yield* SwarmService.SwarmService;
      const store = yield* SwarmStore.SwarmStore;
      const { threadId, anchor } = yield* seedArchitect("a3-worktree");
      prepareRuns.length = 0;
      const result = yield* createSwarm(threadId, {
        maxConcurrent: 1,
        members: members(2, { isolation: "worktree" }),
      });
      assert.equal(
        Option.getOrThrow(yield* store.getSwarm(result.swarmId)).baseCommit,
        "0000000000000000000000000000000000000000",
      );
      assert.equal(prepareRuns.length, 1);
      yield* endRun({ threadId, runId: anchor.id });
      const first = (yield* rows(result.swarmId))[0]!;
      yield* finishMember({
        parentThreadId: threadId,
        taskId: first.taskId!,
        childThreadId: first.childThreadId!,
        runId: first.childRunId!,
        text: "first done",
      });
      yield* swarms.tick;
      const second = (yield* rows(result.swarmId))[1]!;
      assert.equal(second.status, "launching");
      assert.deepEqual(prepareRuns, [first.childThreadId!, second.childThreadId!]);
      yield* retire(result.swarmId);
    }),
  );

  it.effect("cancels queued members and the swarm after the architect's Stop", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const swarms = yield* SwarmService.SwarmService;
      const { threadId, anchor } = yield* seedArchitect("a3-stop");
      const result = yield* createSwarm(threadId, {
        maxConcurrent: 1,
        members: members(2, { interactionMode: "plan" }),
      });
      yield* endRun({ threadId, runId: anchor.id });
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("command:a3-stop"),
        threadId,
      });
      const first = (yield* rows(result.swarmId))[0]!;
      yield* finishMember({
        parentThreadId: threadId,
        taskId: first.taskId!,
        childThreadId: first.childThreadId!,
        runId: first.childRunId!,
        text: "first done",
      });
      yield* swarms.tick;
      const store = yield* SwarmStore.SwarmStore;
      const after = yield* rows(result.swarmId);
      assert.deepInclude(after[1], {
        status: "cancelled",
        failureClass: "cancelled_by_architect_stop",
      });
      assert.equal(Option.getOrThrow(yield* store.getSwarm(result.swarmId)).status, "cancelled");
      assert.isUndefined(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.find(
          (task) => task.id === after[1]?.taskId,
        ),
      );
      yield* retire(result.swarmId);
    }),
  );

  it.effect("resumes launching rows whose child ids were never stored, admitting each once", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const swarms = yield* SwarmService.SwarmService;
      const store = yield* SwarmStore.SwarmStore;
      const { threadId } = yield* seedArchitect("a3-resume");
      const result = yield* createSwarm(threadId, {
        maxConcurrent: 1,
        members: members(2, { interactionMode: "plan" }),
      });
      const updatedAt = DateTime.formatIso(yield* DateTime.now);
      const [first] = yield* rows(result.swarmId);
      // m0 was dispatched, but a crash lost its ids before they were stored.
      yield* store.updateMember({
        swarmId: result.swarmId,
        memberKey: "m0",
        patch: { taskId: null, childThreadId: null, childRunId: null, boundRunId: null, updatedAt },
      });
      // m1 was marked launching, but the crash came before its dispatch.
      yield* store.updateMember({
        swarmId: result.swarmId,
        memberKey: "m1",
        patch: {
          status: "launching",
          queueReason: null,
          commandId: CommandId.make(`swarm-admit:${result.swarmId}:m1:1`),
          effectiveRuntimeMode: "full-access",
          effectiveInteractionMode: "plan",
          updatedAt,
        },
      });
      const tasksBefore = (yield* orchestrator.getThreadProjection(threadId)).subagents.length;

      yield* swarms.tick;
      yield* swarms.tick;

      const [m0, m1] = yield* rows(result.swarmId);
      assert.equal(m0?.taskId, first?.taskId);
      assert.equal(m0?.childThreadId, first?.childThreadId);
      assert.equal(m0?.childRunId, first?.childRunId);
      assert.isNotNull(m1?.childThreadId ?? null);
      assert.equal(m1?.status, "launching");
      // The replay reused m0's task; only m1 added one.
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).subagents.length,
        tasksBefore + 1,
      );
      yield* retire(result.swarmId);
    }),
  );

  it.effect("detaches the swarm when the user cancels its queued wake", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const swarms = yield* SwarmService.SwarmService;
      const store = yield* SwarmStore.SwarmStore;
      const { threadId, anchor } = yield* seedArchitect("a3-detach");
      const result = yield* createSwarm(threadId, {
        maxConcurrent: 2,
        members: members(3, { interactionMode: "plan" }),
      });
      yield* endRun({ threadId, runId: anchor.id });
      yield* startRun({ threadId, ordinal: 2 });
      const [first] = yield* rows(result.swarmId);
      yield* finishMember({
        parentThreadId: threadId,
        taskId: first!.taskId!,
        childThreadId: first!.childThreadId!,
        runId: first!.childRunId!,
        text: "first done",
      });
      yield* takeWake(threadId);
      const wake = yield* deliverWake(threadId, anchor.id);
      assert.equal(wake.run.status, "queued");
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("command:a3-detach-cancel"),
        threadId,
        runId: wake.run.id,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs.find((run) => run.id === anchor.id)
          ?.delegatedCompletion?.disposition,
        "disposed",
      );

      yield* swarms.tick;

      assert.deepEqual(
        (yield* rows(result.swarmId)).map((row) => row.status),
        ["claimed_done", "detached", "cancelled"],
      );
      assert.equal(Option.getOrThrow(yield* store.getSwarm(result.swarmId)).status, "detached");
    }),
  );

  it.effect("does not touch swarm rows while the flag is off", () =>
    Effect.gen(function* () {
      const swarms = yield* SwarmService.SwarmService;
      const settings = yield* ServerSettings.ServerSettingsService;
      const { threadId, anchor } = yield* seedArchitect("a3-flag-off");
      const result = yield* createSwarm(threadId, {
        maxConcurrent: 1,
        members: members(2, { interactionMode: "plan" }),
      });
      yield* endRun({ threadId, runId: anchor.id });
      const [first] = yield* rows(result.swarmId);
      yield* finishMember({
        parentThreadId: threadId,
        taskId: first!.taskId!,
        childThreadId: first!.childThreadId!,
        runId: first!.childRunId!,
        text: "first done",
      });
      yield* settings.updateSettings({ swarmV2Enabled: false });
      const before = yield* rows(result.swarmId);
      yield* swarms.tick;
      assert.deepEqual(yield* rows(result.swarmId), before);
      yield* settings.updateSettings({ swarmV2Enabled: true });
      yield* swarms.tick;
      assert.deepEqual(
        (yield* rows(result.swarmId)).map((row) => row.status),
        ["claimed_done", "launching"],
      );
      yield* retire(result.swarmId);
    }),
  );

  it.effect("validates anyOf targets at create", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedArchitect("a3b-validation");
      const plan = { interactionMode: "plan" as const };
      const refused = (target: SwarmMemberInput["target"]) =>
        createError(threadId, { members: members(1, { ...plan, target }) });
      const mixed = yield* refused({ anyOf: instanceIds("codex", "claude-1"), model: "m" });
      assert.equal(mixed.code, "invalid_request");
      assert.include(mixed.message, "claude-1");
      const missing = yield* refused({ anyOf: instanceIds("codex", "no-model"), model: "m" });
      assert.equal(missing.code, "invalid_request");
      assert.include(missing.message, "no-model");
      const noModel = yield* refused({ anyOf: instanceIds("codex", "codex-2") });
      assert.include(noModel.message, "requires target.model");
      const pinned = yield* refused({
        anyOf: instanceIds("codex", "codex-2"),
        model: "m",
        providerInstanceId: ProviderInstanceId.make("codex"),
      });
      assert.include(pinned.message, "excludes target.providerInstanceId");
    }),
  );

  it.effect("places an anyOf member on a healthy instance before dispatch and keeps it there", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* seedArchitect("a3b-place");
      providerHealth = [
        {
          instanceId: "codex-down",
          enabled: true,
          status: "error",
          auth: { status: "authenticated" },
        },
        { instanceId: "codex", enabled: true, status: "ready", auth: { status: "authenticated" } },
        {
          instanceId: "codex-out",
          enabled: true,
          status: "ready",
          auth: { status: "unauthenticated" },
        },
      ] as unknown as ReadonlyArray<ServerProvider>;
      resolverCalls.length = 0;
      const result = yield* createSwarm(threadId, {
        maxConcurrent: 1,
        members: members(2, {
          interactionMode: "plan",
          target: { anyOf: instanceIds("codex-down", "codex", "codex-out"), model: "m" },
        }),
      });
      // Each listed instance resolves once per call, not once per member.
      assert.equal(resolverCalls.length, 3);
      assert.deepEqual(
        result.members.map((row) => [row.status, row.providerInstanceId]),
        [
          ["launching", "codex"],
          ["queued", null],
        ],
      );
      assert.deepEqual(result.members[0]?.anyOf?.map(String), ["codex-down", "codex", "codex-out"]);
      const child = yield* orchestrator.getThreadProjection(result.members[0]!.childThreadId!);
      assert.equal(child.thread.modelSelection.instanceId, "codex");
      // The placement was written with the command id, so recovery reuses it.
      const [row] = yield* rows(result.swarmId);
      assert.equal(row?.providerInstanceId, "codex");
      assert.isNotNull(row?.commandId ?? null);
      providerHealth = [];
      yield* retire(result.swarmId);
    }),
  );

  it.effect("queues anyOf members as any_of_unavailable when no instance qualifies", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedArchitect("a3b-unavailable");
      providerHealth = [];
      const result = yield* createSwarm(threadId, {
        members: members(1, {
          interactionMode: "plan",
          target: { anyOf: instanceIds("codex", "codex-2"), model: "m" },
        }),
      });
      assert.deepEqual(
        result.members.map((row) => [row.status, row.queueReason, row.providerInstanceId]),
        [["queued", "any_of_unavailable", null]],
      );
      yield* retire(result.swarmId);
    }),
  );

  it.effect("returns one swarm to two concurrent calls with the same clientRequestId", () =>
    Effect.gen(function* () {
      const { threadId } = yield* seedArchitect("a3-race");
      const input = {
        clientRequestId: "race-1",
        maxConcurrent: 1,
        members: members(1, { interactionMode: "plan" as const }),
      };
      const [left, right] = yield* Effect.all(
        [createSwarm(threadId, input), createSwarm(threadId, input)],
        {
          concurrency: "unbounded",
        },
      );
      assert.equal(left.swarmId, right.swarmId);
      yield* retire(left.swarmId);
    }),
  );
});
