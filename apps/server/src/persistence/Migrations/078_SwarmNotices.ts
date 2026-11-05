import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Swarm v2 notices for the architect: delivered once, in its next turn's context, never as a
  // message that would start a turn. Server-authored text of ids and counts; one row per
  // swarm and key, so a changed notice replaces the pending one.
  yield* sql`
    CREATE TABLE IF NOT EXISTS swarm_notices (
      swarm_id TEXT NOT NULL,
      notice_key TEXT NOT NULL,
      parent_thread_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      text TEXT NOT NULL,
      created_at TEXT NOT NULL,
      delivered_at TEXT,
      PRIMARY KEY (swarm_id, notice_key)
    ) STRICT
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS swarm_notices_pending
    ON swarm_notices (parent_thread_id, delivered_at)
  `;
});
