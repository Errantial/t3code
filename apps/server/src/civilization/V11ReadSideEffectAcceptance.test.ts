import {
  CivilizationMessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ThreadId as ThreadIdType,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ChronicleService from "./ChronicleService.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import * as MailService from "./MailService.ts";
import * as ProjectBriefService from "./ProjectBriefService.ts";

const PROJECT_ID = ProjectId.make("project:v11-5:no-side-effects");
const PROVIDER_ID = ProviderInstanceId.make("codex-main");
const ROOT_ID = ThreadId.make("thread:v11-5:root");
const CHILD_A_ID = ThreadId.make("thread:v11-5:child-a");
const CHILD_B_ID = ThreadId.make("thread:v11-5:child-b");
const CHILD_C_ID = ThreadId.make("thread:v11-5:child-c");
const GRANDCHILD_ID = ThreadId.make("thread:v11-5:grandchild");
const ROOT_MESSAGE_ID = CivilizationMessageId.make("mail:v11-5:root");
const REPLY_MESSAGE_ID = CivilizationMessageId.make("mail:v11-5:reply");
const NESTED_MESSAGE_ID = CivilizationMessageId.make("mail:v11-5:nested");
const NOW = "2026-10-18T12:30:00.000Z";

type ProviderCalls = {
  get: number;
  list: number;
};

const database = NodeSqliteClient.layer({ filename: ":memory:" });
const config = ConfigService.layer.pipe(Layer.provide(database));
const providers = (calls: ProviderCalls) =>
  Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: () => {
        calls.get += 1;
        return Effect.die("V11-5 read acceptance must not resolve provider adapters");
      },
      list: () => {
        calls.list += 1;
        return Effect.die("V11-5 read acceptance must not enumerate provider adapters");
      },
    }),
  );

const makeLayer = (calls: ProviderCalls) => {
  const providerLayer = providers(calls);
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer).pipe(
    Layer.provide(database),
  );
  const knowledge = KnowledgeService.layer.pipe(Layer.provide(database));
  const chronicle = ChronicleService.layer.pipe(Layer.provide(database));
  const citizens = CitizenService.layer.pipe(Layer.provide(Layer.mergeAll(database, stores)));
  const mail = MailService.layer.pipe(
    Layer.provide(Layer.mergeAll(database, config, providerLayer)),
  );
  const projectBrief = ProjectBriefService.layer.pipe(Layer.provide(database));
  const context = ContextService.layer.pipe(
    Layer.provide(Layer.mergeAll(database, config, providerLayer, mail, projectBrief)),
  );
  return Layer.mergeAll(
    database,
    stores,
    config,
    providerLayer,
    knowledge,
    citizens,
    chronicle,
    mail,
    projectBrief,
    context,
  );
};

