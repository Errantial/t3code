import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE chatgpt_browser_provider_operations (
      run_attempt_id TEXT PRIMARY KEY NOT NULL,
      provider_operation_id TEXT NOT NULL UNIQUE,
      provider_session_id TEXT NOT NULL,
      provider_thread_id TEXT NOT NULL,
      consumer_high_water INTEGER NOT NULL DEFAULT 0 CHECK (consumer_high_water >= 0),
      cancel_requested INTEGER NOT NULL DEFAULT 0 CHECK (cancel_requested IN (0, 1))
    ) STRICT
  `;
});
