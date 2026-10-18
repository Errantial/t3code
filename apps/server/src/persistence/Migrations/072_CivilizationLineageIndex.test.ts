import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds the bounded direct-child lineage lookup index", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 72 });
    const rows = yield* sql<{ readonly sql: string }>`
      SELECT sql FROM sqlite_master
      WHERE type = 'index' AND name = 'civilization_citizens_project_parent_idx'
    `;
    assert.equal(rows.length, 1);
    assert.match(rows[0]!.sql, /project_id, parent_thread_id, deleted, birth_sequence, thread_id/);
    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT thread_id FROM civilization_citizens
      WHERE project_id = 'project:lineage-plan'
        AND parent_thread_id = 'thread:lineage-parent'
        AND deleted = 0
      ORDER BY birth_sequence ASC, thread_id ASC
      LIMIT 51
    `;
    assert.include(
      plan.map((row) => row.detail).join("\n"),
      "civilization_citizens_project_parent_idx",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
