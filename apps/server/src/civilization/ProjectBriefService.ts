import {
  CIVILIZATION_MAX_PROJECT_BRIEF_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS,
  CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES,
  CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES,
  type CivilizationProjectBriefClearRequest,
  CivilizationProjectBriefConflictError,
  CivilizationProjectBriefContentV1,
  type CivilizationProjectBriefDetail,
  CivilizationProjectBriefInvalidError,
  type CivilizationProjectBriefMetadata,
  type CivilizationProjectBriefSetRequest,
  CivilizationUnavailableError,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

type BriefRow = {
  readonly revision: number;
  readonly content_json: string | null;
  readonly body_bytes: number;
  readonly updated_at: string;
};

const projectBriefContentJson = Schema.fromJsonString(CivilizationProjectBriefContentV1);
const encodeProjectBriefContentJson = Schema.encodeSync(projectBriefContentJson);
const decodeProjectBriefContentJson = Schema.decodeEffect(projectBriefContentJson);
const isProjectBriefInvalidError = Schema.is(CivilizationProjectBriefInvalidError);

const utf8Length = (value: string) => Buffer.byteLength(value, "utf8");
const unsafeText = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

const invalid = (reason: CivilizationProjectBriefInvalidError["reason"], message: string) =>
  new CivilizationProjectBriefInvalidError({
    code: "civilization_project_brief_invalid",
    reason,
    message,
  });

const exactKeys = (value: object, keys: ReadonlyArray<string>) => {
  const actual = Object.keys(value).toSorted();
  const expected = [...keys].toSorted();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
};

const validateText = (value: unknown, label: string, maxBytes: number) => {
  if (
    typeof value !== "string" ||
    value.trim().length === 0 ||
    unsafeText(value) ||
    utf8Length(value) > maxBytes
  ) {
    throw invalid(
      "invalid_content",
      `${label} must be non-empty safe text of at most ${maxBytes} UTF-8 bytes.`,
    );
  }
  return value;
};

const canonicalizeContent = (input: CivilizationProjectBriefContentV1) => {
  const value = input as unknown;
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, ["version", "summary", "objectives", "constraints", "references"])
  ) {
    throw invalid("invalid_content", "Project Brief content has an invalid structure.");
  }
  const record = value as Record<string, unknown>;
  if (record.version !== 1) {
    throw invalid("invalid_content", "Project Brief content version must be 1.");
  }
  const summary = validateText(
    record.summary,
    "Project Brief summary",
    CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES,
  );
  const validateItems = (raw: unknown, label: string) => {
    if (!Array.isArray(raw) || raw.length > CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS) {
      throw invalid(
        "invalid_content",
        `${label} must contain at most ${CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS} items.`,
      );
    }
    return raw.map((item, index) =>
      validateText(item, `${label} item ${index + 1}`, CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES),
    );
  };
  const objectives = validateItems(record.objectives, "Project Brief objectives");
  const constraints = validateItems(record.constraints, "Project Brief constraints");
  if (
    !Array.isArray(record.references) ||
    record.references.length > CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES
  ) {
    throw invalid(
      "invalid_content",
      `Project Brief references must contain at most ${CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES} items.`,
    );
  }
  const seenReferences = new Set<string>();
  const references = record.references.map((reference, index) => {
    if (
      typeof reference !== "object" ||
      reference === null ||
      Array.isArray(reference) ||
      !exactKeys(reference, ["kind", "reference"])
    ) {
      throw invalid("invalid_content", `Project Brief reference ${index + 1} is invalid.`);
    }
    const referenceRecord = reference as Record<string, unknown>;
    const kind = validateText(
      referenceRecord.kind,
      `Project Brief reference ${index + 1} kind`,
      CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES,
    );
    const referenceValue = validateText(
      referenceRecord.reference,
      `Project Brief reference ${index + 1} value`,
      CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES,
    );
    const key = `${kind}\u0000${referenceValue}`;
    if (seenReferences.has(key)) {
      throw invalid("invalid_content", "Duplicate Project Brief references are not allowed.");
    }
    seenReferences.add(key);
    return { kind, reference: referenceValue };
  });
  const content = {
    version: 1 as const,
    summary,
    objectives,
    constraints,
    references,
  } satisfies CivilizationProjectBriefContentV1;
  const json = encodeProjectBriefContentJson(content);
  const bodyBytes = utf8Length(json);
  if (bodyBytes > CIVILIZATION_MAX_PROJECT_BRIEF_BYTES) {
    throw invalid(
      "content_too_large",
      `Project Brief canonical payload exceeds ${CIVILIZATION_MAX_PROJECT_BRIEF_BYTES} UTF-8 bytes.`,
    );
  }
  return { content, json, bodyBytes } as const;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const ensureProjectOpen = Effect.fn("CivilizationProjectBrief.ensureProjectOpen")(function* (
    projectId: ProjectId,
  ) {
    const row = (yield* sql<{ readonly project_id: string }>`
      SELECT project_id FROM projection_projects
      WHERE project_id = ${projectId} AND deleted_at IS NULL
      LIMIT 1
    `)[0];
    if (row === undefined) {
      return yield* invalid(
        "project_unavailable",
        `Project ${projectId} does not exist or is deleted.`,
      );
    }
  });

  const readRow = Effect.fn("CivilizationProjectBrief.readRow")(function* (projectId: ProjectId) {
    return (yield* sql<BriefRow>`
      SELECT revision, content_json, body_bytes, updated_at
      FROM civilization_project_brief
      WHERE project_id = ${projectId}
      LIMIT 1
    `)[0];
  });

  const decodeRow = Effect.fn("CivilizationProjectBrief.decodeRow")(function* (
    projectId: ProjectId,
    row: BriefRow,
  ) {
    const failCorrupt = (message: string) =>
      new CivilizationUnavailableError({
        code: "civilization_unavailable",
        reason: "corrupt_state",
        message,
      });
    if (!Number.isSafeInteger(row.revision) || row.revision < 1 || row.body_bytes < 0) {
      return yield* failCorrupt(`Stored Project Brief state for ${projectId} is invalid.`);
    }
    const contentJson = row.content_json;
    if (contentJson === null) {
      if (row.body_bytes !== 0) {
        return yield* failCorrupt(
          `Stored Project Brief byte metadata for ${projectId} is invalid.`,
        );
      }
      return { content: null, bodyBytes: 0 } as const;
    }
    if (row.body_bytes <= 0) {
      return yield* failCorrupt(`Stored Project Brief byte metadata for ${projectId} is invalid.`);
    }
    const parsed = yield* decodeProjectBriefContentJson(contentJson).pipe(
      Effect.mapError(() =>
        failCorrupt(`Stored Project Brief content for ${projectId} is not valid JSON.`),
      ),
    );
    const canonical = yield* Effect.try({
      try: () => canonicalizeContent(parsed),
      catch: () => failCorrupt(`Stored Project Brief content for ${projectId} is invalid.`),
    });
    if (canonical.json !== contentJson || canonical.bodyBytes !== row.body_bytes) {
      return yield* failCorrupt(`Stored Project Brief content for ${projectId} is not canonical.`);
    }
    return { content: canonical.content, bodyBytes: canonical.bodyBytes } as const;
  });

  const metadataFor = (
    projectId: ProjectId,
    row: BriefRow | undefined,
  ): CivilizationProjectBriefMetadata => ({
    projectId,
    revision: row?.revision ?? 0,
    configured: row?.content_json !== null && row?.content_json !== undefined,
    bodyBytes: row?.body_bytes ?? 0,
    updatedAt: row?.updated_at ?? null,
  });

  const readMetadata = Effect.fn("CivilizationProjectBrief.readMetadata")(function* (
    projectId: ProjectId,
  ) {
    yield* ensureProjectOpen(projectId);
    const row = yield* readRow(projectId);
    if (row !== undefined) yield* decodeRow(projectId, row);
    return metadataFor(projectId, row);
  });

  const readDetail = Effect.fn("CivilizationProjectBrief.readDetail")(function* (
    projectId: ProjectId,
  ) {
    yield* ensureProjectOpen(projectId);
    const row = yield* readRow(projectId);
    if (row === undefined) {
      return {
        ...metadataFor(projectId, undefined),
        content: null,
      } satisfies CivilizationProjectBriefDetail;
    }
    const decoded = yield* decodeRow(projectId, row);
    return {
      ...metadataFor(projectId, row),
      content: decoded.content,
    } satisfies CivilizationProjectBriefDetail;
  });

  const set = Effect.fn("CivilizationProjectBrief.set")(function* (
    input: CivilizationProjectBriefSetRequest,
  ) {
    const canonical = yield* Effect.try({
      try: () => canonicalizeContent(input.content),
      catch: (cause) =>
        isProjectBriefInvalidError(cause)
          ? cause
          : invalid("invalid_content", "Project Brief validation failed."),
    });
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* ensureProjectOpen(input.projectId);
        const current = yield* readRow(input.projectId);
        if (current !== undefined) yield* decodeRow(input.projectId, current);
        const currentRevision = current?.revision ?? 0;
        if (input.expectedRevision !== currentRevision) {
          return yield* new CivilizationProjectBriefConflictError({
            code: "civilization_project_brief_conflict",
            projectId: input.projectId,
            expectedRevision: input.expectedRevision,
            currentRevision,
          });
        }
        const revision = currentRevision + 1;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          INSERT INTO civilization_project_brief (
            project_id, revision, content_json, body_bytes, updated_at
          ) VALUES (
            ${input.projectId}, ${revision}, ${canonical.json}, ${canonical.bodyBytes}, ${updatedAt}
          )
          ON CONFLICT(project_id) DO UPDATE SET
            revision = excluded.revision,
            content_json = excluded.content_json,
            body_bytes = excluded.body_bytes,
            updated_at = excluded.updated_at
        `;
        return {
          projectId: input.projectId,
          revision,
          configured: true,
          bodyBytes: canonical.bodyBytes,
          updatedAt,
          content: canonical.content,
        } satisfies CivilizationProjectBriefDetail;
      }),
    );
  });

  const clear = Effect.fn("CivilizationProjectBrief.clear")(function* (
    input: CivilizationProjectBriefClearRequest,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* ensureProjectOpen(input.projectId);
        const current = yield* readRow(input.projectId);
        if (current !== undefined) yield* decodeRow(input.projectId, current);
        const currentRevision = current?.revision ?? 0;
        if (input.expectedRevision !== currentRevision) {
          return yield* new CivilizationProjectBriefConflictError({
            code: "civilization_project_brief_conflict",
            projectId: input.projectId,
            expectedRevision: input.expectedRevision,
            currentRevision,
          });
        }
        if (current === undefined || current.content_json === null) {
          return yield* invalid("not_configured", "Project Brief is not currently configured.");
        }
        const revision = currentRevision + 1;
        const updatedAt = DateTime.formatIso(yield* DateTime.now);
        yield* sql`
          UPDATE civilization_project_brief
          SET revision = ${revision}, content_json = NULL, body_bytes = 0, updated_at = ${updatedAt}
          WHERE project_id = ${input.projectId}
        `;
        return {
          projectId: input.projectId,
          revision,
          configured: false,
          bodyBytes: 0,
          updatedAt,
          content: null,
        } satisfies CivilizationProjectBriefDetail;
      }),
    );
  });

  return { readMetadata, readDetail, set, clear } as const;
});

export type CivilizationProjectBriefServiceShape = Effect.Success<typeof make>;

export class CivilizationProjectBriefService extends Context.Service<
  CivilizationProjectBriefService,
  CivilizationProjectBriefServiceShape
>()("t3/civilization/ProjectBriefService/CivilizationProjectBriefService") {}

export const layer = Layer.effect(CivilizationProjectBriefService, make);
