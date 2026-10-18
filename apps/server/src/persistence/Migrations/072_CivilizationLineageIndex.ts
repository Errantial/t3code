import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX civilization_citizens_project_parent_idx
    ON civilization_citizens(project_id, parent_thread_id, deleted, birth_sequence, thread_id)
  `;
});
