import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // A project may name a workspace root per linked environment. v1.2.0 only
  // stores the map; the target verifies the path and its repository at use
  // time in v1.3. An older build ignores the column.
  yield* sql`
    ALTER TABLE projection_projects
    ADD COLUMN environment_roots_json TEXT NOT NULL DEFAULT '{}'
  `;
});
