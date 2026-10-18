import { ProjectId, ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import {
  CivilizationChronicleInvalidError,
  CivilizationChronicleService,
  layer,
  recordChronicleEntry,
} from "./ChronicleService.ts";

const projectId = ProjectId.make("project:chronicle:test");
const citizenId = ThreadId.make("thread:chronicle:test");
const database = NodeSqliteClient.layer({ filename: ":memory:" });
const serviceLayer = layer.pipe(Layer.provide(database));
const testLayer = Layer.mergeAll(database, serviceLayer);
const isInvalid = Schema.is(CivilizationChronicleInvalidError);

const seedCitizenName = Effect.fn("ChronicleService.test.seedCitizenName")(function* (
  threadId: ThreadId,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO civilization_citizens (
      thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
      generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
      name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
      name_environment_revision, name_project_revision,
      profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
      profile_rich_label, profile_rich_traits_json, profile_rich_axiom, profile_rich_voice,
      profile_rich_style_text, profile_environment_revision, profile_project_revision,
      title_managed, preserved_title, last_managed_title, title_topic,
      pending_title_command_id, pending_managed_title, pending_title_topic,
      epoch, closed, deleted, revision, created_at, updated_at
    ) VALUES (
      ${threadId}, ${projectId}, NULL, NULL, ${threadId},
      0, 'resolved', 0, 1, 1,
      ${`name:${threadId}`}, 1, ${name}, ${name}, ${threadId}, 'main',
      1, 0,
      'calm', 'Calm', '[]', '', 'profiles',
      'Calm Architect', '["calm"]', 'Be calm.', 'Calm.', 'Stay calm.', 1, 0,
      0, ${name}, NULL, ${name},
      NULL, NULL, NULL,
      0, 0, 0, 1, '2026-10-17T20:00:00.000Z', '2026-10-17T20:00:00.000Z'
    )
  `;
});

it.effect("records provenance idempotently and pages Chronicle by stable revision", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* CivilizationChronicleService;
    const sql = yield* SqlClient.SqlClient;
    yield* seedCitizenName(citizenId, "Ada Chronicle");

    const source = {
      projectId,
      primaryThreadId: citizenId,
      citizenEpoch: 0,
      citizenRevision: 1,
      sourceKind: "host_event" as const,
      sourceId: "event:chronicle:joined",
      sourceSequence: 10,
      occurredAt: "2026-10-17T20:00:00.000Z",
    };
    const firstId = yield* recordChronicleEntry({ ...source, kind: "citizen_joined" });
    const duplicateId = yield* recordChronicleEntry({ ...source, kind: "citizen_joined" });
    assert.equal(firstId, duplicateId);
    yield* recordChronicleEntry({
      ...source,
      kind: "citizen_settled",
      sourceId: "event:chronicle:settled",
      sourceSequence: 11,
      occurredAt: "2026-10-17T20:01:00.000Z",
      citizenEpoch: 1,
      citizenRevision: 2,
    });
    yield* recordChronicleEntry({
      ...source,
      kind: "citizen_returned",
      sourceId: "event:chronicle:return",
      sourceSequence: 12,
      occurredAt: "2026-10-17T20:02:00.000Z",
      citizenEpoch: 2,
      citizenRevision: 3,
    });

    const count = (yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM civilization_chronicle_entries WHERE project_id = ${projectId}
    `)[0]!.count;
    assert.equal(count, 3);
    const state = (yield* sql<{ readonly chronicle_revision: number }>`
      SELECT chronicle_revision FROM civilization_project_state WHERE project_id = ${projectId}
    `)[0]!;
    assert.equal(state.chronicle_revision, 3);

    const first = yield* service.list({ projectId, limit: 2 });
    assert.deepEqual(
      first.entries.map((entry) => entry.kind),
      ["citizen_returned", "citizen_settled"],
    );
    assert.isTrue(first.partial);
    assert.isNotNull(first.nextCursor);
    assert.deepEqual(first.citizenReferences, [{ threadId: citizenId, name: "Ada Chronicle" }]);
    const second = yield* service.list({ projectId, limit: 2, cursor: first.nextCursor! });
    assert.deepEqual(
      second.entries.map((entry) => entry.kind),
      ["citizen_joined"],
    );
    assert.isFalse(second.partial);
  }).pipe(Effect.provide(testLayer)),
);

