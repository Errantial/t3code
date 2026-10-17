import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

it.effect("widens context suppression reasons without losing rows or reference sync", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 70 });
    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
        provider_instance_id, provider_driver, outcome, suppression_reason, diagnostics_mode,
        packet_text_state, created_at, updated_at
      ) VALUES (
        'inspection:legacy', 'project:one', 'thread:one', 'run:one', 'attempt:one', 1,
        'claude-main', 'claudeAgent', 'skipped', 'claude_provider_continuation', 'normal',
        'skipped_no_packet', '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
      )
    `;

    yield* runMigrations({ toMigrationInclusive: 71 });
    const preserved = (yield* sql<{ readonly suppression_reason: string }>`
      SELECT suppression_reason FROM civilization_context_inspections
      WHERE inspection_id = 'inspection:legacy'
    `)[0]!;
    assert.equal(preserved.suppression_reason, "claude_provider_continuation");

    for (const [id, reason] of [
      ["continuation", "provider_continuation"],
      ["command", "provider_command"],
    ] as const) {
      yield* sql`
        INSERT INTO civilization_context_inspections (
          inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
          provider_instance_id, provider_driver, outcome, suppression_reason, diagnostics_mode,
          packet_text_state, created_at, updated_at
        ) VALUES (
          ${`inspection:${id}`}, 'project:one', 'thread:one', ${`run:${id}`}, ${`attempt:${id}`}, 1,
          'opencode-main', 'opencode', 'skipped', ${reason}, 'normal', 'skipped_no_packet',
          '2026-10-16T00:00:01.000Z', '2026-10-16T00:00:01.000Z'
        )
      `;
    }

    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, context_reference_id, project_id, thread_id, run_id, attempt_id,
        provider_turn_ordinal, provider_instance_id, provider_driver, outcome, diagnostics_mode,
        packet_text_state, packet_hash, packet_bytes, environment_revision, project_revision,
        citizen_revision, census_revision, notes_revision, inbox_revision, created_at, updated_at
      ) VALUES (
        'inspection:sync71', 'reference:sync71', 'project:one', 'thread:one', 'run:sync71',
        'attempt:sync71', 1, 'opencode-main', 'opencode', 'built', 'normal', 'retained_normal',
        'sha256:sync71', 7, 1, 1, 1, 1, 1, 1,
        '2026-10-16T00:00:02.000Z', '2026-10-16T00:00:02.000Z'
      )
    `;
    assert.equal(
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_context_references
        WHERE context_reference_id = 'reference:sync71'
      `)[0]!.count,
      1,
    );

    yield* sql`
      UPDATE civilization_context_inspections
      SET packet_hash = 'sha256:sync71-updated', packet_bytes = 9
      WHERE inspection_id = 'inspection:sync71'
    `;
    assert.deepStrictEqual(
      (yield* sql<{ readonly packet_hash: string; readonly packet_bytes: number }>`
        SELECT packet_hash, packet_bytes FROM civilization_context_references
        WHERE context_reference_id = 'reference:sync71'
      `)[0],
      { packet_hash: "sha256:sync71-updated", packet_bytes: 9 },
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
