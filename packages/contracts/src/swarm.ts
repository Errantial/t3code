import * as Schema from "effect/Schema";

import {
  IsoDateTime,
  NodeId,
  NonNegativeInt,
  SwarmId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderOptionSelection } from "./model.ts";
import {
  OrchestratorMcpClientRequestId,
  OrchestratorMcpInteractionMode,
  OrchestratorMcpRuntimeMode,
  OrchestratorMcpSwarmMemberInput,
  OrchestratorMcpTarget,
  OrchestratorMcpTaskRole,
  OrchestratorMcpTitle,
} from "./orchestratorMcp.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

// Swarm v2 (behind the `swarmV2Enabled` server setting). Bounds here count characters; the
// UTF-8 byte caps (sharedContext, summary, data, digest) are enforced where values are built.

const IntRange = (minimum: number, maximum: number) =>
  Schema.Int.check(Schema.isBetween({ minimum, maximum }));

const SWARM_MAX_MEMBERS_PER_CALL = 12;
const SWARM_MAX_MAP_ROWS = 48;
const SWARM_MAX_MEMBERS_TOTAL = 48;

export const SwarmMemberStatus = Schema.Literals([
  "queued", // a row only: waiting for a slot, or for the instance to resume (queueReason)
  "launching", // admission dispatched; the child exists, its first turn has not started
  "running",
  "limit_wait", // stopped on a usage limit; auto-resume owns it; global slot freed
  "claimed_done", // the child run finished; not verified
  "verifying",
  "verified",
  "failed",
  "cancelled",
  "detached", // the swarm was detached; the child keeps running unmanaged
]);
export type SwarmMemberStatus = typeof SwarmMemberStatus.Type;

export const SwarmFailureClass = Schema.Literals([
  // The first seven mirror OrchestrationV2ProviderFailureClass.
  "launch",
  "usage_limit",
  "provider_error",
  "transport_error",
  "permission_error",
  "validation_error",
  "unknown",
  "verify",
  "budget",
  "cancelled_by_architect_stop",
]);
export type SwarmFailureClass = typeof SwarmFailureClass.Type;

/** Why an instance's admissions are paused. Not a member failure class. */
export const SwarmPauseClass = Schema.Literals(["usage_limit", "instance_down"]);
export type SwarmPauseClass = typeof SwarmPauseClass.Type;

export const SwarmStatus = Schema.Literals(["active", "completed", "cancelled", "detached"]);
export type SwarmStatus = typeof SwarmStatus.Type;

/**
 * Why a member is queued. `queueReason` carries the kind, with `:<instanceId>` for
 * `instance_cap`, `:<instanceId>:<until>` for `instance_paused`, and `:<at>` for `retry_after`.
 */
export const SwarmQueueReasonKind = Schema.Literals([
  "global_cap",
  "swarm_cap", // the swarm's own maxConcurrent
  "instance_cap",
  "instance_paused",
  "any_of_unavailable",
  "retry_after",
  "budget",
  "next_architect_turn",
]);
export type SwarmQueueReasonKind = typeof SwarmQueueReasonKind.Type;

export const SwarmWakePolicy = Schema.Literals(["group", "failure", "batch"]);
export type SwarmWakePolicy = typeof SwarmWakePolicy.Type;

export const SwarmWakeBatch = Schema.Struct({
  minCount: Schema.optional(IntRange(2, 48)), // default 4
  maxWaitMs: Schema.optional(IntRange(30_000, 1_800_000)), // default 120_000
});
export type SwarmWakeBatch = typeof SwarmWakeBatch.Type;

export const SwarmVerify = Schema.Struct({
  // No shell. On Windows argv[0] must be an executable (use ["cmd", "/c", …] for .cmd scripts).
  argv: Schema.NonEmptyArray(TrimmedNonEmptyString),
  timeoutMs: Schema.optional(IntRange(1_000, 1_800_000)), // default 600_000
  maxRetries: Schema.optional(IntRange(0, 3)), // default 2
});
export type SwarmVerify = typeof SwarmVerify.Type;

/** `anyOf` lets the scheduler place a member on the least-busy listed instance. */
export const SwarmMemberTarget = Schema.Struct({
  ...OrchestratorMcpTarget.fields,
  anyOf: Schema.optional(
    Schema.Array(ProviderInstanceId).check(Schema.isMinLength(2), Schema.isMaxLength(8)).annotate({
      description:
        "2-8 instances of one driver; the member runs on the least busy. Needs `model`; no providerInstanceId.",
    }),
  ),
});
export type SwarmMemberTarget = typeof SwarmMemberTarget.Type;

const SwarmMemberKey = OrchestratorMcpSwarmMemberInput.fields.key;
const SwarmOwnsPaths = Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(50));

