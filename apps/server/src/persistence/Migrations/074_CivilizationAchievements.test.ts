import { assert, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

const insertCitizen = Effect.fn("test.insertAchievementCitizen")(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly parentThreadId?: string | null;
  readonly generation?: number;
  readonly birthSequence: number;
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
      epoch, closed, deleted, revision, created_at, updated_at
    ) VALUES (
      ${input.threadId}, ${input.projectId}, ${input.parentThreadId ?? null},
      ${input.parentThreadId === undefined || input.parentThreadId === null ? null : "fork"},
      ${input.parentThreadId ?? input.threadId}, ${input.generation ?? 0}, 'resolved', 0,
      ${input.birthSequence}, ${input.birthSequence},
      ${`name:${input.threadId}`}, 1, ${input.threadId}, ${input.threadId}, ${input.threadId},
      'default-names', 0, 0,
      ${`profile:${input.threadId}`}, 'Measured', '[]', 'Measured.', 'default-profiles', 0, 0,
      0, NULL, NULL, ${input.threadId}, NULL, NULL, NULL,
      0, 0, 0, 1, '2026-10-17T10:00:00.000Z', '2026-10-17T10:00:00.000Z'
    )
  `;
});

const insertChronicle = Effect.fn("test.insertAchievementChronicle")(function* (input: {
  readonly entryId: string;
  readonly projectId: string;
  readonly kind: string;
  readonly primaryThreadId: string;
  readonly secondaryThreadId?: string | null;
  readonly occurredAt: string;
  readonly metadataJson?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO civilization_chronicle_entries (
      entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
      citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
      provenance_key, occurred_at, metadata_json
    ) VALUES (
      ${input.entryId}, ${input.projectId}, ${input.kind}, ${input.primaryThreadId},
      ${input.secondaryThreadId ?? null}, 0, 1, 'host_event', ${`event:${input.entryId}`}, 1,
      ${`host_event\u001f${input.entryId}\u001f${input.kind}\u001f${input.primaryThreadId}\u001f${input.secondaryThreadId ?? ""}`},
      ${input.occurredAt}, ${input.metadataJson ?? "{}"}
    )
  `;
});

