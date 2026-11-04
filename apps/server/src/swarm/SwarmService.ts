// @effect-diagnostics effectFnOpportunity:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpTarget,
  type ServerSettings as ServerSettingsValue,
  type SwarmCreateInput,
  type SwarmCreateResult,
  SwarmId,
  type SwarmMemberInput,
  type SwarmMemberResult,
  type SwarmWarning,
  type ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { type McpInvocationScope, threadLinkFor } from "../mcp/McpInvocationContext.ts";
import type { ResolvedTarget } from "../mcp/OrchestratorMcpService.ts";
import {
  resolveInteractionMode,
  resolveRuntimeMode,
  taskPrompt,
} from "../mcp/delegatedTaskModes.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SwarmStore from "./SwarmStore.ts";
import {
  type SwarmCaps,
  type SwarmMemberSpec,
  isFinalMemberStatus,
  isWriter,
  memberRef,
  narrowerInteractionMode,
  narrowerRuntimeMode,
  ownsPathsOverlapWarnings,
  planAdmissions,
  serialInstanceWarnings,
  sharedWriterRefusal,
  type WriterCandidate,
} from "./swarmPlanning.ts";

// Swarm v2: swarm_create, admission, and the scheduler (SW-A3). Queued members exist only as
// swarm_members rows until they are admitted against the swarm's anchor run. Logs carry ids,
// counts, statuses, and failure classes only.

const SAFETY_TICK = Duration.seconds(5);

const failure = (code: OrchestratorMcpFailure["code"], message: string) =>
  new OrchestratorMcpFailure({ code, message });

const notYet = (what: string) =>
  failure("capability_denied", `${what} is not available in this build yet.`);

const storageOrDispatchTag = (error: unknown) =>
  typeof error === "object" && error !== null && "_tag" in error
    ? String((error as { readonly _tag: unknown })._tag)
    : "unknown";

export interface SwarmTargetResolver {
  readonly resolveTarget: (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    target: OrchestratorMcpTarget | undefined,
  ) => Effect.Effect<ResolvedTarget, OrchestratorMcpFailure>;
  readonly resolveWorktreeBase: (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) => Effect.Effect<string, OrchestratorMcpFailure>;
}

