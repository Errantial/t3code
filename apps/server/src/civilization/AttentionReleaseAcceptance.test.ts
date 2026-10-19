import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AttentionService from "./AttentionService.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as MailService from "./MailService.ts";
import * as ProjectBriefService from "./ProjectBriefService.ts";

const PROJECT_ID = ProjectId.make("project:v15-5:attention-acceptance");
const THREAD_ID = ThreadId.make("thread:v15-5:attention-acceptance");
const PROVIDER_ID = ProviderInstanceId.make("codex-main");
const NOW = "2026-10-18T12:00:00.000Z";
const RECENT_FROM = "2026-10-17T12:00:00.000Z";

const MAIL_SECRET = "ATTENTION_MUST_NOT_READ_MAIL_BODY";
const NOTE_SECRET = "ATTENTION_MUST_NOT_READ_NOTE_BODY";
const BRIEF_SECRET = "ATTENTION_MUST_NOT_READ_BRIEF_BODY";
const PACKET_SECRET = "ATTENTION_MUST_NOT_READ_PACKET_TEXT";
const OLD_PACKET_SECRET = "ATTENTION_MUST_IGNORE_OLD_PACKET_TEXT";
const MODEL_SECRET = "attention-model-must-not-change";

type ProviderCalls = {
  list: number;
  get: number;
  unexpectedProviderWork: number;
};

const providerLayer = (calls: ProviderCalls) =>
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      list: () => {
        calls.list += 1;
        return Effect.succeed([PROVIDER_ID]);
      },
      get: (instanceId) => {
        calls.get += 1;
        if (instanceId !== PROVIDER_ID) {
          return Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          );
        }
        return Effect.succeed({
          instanceId,
          driver: "codex",
          openSession: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("attention acceptance must not open provider sessions");
          },
          getCapabilities: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die(
              "attention acceptance must not execute provider/model capability work",
            );
          },
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]);
      },
    }),
  );

const makeLayer = (calls: ProviderCalls) => {
  const database = SqlitePersistence.layerMemory;
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const providers = providerLayer(calls);
  const mail = MailService.layer.pipe(Layer.provide(Layer.mergeAll(database, providers)));
  const projectBrief = ProjectBriefService.layer.pipe(Layer.provide(database));
  const context = ContextService.layer.pipe(
    Layer.provide(Layer.mergeAll(database, config, providers, mail, projectBrief)),
  );
  const attention = AttentionService.layer.pipe(Layer.provide(Layer.mergeAll(config, context)));
  return Layer.mergeAll(database, config, providers, mail, projectBrief, context, attention);
};

