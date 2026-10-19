// @effect-diagnostics nodeBuiltinImport:off -- Acceptance samples process RSS for repeated bounded analytics reads.
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as MailService from "./MailService.ts";
import * as ProjectBriefService from "./ProjectBriefService.ts";

const PROJECT_ID = ProjectId.make("project:context-analytics:performance");
const PROVIDER_ID = ProviderInstanceId.make("codex-main");
const THREAD_ID = ThreadId.make("thread:analytics:0000");
const INSPECTION_COUNT = 100_000;
const SAMPLES = 30;
const P95_BUDGET_MS = 50;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RSS_PLATEAU_GROWTH = 64 * 1024 * 1024;
const NOW = "2026-10-18T12:00:00.000Z";
const FROM = "2026-09-18T12:00:00.000Z";

const percentile = (values: ReadonlyArray<number>, fraction: number): number => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
};

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const value = yield* effect;
    return { value, elapsedMs: performance.now() - started } as const;
  });

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const config = ConfigService.layer.pipe(Layer.provide(database));
const adapters = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: () => Effect.die("context analytics must not request provider adapters"),
    list: () => Effect.die("context analytics must not enumerate provider adapters"),
  }),
);
const mail = MailService.layer.pipe(Layer.provide(Layer.mergeAll(database, adapters)));
const projectBrief = ProjectBriefService.layer.pipe(Layer.provide(database));
const context = ContextService.layer.pipe(
  Layer.provide(Layer.mergeAll(database, config, adapters, mail, projectBrief)),
);
const testLayer = Layer.mergeAll(database, config, adapters, mail, projectBrief, context);

