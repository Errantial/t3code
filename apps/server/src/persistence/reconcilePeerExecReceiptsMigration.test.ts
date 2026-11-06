// @effect-diagnostics nodeBuiltinImport:off -- the v1.2.0 fixture is a gzipped SQLite file.
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import { reconcilePeerExecReceiptsMigration } from "./reconcilePeerExecReceiptsMigration.ts";

// A fresh database written by release/v1.2.0-rc (92f12598b7): it records 73 and then 75.
const V120_FIXTURE = `${import.meta.dirname}/fixtures/v1.2.0-rc-92f12598b7.sqlite.gz`;

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const schemaObjects = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<{ readonly type: string; readonly name: string; readonly sql: string | null }>`
    SELECT type, name, sql FROM sqlite_master ORDER BY type, name
  `;
});

/** Runs `use` against a copy of the v1.2.0 fixture in a temporary directory, opened by `open`. */
const withV120DatabaseLayer = <A, E, LE>(
  use: Effect.Effect<A, E, SqlClient.SqlClient>,
  open: (
    filename: string,
  ) => Layer.Layer<SqlClient.SqlClient, LE, FileSystem.FileSystem | Path.Path>,
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: "t3-v120-db-" });
    const filename = path.join(directory, "state.sqlite");
    const gzipped = yield* fs.readFile(V120_FIXTURE);
    yield* fs.writeFile(filename, NodeZlib.gunzipSync(gzipped));
    return yield* use.pipe(
      Effect.provide(open(filename)),
      // The client is closed by now; Windows may still hold the WAL files for a moment.
      Effect.ensuring(Effect.ignore(fs.remove(directory, { recursive: true }))),
    );
  }).pipe(Effect.provide(NodeServices.layer));

