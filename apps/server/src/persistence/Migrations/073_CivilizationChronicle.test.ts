import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds Chronicle projection storage without fabricating historical entries", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 72 });
    yield* sql`
      INSERT INTO projection_projects (
        project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
      ) VALUES ('project:chronicle-existing', 'Existing', '/tmp/existing', '[]', datetime('now'), datetime('now'), NULL)
    `;
    yield* sql`
      INSERT INTO civilization_citizens (
        thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
        generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
        name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
        name_environment_revision, name_project_revision,
        profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
        profile_environment_revision, profile_project_revision,
        title_managed, preserved_title, last_managed_title, title_topic,
        pending_title_command_id, pending_managed_title, pending_title_topic,
        epoch, closed, deleted, revision, created_at, updated_at
      ) VALUES (
        'thread:chronicle-existing', 'project:chronicle-existing', NULL, NULL,
        'thread:chronicle-existing', 0, 'resolved', 0, 1, 1,
        'existing-name', 1, 'Existing', 'Existing', 'existing-name', 'default-names', 0, 0,
        'existing-profile', 'Existing', '[]', 'pre-migration-secret-style', 'default-profiles', 0, 0,
        0, NULL, NULL, 'Existing', NULL, NULL, NULL,
        0, 0, 0, 1, '2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00.000Z'
      )
    `;
    yield* sql`
      INSERT INTO civilization_notes (
        note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
        accepted_runtime_mode, accepted_interaction_mode, source_refs_json,
        revision, created_at, updated_at, resolved_at
      ) VALUES (
        'note:chronicle-existing', 'project:chronicle-existing', 'fact',
        'pre-migration-secret-note-body', 30, 'thread:chronicle-existing', 0,
        'full-access', 'default', '[]', 1,
        '2026-10-17T10:01:00.000Z', '2026-10-17T10:01:00.000Z', NULL
      )
    `;
    yield* sql`
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send,
        sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
        body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
        terminal_retention_days
      ) VALUES (
        'mail:chronicle-existing', 'project:chronicle-existing', 'thread:chronicle-existing',
        'Existing', 0, 'run:existing', 'thread:recipient', 0,
        'pre-migration-secret-mail-body', 30, 'full-access', 'default', 0, 0,
        '2026-10-17T10:02:00.000Z', '2026-11-17T10:02:00.000Z', 30
      )
    `;
    yield* runMigrations({ toMigrationInclusive: 73 });
    const tables = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'civilization_chronicle_entries'
    `;
    assert.lengthOf(tables, 1);
    const entries = yield* sql<{
      readonly count: number;
    }>`SELECT COUNT(*) AS count FROM civilization_chronicle_entries`;
    assert.equal(entries[0]?.count, 0);
    const columns = yield* sql<{
      readonly name: string;
    }>`PRAGMA table_info(civilization_project_state)`;
    assert.isTrue(columns.some((column) => column.name === "chronicle_revision"));

    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name LIKE 'civilization_chronicle_%'
    `;
    assert.includeMembers(
      indexes.map((row) => row.name),
      [
        "civilization_chronicle_project_recent_idx",
        "civilization_chronicle_thread_recent_idx",
        "civilization_chronicle_secondary_thread_recent_idx",
        "civilization_chronicle_thread_kind_recent_idx",
        "civilization_chronicle_secondary_thread_kind_recent_idx",
        "civilization_chronicle_kind_recent_idx",
      ],
    );

    yield* sql`
      UPDATE civilization_citizens
      SET name_entry_id = 'replacement-name', revision = revision + 1
      WHERE thread_id = 'thread:chronicle-existing'
    `;
    yield* sql`
      INSERT INTO civilization_notes (
        note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
        accepted_runtime_mode, accepted_interaction_mode, source_refs_json,
        revision, created_at, updated_at, resolved_at
      ) VALUES (
        'note:chronicle-new', 'project:chronicle-existing', 'decision',
        'new-secret-note-body', 20, 'thread:chronicle-existing', 0,
        'full-access', 'default', '[]', 1,
        '2026-10-17T11:00:00.000Z', '2026-10-17T11:00:00.000Z', NULL
      )
    `;
    yield* sql`
      UPDATE civilization_notes
      SET resolved_at = '2026-10-17T11:01:00.000Z', revision = revision + 1
      WHERE note_id = 'note:chronicle-new'
    `;
    yield* sql`
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send,
        sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
        body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
        terminal_retention_days
      ) VALUES (
        'mail:chronicle-new', 'project:chronicle-existing', 'thread:chronicle-existing',
        'Existing', 0, 'run:new', 'thread:recipient', 0,
        'new-secret-mail-body', 20, 'full-access', 'default', 0, 0,
        '2026-10-17T11:02:00.000Z', '2026-11-17T11:02:00.000Z', 30
      )
    `;
    yield* sql`
      UPDATE civilization_messages
      SET acknowledged_at = '2026-10-17T11:03:00.000Z'
      WHERE message_id = 'mail:chronicle-new'
    `;

    const projected = yield* sql<{
      readonly kind: string;
      readonly metadata_json: string;
    }>`
      SELECT kind, metadata_json FROM civilization_chronicle_entries
      WHERE project_id = 'project:chronicle-existing'
      ORDER BY kind ASC
    `;
    assert.deepEqual(
      projected.map((row) => row.kind),
      ["identity_reassigned", "mail_acknowledged", "mail_sent", "note_created", "note_resolved"],
    );
    const metadata = projected.map((row) => row.metadata_json).join("\n");
    assert.notInclude(metadata, "new-secret-note-body");
    assert.notInclude(metadata, "new-secret-mail-body");
    assert.notInclude(metadata, "pre-migration-secret");
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