it.effect("derives versioned achievements only from durable Chronicle provenance", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 73 });

    yield* insertCitizen({
      threadId: "thread:legacy-founder",
      projectId: "project:legacy-achievements",
      birthSequence: 1,
    });
    yield* insertCitizen({
      threadId: "thread:truthful-founder",
      projectId: "project:truthful-achievements",
      birthSequence: 1,
    });
    yield* insertChronicle({
      entryId: "chronicle:truthful-founder",
      projectId: "project:truthful-achievements",
      kind: "citizen_joined",
      primaryThreadId: "thread:truthful-founder",
      occurredAt: "2026-10-17T10:00:00.000Z",
    });

    yield* runMigrations({ toMigrationInclusive: 74 });

    const initial = yield* sql<{
      readonly project_id: string;
      readonly achievement_id: string;
      readonly subject_thread_id: string | null;
      readonly trigger_entry_id: string;
    }>`
      SELECT project_id, achievement_id, subject_thread_id, trigger_entry_id
      FROM civilization_achievement_awards
      ORDER BY project_id, achievement_id
    `;
    assert.deepEqual(initial, [
      {
        project_id: "project:truthful-achievements",
        achievement_id: "project_founder",
        subject_thread_id: "thread:truthful-founder",
        trigger_entry_id: "chronicle:truthful-founder",
      },
    ]);

    yield* insertCitizen({
      threadId: "thread:first-child",
      projectId: "project:truthful-achievements",
      parentThreadId: "thread:truthful-founder",
      generation: 1,
      birthSequence: 2,
    });
    yield* insertChronicle({
      entryId: "chronicle:first-child",
      projectId: "project:truthful-achievements",
      kind: "child_joined",
      primaryThreadId: "thread:first-child",
      secondaryThreadId: "thread:truthful-founder",
      occurredAt: "2026-10-17T10:01:00.000Z",
      metadataJson: '{"relationship":"fork"}',
    });
    yield* insertCitizen({
      threadId: "thread:second-child",
      projectId: "project:truthful-achievements",
      parentThreadId: "thread:truthful-founder",
      generation: 1,
      birthSequence: 3,
    });
    yield* insertChronicle({
      entryId: "chronicle:second-child",
      projectId: "project:truthful-achievements",
      kind: "child_joined",
      primaryThreadId: "thread:second-child",
      secondaryThreadId: "thread:truthful-founder",
      occurredAt: "2026-10-17T09:59:00.000Z",
      metadataJson: '{"relationship":"fork"}',
    });
    yield* insertCitizen({
      threadId: "thread:generation-three",
      projectId: "project:truthful-achievements",
      parentThreadId: "thread:second-child",
      generation: 3,
      birthSequence: 4,
    });
    yield* insertChronicle({
      entryId: "chronicle:generation-three",
      projectId: "project:truthful-achievements",
      kind: "child_joined",
      primaryThreadId: "thread:generation-three",
      secondaryThreadId: "thread:second-child",
      occurredAt: "2026-10-17T10:03:00.000Z",
      metadataJson: '{"relationship":"fork"}',
    });
    yield* insertChronicle({
      entryId: "chronicle:mail-ack-one",
      projectId: "project:truthful-achievements",
      kind: "mail_acknowledged",
      primaryThreadId: "thread:first-child",
      secondaryThreadId: "thread:truthful-founder",
      occurredAt: "2026-10-17T10:04:00.000Z",
      metadataJson: '{"messageId":"mail:one"}',
    });
    yield* insertChronicle({
      entryId: "chronicle:mail-ack-two",
      projectId: "project:truthful-achievements",
      kind: "mail_acknowledged",
      primaryThreadId: "thread:second-child",
      secondaryThreadId: "thread:truthful-founder",
      occurredAt: "2026-10-17T10:03:30.000Z",
      metadataJson: '{"messageId":"mail:two"}',
    });

    const awards = yield* sql<{
      readonly achievement_id: string;
      readonly definition_version: number;
      readonly subject_thread_id: string | null;
      readonly trigger_entry_id: string;
      readonly awarded_at: string;
    }>`
      SELECT achievement_id, definition_version, subject_thread_id, trigger_entry_id, awarded_at
      FROM civilization_achievement_awards
      WHERE project_id = 'project:truthful-achievements'
      ORDER BY achievement_id ASC
    `;
    assert.deepEqual(
      awards.map((award) => [
        award.achievement_id,
        award.definition_version,
        award.trigger_entry_id,
      ]),
      [
        ["first_acknowledged_correspondence", 1, "chronicle:mail-ack-two"],
        ["first_descendant", 1, "chronicle:second-child"],
        ["lineage_generation_3", 1, "chronicle:generation-three"],
        ["project_founder", 1, "chronicle:truthful-founder"],
      ],
    );
    assert.equal(
      awards.find((award) => award.achievement_id === "first_descendant")?.awarded_at,
      "2026-10-17T09:59:00.000Z",
    );

    yield* insertCitizen({
      threadId: "thread:out-of-order-founder",
      projectId: "project:out-of-order-achievements",
      birthSequence: 1,
    });
    yield* insertCitizen({
      threadId: "thread:out-of-order-child",
      projectId: "project:out-of-order-achievements",
      parentThreadId: "thread:out-of-order-founder",
      generation: 1,
      birthSequence: 2,
    });
    yield* insertChronicle({
      entryId: "chronicle:out-of-order-child",
      projectId: "project:out-of-order-achievements",
      kind: "child_joined",
      primaryThreadId: "thread:out-of-order-child",
      secondaryThreadId: "thread:out-of-order-founder",
      occurredAt: "2026-10-17T11:01:00.000Z",
      metadataJson: '{"relationship":"fork"}',
    });
    yield* insertChronicle({
      entryId: "chronicle:out-of-order-mail",
      projectId: "project:out-of-order-achievements",
      kind: "mail_acknowledged",
      primaryThreadId: "thread:out-of-order-child",
      secondaryThreadId: "thread:out-of-order-founder",
      occurredAt: "2026-10-17T11:02:00.000Z",
      metadataJson: '{"messageId":"mail:out-of-order"}',
    });
    assert.equal(
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_achievement_awards
        WHERE project_id = 'project:out-of-order-achievements'
      `)[0]?.count,
      0,
    );
    yield* insertChronicle({
      entryId: "chronicle:out-of-order-founder",
      projectId: "project:out-of-order-achievements",
      kind: "citizen_joined",
      primaryThreadId: "thread:out-of-order-founder",
      occurredAt: "2026-10-17T11:00:00.000Z",
    });
    assert.deepEqual(
      (yield* sql<{ readonly achievement_id: string; readonly trigger_entry_id: string }>`
        SELECT achievement_id, trigger_entry_id
        FROM civilization_achievement_awards
        WHERE project_id = 'project:out-of-order-achievements'
        ORDER BY achievement_id ASC
      `).map((award) => [award.achievement_id, award.trigger_entry_id]),
      [
        ["first_acknowledged_correspondence", "chronicle:out-of-order-mail"],
        ["first_descendant", "chronicle:out-of-order-child"],
        ["project_founder", "chronicle:out-of-order-founder"],
      ],
    );

    assert.equal(
      (yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM civilization_achievement_awards
        WHERE project_id = 'project:legacy-achievements'
      `)[0]?.count,
      0,
      "pre-v1.1 citizens without Chronicle provenance must not receive synthetic awards",
    );
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
