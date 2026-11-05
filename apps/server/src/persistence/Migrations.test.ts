import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("reserves the peer-exec and environment-roots migration ids", () =>
  Effect.gen(function* () {
    yield* Effect.void;
    assert.deepStrictEqual(
      migrationManifest.filter(([id]) => id === 74 || id === 75),
      [
        [74, "PeerExecReceipts"],
        [75, "ProjectionProjectsEnvironmentRoots"],
      ],
    );
  }),
);

it.effect("075 adds environment_roots_json with an empty default and is idempotent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    yield* sql`
      INSERT INTO projection_projects
        (project_id, title, workspace_root, default_model_selection_json,
         default_thread_env_mode, auto_pull, favicon_path, project_icon_json,
         scripts_json, created_at, updated_at, deleted_at)
      VALUES
        ('roots-project', 'Roots', '/tmp/roots', NULL, NULL, 0, NULL, NULL, '[]',
         '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL)
    `;
    const rows = yield* sql<{ readonly environment_roots_json: string }>`
      SELECT environment_roots_json FROM projection_projects WHERE project_id = 'roots-project'
    `;
    assert.strictEqual(rows[0]?.environment_roots_json, "{}");
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

// v1.2.0 reserves 074 and 075; Swarm v2 (v1.2.1) takes 076.
it.effect("reserves the swarm records migration id", () =>
  Effect.gen(function* () {
    yield* Effect.void;
    assert.deepStrictEqual(
      migrationManifest.filter(([id]) => id === 76 || id === 77),
      [
        [76, "SwarmRecords"],
        [77, "SwarmVerifyProcess"],
      ],
    );
  }),
);

it.effect("076 creates the swarm tables with their defaults and is idempotent", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations();
    const at = "2026-11-04T00:00:00.000Z";
    yield* sql`
      INSERT INTO swarms
        (swarm_id, request_key, parent_thread_id, anchor_run_id, anchor_node_id, title,
         wake_policy, status, created_at, updated_at)
      VALUES ('swarm-1', 'request-1', 'thread-1', 'run-1', 'node-1', 'Swarm', 'group',
         'active', ${at}, ${at})
    `;
    yield* sql`
      INSERT INTO swarm_members
        (swarm_id, member_key, ordinal, spec_json, status, queued_at, updated_at)
      VALUES ('swarm-1', 'a', 0, '{}', 'queued', ${at}, ${at})
    `;
    yield* sql`
      INSERT INTO swarm_note_outbox (swarm_id, seq, kind, members_json, created_at)
      VALUES ('swarm-1', 1, 'followup_result', '[]', ${at})
    `;
    yield* sql`
      INSERT INTO swarm_instance_pauses (provider_instance_id, pause_class, until, at)
      VALUES ('codex', 'usage_limit', ${at}, ${at})
    `;
    const swarm = yield* sql<{
      readonly allow_shared_writers: number;
      readonly budget_exhausted: number;
    }>`SELECT allow_shared_writers, budget_exhausted FROM swarms`;
    assert.deepStrictEqual(swarm, [{ allow_shared_writers: 0, budget_exhausted: 0 }]);
    const member = yield* sql<{
      readonly attempt: number;
      readonly priority: number;
      readonly released: number;
      readonly followup_notified: number;
      readonly superseded_task_id: string | null;
      readonly last_failed_instance_id: string | null;
    }>`
      SELECT attempt, priority, released, followup_notified, superseded_task_id,
        last_failed_instance_id
      FROM swarm_members
    `;
    assert.deepStrictEqual(member, [
      {
        attempt: 1,
        priority: 0,
        released: 0,
        followup_notified: 0,
        superseded_task_id: null,
        last_failed_instance_id: null,
      },
    ]);
    const outbox = yield* sql<{ readonly sent: number }>`SELECT sent FROM swarm_note_outbox`;
    assert.deepStrictEqual(outbox, [{ sent: 0 }]);
    const badStatus = yield* sql`
      INSERT INTO swarm_members
        (swarm_id, member_key, ordinal, spec_json, status, queued_at, updated_at)
      VALUES ('swarm-1', 'b', 1, '{}', 'unknown', ${at}, ${at})
    `.pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(badStatus));
    const badPause = yield* sql`
      INSERT INTO swarm_instance_pauses (provider_instance_id, pause_class, until, at)
      VALUES ('other', 'launch', ${at}, ${at})
    `.pipe(Effect.exit);
    assert.isTrue(Exit.isFailure(badPause));
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
