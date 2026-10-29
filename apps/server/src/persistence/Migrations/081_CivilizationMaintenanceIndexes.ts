import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX civilization_citizens_project_roster_idx
    ON civilization_citizens(project_id, deleted, name_key, thread_id)
  `;
  yield* sql`
    CREATE INDEX civilization_notes_project_cleanup_idx
    ON civilization_notes(project_id, resolved_at, note_id)
  `;
  yield* sql`
    CREATE INDEX civilization_mail_quota_project_window_idx
    ON civilization_mail_quota_windows(project_id, window_start_minute)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_project_acknowledged_idx
    ON civilization_messages(project_id, acknowledged_at, message_id)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_project_terminal_idx
    ON civilization_messages(project_id, terminal_at, message_id)
  `;
});
