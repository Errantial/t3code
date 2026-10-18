import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX civilization_chronicle_source_recent_idx
    ON civilization_chronicle_entries(project_id, source_id, occurred_at DESC, entry_id DESC)
  `;
});
