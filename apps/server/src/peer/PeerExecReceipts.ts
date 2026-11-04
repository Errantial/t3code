// @effect-diagnostics effectFnOpportunity:off
import {
  OrchestratorMcpFailure,
  PEER_EXEC_RECEIPT_MAX_BYTES,
  PEER_EXEC_RECEIPT_MAX_ROWS,
  PEER_EXEC_RECEIPT_RETENTION_MS,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

/** Terminal metadata a receipt keeps. Output tails and file content never reach the table. */
export const PeerExecReceiptMetadata = Schema.Struct({
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  cancelled: Schema.Boolean,
  durationMs: Schema.Number,
  stdoutBytes: Schema.Number,
  stderrBytes: Schema.Number,
  truncated: Schema.Boolean,
  cwd: Schema.String,
  platform: Schema.String,
});
export type PeerExecReceiptMetadata = typeof PeerExecReceiptMetadata.Type;

const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(PeerExecReceiptMetadata));

interface ReceiptRow {
  readonly exec_id: string;
  readonly request_hash: string;
  readonly state: string;
  readonly result_json: string | null;
  readonly created_at: string;
  readonly updated_at: string;
}

export const receiptMetadataOf = (result: {
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
  readonly cwd: string;
  readonly platform: string;
}): PeerExecReceiptMetadata => ({
  exitCode: result.exitCode,
  signal: result.signal,
  timedOut: result.timedOut,
  cancelled: result.cancelled,
  durationMs: result.durationMs,
  stdoutBytes: result.stdoutBytes,
  stderrBytes: result.stderrBytes,
  truncated: result.truncated,
  cwd: result.cwd,
  platform: result.platform,
});

const decodeReceiptMetadata = (row: ReceiptRow): PeerExecReceiptMetadata | undefined =>
  row.result_json === null ? undefined : Option.getOrUndefined(decodeMetadata(row.result_json));

export type BeginReceiptResult =
  | { readonly kind: "new" }
  | { readonly kind: "replay"; readonly metadata: PeerExecReceiptMetadata }
  | { readonly kind: "running" }
  | { readonly kind: "conflict" }
  | { readonly kind: "unknown" };

const failure = (code: "exec_receipt_capacity", message: string) =>
  new OrchestratorMcpFailure({ code, message });

const storageFailure = () =>
  new OrchestratorMcpFailure({
    code: "orchestration_error",
    message: "The execution receipt store here failed. The server log has details.",
  });

/**
 * Durable idempotency receipts for `peer_exec`. A caller-chosen `execId` maps
 * to one request hash and one terminal result, so a lost reply can be retried
 * without spawning twice. The table keeps no command text, env values, output,
 * or file content.
 */