const insertCitizen = Effect.fn("V11ReadSideEffectAcceptance.insertCitizen")(function* (input: {
  readonly threadId: ThreadIdType;
  readonly parentThreadId: ThreadIdType | null;
  readonly relationship: "fork" | "subagent" | null;
  readonly generation: number;
  readonly birthSequence: number;
  readonly displayName: string;
}) {
  const sql = yield* SqlClient.SqlClient;
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
      ${input.threadId}, ${PROJECT_ID}, ${input.parentThreadId}, ${input.relationship}, ${ROOT_ID},
      ${input.generation}, 'resolved', 0, ${input.birthSequence}, ${input.birthSequence},
      ${`name:${input.threadId}`}, 1, ${input.displayName}, ${input.displayName},
      ${String(input.threadId)}, 'default-names', 0, 0,
      'profile:calm', 'Calm', '[]', '', 'default-profiles', 0, 0,
      0, ${input.displayName}, NULL, ${input.displayName}, NULL, NULL, NULL,
      0, 0, 0, 0, 0, 0, 0,
      1, '2026-10-18T09:00:00.000Z', '2026-10-18T09:00:00.000Z'
    )
  `;
});

const seedFixture = Effect.fn("V11ReadSideEffectAcceptance.seedFixture")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations();
  yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(NOW)));

  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${PROJECT_ID}, 'V11-5 read-only acceptance', '/tmp/v11-5-read-only', '[]',
      '2026-10-18T09:00:00.000Z', '2026-10-18T09:00:00.000Z', NULL
    )
  `;

  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id,
      runtime_mode, interaction_mode, active_provider_thread_id,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${ROOT_ID}, ${PROJECT_ID}, 'V11-5 root', ${PROVIDER_ID}, ${PROVIDER_ID},
      'full-access', 'default', 'provider-thread:v11-5',
      '2026-10-18T09:00:00.000Z', '2026-10-18T09:05:00.000Z', NULL, NULL,
      '{"fixture":"v11-5"}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
      status, requested_at, completed_at, payload_json
    ) VALUES (
      'run:v11-5:root', ${ROOT_ID}, 1, ${PROVIDER_ID}, ${PROVIDER_ID}, 'provider-thread:v11-5',
      'running', '2026-10-18T09:05:00.000Z', NULL, '{"fixture":"v11-5"}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_run_attempts (
      attempt_id, thread_id, run_id, attempt_ordinal, root_node_id,
      provider, provider_instance_id, provider_thread_id, provider_turn_id, status, payload_json
    ) VALUES (
      'attempt:v11-5:root', ${ROOT_ID}, 'run:v11-5:root', 1, 'node:v11-5:root',
      ${PROVIDER_ID}, ${PROVIDER_ID}, 'provider-thread:v11-5', 'provider-turn:v11-5',
      'running', '{"fixture":"v11-5"}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_sessions (
      provider_session_id, thread_id, provider, driver, provider_instance_id,
      status, model, updated_at, payload_json
    ) VALUES (
      'provider-session:v11-5', ${ROOT_ID}, ${PROVIDER_ID}, 'codex', ${PROVIDER_ID},
      'active', 'gpt-fixture', '2026-10-18T09:05:00.000Z', '{"fixture":"v11-5"}'
    )
  `;
  yield* sql`
    INSERT INTO orchestration_v2_projection_provider_threads (
      provider_thread_id, thread_id, owner_node_id, provider, driver, provider_instance_id,
      provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json
    ) VALUES (
      'provider-thread:v11-5', ${ROOT_ID}, 'node:v11-5:root', ${PROVIDER_ID}, 'codex', ${PROVIDER_ID},
      'provider-session:v11-5', 'active', 1, 1, '2026-10-18T09:05:00.000Z',
      '{"fixture":"v11-5"}'
    )
  `;
  yield* sql`
    INSERT INTO provider_session_runtime (
      thread_id, provider_name, adapter_key, provider_instance_id,
      runtime_mode, status, last_seen_at, resume_cursor_json, runtime_payload_json
    ) VALUES (
      ${ROOT_ID}, 'codex', 'codex', ${PROVIDER_ID}, 'full-access', 'active',
      '2026-10-18T09:05:00.000Z', '{"cursor":"v11-5"}', '{"fixture":"v11-5"}'
    )
  `;

  yield* insertCitizen({
    threadId: ROOT_ID,
    parentThreadId: null,
    relationship: null,
    generation: 0,
    birthSequence: 1,
    displayName: "Root",
  });
  yield* insertCitizen({
    threadId: CHILD_A_ID,
    parentThreadId: ROOT_ID,
    relationship: "fork",
    generation: 1,
    birthSequence: 2,
    displayName: "Child A",
  });
  yield* insertCitizen({
    threadId: CHILD_B_ID,
    parentThreadId: ROOT_ID,
    relationship: "subagent",
    generation: 1,
    birthSequence: 3,
    displayName: "Child B",
  });
  yield* insertCitizen({
    threadId: CHILD_C_ID,
    parentThreadId: ROOT_ID,
    relationship: "fork",
    generation: 1,
    birthSequence: 4,
    displayName: "Child C",
  });
  yield* insertCitizen({
    threadId: GRANDCHILD_ID,
    parentThreadId: CHILD_A_ID,
    relationship: "subagent",
    generation: 2,
    birthSequence: 5,
    displayName: "Grandchild",
  });

  yield* sql`
    INSERT INTO civilization_chronicle_entries (
      entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
      citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
      provenance_key, occurred_at, metadata_json
    ) VALUES
      ('chronicle:v11-5:root', ${PROJECT_ID}, 'citizen_joined', ${ROOT_ID}, NULL,
       0, 1, 'host_event', 'event:v11-5:root', 1, 'v11-5-root',
       '2026-10-18T09:10:00.000Z', '{}'),
      ('chronicle:v11-5:child-a', ${PROJECT_ID}, 'child_joined', ${ROOT_ID}, ${CHILD_A_ID},
       0, 1, 'host_event', 'event:v11-5:child-a', 2, 'v11-5-child-a',
       '2026-10-18T09:20:00.000Z', '{"relationship":"fork"}'),
      ('chronicle:v11-5:child-b', ${PROJECT_ID}, 'child_joined', ${ROOT_ID}, ${CHILD_B_ID},
       0, 1, 'host_event', 'event:v11-5:child-b', 3, 'v11-5-child-b',
       '2026-10-18T09:30:00.000Z', '{"relationship":"subagent"}'),
      ('chronicle:v11-5:grandchild', ${PROJECT_ID}, 'child_joined', ${CHILD_A_ID}, ${GRANDCHILD_ID},
       0, 1, 'host_event', 'event:v11-5:grandchild', 4, 'v11-5-grandchild',
       '2026-10-18T09:40:00.000Z', '{"relationship":"subagent"}')
  `;

  yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, sender_thread_id, sender_name_at_send,
      sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
      reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
      terminal_retention_days, first_offered_at, last_offered_at, offer_count,
      acknowledged_at, terminal_at, terminal_reason
    ) VALUES
      (${ROOT_MESSAGE_ID}, ${PROJECT_ID}, ${ROOT_ID}, 'Root', 0, 'run:v11-5:root',
       ${CHILD_A_ID}, 0, NULL, 'root retained body', 18, 'full-access', 'default', 0, 0,
       '2026-10-18T10:00:00.000Z', '2026-11-18T10:00:00.000Z', 30,
       '2026-10-18T10:01:00.000Z', '2026-10-18T10:02:00.000Z', 2,
       NULL, NULL, NULL),
      (${REPLY_MESSAGE_ID}, ${PROJECT_ID}, ${CHILD_A_ID}, 'Child A', 0, 'run:v11-5:child-a',
       ${ROOT_ID}, 0, ${ROOT_MESSAGE_ID}, 'reply retained body', 19, 'full-access', 'default', 0, 0,
       '2026-10-18T10:10:00.000Z', '2026-11-18T10:10:00.000Z', 30,
       '2026-10-18T10:11:00.000Z', '2026-10-18T10:11:00.000Z', 1,
       '2026-10-18T10:12:00.000Z', NULL, NULL),
      (${NESTED_MESSAGE_ID}, ${PROJECT_ID}, ${ROOT_ID}, 'Root', 0, 'run:v11-5:root',
       ${CHILD_B_ID}, 0, ${REPLY_MESSAGE_ID}, 'nested retained body', 20, 'full-access', 'default', 0, 0,
       '2026-10-18T10:20:00.000Z', '2026-11-18T10:20:00.000Z', 30,
       NULL, NULL, 0, NULL, NULL, NULL)
  `;

  yield* sql`
    INSERT INTO civilization_context_inspections (
      inspection_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
      provider_instance_id, provider_driver, outcome, suppression_reason,
      diagnostics_mode, packet_text_state, packet_bytes, packet_text, packet_budget_bytes,
      required_bytes, roster_bytes, note_bytes, inbox_bytes, unused_bytes,
      roster_candidates, roster_included, note_candidates, note_included,
      inbox_candidates, inbox_included, selected_citizen_ids_json, selected_note_ids_json,
      selected_inbox_ids_json, created_at, updated_at
    ) VALUES
      ('inspection:v11-5:one', ${PROJECT_ID}, ${ROOT_ID}, 'run:v11-5:root', 'attempt:v11-5:root', 1,
       ${PROVIDER_ID}, 'codex', 'built', NULL, 'normal', 'retained_normal', 512,
       'sensitive packet one', 16384, 128, 128, 0, 64, 16000,
       5, 3, 0, 0, 3, 2, '["thread:v11-5:child-a"]', '[]', '["mail:v11-5:root"]',
       '2026-10-18T11:00:00.000Z', '2026-10-18T11:00:00.000Z'),
      ('inspection:v11-5:two', ${PROJECT_ID}, ${ROOT_ID}, 'run:v11-5:root', 'attempt:v11-5:two', 2,
       ${PROVIDER_ID}, 'codex', 'skipped', 'provider_command', 'normal', 'skipped_no_packet', 0,
       NULL, 16384, 0, 0, 0, 0, 16384,
       5, 0, 0, 0, 3, 0, '[]', '[]', '[]',
       '2026-10-18T11:30:00.000Z', '2026-10-18T11:30:00.000Z')
  `;
});

