import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE civilization_project_state
    ADD COLUMN chronicle_revision INTEGER NOT NULL DEFAULT 0 CHECK (chronicle_revision >= 0)
  `;

  yield* sql`
    CREATE TABLE civilization_chronicle_entries (
      entry_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN (
        'citizen_joined', 'citizen_adopted', 'child_joined',
        'citizen_settled', 'citizen_returned', 'citizen_archived', 'citizen_deleted',
        'identity_reassigned', 'note_created', 'note_resolved',
        'mail_sent', 'mail_acknowledged', 'mail_terminal'
      )),
      primary_thread_id TEXT,
      secondary_thread_id TEXT,
      citizen_epoch INTEGER CHECK (citizen_epoch IS NULL OR citizen_epoch >= 0),
      citizen_revision INTEGER CHECK (citizen_revision IS NULL OR citizen_revision >= 1),
      source_kind TEXT NOT NULL CHECK (source_kind IN ('host_event', 'civilization_mutation')),
      source_id TEXT NOT NULL,
      source_sequence INTEGER CHECK (source_sequence IS NULL OR source_sequence >= 0),
      provenance_key TEXT NOT NULL UNIQUE,
      occurred_at TEXT NOT NULL,
      metadata_json TEXT NOT NULL DEFAULT '{}'
    )
  `;

  yield* sql`
    CREATE INDEX civilization_chronicle_project_recent_idx
    ON civilization_chronicle_entries(project_id, occurred_at DESC, entry_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_chronicle_thread_recent_idx
    ON civilization_chronicle_entries(project_id, primary_thread_id, occurred_at DESC, entry_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_chronicle_secondary_thread_recent_idx
    ON civilization_chronicle_entries(project_id, secondary_thread_id, occurred_at DESC, entry_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_chronicle_thread_kind_recent_idx
    ON civilization_chronicle_entries(project_id, primary_thread_id, kind, occurred_at DESC, entry_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_chronicle_secondary_thread_kind_recent_idx
    ON civilization_chronicle_entries(project_id, secondary_thread_id, kind, occurred_at DESC, entry_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_chronicle_kind_recent_idx
    ON civilization_chronicle_entries(project_id, kind, occurred_at DESC, entry_id DESC)
  `;

  yield* sql`
    CREATE TRIGGER civilization_chronicle_revision_insert
    AFTER INSERT ON civilization_chronicle_entries
    BEGIN
      INSERT INTO civilization_project_state (project_id, chronicle_revision, updated_at)
      VALUES (NEW.project_id, 1, datetime('now'))
      ON CONFLICT(project_id) DO UPDATE SET
        chronicle_revision = chronicle_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_chronicle_revision_delete
    AFTER DELETE ON civilization_chronicle_entries
    BEGIN
      UPDATE civilization_project_state
      SET chronicle_revision = chronicle_revision + 1,
          updated_at = datetime('now')
      WHERE project_id = OLD.project_id;
    END
  `;

  // Feature-owned mutation facts are projected by SQLite triggers so every
  // authoritative write path participates in the same transaction without an
  // application-level per-row loop. Creating these triggers does not backfill
  // existing rows, which deliberately avoids fabricated pre-v1.1 history.
  yield* sql`
    CREATE TRIGGER civilization_chronicle_identity_reassigned
    AFTER UPDATE OF name_entry_id, profile_entry_id ON civilization_citizens
    WHEN OLD.name_entry_id <> NEW.name_entry_id OR OLD.profile_entry_id <> NEW.profile_entry_id
    BEGIN
      INSERT OR IGNORE INTO civilization_chronicle_entries (
        entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
        citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
        provenance_key, occurred_at, metadata_json
      ) VALUES (
        'chronicle:identity:' || NEW.thread_id || ':' || NEW.revision,
        NEW.project_id, 'identity_reassigned', NEW.thread_id, NULL,
        NEW.epoch, NEW.revision, 'civilization_mutation',
        'identity:' || NEW.thread_id || ':' || NEW.revision, NULL,
        'civilization_mutation' || char(31) || 'identity:' || NEW.thread_id || ':' || NEW.revision || char(31) ||
          'identity_reassigned' || char(31) || NEW.thread_id || char(31),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        json_object('nameEntryId', NEW.name_entry_id, 'profileEntryId', NEW.profile_entry_id)
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_chronicle_note_created
    AFTER INSERT ON civilization_notes
    BEGIN
      INSERT OR IGNORE INTO civilization_chronicle_entries (
        entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
        citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
        provenance_key, occurred_at, metadata_json
      ) VALUES (
        'chronicle:note:' || NEW.note_id || ':created',
        NEW.project_id, 'note_created', NEW.author_thread_id, NULL,
        NEW.author_epoch, NULL, 'civilization_mutation', 'note:' || NEW.note_id || ':created', NULL,
        'civilization_mutation' || char(31) || 'note:' || NEW.note_id || ':created' || char(31) ||
          'note_created' || char(31) || NEW.author_thread_id || char(31),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
        json_object('noteId', NEW.note_id, 'category', NEW.category)
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_chronicle_note_resolved
    AFTER UPDATE OF resolved_at ON civilization_notes
    WHEN OLD.resolved_at IS NULL AND NEW.resolved_at IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO civilization_chronicle_entries (
        entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
        citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
        provenance_key, occurred_at, metadata_json
      ) VALUES (
        'chronicle:note:' || NEW.note_id || ':resolved:' || NEW.revision,
        NEW.project_id, 'note_resolved', NEW.author_thread_id, NULL,
        NEW.author_epoch, NULL, 'civilization_mutation',
        'note:' || NEW.note_id || ':resolved:' || NEW.revision, NULL,
        'civilization_mutation' || char(31) || 'note:' || NEW.note_id || ':resolved:' || NEW.revision || char(31) ||
          'note_resolved' || char(31) || NEW.author_thread_id || char(31),
        strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), json_object('noteId', NEW.note_id)
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_chronicle_mail_sent
    AFTER INSERT ON civilization_messages
    BEGIN
      INSERT OR IGNORE INTO civilization_chronicle_entries (
        entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
        citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
        provenance_key, occurred_at, metadata_json
      ) VALUES (
        'chronicle:mail:' || NEW.message_id || ':sent',
        NEW.project_id, 'mail_sent', NEW.sender_thread_id, NEW.recipient_thread_id,
        NEW.sender_citizen_epoch, NULL, 'civilization_mutation', 'mail:' || NEW.message_id || ':sent', NULL,
        'civilization_mutation' || char(31) || 'mail:' || NEW.message_id || ':sent' || char(31) ||
          'mail_sent' || char(31) || NEW.sender_thread_id || char(31) || NEW.recipient_thread_id,
        NEW.accepted_at, json_object('messageId', NEW.message_id)
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_chronicle_mail_acknowledged
    AFTER UPDATE OF acknowledged_at ON civilization_messages
    WHEN OLD.acknowledged_at IS NULL AND NEW.acknowledged_at IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO civilization_chronicle_entries (
        entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
        citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
        provenance_key, occurred_at, metadata_json
      ) VALUES (
        'chronicle:mail:' || NEW.message_id || ':acknowledged',
        NEW.project_id, 'mail_acknowledged', NEW.recipient_thread_id, NEW.sender_thread_id,
        NEW.recipient_delivery_epoch, NULL, 'civilization_mutation',
        'mail:' || NEW.message_id || ':acknowledged', NULL,
        'civilization_mutation' || char(31) || 'mail:' || NEW.message_id || ':acknowledged' || char(31) ||
          'mail_acknowledged' || char(31) || NEW.recipient_thread_id || char(31) || NEW.sender_thread_id,
        NEW.acknowledged_at, json_object('messageId', NEW.message_id)
      );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_chronicle_mail_terminal
    AFTER UPDATE OF terminal_at ON civilization_messages
    WHEN OLD.terminal_at IS NULL AND NEW.terminal_at IS NOT NULL
    BEGIN
      INSERT OR IGNORE INTO civilization_chronicle_entries (
        entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
        citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
        provenance_key, occurred_at, metadata_json
      ) VALUES (
        'chronicle:mail:' || NEW.message_id || ':terminal',
        NEW.project_id, 'mail_terminal', NEW.recipient_thread_id, NEW.sender_thread_id,
        NEW.recipient_delivery_epoch, NULL, 'civilization_mutation',
        'mail:' || NEW.message_id || ':terminal', NULL,
        'civilization_mutation' || char(31) || 'mail:' || NEW.message_id || ':terminal' || char(31) ||
          'mail_terminal' || char(31) || NEW.recipient_thread_id || char(31) || NEW.sender_thread_id,
        NEW.terminal_at,
        json_object('messageId', NEW.message_id, 'terminalReason', NEW.terminal_reason)
      );
    END
  `;
});
