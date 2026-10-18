// @effect-diagnostics nodeBuiltinImport:off -- Acceptance uses process RSS to prove repeated bounded Chronicle paging reaches a memory plateau.
import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import { CivilizationChronicleService, layer } from "./ChronicleService.ts";

const PROJECT_ID = ProjectId.make("project:chronicle:performance");
const TARGET_THREAD_ID = ThreadId.make("thread:chronicle:00007");
const ENTRY_COUNT = 100_000;
const PAGE_SIZE = 50;
const SAMPLES = 80;
const P95_BUDGET_MS = 100;
const MAX_RESPONSE_BYTES = 64 * 1024;
const MAX_RSS_PLATEAU_GROWTH = 64 * 1024 * 1024;

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
const chronicleLayer = layer.pipe(Layer.provide(database));
const testLayer = Layer.mergeAll(database, chronicleLayer);

it.effect(
  "keeps 100k-entry Chronicle first-page and filtered reads bounded under the v1.1 budget",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const chronicle = yield* CivilizationChronicleService;
      yield* runMigrations();

      yield* sql`
        WITH digits(n) AS (
          VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)
        ), numbers(n) AS (
          SELECT a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n
          FROM digits a
          CROSS JOIN digits b
          CROSS JOIN digits c
          CROSS JOIN digits d
          CROSS JOIN digits e
        )
        INSERT INTO civilization_chronicle_entries (
          entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
          citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
          provenance_key, occurred_at, metadata_json
        )
        SELECT
          printf('chronicle:perf:%06d', n),
          ${PROJECT_ID},
          CASE WHEN n % 10 = 0 THEN 'child_joined' ELSE 'citizen_joined' END,
          printf('thread:chronicle:%05d', n % 1000),
          CASE WHEN n % 10 = 0 THEN printf('thread:chronicle:%05d', (n + 7) % 1000) ELSE NULL END,
          0,
          1,
          'host_event',
          printf('event:chronicle:perf:%06d', n),
          n,
          printf('host_event%cperf:%06d%ccitizen_joined%c%c', 31, n, 31, 31, 31),
          strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01T00:00:00Z', '+' || n || ' seconds'),
          CASE WHEN n % 10 = 0 THEN '{"relationship":"fork"}' ELSE '{}' END
        FROM numbers
        WHERE n < ${ENTRY_COUNT}
      `;

      const count = (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_chronicle_entries WHERE project_id = ${PROJECT_ID}
      `)[0]?.count;
      assert.equal(count, ENTRY_COUNT);

      const projectPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT entry_id FROM civilization_chronicle_entries
        WHERE project_id = ${PROJECT_ID}
          AND kind = 'child_joined'
          AND occurred_at >= '0000-01-01T00:00:00.000Z'
          AND (occurred_at, entry_id) < ('9999-12-31T23:59:59.999Z', char(0xffff))
        ORDER BY occurred_at DESC, entry_id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(
        projectPlan.map((row) => row.detail).join("\n"),
        "civilization_chronicle_kind_recent_idx",
      );
      const threadPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT entry_id FROM civilization_chronicle_entries
        WHERE project_id = ${PROJECT_ID}
          AND primary_thread_id = ${TARGET_THREAD_ID}
          AND kind = 'child_joined'
          AND occurred_at >= '0000-01-01T00:00:00.000Z'
          AND (occurred_at, entry_id) < ('9999-12-31T23:59:59.999Z', char(0xffff))
        ORDER BY occurred_at DESC, entry_id DESC
        LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(
        threadPlan.map((row) => row.detail).join("\n"),
        "civilization_chronicle_thread_kind_recent_idx",
      );

      for (let index = 0; index < 5; index += 1) {
        yield* chronicle.list({ projectId: PROJECT_ID, limit: PAGE_SIZE });
        yield* chronicle.list({
          projectId: PROJECT_ID,
          kind: "child_joined",
          threadId: TARGET_THREAD_ID,
          limit: PAGE_SIZE,
        });
      }

      const firstPageSamples: Array<number> = [];
      const filteredSamples: Array<number> = [];
      const rssSamples: Array<number> = [];
      let firstPageBytes = 0;
      let filteredPageBytes = 0;
      for (let index = 0; index < SAMPLES; index += 1) {
        const firstPage = yield* timed(chronicle.list({ projectId: PROJECT_ID, limit: PAGE_SIZE }));
        firstPageSamples.push(firstPage.elapsedMs);
        firstPageBytes = Buffer.byteLength(JSON.stringify(firstPage.value), "utf8");

        const filtered = yield* timed(
          chronicle.list({
            projectId: PROJECT_ID,
            kind: "child_joined",
            threadId: TARGET_THREAD_ID,
            limit: PAGE_SIZE,
          }),
        );
        filteredSamples.push(filtered.elapsedMs);
        filteredPageBytes = Buffer.byteLength(JSON.stringify(filtered.value), "utf8");
        if ((index + 1) % 10 === 0) rssSamples.push(process.memoryUsage().rss);
      }

      const firstPageP95 = percentile(firstPageSamples, 0.95);
      const filteredP95 = percentile(filteredSamples, 0.95);
      assert.isAtMost(firstPageP95, P95_BUDGET_MS, `Chronicle first-page p95 ${firstPageP95}ms`);
      assert.isAtMost(filteredP95, P95_BUDGET_MS, `Chronicle filtered p95 ${filteredP95}ms`);
      assert.isAtMost(firstPageBytes, MAX_RESPONSE_BYTES);
      assert.isAtMost(filteredPageBytes, MAX_RESPONSE_BYTES);

      const plateauStart =
        rssSamples[Math.floor(rssSamples.length / 2)] ?? process.memoryUsage().rss;
      const plateauEnd = rssSamples.at(-1) ?? plateauStart;
      assert.isAtMost(
        plateauEnd - plateauStart,
        MAX_RSS_PLATEAU_GROWTH,
        "Repeated bounded Chronicle reads must not show unbounded RSS growth.",
      );

      const outboxRows = (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
      `)[0]?.count;
      assert.equal(outboxRows, 0, "Chronicle reads must not enqueue orchestration effects.");
    }).pipe(Effect.provide(testLayer)),
  { timeout: 120_000 },
);
