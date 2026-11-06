import * as Effect from "effect/Effect";
import * as Migrator from "effect/sql/Migrator";
import * as SqlClient from "effect/sql/SqlClient";

import PeerExecReceipts from "./Migrations/074_PeerExecReceipts.ts";

const FIRST_V2_MIGRATION_ID = 55;
const PEER_EXEC_RECEIPTS_ID = 74;
const PEER_EXEC_RECEIPTS_NAME = "PeerExecReceipts";
const RECEIPT_COLUMNS = [
  "exec_id",
  "request_hash",
  "state",
  "result_json",
  "created_at",
  "updated_at",
] as const;
const RECEIPT_INDEX = "peer_exec_receipts_updated_at";
const RECEIPT_INDEX_COLUMNS = ["state", "updated_at"] as const;

const badState = (detail: string) =>
  new Migrator.MigrationError({
    kind: "BadState",
    message: `Cannot add migration ${PEER_EXEC_RECEIPTS_ID}_${PEER_EXEC_RECEIPTS_NAME} to this database: ${detail}. Report this migration history so an upgrade path can be added.`,
  });

const sameList = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
  left.length === right.length && left.every((value, index) => value === right[index]);

// The fleet-free v1.2.0 release shipped without 74 and recorded 75. The migrator skips every id
// up to the highest recorded, so 74 is run and recorded here, once, before the history check.
// Later ids (76+) are above the recorded head and run normally afterwards. `manifest` is this
// build's migration list (passed in: Migrations.ts imports this module).
export const reconcilePeerExecReceiptsMigration = Effect.fn("reconcilePeerExecReceiptsMigration")(
  function* (manifest: ReadonlyArray<readonly [number, string]>) {
    const sql = yield* SqlClient.SqlClient;
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const tables = yield* sql`
        SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
      `;
        if (tables.length === 0) return [];
        const history = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations WHERE migration_id >= ${FIRST_V2_MIGRATION_ID}
      `;
        // Act only when 74 is the one gap the history check would report: every recorded V2 id is
        // one of this build's, and every other V2 id up to the highest recorded is present. Any
        // other history is left to that check, which refuses it without writing.
        const latest = Math.max(0, ...history.map((row) => row.migration_id));
        if (latest <= PEER_EXEC_RECEIPTS_ID) return [];
        const recorded = new Map(history.map((row) => [row.migration_id, row.name]));
        const gaps = manifest.filter(
          ([id, name]) => id >= FIRST_V2_MIGRATION_ID && id <= latest && recorded.get(id) !== name,
        );
        const known = new Map(manifest);
        if (
          history.some((row) => known.get(row.migration_id) !== row.name) ||
          gaps.length !== 1 ||
          gaps[0]![0] !== PEER_EXEC_RECEIPTS_ID ||
          gaps[0]![1] !== PEER_EXEC_RECEIPTS_NAME ||
          recorded.has(PEER_EXEC_RECEIPTS_ID)
        ) {
          return [];
        }

        // A table or index left by another build must match 74 exactly; otherwise refuse.
        const existing = yield* sql<{ readonly type: string; readonly name: string }>`
        SELECT type, name FROM sqlite_master
        WHERE name IN ('peer_exec_receipts', ${RECEIPT_INDEX})
      `;
        const table = existing.find((row) => row.name === "peer_exec_receipts");
        if (table !== undefined) {
          if (table.type !== "table") return yield* badState("peer_exec_receipts is not a table");
          const columns = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_table_info('peer_exec_receipts') ORDER BY cid
        `;
          if (
            !sameList(
              columns.map((column) => column.name),
              RECEIPT_COLUMNS,
            )
          ) {
            return yield* badState("peer_exec_receipts exists with other columns");
          }
        }
        const index = existing.find((row) => row.name === RECEIPT_INDEX);
        if (index !== undefined) {
          const owner = yield* sql<{ readonly tbl_name: string }>`
          SELECT tbl_name FROM sqlite_master WHERE type = 'index' AND name = ${RECEIPT_INDEX}
        `;
          const indexColumns = yield* sql<{ readonly name: string }>`
          SELECT name FROM pragma_index_info(${RECEIPT_INDEX}) ORDER BY seqno
        `;
          if (
            index.type !== "index" ||
            owner[0]?.tbl_name !== "peer_exec_receipts" ||
            !sameList(
              indexColumns.map((column) => column.name),
              RECEIPT_INDEX_COLUMNS,
            )
          ) {
            return yield* badState(`${RECEIPT_INDEX} exists with another definition`);
          }
        }

        yield* PeerExecReceipts;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${PEER_EXEC_RECEIPTS_ID}, ${PEER_EXEC_RECEIPTS_NAME})
      `;
        return [[PEER_EXEC_RECEIPTS_ID, PEER_EXEC_RECEIPTS_NAME]] as const;
      }),
    );
  },
);
