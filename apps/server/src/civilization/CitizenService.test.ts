import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  EventId,
  type OrchestrationV2AppThread,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ConfigService from "./ConfigService.ts";
import { enrollCivilizationThread } from "./PersistenceParticipant.ts";

const database = SqlitePersistence.layerMemory;
const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer, EffectOutbox.layer).pipe(
  Layer.provide(database),
);
const hostOnlySink = EventSink.layer.pipe(
  Layer.provide(Layer.mergeAll(stores, database)),
  Layer.provide(Layer.succeed(EventSink.EventSinkPersistenceParticipants, [])),
);
const layer = Layer.mergeAll(
  database,
  stores,
  hostOnlySink,
  ConfigService.layer.pipe(Layer.provide(database)),
  CitizenService.layer.pipe(Layer.provide(Layer.mergeAll(database, stores))),
);

const providerInstanceId = ProviderInstanceId.make("codex");

function makeThread(
  id: ThreadId,
  projectId: ProjectId,
  at: DateTime.Utc,
  overrides: Partial<OrchestrationV2AppThread> = {},
): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id,
    projectId,
    title: "Existing thread title",
    providerInstanceId,
    modelSelection: { instanceId: providerInstanceId, model: "civilization-phase1" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    ...overrides,
  };
}

const enableAllExisting = Effect.fn("CitizenService.test.enableAllExisting")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true, adoption: "all_existing" },
    },
  });
});

const enableManagedAdoption = Effect.fn("CitizenService.test.enableManagedAdoption")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true, adoption: "all_existing" },
      names: { adoptionTitlePolicy: "managed" },
    },
  });
});

const enableRichDetail = Effect.fn("CitizenService.test.enableRichDetail")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true, adoption: "all_existing" },
      personalities: { rendering: "rich" },
    },
  });
});

