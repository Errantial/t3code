import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE civilization_messages
    ADD COLUMN content_kind TEXT NOT NULL DEFAULT 'text'
      CHECK (content_kind IN ('text', 'handoff_v1'))
  `;
  // Receipts written before this migration deliberately retain NULL here. That
  // marker lets MailService recognize the exact legacy text-send hash without
  // making the legacy hash valid for newly introduced structured content.
  yield* sql`
    ALTER TABLE civilization_mail_operation_receipts
    ADD COLUMN content_kind TEXT
      CHECK (content_kind IS NULL OR content_kind IN ('text', 'handoff_v1'))
  `;

  yield* sql`DROP TRIGGER civilization_messages_immutable_content`;
  yield* sql`
    CREATE TRIGGER civilization_messages_immutable_content
    BEFORE UPDATE ON civilization_messages
    WHEN NEW.message_id <> OLD.message_id
      OR NEW.project_id <> OLD.project_id
      OR NEW.sender_thread_id <> OLD.sender_thread_id
      OR NEW.sender_name_at_send <> OLD.sender_name_at_send
      OR NEW.sender_citizen_epoch <> OLD.sender_citizen_epoch
      OR NEW.sender_run_id <> OLD.sender_run_id
      OR NEW.recipient_thread_id <> OLD.recipient_thread_id
      OR NEW.recipient_delivery_epoch <> OLD.recipient_delivery_epoch
      OR COALESCE(NEW.reply_to_message_id, '') <> COALESCE(OLD.reply_to_message_id, '')
      OR NEW.content_kind <> OLD.content_kind
      OR NEW.body <> OLD.body
      OR NEW.body_bytes <> OLD.body_bytes
      OR NEW.accepted_runtime_mode <> OLD.accepted_runtime_mode
      OR NEW.accepted_interaction_mode <> OLD.accepted_interaction_mode
      OR NEW.accepted_environment_revision <> OLD.accepted_environment_revision
      OR NEW.accepted_project_revision <> OLD.accepted_project_revision
      OR NEW.accepted_at <> OLD.accepted_at
      OR NEW.expires_at <> OLD.expires_at
      OR NEW.terminal_retention_days <> OLD.terminal_retention_days
    BEGIN
      SELECT RAISE(ABORT, 'civilization message acceptance fields are immutable');
    END
  `;
});