it.effect(
  "keeps max-range 100k context analytics bounded under the v1.1 read budget",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* ContextService.CivilizationContextService;
      const configService = yield* ConfigService.CivilizationConfigService;
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT_ID}, 'Context analytics performance', '/tmp/context-analytics-performance', '[]',
          ${FROM}, ${FROM}, NULL
        )
      `;
      yield* configService.set({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          operations: { diagnosticRetentionDays: 30 },
        },
      });

      yield* sql`
        WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
        numbers(n) AS (
          SELECT a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n
          FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
        )
        INSERT INTO civilization_context_inspections (
          inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
          provider_instance_id, provider_driver, outcome, suppression_reason,
          diagnostics_mode, packet_text_state, packet_bytes, packet_budget_bytes,
          roster_candidates, roster_included, note_candidates, note_included,
          inbox_candidates, inbox_included, created_at, updated_at
        )
        SELECT
          printf('inspection:analytics:perf:%06d', n),
          ${PROJECT_ID},
          printf('thread:analytics:%04d', n % 100),
          printf('run:analytics:perf:%06d', n),
          printf('attempt:analytics:perf:%06d', n),
          0,
          CASE WHEN n % 4 = 0 THEN 'codex-main' ELSE 'claude-main' END,
          CASE WHEN n % 4 = 0 THEN 'codex' ELSE 'claudeAgent' END,
          CASE
            WHEN n % 8 = 0 THEN 'skipped'
            WHEN n % 8 = 1 THEN 'provider_start_failed'
            WHEN n % 8 = 2 THEN 'provider_start_accepted'
            ELSE 'built'
          END,
          CASE WHEN n % 8 = 0 THEN 'provider_unsupported' ELSE NULL END,
          'normal',
          CASE WHEN n % 8 = 0 THEN 'skipped_no_packet' ELSE 'retained_normal' END,
          CASE WHEN n % 8 = 0 THEN 0 ELSE 256 + (n % 12) * 1000 END,
          16384,
          12, 8, 6, 4, 5, 3,
          strftime('%Y-%m-%dT%H:%M:%fZ', ${FROM}, '+' || ((n * 720) / ${INSPECTION_COUNT}) || ' hours'),
          strftime('%Y-%m-%dT%H:%M:%fZ', ${FROM}, '+' || ((n * 720) / ${INSPECTION_COUNT}) || ' hours')
        FROM numbers
        WHERE n < ${INSPECTION_COUNT}
      `;
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_context_inspections WHERE project_id = ${PROJECT_ID}
        `)[0]?.count,
        INSPECTION_COUNT,
      );

      assert.isBelow(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count
          FROM civilization_context_analytics_hourly
          WHERE project_id = ${PROJECT_ID}
        `)[0]?.count ?? INSPECTION_COUNT,
        5_000,
        "the persisted acceleration must stay coarse relative to retained inspection history",
      );

      const projectPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT substr(bucket_start, 1, 10), SUM(inspection_count)
        FROM civilization_context_analytics_hourly
        WHERE project_id = ${PROJECT_ID}
          AND bucket_start >= ${FROM}
          AND bucket_start < ${NOW}
        GROUP BY substr(bucket_start, 1, 10)
      `;
      assert.include(
        projectPlan.map((row) => row.detail).join("\n"),
        "civilization_context_analytics_hourly",
      );
      const filteredPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT substr(created_at, 1, 10), COUNT(*)
        FROM civilization_context_inspections
        WHERE project_id = ${PROJECT_ID}
          AND created_at >= ${FROM}
          AND created_at < ${NOW}
          AND thread_id = ${THREAD_ID}
          AND provider_instance_id = ${PROVIDER_ID}
          AND outcome = 'skipped'
          AND suppression_reason = 'provider_unsupported'
        GROUP BY substr(created_at, 1, 10)
      `;
      assert.include(
        filteredPlan.map((row) => row.detail).join("\n"),
        "civilization_context_inspections_thread_recent_idx",
      );

      for (let index = 0; index < 3; index += 1) {
        yield* service.analytics({
          projectId: PROJECT_ID,
          bucketSize: "day",
          from: FROM,
          to: NOW,
        });
        yield* service.analytics({
          projectId: PROJECT_ID,
          bucketSize: "day",
          from: FROM,
          to: NOW,
          providerInstanceId: PROVIDER_ID,
          threadId: THREAD_ID,
          outcome: "skipped",
          suppressionReason: "provider_unsupported",
        });
      }

      const maxRangeSamples: number[] = [];
      const filteredSamples: number[] = [];
      const rssSamples: number[] = [];
      let maxResponseBytes = 0;
      for (let index = 0; index < SAMPLES; index += 1) {
        const maxRange = yield* timed(
          service.analytics({
            projectId: PROJECT_ID,
            bucketSize: "day",
            from: FROM,
            to: NOW,
          }),
        );
        maxRangeSamples.push(maxRange.elapsedMs);
        maxResponseBytes = Math.max(
          maxResponseBytes,
          Buffer.byteLength(JSON.stringify(maxRange.value), "utf8"),
        );
        assert.equal(maxRange.value.buckets.length, 31);

        const filtered = yield* timed(
          service.analytics({
            projectId: PROJECT_ID,
            bucketSize: "day",
            from: FROM,
            to: NOW,
            providerInstanceId: PROVIDER_ID,
            threadId: THREAD_ID,
            outcome: "skipped",
            suppressionReason: "provider_unsupported",
          }),
        );
        filteredSamples.push(filtered.elapsedMs);
        maxResponseBytes = Math.max(
          maxResponseBytes,
          Buffer.byteLength(JSON.stringify(filtered.value), "utf8"),
        );
        assert.equal(
          filtered.value.buckets.reduce((sum, bucket) => sum + bucket.totalInspections, 0),
          499,
        );
        if ((index + 1) % 5 === 0) rssSamples.push(process.memoryUsage().rss);
      }

      const maxRangeP95 = percentile(maxRangeSamples, 0.95);
      const filteredP95 = percentile(filteredSamples, 0.95);
      assert.isAtMost(
        maxResponseBytes,
        MAX_RESPONSE_BYTES,
        `Context analytics response was ${maxResponseBytes} bytes`,
      );
      assert.isAtMost(
        maxRangeP95,
        P95_BUDGET_MS,
        `Context analytics max-range p95 ${maxRangeP95}ms`,
      );
      assert.isAtMost(
        filteredP95,
        P95_BUDGET_MS,
        `Context analytics filtered p95 ${filteredP95}ms`,
      );

      const plateauStart =
        rssSamples[Math.floor(rssSamples.length / 2)] ?? process.memoryUsage().rss;
      const plateauEnd = rssSamples.at(-1) ?? plateauStart;
      assert.isAtMost(plateauEnd - plateauStart, MAX_RSS_PLATEAU_GROWTH);
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
        `)[0]?.count,
        0,
        "Context analytics reads must not enqueue orchestration effects.",
      );
    }).pipe(Effect.provide(testLayer)),
  { timeout: 120_000 },
);