it.effect("rejects a stale Chronicle cursor after membership changes", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* CivilizationChronicleService;
    yield* recordChronicleEntry({
      projectId,
      kind: "citizen_joined",
      primaryThreadId: citizenId,
      sourceKind: "host_event",
      sourceId: "event:chronicle:stale:1",
      sourceSequence: 1,
      occurredAt: "2026-10-17T21:00:00.000Z",
    });
    yield* recordChronicleEntry({
      projectId,
      kind: "citizen_settled",
      primaryThreadId: citizenId,
      sourceKind: "host_event",
      sourceId: "event:chronicle:stale:2",
      sourceSequence: 2,
      occurredAt: "2026-10-17T21:01:00.000Z",
    });
    const first = yield* service.list({ projectId, limit: 1 });
    assert.isNotNull(first.nextCursor);
    yield* recordChronicleEntry({
      projectId,
      kind: "citizen_returned",
      primaryThreadId: citizenId,
      sourceKind: "host_event",
      sourceId: "event:chronicle:stale:3",
      sourceSequence: 3,
      occurredAt: "2026-10-17T21:02:00.000Z",
    });
    const stale = yield* Effect.flip(
      service.list({ projectId, limit: 1, cursor: first.nextCursor! }),
    );
    assert.isTrue(isInvalid(stale));
    if (isInvalid(stale)) assert.equal(stale.reason, "invalid_cursor");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("binds kind, citizen, and canonical time filters to bounded Chronicle reads", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* CivilizationChronicleService;
    const parentId = ThreadId.make("thread:chronicle:parent");
    yield* recordChronicleEntry({
      projectId,
      kind: "citizen_joined",
      primaryThreadId: parentId,
      sourceKind: "host_event",
      sourceId: "event:chronicle:filters:parent",
      sourceSequence: 20,
      occurredAt: "2026-10-17T19:00:00.000Z",
    });
    yield* recordChronicleEntry({
      projectId,
      kind: "child_joined",
      primaryThreadId: citizenId,
      secondaryThreadId: parentId,
      sourceKind: "host_event",
      sourceId: "event:chronicle:filters:child",
      sourceSequence: 21,
      occurredAt: "2026-10-17T20:00:00.000Z",
      metadata: { relationship: "fork" },
    });
    yield* recordChronicleEntry({
      projectId,
      kind: "citizen_settled",
      primaryThreadId: citizenId,
      sourceKind: "host_event",
      sourceId: "event:chronicle:filters:settled",
      sourceSequence: 22,
      occurredAt: "2026-10-17T21:00:00.000Z",
    });

    const childOnly = yield* service.list({ projectId, kind: "child_joined", limit: 10 });
    assert.deepEqual(
      childOnly.entries.map((entry) => entry.kind),
      ["child_joined"],
    );

    const exactSource = yield* service.list({
      projectId,
      sourceId: "event:chronicle:filters:child",
      limit: 10,
    });
    assert.deepEqual(
      exactSource.entries.map((entry) => entry.sourceId),
      ["event:chronicle:filters:child"],
    );

    const parentTimeline = yield* service.list({ projectId, threadId: parentId, limit: 10 });
    assert.deepEqual(
      parentTimeline.entries.map((entry) => entry.kind),
      ["child_joined", "citizen_joined"],
    );

    const window = yield* service.list({
      projectId,
      threadId: citizenId,
      from: "2026-10-17T13:30:00-06:00",
      to: "2026-10-17T20:30:00.000Z",
      limit: 10,
    });
    assert.deepEqual(
      window.entries.map((entry) => entry.kind),
      ["child_joined"],
    );

    const malformed = yield* Effect.flip(service.list({ projectId, from: "not-a-time" }));
    assert.isTrue(isInvalid(malformed));
    if (isInvalid(malformed)) assert.equal(malformed.reason, "invalid_time_range");
    const inverted = yield* Effect.flip(
      service.list({
        projectId,
        from: "2026-10-17T22:00:00.000Z",
        to: "2026-10-17T21:00:00.000Z",
      }),
    );
    assert.isTrue(isInvalid(inverted));
    if (isInvalid(inverted)) assert.equal(inverted.reason, "invalid_time_range");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("pages achievement awards by stable revision and binds citizen filters", () =>
  Effect.gen(function* () {
    yield* runMigrations();
    const service = yield* CivilizationChronicleService;
    const sql = yield* SqlClient.SqlClient;
    const otherCitizenId = ThreadId.make("thread:chronicle:achievement-other");
    yield* seedCitizenName(citizenId, "Ada Achievement");
    yield* seedCitizenName(otherCitizenId, "Grace Achievement");
    yield* sql`
      INSERT INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      ) VALUES
        ('award:test:1', ${projectId}, 'project_founder', 1, ${citizenId}, ${citizenId},
         'chronicle:test:award:1', '2026-10-17T20:00:00.000Z'),
        ('award:test:2', ${projectId}, 'first_descendant', 1, ${otherCitizenId}, ${otherCitizenId},
         'chronicle:test:award:2', '2026-10-17T20:01:00.000Z'),
        ('award:test:3', ${projectId}, 'lineage_generation_3', 1, ${citizenId}, ${citizenId},
         'chronicle:test:award:3', '2026-10-17T20:02:00.000Z')
    `;

    const first = yield* service.listAchievements({ projectId, limit: 2 });
    assert.deepEqual(
      first.awards.map((award) => award.achievementId),
      ["lineage_generation_3", "first_descendant"],
    );
    assert.isTrue(first.partial);
    assert.isNotNull(first.nextCursor);
    assert.deepEqual(first.citizenReferences, [
      { threadId: otherCitizenId, name: "Grace Achievement" },
      { threadId: citizenId, name: "Ada Achievement" },
    ]);
    const second = yield* service.listAchievements({
      projectId,
      limit: 2,
      cursor: first.nextCursor!,
    });
    assert.deepEqual(
      second.awards.map((award) => award.achievementId),
      ["project_founder"],
    );

    const citizenAwards = yield* service.listAchievements({
      projectId,
      threadId: citizenId,
      limit: 10,
    });
    assert.deepEqual(
      citizenAwards.awards.map((award) => award.achievementId),
      ["lineage_generation_3", "project_founder"],
    );

    yield* sql`
      INSERT INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      ) VALUES (
        'award:test:4', ${projectId}, 'first_acknowledged_correspondence', 1,
        ${citizenId}, ${citizenId}, 'chronicle:test:award:4', '2026-10-17T20:03:00.000Z'
      )
    `;
    const stale = yield* Effect.flip(
      service.listAchievements({ projectId, limit: 2, cursor: first.nextCursor! }),
    );
    assert.isTrue(isInvalid(stale));
    if (isInvalid(stale)) assert.equal(stale.reason, "invalid_cursor");
  }).pipe(Effect.provide(testLayer)),
);
