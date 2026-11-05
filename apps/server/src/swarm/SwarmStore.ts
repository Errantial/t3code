// @effect-diagnostics effectFnOpportunity:off
import {
  type CommandId,
  type NodeId,
  OrchestratorMcpFailure,
  type ProviderInstanceId,
  type ProviderInteractionMode,
  type RunId,
  type RuntimeMode,
  type SwarmFailureClass,
  type SwarmId,
  type SwarmMemberStatus,
  type SwarmPauseClass,
  type SwarmStatus,
  type SwarmWakePolicy,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

// Persistence for Swarm v2 (migration 076). Task text, shared context, envelopes, and verify
// argv live in these rows; nothing here logs them, and storage errors are logged by operation only.

/** Timestamps are ISO-8601 strings, as the other stores keep them. */
export interface SwarmRecord {
  readonly swarmId: SwarmId;
  readonly requestKey: string;
  readonly parentThreadId: ThreadId;
  readonly anchorRunId: RunId;
  readonly anchorNodeId: NodeId;
  readonly baseCommit: string | null;
  readonly title: string;
  readonly wakePolicy: SwarmWakePolicy;
  readonly wakeBatchJson: string | null;
  readonly maxConcurrent: number | null;
  readonly maxTotalTurns: number | null;
  readonly verifyJson: string | null;
  readonly sharedContext: string | null;
  readonly dataShape: string | null;
  readonly allowSharedWriters: boolean;
  readonly budgetExhausted: boolean;
  readonly status: SwarmStatus;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface SwarmMemberRecord {
  readonly swarmId: SwarmId;
  readonly memberKey: string;
  readonly ordinal: number;
  readonly specJson: string;
  readonly status: SwarmMemberStatus;
  readonly queueReason: string | null;
  readonly attempt: number;
  readonly priority: number;
  readonly commandId: CommandId | null;
  readonly taskId: NodeId | null;
  readonly supersededTaskId: NodeId | null;
  readonly childThreadId: ThreadId | null;
  readonly childRunId: RunId | null;
  readonly boundRunId: RunId | null;
  readonly providerInstanceId: ProviderInstanceId | null;
  readonly effectiveRuntimeMode: RuntimeMode | null;
  readonly effectiveInteractionMode: ProviderInteractionMode | null;
  readonly writer: boolean;
  readonly failureClass: SwarmFailureClass | null;
  readonly lastFailureClass: SwarmFailureClass | null;
  readonly lastFailedAt: string | null;
  readonly lastFailedInstanceId: ProviderInstanceId | null;
  readonly envelopeJson: string | null;
  readonly turnsUsed: number;
  readonly verifyAttempts: number;
  /** The running verify command's process and start time (migration 077). */
  readonly verifyPid: number | null;
  readonly verifyStartedAt: string | null;
  readonly followups: number;
  readonly followupNotified: boolean;
  readonly autoRetries: number;
  readonly retryAfter: string | null;
  readonly released: boolean;
  readonly queuedAt: string;
  readonly startedAt: string | null;
  readonly endedAt: string | null;
  readonly updatedAt: string;
}

/** A new member row: everything else starts at its column default. */
export type NewSwarmMember = Pick<
  SwarmMemberRecord,
  "memberKey" | "ordinal" | "specJson" | "queuedAt"
> &
  Partial<Pick<SwarmMemberRecord, "status" | "queueReason" | "providerInstanceId" | "writer">>;

const MEMBER_PATCH_COLUMNS = {
  specJson: "spec_json",
  status: "status",
  queueReason: "queue_reason",
  attempt: "attempt",
  priority: "priority",
  commandId: "command_id",
  taskId: "task_id",
  supersededTaskId: "superseded_task_id",
  childThreadId: "child_thread_id",
  childRunId: "child_run_id",
  boundRunId: "bound_run_id",
  providerInstanceId: "provider_instance_id",
  effectiveRuntimeMode: "effective_runtime_mode",
  effectiveInteractionMode: "effective_interaction_mode",
  writer: "writer",
  failureClass: "failure_class",
  lastFailureClass: "last_failure_class",
  lastFailedAt: "last_failed_at",
  lastFailedInstanceId: "last_failed_instance_id",
  envelopeJson: "envelope_json",
  turnsUsed: "turns_used",
  verifyAttempts: "verify_attempts",
  verifyPid: "verify_pid",
  verifyStartedAt: "verify_started_at",
  followups: "followups",
  followupNotified: "followup_notified",
  autoRetries: "auto_retries",
  retryAfter: "retry_after",
  released: "released",
  startedAt: "started_at",
  endedAt: "ended_at",
} as const satisfies Partial<Record<keyof SwarmMemberRecord, string>>;

export type SwarmMemberPatch = Partial<
  Pick<SwarmMemberRecord, keyof typeof MEMBER_PATCH_COLUMNS>
> & { readonly updatedAt: string };

export type SwarmPatch = Partial<Pick<SwarmRecord, "status" | "budgetExhausted" | "baseCommit">> & {
  readonly updatedAt: string;
};

export interface SwarmNoteRecord {
  readonly swarmId: SwarmId;
  readonly seq: number;
  readonly kind: "followup_result";
  readonly membersJson: string;
  readonly sent: boolean;
  readonly createdAt: string;
}

export interface SwarmNotice {
  readonly swarmId: SwarmId;
  readonly noticeKey: string;
  readonly kind: string;
  readonly text: string;
  readonly createdAt: string;
  readonly deliveredAt: string | null;
}

const noticeOf = (row: Row): SwarmNotice => ({
  swarmId: row.swarm_id as SwarmId,
  noticeKey: String(row.notice_key),
  kind: String(row.kind),
  text: String(row.text),
  createdAt: String(row.created_at),
  deliveredAt: nullableString(row.delivered_at),
});

export interface SwarmInstancePause {
  readonly providerInstanceId: ProviderInstanceId;
  readonly pauseClass: SwarmPauseClass;
  readonly until: string;
  readonly at: string;
}

type Row = Record<string, unknown>;

const bool = (value: unknown) => value === 1 || value === true;
const nullableString = (value: unknown) => (value === null ? null : String(value));
const nullableNumber = (value: unknown) => (value === null ? null : Number(value));
const sqlBoolean = (value: boolean) => (value ? 1 : 0);

const swarmOf = (row: Row): SwarmRecord => ({
  swarmId: row.swarm_id as SwarmId,
  requestKey: String(row.request_key),
  parentThreadId: row.parent_thread_id as ThreadId,
  anchorRunId: row.anchor_run_id as RunId,
  anchorNodeId: row.anchor_node_id as NodeId,
  baseCommit: nullableString(row.base_commit),
  title: String(row.title),
  wakePolicy: row.wake_policy as SwarmWakePolicy,
  wakeBatchJson: nullableString(row.wake_batch_json),
  maxConcurrent: nullableNumber(row.max_concurrent),
  maxTotalTurns: nullableNumber(row.max_total_turns),
  verifyJson: nullableString(row.verify_json),
  sharedContext: nullableString(row.shared_context),
  dataShape: nullableString(row.data_shape),
  allowSharedWriters: bool(row.allow_shared_writers),
  budgetExhausted: bool(row.budget_exhausted),
  status: row.status as SwarmStatus,
  createdAt: String(row.created_at),
  updatedAt: String(row.updated_at),
});

const memberOf = (row: Row): SwarmMemberRecord => ({
  swarmId: row.swarm_id as SwarmId,
  memberKey: String(row.member_key),
  ordinal: Number(row.ordinal),
  specJson: String(row.spec_json),
  status: row.status as SwarmMemberStatus,
  queueReason: nullableString(row.queue_reason),
  attempt: Number(row.attempt),
  priority: Number(row.priority),
  commandId: row.command_id as CommandId | null,
  taskId: row.task_id as NodeId | null,
  supersededTaskId: row.superseded_task_id as NodeId | null,
  childThreadId: row.child_thread_id as ThreadId | null,
  childRunId: row.child_run_id as RunId | null,
  boundRunId: row.bound_run_id as RunId | null,
  providerInstanceId: row.provider_instance_id as ProviderInstanceId | null,
  effectiveRuntimeMode: row.effective_runtime_mode as RuntimeMode | null,
  effectiveInteractionMode: row.effective_interaction_mode as ProviderInteractionMode | null,
  writer: bool(row.writer),
  failureClass: row.failure_class as SwarmFailureClass | null,
  lastFailureClass: row.last_failure_class as SwarmFailureClass | null,
  lastFailedAt: nullableString(row.last_failed_at),
  lastFailedInstanceId: row.last_failed_instance_id as ProviderInstanceId | null,
  envelopeJson: nullableString(row.envelope_json),
  turnsUsed: Number(row.turns_used),
  verifyAttempts: Number(row.verify_attempts),
  verifyPid: row.verify_pid == null ? null : Number(row.verify_pid),
  verifyStartedAt: nullableString(row.verify_started_at),
  followups: Number(row.followups),
  followupNotified: bool(row.followup_notified),
  autoRetries: Number(row.auto_retries),
  retryAfter: nullableString(row.retry_after),
  released: bool(row.released),
  queuedAt: String(row.queued_at),
  startedAt: nullableString(row.started_at),
  endedAt: nullableString(row.ended_at),
  updatedAt: String(row.updated_at),
});

const noteOf = (row: Row): SwarmNoteRecord => ({
  swarmId: row.swarm_id as SwarmId,
  seq: Number(row.seq),
  kind: "followup_result",
  membersJson: String(row.members_json),
  sent: bool(row.sent),
  createdAt: String(row.created_at),
});

const pauseOf = (row: Row): SwarmInstancePause => ({
  providerInstanceId: row.provider_instance_id as ProviderInstanceId,
  pauseClass: row.pause_class as SwarmPauseClass,
  until: String(row.until),
  at: String(row.at),
});

const memberRow = (swarmId: SwarmId, member: NewSwarmMember, updatedAt: string) => ({
  swarm_id: swarmId,
  member_key: member.memberKey,
  ordinal: member.ordinal,
  spec_json: member.specJson,
  status: member.status ?? "queued",
  queue_reason: member.queueReason ?? null,
  provider_instance_id: member.providerInstanceId ?? null,
  writer: sqlBoolean(member.writer ?? false),
  queued_at: member.queuedAt,
  updated_at: updatedAt,
});

const memberPatchRow = (patch: SwarmMemberPatch): Record<string, unknown> => {
  const row: Record<string, unknown> = { updated_at: patch.updatedAt };
  for (const [field, column] of Object.entries(MEMBER_PATCH_COLUMNS)) {
    const value = patch[field as keyof typeof MEMBER_PATCH_COLUMNS];
    if (value === undefined) continue;
    row[column] = typeof value === "boolean" ? sqlBoolean(value) : value;
  }
  return row;
};

const storageFailure = (operation: string) => () =>
  Effect.logWarning("swarm-store.failed", { operation }).pipe(
    Effect.andThen(
      Effect.fail(
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The swarm store here failed. The server log has details.",
        }),
      ),
    ),
  );