type SnapshotRow = Readonly<Record<string, string | number | null>>;

const readSideEffectSnapshot = Effect.fn("V11ReadSideEffectAcceptance.readSideEffectSnapshot")(
  function* () {
    const sql = yield* SqlClient.SqlClient;
    const counts = (yield* sql<{
      readonly events: number;
      readonly command_receipts: number;
      readonly effect_outbox: number;
      readonly runtime_requests: number;
      readonly mail_receipts: number;
      readonly mail_quota_rows: number;
      readonly citizens: number;
      readonly chronicle: number;
      readonly messages: number;
      readonly inspections: number;
      readonly analytics_rows: number;
    }>`
      SELECT
        (SELECT COUNT(*) FROM orchestration_v2_events) AS events,
        (SELECT COUNT(*) FROM orchestration_v2_command_receipts) AS command_receipts,
        (SELECT COUNT(*) FROM orchestration_v2_effect_outbox) AS effect_outbox,
        (SELECT COUNT(*) FROM orchestration_v2_projection_runtime_requests) AS runtime_requests,
        (SELECT COUNT(*) FROM civilization_mail_operation_receipts) AS mail_receipts,
        (SELECT COUNT(*) FROM civilization_mail_quota_windows) AS mail_quota_rows,
        (SELECT COUNT(*) FROM civilization_citizens WHERE project_id = ${PROJECT_ID}) AS citizens,
        (SELECT COUNT(*) FROM civilization_chronicle_entries WHERE project_id = ${PROJECT_ID}) AS chronicle,
        (SELECT COUNT(*) FROM civilization_messages WHERE project_id = ${PROJECT_ID}) AS messages,
        (SELECT COUNT(*) FROM civilization_context_inspections WHERE project_id = ${PROJECT_ID}) AS inspections,
        (SELECT COUNT(*) FROM civilization_context_analytics_hourly WHERE project_id = ${PROJECT_ID}) AS analytics_rows
    `)[0]!;
    return {
      counts,
      projectState: yield* sql<SnapshotRow>`
        SELECT census_revision, notes_revision, mail_revision, mail_history_revision,
               chronicle_revision, achievement_revision, retained_message_count,
               retained_body_bytes, updated_at
        FROM civilization_project_state WHERE project_id = ${PROJECT_ID}
      `,
      providerRuntime: yield* sql<SnapshotRow>`
        SELECT thread_id, provider_name, adapter_key, provider_instance_id, runtime_mode,
               status, last_seen_at, resume_cursor_json, runtime_payload_json
        FROM provider_session_runtime ORDER BY thread_id
      `,
      threads: yield* sql<SnapshotRow>`
        SELECT thread_id, project_id, provider_instance_id, runtime_mode, interaction_mode,
               active_provider_thread_id, updated_at, archived_at, deleted_at, payload_json
        FROM orchestration_v2_projection_threads ORDER BY thread_id
      `,
      runs: yield* sql<SnapshotRow>`
        SELECT run_id, thread_id, ordinal, provider_instance_id, provider_thread_id,
               status, requested_at, completed_at, payload_json
        FROM orchestration_v2_projection_runs ORDER BY run_id
      `,
      attempts: yield* sql<SnapshotRow>`
        SELECT attempt_id, thread_id, run_id, attempt_ordinal, provider_instance_id,
               provider_thread_id, provider_turn_id, status, payload_json
        FROM orchestration_v2_projection_run_attempts ORDER BY attempt_id
      `,
      providerSessions: yield* sql<SnapshotRow>`
        SELECT provider_session_id, thread_id, driver, provider_instance_id, status,
               model, updated_at, payload_json
        FROM orchestration_v2_projection_provider_sessions ORDER BY provider_session_id
      `,
      providerThreads: yield* sql<SnapshotRow>`
        SELECT provider_thread_id, thread_id, owner_node_id, driver, provider_instance_id,
               provider_session_id, status, first_run_ordinal, last_run_ordinal, updated_at, payload_json
        FROM orchestration_v2_projection_provider_threads ORDER BY provider_thread_id
      `,
      runtimeRequests: yield* sql<SnapshotRow>`
        SELECT runtime_request_id, thread_id, node_id, provider_turn_id, kind, status,
               created_at, resolved_at, payload_json
        FROM orchestration_v2_projection_runtime_requests ORDER BY runtime_request_id
      `,
      mailDelivery: yield* sql<SnapshotRow>`
        SELECT message_id, offer_count, first_offered_at, last_offered_at, acknowledged_at,
               terminal_at, terminal_reason
        FROM civilization_messages WHERE project_id = ${PROJECT_ID} ORDER BY message_id
      `,
      inspections: yield* sql<SnapshotRow>`
        SELECT inspection_id, outcome, suppression_reason, provider_start_at, updated_at
        FROM civilization_context_inspections WHERE project_id = ${PROJECT_ID}
        ORDER BY inspection_id
      `,
      analytics: yield* sql<SnapshotRow>`
        SELECT project_id, bucket_start, provider_instance_id, outcome, suppression_reason,
               inspection_count, packet_zero, packet_low, packet_medium, packet_high, packet_over
        FROM civilization_context_analytics_hourly WHERE project_id = ${PROJECT_ID}
        ORDER BY bucket_start, provider_instance_id, outcome, suppression_reason
      `,
    };
  },
);

