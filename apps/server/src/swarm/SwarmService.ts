// @effect-diagnostics effectFnOpportunity:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type ProviderInteractionMode,
  type RuntimeMode,
  type OrchestrationV2ThreadProjection,
  type OrchestratorMcpTarget,
  type ServerSettings as ServerSettingsValue,
  type SwarmAddMembersInput,
  type SwarmCreateInput,
  type SwarmMap,
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
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Result from "effect/Result";
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
import type * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SwarmStore from "./SwarmStore.ts";
import { expandSwarmMap } from "./swarmMap.ts";
import {
  type SwarmCaps,
  type SwarmMemberSpec,
  type SwarmPlacementOption,
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
  /** Commits on the architect's checkout since `baseCommit` (`git rev-list --count`). */
  readonly countCommitsSince: (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    baseCommit: string,
  ) => Effect.Effect<number, OrchestratorMcpFailure>;
}

export class SwarmService extends Context.Service<
  SwarmService,
  {
    readonly create: (input: {
      readonly scope: McpInvocationScope;
      readonly input: SwarmCreateInput;
      readonly resolver: SwarmTargetResolver;
    }) => Effect.Effect<SwarmCreateResult, OrchestratorMcpFailure>;
    /** swarm_add_members: more members for a swarm, admitted against its anchor. */
    readonly addMembers: (input: {
      readonly scope: McpInvocationScope;
      readonly input: SwarmAddMembersInput;
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

/** The instance a member runs on: its placement for `anyOf`, else its single target. */
const optionFor = (spec: SwarmMemberSpec, instanceId: string | null): SwarmPlacementOption =>
  spec.anyOf?.find((option) => option.modelSelection.instanceId === instanceId) ?? {
    modelSelection: spec.modelSelection,
    ...(spec.supportedRuntimeModes === undefined
      ? {}
      : { supportedRuntimeModes: spec.supportedRuntimeModes }),
    driver: spec.driver,
  };

/** A queued `anyOf` member is bound to no instance until it is placed. */
const rowInstanceId = (spec: SwarmMemberSpec) =>
  spec.anyOf === undefined ? spec.modelSelection.instanceId : null;

const RECENT_FAILURE_WINDOW_MINUTES = 10;

const capsOf = (settings: {
  readonly swarmMaxConcurrent: number;
  readonly swarmMaxConcurrentPerInstance: number;
  readonly swarmInstanceCaps: Readonly<Record<string, number>>;
}): SwarmCaps => ({
  global: settings.swarmMaxConcurrent,
  perInstance: settings.swarmMaxConcurrentPerInstance,
  instanceOverrides: settings.swarmInstanceCaps,
});

/**
 * The architect's run this MCP call belongs to, by delegate_task's rule: the newest active run,
 * refused when another provider owns it.
 */
const liveRunOf = (
  parent: Pick<OrchestrationV2ThreadProjection, "runs">,
  providerInstanceId: string,
): OrchestrationV2Run | undefined => {
  const newest = parent.runs
    .filter(ThreadManagementService.isActiveRun)
    .toSorted((left, right) => right.ordinal - left.ordinal)[0];
  return newest === undefined ||
    newest.rootNodeId === null ||
    newest.providerInstanceId !== providerInstanceId
    ? undefined
    : newest;
};

type AdmissionFailureKind = "provider_disabled" | "refused" | "unknown";

/** A failed dispatch by class, as delegate_task maps it; the message never carries task text. */
const failureKindOf = (error: unknown): AdmissionFailureKind => {
  switch (storageOrDispatchTag(error)) {
    case "ThreadManagementProviderInstanceDisabledError":
      return "provider_disabled";
    case "OrchestratorDispatchError":
    case "OrchestratorCommandPreviouslyRejectedError":
      return "refused";
    default:
      return "unknown";
  }
};

const FAILURE_MESSAGES: Readonly<Record<AdmissionFailureKind, string>> = {
  provider_disabled: "Its provider instance is disabled for this project.",
  refused: "The orchestrator refused to start it.",
  unknown: "The member could not start. The server log has details.",
};

/** Swarm fields a later task owns; until then they fail explicitly rather than being ignored. */
const unsupportedSwarmFields = (input: SwarmCreateInput): string | undefined => {
  if (input.dataShape !== undefined) return "`dataShape`";
  if (input.wakeBatch !== undefined || (input.wakePolicy ?? "group") !== "group") {
    return "A `wakePolicy` other than 'group'";
  }
  if (input.maxTotalTurns !== undefined) return "`maxTotalTurns`";
  return undefined;
};

/** The same for member fields, checked after a `map` expands. */
const unsupportedMemberFields = (members: ReadonlyArray<SwarmMemberInput>): string | undefined => {
  for (const member of members) {
    if (member.doneCriteria !== undefined) return "`doneCriteria`";
    if (member.maxTurns !== undefined) return "`maxTurns`";
    if (member.maxWallClockMs !== undefined) return "`maxWallClockMs`";
  }
  return undefined;
};

/** D5: members per swarm, retries included. */
const SWARM_MAX_MEMBERS_TOTAL = 48;
const SHARED_CONTEXT_MAX_BYTES = 16_384;
const utf8 = new TextEncoder();

const make = Effect.gen(function* () {
  const store = yield* SwarmStore.SwarmStore;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  // Admission passes run one at a time, so a create and a tick never admit the same row twice.
  const passLock = yield* Semaphore.make(1);
  const wakes = yield* Queue.sliding<void>(1);

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  const readSettings = settingsService.getSettings.pipe(
    Effect.mapError(() => failure("orchestration_error", "Unable to read settings.")),
  );

  /** The thread and its runs only: the scheduler never needs a transcript. */
  const loadRuns = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read a swarm thread.")),
      );

  /** Why a member's last admission failed, by class only, for the next swarm_create result. */
  const admissionFailures = new Map<string, AdmissionFailureKind>();

  /** Threads whose run changes matter to the scheduler: architects and launched members. */
  let watchedThreads: ReadonlySet<string> = new Set();

  const admissionCommand = (
    swarm: SwarmStore.SwarmRecord,
    spec: SwarmMemberSpec,
    option: SwarmPlacementOption,
    input: {
      readonly commandId: CommandId;
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ) =>
    ({
      type: "delegated_task.request",
      createdBy: "agent",
      creationSource: "server",
      commandId: input.commandId,
      parentThreadId: swarm.parentThreadId,
      parentRunId: swarm.anchorRunId,
      parentNodeId: swarm.anchorNodeId,
      task: spec.task,
      title: spec.title,
      modelSelection: option.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: input.interactionMode,
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
    }) satisfies Extract<OrchestrationV2Command, { readonly type: "delegated_task.request" }>;

  /** Records a dispatch's outcome: the child's ids on success, class `launch` on failure. */
  const finishAdmission = Effect.fn("SwarmService.finishAdmission")(function* (input: {
    readonly swarm: SwarmStore.SwarmRecord;
    readonly member: SwarmStore.SwarmMemberRecord;
    readonly option: SwarmPlacementOption;
    readonly commandId: CommandId;
    readonly dispatched: Result.Result<Orchestrator.OrchestratorV2DispatchResult, unknown>;
  }) {
    const { swarm, member, option, commandId, dispatched } = input;
    const endedAt = yield* nowIso;
    const events = Result.isSuccess(dispatched) ? dispatched.success.storedEvents : [];
    const task = events.flatMap((stored) =>
      stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned"
        ? [stored.event.payload]
        : [],
    )[0];
    if (task === undefined || task.childThreadId === null) {
      const kind = Result.isFailure(dispatched) ? failureKindOf(dispatched.failure) : "unknown";
      admissionFailures.set(memberRef(member), kind);
      yield* Effect.logWarning("swarm.admission-failed", {
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        attempt: member.attempt,
        failureKind: kind,
      });
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: {
          status: "failed",
          failureClass: "launch",
          lastFailureClass: "launch",
          lastFailedAt: endedAt,
          lastFailedInstanceId: option.modelSelection.instanceId,
          endedAt,
          updatedAt: endedAt,
        },
      });
      return;
    }
    const childThreadId = task.childThreadId;
    const childRun = events.flatMap((stored) =>
      stored.event.type === "run.created" && stored.event.threadId === childThreadId
        ? [stored.event.payload]
        : [],
    )[0];
    yield* store.updateMember({
      swarmId: swarm.swarmId,
      memberKey: member.memberKey,
      patch: {
        taskId: task.id,
        childThreadId,
        ...(childRun === undefined ? {} : { childRunId: childRun.id, boundRunId: childRun.id }),
        providerInstanceId: option.modelSelection.instanceId,
        updatedAt: endedAt,
      },
    });
    // A late worktree member never leaves preparation without this (§4.2).
    if (childRun?.workspacePreparation !== undefined) {
      yield* threadLaunch.prepareRun({ commandId, threadId: childThreadId, runId: childRun.id });
    }
  });

  const dispatchAdmission = Effect.fn("SwarmService.admitMember")(function* (
    swarm: SwarmStore.SwarmRecord,
    member: SwarmStore.SwarmMemberRecord,
    architect: Pick<OrchestrationV2ThreadProjection, "thread">,
    placedInstanceId: string | null,
  ) {
    const spec = parseSpec(member.specJson);
    const option = optionFor(spec, placedInstanceId);
    // Ceilings never rise; the architect's current modes can only lower them. The runtime mode
    // steps down if the placed instance does not offer it (rev 3.2).
    const runtimeMode = yield* resolveRuntimeMode(
      narrowerRuntimeMode(spec.runtimeCeiling, architect.thread.runtimeMode),
      undefined,
      {
        modelSelection: option.modelSelection,
        supportedRuntimeModes: option.supportedRuntimeModes,
      },
    );
    const interactionMode = narrowerInteractionMode(
      spec.interactionCeiling,
      architect.thread.interactionMode,
    );
    const commandId = CommandId.make(
      `swarm-admit:${swarm.swarmId}:${member.memberKey}:${member.attempt}`,
    );
    // Written with the placement before the dispatch, so a crash replays the same command on
    // the same instance (resumeAdmission) instead of placing again. Sticky from here on.
    yield* store.updateMember({
      swarmId: swarm.swarmId,
      memberKey: member.memberKey,
      patch: {
        status: "launching",
        queueReason: null,
        commandId,
        providerInstanceId: option.modelSelection.instanceId,
        effectiveRuntimeMode: runtimeMode,
        effectiveInteractionMode: interactionMode,
        updatedAt: yield* nowIso,
      },
    });
    const dispatched = yield* threads
      .dispatch(admissionCommand(swarm, spec, option, { commandId, runtimeMode, interactionMode }))
      .pipe(Effect.result);
    yield* finishAdmission({ swarm, member, option, commandId, dispatched });
  });

  /**
   * A row left `launching` before its child ids were stored (a crash or a lost dispatch)
   * dispatches the same command again; the orchestrator's receipts make that idempotent.
   */
  const resumeAdmission = Effect.fn("SwarmService.resumeAdmission")(function* (
    swarm: SwarmStore.SwarmRecord,
    member: SwarmStore.SwarmMemberRecord & { readonly commandId: CommandId },
  ) {
    const spec = parseSpec(member.specJson);
    const option = optionFor(spec, member.providerInstanceId);
    const dispatched = yield* threads
      .dispatch(
        admissionCommand(swarm, spec, option, {
          commandId: member.commandId,
          runtimeMode: member.effectiveRuntimeMode ?? spec.runtimeCeiling,
          interactionMode: member.effectiveInteractionMode ?? spec.interactionCeiling,
        }),
      )
      .pipe(Effect.result);
    yield* finishAdmission({ swarm, member, option, commandId: member.commandId, dispatched });
  });

  const logged =
    (event: string, ids: Readonly<Record<string, unknown>>) =>
    <A, E, R>(effect: Effect.Effect<A, E, R>) =>
      effect.pipe(
        Effect.asVoid,
        Effect.catchCause((cause) =>
          Effect.logWarning(event, {
            ...ids,
            causeKind: storageOrDispatchTag(Cause.squash(cause)),
          }),
        ),
      );

  /**
   * Seam for SW-A5/A6/A8, which must replace it before `"held"` is honored: until envelopes,
   * verify, and failure classes land, a member whose first run ended is final by its run status.
   */
  const reconcileMember = Effect.fn("SwarmService.reconcileMember")(function* (
    swarm: SwarmStore.SwarmRecord,
    member: SwarmStore.SwarmMemberRecord,
  ) {
    if (member.childThreadId === null || member.childRunId === null) return;
    const child = yield* loadRuns(member.childThreadId);
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

  /**
   * The architect's Stop cancels a swarm (D12): rows that never launched become `cancelled`.
   * Cancelling the queued wake disposes the cohort and detaches it: launched members keep
   * running unmanaged. Archive or delete cancels (§4.6).
   */
  const closeSwarm = Effect.fn("SwarmService.closeSwarm")(function* (
    swarm: SwarmStore.SwarmRecord,
    members: ReadonlyArray<SwarmStore.SwarmMemberRecord>,
    outcome: "stopped" | "detached" | "closed_thread",
  ) {
    const now = yield* nowIso;
    let cancelled = 0;
    let detached = 0;
    for (const member of members) {
      const neverLaunched =
        member.status === "queued" ||
        (member.status === "launching" && member.childThreadId === null);
      if (neverLaunched) {
        cancelled += 1;
        yield* store.updateMember({
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          patch: {
            status: "cancelled",
            queueReason: null,
            ...(outcome === "stopped" ? { failureClass: "cancelled_by_architect_stop" } : {}),
            endedAt: now,
            updatedAt: now,
          },
        });
      } else if (outcome === "detached" && !isFinalMemberStatus(member.status)) {
        detached += 1;
        yield* store.updateMember({
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          patch: { status: "detached", updatedAt: now },
        });
      }
    }
    yield* store.updateSwarm(swarm.swarmId, {
      status: outcome === "detached" ? "detached" : "cancelled",
      updatedAt: now,
    });
    yield* Effect.logInfo("swarm.closed", { swarmId: swarm.swarmId, outcome, cancelled, detached });
  });

  const anchorStateOf = (
    swarm: SwarmStore.SwarmRecord,
    architect: Option.Option<Pick<OrchestrationV2ThreadProjection, "thread" | "runs">>,
  ): "open" | "stopped" | "detached" | "closed_thread" | "unknown" => {
    if (Option.isNone(architect)) return "unknown";
    const { thread, runs } = architect.value;
    if (thread.archivedAt !== null || thread.deletedAt !== null) return "closed_thread";
    const disposition = runs.find((run) => run.id === swarm.anchorRunId)?.delegatedCompletion
      ?.disposition;
    return disposition === "open"
      ? "open"
      : disposition === "stopped"
        ? "stopped"
        : disposition === "disposed"
          ? "detached"
          : "unknown";
  };

  const pass = (settings: ServerSettingsValue) =>
    passLock.withPermits(1)(
      Effect.gen(function* () {
        // Cancelled swarms still hold slots until their launched members end.
        const swarms = yield* store.listSwarms({ statuses: ["active", "cancelled"] });
        const membersBySwarm = new Map<string, ReadonlyArray<SwarmStore.SwarmMemberRecord>>();
        const architects = new Map<
          string,
          Option.Option<Pick<OrchestrationV2ThreadProjection, "thread" | "runs">>
        >();
        const admits = new Map<string, boolean>();
        const watched = new Set<string>();
        for (const swarm of swarms) {
          let members = yield* store.listMembers(swarm.swarmId);
          if (
            swarm.status === "cancelled" &&
            members.every((row) => isFinalMemberStatus(row.status))
          ) {
            continue;
          }
          // A launched member whose run ended is final before the swarm closes around it.
          for (const member of members) {
            if (
              member.childThreadId !== null &&
              (member.status === "launching" || member.status === "running")
            ) {
              yield* reconcileMember(swarm, member).pipe(
                logged("swarm.reconcile-error", {
                  swarmId: swarm.swarmId,
                  memberKey: member.memberKey,
                }),
              );
            }
          }
          members = yield* store.listMembers(swarm.swarmId);
          const architect = yield* loadRuns(swarm.parentThreadId).pipe(Effect.option);
          architects.set(swarm.swarmId, architect);
          const state = swarm.status === "active" ? anchorStateOf(swarm, architect) : "unknown";
          if (state === "stopped" || state === "detached" || state === "closed_thread") {
            yield* closeSwarm(swarm, members, state).pipe(
              logged("swarm.close-error", { swarmId: swarm.swarmId }),
            );
          } else if (state === "open") {
            for (const member of members) {
              if (
                member.status === "launching" &&
                member.childThreadId === null &&
                member.commandId !== null
              ) {
                yield* resumeAdmission(swarm, { ...member, commandId: member.commandId }).pipe(
                  logged("swarm.resume-error", {
                    swarmId: swarm.swarmId,
                    memberKey: member.memberKey,
                  }),
                );
              }
            }
          }
          members = yield* store.listMembers(swarm.swarmId);
          membersBySwarm.set(swarm.swarmId, members);
          admits.set(swarm.swarmId, swarm.status === "active" && state === "open");
          watched.add(swarm.parentThreadId);
          for (const member of members) {
            if (member.childThreadId !== null && !isFinalMemberStatus(member.status)) {
              watched.add(member.childThreadId);
            }
          }
        }
        watchedThreads = watched;
        if (membersBySwarm.size === 0) return;
        const pauses = new Map(
          (yield* store.listInstancePauses).map((pause) => [pause.providerInstanceId, pause.until]),
        );
        const now = yield* nowIso;
        const healthy = new Set(
          (yield* providerRegistry.getProviders)
            .filter(
              (provider) =>
                provider.enabled &&
                provider.status !== "error" &&
                provider.status !== "disabled" &&
                provider.auth.status !== "unauthenticated",
            )
            .map((provider) => String(provider.instanceId)),
        );
        const failureSince = DateTime.formatIso(
          DateTime.subtract(yield* DateTime.now, { minutes: RECENT_FAILURE_WINDOW_MINUTES }),
        );
        const recentFailures = new Map<string, number>();
        for (const member of [...membersBySwarm.values()].flat()) {
          if (member.lastFailedInstanceId === null || member.lastFailedAt === null) continue;
          if (member.lastFailedAt < failureSince) continue;
          recentFailures.set(
            member.lastFailedInstanceId,
            (recentFailures.get(member.lastFailedInstanceId) ?? 0) + 1,
          );
        }
        const tracked = swarms.filter((swarm) => membersBySwarm.has(swarm.swarmId));
        const plan = planAdmissions({
          swarms: tracked.map((swarm) => ({
            swarmId: swarm.swarmId,
            createdAt: swarm.createdAt,
            maxConcurrent: swarm.maxConcurrent,
            admits: admits.get(swarm.swarmId) === true,
          })),
          members: [...membersBySwarm.values()].flat().map((member) => {
            const spec = parseSpec(member.specJson);
            const unplaced = member.providerInstanceId === null && spec.anyOf !== undefined;
            return {
              swarmId: member.swarmId,
              memberKey: member.memberKey,
              ordinal: member.ordinal,
              status: member.status,
              providerInstanceId: member.providerInstanceId ?? rowInstanceId(spec),
              driver: spec.driver,
              ...(unplaced
                ? { anyOf: spec.anyOf!.map((option) => String(option.modelSelection.instanceId)) }
                : {}),
            };
          }),
          caps: capsOf(settings),
          pauses,
          now,
          healthy,
          recentFailures,
        });
        const swarmById = new Map(tracked.map((swarm) => [swarm.swarmId, swarm]));
        for (const planned of plan.admit) {
          const swarm = swarmById.get(planned.swarmId)!;
          const member = membersBySwarm
            .get(planned.swarmId)!
            .find((candidate) => candidate.memberKey === planned.memberKey)!;
          const architect = architects.get(swarm.swarmId);
          if (architect === undefined || Option.isNone(architect)) continue;
          yield* dispatchAdmission(swarm, member, architect.value, planned.placedInstanceId).pipe(
            logged("swarm.admission-error", {
              swarmId: swarm.swarmId,
              memberKey: member.memberKey,
            }),
          );
          if (member.childThreadId === null) {
            const updated = (yield* store.listMembers(swarm.swarmId)).find(
              (candidate) => candidate.memberKey === member.memberKey,
            );
            if (updated?.childThreadId != null) watched.add(updated.childThreadId);
          }
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
  }).pipe(logged("swarm.tick-error", {}));

  const wake: SwarmService["Service"]["wake"] = Queue.offer(wakes, undefined).pipe(Effect.asVoid);

  /** Member and architect runs starting or ending free and fill slots. */
  const watchRunEvents = threads.streamDomainEvents.pipe(
    Stream.filter((event) => event.type === "run.updated" && watchedThreads.has(event.threadId)),
    Stream.runForEach(() => wake),
    Effect.ignoreCause,
  );

  const start: SwarmService["Service"]["start"] = Effect.fn("SwarmService.start")(function* () {
    const scope = yield* Effect.scope;
    yield* Effect.forkScoped(
      Effect.forever(
        Effect.race(Queue.take(wakes), Effect.sleep(SAFETY_TICK)).pipe(Effect.andThen(tick)),
      ),
    );
    // With the flag off nothing subscribes to domain events; turning it on subscribes.
    let subscription: Fiber.Fiber<void> | undefined;
    const follow = Effect.fn("SwarmService.followRunEvents")(function* (enabled: boolean) {
      if (enabled && subscription === undefined) {
        subscription = yield* Effect.forkIn(watchRunEvents, scope);
      } else if (!enabled && subscription !== undefined) {
        const running = subscription;
        subscription = undefined;
        yield* Fiber.interrupt(running);
      }
    });
    const initial = yield* settingsService.getSettings.pipe(Effect.option);
    yield* follow(Option.isSome(initial) && initial.value.swarmV2Enabled);
    yield* Effect.forkScoped(
      settingsService.streamChanges.pipe(
        Stream.runForEach((settings) => follow(settings.swarmV2Enabled).pipe(Effect.andThen(wake))),
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
      providerInstanceId: member.providerInstanceId ?? rowInstanceId(spec),
      ...(spec.anyOf === undefined
        ? {}
        : { anyOf: spec.anyOf.map((option) => option.modelSelection.instanceId) }),
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
            message: FAILURE_MESSAGES[admissionFailures.get(memberRef(member)) ?? "unknown"],
          })),
        warnings,
      })),
    );

  /** The roster a call asks for: its `members`, or its expanded `map` (exactly one). */
  const rosterOf = Effect.fn("SwarmService.rosterOf")(function* (input: {
    readonly members?: ReadonlyArray<SwarmMemberInput> | undefined;
    readonly map?: SwarmMap | undefined;
  }) {
    if ((input.members === undefined) === (input.map === undefined)) {
      return yield* failure("invalid_request", "Give exactly one of `members` and `map`.");
    }
    if (input.members !== undefined) return input.members;
    const expanded = expandSwarmMap(input.map!);
    if (!expanded.ok) return yield* failure("invalid_request", expanded.message);
    return expanded.members;
  });

  /**
   * Validates and resolves a roster for swarm_create and swarm_add_members alike: keys, remote
   * and project targets, targets once per distinct target, mode ceilings, verify, writers, and
   * warnings. Writers count the architect's other active swarms; overlaps count `swarm`'s own.
   */
  const prepareRoster = Effect.fn("SwarmService.prepareRoster")(function* (input: {
    readonly caller: NonNullable<McpInvocationScope["thread"]>;
    readonly architect: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly members: ReadonlyArray<SwarmMemberInput>;
    readonly existingKeys: ReadonlySet<string>;
    readonly existingWriters: ReadonlyArray<WriterCandidate>;
    readonly verify: SwarmCreateInput["verify"];
    readonly allowSharedWriters: boolean;
    readonly settings: ServerSettingsValue;
    readonly resolver: SwarmTargetResolver;
  }) {
    const { architect, members, resolver } = input;
    const unsupported = unsupportedMemberFields(members);
    if (unsupported !== undefined) return yield* notYet(unsupported);
    const keys = new Set<string>();
    for (const member of members) {
      if (keys.has(member.key) || input.existingKeys.has(member.key)) {
        return yield* failure(
          "invalid_request",
          `Swarm member key '${member.key}' is repeated. Give every member a unique key.`,
        );
      }
      keys.add(member.key);
      if (member.target?.environmentId !== undefined && member.target.anyOf === undefined) {
        return yield* failure(
          "capability_denied",
          "Swarm members run on this machine in this build; remove `target.environmentId`.",
        );
      }
      if (member.target?.projectId !== undefined && member.target.anyOf === undefined) {
        return yield* failure(
          "invalid_request",
          "A swarm member runs in this thread's project. Omit target.projectId.",
        );
      }
    }
    if (input.existingKeys.size + members.length > SWARM_MAX_MEMBERS_TOTAL) {
      return yield* failure(
        "invalid_request",
        `A swarm has at most ${SWARM_MAX_MEMBERS_TOTAL} members, retries included; this call would make ${input.existingKeys.size + members.length}.`,
      );
    }

    // One target resolution per distinct target.
    const targets = new Map<string, ResolvedTarget>();
    const specs: Array<SwarmMemberSpec & { readonly writer: boolean }> = [];
    const resolveOnce = Effect.fn("SwarmService.resolveTargetOnce")(function* (
      target: OrchestratorMcpTarget | undefined,
    ) {
      const targetKey = encodeSpecJson(target ?? null);
      const known = targets.get(targetKey);
      if (known !== undefined) return known;
      const resolved = yield* resolver.resolveTarget(architect, target);
      targets.set(targetKey, resolved);
      return resolved;
    });
    for (const member of members) {
      const anyOf = member.target?.anyOf;
      let target: ResolvedTarget;
      let options: ReadonlyArray<SwarmPlacementOption> | undefined;
      let runtimeCeiling: RuntimeMode;
      if (anyOf === undefined) {
        target = yield* resolveOnce(member.target);
        runtimeCeiling = yield* resolveRuntimeMode(
          architect.thread.runtimeMode,
          member.runtimeMode,
          target,
        );
      } else {
        const { anyOf: _anyOf, ...single } = member.target!;
        for (const field of [
          "providerInstanceId",
          "driverKind",
          "environmentId",
          "projectId",
        ] as const) {
          if (single[field] !== undefined) {
            return yield* failure(
              "invalid_request",
              `Member '${member.key}': target.anyOf excludes target.${field}.`,
            );
          }
        }
        if (single.model === undefined) {
          return yield* failure(
            "invalid_request",
            `Member '${member.key}': target.anyOf requires target.model.`,
          );
        }
        const resolved: Array<ResolvedTarget> = [];
        for (const instanceId of new Set(anyOf)) {
          resolved.push(
            yield* resolveOnce({ ...single, providerInstanceId: instanceId }).pipe(
              Effect.mapError((error) =>
                failure(
                  "invalid_request",
                  `Member '${member.key}': anyOf instance ${instanceId} cannot run it. ${error.message}`,
                ),
              ),
            ),
          );
        }
        const first = resolved[0]!;
        const otherDriver = resolved.find((option) => option.driver !== first.driver);
        if (otherDriver !== undefined) {
          return yield* failure(
            "invalid_request",
            `Member '${member.key}': anyOf instance ${otherDriver.modelSelection.instanceId} uses driver ${otherDriver.driver}, not ${first.driver}. List instances of one driver.`,
          );
        }
        // An explicit mode must be offered by every instance; an inherited one steps down per
        // instance, so the ceiling is the narrowest across them.
        let ceiling: RuntimeMode | undefined;
        for (const option of resolved) {
          const mode = yield* resolveRuntimeMode(
            architect.thread.runtimeMode,
            member.runtimeMode,
            option,
          );
          ceiling = ceiling === undefined ? mode : narrowerRuntimeMode(ceiling, mode);
        }
        runtimeCeiling = ceiling!;
        target = first;
        options = resolved.map((option) => ({
          modelSelection: option.modelSelection,
          ...(option.supportedRuntimeModes === undefined
            ? {}
            : { supportedRuntimeModes: option.supportedRuntimeModes }),
          driver: option.driver,
        }));
      }
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
        ...(member.role === undefined ? {} : { role: member.role }),
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
        ...(options === undefined ? {} : { anyOf: options }),
        runtimeCeiling,
        interactionCeiling,
        writer: isWriter(interactionCeiling),
      });
    }

    // Shared-checkout writers, counting the architect's other active swarms.
    const others: Array<WriterCandidate> = [];
    for (const swarm of yield* store.listSwarms({
      statuses: ["active"],
      parentThreadId: input.caller.threadId,
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
    const added: ReadonlyArray<WriterCandidate> = specs.map((spec) => ({
      key: spec.key,
      isolation: spec.isolation,
      writer: spec.writer,
      ownsPaths: spec.ownsPaths,
    }));
    const refusal = sharedWriterRefusal({
      members: [...added, ...others],
      allowSharedWriters: input.allowSharedWriters,
    });
    if (refusal !== undefined) return yield* failure("invalid_request", refusal);
    const total = input.existingKeys.size + specs.length;
    const warnings: ReadonlyArray<SwarmWarning> = [
      ...ownsPathsOverlapWarnings([...added, ...input.existingWriters]),
      ...serialInstanceWarnings({
        members: specs.flatMap((spec) =>
          (spec.anyOf ?? [spec]).map((option) => ({
            key: spec.key,
            instanceId: option.modelSelection.instanceId,
            driver: option.driver,
          })),
        ),
        caps: capsOf(input.settings),
      }),
      ...(total >= SWARM_MAX_MEMBERS_TOTAL
        ? [
            {
              kind: "no_retry_room" as const,
              message: `This swarm now has ${total} members, the most a swarm can hold, so no member can be retried.`,
            },
          ]
        : []),
    ];
    return { specs, warnings };
  });

  const memberRows = (
    specs: ReadonlyArray<SwarmMemberSpec & { readonly writer: boolean }>,
    firstOrdinal: number,
    now: string,
  ) =>
    specs.map(({ writer, ...spec }, index) => ({
      memberKey: spec.key,
      ordinal: firstOrdinal + index,
      specJson: encodeSpecJson(spec),
      queuedAt: now,
      writer,
      providerInstanceId: rowInstanceId(spec),
    }));

  const admitNow = (swarmId: SwarmId, settings: ServerSettingsValue) =>
    pass(settings).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("swarm.admission-pass-error", {
          swarmId,
          causeKind: storageOrDispatchTag(Cause.squash(cause)),
        }),
      ),
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
    const unsupported = unsupportedSwarmFields(input);
    if (unsupported !== undefined) return yield* notYet(unsupported);
    if (
      input.sharedContext !== undefined &&
      utf8.encode(input.sharedContext).length > SHARED_CONTEXT_MAX_BYTES
    ) {
      return yield* failure(
        "invalid_request",
        `sharedContext is ${utf8.encode(input.sharedContext).length} bytes; the limit is ${SHARED_CONTEXT_MAX_BYTES}.`,
      );
    }
    const members = yield* rosterOf(input);
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

    const architect = yield* loadRuns(caller.threadId);
    const anchor = liveRunOf(architect, caller.providerInstanceId);
    if (anchor === undefined || anchor.rootNodeId === null) {
      return yield* failure(
        "parent_not_active",
        "swarm_create requires an active run owned by this MCP provider session.",
      );
    }
    const { specs, warnings } = yield* prepareRoster({
      caller,
      architect,
      members,
      existingKeys: new Set(),
      existingWriters: [],
      verify: input.verify,
      allowSharedWriters: input.allowSharedWriters === true,
      settings,
      resolver,
    });

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
      sharedContext: input.sharedContext ?? null,
      dataShape: null,
      allowSharedWriters: input.allowSharedWriters === true,
      budgetExhausted: false,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    const created = yield* store
      .createSwarm({ swarm, members: memberRows(specs, 0, now) })
      .pipe(Effect.result);
    if (Result.isFailure(created)) {
      // A concurrent call with the same clientRequestId won the unique request_key.
      const winner = yield* store.getSwarmByRequestKey(requestKey);
      if (Option.isSome(winner)) return yield* swarmResult(scope, winner.value, []);
      return yield* created.failure;
    }
    yield* Effect.logInfo("swarm.created", {
      swarmId,
      members: specs.length,
      shape: input.map === undefined ? "members" : "map",
    });
    // Immediate admission: what fits the caps starts inside this call, on the live anchor.
    yield* admitNow(swarmId, settings);
    return yield* swarmResult(scope, swarm, warnings);
  });

  const addMembers: SwarmService["Service"]["addMembers"] = Effect.fn("SwarmService.addMembers")(
    function* ({ scope, input, resolver }) {
      const caller = scope.thread;
      if (caller === undefined) {
        return yield* failure(
          "invalid_request",
          "swarm_add_members needs an agent inside a T3 thread.",
        );
      }
      const found = yield* store.getSwarm(input.swarmId);
      if (Option.isNone(found) || found.value.parentThreadId !== caller.threadId) {
        // The same answer for a swarm that is not this thread's, so ids cannot be probed.
        return yield* failure(
          "capability_denied",
          `Only the thread that created swarm ${input.swarmId} can add members to it.`,
        );
      }
      const swarm = found.value;
      if (swarm.status !== "active" && swarm.status !== "completed") {
        return yield* failure(
          "invalid_request",
          `Swarm ${input.swarmId} is ${swarm.status} and takes no more members.`,
        );
      }
      if (swarm.budgetExhausted) {
        return yield* failure(
          "invalid_request",
          `Swarm ${input.swarmId} used its turn budget and takes no more members.`,
        );
      }
      const members = yield* rosterOf(input);
      const existing = yield* store.listMembers(swarm.swarmId);
      // A retried call adds nothing twice: every key it names already exists from the first.
      if (
        input.clientRequestId !== undefined &&
        members.every((member) => existing.some((row) => row.memberKey === member.key))
      ) {
        return yield* swarmResult(scope, swarm, []);
      }
      const settings = yield* readSettings;
      const architect = yield* loadRuns(caller.threadId);
      // §4.3: adding reopens a completed swarm only while its anchor still admits members.
      const anchor = architect.runs.find((run) => run.id === swarm.anchorRunId);
      if (anchor?.delegatedCompletion?.disposition !== "open") {
        return yield* failure(
          "invalid_request",
          `The anchor turn of swarm ${input.swarmId} no longer admits members.`,
        );
      }
      const { specs, warnings } = yield* prepareRoster({
        caller,
        architect,
        members,
        existingKeys: new Set(existing.map((row) => row.memberKey)),
        existingWriters: existing
          .filter((row) => !isFinalMemberStatus(row.status))
          .map((row) => {
            const spec = parseSpec(row.specJson);
            return {
              key: row.memberKey,
              isolation: spec.isolation,
              writer: row.writer,
              ownsPaths: spec.ownsPaths,
            };
          }),
        verify: undefined,
        allowSharedWriters: swarm.allowSharedWriters,
        settings,
        resolver,
      });
      const now = yield* nowIso;
      let baseCommit = swarm.baseCommit;
      const extra: Array<SwarmWarning> = [];
      if (specs.some((spec) => spec.isolation === "worktree")) {
        if (baseCommit === null) {
          baseCommit = yield* resolver.resolveWorktreeBase(architect);
        } else {
          // Added members start from the swarm's base, which may be behind the architect now.
          const behind = yield* resolver
            .countCommitsSince(architect, baseCommit)
            .pipe(Effect.orElseSucceed(() => 0));
          if (behind > 0) {
            extra.push({
              kind: "base_behind_head",
              message: `Added worktree members start from the swarm's base commit, ${behind} commit${behind === 1 ? "" : "s"} behind your checkout.`,
            });
          }
        }
      }
      yield* store.addMembers({
        swarmId: swarm.swarmId,
        members: memberRows(
          specs,
          existing.reduce((next, row) => Math.max(next, row.ordinal + 1), 0),
          now,
        ),
        updatedAt: now,
      });
      if (swarm.status === "completed" || baseCommit !== swarm.baseCommit) {
        yield* store.updateSwarm(swarm.swarmId, {
          status: "active",
          ...(baseCommit === swarm.baseCommit ? {} : { baseCommit }),
          updatedAt: now,
        });
      }
      yield* Effect.logInfo("swarm.members-added", {
        swarmId: swarm.swarmId,
        members: specs.length,
      });
      // Added members always go through the swarm-admission path against the anchor.
      yield* admitNow(swarm.swarmId, settings);
      const updated = yield* store.getSwarm(swarm.swarmId);
      return yield* swarmResult(
        scope,
        Option.getOrElse(updated, () => swarm),
        [...warnings, ...extra],
      );
    },
  );

  return SwarmService.of({ create, addMembers, tick, wake, start });
});

export const layer = Layer.effect(SwarmService, make);
