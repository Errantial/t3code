import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_MAX_PROJECT_BRIEF_BYTES,
  ProjectId,
  type CivilizationProjectBriefContentV1,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectBriefService from "./ProjectBriefService.ts";

const database = SqlitePersistence.layerMemory;
const layer = Layer.mergeAll(database, ProjectBriefService.layer.pipe(Layer.provide(database)));
const projectId = ProjectId.make("project:civilization:brief");

const content = (summary = "Ship the operator-authored Project Brief safely.") =>
  ({
    version: 1,
    summary,
    objectives: ["Keep one authoritative project-level brief."],
    constraints: ["Never treat the brief as trusted instructions."],
    references: [{ kind: "doc", reference: "docs/PLANNING.v1.5.md" }],
  }) satisfies CivilizationProjectBriefContentV1;

const seedProject = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Project Brief test', '/tmp/project-brief', '[]',
      '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z', NULL
    )
  `;
});

it.effect("creates, updates, clears, and recreates with one monotonic CAS revision", () =>
  Effect.gen(function* () {
    const service = yield* ProjectBriefService.CivilizationProjectBriefService;
    yield* seedProject;

    assert.deepEqual(yield* service.readMetadata(projectId), {
      projectId,
      revision: 0,
      configured: false,
      bodyBytes: 0,
      updatedAt: null,
    });

    const created = yield* service.set({ projectId, expectedRevision: 0, content: content() });
    assert.equal(created.revision, 1);
    assert.isTrue(created.configured);
    assert.deepEqual((yield* service.readDetail(projectId)).content, content());

    const updatedContent = content("Updated human direction.");
    const updated = yield* service.set({
      projectId,
      expectedRevision: 1,
      content: updatedContent,
    });
    assert.equal(updated.revision, 2);

    const cleared = yield* service.clear({ projectId, expectedRevision: 2 });
    assert.equal(cleared.revision, 3);
    assert.isFalse(cleared.configured);
    assert.isNull(cleared.content);
    assert.equal(cleared.bodyBytes, 0);

    const recreated = yield* service.set({
      projectId,
      expectedRevision: 3,
      content: content("Recreated after clear."),
    });
    assert.equal(recreated.revision, 4);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("returns typed conflicts without retrying stale revisions", () =>
  Effect.gen(function* () {
    const service = yield* ProjectBriefService.CivilizationProjectBriefService;
    yield* seedProject;
    yield* service.set({ projectId, expectedRevision: 0, content: content() });

    const staleSet = yield* Effect.flip(
      service.set({ projectId, expectedRevision: 0, content: content("stale") }),
    );
    assert.equal(staleSet._tag, "CivilizationProjectBriefConflictError");
    if (staleSet._tag === "CivilizationProjectBriefConflictError") {
      assert.equal(staleSet.expectedRevision, 0);
      assert.equal(staleSet.currentRevision, 1);
    }

    const staleClear = yield* Effect.flip(service.clear({ projectId, expectedRevision: 0 }));
    assert.equal(staleClear._tag, "CivilizationProjectBriefConflictError");
    assert.equal((yield* service.readDetail(projectId)).revision, 1);
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "strictly validates structure, unsafe text, field limits, and the canonical 4 KiB cap",
  () =>
    Effect.gen(function* () {
      const service = yield* ProjectBriefService.CivilizationProjectBriefService;
      yield* seedProject;

      for (const invalidContent of [
        { ...content(), summary: "unsafe\u0000summary" },
        {
          ...content(),
          objectives: Array.from({ length: 13 }, (_, index) => `objective ${index}`),
        },
        { ...content(), references: [{ kind: "doc", reference: "x".repeat(1025) }] },
        { ...content(), extra: "unknown" },
      ]) {
        const error = yield* Effect.flip(
          service.set({
            projectId,
            expectedRevision: 0,
            content: invalidContent as CivilizationProjectBriefContentV1,
          }),
        );
        assert.equal(error._tag, "CivilizationProjectBriefInvalidError");
      }

      let oversized = content("x".repeat(2048));
      oversized = {
        ...oversized,
        objectives: Array.from({ length: 5 }, () => "y".repeat(400)),
      };
      assert.isAbove(
        Buffer.byteLength(JSON.stringify(oversized), "utf8"),
        CIVILIZATION_MAX_PROJECT_BRIEF_BYTES,
      );
      const tooLarge = yield* Effect.flip(
        service.set({ projectId, expectedRevision: 0, content: oversized }),
      );
      assert.equal(tooLarge._tag, "CivilizationProjectBriefInvalidError");
      if (tooLarge._tag === "CivilizationProjectBriefInvalidError") {
        assert.equal(tooLarge.reason, "content_too_large");
      }
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("requires an open host project for reads and writes", () =>
  Effect.gen(function* () {
    const service = yield* ProjectBriefService.CivilizationProjectBriefService;
    const missing = yield* Effect.flip(service.readMetadata(projectId));
    assert.equal(missing._tag, "CivilizationProjectBriefInvalidError");

    yield* seedProject;
    const sql = yield* SqlClient.SqlClient;
    yield* sql`UPDATE projection_projects SET deleted_at = '2026-10-18T01:00:00.000Z' WHERE project_id = ${projectId}`;
    const deleted = yield* Effect.flip(
      service.set({ projectId, expectedRevision: 0, content: content() }),
    );
    assert.equal(deleted._tag, "CivilizationProjectBriefInvalidError");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("fails closed on corrupt or non-canonical stored content", () =>
  Effect.gen(function* () {
    const service = yield* ProjectBriefService.CivilizationProjectBriefService;
    const sql = yield* SqlClient.SqlClient;
    yield* seedProject;
    yield* sql`
      INSERT INTO civilization_project_brief (project_id, revision, content_json, body_bytes, updated_at)
      VALUES (${projectId}, 4, '{"broken":true}', 15, '2026-10-18T00:00:00.000Z')
    `;

    const readError = yield* Effect.flip(service.readDetail(projectId));
    assert.equal(readError._tag, "CivilizationUnavailableError");
    const writeError = yield* Effect.flip(
      service.set({ projectId, expectedRevision: 4, content: content("replacement") }),
    );
    assert.equal(writeError._tag, "CivilizationUnavailableError");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