export class SwarmService extends Context.Service<
  SwarmService,
  {
    readonly create: (input: {
      readonly scope: McpInvocationScope;
      readonly input: SwarmCreateInput;
      readonly resolver: SwarmTargetResolver;
    }) => Effect.Effect<SwarmCreateResult, OrchestratorMcpFailure>;
    /** One scheduler pass: reconcile launched members, then admit what the caps allow. */
    readonly tick: Effect.Effect<void>;
    /** Asks the scheduler for a pass soon. */
    readonly wake: Effect.Effect<void>;
    /** The scheduler fiber: woken by domain events and settings changes, with a 5 s tick. */
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/swarm/SwarmService") {}

const SpecJson = Schema.fromJsonString(Schema.Unknown);
const decodeSpecJson = Schema.decodeUnknownSync(SpecJson);
const encodeSpecJson = Schema.encodeSync(SpecJson);
/** Rows are written only by this service, from a `SwarmMemberSpec`. */
const parseSpec = (specJson: string) => decodeSpecJson(specJson) as SwarmMemberSpec;

const capsOf = (settings: {
  readonly swarmMaxConcurrent: number;
  readonly swarmMaxConcurrentPerInstance: number;
  readonly swarmInstanceCaps: Readonly<Record<string, number>>;
}): SwarmCaps => ({
  global: settings.swarmMaxConcurrent,
  perInstance: settings.swarmMaxConcurrentPerInstance,
  instanceOverrides: settings.swarmInstanceCaps,
});

/** The architect's run this MCP call belongs to, as delegate_task picks it. */
const liveRunOf = (
  parent: Pick<OrchestrationV2ThreadProjection, "runs">,
  providerInstanceId: string,
): OrchestrationV2Run | undefined =>
  parent.runs
    .filter(ThreadManagementService.isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)
    .find((run) => run.rootNodeId !== null && run.providerInstanceId === providerInstanceId);

/** Fields a later task owns; until then they fail explicitly rather than being ignored. */
const unsupportedFields = (input: SwarmCreateInput): string | undefined => {
  if (input.map !== undefined) return "`map`";
  if (input.sharedContext !== undefined) return "`sharedContext`";
  if (input.dataShape !== undefined) return "`dataShape`";
  if (input.wakeBatch !== undefined || (input.wakePolicy ?? "group") !== "group") {
    return "A `wakePolicy` other than 'group'";
  }
  if (input.maxTotalTurns !== undefined) return "`maxTotalTurns`";
  for (const member of input.members ?? []) {
    if (member.doneCriteria !== undefined) return "`doneCriteria`";
    if (member.maxTurns !== undefined) return "`maxTurns`";
    if (member.maxWallClockMs !== undefined) return "`maxWallClockMs`";
    if (member.target?.anyOf !== undefined) return "`target.anyOf`";
  }
  return undefined;
};

const make = Effect.gen(function* () {
  const store = yield* SwarmStore.SwarmStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  // Admission passes run one at a time, so a create and a tick never admit the same row twice.
  const passLock = yield* Semaphore.make(1);
  const wakes = yield* Queue.sliding<void>(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readSettings = settingsService.getSettings.pipe(
    Effect.mapError(() => failure("orchestration_error", "Unable to read settings.")),
  );

  const loadProjection = (threadId: ThreadId) =>
    threads
      .getThreadProjection(threadId)
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to read the architect thread."),
        ),
      );

  const dispatchAdmission = Effect.fn("SwarmService.admitMember")(function* (
    swarm: SwarmStore.SwarmRecord,
    member: SwarmStore.SwarmMemberRecord,
  ) {
    const spec = parseSpec(member.specJson);
    const architect = yield* loadProjection(swarm.parentThreadId);
    const anchor = architect.runs.find((run) => run.id === swarm.anchorRunId);
    if (anchor?.delegatedCompletion?.disposition !== "open") return;
    // Ceilings never rise; the architect's current modes can only lower them.
    const runtimeMode = yield* resolveRuntimeMode(
      narrowerRuntimeMode(spec.runtimeCeiling, architect.thread.runtimeMode),
      undefined,
      { modelSelection: spec.modelSelection, supportedRuntimeModes: spec.supportedRuntimeModes },
    );
    const interactionMode = narrowerInteractionMode(
      spec.interactionCeiling,
      architect.thread.interactionMode,
    );
    const commandId = CommandId.make(
      `swarm-admit:${swarm.swarmId}:${member.memberKey}:${member.attempt}`,
    );
    const updatedAt = yield* nowIso;
    yield* store.updateMember({
      swarmId: swarm.swarmId,
      memberKey: member.memberKey,
      patch: {
        status: "launching",
        queueReason: null,
        commandId,
        effectiveRuntimeMode: runtimeMode,
        effectiveInteractionMode: interactionMode,
        updatedAt,
      },
    });
    const dispatched = yield* threads
      .dispatch({
        type: "delegated_task.request",
        createdBy: "agent",
        creationSource: "server",
        commandId,
        parentThreadId: swarm.parentThreadId,
        parentRunId: swarm.anchorRunId,
        parentNodeId: swarm.anchorNodeId,
        task: spec.task,
        title: spec.title,
        modelSelection: spec.modelSelection,
        runtimeMode,
        interactionMode,
        ...(spec.isolation === "worktree" && swarm.baseCommit !== null
          ? {
              workspaceStrategy: {
                type: "worktree" as const,
                baseRef: swarm.baseCommit,
                startFromOrigin: false,
              },
            }
          : {}),
        completionWake: "held",
        swarmAdmission: { swarmId: swarm.swarmId },
      })
      .pipe(Effect.result);
    const endedAt = yield* nowIso;
    const task =
      dispatched._tag === "Success"
        ? dispatched.success.storedEvents.flatMap((stored) =>
            stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned"
              ? [stored.event.payload]
              : [],
          )[0]
        : undefined;
    if (dispatched._tag === "Failure" || task === undefined || task.childThreadId === null) {
      yield* Effect.logWarning("swarm.admission-failed", {
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        attempt: member.attempt,
        errorTag:
          dispatched._tag === "Failure" ? storageOrDispatchTag(dispatched.failure) : "no_task",
      });
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: {
          status: "failed",
          failureClass: "launch",
          lastFailureClass: "launch",
          lastFailedAt: endedAt,
          lastFailedInstanceId: spec.modelSelection.instanceId,
          endedAt,
          updatedAt: endedAt,
        },
      });
      return;
    }
    const childThreadId = task.childThreadId;
    const childRun =
      dispatched._tag === "Success"
        ? dispatched.success.storedEvents.flatMap((stored) =>
            stored.event.type === "run.created" && stored.event.threadId === childThreadId
              ? [stored.event.payload]
              : [],
          )[0]
        : undefined;
    yield* store.updateMember({
      swarmId: swarm.swarmId,
      memberKey: member.memberKey,
      patch: {
        taskId: task.id,
        childThreadId,
        ...(childRun === undefined ? {} : { childRunId: childRun.id, boundRunId: childRun.id }),
        providerInstanceId: spec.modelSelection.instanceId,
        updatedAt: endedAt,
      },
    });
    // A late worktree member never leaves preparation without this (§4.2).
    if (childRun?.workspacePreparation !== undefined) {
      yield* threadLaunch.prepareRun({ commandId, threadId: childThreadId, runId: childRun.id });
    }
  });

  /** Admits one queued member against its swarm's anchor run. Never fails the pass. */
  const admitMember = (swarm: SwarmStore.SwarmRecord, member: SwarmStore.SwarmMemberRecord) =>
    dispatchAdmission(swarm, member).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("swarm.admission-error", {
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          causeKind: storageOrDispatchTag(Cause.squash(cause)),
        }),
      ),
    );

  /**
   * Seam for SW-A5/A6/A8: until envelopes, verify, and failure classes land, a member whose
   * first run ended is final by its run status alone.
   */
  const reconcileMember = Effect.fn("SwarmService.reconcileMember")(function* (
    swarm: SwarmStore.SwarmRecord,
    member: SwarmStore.SwarmMemberRecord,
  ) {
    if (member.childThreadId === null || member.childRunId === null) return;
    const child = yield* loadProjection(member.childThreadId);
    const run = child.runs.find((candidate) => candidate.id === member.childRunId);
    if (run === undefined) return;
    const updatedAt = yield* nowIso;
    if (run.status === "running" && member.status === "launching") {
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { status: "running", startedAt: updatedAt, updatedAt },
      });
      return;
    }
    const ended =
      run.status === "completed"
        ? ("claimed_done" as const)
        : run.status === "failed"
          ? ("failed" as const)
          : run.status === "cancelled" || run.status === "interrupted"
            ? ("cancelled" as const)
            : undefined;
    if (ended === undefined) return;
    yield* store.updateMember({
      swarmId: swarm.swarmId,
      memberKey: member.memberKey,
      patch: {
        status: ended,
        ...(ended === "failed"
          ? {
              failureClass: "unknown",
              lastFailureClass: "unknown",
              lastFailedAt: updatedAt,
              lastFailedInstanceId: member.providerInstanceId,
            }
          : {}),
        endedAt: updatedAt,
        updatedAt,
      },
    });
  });

  const pass = (settings: ServerSettingsValue) =>
    passLock.withPermits(1)(
      Effect.gen(function* () {
        const swarms = yield* store.listSwarms({ statuses: ["active"] });
        if (swarms.length === 0) return;
        const membersBySwarm = new Map<string, ReadonlyArray<SwarmStore.SwarmMemberRecord>>();
        const admits = new Map<string, boolean>();
        for (const swarm of swarms) {
          for (const member of yield* store.listMembers(swarm.swarmId)) {
            if (member.status === "launching" || member.status === "running") {
              yield* reconcileMember(swarm, member).pipe(
                Effect.catchCause((cause) =>
                  Effect.logWarning("swarm.reconcile-error", {
                    swarmId: swarm.swarmId,
                    memberKey: member.memberKey,
                    causeKind: storageOrDispatchTag(Cause.squash(cause)),
                  }),
                ),
              );
            }
          }
          membersBySwarm.set(swarm.swarmId, yield* store.listMembers(swarm.swarmId));
          const architect = yield* loadProjection(swarm.parentThreadId).pipe(Effect.option);
          admits.set(
            swarm.swarmId,
            Option.match(architect, {
              onNone: () => false,
              onSome: (projection) =>
                projection.thread.archivedAt === null &&
                projection.thread.deletedAt === null &&
                projection.runs.find((run) => run.id === swarm.anchorRunId)?.delegatedCompletion
                  ?.disposition === "open",
            }),
          );
        }
        const pauses = new Map(
          (yield* store.listInstancePauses).map((pause) => [pause.providerInstanceId, pause.until]),
        );
        const now = yield* nowIso;
        const plan = planAdmissions({
          swarms: swarms.map((swarm) => ({
            swarmId: swarm.swarmId,
            createdAt: swarm.createdAt,
            maxConcurrent: swarm.maxConcurrent,
            admits: admits.get(swarm.swarmId) === true,
          })),
          members: [...membersBySwarm.values()].flat().map((member) => ({
            swarmId: member.swarmId,
            memberKey: member.memberKey,
            ordinal: member.ordinal,
            status: member.status,
            providerInstanceId:
              member.providerInstanceId ?? parseSpec(member.specJson).modelSelection.instanceId,
            driver: parseSpec(member.specJson).driver,
          })),
          caps: capsOf(settings),
          pauses,
          now,
        });
        const swarmById = new Map(swarms.map((swarm) => [swarm.swarmId, swarm]));
        for (const planned of plan.admit) {
          const swarm = swarmById.get(planned.swarmId)!;
          const member = membersBySwarm
            .get(planned.swarmId)!
            .find((candidate) => candidate.memberKey === planned.memberKey)!;
          yield* admitMember(swarm, member);
        }
        for (const [swarmId, members] of membersBySwarm) {
          for (const member of members) {
            if (member.status !== "queued") continue;
            const reason = plan.queueReasons.get(memberRef(member));
            if (reason === undefined || reason === member.queueReason) continue;
            yield* store.updateMember({
              swarmId: SwarmId.make(swarmId),
              memberKey: member.memberKey,
              patch: { queueReason: reason, updatedAt: now },
            });
          }
        }
      }),
    );

  const tick: SwarmService["Service"]["tick"] = Effect.gen(function* () {
    const settings = yield* readSettings;
    // Flag off: nothing new is admitted, and the swarm tables are not touched.
    if (!settings.swarmV2Enabled) return;
    yield* pass(settings);
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("swarm.tick-error", {
        causeKind: storageOrDispatchTag(Cause.squash(cause)),
      }),
    ),
  );

  const wake: SwarmService["Service"]["wake"] = Queue.offer(wakes, undefined).pipe(Effect.asVoid);

  const start: SwarmService["Service"]["start"] = Effect.fn("SwarmService.start")(function* () {
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.race(Queue.take(wakes), Effect.sleep(SAFETY_TICK)).pipe(Effect.andThen(tick)),
      ),
    );
    // Member runs starting or ending free and fill slots.
    yield* Effect.forkScoped(
      threads.streamDomainEvents.pipe(
        Stream.filter((event) => event.type === "run.updated"),
        Stream.runForEach(() => wake),
        Effect.ignoreCause,
      ),
    );
    yield* Effect.forkScoped(
      settingsService.streamChanges.pipe(
        Stream.runForEach(() => wake),
        Effect.ignoreCause,
      ),
    );
  });

  const memberResult = (
    scope: McpInvocationScope,
    member: SwarmStore.SwarmMemberRecord,
  ): SwarmMemberResult => {
    const spec = parseSpec(member.specJson);
    return {
      key: member.memberKey,
      title: spec.title,
      status: member.status,
      ...(member.queueReason === null ? {} : { queueReason: member.queueReason }),
      ...(member.taskId === null ? {} : { taskId: member.taskId }),
      ...(member.childThreadId === null
        ? {}
        : {
            childThreadId: member.childThreadId,
            link: threadLinkFor(scope, member.childThreadId),
          }),
      providerInstanceId: member.providerInstanceId ?? spec.modelSelection.instanceId,
      model: spec.modelSelection.model,
      ...(spec.modelSelection.options === undefined
        ? {}
        : { options: spec.modelSelection.options }),
      runtimeMode: member.effectiveRuntimeMode ?? spec.runtimeCeiling,
      interactionMode: member.effectiveInteractionMode ?? spec.interactionCeiling,
      attempt: member.attempt,
      followup: member.followups,
      ...(member.startedAt === null ? {} : { startedAt: member.startedAt }),
      ...(member.endedAt === null ? {} : { endedAt: member.endedAt }),
    };
  };

  const swarmResult = (
    scope: McpInvocationScope,
    swarm: SwarmStore.SwarmRecord,
    warnings: ReadonlyArray<SwarmWarning>,
  ) =>
    store.listMembers(swarm.swarmId).pipe(
      Effect.map((members): SwarmCreateResult => ({
        swarmId: swarm.swarmId,
        title: swarm.title,
        members: members.map((member) => memberResult(scope, member)),
        failed: members
          .filter((member) => member.status === "failed" && member.failureClass === "launch")
          .map((member) => ({
            key: member.memberKey,
            title: parseSpec(member.specJson).title,
            message: "The member could not start. The server log has details.",
          })),
        warnings,
      })),
    );

  const create: SwarmService["Service"]["create"] = Effect.fn("SwarmService.create")(function* ({
    scope,
    input,
    resolver,
  }) {
    const caller = scope.thread;
    if (caller === undefined) {
      return yield* failure("invalid_request", "swarm_create needs an agent inside a T3 thread.");
    }
    const unsupported = unsupportedFields(input);
    if (unsupported !== undefined) return yield* notYet(unsupported);
    const members: ReadonlyArray<SwarmMemberInput> = input.members ?? [];
    if (members.length === 0) {
      return yield* failure("invalid_request", "Give `members`: at least one member.");
    }
    const keys = new Set<string>();
    for (const member of members) {
      if (keys.has(member.key)) {
        return yield* failure(
          "invalid_request",
          `Swarm member key '${member.key}' is repeated. Give every member a unique key.`,
        );
      }
      keys.add(member.key);
      if (member.target?.environmentId !== undefined) {
        return yield* failure(
          "capability_denied",
          "Swarm members run on this machine in this build; remove `target.environmentId`.",
        );
      }
      if (member.target?.projectId !== undefined) {
        return yield* failure(
          "invalid_request",
          "A swarm member runs in this thread's project. Omit target.projectId.",
        );
      }
    }
    const settings = yield* readSettings;
    if (input.maxConcurrent !== undefined && input.maxConcurrent > settings.swarmMaxConcurrent) {
      return yield* failure(
        "invalid_request",
        `maxConcurrent ${input.maxConcurrent} is above this machine's cap of ${settings.swarmMaxConcurrent}.`,
      );
    }
    // Nesting depth 1 (D10): a member starts its own swarm only when its architect allowed it.
    const asMember = yield* store.findMemberByChildThread(caller.threadId);
    if (Option.isSome(asMember) && parseSpec(asMember.value.specJson).allowNestedSwarm !== true) {
      return yield* failure(
        "capability_denied",
        "This swarm member may not start a swarm: its architect did not set allowNestedSwarm.",
      );
    }

    const requestKey = `${scope.requestNamespace}:swarm_create:${input.clientRequestId ?? NodeCrypto.randomUUID()}`;
    const existing = yield* store.getSwarmByRequestKey(requestKey);
    if (Option.isSome(existing)) return yield* swarmResult(scope, existing.value, []);

    const architect = yield* loadProjection(caller.threadId);
    const anchor = liveRunOf(architect, caller.providerInstanceId);
    if (anchor === undefined || anchor.rootNodeId === null) {
      return yield* failure(
        "parent_not_active",
        "swarm_create requires an active run owned by this MCP provider session.",
      );
    }

    // One target resolution per distinct target.
    const targets = new Map<string, ResolvedTarget>();
    const specs: Array<SwarmMemberSpec & { readonly writer: boolean }> = [];
    for (const member of members) {
      const targetKey = encodeSpecJson(member.target ?? null);
      let target = targets.get(targetKey);
      if (target === undefined) {
        target = yield* resolver.resolveTarget(architect, member.target);
        targets.set(targetKey, target);
      }
      const runtimeCeiling = yield* resolveRuntimeMode(
        architect.thread.runtimeMode,
        member.runtimeMode,
        target,
      );
      const interactionCeiling = yield* resolveInteractionMode(
        architect.thread.interactionMode,
        member.interactionMode,
      );
      const verify = member.verify ?? input.verify;
      if (verify !== undefined) {
        if (interactionCeiling === "plan") {
          return yield* failure(
            "invalid_request",
            `Member '${member.key}' has verify but runs in plan mode, which does not edit.`,
          );
        }
        const permits = (mode: string) => mode === "auto" || mode === "full-access";
        if (!permits(architect.thread.runtimeMode) || !permits(runtimeCeiling)) {
          return yield* failure(
            "invalid_request",
            `Member '${member.key}' has verify, which needs runtime mode auto or full-access for both this thread and the member.`,
          );
        }
        return yield* notYet("`verify`");
      }
      specs.push({
        key: member.key,
        title: member.title,
        task: taskPrompt({
          task: member.task,
          ...(member.role === undefined ? {} : { role: member.role }),
        }),
        isolation: member.isolation ?? "shared",
        ...(member.ownsPaths === undefined ? {} : { ownsPaths: member.ownsPaths }),
        ...(member.allowNestedSwarm === undefined
          ? {}
          : { allowNestedSwarm: member.allowNestedSwarm }),
        modelSelection: target.modelSelection,
        ...(target.supportedRuntimeModes === undefined
          ? {}
          : { supportedRuntimeModes: target.supportedRuntimeModes }),
        driver: target.driver,
        runtimeCeiling,
        interactionCeiling,
        writer: isWriter(interactionCeiling),
      });
    }

    // Shared-checkout writers, counting the architect's other active swarms.
    const others: Array<WriterCandidate> = [];
    for (const swarm of yield* store.listSwarms({
      statuses: ["active"],
      parentThreadId: caller.threadId,
    })) {
      for (const member of yield* store.listMembers(swarm.swarmId)) {
        if (isFinalMemberStatus(member.status)) continue;
        const spec = parseSpec(member.specJson);
        others.push({
          key: member.memberKey,
          swarmId: swarm.swarmId,
          isolation: spec.isolation,
          writer: member.writer,
          ownsPaths: spec.ownsPaths,
        });
      }
    }
    const candidates: ReadonlyArray<WriterCandidate> = [
      ...specs.map((spec) => ({
        key: spec.key,
        isolation: spec.isolation,
        writer: spec.writer,
        ownsPaths: spec.ownsPaths,
      })),
      ...others,
    ];
    const refusal = sharedWriterRefusal({
      members: candidates,
      allowSharedWriters: input.allowSharedWriters === true,
    });
    if (refusal !== undefined) return yield* failure("invalid_request", refusal);
    const caps = capsOf(settings);
    const warnings: ReadonlyArray<SwarmWarning> = [
      ...ownsPathsOverlapWarnings(candidates.slice(0, specs.length)),
      ...serialInstanceWarnings({
        members: specs.map((spec) => ({
          key: spec.key,
          instanceId: spec.modelSelection.instanceId,
          driver: spec.driver,
        })),
        caps,
      }),
    ];

    const baseCommit = specs.some((spec) => spec.isolation === "worktree")
      ? yield* resolver.resolveWorktreeBase(architect)
      : null;

    const swarmId = SwarmId.make(`swarm:${NodeCrypto.randomUUID()}`);
    yield* threads
      .dispatch({
        type: "swarm.anchor",
        commandId: CommandId.make(`swarm-anchor:${swarmId}`),
        threadId: caller.threadId,
        runId: anchor.id,
        swarmId,
      })
      .pipe(
        Effect.mapError(() =>
          failure("orchestration_error", "Unable to anchor the swarm on this turn."),
        ),
      );
    const now = yield* nowIso;
    const swarm: SwarmStore.SwarmRecord = {
      swarmId,
      requestKey,
      parentThreadId: caller.threadId,
      anchorRunId: anchor.id,
      anchorNodeId: anchor.rootNodeId,
      baseCommit,
      title: input.title,
      wakePolicy: input.wakePolicy ?? "group",
      wakeBatchJson: null,
      maxConcurrent: input.maxConcurrent ?? null,
      maxTotalTurns: null,
      verifyJson: null,
      sharedContext: null,
      dataShape: null,
      allowSharedWriters: input.allowSharedWriters === true,
      budgetExhausted: false,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    yield* store.createSwarm({
      swarm,
      members: specs.map(({ writer, ...spec }, ordinal) => ({
        memberKey: spec.key,
        ordinal,
        specJson: encodeSpecJson(spec),
        queuedAt: now,
        writer,
        providerInstanceId: spec.modelSelection.instanceId,
      })),
    });
    yield* Effect.logInfo("swarm.created", { swarmId, members: specs.length });
    // Immediate admission: what fits the caps starts inside this call, on the live anchor.
    yield* pass(settings).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("swarm.create-admission-error", {
          swarmId,
          causeKind: storageOrDispatchTag(Cause.squash(cause)),
        }),
      ),
    );
    return yield* swarmResult(scope, swarm, warnings);
  });

  return SwarmService.of({ create, tick, wake, start });
});

export const layer = Layer.effect(SwarmService, make);
