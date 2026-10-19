// @effect-diagnostics nodeBuiltinImport:off -- Acceptance samples process RSS for bounded correspondence reads.
import { CIVILIZATION_CONFIG_VERSION, ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { runMigrations } from "../persistence/Migrations.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailService from "./MailService.ts";

const PROJECT_ID = ProjectId.make("project:correspondence:performance");
const TARGET_PARTICIPANT = ThreadId.make("thread:correspondence:0007");
const PAIR_COUNTERPARTY = ThreadId.make("thread:correspondence:0008");
const MESSAGE_COUNT = 100_000;
const PAIR_MESSAGE_COUNT = 60_000;
const PAGE_SIZE = 50;
const SAMPLES = 60;
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
const config = ConfigService.layer.pipe(Layer.provide(database));
const adapters = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: () => Effect.die("correspondence inspection must not request provider adapters"),
    list: () => Effect.die("correspondence inspection must not list provider adapters"),
  }),
);
const dependencies = Layer.mergeAll(database, config, adapters);
const mail = MailService.layer.pipe(Layer.provide(dependencies));
const testLayer = Layer.mergeAll(dependencies, mail);

it.effect(
  "keeps retained-correspondence page and anchored-thread reads bounded at the max configured 100k ceiling",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const configService = yield* ConfigService.CivilizationConfigService;
      yield* runMigrations();
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (
          ${PROJECT_ID}, 'Correspondence performance', '/tmp/correspondence-performance', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', NULL
        )
      `;
      yield* configService.set({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedEnvironmentRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          messaging: { retainedMessageCount: MESSAGE_COUNT },
        },
      });
      yield* sql`
        WITH digits(n) AS (VALUES (0),(1),(2),(3),(4),(5),(6),(7),(8),(9)),
        numbers(n) AS (
          SELECT a.n + 10*b.n + 100*c.n + 1000*d.n + 10000*e.n
          FROM digits a CROSS JOIN digits b CROSS JOIN digits c CROSS JOIN digits d CROSS JOIN digits e
        )
        INSERT INTO civilization_messages (
          message_id, project_id, sender_thread_id, sender_name_at_send,
          sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
          reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
          accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
          terminal_retention_days, first_offered_at, last_offered_at, offer_count,
          acknowledged_at, terminal_at, terminal_reason
        )
        SELECT
          printf('mail:perf:%05d', n), ${PROJECT_ID},
          CASE
            WHEN n < ${PAIR_MESSAGE_COUNT} AND n % 2 = 0 THEN ${TARGET_PARTICIPANT}
            WHEN n < ${PAIR_MESSAGE_COUNT} THEN ${PAIR_COUNTERPARTY}
            ELSE printf('thread:correspondence:%04d', 100 + (n % 100))
          END,
          printf('Sender %04d', n % 100),
          n % 4, printf('run:mail:perf:%05d', n),
          CASE
            WHEN n < ${PAIR_MESSAGE_COUNT} AND n % 2 = 0 THEN ${PAIR_COUNTERPARTY}
            WHEN n < ${PAIR_MESSAGE_COUNT} THEN ${TARGET_PARTICIPANT}
            ELSE printf('thread:correspondence:%04d', 200 + (n % 100))
          END,
          n % 8,
          CASE WHEN n % 10 = 0 THEN NULL ELSE printf('mail:perf:%05d', n - 1) END,
          'x', 1, 'full-access', 'default', 0, 0,
          strftime('%Y-%m-%dT%H:%M:%fZ', '2026-01-01T00:00:00Z', '+' || n || ' seconds'),
          '2027-01-01T00:00:00.000Z', 30, NULL, NULL, 0,
          CASE WHEN n % 3 = 0 THEN '2026-01-02T00:00:00.000Z' ELSE NULL END,
          NULL, NULL
        FROM numbers
        WHERE n < ${MESSAGE_COUNT}
      `;
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_messages WHERE project_id = ${PROJECT_ID}
        `)[0]?.count,
        MESSAGE_COUNT,
      );

      const projectPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id FROM civilization_messages
        WHERE project_id = ${PROJECT_ID}
        ORDER BY accepted_at DESC, message_id DESC LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(projectPlan.map((row) => row.detail).join("\n"), "project_history_idx");
      const senderPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id FROM civilization_messages
        WHERE project_id = ${PROJECT_ID} AND sender_thread_id = ${TARGET_PARTICIPANT}
        ORDER BY accepted_at DESC, message_id DESC LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(senderPlan.map((row) => row.detail).join("\n"), "sender_history_idx");
      const pairForwardPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id FROM civilization_messages
        WHERE project_id = ${PROJECT_ID}
          AND sender_thread_id = ${TARGET_PARTICIPANT}
          AND recipient_thread_id = ${PAIR_COUNTERPARTY}
        ORDER BY accepted_at DESC, message_id DESC LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(pairForwardPlan.map((row) => row.detail).join("\n"), "pair_history_idx");
      const pairReversePlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id FROM civilization_messages
        WHERE project_id = ${PROJECT_ID}
          AND sender_thread_id = ${PAIR_COUNTERPARTY}
          AND recipient_thread_id = ${TARGET_PARTICIPANT}
        ORDER BY accepted_at DESC, message_id DESC LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(pairReversePlan.map((row) => row.detail).join("\n"), "pair_history_idx");
      const replyPlan = yield* sql<{ readonly detail: string }>`
        EXPLAIN QUERY PLAN
        SELECT message_id FROM civilization_messages
        WHERE project_id = ${PROJECT_ID} AND reply_to_message_id = 'mail:perf:05000'
        ORDER BY accepted_at ASC, message_id ASC LIMIT ${PAGE_SIZE + 1}
      `;
      assert.include(replyPlan.map((row) => row.detail).join("\n"), "reply_history_idx");

      const pairFirst = yield* service.listCorrespondenceHistory({
        projectId: PROJECT_ID,
        participantThreadId: TARGET_PARTICIPANT,
        counterpartyThreadId: PAIR_COUNTERPARTY,
        limit: PAGE_SIZE,
      });
      const pairFirstSwapped = yield* service.listCorrespondenceHistory({
        projectId: PROJECT_ID,
        participantThreadId: PAIR_COUNTERPARTY,
        counterpartyThreadId: TARGET_PARTICIPANT,
        limit: PAGE_SIZE,
      });
      assert.deepEqual(
        pairFirstSwapped.messages.map((message) => message.messageId),
        pairFirst.messages.map((message) => message.messageId),
      );
      assert.equal(pairFirstSwapped.nextCursor, pairFirst.nextCursor);
      const pairCursor = pairFirst.nextCursor;
      if (pairCursor === null) {
        return yield* Effect.die("dense correspondence pair must have a continued page");
      }
      const pairSecond = yield* service.listCorrespondenceHistory({
        projectId: PROJECT_ID,
        participantThreadId: PAIR_COUNTERPARTY,
        counterpartyThreadId: TARGET_PARTICIPANT,
        cursor: pairCursor,
        limit: PAGE_SIZE,
      });
      const pairMessages = [...pairFirst.messages, ...pairSecond.messages];
      assert.lengthOf(pairMessages, PAGE_SIZE * 2);
      assert.equal(
        new Set(pairMessages.map((message) => message.messageId)).size,
        pairMessages.length,
      );
      for (const message of pairMessages) {
        assert.isTrue(
          (message.senderThreadId === TARGET_PARTICIPANT &&
            message.recipientThreadId === PAIR_COUNTERPARTY) ||
            (message.senderThreadId === PAIR_COUNTERPARTY &&
              message.recipientThreadId === TARGET_PARTICIPANT),
          `unexpected outsider ${message.messageId}`,
        );
      }
      const expectedPairRows = yield* sql<{ readonly message_id: string }>`
        SELECT message_id FROM civilization_messages
        WHERE project_id = ${PROJECT_ID}
          AND (
            (sender_thread_id = ${TARGET_PARTICIPANT} AND recipient_thread_id = ${PAIR_COUNTERPARTY})
            OR
            (sender_thread_id = ${PAIR_COUNTERPARTY} AND recipient_thread_id = ${TARGET_PARTICIPANT})
          )
        ORDER BY accepted_at DESC, message_id DESC
        LIMIT ${PAGE_SIZE * 2}
      `;
      assert.deepEqual(
        pairMessages.map((message) => message.messageId),
        expectedPairRows.map((row) => row.message_id),
      );

      for (let index = 0; index < 5; index += 1) {
        yield* service.listCorrespondenceHistory({ projectId: PROJECT_ID, limit: PAGE_SIZE });
        yield* service.listCorrespondenceHistory({
          projectId: PROJECT_ID,
          participantThreadId: TARGET_PARTICIPANT,
          limit: PAGE_SIZE,
        });
        yield* service.listCorrespondenceHistory({
          projectId: PROJECT_ID,
          participantThreadId: TARGET_PARTICIPANT,
          counterpartyThreadId: PAIR_COUNTERPARTY,
          limit: PAGE_SIZE,
        });
        yield* service.listCorrespondenceHistory({
          projectId: PROJECT_ID,
          participantThreadId: PAIR_COUNTERPARTY,
          counterpartyThreadId: TARGET_PARTICIPANT,
          cursor: pairCursor,
          limit: PAGE_SIZE,
        });
        yield* service.readCorrespondenceThread({
          projectId: PROJECT_ID,
          messageId: "mail:perf:05005" as never,
          ancestorLimit: 12,
          descendantLimit: PAGE_SIZE,
        });
      }

      const pageSamples: number[] = [];
      const participantSamples: number[] = [];
      const selectiveSamples: number[] = [];
      const pairFirstPageSamples: number[] = [];
      const pairContinuedPageSamples: number[] = [];
      const threadSamples: number[] = [];
      const rssSamples: number[] = [];
      let maxBytes = 0;
      for (let index = 0; index < SAMPLES; index += 1) {
        const page = yield* timed(
          service.listCorrespondenceHistory({ projectId: PROJECT_ID, limit: PAGE_SIZE }),
        );
        pageSamples.push(page.elapsedMs);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(page.value), "utf8"));
        const participant = yield* timed(
          service.listCorrespondenceHistory({
            projectId: PROJECT_ID,
            participantThreadId: TARGET_PARTICIPANT,
            limit: PAGE_SIZE,
          }),
        );
        participantSamples.push(participant.elapsedMs);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(participant.value), "utf8"));
        const selective = yield* timed(
          service.listCorrespondenceHistory({
            projectId: PROJECT_ID,
            participantThreadId: TARGET_PARTICIPANT,
            deliveryEpoch: 7,
            acknowledged: false,
            terminal: false,
            limit: PAGE_SIZE,
          }),
        );
        selectiveSamples.push(selective.elapsedMs);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(selective.value), "utf8"));
        const pairFirstPage = yield* timed(
          service.listCorrespondenceHistory({
            projectId: PROJECT_ID,
            participantThreadId: TARGET_PARTICIPANT,
            counterpartyThreadId: PAIR_COUNTERPARTY,
            limit: PAGE_SIZE,
          }),
        );
        pairFirstPageSamples.push(pairFirstPage.elapsedMs);
        maxBytes = Math.max(
          maxBytes,
          Buffer.byteLength(JSON.stringify(pairFirstPage.value), "utf8"),
        );
        const pairContinuedPage = yield* timed(
          service.listCorrespondenceHistory({
            projectId: PROJECT_ID,
            participantThreadId: PAIR_COUNTERPARTY,
            counterpartyThreadId: TARGET_PARTICIPANT,
            cursor: pairCursor,
            limit: PAGE_SIZE,
          }),
        );
        pairContinuedPageSamples.push(pairContinuedPage.elapsedMs);
        maxBytes = Math.max(
          maxBytes,
          Buffer.byteLength(JSON.stringify(pairContinuedPage.value), "utf8"),
        );
        const thread = yield* timed(
          service.readCorrespondenceThread({
            projectId: PROJECT_ID,
            messageId: "mail:perf:05005" as never,
            ancestorLimit: 12,
            descendantLimit: PAGE_SIZE,
          }),
        );
        threadSamples.push(thread.elapsedMs);
        maxBytes = Math.max(maxBytes, Buffer.byteLength(JSON.stringify(thread.value), "utf8"));
        if ((index + 1) % 10 === 0) rssSamples.push(process.memoryUsage().rss);
      }

      assert.isAtMost(percentile(pageSamples, 0.95), P95_BUDGET_MS);
      assert.isAtMost(percentile(participantSamples, 0.95), P95_BUDGET_MS);
      assert.isAtMost(percentile(selectiveSamples, 0.95), P95_BUDGET_MS);
      assert.isAtMost(percentile(pairFirstPageSamples, 0.95), P95_BUDGET_MS);
      assert.isAtMost(percentile(pairContinuedPageSamples, 0.95), P95_BUDGET_MS);
      assert.isAtMost(percentile(threadSamples, 0.95), P95_BUDGET_MS);
      assert.isAtMost(maxBytes, MAX_RESPONSE_BYTES);
      const plateauStart =
        rssSamples[Math.floor(rssSamples.length / 2)] ?? process.memoryUsage().rss;
      const plateauEnd = rssSamples.at(-1) ?? plateauStart;
      assert.isAtMost(plateauEnd - plateauStart, MAX_RSS_PLATEAU_GROWTH);
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`)[0]?.count,
        0,
      );
    }).pipe(Effect.provide(testLayer)),
  { timeout: 120_000 },
);