it.effect(
  "explicitly adopts current projections, remains idempotent, and excludes deleted threads",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const citizens = yield* CitizenService.CivilizationCitizenService;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:adoption");
      const activeId = ThreadId.make("thread:civilization:adoption:active");
      const deletedId = ThreadId.make("thread:civilization:adoption:deleted");
      const active = makeThread(activeId, projectId, now);
      const deleted = makeThread(deletedId, projectId, now);

      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:adoption:active:create"),
            type: "thread.created",
            threadId: activeId,
            occurredAt: now,
            payload: active,
          },
          {
            id: EventId.make("event:civilization:adoption:deleted:create"),
            type: "thread.created",
            threadId: deletedId,
            occurredAt: now,
            payload: deleted,
          },
        ],
      });
      const deletedProjection = { ...deleted, deletedAt: now, updatedAt: now };
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:adoption:deleted:delete"),
            type: "thread.deleted",
            threadId: deletedId,
            occurredAt: now,
            payload: deletedProjection,
          },
        ],
      });
      assert.isNull(yield* citizens.getCitizen(activeId));
      yield* enableAllExisting();

      const first = yield* citizens.adoptExisting();
      assert.deepEqual(first, { candidates: 1, adopted: 1, skipped: 0 });
      assert.isNotNull(yield* citizens.getCitizen(activeId));
      assert.isNull(yield* citizens.getCitizen(deletedId));

      const second = yield* citizens.adoptExisting();
      assert.deepEqual(second, { candidates: 0, adopted: 0, skipped: 0 });
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("adopts all existing projections across bounded 100-row batches", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const citizens = yield* CitizenService.CivilizationCitizenService;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:civilization:adoption-batches");
    const threads = Array.from({ length: 105 }, (_, index) => {
      const suffix = String(index).padStart(4, "0");
      const threadId = ThreadId.make(`thread:civilization:adoption-batches:${suffix}`);
      return makeThread(threadId, projectId, now);
    });
    yield* sink.write({
      events: threads.map((thread, index) => ({
        id: EventId.make(`event:civilization:adoption-batches:${index}`),
        type: "thread.created" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      })),
    });
    yield* enableAllExisting();

    const first = yield* citizens.adoptExisting({ projectId });
    assert.deepEqual(first, { candidates: 105, adopted: 105, skipped: 0 });
    const second = yield* citizens.adoptExisting({ projectId });
    assert.deepEqual(second, { candidates: 0, adopted: 0, skipped: 0 });
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "reads one exact persisted citizen detail without provider work and rejects project mismatch",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const citizens = yield* CitizenService.CivilizationCitizenService;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:detail");
      const threadId = ThreadId.make("thread:civilization:detail");
      const thread = makeThread(threadId, projectId, now, { title: "Host detail title" });
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:detail:create"),
            type: "thread.created",
            threadId,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      yield* enableRichDetail();
      assert.deepEqual(yield* citizens.adoptExisting({ projectId }), {
        candidates: 1,
        adopted: 1,
        skipped: 0,
      });

      yield* sql`
        UPDATE civilization_citizens
        SET name_base = 'Stored base name',
            profile_label = 'Stored base personality',
            profile_traits_json = '["careful","concise"]',
            profile_style_text = 'Stored base style.',
            profile_rich_label = 'Stored Rich Persona',
            profile_rich_traits_json = '["deliberate","precise"]',
            profile_rich_axiom = 'Stored axiom.',
            profile_rich_voice = 'Stored voice.',
            profile_rich_style_text = 'Stored rich style.',
            title_managed = 1,
            preserved_title = 'Preserved manual title',
            last_managed_title = 'Prior managed title',
            title_topic = 'Stored topic'
        WHERE thread_id = ${threadId}
      `;
      const outboxBefore = (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
      `)[0]!.count;

      const detail = yield* citizens.getCitizenDetail({ projectId, threadId });
      assert.equal(detail.threadId, threadId);
      assert.equal(detail.projectId, projectId);
      assert.equal(detail.identity.baseName, "Stored base name");
      assert.equal(detail.host.threadTitle, "Host detail title");
      assert.equal(detail.host.providerInstanceId, providerInstanceId);
      assert.equal(detail.presentation.rendering, "rich");
      assert.equal(detail.presentation.label, "Stored Rich Persona");
      assert.deepEqual(detail.personality.base, {
        label: "Stored base personality",
        traits: ["careful", "concise"],
        styleText: "Stored base style.",
      });
      assert.deepEqual(detail.personality.rich, {
        label: "Stored Rich Persona",
        traits: ["deliberate", "precise"],
        axiom: "Stored axiom.",
        voice: "Stored voice.",
        styleText: "Stored rich style.",
      });
      assert.deepEqual(detail.lifecycle, {
        state: "open",
        epoch: 0,
        closed: false,
        deleted: false,
      });
      assert.isTrue(detail.title.managed);
      assert.equal(detail.title.topic, "Stored topic");
      assert.equal(detail.title.preservedTitle, "Preserved manual title");
      assert.equal(detail.title.lastManagedTitle, "Prior managed title");
      assert.equal(
        detail.title.managedTitlePreview,
        `[${detail.identity.displayName}] Stored topic`,
      );
      const outboxAfter = (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM orchestration_v2_effect_outbox
      `)[0]!.count;
      assert.equal(outboxAfter, outboxBefore);

      const mismatch = yield* citizens
        .getCitizenDetail({
          projectId: ProjectId.make("project:civilization:detail:wrong"),
          threadId,
        })
        .pipe(Effect.flip);
      assert.equal(mismatch._tag, "CivilizationCitizenNotFoundError");
      if (mismatch._tag === "CivilizationCitizenNotFoundError") {
        assert.equal(mismatch.threadId, threadId);
      }
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("queues replay-safe managed title application for managed adoption", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const citizens = yield* CitizenService.CivilizationCitizenService;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:civilization:managed-adoption");
    const threadId = ThreadId.make("thread:civilization:managed-adoption");
    const thread = makeThread(threadId, projectId, now);
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:civilization:managed-adoption:create"),
          type: "thread.created",
          threadId,
          occurredAt: now,
          payload: thread,
        },
      ],
    });
    yield* enableManagedAdoption();

    assert.deepEqual(yield* citizens.adoptExisting({ projectId }), {
      candidates: 1,
      adopted: 1,
      skipped: 0,
    });
    const effects = yield* sql<{ readonly effect_type: string; readonly payload_json: string }>`
      SELECT effect_type, payload_json
      FROM orchestration_v2_effect_outbox
      ORDER BY rowid ASC
    `;
    assert.lengthOf(effects, 1);
    assert.equal(effects[0]!.effect_type, "thread-title.apply");
    const citizen = yield* citizens.getCitizen(threadId);
    assert.isNotNull(citizen);
    assert.include(effects[0]!.payload_json, `[${citizen!.name}] Existing thread title`);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "catch-up advances only enrolled citizens and never turns historical thread.created into adoption",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const citizens = yield* CitizenService.CivilizationCitizenService;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:civilization:catch-up");
      const enrolledId = ThreadId.make("thread:civilization:catch-up:enrolled");
      const historicalId = ThreadId.make("thread:civilization:catch-up:historical");
      const enrolled = makeThread(enrolledId, projectId, now);
      const historical = makeThread(historicalId, projectId, now);
      yield* enableAllExisting();

      const created = yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:catch-up:enrolled:create"),
            type: "thread.created",
            threadId: enrolledId,
            occurredAt: now,
            payload: enrolled,
          },
          {
            id: EventId.make("event:civilization:catch-up:historical:create"),
            type: "thread.created",
            threadId: historicalId,
            occurredAt: now,
            payload: historical,
          },
        ],
      });
      const enrolledCreate = created.find((stored) => stored.event.threadId === enrolledId)!;
      yield* enrollCivilizationThread({
        sequence: enrolledCreate.sequence,
        thread: enrolled,
        adoption: false,
      }).pipe(Effect.provideService(SqlClient.SqlClient, sql));

      const settled = {
        ...enrolled,
        settledOverride: "settled" as const,
        settledAt: now,
        updatedAt: now,
      };
      const settledStored = yield* sink.write({
        events: [
          {
            id: EventId.make("event:civilization:catch-up:enrolled:settle"),
            type: "thread.settled",
            threadId: enrolledId,
            occurredAt: now,
            payload: settled,
          },
        ],
      });

      const summary = yield* citizens.reconcileExisting();
      assert.deepEqual(summary, { citizenCount: 1, caughtUpCitizenCount: 1, appliedEventCount: 1 });
      const caughtUp = yield* citizens.getCitizen(enrolledId);
      assert.equal(caughtUp?.epoch, 1);
      assert.isTrue(caughtUp?.closed ?? false);
      assert.isNull(yield* citizens.getCitizen(historicalId));
      const watermark = (yield* sql<{ readonly last_applied_sequence: number }>`
        SELECT last_applied_sequence
        FROM civilization_citizens WHERE thread_id = ${enrolledId}
      `)[0]!.last_applied_sequence;
      assert.equal(watermark, settledStored[0]!.sequence);

      const idempotent = yield* citizens.reconcileExisting();
      assert.deepEqual(idempotent, {
        citizenCount: 1,
        caughtUpCitizenCount: 0,
        appliedEventCount: 0,
      });
    }).pipe(Effect.provide(Layer.fresh(layer))),
);
