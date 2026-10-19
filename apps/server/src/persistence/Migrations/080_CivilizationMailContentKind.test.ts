import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const insertMessage = Effect.fn("080.test.insertMessage")(function* (input: {
  readonly messageId: string;
  readonly contentKind?: "text" | "handoff_v1" | "invalid" | undefined;
  readonly body: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  const bodyBytes = Buffer.byteLength(input.body, "utf8");
  if (input.contentKind === undefined) {
    yield* sql`
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send,
        sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
        body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision,
        accepted_at, expires_at, terminal_retention_days
      ) VALUES (
        ${input.messageId}, 'project:mail:080', 'thread:sender', 'Sender',
        0, 'run:sender', 'thread:recipient', 0,
        ${input.body}, ${bodyBytes}, 'full-access', 'default', 0, 0,
        '2026-10-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z', 30
      )
    `;
    return;
  }
  yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, content_kind, sender_thread_id, sender_name_at_send,
      sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
      body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision,
      accepted_at, expires_at, terminal_retention_days
    ) VALUES (
      ${input.messageId}, 'project:mail:080', ${input.contentKind}, 'thread:sender', 'Sender',
      0, 'run:sender', 'thread:recipient', 0,
      ${input.body}, ${bodyBytes}, 'full-access', 'default', 0, 0,
      '2026-10-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z', 30
    )
  `;
});

describe("080_CivilizationMailContentKind", () => {
  it.effect(
    "backfills text, marks legacy receipts, validates kinds and makes content kind immutable",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });

        yield* insertMessage({ messageId: "mail:legacy", body: "legacy body" });
        yield* sql`
        INSERT INTO civilization_mail_operation_receipts (
          project_id, actor_thread_id, actor_citizen_epoch, operation_kind,
          client_request_id, canonical_payload_hash, result_message_id, created_at, expires_at
        ) VALUES (
          'project:mail:080', 'thread:sender', 0, 'send',
          'request:legacy', 'sha256:legacy', 'mail:legacy',
          '2026-10-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z'
        )
      `;

        yield* runMigrations({ toMigrationInclusive: 80 });

        assert.deepStrictEqual(
          yield* sql<{ readonly content_kind: string }>`
          SELECT content_kind FROM civilization_messages WHERE message_id = 'mail:legacy'
        `,
          [{ content_kind: "text" }],
        );
        assert.deepStrictEqual(
          yield* sql<{ readonly content_kind: string | null }>`
          SELECT content_kind FROM civilization_mail_operation_receipts
          WHERE client_request_id = 'request:legacy'
        `,
          [{ content_kind: null }],
        );

        yield* insertMessage({
          messageId: "mail:handoff",
          contentKind: "handoff_v1",
          body: '{"version":1}',
        });
        const invalidKind = yield* Effect.exit(
          insertMessage({ messageId: "mail:invalid", contentKind: "invalid", body: "invalid" }),
        );
        assert.isTrue(Exit.isFailure(invalidKind));

        const mutateKind = yield* Effect.exit(sql`
        UPDATE civilization_messages SET content_kind = 'text' WHERE message_id = 'mail:handoff'
      `);
        assert.isTrue(Exit.isFailure(mutateKind));

        yield* sql`
        UPDATE civilization_messages
        SET acknowledged_at = '2026-10-18T10:01:00.000Z'
        WHERE message_id = 'mail:handoff'
      `;
        assert.deepStrictEqual(
          yield* sql<{ readonly acknowledged_at: string | null }>`
          SELECT acknowledged_at FROM civilization_messages WHERE message_id = 'mail:handoff'
        `,
          [{ acknowledged_at: "2026-10-18T10:01:00.000Z" }],
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