const seedFixture = Effect.fn("AttentionReleaseAcceptance.seedFixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ConfigService.CivilizationConfigService;
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${PROJECT_ID}, 'Attention acceptance', '/tmp/attention-acceptance', '[]',
      '2026-09-18T12:00:00.000Z', '2026-10-18T10:00:00.000Z', NULL
    )
  `;
  yield* config.set({
    projectId: PROJECT_ID,
    expectedRevision: 0,
    expectedEnvironmentRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      operations: { diagnostics: "normal", diagnosticRetentionDays: 30 },
    },
  });

  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id,
      runtime_mode, interaction_mode, active_provider_thread_id,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${THREAD_ID}, ${PROJECT_ID}, 'Attention title', ${PROVIDER_ID}, ${PROVIDER_ID},
      'full-access', 'default', 'provider-thread:attention',
      '2026-09-18T12:00:00.000Z', '2026-10-18T10:00:00.000Z', NULL, NULL,
      '{"fixture":"attention"}'
    )
  `;
  yield* sql`
    INSERT INTO civilization_citizens (
      thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
      generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
      name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
      name_environment_revision, name_project_revision,
      profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
      profile_environment_revision, profile_project_revision,
      title_managed, preserved_title, last_managed_title, title_topic,
      pending_title_command_id, pending_managed_title, pending_title_topic,
      epoch, closed, deleted, delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
      revision, created_at, updated_at
    ) VALUES (
      ${THREAD_ID}, ${PROJECT_ID}, NULL, NULL, ${THREAD_ID},
      0, 'resolved', 0, 1, 1,
      'attention-name', 1, 'Attender', 'Attender', 'attender', 'default-names', 0, 1,
      'calm', 'Calm', '[]', '', 'default-profiles', 0, 1,
      1, 'Attention title', 'Attention title', 'Attention title', NULL, NULL, NULL,
      0, 0, 0, 0, 0, 0, 0,
      1, '2026-09-18T12:00:00.000Z', '2026-10-18T10:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT OR IGNORE INTO civilization_project_state (
      project_id, census_revision, notes_revision, updated_at
    ) VALUES (${PROJECT_ID}, 1, 1, '2026-10-18T10:00:00.000Z')
  `;
  yield* sql`
    UPDATE civilization_project_state
    SET applied_diagnostic_retention_days = 30
    WHERE project_id = ${PROJECT_ID}
  `;

  yield* sql`
    INSERT INTO civilization_notes (
      note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
      accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
      created_at, updated_at, resolved_at
    ) VALUES (
      'note:attention-secret', ${PROJECT_ID}, 'fact', ${NOTE_SECRET}, ${Buffer.byteLength(NOTE_SECRET, "utf8")},
      ${THREAD_ID}, 0, 'full-access', 'default', '[]', 1,
      '2026-10-18T08:00:00.000Z', '2026-10-18T08:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, sender_thread_id, sender_name_at_send,
      sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
      reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
      terminal_retention_days, first_offered_at, last_offered_at, offer_count,
      acknowledged_at, terminal_at, terminal_reason
    ) VALUES (
      'mail:attention-secret', ${PROJECT_ID}, 'thread:v15-5:attention-sender', 'Sender', 0, 'run:attention',
      ${THREAD_ID}, 0, NULL, ${MAIL_SECRET}, ${Buffer.byteLength(MAIL_SECRET, "utf8")},
      'full-access', 'default', 0, 1,
      '2026-10-18T07:00:00.000Z', '2026-11-18T07:00:00.000Z', 30,
      '2026-10-18T07:01:00.000Z', '2026-10-18T07:02:00.000Z', 1,
      '2026-10-18T07:03:00.000Z', NULL, NULL
    )
  `;
  const briefJson = JSON.stringify({
    version: 1,
    summary: BRIEF_SECRET,
    objectives: [],
    constraints: [],
    references: [],
  });
  yield* sql`
    INSERT INTO civilization_project_brief (
      project_id, revision, content_json, body_bytes, updated_at
    ) VALUES (
      ${PROJECT_ID}, 1, ${briefJson}, ${Buffer.byteLength(briefJson, "utf8")},
      '2026-10-18T06:00:00.000Z'
    )
  `;

  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_sessions (
      provider_session_id, thread_id, provider, driver, provider_instance_id,
      status, model, updated_at, payload_json
    ) VALUES (
      'provider-session:attention', ${THREAD_ID}, ${PROVIDER_ID}, 'codex', ${PROVIDER_ID},
      'active', ${MODEL_SECRET}, '2026-10-18T10:00:00.000Z', '{"fixture":"attention"}'
    )
  `;
  yield* sql`
    INSERT INTO provider_session_runtime (
      thread_id, provider_name, adapter_key, provider_instance_id,
      runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
    ) VALUES (
      ${THREAD_ID}, 'codex', 'codex', ${PROVIDER_ID}, 'full-access', 'active',
      '2026-10-18T10:00:00.000Z', '{"cursor":"attention"}', '{"fixture":"attention"}'
    )
  `;

  yield* sql`
    INSERT INTO civilization_context_inspections (
      inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
      provider_instance_id, provider_driver, outcome, suppression_reason,
      diagnostics_mode, packet_text_state, packet_bytes, packet_text, packet_budget_bytes,
      roster_candidates, roster_included, note_candidates, note_included,
      inbox_candidates, inbox_included, created_at, updated_at
    ) VALUES
      ('inspection:attention:recent-failure', ${PROJECT_ID}, ${THREAD_ID}, 'run:attention:1', 'attempt:attention:1', 1,
       ${PROVIDER_ID}, 'codex', 'provider_start_failed', NULL,
       'normal', 'retained_error', 1024, ${PACKET_SECRET}, 16384,
       1, 1, 1, 1, 1, 1, '2026-10-18T11:00:00.000Z', '2026-10-18T11:00:00.000Z'),
      ('inspection:attention:recent-zero', ${PROJECT_ID}, ${THREAD_ID}, 'run:attention:2', 'attempt:attention:2', 2,
       ${PROVIDER_ID}, 'codex', 'skipped', 'packet_budget_zero',
       'normal', 'skipped_no_packet', 0, NULL, 0,
       1, 0, 1, 0, 1, 0, '2026-10-18T10:00:00.000Z', '2026-10-18T10:00:00.000Z'),
      ('inspection:attention:recent-small', ${PROJECT_ID}, ${THREAD_ID}, 'run:attention:3', 'attempt:attention:3', 3,
       ${PROVIDER_ID}, 'codex', 'skipped', 'packet_budget_too_small',
       'normal', 'skipped_no_packet', 0, NULL, 1,
       1, 0, 1, 0, 1, 0, '2026-10-18T09:00:00.000Z', '2026-10-18T09:00:00.000Z'),
      ('inspection:attention:old-failure', ${PROJECT_ID}, ${THREAD_ID}, 'run:attention:old-1', 'attempt:attention:old-1', 4,
       ${PROVIDER_ID}, 'codex', 'provider_start_failed', NULL,
       'normal', 'retained_error', 1024, ${OLD_PACKET_SECRET}, 16384,
       1, 1, 1, 1, 1, 1, '2026-09-19T12:00:00.000Z', '2026-09-19T12:00:00.000Z'),
      ('inspection:attention:old-zero', ${PROJECT_ID}, ${THREAD_ID}, 'run:attention:old-2', 'attempt:attention:old-2', 5,
       ${PROVIDER_ID}, 'codex', 'skipped', 'packet_budget_zero',
       'normal', 'skipped_no_packet', 0, NULL, 0,
       1, 0, 1, 0, 1, 0, '2026-09-19T13:00:00.000Z', '2026-09-19T13:00:00.000Z')
  `;
});

type SnapshotRow = Readonly<Record<string, string | number | null>>;

const readMutationSnapshot = Effect.fn("AttentionReleaseAcceptance.readMutationSnapshot")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    return {
      environmentConfig: yield* sql<SnapshotRow>`
        SELECT singleton, revision, override_json, updated_at
        FROM civilization_environment_config
      `,
      projectConfig: yield* sql<SnapshotRow>`
        SELECT project_id, revision, override_json, updated_at
        FROM civilization_project_config WHERE project_id = ${PROJECT_ID}
      `,
      projectState: yield* sql<SnapshotRow>`
        SELECT census_revision, notes_revision, mail_revision, mail_history_revision,
               retained_message_count, retained_body_bytes, applied_diagnostic_retention_days, updated_at
        FROM civilization_project_state WHERE project_id = ${PROJECT_ID}
      `,
      citizen: yield* sql<SnapshotRow>`
        SELECT thread_id, epoch, closed, deleted, delivery_epoch, delivery_settled,
               delivery_archived, delivery_deleted, revision, title_managed, preserved_title,
               last_managed_title, title_topic, pending_title_command_id,
               pending_managed_title, pending_title_topic, updated_at
        FROM civilization_citizens WHERE thread_id = ${THREAD_ID}
      `,
      thread: yield* sql<SnapshotRow>`
        SELECT thread_id, title, provider_instance_id, runtime_mode, interaction_mode,
               active_provider_thread_id, updated_at, archived_at, deleted_at, payload_json
        FROM orchestration_v2_projection_threads WHERE thread_id = ${THREAD_ID}
      `,
      mail: yield* sql<SnapshotRow>`
        SELECT message_id, content_kind, body, offer_count, first_offered_at, last_offered_at,
               acknowledged_at, terminal_at, terminal_reason
        FROM civilization_messages WHERE project_id = ${PROJECT_ID}
      `,
      notes: yield* sql<SnapshotRow>`
        SELECT note_id, body, revision, updated_at, resolved_at
        FROM civilization_notes WHERE project_id = ${PROJECT_ID}
      `,
      brief: yield* sql<SnapshotRow>`
        SELECT project_id, revision, content_json, body_bytes, updated_at
        FROM civilization_project_brief WHERE project_id = ${PROJECT_ID}
      `,
      providerSessions: yield* sql<SnapshotRow>`
        SELECT provider_session_id, thread_id, driver, provider_instance_id, status,
               model, updated_at, payload_json
        FROM orchestration_v2_projection_provider_sessions WHERE thread_id = ${THREAD_ID}
      `,
      providerRuntime: yield* sql<SnapshotRow>`
        SELECT thread_id, provider_name, adapter_key, provider_instance_id, runtime_mode,
               status, last_seen_at, resume_cursor_json, runtime_payload_json
        FROM provider_session_runtime WHERE thread_id = ${THREAD_ID}
      `,
      inspections: yield* sql<SnapshotRow>`
        SELECT inspection_id, outcome, suppression_reason, provider_start_at,
               packet_text_state, packet_text, updated_at
        FROM civilization_context_inspections WHERE project_id = ${PROJECT_ID}
        ORDER BY inspection_id
      `,
      effects: (yield* sql<SnapshotRow>`
        SELECT
          (SELECT COUNT(*) FROM orchestration_v2_events) AS events,
          (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS command_receipts,
          (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS effect_outbox,
          (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests) AS runtime_requests,
          (SELECT COUNT(*) FROM civilization_mail_operation_receipts) AS mail_receipts,
          (SELECT COUNT(*) FROM civilization_mail_quota_windows) AS mail_quota_rows
      `)[0]!,
    } as const;
  },
);

it.effect(
  "keeps V15-5 attention bounded, body-free, recent-only, and read-only on stats-free SQLite",
  () => {
    const calls: ProviderCalls = { list: 0, get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const attention = yield* AttentionService.CivilizationAttentionService;
      yield* seedFixture();

      assert.equal(AttentionService.CIVILIZATION_ATTENTION_RECENT_WINDOW_HOURS, 24);
      assert.equal(AttentionService.CIVILIZATION_ATTENTION_MAX_ITEMS, 8);
      assert.lengthOf(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'sqlite_stat1'`,
        0,
        "attention acceptance must exercise the production stats-free SQLite policy",
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_context_inspections
          WHERE project_id = ${PROJECT_ID} AND created_at < ${RECENT_FROM}
        `)[0]?.count,
        2,
        "max-retention diagnostics outside the fixed attention window must remain present",
      );

      const before = yield* readMutationSnapshot();
      const snapshot = yield* attention.snapshot(PROJECT_ID);
      const after = yield* readMutationSnapshot();

      assert.equal(snapshot.projectId, PROJECT_ID);
      assert.equal(snapshot.generatedAt, NOW);
      assert.deepEqual(
        snapshot.items.map((item) => item.kind),
        ["context_provider_start_failures", "packet_budget_pressure"],
      );
      assert.equal(
        snapshot.items.find((item) => item.kind === "context_provider_start_failures")?.detail,
        "1 provider-start failure was recorded in the recent diagnostic window.",
      );
      assert.equal(
        snapshot.items.find((item) => item.kind === "packet_budget_pressure")?.detail,
        "2 packet-budget suppressions were recorded in the recent diagnostic window.",
      );
      assert.isAtMost(snapshot.items.length, AttentionService.CIVILIZATION_ATTENTION_MAX_ITEMS);

      const serialized = JSON.stringify(snapshot);
      for (const secret of [
        MAIL_SECRET,
        NOTE_SECRET,
        BRIEF_SECRET,
        PACKET_SECRET,
        OLD_PACKET_SECRET,
        MODEL_SECRET,
      ]) {
        assert.notInclude(serialized, secret);
      }

      assert.deepEqual(after, before);
      assert.deepEqual(calls, { list: 1, get: 1, unexpectedProviderWork: 0 });
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
  { timeout: 120_000 },
);