it.effect(
  "keeps all integrated v1.1 read surfaces provider-free and persistence-side-effect-free",
  () => {
    const calls: ProviderCalls = { get: 0, list: 0 };
    return Effect.gen(function* () {
      const knowledge = yield* KnowledgeService.CivilizationKnowledgeService;
      const citizens = yield* CitizenService.CivilizationCitizenService;
      const chronicle = yield* ChronicleService.CivilizationChronicleService;
      const mail = yield* MailService.CivilizationMailService;
      const context = yield* ContextService.CivilizationContextService;
      yield* seedFixture();
      const before = yield* readSideEffectSnapshot();

      const hallOpen = yield* knowledge.getLineageNeighborhood({
        projectId: PROJECT_ID,
        threadId: ROOT_ID,
        limit: 2,
      });
      assert.deepEqual(
        hallOpen.children.map((child) => child.threadId),
        [CHILD_A_ID, CHILD_B_ID],
      );
      assert.isTrue(hallOpen.partial);
      assert.isNotNull(hallOpen.nextCursor);
      const hallPage = yield* knowledge.getLineageNeighborhood({
        projectId: PROJECT_ID,
        threadId: ROOT_ID,
        cursor: hallOpen.nextCursor!,
        limit: 2,
      });
      assert.deepEqual(
        hallPage.children.map((child) => child.threadId),
        [CHILD_C_ID],
      );
      const hallFocus = yield* knowledge.getLineageNeighborhood({
        projectId: PROJECT_ID,
        threadId: CHILD_A_ID,
        limit: 2,
      });
      assert.equal(hallFocus.parent?.threadId, ROOT_ID);
      assert.deepEqual(
        hallFocus.children.map((child) => child.threadId),
        [GRANDCHILD_ID],
      );
      const citizenDetail = yield* citizens.getCitizenDetail({
        projectId: PROJECT_ID,
        threadId: ROOT_ID,
      });
      assert.equal(citizenDetail.identity.displayName, "Root");
      assert.equal(citizenDetail.host.threadTitle, "V11-5 root");

      const chronicleFirst = yield* chronicle.list({ projectId: PROJECT_ID, limit: 2 });
      assert.isNotNull(chronicleFirst.nextCursor);
      const chroniclePage = yield* chronicle.list({
        projectId: PROJECT_ID,
        cursor: chronicleFirst.nextCursor!,
        limit: 2,
      });
      assert.isAbove(chroniclePage.entries.length, 0);
      const chronicleFiltered = yield* chronicle.list({
        projectId: PROJECT_ID,
        kind: "child_joined",
        threadId: ROOT_ID,
        limit: 10,
      });
      assert.deepEqual(
        chronicleFiltered.entries.map((entry) => entry.entryId),
        ["chronicle:v11-5:child-b", "chronicle:v11-5:child-a"],
      );

      const correspondenceFirst = yield* mail.listCorrespondenceHistory({
        projectId: PROJECT_ID,
        participantThreadId: ROOT_ID,
        limit: 2,
      });
      assert.isNotNull(correspondenceFirst.nextCursor);
      const correspondencePage = yield* mail.listCorrespondenceHistory({
        projectId: PROJECT_ID,
        participantThreadId: ROOT_ID,
        cursor: correspondenceFirst.nextCursor!,
        limit: 2,
      });
      assert.lengthOf(correspondencePage.messages, 1);
      const pairConversation = yield* mail.listCorrespondenceHistory({
        projectId: PROJECT_ID,
        participantThreadId: CHILD_A_ID,
        counterpartyThreadId: ROOT_ID,
        limit: 10,
      });
      assert.deepEqual(
        pairConversation.messages.map((message) => message.messageId),
        [REPLY_MESSAGE_ID, ROOT_MESSAGE_ID],
      );
      assert.notInclude(JSON.stringify(pairConversation), "retained body");
      const thread = yield* mail.readCorrespondenceThread({
        projectId: PROJECT_ID,
        messageId: REPLY_MESSAGE_ID,
        ancestorLimit: 4,
        descendantLimit: 4,
      });
      assert.deepEqual(
        thread.entries.map((entry) => [entry.message.messageId, entry.relation, entry.depth]),
        [
          [ROOT_MESSAGE_ID, "ancestor", -1],
          [REPLY_MESSAGE_ID, "selected", 0],
          [NESTED_MESSAGE_ID, "descendant", 1],
        ],
      );
      const body = yield* mail.readAdminMessage({
        projectId: PROJECT_ID,
        messageId: REPLY_MESSAGE_ID,
      });
      assert.equal(body.body, "reply retained body");

      const analytics = yield* context.analytics({
        projectId: PROJECT_ID,
        bucketSize: "hour",
        from: "2026-10-18T10:00:00.000Z",
        to: "2026-10-18T12:00:00.000Z",
      });
      assert.equal(
        analytics.buckets.reduce((sum, bucket) => sum + bucket.totalInspections, 0),
        2,
      );
      const inspectorFirst = yield* context.listInspections({
        projectId: PROJECT_ID,
        threadId: ROOT_ID,
        limit: 1,
      });
      assert.lengthOf(inspectorFirst.inspections, 1);
      assert.isNotNull(inspectorFirst.nextCursor);
      assert.notInclude(JSON.stringify(inspectorFirst), "sensitive packet one");
      const inspectorPage = yield* context.listInspections({
        projectId: PROJECT_ID,
        threadId: ROOT_ID,
        cursor: inspectorFirst.nextCursor!,
        limit: 1,
      });
      assert.lengthOf(inspectorPage.inspections, 1);
      assert.notInclude(JSON.stringify(inspectorPage), "sensitive packet one");

      const after = yield* readSideEffectSnapshot();
      assert.deepEqual(
        after,
        before,
        "v1.1 inspection reads must not mutate provider/session/run/mail/analytics persistence",
      );
      assert.equal(
        after.counts.effect_outbox,
        0,
        "reads must not enqueue provider or wake/steer work",
      );
      assert.equal(after.counts.events, 0, "reads must not synthesize orchestration events");
      assert.equal(after.counts.command_receipts, 0, "reads must not issue orchestration commands");
      assert.equal(
        after.counts.runtime_requests,
        0,
        "reads must not create runtime/model requests",
      );
      assert.equal(
        after.counts.mail_receipts,
        0,
        "reads must not send, offer, receive, or acknowledge mail",
      );
      assert.equal(after.counts.mail_quota_rows, 0, "reads must not consume mail quota");
      assert.equal(calls.get, 0);
      assert.equal(calls.list, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
  { timeout: 30_000 },
);
