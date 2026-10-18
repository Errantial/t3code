import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds membership-only correspondence history revision and bounded lookup indexes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 74 });

    yield* sql`
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send,
        sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
        reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
        terminal_retention_days
      ) VALUES (
        'mail:pre-075', 'project:correspondence-migration', 'thread:sender', 'Sender',
        0, 'run:sender', 'thread:recipient', 0, NULL, 'legacy retained body', 20,
        'full-access', 'default', 0, 0,
        '2026-10-17T10:00:00.000Z', '2026-11-17T10:00:00.000Z', 30
      )
    `;

    yield* runMigrations({ toMigrationInclusive: 75 });

    const stateAfterUpgrade = (yield* sql<{ readonly mail_history_revision: number }>`
      SELECT mail_history_revision
      FROM civilization_project_state
      WHERE project_id = 'project:correspondence-migration'
    `)[0];
    assert.equal(stateAfterUpgrade?.mail_history_revision, 0);

    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN (
        'civilization_messages_project_history_idx',
        'civilization_messages_pair_history_idx',
        'civilization_messages_reply_history_idx'
      )
      ORDER BY name ASC
    `;
    assert.deepEqual(
      indexes.map((row) => row.name),
      [
        "civilization_messages_pair_history_idx",
        "civilization_messages_project_history_idx",
        "civilization_messages_reply_history_idx",
      ],
    );

    yield* sql`
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send,
        sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
        reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
        terminal_retention_days
      ) VALUES (
        'mail:post-075', 'project:correspondence-migration', 'thread:recipient', 'Recipient',
        0, 'run:recipient', 'thread:sender', 1, 'mail:pre-075', 'new retained body', 17,
        'full-access', 'default', 0, 0,
        '2026-10-17T10:01:00.000Z', '2026-11-17T10:01:00.000Z', 30
      )
    `;
    assert.equal(
      (yield* sql<{ readonly mail_history_revision: number }>`
        SELECT mail_history_revision FROM civilization_project_state
        WHERE project_id = 'project:correspondence-migration'
      `)[0]?.mail_history_revision,
      1,
    );

    yield* sql`
      UPDATE civilization_messages
      SET acknowledged_at = '2026-10-17T10:02:00.000Z',
          terminal_at = '2026-10-17T10:03:00.000Z',
          terminal_reason = 'recipient_settled'
      WHERE message_id = 'mail:post-075'
    `;
    assert.equal(
      (yield* sql<{ readonly mail_history_revision: number }>`
        SELECT mail_history_revision FROM civilization_project_state
        WHERE project_id = 'project:correspondence-migration'
      `)[0]?.mail_history_revision,
      1,
      "mutable delivery state must not invalidate correspondence membership cursors",
    );

    yield* sql`DELETE FROM civilization_messages WHERE message_id = 'mail:post-075'`;
    assert.equal(
      (yield* sql<{ readonly mail_history_revision: number }>`
        SELECT mail_history_revision FROM civilization_project_state
        WHERE project_id = 'project:correspondence-migration'
      `)[0]?.mail_history_revision,
      2,
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