export class SwarmStore extends Context.Service<
  SwarmStore,
  {
    /** Inserts the swarm and its first members in one transaction. */
    readonly createSwarm: (input: {
      readonly swarm: SwarmRecord;
      readonly members: ReadonlyArray<NewSwarmMember>;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly getSwarm: (
      swarmId: SwarmId,
    ) => Effect.Effect<Option.Option<SwarmRecord>, OrchestratorMcpFailure>;
    /** A retried `swarm_create` finds its swarm by request key. */
    readonly getSwarmByRequestKey: (
      requestKey: string,
    ) => Effect.Effect<Option.Option<SwarmRecord>, OrchestratorMcpFailure>;
    readonly listSwarms: (filter: {
      readonly statuses?: ReadonlyArray<SwarmStatus>;
      readonly parentThreadId?: ThreadId;
    }) => Effect.Effect<ReadonlyArray<SwarmRecord>, OrchestratorMcpFailure>;
    readonly updateSwarm: (
      swarmId: SwarmId,
      patch: SwarmPatch,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly addMembers: (input: {
      readonly swarmId: SwarmId;
      readonly members: ReadonlyArray<NewSwarmMember>;
      readonly updatedAt: string;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Members in ordinal order. */
    readonly listMembers: (
      swarmId: SwarmId,
    ) => Effect.Effect<ReadonlyArray<SwarmMemberRecord>, OrchestratorMcpFailure>;
    readonly findMemberByChildThread: (
      childThreadId: ThreadId,
    ) => Effect.Effect<Option.Option<SwarmMemberRecord>, OrchestratorMcpFailure>;
    /** Returns false when the member does not exist. */
    readonly updateMember: (input: {
      readonly swarmId: SwarmId;
      readonly memberKey: string;
      readonly patch: SwarmMemberPatch;
    }) => Effect.Effect<boolean, OrchestratorMcpFailure>;
    readonly enqueueNote: (
      note: Omit<SwarmNoteRecord, "sent">,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Marks the note sent and its members' follow-ups notified, in one transaction. */
    readonly markNoteSent: (input: {
      readonly swarmId: SwarmId;
      readonly seq: number;
      readonly memberKeys?: ReadonlyArray<string>;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    /** Replaces an unsent note's members, while it is still being coalesced. */
    readonly updateNoteMembers: (input: {
      readonly swarmId: SwarmId;
      readonly seq: number;
      readonly membersJson: string;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly nextNoteSeq: (swarmId: SwarmId) => Effect.Effect<number, OrchestratorMcpFailure>;
    readonly listUnsentNotes: Effect.Effect<ReadonlyArray<SwarmNoteRecord>, OrchestratorMcpFailure>;
    readonly setInstancePause: (
      pause: SwarmInstancePause,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly clearInstancePause: (
      providerInstanceId: ProviderInstanceId,
    ) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly listInstancePauses: Effect.Effect<
      ReadonlyArray<SwarmInstancePause>,
      OrchestratorMcpFailure
    >;
    /**
     * Members across every swarm whose last failure was on `providerInstanceId`, of one of
     * `classes`, at or after `since` (SW-A8 instance down; the last-failure index).
     */
    readonly countRecentInstanceFailures: (input: {
      readonly providerInstanceId: ProviderInstanceId;
      readonly since: string;
      readonly classes: ReadonlyArray<SwarmFailureClass>;
    }) => Effect.Effect<number, OrchestratorMcpFailure>;
    /**
     * A notice for the architect's next turn (migration 078). Replaces the pending one with the
     * same key; an unchanged notice keeps its delivery. Returns whether anything changed.
     */
    readonly putNotice: (notice: {
      readonly swarmId: SwarmId;
      readonly parentThreadId: ThreadId;
      readonly noticeKey: string;
      readonly kind: string;
      readonly text: string;
      readonly createdAt: string;
    }) => Effect.Effect<boolean, OrchestratorMcpFailure>;
    /** The thread's pending notices, oldest first, marked delivered in the same transaction. */
    readonly takeNotices: (input: {
      readonly parentThreadId: ThreadId;
      readonly deliveredAt: string;
    }) => Effect.Effect<ReadonlyArray<SwarmNotice>, OrchestratorMcpFailure>;
    /** Every notice of a thread, delivered or not (the panel and tests). */
    readonly listNotices: (
      parentThreadId: ThreadId,
    ) => Effect.Effect<ReadonlyArray<SwarmNotice>, OrchestratorMcpFailure>;
    /** Runs store calls in one transaction (SW-A8: a failure, its pause, and its retry). */
    readonly transaction: <A, R>(
      effect: Effect.Effect<A, OrchestratorMcpFailure, R>,
    ) => Effect.Effect<A, OrchestratorMcpFailure, R>;
  }
>()("t3/swarm/SwarmStore") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const swarmRow = (swarm: SwarmRecord) => ({
    swarm_id: swarm.swarmId,
    request_key: swarm.requestKey,
    parent_thread_id: swarm.parentThreadId,
    anchor_run_id: swarm.anchorRunId,
    anchor_node_id: swarm.anchorNodeId,
    base_commit: swarm.baseCommit,
    title: swarm.title,
    wake_policy: swarm.wakePolicy,
    wake_batch_json: swarm.wakeBatchJson,
    max_concurrent: swarm.maxConcurrent,
    max_total_turns: swarm.maxTotalTurns,
    verify_json: swarm.verifyJson,
    shared_context: swarm.sharedContext,
    data_shape: swarm.dataShape,
    allow_shared_writers: sqlBoolean(swarm.allowSharedWriters),
    budget_exhausted: sqlBoolean(swarm.budgetExhausted),
    status: swarm.status,
    created_at: swarm.createdAt,
    updated_at: swarm.updatedAt,
  });

  const insertMembers = (
    swarmId: SwarmId,
    members: ReadonlyArray<NewSwarmMember>,
    updatedAt: string,
  ) =>
    members.length === 0
      ? Effect.void
      : sql`INSERT INTO swarm_members ${sql.insert(
          members.map((member) => memberRow(swarmId, member, updatedAt)),
        )}`.pipe(Effect.asVoid);

  const createSwarm: SwarmStore["Service"]["createSwarm"] = (input) =>
    sql
      .withTransaction(
        sql`INSERT INTO swarms ${sql.insert(swarmRow(input.swarm))}`.pipe(
          Effect.andThen(insertMembers(input.swarm.swarmId, input.members, input.swarm.updatedAt)),
        ),
      )
      .pipe(Effect.catch(storageFailure("createSwarm")));

  const getSwarm: SwarmStore["Service"]["getSwarm"] = (swarmId) =>
    sql<Row>`SELECT * FROM swarms WHERE swarm_id = ${swarmId}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), swarmOf)),
      Effect.catch(storageFailure("getSwarm")),
    );

  const getSwarmByRequestKey: SwarmStore["Service"]["getSwarmByRequestKey"] = (requestKey) =>
    sql<Row>`SELECT * FROM swarms WHERE request_key = ${requestKey}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), swarmOf)),
      Effect.catch(storageFailure("getSwarmByRequestKey")),
    );

  const listSwarms: SwarmStore["Service"]["listSwarms"] = (filter) => {
    const clauses = [
      ...(filter.statuses === undefined ? [] : [sql.in("status", filter.statuses)]),
      ...(filter.parentThreadId === undefined
        ? []
        : [sql`parent_thread_id = ${filter.parentThreadId}`]),
    ];
    return sql<Row>`
      SELECT * FROM swarms ${clauses.length === 0 ? sql`` : sql`WHERE ${sql.and(clauses)}`}
      ORDER BY created_at ASC, swarm_id ASC
    `.pipe(
      Effect.map((rows) => rows.map(swarmOf)),
      Effect.catch(storageFailure("listSwarms")),
    );
  };

  const updateSwarm: SwarmStore["Service"]["updateSwarm"] = (swarmId, patch) => {
    const row: Record<string, unknown> = {
      updated_at: patch.updatedAt,
      ...(patch.status === undefined ? {} : { status: patch.status }),
      ...(patch.budgetExhausted === undefined
        ? {}
        : { budget_exhausted: sqlBoolean(patch.budgetExhausted) }),
      ...(patch.baseCommit === undefined ? {} : { base_commit: patch.baseCommit }),
    };
    return sql`UPDATE swarms SET ${sql.update(row)} WHERE swarm_id = ${swarmId}`.pipe(
      Effect.asVoid,
      Effect.catch(storageFailure("updateSwarm")),
    );
  };

  const addMembers: SwarmStore["Service"]["addMembers"] = (input) =>
    sql
      .withTransaction(insertMembers(input.swarmId, input.members, input.updatedAt))
      .pipe(Effect.catch(storageFailure("addMembers")));

  const listMembers: SwarmStore["Service"]["listMembers"] = (swarmId) =>
    sql<Row>`SELECT * FROM swarm_members WHERE swarm_id = ${swarmId} ORDER BY ordinal ASC`.pipe(
      Effect.map((rows) => rows.map(memberOf)),
      Effect.catch(storageFailure("listMembers")),
    );

  const findMemberByChildThread: SwarmStore["Service"]["findMemberByChildThread"] = (
    childThreadId,
  ) =>
    sql<Row>`SELECT * FROM swarm_members WHERE child_thread_id = ${childThreadId}`.pipe(
      Effect.map((rows) => Option.map(Option.fromNullishOr(rows[0]), memberOf)),
      Effect.catch(storageFailure("findMemberByChildThread")),
    );

  const updateMember: SwarmStore["Service"]["updateMember"] = (input) =>
    sql<Row>`
      UPDATE swarm_members SET ${sql.update(memberPatchRow(input.patch))}
      WHERE swarm_id = ${input.swarmId} AND member_key = ${input.memberKey}
      RETURNING member_key
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.catch(storageFailure("updateMember")),
    );

  const enqueueNote: SwarmStore["Service"]["enqueueNote"] = (note) =>
    sql`INSERT INTO swarm_note_outbox ${sql.insert({
      swarm_id: note.swarmId,
      seq: note.seq,
      kind: note.kind,
      members_json: note.membersJson,
      created_at: note.createdAt,
    })}`.pipe(Effect.asVoid, Effect.catch(storageFailure("enqueueNote")));

  const markNoteSent: SwarmStore["Service"]["markNoteSent"] = (input) =>
    sql
      .withTransaction(
        sql`
          UPDATE swarm_note_outbox SET sent = 1
          WHERE swarm_id = ${input.swarmId} AND seq = ${input.seq}
        `.pipe(
          Effect.andThen(
            (input.memberKeys ?? []).length === 0
              ? Effect.void
              : sql`
                  UPDATE swarm_members SET followup_notified = 1
                  WHERE swarm_id = ${input.swarmId}
                    AND ${sql.in("member_key", input.memberKeys ?? [])}
                `,
          ),
        ),
      )
      .pipe(Effect.asVoid, Effect.catch(storageFailure("markNoteSent")));

  const updateNoteMembers: SwarmStore["Service"]["updateNoteMembers"] = (input) =>
    sql`
      UPDATE swarm_note_outbox SET members_json = ${input.membersJson}
      WHERE swarm_id = ${input.swarmId} AND seq = ${input.seq} AND sent = 0
    `.pipe(Effect.asVoid, Effect.catch(storageFailure("updateNoteMembers")));

  const nextNoteSeq: SwarmStore["Service"]["nextNoteSeq"] = (swarmId) =>
    sql<{ readonly next: number }>`
      SELECT COALESCE(MAX(seq), 0) + 1 AS next FROM swarm_note_outbox WHERE swarm_id = ${swarmId}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.next ?? 1)),
      Effect.catch(storageFailure("nextNoteSeq")),
    );

  const listUnsentNotes: SwarmStore["Service"]["listUnsentNotes"] = sql<Row>`
    SELECT * FROM swarm_note_outbox WHERE sent = 0 ORDER BY swarm_id ASC, seq ASC
  `.pipe(
    Effect.map((rows) => rows.map(noteOf)),
    Effect.catch(storageFailure("listUnsentNotes")),
  );

  const setInstancePause: SwarmStore["Service"]["setInstancePause"] = (pause) =>
    sql`
      INSERT INTO swarm_instance_pauses (provider_instance_id, pause_class, until, at)
      VALUES (${pause.providerInstanceId}, ${pause.pauseClass}, ${pause.until}, ${pause.at})
      ON CONFLICT (provider_instance_id) DO UPDATE SET
        pause_class = excluded.pause_class, until = excluded.until, at = excluded.at
    `.pipe(Effect.asVoid, Effect.catch(storageFailure("setInstancePause")));

  const clearInstancePause: SwarmStore["Service"]["clearInstancePause"] = (providerInstanceId) =>
    sql`DELETE FROM swarm_instance_pauses WHERE provider_instance_id = ${providerInstanceId}`.pipe(
      Effect.asVoid,
      Effect.catch(storageFailure("clearInstancePause")),
    );

  const listInstancePauses: SwarmStore["Service"]["listInstancePauses"] = sql<Row>`
    SELECT * FROM swarm_instance_pauses ORDER BY provider_instance_id ASC
  `.pipe(
    Effect.map((rows) => rows.map(pauseOf)),
    Effect.catch(storageFailure("listInstancePauses")),
  );

  const countRecentInstanceFailures: SwarmStore["Service"]["countRecentInstanceFailures"] = (
    input,
  ) =>
    sql<{ readonly failures: number }>`
      SELECT COUNT(*) AS failures FROM swarm_members
      WHERE last_failed_instance_id = ${input.providerInstanceId}
        AND last_failed_at >= ${input.since}
        AND last_failure_class IN ${sql.in([...input.classes])}
    `.pipe(
      Effect.map((rows) => Number(rows[0]?.failures ?? 0)),
      Effect.catch(storageFailure("countRecentInstanceFailures")),
    );

  const putNotice: SwarmStore["Service"]["putNotice"] = (notice) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const existing = yield* sql<Row>`
            SELECT text FROM swarm_notices
            WHERE swarm_id = ${notice.swarmId} AND notice_key = ${notice.noticeKey}
          `;
          if (existing[0] !== undefined && String(existing[0].text) === notice.text) return false;
          yield* sql`
            INSERT INTO swarm_notices
              (swarm_id, notice_key, parent_thread_id, kind, text, created_at, delivered_at)
            VALUES (${notice.swarmId}, ${notice.noticeKey}, ${notice.parentThreadId},
              ${notice.kind}, ${notice.text}, ${notice.createdAt}, NULL)
            ON CONFLICT (swarm_id, notice_key) DO UPDATE SET
              text = excluded.text, created_at = excluded.created_at, delivered_at = NULL
          `;
          return true;
        }),
      )
      .pipe(Effect.catch(storageFailure("putNotice")));

  const takeNotices: SwarmStore["Service"]["takeNotices"] = (input) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<Row>`
            SELECT * FROM swarm_notices
            WHERE parent_thread_id = ${input.parentThreadId} AND delivered_at IS NULL
            ORDER BY created_at ASC, notice_key ASC
          `;
          if (rows.length === 0) return [];
          yield* sql`
            UPDATE swarm_notices SET delivered_at = ${input.deliveredAt}
            WHERE parent_thread_id = ${input.parentThreadId} AND delivered_at IS NULL
          `;
          return rows.map(noticeOf);
        }),
      )
      .pipe(Effect.catch(storageFailure("takeNotices")));

  const listNotices: SwarmStore["Service"]["listNotices"] = (parentThreadId) =>
    sql<Row>`
      SELECT * FROM swarm_notices WHERE parent_thread_id = ${parentThreadId}
      ORDER BY created_at ASC, notice_key ASC
    `.pipe(
      Effect.map((rows) => rows.map(noticeOf)),
      Effect.catch(storageFailure("listNotices")),
    );

  const transaction: SwarmStore["Service"]["transaction"] = (effect) =>
    sql.withTransaction(effect).pipe(Effect.catchTags({ SqlError: storageFailure("transaction") }));

  return SwarmStore.of({
    putNotice,
    takeNotices,
    listNotices,
    countRecentInstanceFailures,
    transaction,
    createSwarm,
    getSwarm,
    getSwarmByRequestKey,
    listSwarms,
    updateSwarm,
    addMembers,
    listMembers,
    findMemberByChildThread,
    updateMember,
    enqueueNote,
    markNoteSent,
    updateNoteMembers,
    nextNoteSeq,
    listUnsentNotes,
    setInstancePause,
    clearInstancePause,
    listInstancePauses,
  });
});

export const layer = Layer.effect(SwarmStore, make);
