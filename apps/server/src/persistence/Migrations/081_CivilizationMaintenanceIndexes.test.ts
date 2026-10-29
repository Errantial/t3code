import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const indexNames = [
  "civilization_citizens_project_roster_idx",
  "civilization_notes_project_cleanup_idx",
  "civilization_mail_quota_project_window_idx",
  "civilization_messages_project_acknowledged_idx",
  "civilization_messages_project_terminal_idx",
] as const;

it.effect("adds the bounded roster and retention-sweep indexes", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 81 });
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name IN ${sql.in(indexNames)}
      ORDER BY name ASC
    `;
    assert.deepEqual(
      indexes.map((row) => row.name),
      [...indexNames].sort(),
    );

    const rosterPlan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT thread_id
      FROM civilization_citizens
      WHERE project_id = 'project:roster-index' AND deleted = 0
      ORDER BY name_key ASC, thread_id ASC
      LIMIT 11
    `;
    assert.include(
      rosterPlan.map((row) => row.detail).join("\n"),
      "civilization_citizens_project_roster_idx",
    );

    const acknowledgedPlan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT message_id
      FROM civilization_messages
      WHERE project_id = 'project:ack-index' AND acknowledged_at IS NOT NULL
      ORDER BY acknowledged_at ASC, message_id ASC
      LIMIT 11
    `;
    assert.include(
      acknowledgedPlan.map((row) => row.detail).join("\n"),
      "civilization_messages_project_acknowledged_idx",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
