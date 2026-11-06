// @effect-diagnostics nodeBuiltinImport:off -- the v1.2.0 fixture is a gzipped SQLite file.
import * as NodeZlib from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import * as SqlitePersistence from "./Sqlite.ts";

// A fresh database written by release/v1.2.0 (92f12598b7): it records 73 and then 75.
const V120_FIXTURE = `${import.meta.dirname}/fixtures/v1.2.0-92f12598b7.sqlite.gz`;

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

describe("a v1.2.0 database", () => {
  it.effect("upgrades: 76-78 run after 75, and v1.2.0's schema is unchanged", () =>
    withV120DatabaseLayer(
      Effect.gen(function* () {
        const before = yield* history;
        assert.deepStrictEqual(
          before.filter(([id]) => id >= 73).map(([id]) => id),
          [73, 75],
        );
        const objectsBefore = yield* schemaObjects;
        assert.deepStrictEqual(yield* runMigrations(), [
          [76, "SwarmRecords"],
          [77, "SwarmVerifyProcess"],
          [78, "SwarmNotices"],
        ]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        const after = yield* schemaObjects;
        const added = after.filter(
          (object) => !objectsBefore.some((old) => old.name === object.name),
        );
        assert.isTrue(
          added.every(
            (object) =>
              object.name.startsWith("swarm") || object.name.startsWith("sqlite_autoindex_swarm"),
          ),
          JSON.stringify(added.map((object) => object.name)),
        );
        assert.includeMembers(
          added.map((object) => object.name),
          ["swarms", "swarm_members", "swarm_notices"],
        );
        assert.deepStrictEqual(
          after.filter((object) => objectsBefore.some((old) => old.name === object.name)),
          objectsBefore,
        );
        // The next start finds nothing to do.
        assert.deepStrictEqual(yield* runMigrations(), []);
      }),
      (filename) => NodeSqliteClient.layer({ filename }),
    ),
  );

  it.effect("opens through the server's database layer, as a start does", () =>
    withV120DatabaseLayer(
      Effect.gen(function* () {
        assert.deepStrictEqual(yield* history, migrationManifest);
      }),
      (filename) => SqlitePersistence.layerFromPath(filename),
    ),
  );
});
