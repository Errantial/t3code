// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
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
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";

import * as CheckpointRollbackService from "../orchestration-v2/CheckpointRollbackService.ts";
import * as EffectOutbox from "../orchestration-v2/EffectOutbox.ts";
import * as EffectWorker from "../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "../orchestration-v2/ProviderSessionManager.ts";
import * as ProviderTurnControlService from "../orchestration-v2/ProviderTurnControlService.ts";
import * as ProviderTurnStartService from "../orchestration-v2/ProviderTurnStartService.ts";
import * as RunFinalizationService from "../orchestration-v2/RunFinalizationService.ts";
import * as RuntimeRequestService from "../orchestration-v2/RuntimeRequestService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTitleRegenerationService from "../orchestration-v2/ThreadTitleRegenerationService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import { civilizationPersistenceParticipant } from "./PersistenceParticipant.ts";

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:civilization:title-restart");
const threadId = ThreadId.make("thread:civilization:title-restart");

function makeThread(at: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId,
    title: "Seed topic",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "civilization-title-restart" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: at,
    updatedAt: at,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

const enableManagedTitles = Effect.fn("TitleRestartAcceptance.enableManagedTitles")(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  yield* config.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      names: {
        pools: [{ id: "main", entries: [{ id: "ada", displayName: "Ada", weight: 1 }] }],
        selectedPoolId: "main",
        automaticTitles: true,
        titleTemplate: "[{name}] {topic}",
      },
    },
  });
});

function makeEnrollmentLayer(dbPath: string) {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const stores = Layer.merge(EventStore.layer, ProjectionStore.layer).pipe(Layer.provide(database));
  const participant = Layer.succeed(EventSink.EventSinkPersistenceParticipants, [
    civilizationPersistenceParticipant,
  ]);
  const sink = EventSink.layer.pipe(
    Layer.provide(Layer.mergeAll(stores, database)),
    Layer.provide(participant),
  );
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const config = ConfigService.layer.pipe(Layer.provide(database));
  return Layer.mergeAll(database, stores, sink, outbox, config);
}

function makeReplayLayer(
  dbPath: string,
  dispatchCount: Ref.Ref<number>,
  regenerationCount: Ref.Ref<number>,
) {
  const database = SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer));
  const outbox = EffectOutbox.layer.pipe(Layer.provide(database));
  const threads = Layer.unwrap(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      return Layer.mock(ThreadManagementService.ThreadManagementService)({
        getThreadProjection: (requestedThreadId) =>
          Effect.gen(function* () {
            const row = (yield* sql<{ readonly title: string }>`
              SELECT title
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${requestedThreadId}
              LIMIT 1
            `)[0];
            if (row === undefined) return yield* Effect.die("missing title restart projection");
            return { thread: { title: row.title } } as never;
          }).pipe(Effect.orDie),
        dispatch: (command) => {
          if (command.type !== "thread.title.converge") {
            return Effect.die(`unexpected title restart command: ${command.type}`);
          }
          return Effect.gen(function* () {
            const row = (yield* sql<{ readonly title: string }>`
              SELECT title
              FROM orchestration_v2_projection_threads
              WHERE thread_id = ${command.threadId}
              LIMIT 1
            `)[0];
            if (row === undefined) return yield* Effect.die("missing title restart projection");
            assert.equal(row.title, command.expectedTitle);
            yield* sql`
              UPDATE orchestration_v2_projection_threads
              SET title = ${command.title},
                  payload_json = json_set(payload_json, '$.title', ${command.title})
              WHERE thread_id = ${command.threadId}
            `;
            yield* Ref.update(dispatchCount, (count) => count + 1);
            return { sequence: 2, storedEvents: [] } as never;
          }).pipe(Effect.orDie);
        },
      });
    }),
  ).pipe(Layer.provide(database));
  const titleRegeneration = Layer.succeed(
    ThreadTitleRegenerationService.ThreadTitleRegenerationService,
    ThreadTitleRegenerationService.ThreadTitleRegenerationService.of({
      execute: () => Ref.update(regenerationCount, (count) => count + 1),
    }),
  );
  const executorDependencies = Layer.mergeAll(
    Layer.mock(RunFinalizationService.RunFinalizationService)({}),
    Layer.mock(CheckpointRollbackService.CheckpointRollbackServiceV2)({}),
    Layer.mock(ProviderSessionManager.ProviderSessionManagerV2)({}),
    Layer.mock(ProviderTurnControlService.ProviderTurnControlServiceV2)({}),
    Layer.mock(ProviderTurnStartService.ProviderTurnStartServiceV2)({}),
    Layer.mock(RuntimeRequestService.RuntimeRequestServiceV2)({}),
    Layer.mock(ServerSettings.ServerSettingsService)({}),
    threads,
    titleRegeneration,
  );
  const executor = EffectWorker.layerExecutor.pipe(Layer.provide(executorDependencies));
  const worker = EffectWorker.layerWithOptions({
    workerId: "civilization-title-restart-worker",
  }).pipe(Layer.provide(Layer.merge(outbox, executor)));
  return Layer.mergeAll(database, outbox, executor, worker);
}

it.effect(
  "replays a deterministic managed-title effect after process loss without model work or double prefixing",
  () => {
    const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-title-restart-"));
    const dbPath = NodePath.join(tempDir, "state.sqlite");

    return Effect.gen(function* () {
      const effectId = yield* Effect.gen(function* () {
        yield* enableManagedTitles();
        const sink = yield* EventSink.EventSinkV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make("event:civilization:title-restart:create"),
              type: "thread.created",
              threadId,
              occurredAt: now,
              payload: makeThread(now),
            },
          ],
        });

        const claimed = yield* outbox.claimNext({
          workerId: "crashed-title-worker",
          leaseDurationMs: 30_000,
        });
        assert.isTrue(Option.isSome(claimed));
        if (Option.isNone(claimed)) return yield* Effect.die("managed title effect was not queued");
        assert.equal(claimed.value.request.type, "thread-title.apply");
        if (claimed.value.request.type !== "thread-title.apply") {
          return yield* Effect.die("unexpected managed title effect");
        }
        assert.equal(claimed.value.request.expectedTitle, "Seed topic");
        assert.equal(claimed.value.request.title, "[Ada] Seed topic");
        return claimed.value.id;
      }).pipe(Effect.provide(Layer.fresh(makeEnrollmentLayer(dbPath))));

      const dispatchCount = yield* Ref.make(0);
      const regenerationCount = yield* Ref.make(0);
      yield* Effect.gen(function* () {
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const executor = yield* EffectWorker.OrchestrationEffectExecutorV2;
        const sql = yield* SqlClient.SqlClient;

        assert.deepEqual(yield* outbox.reconcileAfterProcessLoss, { requeued: 1, cancelled: 0 });
        assert.isTrue(yield* worker.runOnce);
        assert.isFalse(yield* worker.runOnce);

        const stored = yield* outbox.get(effectId);
        assert.isTrue(Option.isSome(stored));
        if (Option.isNone(stored)) return yield* Effect.die("managed title effect disappeared");
        assert.equal(stored.value.status, "succeeded");

        yield* executor.execute(stored.value);
        assert.equal(yield* Ref.get(dispatchCount), 1);
        assert.equal(yield* Ref.get(regenerationCount), 0);
        const projection = (yield* sql<{ readonly title: string }>`
          SELECT title
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `)[0]!;
        assert.equal(projection.title, "[Ada] Seed topic");
      }).pipe(
        Effect.provide(Layer.fresh(makeReplayLayer(dbPath, dispatchCount, regenerationCount))),
      );
    }).pipe(
      Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
    );
  },
);
