import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("adds the bounded Chronicle source lookup used by cross-feature navigation", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 77 });
    const indexes = yield* sql<{ readonly name: string }>`
      SELECT name FROM sqlite_master
      WHERE type = 'index' AND name = 'civilization_chronicle_source_recent_idx'
    `;
    assert.deepEqual(
      indexes.map((row) => row.name),
      ["civilization_chronicle_source_recent_idx"],
    );

    const plan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT entry_id
      FROM civilization_chronicle_entries
      WHERE project_id = 'project:source-index'
        AND source_id = 'mail:source-index'
      ORDER BY occurred_at DESC, entry_id DESC
      LIMIT 26
    `;
    assert.include(
      plan.map((row) => row.detail).join("\n"),
      "civilization_chronicle_source_recent_idx",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