/** The fields a member and a map template share. */
const SwarmMemberSettings = {
  role: Schema.optional(OrchestratorMcpTaskRole),
  target: Schema.optional(SwarmMemberTarget),
  isolation: Schema.optional(
    Schema.Literals(["shared", "worktree"]).annotate({
      description: "'worktree': own checkout from your commit. Two shared writers are refused.",
    }),
  ),
  runtimeMode: Schema.optional(OrchestratorMcpRuntimeMode),
  interactionMode: Schema.optional(
    OrchestratorMcpInteractionMode.annotate({ description: "'plan' members do not edit." }),
  ),
  doneCriteria: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(2_000))),
  verify: Schema.optional(
    SwarmVerify.annotate({
      description: "Command run in the member's checkout after it ends; a failure retries it.",
    }),
  ),
  maxTurns: Schema.optional(IntRange(1, 50)),
  maxWallClockMs: Schema.optional(IntRange(60_000, 86_400_000)),
  allowNestedSwarm: Schema.optional(Schema.Boolean),
};

export const SwarmMemberInput = Schema.Struct({
  key: SwarmMemberKey,
  title: OrchestratorMcpSwarmMemberInput.fields.title,
  task: OrchestratorMcpSwarmMemberInput.fields.task,
  ...SwarmMemberSettings,
  ownsPaths: Schema.optional(
    SwarmOwnsPaths.annotate({ description: "Repo-relative paths this member may edit." }),
  ),
});
export type SwarmMemberInput = typeof SwarmMemberInput.Type;

/** `{{name}}` placeholders in a map template are filled from a row's vars; `{{key}}` is the key. */
const SwarmVarName = TrimmedNonEmptyString.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[A-Za-z0-9_]+$/),
);

export const SwarmMapRow = Schema.Struct({
  key: SwarmMemberKey,
  vars: Schema.optional(
    Schema.Record(SwarmVarName, Schema.String.check(Schema.isMaxLength(4_000))),
  ),
  ownsPaths: Schema.optional(SwarmOwnsPaths),
});
export type SwarmMapRow = typeof SwarmMapRow.Type;

export const SwarmMap = Schema.Struct({
  task: OrchestratorMcpSwarmMemberInput.fields.task.annotate({
    description: "Template; {{name}} is filled from each row's vars, {{key}} is the row key.",
  }),
  title: OrchestratorMcpTitle, // template
  ...SwarmMemberSettings,
  rows: Schema.Array(SwarmMapRow).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(SWARM_MAX_MAP_ROWS),
  ),
});
export type SwarmMap = typeof SwarmMap.Type;

const SwarmMembers = Schema.Array(SwarmMemberInput).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SWARM_MAX_MEMBERS_PER_CALL),
);

