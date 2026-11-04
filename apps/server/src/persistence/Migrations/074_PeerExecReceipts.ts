import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // One row per caller-chosen exec id. It keeps the request hash and terminal
  // metadata only: no argv, env values, output, or file content, so a replay
  // can answer without ever spawning the command twice.
  yield* sql`
    CREATE TABLE IF NOT EXISTS peer_exec_receipts (
      exec_id TEXT PRIMARY KEY NOT NULL,
      request_hash TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'failed', 'unknown')),
      result_json TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    ) STRICT
  `;
  yield* sql`
    CREATE INDEX IF NOT EXISTS peer_exec_receipts_updated_at
    ON peer_exec_receipts (state, updated_at)
  `;
});
