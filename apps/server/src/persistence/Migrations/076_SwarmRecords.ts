import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Swarm v2. A queued member exists only as a row here until it is admitted. Task text,
  // shared context, envelopes, and verify argv are stored here and are never logged.
  yield* sql`
    CREATE TABLE IF NOT EXISTS swarms (
      swarm_id TEXT PRIMARY KEY NOT NULL,
      request_key TEXT NOT NULL UNIQUE,
      parent_thread_id TEXT NOT NULL,
      anchor_run_id TEXT NOT NULL,
      anchor_node_id TEXT NOT NULL,
      base_commit TEXT,
      title TEXT NOT NULL,
      wake_policy TEXT NOT NULL CHECK (wake_policy IN ('group', 'failure', 'batch')),
      wake_batch_json TEXT,
      max_concurrent INTEGER,
      max_total_turns INTEGER,
      verify_json TEXT,
      shared_context TEXT,
      data_shape TEXT,
      allow_shared_writers INTEGER NOT NULL DEFAULT 0 CHECK (allow_shared_writers IN (0, 1)),
      budget_exhausted INTEGER NOT NULL DEFAULT 0 CHECK (budget_exhausted IN (0, 1)),
      status TEXT NOT NULL CHECK (status IN ('active', 'completed', 'cancelled', 'detached')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarms_parent_status ON swarms (parent_thread_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarms_status ON swarms (status)
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS swarm_members (
      swarm_id TEXT NOT NULL,
      member_key TEXT NOT NULL,
      ordinal INTEGER NOT NULL,
      spec_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN (
        'queued', 'launching', 'running', 'limit_wait', 'claimed_done', 'verifying',
        'verified', 'failed', 'cancelled', 'detached'
      )),
      queue_reason TEXT,
      attempt INTEGER NOT NULL DEFAULT 1,
      priority INTEGER NOT NULL DEFAULT 0,
      command_id TEXT,
      task_id TEXT,
      superseded_task_id TEXT,
      child_thread_id TEXT,
      child_run_id TEXT,
      bound_run_id TEXT,
      provider_instance_id TEXT,
      effective_runtime_mode TEXT,
      effective_interaction_mode TEXT,
      writer INTEGER NOT NULL DEFAULT 0 CHECK (writer IN (0, 1)),
      failure_class TEXT,
      last_failure_class TEXT,
      last_failed_at TEXT,
      last_failed_instance_id TEXT,
      envelope_json TEXT,
      turns_used INTEGER NOT NULL DEFAULT 0,
      verify_attempts INTEGER NOT NULL DEFAULT 0,
      followups INTEGER NOT NULL DEFAULT 0,
      followup_notified INTEGER NOT NULL DEFAULT 0 CHECK (followup_notified IN (0, 1)),
      auto_retries INTEGER NOT NULL DEFAULT 0,
      retry_after TEXT,
      released INTEGER NOT NULL DEFAULT 0 CHECK (released IN (0, 1)),
      queued_at TEXT NOT NULL,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (swarm_id, member_key)
    ) STRICT
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarm_members_status ON swarm_members (status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarm_members_instance_status
    ON swarm_members (provider_instance_id, status)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarm_members_last_failure
    ON swarm_members (last_failed_instance_id, last_failure_class, last_failed_at)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarm_members_child_thread ON swarm_members (child_thread_id)
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarm_members_task ON swarm_members (task_id)
  `;

  // A note's body is rebuilt from the members' stored envelopes; the row holds no text.
  yield* sql`
    CREATE TABLE IF NOT EXISTS swarm_note_outbox (
      swarm_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('followup_result')),
      members_json TEXT NOT NULL,
      sent INTEGER NOT NULL DEFAULT 0 CHECK (sent IN (0, 1)),
      created_at TEXT NOT NULL,
      PRIMARY KEY (swarm_id, seq)
    ) STRICT
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS swarm_instance_pauses (
      provider_instance_id TEXT PRIMARY KEY NOT NULL,
      pause_class TEXT NOT NULL CHECK (pause_class IN ('usage_limit', 'instance_down')),
      until TEXT NOT NULL,
      at TEXT NOT NULL
    ) STRICT
  `;
});
