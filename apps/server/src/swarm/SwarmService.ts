// @effect-diagnostics effectFnOpportunity:off nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  MessageId,
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
  type SwarmEnvelope,
  SwarmWakeBatch,
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
import * as FiberMap from "effect/FiberMap";
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
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import {
  DELEGATED_RESULT_INLINE_BYTES,
  delegatedCompletionWakeEntryBytes,
} from "../orchestration-v2/delegatedCompletionWake.ts";
import { subagentResultForRun } from "@t3tools/provider-core/server/subagentProjection";
import * as ServerSettings from "../serverSettings.ts";
import * as SwarmStore from "./SwarmStore.ts";
import * as SwarmVerifier from "./SwarmVerifier.ts";
import { expandSwarmMap } from "./swarmMap.ts";
import {
  capChangedPaths,
  type FinalMemberStatus,
  matchesAnyGlob,
  parseSwarmResult,
  swarmDigest,
} from "./swarmEnvelope.ts";
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
  readyForRelease,
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
    /** SW-A7 hands a released member's follow-up result to the note outbox. */
    readonly queueFollowupResult: (input: {
      readonly swarmId: SwarmId;
      readonly memberKey: string;
      readonly followup: number;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
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
  if (input.maxTotalTurns !== undefined) return "`maxTotalTurns`";
  return undefined;
};

const WakeBatchJson = Schema.fromJsonString(SwarmWakeBatch);
const decodeWakeBatchJson = Schema.decodeOption(WakeBatchJson);
const decodeWakeBatch = (json: string | null) =>
  json === null ? {} : Option.getOrElse(decodeWakeBatchJson(json), () => ({}));
const encodeWakeBatch = Schema.encodeSync(WakeBatchJson);
const decodeEnvelope = (json: string) => decodeSpecJson(json) as SwarmEnvelope;

type SwarmNoteKind =
  | "cancelled"
  | "detached"
  | "budget"
  | "instance_paused"
  | "approvals"
  | "delivery_stalled";

const NOTE_WINDOW_MS = 30_000;
const FOLLOWUP_COALESCE_MS = 5_000;
const DELIVERY_STALL_MS = 10 * 60_000;
const MAX_RELEASE_ATTEMPTS = 5;
const VERIFY_DEFAULT_TIMEOUT_MS = 600_000;
const VERIFY_DEFAULT_MAX_RETRIES = 2;
const VERIFY_NOT_STARTED_MESSAGE =
  'The verify command could not be started; on Windows use ["cmd", "/c", …] for .cmd/.bat commands.';
/** The retry message carries the last 2 KB of the verify output. */
const VERIFY_RETRY_OUTPUT_CHARACTERS = 2_048;

/** A finished check, with the attempt it belongs to. */
interface VerifyResult {
  readonly swarmId: SwarmId;
  readonly memberKey: string;
  readonly boundRunId: string;
  readonly verifyAttempts: number;
  /** A finished command, or a check skipped because a mode no longer allows it. */
  readonly outcome:
    | SwarmVerifier.SwarmVerifyOutcome
    | { readonly skipped: "runtime_mode" | "plan_mode" };
}
const TERMINAL_TASK_STATUSES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

interface FollowupEntry {
  readonly key: string;
  readonly followup: number;
}
const FollowupEntriesJson = Schema.fromJsonString(
  Schema.Array(Schema.Struct({ key: Schema.String, followup: Schema.Number })),
);
const decodeFollowupEntriesJson = Schema.decodeOption(FollowupEntriesJson);
const decodeFollowupEntries = (json: string): ReadonlyArray<FollowupEntry> =>
  Option.getOrElse(decodeFollowupEntriesJson(json), () => []);
const encodeFollowupEntries = Schema.encodeSync(FollowupEntriesJson);

/** Rebuilt from the members' stored envelopes, so an outbox row holds no text of its own. */
const followupNoteBody = (
  swarmId: SwarmId,
  members: ReadonlyArray<SwarmStore.SwarmMemberRecord>,
  entries: ReadonlyArray<FollowupEntry>,
): string =>
  [
    `Follow-up results from swarm ${swarmId}:`,
    ...entries.flatMap((entry) => {
      const member = members.find((row) => row.memberKey === entry.key);
      return member?.envelopeJson == null
        ? []
        : [swarmDigest({ key: entry.key, envelope: decodeEnvelope(member.envelopeJson) })];
    }),
  ].join("\n\n");

/** The same for member fields, checked after a `map` expands. */
const unsupportedMemberFields = (members: ReadonlyArray<SwarmMemberInput>): string | undefined => {
  for (const member of members) {
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
  // Envelope artifacts read the member's worktree; without git they stay empty.
  const gitDriver = yield* Effect.serviceOption(GitVcsDriver.GitVcsDriver);
  const verifier = yield* SwarmVerifier.SwarmVerifier;
  // Running verify commands by member (SW-A6); removing one kills its process tree.
  const verifyFibers = yield* FiberMap.make<string>();
  const verifyMembers = new Map<
    string,
    { readonly swarmId: SwarmId; readonly memberKey: string }
  >();
  // Finished checks waiting for the next pass, which applies them under the pass lock.
  const verifyOutcomes = new Map<string, VerifyResult>();
  // Shared-checkout members verify one at a time per checkout.
  const checkoutLocks = new Map<string, Semaphore.Semaphore>();
  // Admission passes run one at a time, so a create and a tick never admit the same row twice.
  const passLock = yield* Semaphore.make(1);
  // Architect notes (SW-A5): routine notes at most once per swarm every 30 s; notes already
  // sent this process are skipped (a replay after a restart hits the command receipt instead).
  const lastNoteAt = new Map<string, number>();
  const sentNotes = new Set<string>();
  const stalledSince = new Map<string, number>();
  const releaseAttempts = new Map<string, number>();
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

  const childRecords = (threadId: ThreadId) =>
    threads
      .getThreadRecords(threadId, ["runs", "messages", "turnItems"], {
        turnItemTypes: ["assistant_message"],
        messageRoles: ["assistant"],
      })
      .pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read a member thread.")),
      );

  /** Git facts of a worktree member's checkout; empty when there is no checkout or no git. */
  const worktreeArtifacts = Effect.fn("SwarmService.worktreeArtifacts")(function* (
    cwd: string,
    baseCommit: string | null,
  ) {
    if (Option.isNone(gitDriver)) return undefined;
    const git = (args: ReadonlyArray<string>) =>
      gitDriver.value
        .execute({ operation: "SwarmService.envelope", cwd, args, timeoutMs: 15_000 })
        .pipe(
          Effect.map((result) => result.stdout),
          Effect.orElseSucceed(() => ""),
        );
    const lines = (text: string) => text.split("\n").filter((line) => line.trim().length > 0);
    const branch = (yield* git(["rev-parse", "--abbrev-ref", "HEAD"])).trim();
    const commit = (yield* git(["rev-parse", "HEAD"])).trim();
    const committed =
      baseCommit === null ? [] : lines(yield* git(["diff", "--name-only", `${baseCommit}..HEAD`]));
    const uncommitted = lines(yield* git(["status", "--porcelain"])).map((line) => line.slice(3));
    return {
      branch,
      commit,
      paths: [...committed, ...uncommitted],
      uncommittedCount: uncommitted.length,
    };
  });

  /** The member's envelope from its bound run's final text (SW-A5). Stored, never logged. */
  const buildEnvelope = Effect.fn("SwarmService.buildEnvelope")(function* (input: {
    readonly swarm: SwarmStore.SwarmRecord;
    readonly member: SwarmStore.SwarmMemberRecord;
    readonly child: Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">;
    readonly run: OrchestrationV2Run;
    readonly status: FinalMemberStatus | "running";
    readonly testPathGlobs: ReadonlyArray<string>;
    readonly verify?: SwarmEnvelope["verify"];
    readonly verifySkipped?: SwarmEnvelope["verifySkipped"];
    readonly failure?: SwarmEnvelope["failure"];
  }) {
    const { swarm, member, child, run, status } = input;
    const spec = parseSpec(member.specJson);
    const parsed = parseSwarmResult(subagentResultForRun(child, run).text);
    const worktree =
      spec.isolation === "worktree" && child.thread.worktreePath !== null
        ? yield* worktreeArtifacts(child.thread.worktreePath, swarm.baseCommit)
        : undefined;
    const paths = capChangedPaths(worktree?.paths ?? []);
    const prUrl = child.thread.pullRequests?.[0]?.url;
    const envelope: SwarmEnvelope = {
      status,
      attempt: member.attempt,
      followup: member.followups,
      structured: parsed.structured,
      summary: parsed.summary,
      decisions: parsed.decisions,
      assumptions: parsed.assumptions,
      ...(parsed.data === undefined ? {} : { data: parsed.data }),
      dataDropped: parsed.dataDropped,
      artifacts: {
        ...(worktree?.branch ? { branch: worktree.branch } : {}),
        ...(worktree?.commit ? { commit: worktree.commit } : {}),
        ...paths,
        changedPathsTracked: worktree !== undefined,
        uncommittedCount: worktree?.uncommittedCount ?? 0,
        ...(prUrl === undefined ? {} : { prUrl }),
      },
      testFilesChanged: paths.changedPaths.some((path) =>
        matchesAnyGlob(path, input.testPathGlobs),
      ),
      ...(input.verify === undefined ? {} : { verify: input.verify }),
      ...(input.verifySkipped === undefined ? {} : { verifySkipped: input.verifySkipped }),
      ...(input.failure !== undefined
        ? { failure: input.failure }
        : status === "failed"
          ? { failure: { class: "unknown" as const, message: "The member's run failed." } }
          : {}),
    };
    return envelope;
  });

  /** Only `auto` and `full-access` run commands without approval, so only they allow verify. */
  /**
   * A server-run verify bypasses provider sandboxes and approval review, so only `full-access`
   * allows it (decision 2026-11-04): `auto` still sandboxes or reviews commands in each driver.
   */
  const verifyPermitted = (mode: RuntimeMode) => mode === "full-access";

  /** Why the architect's or the member's current modes forbid a check now, if they do. */
  const verifyModeBlock = (
    architect: Pick<OrchestrationV2ThreadProjection, "thread">,
    child: Pick<OrchestrationV2ThreadProjection, "thread">,
  ): "runtime_mode" | "plan_mode" | undefined =>
    child.thread.interactionMode === "plan"
      ? "plan_mode"
      : !verifyPermitted(architect.thread.runtimeMode) || !verifyPermitted(child.thread.runtimeMode)
        ? "runtime_mode"
        : undefined;

  const verifyRetryId = (member: SwarmStore.SwarmMemberRecord, retry: number) =>
    `swarm-verify:${member.swarmId}:${member.memberKey}:${retry}`;

  /**
   * The run the member's current attempt is bound to (rev 2.1): the admission run, then the run
   * each verify retry message started, followed through usage-limit continuations. Any other
   * run on the member thread is the user's or a restart's and never ends the attempt.
   */
  const boundRunOf = (
    member: SwarmStore.SwarmMemberRecord,
    runs: ReadonlyArray<OrchestrationV2Run>,
  ): OrchestrationV2Run | undefined => {
    let boundId =
      member.boundRunId ??
      (member.verifyAttempts === 0
        ? member.childRunId
        : (runs.find(
            (run) =>
              run.userMessageId === `message:${verifyRetryId(member, member.verifyAttempts)}`,
          )?.id ?? null));
    if (boundId === null) return undefined;
    for (;;) {
      const continuation = runs.find((run) =>
        run.userMessageId.startsWith(`limit-resume:${run.threadId}:${boundId}:`),
      );
      if (continuation === undefined) break;
      boundId = continuation.id;
    }
    return runs.find((run) => run.id === boundId);
  };

  /** The message that sends a failed verify back to the member, rebuilt from its envelope. */
  const verifyRetryText = (spec: SwarmMemberSpec, verify: NonNullable<SwarmEnvelope["verify"]>) => {
    const output = verify.outputTail.slice(-VERIFY_RETRY_OUTPUT_CHARACTERS);
    return [
      `The swarm's verify command failed (check ${verify.attempts} of ${(spec.verifyMaxRetries ?? VERIFY_DEFAULT_MAX_RETRIES) + 1}).`,
      `Command: ${encodeSpecJson(spec.verifyArgv ?? [])}`,
      verify.timedOut ? "It timed out." : `Exit code: ${verify.exitCode ?? "none"}`,
      "Last output:",
      "```",
      output,
      "```",
      "Fix the problem, then end your turn with the t3-swarm-result block again.",
    ].join("\n");
  };

  /**
   * Sends a verify retry to the member's thread. Idempotent by command id; never sent once the
   * swarm row is cancelled or detached (checked here, right before the dispatch).
   */
  const sendVerifyRetry = Effect.fn("SwarmService.sendVerifyRetry")(function* (
    member: SwarmStore.SwarmMemberRecord,
  ) {
    if (member.childThreadId === null || member.envelopeJson === null) return;
    const swarm = yield* store.getSwarm(member.swarmId);
    if (Option.isNone(swarm) || swarm.value.status !== "active") return;
    const verify = decodeEnvelope(member.envelopeJson).verify;
    if (verify === undefined) return;
    const id = verifyRetryId(member, member.verifyAttempts);
    const sent = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: member.childThreadId,
        messageId: MessageId.make(`message:${id}`),
        text: verifyRetryText(parseSpec(member.specJson), verify),
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (Result.isFailure(sent)) {
      yield* Effect.logWarning("swarm.verify-retry-failed", {
        swarmId: member.swarmId,
        memberKey: member.memberKey,
        retry: member.verifyAttempts,
        errorTag: storageOrDispatchTag(sent.failure),
      });
      return;
    }
    yield* Effect.logInfo("swarm.verify-retry", {
      swarmId: member.swarmId,
      memberKey: member.memberKey,
      retry: member.verifyAttempts,
    });
  });

  const lockFor = Effect.fn("SwarmService.checkoutLock")(function* (cwd: string) {
    const known = checkoutLocks.get(cwd);
    if (known !== undefined) return known;
    const lock = yield* Semaphore.make(1);
    checkoutLocks.set(cwd, lock);
    return lock;
  });

  /** Stops a member's verify command, if one runs; its result is discarded. */
  const abortVerify = (member: SwarmStore.SwarmMemberRecord) => {
    const ref = memberRef(member);
    verifyMembers.delete(ref);
    verifyOutcomes.delete(ref);
    return FiberMap.remove(verifyFibers, ref);
  };

  /** Verify commands whose member moved on (cancelled, detached, or gone) are killed. */
  const dropStaleVerifies = Effect.gen(function* () {
    for (const [ref, ids] of verifyMembers) {
      const row = (yield* store.listMembers(ids.swarmId)).find(
        (member) => member.memberKey === ids.memberKey,
      );
      if (row === undefined || row.status !== "verifying") {
        verifyMembers.delete(ref);
        yield* FiberMap.remove(verifyFibers, ref);
      }
    }
  });

  /** Ends a verifying member without a check: its modes or checkout no longer allow one. */
  const skipVerify = Effect.fn("SwarmService.skipVerify")(function* (input: {
    readonly swarm: SwarmStore.SwarmRecord;
    readonly member: SwarmStore.SwarmMemberRecord;
    readonly child: Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">;
    readonly run: OrchestrationV2Run;
    readonly reason: NonNullable<SwarmEnvelope["verifySkipped"]>;
    readonly settings: ServerSettingsValue;
  }) {
    const updatedAt = yield* nowIso;
    const envelope = yield* buildEnvelope({
      swarm: input.swarm,
      member: input.member,
      child: input.child,
      run: input.run,
      status: "claimed_done",
      testPathGlobs: input.settings.swarmTestPathGlobs,
      verifySkipped: input.reason,
    });
    yield* store.updateMember({
      swarmId: input.swarm.swarmId,
      memberKey: input.member.memberKey,
      patch: {
        status: "claimed_done",
        envelopeJson: encodeSpecJson(envelope),
        endedAt: updatedAt,
        updatedAt,
      },
    });
    yield* Effect.logInfo("swarm.verify-skipped", {
      swarmId: input.swarm.swarmId,
      memberKey: input.member.memberKey,
      reason: input.reason,
    });
  });

  /**
   * Applies a finished verify command (SW-A6), under the pass lock. A result whose member moved
   * on, or whose thread started another run meanwhile, is discarded.
   */
  const applyVerifyOutcome = Effect.fn("SwarmService.applyVerifyOutcome")(function* (
    input: VerifyResult,
  ) {
    const settings = yield* readSettings;
    if (!settings.swarmV2Enabled) return;
    const swarm = yield* store.getSwarm(input.swarmId);
    if (Option.isNone(swarm)) return;
    const member = (yield* store.listMembers(input.swarmId)).find(
      (row) => row.memberKey === input.memberKey,
    );
    if (
      member === undefined ||
      member.status !== "verifying" ||
      member.childThreadId === null ||
      member.verifyAttempts !== input.verifyAttempts
    ) {
      return;
    }
    const child = yield* childRecords(member.childThreadId);
    const run = boundRunOf(member, child.runs);
    if (run === undefined || run.id !== input.boundRunId) return;
    const updatedAt = yield* nowIso;
    if (child.runs.some(ThreadManagementService.isActiveRun)) {
      // Verify races (rev 2.1): a run started meanwhile; the member goes back to running.
      yield* store.updateMember({
        swarmId: input.swarmId,
        memberKey: input.memberKey,
        patch: { status: "running", updatedAt },
      });
      return;
    }
    if ("skipped" in input.outcome) {
      return yield* skipVerify({
        swarm: swarm.value,
        member,
        child,
        run,
        reason: input.outcome.skipped,
        settings,
      });
    }
    const spec = parseSpec(member.specJson);
    const verify = {
      passed: input.outcome.passed,
      exitCode: input.outcome.exitCode,
      timedOut: input.outcome.timedOut,
      attempts: member.verifyAttempts + 1,
      outputTail: input.outcome.outputTail,
      ...(input.outcome.notStarted ? { notStarted: true } : {}),
    };
    const maxRetries = spec.verifyMaxRetries ?? VERIFY_DEFAULT_MAX_RETRIES;
    // A command that cannot start fails the same way every time: final, with no retry.
    const retry = !verify.passed && !input.outcome.notStarted && member.verifyAttempts < maxRetries;
    // A retry is not sent once the swarm row is cancelled or detached; the check fails instead.
    const retrying = retry && swarm.value.status === "active";
    const status = verify.passed ? "verified" : retrying ? "running" : "failed";
    const envelope = yield* buildEnvelope({
      swarm: swarm.value,
      member,
      child,
      run,
      status,
      testPathGlobs: settings.swarmTestPathGlobs,
      verify,
      ...(status === "failed"
        ? {
            failure: {
              class: "verify" as const,
              message: input.outcome.notStarted
                ? VERIFY_NOT_STARTED_MESSAGE
                : `The verify command failed after ${verify.attempts} ${verify.attempts === 1 ? "check" : "checks"}.`,
            },
          }
        : {}),
    });
    yield* Effect.logInfo("swarm.verify", {
      swarmId: input.swarmId,
      memberKey: input.memberKey,
      check: verify.attempts,
      passed: verify.passed,
      timedOut: verify.timedOut,
      exitCode: verify.exitCode,
      next: status,
    });
    if (retrying) {
      // Stored before the dispatch, so a crash re-sends the same message (same command id).
      yield* store.updateMember({
        swarmId: input.swarmId,
        memberKey: input.memberKey,
        patch: {
          status: "running",
          verifyAttempts: member.verifyAttempts + 1,
          boundRunId: null,
          envelopeJson: encodeSpecJson(envelope),
          updatedAt,
        },
      });
      const updated = (yield* store.listMembers(input.swarmId)).find(
        (row) => row.memberKey === input.memberKey,
      );
      if (updated !== undefined) yield* sendVerifyRetry(updated);
      return;
    }
    yield* store.updateMember({
      swarmId: input.swarmId,
      memberKey: input.memberKey,
      patch: {
        status,
        envelopeJson: encodeSpecJson(envelope),
        ...(status === "failed"
          ? {
              failureClass: "verify",
              lastFailureClass: "verify",
              lastFailedAt: updatedAt,
              lastFailedInstanceId: member.providerInstanceId,
            }
          : {}),
        endedAt: updatedAt,
        updatedAt,
      },
    });
  });

  /** Starts the member's verify command unless one already runs for it. */
  const ensureVerify = Effect.fn("SwarmService.ensureVerify")(function* (input: {
    readonly swarm: SwarmStore.SwarmRecord;
    readonly member: SwarmStore.SwarmMemberRecord;
    readonly child: Pick<OrchestrationV2ThreadProjection, "thread" | "messages" | "turnItems">;
    readonly run: OrchestrationV2Run;
    readonly settings: ServerSettingsValue;
  }) {
    const { member } = input;
    const ref = memberRef(member);
    if (verifyOutcomes.has(ref) || (yield* FiberMap.has(verifyFibers, ref))) return;
    const cwd = yield* verifier.checkoutOf(input.child.thread).pipe(Effect.option);
    if (Option.isNone(cwd)) {
      return yield* skipVerify({ ...input, reason: "no_checkout" });
    }
    const spec = parseSpec(member.specJson);
    const lock = yield* lockFor(cwd.value);
    const ids = {
      swarmId: member.swarmId,
      memberKey: member.memberKey,
      boundRunId: input.run.id,
      verifyAttempts: member.verifyAttempts,
    };
    verifyMembers.set(ref, { swarmId: member.swarmId, memberKey: member.memberKey });
    yield* Effect.logInfo("swarm.verify-started", {
      swarmId: member.swarmId,
      memberKey: member.memberKey,
      check: member.verifyAttempts + 1,
    });
    const childThreadId = member.childThreadId!;
    // The outcome is recorded before the checkout is free for the next check; the next pass
    // applies it. Modes are checked again inside the lock, right before the spawn: a member may
    // have waited for the checkout, or be re-run after a restart.
    yield* FiberMap.run(
      verifyFibers,
      ref,
      lock
        .withPermits(1)(
          Effect.gen(function* () {
            const architect = yield* loadRuns(input.swarm.parentThreadId).pipe(Effect.option);
            const child = yield* loadRuns(childThreadId).pipe(Effect.option);
            // Unreadable now: no outcome, so the next pass starts the check again.
            if (Option.isNone(architect) || Option.isNone(child)) return;
            const blocked = verifyModeBlock(architect.value, child.value);
            if (blocked !== undefined) {
              verifyOutcomes.set(ref, { ...ids, outcome: { skipped: blocked } });
              return;
            }
            const outcome = yield* verifier.run({
              argv: spec.verifyArgv ?? [],
              cwd: cwd.value,
              timeoutMs: spec.verifyTimeoutMs ?? VERIFY_DEFAULT_TIMEOUT_MS,
            });
            verifyOutcomes.set(ref, { ...ids, outcome });
          }),
        )
        .pipe(Effect.ensuring(Effect.sync(() => verifyMembers.delete(ref))), Effect.andThen(wake)),
      { onlyIfMissing: true },
    );
  });

  /**
   * The member terminal path (SW-A5 envelopes, SW-A6 verify; SW-A8 real failure classes): when
   * the bound run ends, the member becomes final with its envelope, or verifies first.
   */
  const reconcileMember = Effect.fn("SwarmService.reconcileMember")(function* (
    swarm: SwarmStore.SwarmRecord,
    member: SwarmStore.SwarmMemberRecord,
    settings: ServerSettingsValue,
  ) {
    if (member.childThreadId === null) return;
    const child = yield* childRecords(member.childThreadId);
    const updatedAt = yield* nowIso;
    // Before release every run on the member thread counts toward its turns (rev 2.1).
    if (!member.released && child.runs.length !== member.turnsUsed) {
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { turnsUsed: child.runs.length, updatedAt },
      });
    }
    const run = boundRunOf(member, child.runs);
    if (run === undefined) {
      // A verify retry whose message has not started a run yet: send it (again; idempotent).
      if (member.verifyAttempts > 0 && member.boundRunId === null && member.status === "running") {
        yield* sendVerifyRetry(member);
      }
      return;
    }
    if (run.id !== member.boundRunId) {
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { boundRunId: run.id, updatedAt },
      });
    }
    // A detached member runs unmanaged; it only gets its envelope, for swarm_collect.
    if (member.status === "detached") {
      const status: FinalMemberStatus | undefined =
        run.status === "completed"
          ? "claimed_done"
          : run.status === "failed"
            ? "failed"
            : run.status === "cancelled" || run.status === "interrupted"
              ? "cancelled"
              : undefined;
      if (status === undefined) return;
      const envelope = yield* buildEnvelope({
        swarm,
        member,
        child,
        run,
        status,
        testPathGlobs: settings.swarmTestPathGlobs,
      });
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { envelopeJson: encodeSpecJson(envelope), endedAt: updatedAt, updatedAt },
      });
      return;
    }
    const threadBusy = child.runs.some(ThreadManagementService.isActiveRun);
    if (member.status === "verifying") {
      if (threadBusy) {
        // Verify races (rev 2.1): never verify while a run is active on the member thread.
        yield* abortVerify(member);
        yield* store.updateMember({
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          patch: { status: "running", updatedAt },
        });
        yield* Effect.logInfo("swarm.verify-aborted", {
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
        });
        return;
      }
      return yield* ensureVerify({ swarm, member, child, run, settings });
    }
    if (ThreadManagementService.isActiveRun(run)) {
      if (run.status === "running" && member.status === "launching") {
        yield* store.updateMember({
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          patch: { status: "running", startedAt: updatedAt, updatedAt },
        });
      }
      return;
    }
    const spec = parseSpec(member.specJson);
    if (run.status === "completed" && spec.verifyArgv !== undefined) {
      // The member's run is done; verify waits for any other run on its thread to end.
      if (threadBusy) return;
      // Modes can change after create, so they are checked here and again right before the
      // command starts.
      const blocked = verifyModeBlock(yield* loadRuns(swarm.parentThreadId), child);
      if (blocked !== undefined) {
        return yield* skipVerify({ swarm, member, child, run, reason: blocked, settings });
      }
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { status: "verifying", updatedAt },
      });
      return yield* ensureVerify({
        swarm,
        member: { ...member, status: "verifying", boundRunId: run.id },
        child,
        run,
        settings,
      });
    }
    const ended: FinalMemberStatus | undefined =
      run.status === "completed"
        ? "claimed_done"
        : run.status === "failed"
          ? "failed"
          : run.status === "cancelled" || run.status === "interrupted"
            ? "cancelled"
            : undefined;
    if (ended === undefined) return;
    const envelope = yield* buildEnvelope({
      swarm,
      member,
      child,
      run,
      status: ended,
      testPathGlobs: settings.swarmTestPathGlobs,
    });
    yield* store.updateMember({
      swarmId: swarm.swarmId,
      memberKey: member.memberKey,
      patch: {
        status: ended,
        envelopeJson: encodeSpecJson(envelope),
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
   * Releases ready members to the architect (SW-A5): the gate is evaluated once per pass, then
   * the longest ordinal prefix whose rendered wake entries fit DELEGATED_RESULT_INLINE_BYTES
   * with what the delivery already holds; when not even one fits, one member goes alone.
   */
  const releasePass = Effect.fn("SwarmService.releasePass")(function* (
    swarm: SwarmStore.SwarmRecord,
    members: ReadonlyArray<SwarmStore.SwarmMemberRecord>,
  ) {
    const now = yield* nowIso;
    // A row that never launched has no task to wake with; it counts as released once final.
    for (const member of members) {
      if (member.taskId === null && !member.released && isFinalMemberStatus(member.status)) {
        yield* store.updateMember({
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          patch: { released: true, updatedAt: now },
        });
      }
    }
    const ready = readyForRelease({
      wakePolicy: swarm.wakePolicy,
      wakeBatch: decodeWakeBatch(swarm.wakeBatchJson),
      members,
      nowMillis: Date.parse(now),
    });
    if (ready.length === 0) return;
    const parent = yield* threads
      .getThreadRecords(swarm.parentThreadId, ["runs", "subagents", "messages"], {
        messageRoles: ["user"],
      })
      .pipe(Effect.mapError(() => failure("orchestration_error", "Unable to read the architect.")));
    const anchor = parent.runs.find((run) => run.id === swarm.anchorRunId);
    const cohort = anchor?.delegatedCompletion;
    if (cohort?.disposition !== "open") return;
    const delivery = cohort.delivery;
    const deliveryRun =
      delivery === null
        ? undefined
        : parent.runs.find(
            (run) =>
              run.id ===
              parent.messages.find((message) => message.id === delivery.messageId)?.runId,
          );
    const releasedTaskIds = new Set(
      members.flatMap((member) =>
        member.released && member.taskId !== null ? [member.taskId] : [],
      ),
    );
    // The gate (rev 3.2): closed while a delivery with no run yet, or a queued one, already
    // holds a released swarm task.
    if (
      delivery !== null &&
      (deliveryRun === undefined || deliveryRun.status === "queued") &&
      delivery.taskIds.some((taskId) => releasedTaskIds.has(taskId))
    ) {
      // A delivery that never got a run (no provider thread to wake) stalls; say so once.
      if (deliveryRun === undefined) {
        const since = stalledSince.get(delivery.messageId) ?? Date.parse(now);
        stalledSince.set(delivery.messageId, since);
        if (Date.parse(now) - since >= DELIVERY_STALL_MS) {
          yield* notifyArchitect(swarm, {
            kind: "delivery_stalled",
            key: String(delivery.messageId),
            summary: "Swarm results are waiting to be delivered",
            text: `Swarm ${swarm.swarmId}: a completion wake has had no run for 10 minutes. Released member results are in swarm_collect.`,
            routine: false,
          });
        }
      }
      return;
    }
    const tasks = new Map(parent.subagents.map((task) => [String(task.id), task]));
    // What the next wake already carries: the delivery's tasks while its run is missing or
    // queued (a release joins them); once that run runs, the pending tasks the collector will
    // gather into the following wake.
    const committedTaskIds =
      deliveryRun === undefined || deliveryRun.status === "queued"
        ? (delivery?.taskIds ?? [])
        : parent.subagents
            .filter(
              (task) =>
                task.runId === swarm.anchorRunId && task.completionDelivery?.state === "pending",
            )
            .map((task) => task.id);
    const committed = committedTaskIds.reduce((bytes, taskId) => {
      const task = tasks.get(String(taskId));
      return task === undefined ? bytes : bytes + delegatedCompletionWakeEntryBytes(taskId, task);
    }, 0);
    let used = committed;
    const releases: Array<{
      readonly member: SwarmStore.SwarmMemberRecord;
      readonly digest: string;
    }> = [];
    for (const member of ready) {
      const task = tasks.get(String(member.taskId));
      if (task === undefined) continue;
      const digest = swarmDigest({
        key: member.memberKey,
        envelope: decodeEnvelope(member.envelopeJson!),
      });
      const bytes = delegatedCompletionWakeEntryBytes(member.taskId!, {
        ...task,
        completionDetail: digest,
      });
      if (used + bytes > DELEGATED_RESULT_INLINE_BYTES && releases.length > 0) break;
      releases.push({ member, digest });
      used += bytes;
      // Progress: one member that does not fit still goes, alone (it may arrive as a pointer).
      if (used > DELEGATED_RESULT_INLINE_BYTES) break;
    }
    for (const { member, digest } of releases) {
      const released = yield* threads
        .dispatch({
          type: "delegated_task.wake-policy",
          commandId: CommandId.make(
            `swarm-release:${swarm.swarmId}:${member.memberKey}:${member.attempt}`,
          ),
          parentThreadId: swarm.parentThreadId,
          taskId: member.taskId!,
          completionWake: "always",
          completionDetail: digest,
          swarmRelease: true,
        })
        .pipe(Effect.result);
      if (Result.isFailure(released)) {
        const errorTag = storageOrDispatchTag(released.failure);
        // A refusal is final (the task is no longer held, or this id was rejected before and
        // replays as rejected); other errors retry, a few times.
        const refused =
          errorTag === "OrchestratorDispatchError" ||
          errorTag === "OrchestratorCommandPreviouslyRejectedError";
        const ref = memberRef(member);
        const attempts = (releaseAttempts.get(ref) ?? 0) + 1;
        releaseAttempts.set(ref, attempts);
        const gaveUp = refused || attempts >= MAX_RELEASE_ATTEMPTS;
        yield* Effect.logWarning("swarm.release-failed", {
          swarmId: swarm.swarmId,
          memberKey: member.memberKey,
          errorTag,
          outcome: refused ? "refused" : gaveUp ? "retries_exhausted" : "will_retry",
        });
        if (!gaveUp) continue;
        releaseAttempts.delete(ref);
      }
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { released: true, updatedAt: yield* nowIso },
      });
    }
    yield* Effect.logInfo("swarm.released", {
      swarmId: swarm.swarmId,
      members: releases.length,
      ready: ready.length,
    });
  });

  /**
   * The architect's Stop cancels a swarm (D12): rows that never launched become `cancelled`.
   * Cancelling the queued wake disposes the cohort and detaches it: launched members keep
   * running unmanaged. Archive or delete cancels (§4.6).
   */
  /**
   * A server-created message to the architect (§SW-A5): not a member completion, so it does not
   * go through the cohort. Command ids derive from state, so a crash before the state change
   * replays the same note instead of sending a second one. Never carries task text.
   */
  const notifyArchitect = Effect.fn("SwarmService.notifyArchitect")(function* (
    swarm: SwarmStore.SwarmRecord,
    note: {
      readonly kind: SwarmNoteKind;
      readonly key: string;
      readonly summary: string;
      readonly text: string;
      readonly outcome?: "updated" | "cancelled";
      /** Routine notes wait out the 30 s window; closing notes never do. */
      readonly routine: boolean;
    },
  ) {
    const id = `swarm-note:${swarm.swarmId}:${note.kind}:${note.key}`;
    if (sentNotes.has(id)) return true;
    const nowMillis = DateTime.toEpochMillis(yield* DateTime.now);
    if (note.routine && nowMillis - (lastNoteAt.get(swarm.swarmId) ?? -Infinity) < NOTE_WINDOW_MS) {
      return false;
    }
    const sent = yield* threads
      .dispatch({
        type: "message.dispatch",
        commandId: CommandId.make(id),
        threadId: swarm.parentThreadId,
        messageId: MessageId.make(`message:${id}`),
        text: note.text,
        notification: {
          source: { kind: "system" },
          outcome: note.outcome ?? "updated",
          summary: note.summary,
        },
        attachments: [],
        dispatchMode: { type: "queue_after_active" },
        createdBy: "agent",
        creationSource: "server",
      })
      .pipe(Effect.result);
    if (Result.isFailure(sent)) {
      yield* Effect.logWarning("swarm.note-failed", {
        swarmId: swarm.swarmId,
        kind: note.kind,
        errorTag: storageOrDispatchTag(sent.failure),
      });
      return false;
    }
    sentNotes.add(id);
    lastNoteAt.set(swarm.swarmId, nowMillis);
    yield* Effect.logInfo("swarm.note", { swarmId: swarm.swarmId, kind: note.kind });
    return true;
  });

  /** Pauses, approvals waiting (D6), and an exhausted budget, for an open swarm. */
  const routineNotes = Effect.fn("SwarmService.routineNotes")(function* (
    swarm: SwarmStore.SwarmRecord,
    members: ReadonlyArray<SwarmStore.SwarmMemberRecord>,
  ) {
    const now = yield* nowIso;
    if (swarm.budgetExhausted) {
      yield* notifyArchitect(swarm, {
        kind: "budget",
        key: "1",
        summary: "Swarm stopped admitting members",
        text: `Swarm ${swarm.swarmId} used its turn budget: no new members start and no member is retried. Running members finish; read results with swarm_collect.`,
        routine: true,
      });
    }
    const queuedInstances = new Set(
      members.flatMap((member) => {
        if (member.status !== "queued") return [];
        const spec = parseSpec(member.specJson);
        return spec.anyOf === undefined
          ? [String(spec.modelSelection.instanceId)]
          : spec.anyOf.map((option) => String(option.modelSelection.instanceId));
      }),
    );
    for (const pause of yield* store.listInstancePauses) {
      if (pause.until <= now || !queuedInstances.has(pause.providerInstanceId)) continue;
      yield* notifyArchitect(swarm, {
        kind: "instance_paused",
        key: `${pause.providerInstanceId}:${pause.until}`,
        summary: "Swarm admissions paused on a provider instance",
        text: `Swarm ${swarm.swarmId}: admissions on provider instance ${pause.providerInstanceId} are paused until ${pause.until} (${pause.pauseClass}). Queued members there wait; members on other instances continue.`,
        routine: true,
      });
    }
    // D6: approvals go to the user; the architect only hears how many are waiting.
    const waiting: Array<string> = [];
    for (const member of members) {
      if (member.childThreadId === null || isFinalMemberStatus(member.status)) continue;
      const child = yield* threads
        .getThreadRecords(member.childThreadId, ["runtimeRequests"])
        .pipe(Effect.option);
      if (Option.isNone(child)) continue;
      const pending = child.value.runtimeRequests.find(
        (request) => request.status === "pending" && request.kind !== "user_input",
      );
      if (pending !== undefined) waiting.push(String(pending.id));
    }
    if (waiting.length > 0) {
      yield* notifyArchitect(swarm, {
        kind: "approvals",
        key: waiting.toSorted().join(","),
        summary: "Swarm members are waiting on approval",
        text: `Swarm ${swarm.swarmId}: ${waiting.length} member${waiting.length === 1 ? " is" : "s are"} waiting on the user's approval in ${waiting.length === 1 ? "its thread" : "their threads"}. You cannot approve them; the user does.`,
        routine: true,
      });
    }
  });

  /**
   * Follow-up results for already released members (SW-A7) go through the outbox: a row per
   * note, coalesced over 5 s and bounded by the wake budget, re-sent unchanged after a restart.
   */
  const queueFollowupResult = Effect.fn("SwarmService.queueFollowupResult")(function* (input: {
    readonly swarmId: SwarmId;
    readonly memberKey: string;
    readonly followup: number;
  }) {
    const now = yield* nowIso;
    const members = yield* store.listMembers(input.swarmId);
    const digestBytes = (entries: ReadonlyArray<FollowupEntry>) =>
      utf8.encode(followupNoteBody(input.swarmId, members, entries)).length;
    const open = (yield* store.listUnsentNotes).findLast(
      (note) =>
        note.swarmId === input.swarmId &&
        Date.parse(now) - Date.parse(note.createdAt) < FOLLOWUP_COALESCE_MS,
    );
    const entry = { key: input.memberKey, followup: input.followup };
    if (open !== undefined) {
      const entries = [...decodeFollowupEntries(open.membersJson), entry];
      if (digestBytes(entries) <= DELEGATED_RESULT_INLINE_BYTES) {
        yield* store.updateNoteMembers({
          swarmId: input.swarmId,
          seq: open.seq,
          membersJson: encodeFollowupEntries(entries),
        });
        return;
      }
    }
    yield* store.enqueueNote({
      swarmId: input.swarmId,
      seq: yield* store.nextNoteSeq(input.swarmId),
      kind: "followup_result",
      membersJson: encodeFollowupEntries([entry]),
      createdAt: now,
    });
  });

  /** Sends outbox notes past their 5 s window; the same seq always rebuilds the same body. */
  const sendFollowupNotes = Effect.fn("SwarmService.sendFollowupNotes")(function* () {
    const now = Date.parse(yield* nowIso);
    for (const note of yield* store.listUnsentNotes) {
      if (now - Date.parse(note.createdAt) < FOLLOWUP_COALESCE_MS) continue;
      const swarm = yield* store.getSwarm(note.swarmId);
      if (Option.isNone(swarm)) continue;
      const entries = decodeFollowupEntries(note.membersJson);
      const members = yield* store.listMembers(note.swarmId);
      const id = `swarm-note:${note.swarmId}:followup_result:${note.seq}`;
      const sent = yield* threads
        .dispatch({
          type: "message.dispatch",
          commandId: CommandId.make(id),
          threadId: swarm.value.parentThreadId,
          messageId: MessageId.make(`message:${id}`),
          text: followupNoteBody(note.swarmId, members, entries),
          notification: {
            source: { kind: "system" },
            outcome: "completed",
            summary: "Swarm follow-up results",
          },
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.result);
      if (Result.isFailure(sent)) {
        yield* Effect.logWarning("swarm.note-failed", {
          swarmId: note.swarmId,
          kind: "followup_result",
          errorTag: storageOrDispatchTag(sent.failure),
        });
        continue;
      }
      yield* store.markNoteSent({
        swarmId: note.swarmId,
        seq: note.seq,
        memberKeys: entries.map((entry) => entry.key),
      });
      yield* Effect.logInfo("swarm.note", { swarmId: note.swarmId, kind: "followup_result" });
    }
  });

  /**
   * An earlier attempt's held task (SW-A7 retries) is disposed with settled_only, which never
   * plans a wake, but only once it is terminal: earlier, it could still plan when it ends.
   */
  const disposeSuperseded = Effect.fn("SwarmService.disposeSuperseded")(function* (
    swarm: SwarmStore.SwarmRecord,
    members: ReadonlyArray<SwarmStore.SwarmMemberRecord>,
  ) {
    const superseded = members.filter((member) => member.supersededTaskId !== null);
    if (superseded.length === 0) return;
    const parent = yield* threads
      .getThreadRecords(swarm.parentThreadId, ["subagents"])
      .pipe(Effect.mapError(() => failure("orchestration_error", "Unable to read the architect.")));
    for (const member of superseded) {
      const task = parent.subagents.find((row) => row.id === member.supersededTaskId);
      if (task !== undefined && !TERMINAL_TASK_STATUSES.has(task.status)) continue;
      if (task !== undefined && task.completionWake === "held") {
        yield* threads.dispatch({
          type: "delegated_task.wake-policy",
          commandId: CommandId.make(`swarm-dispose:${swarm.swarmId}:${task.id}`),
          parentThreadId: swarm.parentThreadId,
          taskId: task.id,
          completionWake: "settled_only",
          swarmRelease: true,
        });
      }
      yield* store.updateMember({
        swarmId: swarm.swarmId,
        memberKey: member.memberKey,
        patch: { supersededTaskId: null, updatedAt: yield* nowIso },
      });
    }
  });

  /**
   * §4.3: a swarm is completed when every row is final and released (a row that never
   * launched counts as released once final), no superseded task waits, and no follow-up note
   * is unsent. swarm_add_members and swarm_followup reopen it.
   */
  const completeIfDone = Effect.fn("SwarmService.completeIfDone")(function* (
    swarm: SwarmStore.SwarmRecord,
  ) {
    const members = yield* store.listMembers(swarm.swarmId);
    const done =
      members.length > 0 &&
      members.every(
        (member) =>
          isFinalMemberStatus(member.status) &&
          (member.released || member.status === "detached") &&
          member.supersededTaskId === null &&
          (member.followups === 0 || member.followupNotified),
      ) &&
      !(yield* store.listUnsentNotes).some((note) => note.swarmId === swarm.swarmId);
    if (!done) return;
    yield* store.updateSwarm(swarm.swarmId, { status: "completed", updatedAt: yield* nowIso });
    yield* Effect.logInfo("swarm.completed", { swarmId: swarm.swarmId, members: members.length });
  });

  const closeSwarm = Effect.fn("SwarmService.closeSwarm")(function* (
    swarm: SwarmStore.SwarmRecord,
    members: ReadonlyArray<SwarmStore.SwarmMemberRecord>,
    outcome: "stopped" | "detached" | "closed_thread",
  ) {
    const now = yield* nowIso;
    const queued = members.filter(
      (member) =>
        member.status === "queued" ||
        (member.status === "launching" && member.childThreadId === null),
    ).length;
    const running = members.filter(
      (member) => member.childThreadId !== null && !isFinalMemberStatus(member.status),
    ).length;
    const undelivered = members.filter(
      (member) => isFinalMemberStatus(member.status) && !member.released && member.taskId !== null,
    ).length;
    // Sent before the state changes: a crash in between replays this note, never loses it.
    if (outcome === "stopped") {
      yield* notifyArchitect(swarm, {
        kind: "cancelled",
        key: "1",
        summary: "Swarm cancelled by Stop",
        text: `Swarm ${swarm.swarmId} was cancelled by Stop: ${queued} queued member${queued === 1 ? "" : "s"} will not start, and running members were stopped. Results so far: swarm_collect.`,
        outcome: "cancelled",
        routine: false,
      });
    } else if (outcome === "detached") {
      yield* notifyArchitect(swarm, {
        kind: "detached",
        key: "1",
        summary: "Swarm detached",
        text: `Swarm ${swarm.swarmId} was detached because its wake was cancelled: ${queued} queued member${queued === 1 ? "" : "s"} will not start, ${running} running member${running === 1 ? "" : "s"} continue unmanaged, and ${undelivered} result${undelivered === 1 ? " was" : "s were"} not delivered. Read them with swarm_collect.`,
        outcome: "cancelled",
        routine: false,
      });
    }
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
        yield* sendFollowupNotes().pipe(logged("swarm.followup-note-error", {}));
        yield* dropStaleVerifies.pipe(logged("swarm.verify-sweep-error", {}));
        for (const [ref, result] of verifyOutcomes) {
          verifyOutcomes.delete(ref);
          yield* applyVerifyOutcome(result).pipe(
            logged("swarm.verify-apply-error", {
              swarmId: result.swarmId,
              memberKey: result.memberKey,
            }),
          );
        }
        // Cancelled and detached swarms are followed until their launched members end:
        // cancelled ones still hold slots and release while their anchor is open, detached
        // ones only collect envelopes.
        const swarms = yield* store.listSwarms({ statuses: ["active", "cancelled", "detached"] });
        const membersBySwarm = new Map<string, ReadonlyArray<SwarmStore.SwarmMemberRecord>>();
        const architects = new Map<
          string,
          Option.Option<Pick<OrchestrationV2ThreadProjection, "thread" | "runs">>
        >();
        const admits = new Map<string, boolean>();
        const watched = new Set<string>();
        for (const swarm of swarms) {
          let members = yield* store.listMembers(swarm.swarmId);
          const followed = (member: SwarmStore.SwarmMemberRecord) =>
            !isFinalMemberStatus(member.status) ||
            (member.status === "detached" && member.envelopeJson === null) ||
            (swarm.status === "cancelled" &&
              !member.released &&
              member.taskId !== null &&
              member.status !== "detached") ||
            member.supersededTaskId !== null;
          if (swarm.status !== "active" && !members.some(followed)) continue;
          // A launched member whose run ended is final before the swarm closes around it.
          for (const member of members) {
            if (
              member.childThreadId !== null &&
              (member.status === "launching" ||
                member.status === "running" ||
                member.status === "verifying" ||
                (member.status === "detached" && member.envelopeJson === null))
            ) {
              yield* reconcileMember(swarm, member, settings).pipe(
                logged("swarm.reconcile-error", {
                  swarmId: swarm.swarmId,
                  memberKey: member.memberKey,
                }),
              );
            }
          }
          members = yield* store.listMembers(swarm.swarmId);
          if (swarm.status === "detached") continue;
          const architect = yield* loadRuns(swarm.parentThreadId).pipe(Effect.option);
          architects.set(swarm.swarmId, architect);
          const state = anchorStateOf(swarm, architect);
          if (
            swarm.status === "active" &&
            (state === "stopped" || state === "detached" || state === "closed_thread")
          ) {
            yield* closeSwarm(swarm, members, state).pipe(
              logged("swarm.close-error", { swarmId: swarm.swarmId }),
            );
          } else if (swarm.status === "active" && state === "open") {
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
          // A swarm cancelled by swarm_cancel keeps releasing while its cohort is open; one
          // cancelled by Stop has a stopped cohort and releases nothing (D12).
          if (state === "open") {
            yield* releasePass(swarm, members).pipe(
              logged("swarm.release-error", { swarmId: swarm.swarmId }),
            );
            yield* disposeSuperseded(swarm, yield* store.listMembers(swarm.swarmId)).pipe(
              logged("swarm.dispose-error", { swarmId: swarm.swarmId }),
            );
            members = yield* store.listMembers(swarm.swarmId);
            if (swarm.status === "active") {
              yield* routineNotes(swarm, members).pipe(
                logged("swarm.note-error", { swarmId: swarm.swarmId }),
              );
              yield* completeIfDone(swarm).pipe(
                logged("swarm.complete-error", { swarmId: swarm.swarmId }),
              );
            }
          }
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
        const permits = (mode: string) => mode === "full-access";
        if (!permits(architect.thread.runtimeMode) || !permits(runtimeCeiling)) {
          return yield* failure(
            "invalid_request",
            `Member '${member.key}': verify requires full-access on the architect and the member.`,
          );
        }
      }
      specs.push({
        key: member.key,
        title: member.title,
        task: taskPrompt({
          task: member.task,
          ...(member.role === undefined ? {} : { role: member.role }),
        }),
        ...(member.role === undefined ? {} : { role: member.role }),
        ...(member.doneCriteria === undefined ? {} : { doneCriteria: member.doneCriteria }),
        ...(verify === undefined
          ? {}
          : {
              verifyArgv: verify.argv,
              ...(verify.timeoutMs === undefined ? {} : { verifyTimeoutMs: verify.timeoutMs }),
              ...(verify.maxRetries === undefined ? {} : { verifyMaxRetries: verify.maxRetries }),
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
    if (input.wakeBatch !== undefined && input.wakePolicy !== "batch") {
      return yield* failure("invalid_request", "`wakeBatch` needs wakePolicy: 'batch'.");
    }
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
      wakeBatchJson: input.wakeBatch === undefined ? null : encodeWakeBatch(input.wakeBatch),
      maxConcurrent: input.maxConcurrent ?? null,
      maxTotalTurns: null,
      verifyJson: null,
      sharedContext: input.sharedContext ?? null,
      dataShape: input.dataShape ?? null,
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
      const requestKey =
        input.clientRequestId === undefined
          ? undefined
          : `${scope.requestNamespace}:swarm_add_members:${input.clientRequestId}`;
      const settings = yield* readSettings;
      // Under the pass lock, so two concurrent calls cannot both pass the 48-member check.
      const added = yield* passLock.withPermits(1)(
        Effect.gen(function* () {
          const existing = yield* store.listMembers(swarm.swarmId);
          // A retried call returns what the first one added; its key is stored on those members.
          if (
            requestKey !== undefined &&
            existing.some((row) => parseSpec(row.specJson).addRequestKey === requestKey)
          ) {
            return { replayed: true as const, warnings: [] as ReadonlyArray<SwarmWarning> };
          }
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
              requestKey === undefined
                ? specs
                : specs.map((spec) => ({ ...spec, addRequestKey: requestKey })),
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
          return { replayed: false as const, warnings: [...warnings, ...extra] };
        }),
      );
      if (added.replayed) return yield* swarmResult(scope, swarm, []);
      // Added members always go through the swarm-admission path against the anchor.
      yield* admitNow(swarm.swarmId, settings);
      const updated = yield* store.getSwarm(swarm.swarmId);
      return yield* swarmResult(
        scope,
        Option.getOrElse(updated, () => swarm),
        added.warnings,
      );
    },
  );

  return SwarmService.of({ create, addMembers, queueFollowupResult, tick, wake, start });
});

export const layer = Layer.effect(SwarmService, make);
