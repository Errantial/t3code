import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // The running verify command of a member, so a check re-run after a restart can kill the old
  // process tree first. The start time guards against a reused pid.
  yield* sql`ALTER TABLE swarm_members ADD COLUMN verify_pid INTEGER`;
  yield* sql`ALTER TABLE swarm_members ADD COLUMN verify_started_at TEXT`;
});
