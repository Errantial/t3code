import { assert, it } from "@effect/vitest";
import { CIVILIZATION_CONFIG_VERSION, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";

const PROJECT_ID = ProjectId.make("project:civilization:search-performance");
const CITIZEN_COUNT = 10_000;
const SAMPLE_COUNT = 30;
const P95_BUDGET_MS = 50;

const database = SqlitePersistence.layerMemory;
const config = ConfigService.layer.pipe(Layer.provide(database));
const knowledge = KnowledgeService.layer.pipe(Layer.provide(database));
const layer = Layer.mergeAll(database, config, knowledge);

const percentile = (values: ReadonlyArray<number>, fraction: number) => {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))] ?? 0;
};

it.effect(
  "keeps 10k citizen search bounded on stats-free SQLite",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const configService = yield* ConfigService.CivilizationConfigService;
      const service = yield* KnowledgeService.CivilizationKnowledgeService;

      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT_ID}, 'Citizen search performance', '/tmp/citizen-search-performance', '[]',
          '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z', NULL
        )
      `;
      yield* configService.set({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true, showObservedAgents: false },
        },
      });

      yield* sql`
        WITH RECURSIVE n(i) AS (
          VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${CITIZEN_COUNT}
        )
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, provider_instance_id,
          runtime_mode, interaction_mode, active_provider_thread_id,
          created_at, updated_at, archived_at, deleted_at, payload_json
        )
        SELECT printf('thread:search:%05d', i), ${PROJECT_ID}, printf('Host %05d', i),
          'codex', 'codex-main', 'full-access', 'default', NULL,
          '2026-10-18T00:00:00.000Z', printf('2026-10-18T00:%02d:00.000Z', i % 60),
          NULL, NULL, '{}'
        FROM n
      `;
      yield* sql`
        WITH RECURSIVE n(i) AS (
          VALUES(1) UNION ALL SELECT i + 1 FROM n WHERE i < ${CITIZEN_COUNT}
        )
        INSERT INTO civilization_citizens (
          thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
          generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
          name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
          name_environment_revision, name_project_revision,
          profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
          profile_environment_revision, profile_project_revision,
          title_managed, preserved_title, last_managed_title, title_topic,
          pending_title_command_id, pending_managed_title, pending_title_topic,
          epoch, closed, deleted, revision, created_at, updated_at
        )
        SELECT printf('thread:search:%05d', i), ${PROJECT_ID}, NULL, NULL,
          printf('thread:search:%05d', i), 0, 'resolved', 0, i, i,
          printf('name:search:%05d', i), 1, printf('Citizen %05d', i),
          printf('Citizen %05d', i), printf('citizen %05d', i), 'default-names', 1, 1,
          'calm', 'Calm', '[]', '', 'default-profiles', 1, 1,
          0, printf('Host %05d', i), NULL, printf('Host %05d', i),
          NULL, NULL, NULL, 0, 0, 0, 1,
          '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z'
        FROM n
      `;

      const stats = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'
      `;
      assert.lengthOf(stats, 0, "fixture must remain stats-free; do not ANALYZE before EXPLAIN");

      const namePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT c.thread_id
        FROM civilization_citizens AS c
        INNER JOIN orchestration_v2_projection_threads AS t
          ON t.thread_id = c.thread_id AND t.project_id = c.project_id
        WHERE c.project_id = ${PROJECT_ID}
          AND c.deleted = 0
          AND t.deleted_at IS NULL
          AND c.observed_only = 0
          AND c.name_key >= 'citizen 099'
          AND c.name_key < 'citizen 09:'
        ORDER BY c.name_key ASC, c.thread_id ASC
        LIMIT 20
      `;
      const namePlanText = namePlan.map((row) => row.detail).join("\n");
      assert.include(namePlanText, "civilization_citizens");
      assert.notInclude(namePlanText, "SCAN c");

      const titlePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT c.thread_id
        FROM orchestration_v2_projection_threads AS t
        INNER JOIN civilization_citizens AS c
          ON c.thread_id = t.thread_id AND c.project_id = t.project_id
        WHERE t.project_id = ${PROJECT_ID}
          AND t.deleted_at IS NULL
          AND c.deleted = 0
          AND c.observed_only = 0
          AND t.title COLLATE NOCASE LIKE 'Host 099%' ESCAPE '!'
        ORDER BY t.updated_at DESC, t.thread_id ASC
        LIMIT 20
      `;
      const titlePlanText = titlePlan.map((row) => row.detail).join("\n");
      assert.include(titlePlanText, "orchestration_v2_projection_threads_project_updated_idx");
      assert.notInclude(titlePlanText, "SCAN t");

      for (let index = 0; index < 3; index += 1) {
        yield* service.searchCitizens({ projectId: PROJECT_ID, query: "citizen 099", limit: 20 });
        yield* service.searchCitizens({ projectId: PROJECT_ID, query: "host 099", limit: 20 });
      }

      const samples: number[] = [];
      for (let index = 0; index < SAMPLE_COUNT; index += 1) {
        const started = performance.now();
        const results = yield* service.searchCitizens({
          projectId: PROJECT_ID,
          query: index % 2 === 0 ? "citizen 099" : "host 099",
          limit: 20,
        });
        samples.push(performance.now() - started);
        assert.isAtMost(results.length, 20);
      }

      assert.isAtMost(percentile(samples, 0.95), P95_BUDGET_MS);
    }).pipe(Effect.provide(Layer.fresh(layer))),
  { timeout: 120_000 },
);