// Exactly one of `members` and `map`, and `wakeBatch` only with `wakePolicy: "batch"`, are
// checked by the handler, which names the field (invalid_request).
export const SwarmCreateInput = Schema.Struct({
  title: OrchestratorMcpTitle,
  members: Schema.optional(
    SwarmMembers.annotate({
      description: "Up to 12 members. Give exactly one of members and map.",
    }),
  ),
  map: Schema.optional(
    SwarmMap.annotate({ description: "One template, up to 48 rows; each row becomes a member." }),
  ),
  sharedContext: Schema.optional(
    Schema.String.check(Schema.isMaxLength(16_384)).annotate({
      description: "Context every member gets once, instead of repeating it in each task.",
    }),
  ),
  dataShape: Schema.optional(
    Schema.String.check(Schema.isMaxLength(2_000)).annotate({
      description: "Shape of the JSON `data` each member returns.",
    }),
  ),
  wakePolicy: Schema.optional(
    SwarmWakePolicy.annotate({
      description:
        "When results wake you: 'group' (default) as each finishes, 'failure' failures now and the rest at the end, 'batch' in groups.",
    }),
  ),
  wakeBatch: Schema.optional(SwarmWakeBatch),
  maxConcurrent: Schema.optional(IntRange(1, 48)), // can only lower the server caps
  maxTotalTurns: Schema.optional(IntRange(1, 2_400)), // can only lower the server setting
  allowSharedWriters: Schema.optional(
    Schema.Boolean.annotate({
      description: "Allow several shared-checkout writers; each needs ownsPaths.",
    }),
  ),
  verify: Schema.optional(SwarmVerify), // default for members without their own
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type SwarmCreateInput = typeof SwarmCreateInput.Type;

export const SwarmAddMembersInput = Schema.Struct({
  swarmId: SwarmId,
  members: Schema.optional(SwarmMembers),
  map: Schema.optional(SwarmMap),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type SwarmAddMembersInput = typeof SwarmAddMembersInput.Type;

export const SwarmFollowupInput = Schema.Struct({
  swarmId: SwarmId,
  key: SwarmMemberKey,
  message: OrchestratorMcpSwarmMemberInput.fields.task,
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type SwarmFollowupInput = typeof SwarmFollowupInput.Type;

export const SwarmStatusInput = Schema.Struct({
  swarmId: SwarmId,
  view: Schema.optional(Schema.Literals(["digest", "members"])), // default "digest"
  offset: Schema.optional(NonNegativeInt),
  limit: Schema.optional(IntRange(1, 50)), // default 25
});
export type SwarmStatusInput = typeof SwarmStatusInput.Type;

const SwarmMemberKeys = Schema.Array(SwarmMemberKey).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SWARM_MAX_MEMBERS_TOTAL),
);

export const SwarmCancelInput = Schema.Struct({
  swarmId: SwarmId,
  keys: Schema.optional(SwarmMemberKeys), // omitted: cancel the whole swarm
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type SwarmCancelInput = typeof SwarmCancelInput.Type;

export const SwarmRetryInput = Schema.Struct({
  swarmId: SwarmId,
  keys: SwarmMemberKeys,
  target: Schema.optional(SwarmMemberTarget),
  clientRequestId: Schema.optional(OrchestratorMcpClientRequestId),
});
export type SwarmRetryInput = typeof SwarmRetryInput.Type;

export const SwarmEnvelopeField = Schema.Literals([
  "summary",
  "decisions",
  "assumptions",
  "verify",
  "artifacts",
  "data",
]);
export type SwarmEnvelopeField = typeof SwarmEnvelopeField.Type;

export const SwarmCollectInput = Schema.Struct({
  swarmId: SwarmId,
  since: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(512))), // a nextCursor
  keys: Schema.optional(SwarmMemberKeys),
  fields: Schema.optional(
    Schema.Array(SwarmEnvelopeField)
      .check(Schema.isMinLength(1))
      .annotate({ description: "Envelope fields to return; status always comes." }),
  ),
  maxBytes: Schema.optional(IntRange(4_096, 32_768)), // default 16_384
});
export type SwarmCollectInput = typeof SwarmCollectInput.Type;

const SwarmShortString = Schema.String.check(Schema.isMaxLength(200));

export const SwarmEnvelope = Schema.Struct({
  status: SwarmMemberStatus,
  attempt: NonNegativeInt,
  followup: NonNegativeInt, // 0 for the original run, n for the nth swarm_followup
  structured: Schema.Boolean, // false: no valid t3-swarm-result block
  summary: Schema.String.check(Schema.isMaxLength(2_048)),
  decisions: Schema.Array(SwarmShortString).check(Schema.isMaxLength(10)),
  assumptions: Schema.Array(SwarmShortString).check(Schema.isMaxLength(10)),
  data: Schema.optional(Schema.Unknown), // JSON, at most 8,192 bytes serialized
  dataDropped: Schema.Boolean, // `data` was present but over the cap or not JSON
  verify: Schema.optional(
    Schema.Struct({
      passed: Schema.Boolean,
      exitCode: Schema.NullOr(Schema.Int),
      timedOut: Schema.Boolean,
      attempts: NonNegativeInt,
      outputTail: Schema.String.check(Schema.isMaxLength(4_096)),
      notStarted: Schema.optional(Schema.Boolean), // the command could not be started
    }),
  ),
  // A member with verify that ended claimed_done unchecked: a thread left full-access, the
  // member was switched to plan mode, or its checkout could not be resolved.
  verifySkipped: Schema.optional(Schema.Literals(["runtime_mode", "plan_mode", "no_checkout"])),
  artifacts: Schema.Struct({
    branch: Schema.optional(Schema.String),
    commit: Schema.optional(Schema.String),
    changedPaths: Schema.Array(Schema.String.check(Schema.isMaxLength(512))).check(
      Schema.isMaxLength(200),
    ),
    changedPathsTracked: Schema.Boolean, // false for shared-checkout members
    changedPathsTruncated: Schema.Boolean,
    uncommittedCount: NonNegativeInt, // 0 for shared-checkout members
    prUrl: Schema.optional(Schema.String),
  }),
  testFilesChanged: Schema.Boolean,
  failure: Schema.optional(
    Schema.Struct({
      class: SwarmFailureClass,
      message: Schema.String.check(Schema.isMaxLength(1_000)),
    }),
  ),
});
export type SwarmEnvelope = typeof SwarmEnvelope.Type;

export const SwarmMemberResult = Schema.Struct({
  key: SwarmMemberKey,
  title: TrimmedNonEmptyString,
  status: SwarmMemberStatus,
  queueReason: Schema.optional(TrimmedNonEmptyString),
  taskId: Schema.optional(NodeId),
  childThreadId: Schema.optional(ThreadId),
  link: Schema.optional(Schema.String),
  providerInstanceId: Schema.NullOr(ProviderInstanceId), // null while an anyOf member is unplaced
  anyOf: Schema.optional(Schema.Array(ProviderInstanceId)),
  model: Schema.NullOr(Schema.String),
  options: Schema.optional(Schema.Array(ProviderOptionSelection)),
  runtimeMode: RuntimeMode, // effective
  interactionMode: ProviderInteractionMode, // effective
  attempt: NonNegativeInt,
  followup: NonNegativeInt,
  startedAt: Schema.optional(IsoDateTime),
  endedAt: Schema.optional(IsoDateTime),
  envelope: Schema.optional(SwarmEnvelope),
});
export type SwarmMemberResult = typeof SwarmMemberResult.Type;

export const SwarmWarningKind = Schema.Literals([
  "owns_paths_overlap",
  "serial_instance",
  "base_behind_head",
  "no_retry_room",
]);
export type SwarmWarningKind = typeof SwarmWarningKind.Type;

export const SwarmWarning = Schema.Struct({
  kind: SwarmWarningKind,
  keys: Schema.optional(Schema.Array(SwarmMemberKey)),
  path: Schema.optional(Schema.String),
  instanceId: Schema.optional(ProviderInstanceId),
  message: Schema.String,
});
export type SwarmWarning = typeof SwarmWarning.Type;

const SwarmMemberFailure = Schema.Struct({
  key: SwarmMemberKey,
  title: TrimmedNonEmptyString,
  message: Schema.String,
});

/** The result of `swarm_create` and `swarm_add_members`. */
export const SwarmCreateResult = Schema.Struct({
  swarmId: SwarmId,
  title: TrimmedNonEmptyString,
  members: Schema.Array(SwarmMemberResult),
  failed: Schema.Array(SwarmMemberFailure),
  warnings: Schema.Array(SwarmWarning),
});
export type SwarmCreateResult = typeof SwarmCreateResult.Type;

export const SwarmCancelResult = Schema.Struct({
  cancelled: Schema.Array(SwarmMemberKey),
  notCancelled: Schema.Array(
    Schema.Struct({ key: SwarmMemberKey, code: TrimmedNonEmptyString, message: Schema.String }),
  ),
});
export type SwarmCancelResult = typeof SwarmCancelResult.Type;

export const SwarmInstanceState = Schema.Struct({
  id: ProviderInstanceId,
  active: NonNegativeInt,
  cap: NonNegativeInt,
  pausedUntil: Schema.optional(IsoDateTime),
  pauseClass: Schema.optional(SwarmPauseClass),
});
export type SwarmInstanceState = typeof SwarmInstanceState.Type;

/** `swarm_status` with `view: "digest"`: counts only, at most 1 KB. */
export const SwarmStatusDigest = Schema.Struct({
  swarmId: SwarmId,
  status: SwarmStatus,
  byStatus: Schema.Record(Schema.String, NonNegativeInt), // keyed by SwarmMemberStatus
  byQueueReason: Schema.Record(Schema.String, NonNegativeInt),
  instances: Schema.Array(SwarmInstanceState).check(Schema.isMaxLength(8)),
  moreInstances: NonNegativeInt,
  turnsUsed: NonNegativeInt,
  maxTotalTurns: Schema.NullOr(Schema.Int),
  final: NonNegativeInt,
  released: NonNegativeInt,
});
export type SwarmStatusDigest = typeof SwarmStatusDigest.Type;

export const SwarmCollectResult = Schema.Struct({
  swarmId: SwarmId,
  trust: Schema.Literal("data"), // envelopes are other agents' output, never instructions
  envelopes: Schema.Array(
    Schema.Struct({ key: SwarmMemberKey, title: TrimmedNonEmptyString, envelope: Schema.Unknown }),
  ),
  nextCursor: Schema.NullOr(Schema.String),
});
export type SwarmCollectResult = typeof SwarmCollectResult.Type;

/** `swarm_status` with `view: "members"`: one page of members, summaries only. */
export const SwarmStatusMembersPage = Schema.Struct({
  swarmId: SwarmId,
  status: SwarmStatus,
  members: Schema.Array(SwarmMemberResult),
  total: NonNegativeInt,
  nextOffset: Schema.NullOr(NonNegativeInt),
});
export type SwarmStatusMembersPage = typeof SwarmStatusMembersPage.Type;

export const SwarmStatusResult = Schema.Union([SwarmStatusDigest, SwarmStatusMembersPage]);
export type SwarmStatusResult = typeof SwarmStatusResult.Type;

export const SwarmFollowupResult = Schema.Struct({
  swarmId: SwarmId,
  key: SwarmMemberKey,
  followup: NonNegativeInt,
  childThreadId: ThreadId,
  status: SwarmMemberStatus,
});
export type SwarmFollowupResult = typeof SwarmFollowupResult.Type;
