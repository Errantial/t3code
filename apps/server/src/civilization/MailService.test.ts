// @effect-diagnostics nodeBuiltinImport:off -- Receipt compatibility fixtures assert the exact stored SHA-256 wire hash.
import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type ProviderInteractionMode,
  type RuntimeMode,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailService from "./MailService.ts";

type FakeProviderCalls = {
  get: number;
  unexpectedProviderWork: number;
};

const fakeProviderLayer = (calls: FakeProviderCalls) => {
  const drivers: Readonly<Record<string, string>> = {
    "codex-main": "codex",
    "claude-main": "claudeAgent",
    "cursor-main": "cursor",
  };
  return Layer.succeed(
    ProviderAdapterRegistry.ProviderAdapterRegistryV2,
    ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
      get: (instanceId) => {
        calls.get += 1;
        const driver = drivers[instanceId];
        if (driver === undefined) {
          return Effect.fail(
            new ProviderAdapterRegistry.ProviderAdapterRegistryLookupError({ instanceId }),
          );
        }
        return Effect.succeed({
          instanceId,
          driver,
          openSession: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("MailService must not open provider sessions");
          },
          getCapabilities: () => {
            calls.unexpectedProviderWork += 1;
            return Effect.die("MailService must not inspect live provider capabilities");
          },
        } as unknown as ProviderAdapter.ProviderAdapterV2["Service"]);
      },
      list: () => Effect.succeed(Object.keys(drivers).map((id) => ProviderInstanceId.make(id))),
    }),
  );
};

const makeLayer = (calls: FakeProviderCalls) => {
  const database = SqlitePersistence.layerMemory;
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const providers = fakeProviderLayer(calls);
  const dependencies = Layer.mergeAll(database, config, providers);
  return Layer.mergeAll(dependencies, MailService.layer.pipe(Layer.provide(dependencies)));
};

type TestConfig = {
  readonly pendingPerRecipient?: number;
  readonly senderPerMinute?: number;
  readonly projectPerMinute?: number;
  readonly retainedMessageCount?: number;
  readonly retainedBodyBytes?: number;
  readonly unreadTtlDays?: number;
  readonly terminalRetentionDays?: number;
  readonly operationReceiptRetentionDays?: number;
  readonly responseBodyBytes?: number;
};

const enableFeature = Effect.fn("MailService.test.enableFeature")(function* (
  input: TestConfig = {},
) {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      messaging: {
        enabled: true,
        ...(input.pendingPerRecipient === undefined
          ? {}
          : { pendingPerRecipient: input.pendingPerRecipient }),
        ...(input.senderPerMinute === undefined ? {} : { senderPerMinute: input.senderPerMinute }),
        ...(input.projectPerMinute === undefined
          ? {}
          : { projectPerMinute: input.projectPerMinute }),
        ...(input.retainedMessageCount === undefined
          ? {}
          : { retainedMessageCount: input.retainedMessageCount }),
        ...(input.retainedBodyBytes === undefined
          ? {}
          : { retainedBodyBytes: input.retainedBodyBytes }),
        ...(input.unreadTtlDays === undefined ? {} : { unreadTtlDays: input.unreadTtlDays }),
      },
      operations: {
        ...(input.terminalRetentionDays === undefined
          ? {}
          : { terminalRetentionDays: input.terminalRetentionDays }),
        ...(input.operationReceiptRetentionDays === undefined
          ? {}
          : { operationReceiptRetentionDays: input.operationReceiptRetentionDays }),
        ...(input.responseBodyBytes === undefined
          ? {}
          : { responseBodyBytes: input.responseBodyBytes }),
      },
    },
  });
});

const seedProject = Effect.fn("MailService.test.seedProject")(function* (projectId: ProjectId) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization-mail', '[]',
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z', NULL
    )
  `;
});

type ActorSeed = {
  readonly threadId: ThreadId;
  readonly runId: RunId;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly runtimeMode?: RuntimeMode;
  readonly interactionMode?: ProviderInteractionMode;
  readonly observedOnly?: boolean;
  readonly closed?: boolean;
  readonly deleted?: boolean;
  readonly deliveryEpoch?: number;
  readonly deliverySettled?: boolean;
  readonly deliveryArchived?: boolean;
  readonly deliveryDeleted?: boolean;
  readonly withRun?: boolean;
};

const seedActor = Effect.fn("MailService.test.seedActor")(function* (
  projectId: ProjectId,
  input: ActorSeed,
) {
  const sql = yield* SqlClient.SqlClient;
  const provider = input.providerInstanceId ?? ProviderInstanceId.make("codex-main");
  const runtimeMode = input.runtimeMode ?? "full-access";
  const interactionMode = input.interactionMode ?? "default";
  const name = `Citizen ${input.threadId}`;
  yield* sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, provider_instance_id,
      runtime_mode, interaction_mode, active_provider_thread_id,
      created_at, updated_at, archived_at, deleted_at, payload_json
    ) VALUES (
      ${input.threadId}, ${projectId}, ${input.threadId}, ${provider}, ${provider},
      ${runtimeMode}, ${interactionMode}, NULL,
      '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z',
      ${input.deliveryArchived === true ? "2026-10-16T10:00:00.000Z" : null},
      ${input.deleted === true || input.deliveryDeleted === true ? "2026-10-16T10:00:00.000Z" : null},
      '{}'
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
      ${input.threadId}, ${projectId}, NULL, NULL, ${input.threadId},
      0, 'resolved', ${input.observedOnly === true ? 1 : 0}, 1, 1,
      ${`name:${input.threadId}`}, 1, ${name}, ${name}, ${input.threadId}, 'default-names',
      1, 0,
      'calm', 'Calm', '[]', '', 'default-profiles',
      1, 0,
      0, ${name}, NULL, ${name},
      NULL, NULL, NULL,
      0, ${input.closed === true ? 1 : 0}, ${input.deleted === true ? 1 : 0},
      ${input.deliveryEpoch ?? 0}, ${input.deliverySettled === true ? 1 : 0},
      ${input.deliveryArchived === true ? 1 : 0}, ${input.deliveryDeleted === true ? 1 : 0},
      1, '2026-10-16T10:00:00.000Z', '2026-10-16T10:00:00.000Z'
    )
  `;
  if (input.withRun !== false) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs (
        run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
        status, requested_at, completed_at, payload_json
      ) VALUES (
        ${input.runId}, ${input.threadId}, 1, ${provider}, ${provider}, NULL,
        'running', '2026-10-16T10:00:00.000Z', NULL, '{}'
      )
    `;
  }
});

const callerInput = (projectId: ProjectId, actor: ActorSeed) => ({
  projectId,
  threadId: actor.threadId,
  runId: actor.runId,
  providerInstanceId: actor.providerInstanceId ?? ProviderInstanceId.make("codex-main"),
  runtimeMode: actor.runtimeMode ?? ("full-access" as const),
  interactionMode: actor.interactionMode ?? ("default" as const),
});

const insertRetainedMessage = Effect.fn("MailService.test.insertRetainedMessage")(
  function* (input: {
    readonly messageId: string;
    readonly projectId: ProjectId;
    readonly senderThreadId: ThreadId;
    readonly recipientThreadId: ThreadId;
    readonly acceptedAt: string;
    readonly replyToMessageId?: string | null;
    readonly recipientDeliveryEpoch?: number;
    readonly acknowledgedAt?: string | null;
    readonly terminalAt?: string | null;
    readonly terminalReason?: "recipient_settled" | null;
    readonly contentKind?: "text" | "handoff_v1" | undefined;
    readonly body?: string | undefined;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const body = input.body ?? "retained-history-body";
    yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, content_kind, sender_thread_id, sender_name_at_send,
      sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
      reply_to_message_id, body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
      terminal_retention_days, first_offered_at, last_offered_at, offer_count,
      acknowledged_at, terminal_at, terminal_reason
    ) VALUES (
      ${input.messageId}, ${input.projectId}, ${input.contentKind ?? "text"}, ${input.senderThreadId}, ${`Sender ${input.senderThreadId}`},
      0, ${`run:${input.messageId}`}, ${input.recipientThreadId}, ${input.recipientDeliveryEpoch ?? 0},
      ${input.replyToMessageId ?? null}, ${body}, ${Buffer.byteLength(body, "utf8")}, 'full-access', 'default',
      0, 0, ${input.acceptedAt}, '2026-11-17T12:00:00.000Z', 30,
      NULL, NULL, 0, ${input.acknowledgedAt ?? null}, ${input.terminalAt ?? null},
      ${input.terminalReason ?? null}
    )
  `;
  },
);