const withV120Database = <A, E>(use: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  withV120DatabaseLayer(use, (filename) => NodeSqliteClient.layer({ filename }));

const memory = NodeSqliteClient.layer({ filename: ":memory:" });

describe("reconcilePeerExecReceiptsMigration (F1)", () => {
  it.effect("upgrades a v1.2.0 database: 74 is added, then 76-78 run normally", () =>
    withV120Database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const before = yield* history;
        assert.isTrue(before.some(([id]) => id === 75));
        assert.isFalse(before.some(([id]) => id === 74));
        const objectsBefore = yield* schemaObjects;

        assert.deepStrictEqual(yield* runMigrations(), [
          [74, "PeerExecReceipts"],
          [76, "SwarmRecords"],
          [77, "SwarmVerifyProcess"],
          [78, "SwarmNotices"],
        ]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        // Only 74's and 76-78's objects were added; everything from v1.2.0 is as it was.
        const added = (yield* schemaObjects).filter(
          (object) => !objectsBefore.some((old) => old.name === object.name),
        );
        assert.includeMembers(
          added.map((object) => object.name),
          ["peer_exec_receipts", "peer_exec_receipts_updated_at", "swarms", "swarm_members"],
        );
        assert.isTrue(
          added.every(
            (object) =>
              object.name.startsWith("peer_exec_receipts") ||
              object.name.startsWith("swarm") ||
              object.name.startsWith("sqlite_autoindex_peer_exec") ||
              object.name.startsWith("sqlite_autoindex_swarm") ||
              object.name.startsWith("idx_swarm"),
          ),
          JSON.stringify(added.map((object) => object.name)),
        );
        assert.deepStrictEqual(
          (yield* schemaObjects).filter((object) =>
            objectsBefore.some((old) => old.name === object.name),
          ),
          objectsBefore,
        );
        yield* sql`
          INSERT INTO peer_exec_receipts (exec_id, request_hash, state, created_at, updated_at)
          VALUES ('exec-1', 'hash', 'finished', '2026-11-05', '2026-11-05')
        `;
        // The next start finds nothing to do.
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
    ),
  );

  it.effect("starts the server's database layer on a v1.2.0 database", () =>
    withV120DatabaseLayer(
      Effect.gen(function* () {
        // The layer ran the migrations, as a server start does.
        assert.deepStrictEqual(yield* history, migrationManifest);
      }),
      (filename) => SqlitePersistence.layerFromPath(filename),
    ),
  );

  it.effect("is a no-op on a fresh database and on one that already has 74", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(yield* reconcilePeerExecReceiptsMigration(migrationManifest), []);
      const executed = yield* runMigrations();
      assert.deepStrictEqual(executed, migrationManifest);
      const objects = yield* schemaObjects;
      assert.deepStrictEqual(yield* reconcilePeerExecReceiptsMigration(migrationManifest), []);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.deepStrictEqual(yield* schemaObjects, objects);
    }).pipe(Effect.provide(memory)),
  );

  it.effect("records 74 once: a second run is a no-op", () =>
    withV120Database(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* reconcilePeerExecReceiptsMigration(migrationManifest), [
          [74, "PeerExecReceipts"],
        ]);
        const objects = yield* schemaObjects;
        const recorded = yield* history;
        assert.deepStrictEqual(yield* reconcilePeerExecReceiptsMigration(migrationManifest), []);
        assert.deepStrictEqual(yield* history, recorded);
        assert.deepStrictEqual(yield* schemaObjects, objects);
      }),
    ),
  );

  it.effect("accepts a receipts table that already matches 74, and only records it", () =>
    withV120Database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`
          CREATE TABLE peer_exec_receipts (
            exec_id TEXT PRIMARY KEY NOT NULL,
            request_hash TEXT NOT NULL,
            state TEXT NOT NULL CHECK (state IN ('running', 'finished', 'failed', 'unknown')),
            result_json TEXT,
            created_at TEXT NOT NULL,
            updated_at TEXT NOT NULL
          ) STRICT
        `;
        assert.deepStrictEqual(yield* reconcilePeerExecReceiptsMigration(migrationManifest), [
          [74, "PeerExecReceipts"],
        ]);
        const index = yield* sql`
          SELECT name FROM sqlite_master WHERE name = 'peer_exec_receipts_updated_at'
        `;
        assert.equal(index.length, 1);
      }),
    ),
  );

  it.effect.each([
    ["another gap (73 missing too)", "DELETE FROM effect_sql_migrations WHERE migration_id = 73"],
    [
      "an id this build does not know",
      "INSERT INTO effect_sql_migrations (migration_id, name) VALUES (99, 'FutureMigration')",
    ],
  ] as const)("leaves %s to the history check, writing nothing", ([, setup]) =>
    withV120Database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql.unsafe(setup);
        const recorded = yield* history;
        const objects = yield* schemaObjects;
        assert.deepStrictEqual(yield* reconcilePeerExecReceiptsMigration(migrationManifest), []);
        const exit = yield* Effect.exit(runMigrations());
        // The history check refuses, naming 74 (and 73 when it is missing as well).
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(exit), "74_PeerExecReceipts (recorded: nothing)");
        if (setup.startsWith("DELETE")) {
          assert.include(String(exit), "73_ChatGptBrowserProviderOperations (recorded: nothing)");
        }
        assert.deepStrictEqual(yield* history, recorded);
        assert.deepStrictEqual(yield* schemaObjects, objects);
      }),
    ),
  );

  it.effect.each([
    [
      "a receipts table with other columns",
      "CREATE TABLE peer_exec_receipts (exec_id TEXT PRIMARY KEY NOT NULL, payload TEXT)",
      "peer_exec_receipts exists with other columns",
    ],
    [
      "a receipts index with another definition",
      "CREATE TABLE other_table (state TEXT); CREATE INDEX peer_exec_receipts_updated_at ON other_table (state)",
      "peer_exec_receipts_updated_at exists with another definition",
    ],
    [
      "a view named like the receipts table",
      "CREATE VIEW peer_exec_receipts AS SELECT 1 AS exec_id",
      "peer_exec_receipts is not a table",
    ],
  ] as const)("refuses %s, and writes nothing", ([, setup, reason]) =>
    withV120Database(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        for (const statement of setup.split("; ")) yield* sql.unsafe(statement);
        const recorded = yield* history;
        const objects = yield* schemaObjects;
        const exit = yield* Effect.exit(runMigrations());
        assert.isTrue(Exit.isFailure(exit));
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), reason);
        assert.include(String(Exit.isFailure(exit) ? exit.cause : ""), "74_PeerExecReceipts");
        assert.deepStrictEqual(yield* history, recorded);
        assert.deepStrictEqual(yield* schemaObjects, objects);
      }),
    ),
  );
});
