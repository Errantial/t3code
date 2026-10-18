import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Correspondence history cursors track retained membership only. Delivery
  // state changes continue to use mail_revision so offer/ack/terminal updates
  // do not invalidate every history page.
  yield* sql`
    ALTER TABLE civilization_project_state
    ADD COLUMN mail_history_revision INTEGER NOT NULL DEFAULT 0 CHECK (mail_history_revision >= 0)
  `;

  yield* sql`
    CREATE INDEX civilization_messages_project_history_idx
    ON civilization_messages(project_id, accepted_at DESC, message_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_messages_pair_history_idx
    ON civilization_messages(
      project_id, sender_thread_id, recipient_thread_id, accepted_at DESC, message_id DESC
    )
  `;
  yield* sql`
    CREATE INDEX civilization_messages_reply_history_idx
    ON civilization_messages(project_id, reply_to_message_id, accepted_at ASC, message_id ASC)
  `;

  yield* sql`
    CREATE TRIGGER civilization_messages_history_revision_insert
    AFTER INSERT ON civilization_messages
    BEGIN
      INSERT INTO civilization_project_state (project_id, mail_history_revision, updated_at)
      VALUES (NEW.project_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(project_id) DO UPDATE SET
        mail_history_revision = mail_history_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_messages_history_revision_delete
    AFTER DELETE ON civilization_messages
    BEGIN
      INSERT INTO civilization_project_state (project_id, mail_history_revision, updated_at)
      VALUES (OLD.project_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(project_id) DO UPDATE SET
        mail_history_revision = mail_history_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;
});