export class PeerExecReceipts extends Context.Service<
  PeerExecReceipts,
  {
    readonly begin: (input: {
      readonly execId: string;
      readonly requestHash: string;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<BeginReceiptResult, OrchestratorMcpFailure>;
    readonly finish: (input: {
      readonly execId: string;
      readonly metadata: PeerExecReceiptMetadata;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<void, OrchestratorMcpFailure>;
    readonly markUnknown: (input: {
      readonly execId: string;
      readonly now: DateTime.Utc;
    }) => Effect.Effect<boolean, OrchestratorMcpFailure>;
    /** Startup: an exec left running by a stopped process is never rerun. */
    readonly markAllRunningUnknown: (input: {
      readonly now: DateTime.Utc;
    }) => Effect.Effect<number, OrchestratorMcpFailure>;
    /** Deletes completed receipts past the retention window. Returns rows removed. */
    readonly sweep: (input: {
      readonly now: DateTime.Utc;
    }) => Effect.Effect<number, OrchestratorMcpFailure>;
    readonly capacityReached: Effect.Effect<boolean, OrchestratorMcpFailure>;
    readonly stateOf: (
      execId: string,
    ) => Effect.Effect<"running" | "finished" | "unknown", OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerExecReceipts") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const read = (execId: string) =>
    sql<ReceiptRow>`
      SELECT exec_id, request_hash, state, result_json, created_at, updated_at
      FROM peer_exec_receipts WHERE exec_id = ${execId}
    `.pipe(
      Effect.map((rows) => rows[0]),
      Effect.mapError(storageFailure),
    );

  const begin: PeerExecReceipts["Service"]["begin"] = Effect.fn("PeerExecReceipts.begin")(
    function* (input) {
      if (yield* capacityReached) {
        return yield* failure(
          "exec_receipt_capacity",
          "This machine holds too many execution receipts to start another run. Retry after the retention sweep, or use a machine that is not full.",
        );
      }
      const createdAt = DateTime.formatIso(input.now);
      const inserted = yield* sql<{ readonly exec_id: string }>`
        INSERT INTO peer_exec_receipts
          (exec_id, request_hash, state, result_json, created_at, updated_at)
        VALUES (${input.execId}, ${input.requestHash}, 'running', NULL, ${createdAt}, ${createdAt})
        ON CONFLICT (exec_id) DO NOTHING
        RETURNING exec_id
      `.pipe(Effect.mapError(storageFailure));
      if (inserted.length > 0) return { kind: "new" } as const;
      const row = yield* read(input.execId);
      if (row === undefined) return { kind: "unknown" } as const;
      if (row.request_hash !== input.requestHash) return { kind: "conflict" } as const;
      if (row.state === "running") return { kind: "running" } as const;
      const metadata = decodeReceiptMetadata(row);
      if (row.state !== "finished" || metadata === undefined) return { kind: "unknown" } as const;
      return { kind: "replay", metadata } as const;
    },
  );

  const finish: PeerExecReceipts["Service"]["finish"] = (input) =>
    sql`
      UPDATE peer_exec_receipts
      SET state = 'finished', result_json = ${JSON.stringify(input.metadata)},
          updated_at = ${DateTime.formatIso(input.now)}
      WHERE exec_id = ${input.execId} AND state = 'running'
    `.pipe(Effect.asVoid, Effect.mapError(storageFailure));

  const markUnknown: PeerExecReceipts["Service"]["markUnknown"] = (input) =>
    sql<{ readonly exec_id: string }>`
      UPDATE peer_exec_receipts
      SET state = 'unknown', updated_at = ${DateTime.formatIso(input.now)}
      WHERE exec_id = ${input.execId} AND state = 'running'
      RETURNING exec_id
    `.pipe(
      Effect.map((rows) => rows.length > 0),
      Effect.mapError(storageFailure),
    );

  const markAllRunningUnknown: PeerExecReceipts["Service"]["markAllRunningUnknown"] = (input) =>
    sql<{ readonly exec_id: string }>`
      UPDATE peer_exec_receipts
      SET state = 'unknown', updated_at = ${DateTime.formatIso(input.now)}
      WHERE state = 'running'
      RETURNING exec_id
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(storageFailure),
    );

  const sweep: PeerExecReceipts["Service"]["sweep"] = (input) => {
    const cutoff = DateTime.formatIso(
      DateTime.subtract(input.now, { milliseconds: PEER_EXEC_RECEIPT_RETENTION_MS }),
    );
    return sql<{ readonly exec_id: string }>`
      DELETE FROM peer_exec_receipts
      WHERE state <> 'running' AND updated_at < ${cutoff}
      RETURNING exec_id
    `.pipe(
      Effect.map((rows) => rows.length),
      Effect.mapError(storageFailure),
    );
  };

  const capacityReached = Effect.gen(function* () {
    const rows = yield* sql<{ readonly rows: number; readonly bytes: number | null }>`
      SELECT COUNT(*) AS rows, SUM(LENGTH(result_json)) AS bytes FROM peer_exec_receipts
    `.pipe(Effect.mapError(storageFailure));
    const row = rows[0];
    const bytes = Number(row?.bytes ?? 0);
    return (
      Number(row?.rows ?? 0) >= PEER_EXEC_RECEIPT_MAX_ROWS || bytes >= PEER_EXEC_RECEIPT_MAX_BYTES
    );
  });

  const stateOf: PeerExecReceipts["Service"]["stateOf"] = (execId) =>
    read(execId).pipe(
      Effect.map((row) =>
        row === undefined
          ? ("unknown" as const)
          : row.state === "finished"
            ? ("finished" as const)
            : row.state === "running"
              ? ("running" as const)
              : ("unknown" as const),
      ),
    );

  return PeerExecReceipts.of({
    begin,
    finish,
    markUnknown,
    markAllRunningUnknown,
    sweep,
    capacityReached,
    stateOf,
  });
});

export const layer = Layer.effect(PeerExecReceipts, make);