const errorTag = (value: unknown) => (value as { readonly _tag?: string })._tag;
const errorReason = (value: unknown) => (value as { readonly reason?: string }).reason;
const payloadHash = (value: unknown) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

it.effect("lists correspondence with revision-bound filters without reading bodies", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:mail:correspondence-list");
    const a = ThreadId.make("thread:mail:correspondence:a");
    const b = ThreadId.make("thread:mail:correspondence:b");
    const c = ThreadId.make("thread:mail:correspondence:c");
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, { threadId: a, runId: RunId.make("run:correspondence:a") });
    yield* seedActor(projectId, { threadId: b, runId: RunId.make("run:correspondence:b") });
    yield* seedActor(projectId, { threadId: c, runId: RunId.make("run:correspondence:c") });
    yield* insertRetainedMessage({
      messageId: "mail:correspondence:root",
      projectId,
      senderThreadId: a,
      recipientThreadId: b,
      acceptedAt: "2026-10-17T10:00:00.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:correspondence:reply",
      projectId,
      senderThreadId: b,
      recipientThreadId: a,
      acceptedAt: "2026-10-17T10:01:00.000Z",
      replyToMessageId: "mail:correspondence:root",
      acknowledgedAt: "2026-10-17T10:01:30.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:correspondence:nested",
      projectId,
      senderThreadId: a,
      recipientThreadId: b,
      acceptedAt: "2026-10-17T10:02:00.000Z",
      replyToMessageId: "mail:correspondence:reply",
      recipientDeliveryEpoch: 2,
      terminalAt: "2026-10-17T10:02:30.000Z",
      terminalReason: "recipient_settled",
    });
    yield* insertRetainedMessage({
      messageId: "mail:correspondence:other",
      projectId,
      senderThreadId: c,
      recipientThreadId: a,
      acceptedAt: "2026-10-17T10:03:00.000Z",
    });

    const participant = yield* service.listCorrespondenceHistory({
      projectId,
      participantThreadId: a,
      from: "2026-10-17T04:01:00-06:00",
      to: "2026-10-17T10:03:00.000Z",
      limit: 10,
    });
    assert.deepEqual(
      participant.messages.map((message) => message.messageId),
      ["mail:correspondence:nested", "mail:correspondence:reply"],
      "time windows are canonical and half-open",
    );
    assert.notInclude(JSON.stringify(participant), "retained-history-body");
    assert.deepEqual(participant.citizenReferences, [
      { threadId: a, name: `Citizen ${a}` },
      { threadId: b, name: `Citizen ${b}` },
    ]);

    const roots = yield* service.listCorrespondenceHistory({
      projectId,
      replyRelation: "root",
      limit: 10,
    });
    assert.deepEqual(
      roots.messages.map((message) => message.messageId),
      ["mail:correspondence:other", "mail:correspondence:root"],
    );
    const replies = yield* service.listCorrespondenceHistory({
      projectId,
      replyRelation: "replies_to",
      replyToMessageId: "mail:correspondence:root" as never,
      limit: 10,
    });
    assert.deepEqual(
      replies.messages.map((message) => message.messageId),
      ["mail:correspondence:reply"],
    );
    const acknowledged = yield* service.listCorrespondenceHistory({
      projectId,
      acknowledged: true,
      limit: 10,
    });
    assert.deepEqual(
      acknowledged.messages.map((message) => message.messageId),
      ["mail:correspondence:reply"],
    );
    const terminal = yield* service.listCorrespondenceHistory({
      projectId,
      terminal: true,
      limit: 10,
    });
    assert.deepEqual(
      terminal.messages.map((message) => message.messageId),
      ["mail:correspondence:nested"],
    );
    const epoch = yield* service.listCorrespondenceHistory({
      projectId,
      deliveryEpoch: 2,
      limit: 10,
    });
    assert.deepEqual(
      epoch.messages.map((message) => message.messageId),
      ["mail:correspondence:nested"],
    );

    const first = yield* service.listCorrespondenceHistory({ projectId, limit: 2 });
    assert.isNotNull(first.nextCursor);
    const revision = first.revision;
    yield* sql`
      UPDATE civilization_messages
      SET acknowledged_at = '2026-10-17T10:04:00.000Z'
      WHERE message_id = 'mail:correspondence:other'
    `;
    const second = yield* service.listCorrespondenceHistory({
      projectId,
      cursor: first.nextCursor!,
      limit: 2,
    });
    assert.equal(second.revision, revision, "delivery-state churn must not stale history paging");
    assert.deepEqual(
      second.messages.map((message) => message.messageId),
      ["mail:correspondence:reply", "mail:correspondence:root"],
    );

    yield* insertRetainedMessage({
      messageId: "mail:correspondence:new-membership",
      projectId,
      senderThreadId: b,
      recipientThreadId: c,
      acceptedAt: "2026-10-17T10:04:00.000Z",
    });
    const stale = yield* service
      .listCorrespondenceHistory({ projectId, cursor: first.nextCursor!, limit: 2 })
      .pipe(Effect.flip);
    assert.equal(errorReason(stale), "invalid_cursor");

    const invalidReply = yield* service
      .listCorrespondenceHistory({ projectId, replyRelation: "replies_to", limit: 10 })
      .pipe(Effect.flip);
    assert.equal(errorReason(invalidReply), "invalid_cursor");
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect("filters correspondence content kind before paging and binds it into cursors", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:correspondence-content-kind");
    const sender = ThreadId.make("thread:mail:content-kind:sender");
    const recipient = ThreadId.make("thread:mail:content-kind:recipient");
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, {
      threadId: sender,
      runId: RunId.make("run:correspondence-content-kind:sender"),
    });
    yield* seedActor(projectId, {
      threadId: recipient,
      runId: RunId.make("run:correspondence-content-kind:recipient"),
    });
    yield* insertRetainedMessage({
      messageId: "mail:content-kind:handoff-old",
      projectId,
      senderThreadId: sender,
      recipientThreadId: recipient,
      acceptedAt: "2026-10-17T10:00:00.000Z",
      contentKind: "handoff_v1",
      body: JSON.stringify({
        version: 1,
        summary: "Older handoff",
        completed: [],
        decisions: [],
        nextActions: [],
        blockersOrQuestions: [],
        references: [],
      }),
    });
    yield* insertRetainedMessage({
      messageId: "mail:content-kind:handoff-new",
      projectId,
      senderThreadId: sender,
      recipientThreadId: recipient,
      acceptedAt: "2026-10-17T10:02:00.000Z",
      contentKind: "handoff_v1",
      body: JSON.stringify({
        version: 1,
        summary: "Newer handoff",
        completed: [],
        decisions: [],
        nextActions: [],
        blockersOrQuestions: [],
        references: [],
      }),
    });
    yield* insertRetainedMessage({
      messageId: "mail:content-kind:text-newest",
      projectId,
      senderThreadId: sender,
      recipientThreadId: recipient,
      acceptedAt: "2026-10-17T10:03:00.000Z",
    });

    const first = yield* service.listCorrespondenceHistory({
      projectId,
      contentKind: "handoff_v1",
      limit: 1,
    });
    assert.deepEqual(
      first.messages.map((message) => [message.messageId, message.contentKind]),
      [["mail:content-kind:handoff-new", "handoff_v1"]],
      "content-kind selection must happen in SQL before LIMIT",
    );
    assert.isNotNull(first.nextCursor);

    const second = yield* service.listCorrespondenceHistory({
      projectId,
      contentKind: "handoff_v1",
      cursor: first.nextCursor!,
      limit: 1,
    });
    assert.deepEqual(
      second.messages.map((message) => message.messageId),
      ["mail:content-kind:handoff-old"],
    );

    const mismatchedCursor = yield* service
      .listCorrespondenceHistory({
        projectId,
        contentKind: "text",
        cursor: first.nextCursor!,
        limit: 1,
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(mismatchedCursor), "invalid_cursor");
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect("lists an unordered citizen pair through canonical bounded directional branches", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:mail:correspondence-pair");
    const a = ThreadId.make("thread:mail:pair:a");
    const b = ThreadId.make("thread:mail:pair:b");
    const c = ThreadId.make("thread:mail:pair:c");
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, { threadId: a, runId: RunId.make("run:pair:a") });
    yield* seedActor(projectId, { threadId: b, runId: RunId.make("run:pair:b") });
    yield* seedActor(projectId, { threadId: c, runId: RunId.make("run:pair:c") });

    yield* insertRetainedMessage({
      messageId: "mail:pair:root",
      projectId,
      senderThreadId: a,
      recipientThreadId: b,
      acceptedAt: "2026-10-17T10:00:00.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:pair:reply",
      projectId,
      senderThreadId: b,
      recipientThreadId: a,
      acceptedAt: "2026-10-17T10:01:00.000Z",
      replyToMessageId: "mail:pair:root",
      acknowledgedAt: "2026-10-17T10:01:30.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:pair:terminal",
      projectId,
      senderThreadId: a,
      recipientThreadId: b,
      acceptedAt: "2026-10-17T10:02:00.000Z",
      replyToMessageId: "mail:pair:reply",
      recipientDeliveryEpoch: 2,
      terminalAt: "2026-10-17T10:02:30.000Z",
      terminalReason: "recipient_settled",
    });
    yield* insertRetainedMessage({
      messageId: "mail:pair:tie-y",
      projectId,
      senderThreadId: b,
      recipientThreadId: a,
      acceptedAt: "2026-10-17T10:03:00.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:pair:tie-z",
      projectId,
      senderThreadId: a,
      recipientThreadId: b,
      acceptedAt: "2026-10-17T10:03:00.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:pair:outsider-a-c",
      projectId,
      senderThreadId: a,
      recipientThreadId: c,
      acceptedAt: "2026-10-17T10:04:00.000Z",
    });
    yield* insertRetainedMessage({
      messageId: "mail:pair:outsider-c-b",
      projectId,
      senderThreadId: c,
      recipientThreadId: b,
      acceptedAt: "2026-10-17T10:05:00.000Z",
    });

    const pairPlan = yield* sql<{ readonly detail: string }>`
      EXPLAIN QUERY PLAN
      SELECT message_id
      FROM civilization_messages
      WHERE project_id = ${projectId}
        AND sender_thread_id = ${a}
        AND recipient_thread_id = ${b}
        AND (accepted_at < ${"2026-10-17T10:03:00.000Z"}
          OR (accepted_at = ${"2026-10-17T10:03:00.000Z"} AND message_id < ${"mail:pair:tie-z"}))
      ORDER BY accepted_at DESC, message_id DESC
      LIMIT 3
    `;
    assert.isTrue(
      pairPlan.some((row) => row.detail.includes("civilization_messages_pair_history_idx")),
      "pair branches must use migration075's sender/recipient history index",
    );

    const first = yield* service.listCorrespondenceHistory({
      projectId,
      participantThreadId: b,
      counterpartyThreadId: a,
      limit: 2,
    });
    assert.deepEqual(
      first.messages.map((message) => message.messageId),
      ["mail:pair:tie-z", "mail:pair:tie-y"],
      "pair merge keeps the existing accepted-time/message-id ordering across directions",
    );
    assert.isNotNull(first.nextCursor);
    assert.deepEqual(first.citizenReferences, [
      { threadId: a, name: `Citizen ${a}` },
      { threadId: b, name: `Citizen ${b}` },
    ]);
    assert.notInclude(JSON.stringify(first), "retained-history-body");

    const swappedSecond = yield* service.listCorrespondenceHistory({
      projectId,
      participantThreadId: a,
      counterpartyThreadId: b,
      cursor: first.nextCursor!,
      limit: 3,
    });
    assert.deepEqual(
      swappedSecond.messages.map((message) => message.messageId),
      ["mail:pair:terminal", "mail:pair:reply", "mail:pair:root"],
      "the cursor identity is canonical for swapped A/B inputs and excludes outsiders",
    );

    const acknowledged = yield* service.listCorrespondenceHistory({
      projectId,
      participantThreadId: a,
      counterpartyThreadId: b,
      acknowledged: true,
      limit: 10,
    });
    assert.deepEqual(
      acknowledged.messages.map((message) => message.messageId),
      ["mail:pair:reply"],
    );
    const terminal = yield* service.listCorrespondenceHistory({
      projectId,
      participantThreadId: a,
      counterpartyThreadId: b,
      terminal: true,
      deliveryEpoch: 2,
      limit: 10,
    });
    assert.deepEqual(
      terminal.messages.map((message) => message.messageId),
      ["mail:pair:terminal"],
    );
    const roots = yield* service.listCorrespondenceHistory({
      projectId,
      participantThreadId: a,
      counterpartyThreadId: b,
      replyRelation: "root",
      from: "2026-10-17T09:59:00.000Z",
      to: "2026-10-17T10:01:00.000Z",
      limit: 10,
    });
    assert.deepEqual(
      roots.messages.map((message) => message.messageId),
      ["mail:pair:root"],
    );

    const invalidInputs: ReadonlyArray<MailService.CorrespondenceHistoryInput> = [
      { projectId, counterpartyThreadId: b },
      { projectId, participantThreadId: a, counterpartyThreadId: a },
      { projectId, participantThreadId: a, counterpartyThreadId: b, senderThreadId: a },
      { projectId, participantThreadId: a, counterpartyThreadId: b, recipientThreadId: b },
    ];
    for (const invalidInput of invalidInputs) {
      const failure = yield* service.listCorrespondenceHistory(invalidInput).pipe(Effect.flip);
      assert.equal(errorReason(failure), "invalid_cursor");
    }

    const wrongPair = yield* service
      .listCorrespondenceHistory({
        projectId,
        participantThreadId: a,
        counterpartyThreadId: c,
        cursor: first.nextCursor!,
        limit: 2,
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(wrongPair), "invalid_cursor");

    yield* insertRetainedMessage({
      messageId: "mail:pair:new-membership",
      projectId,
      senderThreadId: b,
      recipientThreadId: a,
      acceptedAt: "2026-10-17T10:06:00.000Z",
    });
    const stale = yield* service
      .listCorrespondenceHistory({
        projectId,
        participantThreadId: b,
        counterpartyThreadId: a,
        cursor: first.nextCursor!,
        limit: 2,
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(stale), "invalid_cursor");
    assert.equal(calls.get, 0);
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "returns deterministic bounded anchored correspondence segments with explicit root status",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:correspondence-thread");
      const a = ThreadId.make("thread:mail:thread:a");
      const b = ThreadId.make("thread:mail:thread:b");
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, { threadId: a, runId: RunId.make("run:thread:a") });
      yield* seedActor(projectId, { threadId: b, runId: RunId.make("run:thread:b") });
      yield* insertRetainedMessage({
        messageId: "mail:thread:root",
        projectId,
        senderThreadId: a,
        recipientThreadId: b,
        acceptedAt: "2026-10-17T11:00:00.000Z",
      });
      yield* insertRetainedMessage({
        messageId: "mail:thread:one",
        projectId,
        senderThreadId: b,
        recipientThreadId: a,
        replyToMessageId: "mail:thread:root",
        acceptedAt: "2026-10-17T11:01:00.000Z",
      });
      yield* insertRetainedMessage({
        messageId: "mail:thread:two",
        projectId,
        senderThreadId: a,
        recipientThreadId: b,
        replyToMessageId: "mail:thread:one",
        acceptedAt: "2026-10-17T11:02:00.000Z",
      });
      yield* insertRetainedMessage({
        messageId: "mail:thread:child-z",
        projectId,
        senderThreadId: b,
        recipientThreadId: a,
        replyToMessageId: "mail:thread:two",
        acceptedAt: "2026-10-17T11:04:00.000Z",
      });
      yield* insertRetainedMessage({
        messageId: "mail:thread:child-a",
        projectId,
        senderThreadId: b,
        recipientThreadId: a,
        replyToMessageId: "mail:thread:two",
        acceptedAt: "2026-10-17T11:03:00.000Z",
      });
      yield* insertRetainedMessage({
        messageId: "mail:thread:grandchild",
        projectId,
        senderThreadId: a,
        recipientThreadId: b,
        replyToMessageId: "mail:thread:child-a",
        acceptedAt: "2026-10-17T11:05:00.000Z",
      });

      const segment = yield* service.readCorrespondenceThread({
        projectId,
        messageId: "mail:thread:two" as never,
        ancestorLimit: 4,
        descendantLimit: 2,
      });
      assert.equal(segment.rootStatus, "resolved");
      assert.isFalse(segment.ancestorTruncated);
      assert.isTrue(segment.descendantsTruncated);
      assert.deepEqual(
        segment.entries.map((entry) => [entry.message.messageId, entry.relation, entry.depth]),
        [
          ["mail:thread:root", "ancestor", -2],
          ["mail:thread:one", "ancestor", -1],
          ["mail:thread:two", "selected", 0],
          ["mail:thread:child-a", "descendant", 1],
          ["mail:thread:child-z", "descendant", 1],
        ],
        "wide descendants use deterministic breadth-first accepted-time order",
      );
      assert.notInclude(JSON.stringify(segment), "retained-history-body");
      assert.deepEqual(segment.citizenReferences, [
        { threadId: a, name: `Citizen ${a}` },
        { threadId: b, name: `Citizen ${b}` },
      ]);

      const depthLimited = yield* service.readCorrespondenceThread({
        projectId,
        messageId: "mail:thread:two" as never,
        ancestorLimit: 1,
        descendantLimit: 1,
      });
      assert.equal(depthLimited.rootStatus, "depth_limit");
      assert.isTrue(depthLimited.ancestorTruncated);

      yield* insertRetainedMessage({
        messageId: "mail:thread:missing-parent",
        projectId,
        senderThreadId: a,
        recipientThreadId: b,
        replyToMessageId: "mail:thread:purged-parent",
        acceptedAt: "2026-10-17T11:06:00.000Z",
      });
      const unresolved = yield* service.readCorrespondenceThread({
        projectId,
        messageId: "mail:thread:missing-parent" as never,
        ancestorLimit: 4,
        descendantLimit: 2,
      });
      assert.equal(unresolved.rootStatus, "missing_parent");
      assert.isFalse(unresolved.ancestorTruncated);
      assert.isTrue(
        unresolved.entries.find((entry) => entry.relation === "selected")?.unresolvedParent,
      );
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("derives an authoritative caller from the live host run and supported provider", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:caller");
    const actor: ActorSeed = {
      threadId: ThreadId.make("thread:mail:caller"),
      runId: RunId.make("run:mail:caller"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, actor);

    const caller = yield* service.authoritativeCaller(callerInput(projectId, actor));
    assert.deepEqual(caller, {
      ...callerInput(projectId, actor),
      citizenEpoch: 0,
      deliveryEpoch: 0,
    });
    assert.equal(calls.get, 1);
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "sends atomically and replays an identical request without double quota or receipt",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:send");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:send:from"),
        runId: RunId.make("run:mail:send:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:send:to"),
        runId: RunId.make("run:mail:send:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));

      const input = {
        caller,
        targetThreadId: recipient.threadId,
        clientRequestId: "send:one",
        body: "hello",
      } as const;
      const first = yield* service.send(input);
      const replay = yield* service.send(input);
      assert.equal(replay.message.messageId, first.message.messageId);

      const changed = yield* service.send({ ...input, body: "different" }).pipe(Effect.flip);
      assert.equal(errorTag(changed), "CivilizationMailConflictError");
      assert.equal(errorReason(changed), "idempotency_conflict");
      assert.deepEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM civilization_messages`)[0],
        { count: 1 },
      );
      assert.deepEqual(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts`)[0],
        { count: 1 },
      );
      assert.deepEqual(
        yield* sql<{ readonly scope_kind: string; readonly accepted_count: number }>`
        SELECT scope_kind, accepted_count FROM civilization_mail_quota_windows ORDER BY scope_kind ASC
      `,
        [
          { scope_kind: "project", accepted_count: 1 },
          { scope_kind: "sender", accepted_count: 1 },
        ],
      );
      assert.deepEqual(
        (yield* sql<{
          readonly retained_message_count: number;
          readonly retained_body_bytes: number;
        }>`
        SELECT retained_message_count, retained_body_bytes FROM civilization_project_state WHERE project_id = ${projectId}
      `)[0],
        { retained_message_count: 1, retained_body_bytes: 5 },
      );
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox`)[0]?.count,
        0,
      );
      assert.equal(calls.unexpectedProviderWork, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect(
  "sends canonical structured handoffs through the passive mail transaction and renders them deterministically",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:handoff");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:handoff:from"),
        runId: RunId.make("run:mail:handoff:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:handoff:to"),
        runId: RunId.make("run:mail:handoff:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      const runsBefore =
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs
          WHERE thread_id = ${recipient.threadId}
        `)[0]?.count ?? 0;
      const handoff = {
        version: 1,
        summary: "Core handoff is ready.",
        completed: ["Added durable storage."],
        decisions: ["Keep delivery passive."],
        nextActions: ["Wire the existing consumer."],
        blockersOrQuestions: ["Confirm final presentation copy."],
        references: [{ kind: "thread", reference: String(recipient.threadId) }],
      } as const;
      const canonicalBody = JSON.stringify({
        version: 1,
        summary: handoff.summary,
        completed: [...handoff.completed],
        decisions: [...handoff.decisions],
        nextActions: [...handoff.nextActions],
        blockersOrQuestions: [...handoff.blockersOrQuestions],
        references: handoff.references.map(({ kind, reference }) => ({ kind, reference })),
      });
      const input = {
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "handoff:send",
        handoff,
      } as const;

      const first = yield* service.sendHandoff(input);
      const replay = yield* service.sendHandoff(input);
      assert.equal(replay.message.messageId, first.message.messageId);
      assert.equal(first.message.contentKind, "handoff_v1");
      assert.equal(first.message.bodyBytes, Buffer.byteLength(canonicalBody, "utf8"));

      const stored = (yield* sql<{
        readonly content_kind: string;
        readonly body: string;
        readonly body_bytes: number;
      }>`
        SELECT content_kind, body, body_bytes FROM civilization_messages
        WHERE message_id = ${first.message.messageId}
      `)[0]!;
      assert.deepStrictEqual(stored, {
        content_kind: "handoff_v1",
        body: canonicalBody,
        body_bytes: Buffer.byteLength(canonicalBody, "utf8"),
      });
      assert.deepStrictEqual(
        (yield* sql<{
          readonly content_kind: string | null;
          readonly canonical_payload_hash: string;
        }>`
          SELECT content_kind, canonical_payload_hash
          FROM civilization_mail_operation_receipts
          WHERE client_request_id = 'handoff:send'
        `)[0],
        {
          content_kind: "handoff_v1",
          canonical_payload_hash: payloadHash({
            contentKind: "handoff_v1",
            targetThreadId: recipient.threadId,
            body: canonicalBody,
            replyToMessageId: null,
          }),
        },
      );

      const changed = yield* service
        .sendHandoff({
          ...input,
          handoff: { ...handoff, summary: "Changed under the same request id." },
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(changed), "CivilizationMailConflictError");
      assert.equal(errorReason(changed), "idempotency_conflict");

      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_projection_runs
          WHERE thread_id = ${recipient.threadId}
        `)[0]?.count,
        runsBefore,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
        `)[0]?.count,
        0,
      );
      assert.equal(calls.unexpectedProviderWork, 0);

      const inbox = yield* service.listInbox({ caller: recipientCaller });
      assert.equal(inbox.messages[0]?.contentKind, "handoff_v1");
      const received = yield* service.receive({
        caller: recipientCaller,
        messageId: first.message.messageId,
        clientRequestId: "handoff:receive",
      });
      assert.equal(received.message.contentKind, "handoff_v1");
      if (received.message.contentKind === "handoff_v1") {
        assert.deepStrictEqual(received.message.handoff, handoff);
        assert.equal(
          received.message.body,
          [
            "Summary:\nCore handoff is ready.",
            "Completed:\n- Added durable storage.",
            "Decisions:\n- Keep delivery passive.",
            "Next actions:\n- Wire the existing consumer.",
            "Blockers or questions:\n- Confirm final presentation copy.",
            `References:\n- thread: ${recipient.threadId}`,
          ].join("\n\n"),
        );
      }
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("replays the exact pre-080 text hash but never a legacy-shaped handoff hash", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:legacy-receipt");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:legacy-receipt:from"),
      runId: RunId.make("run:mail:legacy-receipt:from"),
    };
    const recipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:legacy-receipt:to"),
      runId: RunId.make("run:mail:legacy-receipt:to"),
    };
    yield* seedProject(projectId);
    yield* enableFeature({ pendingPerRecipient: 10, senderPerMinute: 10, projectPerMinute: 10 });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));

    const textInput = {
      caller,
      targetThreadId: recipient.threadId,
      clientRequestId: "legacy:text",
      body: "legacy-compatible text",
    } as const;
    const text = yield* service.send(textInput);
    const legacyTextHash = payloadHash({
      targetThreadId: recipient.threadId,
      body: textInput.body,
      replyToMessageId: null,
    });
    yield* sql`
      UPDATE civilization_mail_operation_receipts
      SET content_kind = NULL, canonical_payload_hash = ${legacyTextHash}
      WHERE client_request_id = ${textInput.clientRequestId}
    `;
    const legacyReplay = yield* service.send(textInput);
    assert.equal(legacyReplay.message.messageId, text.message.messageId);
    assert.equal(legacyReplay.message.contentKind, "text");

    const handoff = {
      version: 1,
      summary: "No legacy handoff hash.",
      completed: [],
      decisions: [],
      nextActions: [],
      blockersOrQuestions: [],
      references: [],
    } as const;
    const handoffInput = {
      caller,
      targetThreadId: recipient.threadId,
      clientRequestId: "legacy:handoff",
      handoff,
    } as const;
    const sentHandoff = yield* service.sendHandoff(handoffInput);
    const canonicalHandoff = JSON.stringify(handoff);
    const impossibleLegacyHandoffHash = payloadHash({
      targetThreadId: recipient.threadId,
      body: canonicalHandoff,
      replyToMessageId: null,
    });
    yield* sql`
      UPDATE civilization_mail_operation_receipts
      SET content_kind = NULL, canonical_payload_hash = ${impossibleLegacyHandoffHash}
      WHERE client_request_id = ${handoffInput.clientRequestId}
    `;
    const rejectedLegacyHandoff = yield* service.sendHandoff(handoffInput).pipe(Effect.flip);
    assert.equal(errorTag(rejectedLegacyHandoff), "CivilizationMailConflictError");
    assert.equal(errorReason(rejectedLegacyHandoff), "idempotency_conflict");
    assert.equal(sentHandoff.message.contentKind, "handoff_v1");
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "rejects invalid structured handoff bounds and fails closed on corrupt stored handoffs",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:handoff-invalid");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:handoff-invalid:from"),
        runId: RunId.make("run:mail:handoff-invalid:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:handoff-invalid:to"),
        runId: RunId.make("run:mail:handoff-invalid:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature({ pendingPerRecipient: 10, senderPerMinute: 10, projectPerMinute: 10 });
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));

      const base = {
        version: 1,
        summary: "Valid summary",
        completed: [],
        decisions: [],
        nextActions: [],
        blockersOrQuestions: [],
        references: [],
      } as const;
      const tooManyItems = yield* service
        .sendHandoff({
          caller: senderCaller,
          targetThreadId: recipient.threadId,
          clientRequestId: "invalid:items",
          handoff: { ...base, completed: Array.from({ length: 9 }, (_, index) => `item ${index}`) },
        } as never)
        .pipe(Effect.flip);
      assert.equal(errorReason(tooManyItems), "invalid_message");
      const longKind = yield* service
        .sendHandoff({
          caller: senderCaller,
          targetThreadId: recipient.threadId,
          clientRequestId: "invalid:kind",
          handoff: { ...base, references: [{ kind: "k".repeat(129), reference: "ref" }] },
        } as never)
        .pipe(Effect.flip);
      assert.equal(errorReason(longKind), "invalid_message");
      const longReference = yield* service
        .sendHandoff({
          caller: senderCaller,
          targetThreadId: recipient.threadId,
          clientRequestId: "invalid:reference",
          handoff: { ...base, references: [{ kind: "kind", reference: "r".repeat(1025) }] },
        } as never)
        .pipe(Effect.flip);
      assert.equal(errorReason(longReference), "invalid_message");
      const oversizedCanonicalBody = yield* service
        .sendHandoff({
          caller: senderCaller,
          targetThreadId: recipient.threadId,
          clientRequestId: "invalid:total-bytes",
          handoff: {
            ...base,
            references: Array.from({ length: 4 }, (_, index) => ({
              kind: `ref-${index}`,
              reference: "r".repeat(1024),
            })),
          },
        })
        .pipe(Effect.flip);
      assert.equal(errorReason(oversizedCanonicalBody), "message_too_large");

      yield* insertRetainedMessage({
        messageId: "mail:corrupt-handoff",
        projectId,
        senderThreadId: sender.threadId,
        recipientThreadId: recipient.threadId,
        acceptedAt: "2026-10-18T11:00:00.000Z",
        contentKind: "handoff_v1",
        body: '{"version":1,"summary":',
      });
      const inbox = yield* service.listInbox({ caller: recipientCaller });
      assert.equal(inbox.messages[0]?.contentKind, "handoff_v1");

      const receiveError = yield* service
        .receive({
          caller: recipientCaller,
          messageId: "mail:corrupt-handoff" as never,
          clientRequestId: "corrupt:receive",
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(receiveError), "CivilizationMailInvalidError");
      assert.equal(errorReason(receiveError), "corrupt_message");
      assert.deepStrictEqual(
        (yield* sql<{ readonly offer_count: number }>`
        SELECT offer_count FROM civilization_messages WHERE message_id = 'mail:corrupt-handoff'
      `)[0],
        { offer_count: 0 },
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_mail_operation_receipts
        WHERE client_request_id = 'corrupt:receive'
      `)[0]?.count,
        0,
      );

      const adminError = yield* service
        .readAdminMessage({ projectId, messageId: "mail:corrupt-handoff" as never })
        .pipe(Effect.flip);
      assert.equal(errorReason(adminError), "corrupt_message");
      const contextError = yield* service
        .selectInboxForContext({ caller: recipientCaller, limit: 5, selection: "recent" })
        .pipe(Effect.flip);
      assert.equal(errorReason(contextError), "corrupt_message");
      const wouldOfferError = yield* service
        .wouldOfferInboxForContext({
          caller: recipientCaller,
          messageIds: ["mail:corrupt-handoff" as never],
        })
        .pipe(Effect.flip);
      assert.equal(errorReason(wouldOfferError), "corrupt_message");
      const offerError = yield* service
        .offerInboxForContext({
          caller: recipientCaller,
          messageIds: ["mail:corrupt-handoff" as never],
        })
        .pipe(Effect.flip);
      assert.equal(errorReason(offerError), "corrupt_message");
      assert.deepStrictEqual(
        (yield* sql<{ readonly offer_count: number }>`
        SELECT offer_count FROM civilization_messages WHERE message_id = 'mail:corrupt-handoff'
      `)[0],
        { offer_count: 0 },
      );
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("rejects unsupported, observed, self, closed and above-ceiling recipients", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:reject");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:from"),
      runId: RunId.make("run:mail:reject:from"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, sender);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    const sendTo = (targetThreadId: ThreadId, clientRequestId: string) =>
      service.send({ caller, targetThreadId, clientRequestId, body: "hello" });

    const self = yield* sendTo(sender.threadId, "reject:self").pipe(Effect.flip);
    assert.equal(errorReason(self), "self_send");

    const unsupported: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:unsupported"),
      runId: RunId.make("run:mail:reject:unsupported"),
      providerInstanceId: ProviderInstanceId.make("cursor-main"),
    };
    yield* seedActor(projectId, unsupported);
    const unsupportedError = yield* sendTo(unsupported.threadId, "reject:unsupported").pipe(
      Effect.flip,
    );
    assert.equal(errorReason(unsupportedError), "unsupported_provider");

    const observed: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:observed"),
      runId: RunId.make("run:mail:reject:observed"),
      observedOnly: true,
    };
    yield* seedActor(projectId, observed);
    const observedError = yield* sendTo(observed.threadId, "reject:observed").pipe(Effect.flip);
    assert.equal(errorReason(observedError), "observed_agent_read_only");

    const closed: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:closed"),
      runId: RunId.make("run:mail:reject:closed"),
      closed: true,
      deliverySettled: true,
    };
    yield* seedActor(projectId, closed);
    const closedError = yield* sendTo(closed.threadId, "reject:closed").pipe(Effect.flip);
    assert.equal(errorReason(closedError), "closed_citizen");

    const lowSender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:low-sender"),
      runId: RunId.make("run:mail:reject:low-sender"),
      runtimeMode: "approval-required",
      interactionMode: "plan",
    };
    const highTarget: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reject:high-target"),
      runId: RunId.make("run:mail:reject:high-target"),
      runtimeMode: "full-access",
      interactionMode: "default",
    };
    yield* seedActor(projectId, lowSender);
    yield* seedActor(projectId, highTarget);
    const lowCaller = yield* service.authoritativeCaller(callerInput(projectId, lowSender));
    const ceilingError = yield* service
      .send({
        caller: lowCaller,
        targetThreadId: highTarget.threadId,
        clientRequestId: "reject:ceiling",
        body: "hello",
      })
      .pipe(Effect.flip);
    assert.equal(errorReason(ceilingError), "forbidden");
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "enforces recipient pending capacity and sender per-minute quota before extra acceptance",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:limits");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:limits:from"),
        runId: RunId.make("run:mail:limits:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:limits:to"),
        runId: RunId.make("run:mail:limits:to"),
      };
      const other: ActorSeed = {
        threadId: ThreadId.make("thread:mail:limits:other"),
        runId: RunId.make("run:mail:limits:other"),
      };
      yield* seedProject(projectId);
      yield* enableFeature({ pendingPerRecipient: 1, senderPerMinute: 1, projectPerMinute: 10 });
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      yield* seedActor(projectId, other);
      const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      yield* service.send({
        caller,
        targetThreadId: recipient.threadId,
        clientRequestId: "limits:first",
        body: "one",
      });
      const pending = yield* service
        .send({
          caller,
          targetThreadId: recipient.threadId,
          clientRequestId: "limits:pending",
          body: "two",
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(pending), "CivilizationMailCapacityError");
      assert.equal(errorReason(pending), undefined);
      const quota = yield* service
        .send({
          caller,
          targetThreadId: other.threadId,
          clientRequestId: "limits:quota",
          body: "two",
        })
        .pipe(Effect.flip);
      assert.equal(errorTag(quota), "CivilizationMailQuotaError");
      assert.equal((quota as { readonly scope?: string }).scope, "sender");
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("enforces retained project message capacity independently of pending delivery", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:retained-capacity");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:retained-capacity:from"),
      runId: RunId.make("run:mail:retained-capacity:from"),
    };
    const firstRecipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:retained-capacity:first"),
      runId: RunId.make("run:mail:retained-capacity:first"),
    };
    const secondRecipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:retained-capacity:second"),
      runId: RunId.make("run:mail:retained-capacity:second"),
    };
    yield* seedProject(projectId);
    yield* enableFeature({
      retainedMessageCount: 1,
      pendingPerRecipient: 10,
      senderPerMinute: 10,
      projectPerMinute: 10,
    });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, firstRecipient);
    yield* seedActor(projectId, secondRecipient);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    yield* service.send({
      caller,
      targetThreadId: firstRecipient.threadId,
      clientRequestId: "retained:first",
      body: "one",
    });
    const capacity = yield* service
      .send({
        caller,
        targetThreadId: secondRecipient.threadId,
        clientRequestId: "retained:second",
        body: "two",
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(capacity), "CivilizationMailCapacityError");
    assert.equal((capacity as { readonly scope?: string }).scope, "project_message_count");
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "keeps inbox metadata body-free; receive offers once, ack requires offer, and acked mail is explicit-read only",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:receive");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:receive:from"),
        runId: RunId.make("run:mail:receive:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:receive:to"),
        runId: RunId.make("run:mail:receive:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      const sent = yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "receive:send",
        body: "secret body",
      });
      const messageId = sent.message.messageId;

      const inbox = yield* service.listInbox({ caller: recipientCaller });
      assert.lengthOf(inbox.messages, 1);
      assert.isFalse("body" in inbox.messages[0]!);

      const earlyAck = yield* service
        .acknowledge({ caller: recipientCaller, messageId, clientRequestId: "receive:early-ack" })
        .pipe(Effect.flip);
      assert.equal(errorTag(earlyAck), "CivilizationMailInvalidError");

      const received = yield* service.receive({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:one",
      });
      assert.equal(received.message.body, "secret body");
      assert.isNull(received.message.acknowledgedAt);
      const replay = yield* service.receive({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:one",
      });
      assert.equal(replay.message.offerCount, 1);

      const ack = yield* service.acknowledge({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:ack",
      });
      assert.isString(ack.acknowledgedAt);
      const explicitAfterAck = yield* service.receive({
        caller: recipientCaller,
        messageId,
        clientRequestId: "receive:after-ack",
      });
      assert.equal(explicitAfterAck.message.body, "secret body");
      assert.isNotNull(explicitAfterAck.message.acknowledgedAt);
      assert.deepEqual(
        yield* service.selectInboxForContext({
          caller: recipientCaller,
          limit: 10,
          selection: "recent",
        }),
        [],
      );
      assert.equal(
        (yield* sql<{
          readonly offer_count: number;
        }>`SELECT offer_count FROM civilization_messages WHERE message_id = ${messageId}`)[0]
          ?.offer_count,
        2,
      );
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect(
  "offers exactly the requested context messages and leaves other candidates untouched",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:context-offer");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:context-offer:from"),
        runId: RunId.make("run:mail:context-offer:from"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:context-offer:to"),
        runId: RunId.make("run:mail:context-offer:to"),
      };
      yield* seedProject(projectId);
      yield* enableFeature();
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      const first = yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "context:first",
        body: "first",
      });
      const second = yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "context:second",
        body: "second",
      });

      const offered = yield* service.offerInboxForContext({
        caller: recipientCaller,
        messageIds: [second.message.messageId, second.message.messageId],
      });
      assert.deepEqual(
        offered.messages.map((message) => message.messageId),
        [second.message.messageId],
      );
      assert.deepEqual(
        yield* sql<{ readonly message_id: string; readonly offer_count: number }>`
        SELECT message_id, offer_count FROM civilization_messages ORDER BY message_id ASC
      `,
        [
          { message_id: first.message.messageId, offer_count: 0 },
          { message_id: second.message.messageId, offer_count: 1 },
        ].sort((a, b) => a.message_id.localeCompare(b.message_id)),
      );
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("simulates context offers with runtime parity and zero mail mutation", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:context-would-offer");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:context-would-offer:from"),
      runId: RunId.make("run:mail:context-would-offer:from"),
    };
    const recipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:context-would-offer:to"),
      runId: RunId.make("run:mail:context-would-offer:to"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
    const first = yield* service.send({
      caller: senderCaller,
      targetThreadId: recipient.threadId,
      clientRequestId: "context:would:first",
      body: "first",
    });
    const second = yield* service.send({
      caller: senderCaller,
      targetThreadId: recipient.threadId,
      clientRequestId: "context:would:second",
      body: "second",
    });
    const third = yield* service.send({
      caller: senderCaller,
      targetThreadId: recipient.threadId,
      clientRequestId: "context:would:third",
      body: "third",
    });
    yield* sql`
      UPDATE civilization_messages
      SET acknowledged_at = '2026-10-16T10:01:00.000Z'
      WHERE message_id = ${second.message.messageId}
    `;

    const lifecycle = () =>
      sql<{
        readonly message_id: string;
        readonly first_offered_at: string | null;
        readonly last_offered_at: string | null;
        readonly offer_count: number;
      }>`
        SELECT message_id, first_offered_at, last_offered_at, offer_count
        FROM civilization_messages
        WHERE project_id = ${projectId}
        ORDER BY message_id ASC
      `;
    const mailRevision = () =>
      sql<{ readonly mail_revision: number }>`
        SELECT mail_revision FROM civilization_project_state
        WHERE project_id = ${projectId}
        LIMIT 1
      `.pipe(Effect.map((rows) => rows[0]!.mail_revision));
    const requested = [
      third.message.messageId,
      first.message.messageId,
      second.message.messageId,
      third.message.messageId,
    ];
    const beforeLifecycle = yield* lifecycle();
    const beforeRevision = yield* mailRevision();

    const simulated = yield* service.wouldOfferInboxForContext({
      caller: recipientCaller,
      messageIds: requested,
    });
    assert.deepEqual(
      simulated.messages.map((message) => message.messageId),
      [third.message.messageId, first.message.messageId],
    );
    assert.equal(simulated.revision, beforeRevision);
    assert.deepEqual(yield* lifecycle(), beforeLifecycle);
    assert.equal(yield* mailRevision(), beforeRevision);

    const offered = yield* service.offerInboxForContext({
      caller: recipientCaller,
      messageIds: requested,
    });
    assert.deepEqual(
      offered.messages.map((message) => message.messageId),
      simulated.messages.map((message) => message.messageId),
    );
    const afterLifecycle = yield* lifecycle();
    const byId = new Map(afterLifecycle.map((row) => [row.message_id, row] as const));
    assert.equal(byId.get(first.message.messageId)?.offer_count, 1);
    assert.equal(byId.get(second.message.messageId)?.offer_count, 0);
    assert.equal(byId.get(third.message.messageId)?.offer_count, 1);
    assert.isAbove(yield* mailRevision(), beforeRevision);
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect("keeps reply references inside the current lifecycle epochs of both participants", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:reply-epoch");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reply-epoch:sender"),
      runId: RunId.make("run:mail:reply-epoch:sender"),
    };
    const recipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:reply-epoch:recipient"),
      runId: RunId.make("run:mail:reply-epoch:recipient"),
    };
    yield* seedProject(projectId);
    yield* enableFeature();
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
    const first = yield* service.send({
      caller: senderCaller,
      targetThreadId: recipient.threadId,
      clientRequestId: "reply:first",
      body: "original correspondence",
    });

    const acceptedReply = yield* service.send({
      caller: recipientCaller,
      targetThreadId: sender.threadId,
      clientRequestId: "reply:accepted",
      body: "current-epoch reply",
      replyToMessageId: first.message.messageId,
    });
    assert.equal(acceptedReply.message.replyToMessageId, first.message.messageId);

    // Model a close/reopen generation without changing the recipient's own
    // epoch. Historical correspondence must not become a reply bridge into the
    // sender's new lifecycle generation.
    yield* sql`
      UPDATE civilization_citizens
      SET epoch = epoch + 1, delivery_epoch = delivery_epoch + 1
      WHERE project_id = ${projectId} AND thread_id = ${sender.threadId}
    `;
    const staleReply = yield* service
      .send({
        caller: recipientCaller,
        targetThreadId: sender.threadId,
        clientRequestId: "reply:stale",
        body: "must not cross the sender lifecycle boundary",
        replyToMessageId: first.message.messageId,
      })
      .pipe(Effect.flip);
    assert.equal(errorTag(staleReply), "CivilizationMailInvalidError");
    assert.equal(errorReason(staleReply), "invalid_reply");
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});

it.effect(
  "bounds inbox and administrative metadata pages by the configured response byte limit",
  () => {
    const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
    return Effect.gen(function* () {
      const service = yield* MailService.CivilizationMailService;
      const projectId = ProjectId.make("project:mail:response-budget");
      const sender: ActorSeed = {
        threadId: ThreadId.make("thread:mail:response-budget:sender"),
        runId: RunId.make("run:mail:response-budget:sender"),
      };
      const recipient: ActorSeed = {
        threadId: ThreadId.make("thread:mail:response-budget:recipient"),
        runId: RunId.make("run:mail:response-budget:recipient"),
      };
      yield* seedProject(projectId);
      yield* enableFeature({ responseBodyBytes: 1 });
      yield* seedActor(projectId, sender);
      yield* seedActor(projectId, recipient);
      const senderCaller = yield* service.authoritativeCaller(callerInput(projectId, sender));
      const recipientCaller = yield* service.authoritativeCaller(callerInput(projectId, recipient));
      yield* service.send({
        caller: senderCaller,
        targetThreadId: recipient.threadId,
        clientRequestId: "response-budget:send",
        body: "body remains separate from metadata",
      });

      const inboxError = yield* service.listInbox({ caller: recipientCaller }).pipe(Effect.flip);
      assert.equal(errorTag(inboxError), "CivilizationMailInvalidError");
      assert.equal(errorReason(inboxError), "response_too_large");
      const adminError = yield* service.listAdminMail({ projectId }).pipe(Effect.flip);
      assert.equal(errorTag(adminError), "CivilizationMailInvalidError");
      assert.equal(errorReason(adminError), "response_too_large");
    }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
  },
);

it.effect("expires zero-TTL mail and later cleans retained message plus expired receipt", () => {
  const calls: FakeProviderCalls = { get: 0, unexpectedProviderWork: 0 };
  return Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const service = yield* MailService.CivilizationMailService;
    const projectId = ProjectId.make("project:mail:cleanup");
    const sender: ActorSeed = {
      threadId: ThreadId.make("thread:mail:cleanup:from"),
      runId: RunId.make("run:mail:cleanup:from"),
    };
    const recipient: ActorSeed = {
      threadId: ThreadId.make("thread:mail:cleanup:to"),
      runId: RunId.make("run:mail:cleanup:to"),
    };
    yield* seedProject(projectId);
    yield* enableFeature({
      unreadTtlDays: 0,
      terminalRetentionDays: 30,
      operationReceiptRetentionDays: 30,
    });
    yield* seedActor(projectId, sender);
    yield* seedActor(projectId, recipient);
    const caller = yield* service.authoritativeCaller(callerInput(projectId, sender));
    yield* service.send({
      caller,
      targetThreadId: recipient.threadId,
      clientRequestId: "cleanup:send",
      body: "ephemeral",
    });

    const expiry = yield* service.cleanupProject(projectId);
    assert.equal(expiry.expired, 1);
    assert.equal(expiry.deletedMessages, 0);
    assert.equal(expiry.deletedReceipts, 0);
    yield* sql`
      UPDATE civilization_messages
      SET terminal_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-31 days')
      WHERE project_id = ${projectId}
    `;
    yield* sql`
      UPDATE civilization_mail_operation_receipts
      SET expires_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '-1 day')
      WHERE project_id = ${projectId}
    `;
    const cleanup = yield* service.cleanupProject(projectId);
    assert.equal(cleanup.deletedMessages, 1);
    assert.equal(cleanup.deletedReceipts, 1);
    assert.equal(
      (yield* sql<{
        readonly count: number;
      }>`SELECT COUNT(*) AS count FROM civilization_messages`)[0]?.count,
      0,
    );
    assert.deepEqual(
      (yield* sql<{
        readonly retained_message_count: number;
        readonly retained_body_bytes: number;
      }>`
        SELECT retained_message_count, retained_body_bytes FROM civilization_project_state WHERE project_id = ${projectId}
      `)[0],
      { retained_message_count: 0, retained_body_bytes: 0 },
    );
    assert.equal(calls.unexpectedProviderWork, 0);
  }).pipe(Effect.provide(Layer.fresh(makeLayer(calls))));
});
