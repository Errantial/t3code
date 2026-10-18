import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

type RollupRow = {
  readonly bucket_start: string;
  readonly outcome: string;
  readonly suppression_reason: string;
  readonly inspection_count: number;
  readonly packet_low: number;
  readonly packet_medium: number;
  readonly utilization_low: number;
  readonly utilization_medium: number;
  readonly roster_candidates: number;
  readonly roster_included: number;
};

const readRollup = Effect.fn("migration076.readRollup")(function* () {
  const sql = yield* SqlClient.SqlClient;
  return yield* sql<RollupRow>`
    SELECT
      bucket_start, outcome, suppression_reason, inspection_count,
      packet_low, packet_medium, utilization_low, utilization_medium,
      roster_candidates, roster_included
    FROM civilization_context_analytics_hourly
    WHERE project_id = 'project:analytics-076'
    ORDER BY bucket_start, outcome, suppression_reason
  `;
});

it.effect("backfills and transactionally maintains bounded context analytics rollups", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 75 });

    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
        provider_instance_id, provider_driver, outcome, suppression_reason,
        diagnostics_mode, packet_text_state,
        packet_bytes, packet_budget_bytes,
        roster_candidates, roster_included,
        note_candidates, note_included,
        inbox_candidates, inbox_included,
        created_at, updated_at
      ) VALUES (
        'inspection:076:pre', 'project:analytics-076', 'thread:076', 'run:076:pre', 'attempt:076:pre', 0,
        'codex-main', 'codex', 'skipped', 'provider_unsupported',
        'off', 'skipped_no_packet',
        512, 2048,
        3, 2,
        2, 1,
        1, 1,
        '2026-10-17T10:15:00.000Z', '2026-10-17T10:15:00.000Z'
      )
    `;

    yield* runMigrations({ toMigrationInclusive: 76 });
    assert.deepEqual(yield* readRollup(), [
      {
        bucket_start: "2026-10-17T10:00:00.000Z",
        outcome: "skipped",
        suppression_reason: "provider_unsupported",
        inspection_count: 1,
        packet_low: 1,
        packet_medium: 0,
        utilization_low: 1,
        utilization_medium: 0,
        roster_candidates: 3,
        roster_included: 2,
      },
    ]);

    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
        provider_instance_id, provider_driver, outcome, suppression_reason,
        diagnostics_mode, packet_text_state,
        packet_bytes, packet_budget_bytes,
        roster_candidates, roster_included,
        note_candidates, note_included,
        inbox_candidates, inbox_included,
        created_at, updated_at
      ) VALUES (
        'inspection:076:post', 'project:analytics-076', 'thread:076', 'run:076:post', 'attempt:076:post', 1,
        'codex-main', 'codex', 'built', NULL,
        'normal', 'pending_provider_start',
        2048, 4096,
        4, 3,
        3, 2,
        2, 1,
        '2026-10-17T10:45:00.000Z', '2026-10-17T10:45:00.000Z'
      )
    `;
    assert.equal((yield* readRollup()).length, 2);

    yield* sql`
      UPDATE civilization_context_inspections
      SET outcome = 'provider_start_accepted',
          packet_bytes = 3072,
          updated_at = '2026-10-17T10:46:00.000Z'
      WHERE inspection_id = 'inspection:076:post'
    `;
    const afterUpdate = yield* readRollup();
    assert.equal(afterUpdate.length, 2);
    const updated = afterUpdate.find((row) => row.outcome === "provider_start_accepted");
    assert.isDefined(updated);
    assert.equal(updated.packet_medium, 1);
    assert.equal(updated.utilization_medium, 1);

    yield* sql`DELETE FROM civilization_context_inspections WHERE inspection_id = 'inspection:076:pre'`;
    assert.deepEqual(yield* readRollup(), [updated]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
