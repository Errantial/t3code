// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off globalDate:off -- Chronicle provenance hashing, canonical HTTP time filters, and bounded metadata JSON are deliberate SQLite persistence boundaries.
import {
  CivilizationAchievementAward,
  CivilizationAchievementAwardId,
  CivilizationAchievementCursor,
  type CivilizationAchievementId,
  type CivilizationAchievementPage,
  CivilizationChronicleCursor,
  CivilizationChronicleEntry,
  CivilizationChronicleEntryId,
  type CivilizationChronicleKind,
  type CivilizationChroniclePage,
  type CivilizationChronicleSourceKind,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { getEffectiveCivilizationConfig } from "./ConfigService.ts";

const CURSOR_VERSION = 1 as const;
const ACHIEVEMENT_CURSOR_VERSION = 1 as const;

export class CivilizationChronicleInvalidError extends Schema.TaggedError<CivilizationChronicleInvalidError>()(
  "CivilizationChronicleInvalidError",
  {
    reason: Schema.Literals([
      "invalid_cursor",
      "invalid_limit",
      "invalid_time_range",
      "response_too_large",
    ]),
    message: Schema.String,
  },
) {}

const invalid = (reason: CivilizationChronicleInvalidError["reason"], message: string) =>
  new CivilizationChronicleInvalidError({ reason, message });
const METADATA_KEYS_MAX = 16;
const METADATA_KEY_BYTES_MAX = 64;
const METADATA_VALUE_BYTES_MAX = 256;
const METADATA_JSON_BYTES_MAX = 4096;

interface ChronicleRow {
  readonly entry_id: string;
  readonly project_id: ProjectId;
  readonly kind: CivilizationChronicleKind;
  readonly primary_thread_id: ThreadId | null;
  readonly secondary_thread_id: ThreadId | null;
  readonly citizen_epoch: number | null;
  readonly citizen_revision: number | null;
  readonly source_kind: CivilizationChronicleSourceKind;
  readonly source_id: string;
  readonly source_sequence: number | null;
  readonly occurred_at: string;
  readonly metadata_json: string;
}

interface ChronicleCursorPayload {
  readonly v: typeof CURSOR_VERSION;
  readonly projectId: string;
  readonly revision: number;
  readonly kind: CivilizationChronicleKind | null;
  readonly threadId: string | null;
  readonly from: string | null;
  readonly to: string | null;
  readonly afterOccurredAt: string;
  readonly afterEntryId: string;
}

interface AchievementRow {
  readonly award_id: string;
  readonly project_id: ProjectId;
  readonly achievement_id: CivilizationAchievementId;
  readonly definition_version: number;
  readonly subject_thread_id: ThreadId | null;
  readonly trigger_entry_id: string;
  readonly awarded_at: string;
}

interface AchievementCursorPayload {
  readonly v: typeof ACHIEVEMENT_CURSOR_VERSION;
  readonly projectId: string;
  readonly revision: number;
  readonly threadId: string | null;
  readonly afterAwardedAt: string;
  readonly afterAwardId: string;
}

export interface AchievementListInput {
  readonly projectId: ProjectId;
  readonly threadId?: ThreadId | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

export interface ChronicleListInput {
  readonly projectId: ProjectId;
  readonly kind?: CivilizationChronicleKind | undefined;
  readonly threadId?: ThreadId | undefined;
  readonly from?: string | undefined;
  readonly to?: string | undefined;
  readonly cursor?: string | undefined;
  readonly limit?: number | undefined;
}

interface ChronicleRecordBase {
  readonly projectId: ProjectId;
  readonly primaryThreadId?: ThreadId | null | undefined;
  readonly secondaryThreadId?: ThreadId | null | undefined;
  readonly citizenEpoch?: number | null | undefined;
  readonly citizenRevision?: number | null | undefined;
  readonly sourceKind: CivilizationChronicleSourceKind;
  readonly sourceId: string;
  readonly sourceSequence?: number | null | undefined;
  readonly occurredAt: string;
}

export type ChronicleRecordInput =
  | (ChronicleRecordBase & {
      readonly kind: "child_joined";
      readonly metadata: { readonly relationship: string };
    })
  | (ChronicleRecordBase & {
      readonly kind:
        | "citizen_joined"
        | "citizen_adopted"
        | "citizen_settled"
        | "citizen_returned"
        | "citizen_archived"
        | "citizen_deleted";
      readonly metadata?: never;
    });

const utf8Length = (value: string): number => Buffer.byteLength(value, "utf8");

function boundedMetadata(
  input: { readonly relationship: string } | undefined,
): Record<string, string> {
  if (input === undefined) return {};
  const entries = Object.entries(input).sort(([left], [right]) => left.localeCompare(right));
  if (entries.length > METADATA_KEYS_MAX) throw new Error("Chronicle metadata has too many keys.");
  const result: Record<string, string> = {};
  for (const [key, value] of entries) {
    if (utf8Length(key) > METADATA_KEY_BYTES_MAX || utf8Length(value) > METADATA_VALUE_BYTES_MAX) {
      throw new Error("Chronicle metadata exceeds its bounded field size.");
    }
    result[key] = value;
  }
  if (utf8Length(JSON.stringify(result)) > METADATA_JSON_BYTES_MAX) {
    throw new Error("Chronicle metadata exceeds its bounded payload size.");
  }
  return result;
}

function normalizeTimeFilter(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const epoch = Date.parse(value);
  if (!Number.isFinite(epoch)) return undefined;
  return new Date(epoch).toISOString();
}

function compareRows(left: ChronicleRow, right: ChronicleRow): number {
  const byTime = right.occurred_at.localeCompare(left.occurred_at);
  return byTime !== 0 ? byTime : right.entry_id.localeCompare(left.entry_id);
}

function mergeBoundedRows(
  left: ReadonlyArray<ChronicleRow>,
  right: ReadonlyArray<ChronicleRow>,
  limit: number,
): Array<ChronicleRow> {
  const byId = new Map<string, ChronicleRow>();
  for (const row of left) byId.set(row.entry_id, row);
  for (const row of right) byId.set(row.entry_id, row);
  return [...byId.values()].sort(compareRows).slice(0, limit);
}

const encodeCursor = (payload: ChronicleCursorPayload): CivilizationChronicleCursor =>
  CivilizationChronicleCursor.make(
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  );

function decodeCursor(
  cursor: string | undefined,
  input: ChronicleListInput,
): ChronicleCursorPayload | null {
  if (cursor === undefined) return null;
  let parsed: ChronicleCursorPayload;
  try {
    parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as ChronicleCursorPayload;
  } catch {
    throw new Error("Invalid Chronicle cursor.");
  }
  if (
    parsed.v !== CURSOR_VERSION ||
    parsed.projectId !== input.projectId ||
    parsed.kind !== (input.kind ?? null) ||
    parsed.threadId !== (input.threadId ?? null) ||
    parsed.from !== (input.from ?? null) ||
    parsed.to !== (input.to ?? null) ||
    !Number.isSafeInteger(parsed.revision) ||
    typeof parsed.afterOccurredAt !== "string" ||
    typeof parsed.afterEntryId !== "string"
  ) {
    throw new Error("Chronicle cursor does not match the current query.");
  }
  return parsed;
}

const encodeAchievementCursor = (
  payload: AchievementCursorPayload,
): CivilizationAchievementCursor =>
  CivilizationAchievementCursor.make(
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
  );

function decodeAchievementCursor(
  cursor: string | undefined,
  input: AchievementListInput,
): AchievementCursorPayload | null {
  if (cursor === undefined) return null;
  let parsed: AchievementCursorPayload;
  try {
    parsed = JSON.parse(
      Buffer.from(cursor, "base64url").toString("utf8"),
    ) as AchievementCursorPayload;
  } catch {
    throw new Error("Invalid achievement cursor.");
  }
  if (
    parsed.v !== ACHIEVEMENT_CURSOR_VERSION ||
    parsed.projectId !== input.projectId ||
    parsed.threadId !== (input.threadId ?? null) ||
    !Number.isSafeInteger(parsed.revision) ||
    typeof parsed.afterAwardedAt !== "string" ||
    typeof parsed.afterAwardId !== "string"
  ) {
    throw new Error("Achievement cursor does not match the current query.");
  }
  return parsed;
}

const decodeChronicleEntry = Schema.decodeUnknownSync(CivilizationChronicleEntry);
const rowToEntry = (row: ChronicleRow): CivilizationChronicleEntry =>
  decodeChronicleEntry({
    entryId: CivilizationChronicleEntryId.make(row.entry_id),
    projectId: row.project_id,
    kind: row.kind,
    primaryThreadId: row.primary_thread_id,
    secondaryThreadId: row.secondary_thread_id,
    citizenEpoch: row.citizen_epoch,
    citizenRevision: row.citizen_revision,
    sourceKind: row.source_kind,
    sourceId: row.source_id,
    sourceSequence: row.source_sequence,
    occurredAt: row.occurred_at,
    metadata: JSON.parse(row.metadata_json) as unknown,
  });

const decodeAchievementAward = Schema.decodeUnknownSync(CivilizationAchievementAward);
const rowToAchievement = (row: AchievementRow): CivilizationAchievementAward =>
  decodeAchievementAward({
    awardId: CivilizationAchievementAwardId.make(row.award_id),
    projectId: row.project_id,
    achievementId: row.achievement_id,
    definitionVersion: row.definition_version,
    subjectThreadId: row.subject_thread_id,
    triggerEntryId: CivilizationChronicleEntryId.make(row.trigger_entry_id),
    awardedAt: row.awarded_at,
  });

export const recordChronicleEntry = Effect.fn("CivilizationChronicle.record")(function* (
  input: ChronicleRecordInput,
) {
  const sql = yield* SqlClient.SqlClient;
  const metadata = boundedMetadata(input.metadata);
  const provenanceKey = [
    input.sourceKind,
    input.sourceId,
    input.kind,
    input.primaryThreadId ?? "",
    input.secondaryThreadId ?? "",
  ].join("\u001f");
  const digest = NodeCrypto.createHash("sha256")
    .update(provenanceKey)
    .digest("base64url")
    .slice(0, 32);
  const entryId = CivilizationChronicleEntryId.make(`chronicle:${digest}`);
  yield* sql`
    INSERT OR IGNORE INTO civilization_chronicle_entries (
      entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
      citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
      provenance_key, occurred_at, metadata_json
    ) VALUES (
      ${entryId}, ${input.projectId}, ${input.kind}, ${input.primaryThreadId ?? null},
      ${input.secondaryThreadId ?? null}, ${input.citizenEpoch ?? null}, ${input.citizenRevision ?? null},
      ${input.sourceKind}, ${input.sourceId}, ${input.sourceSequence ?? null}, ${provenanceKey},
      ${input.occurredAt}, ${JSON.stringify(metadata)}
    )
  `;
  return entryId;
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const list = Effect.fn("CivilizationChronicle.list")(function* (input: ChronicleListInput) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
          return yield* invalid("invalid_limit", "Chronicle limit must be a positive integer.");
        }
        const limit = Math.min(
          input.limit ?? effective.config.operations.censusPageSize,
          effective.config.operations.censusPageSize,
        );
        const normalizedFrom = normalizeTimeFilter(input.from);
        const normalizedTo = normalizeTimeFilter(input.to);
        if (
          (input.from !== undefined && normalizedFrom === undefined) ||
          (input.to !== undefined && normalizedTo === undefined) ||
          (normalizedFrom !== undefined &&
            normalizedTo !== undefined &&
            normalizedFrom > normalizedTo)
        ) {
          return yield* invalid(
            "invalid_time_range",
            "Chronicle time filters must be valid ISO timestamps in ascending order.",
          );
        }
        const normalizedInput: ChronicleListInput = {
          ...input,
          ...(normalizedFrom === undefined ? { from: undefined } : { from: normalizedFrom }),
          ...(normalizedTo === undefined ? { to: undefined } : { to: normalizedTo }),
        };
        const state = (yield* sql<{ readonly chronicle_revision: number }>`
          SELECT chronicle_revision FROM civilization_project_state
          WHERE project_id = ${input.projectId} LIMIT 1
        `)[0] ?? { chronicle_revision: 0 };
        const cursor = yield* Effect.try({
          try: () => decodeCursor(input.cursor, normalizedInput),
          catch: () =>
            invalid("invalid_cursor", "Chronicle cursor is invalid or does not match this query."),
        });
        if (cursor !== null && cursor.revision !== state.chronicle_revision) {
          return yield* invalid(
            "invalid_cursor",
            "Chronicle changed while paging; restart from the first page.",
          );
        }
        const fromBound = normalizedFrom ?? "0000-01-01T00:00:00.000Z";
        const afterOccurredAt =
          cursor?.afterOccurredAt ?? normalizedTo ?? "9999-12-31T23:59:59.999Z";
        const afterEntryId = cursor?.afterEntryId ?? "\uffff";
        const queryLimit = limit + 1;
        let rows: ReadonlyArray<ChronicleRow>;
        if (input.threadId === undefined) {
          rows =
            input.kind === undefined
              ? yield* sql<ChronicleRow>`
                  SELECT entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
                         citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
                         occurred_at, metadata_json
                  FROM civilization_chronicle_entries
                  WHERE project_id = ${input.projectId}
                    AND occurred_at >= ${fromBound}
                    AND (occurred_at, entry_id) < (${afterOccurredAt}, ${afterEntryId})
                  ORDER BY occurred_at DESC, entry_id DESC
                  LIMIT ${queryLimit}
                `
              : yield* sql<ChronicleRow>`
                  SELECT entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
                         citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
                         occurred_at, metadata_json
                  FROM civilization_chronicle_entries
                  WHERE project_id = ${input.projectId}
                    AND kind = ${input.kind}
                    AND occurred_at >= ${fromBound}
                    AND (occurred_at, entry_id) < (${afterOccurredAt}, ${afterEntryId})
                  ORDER BY occurred_at DESC, entry_id DESC
                  LIMIT ${queryLimit}
                `;
        } else {
          const primary =
            input.kind === undefined
              ? yield* sql<ChronicleRow>`
                  SELECT entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
                         citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
                         occurred_at, metadata_json
                  FROM civilization_chronicle_entries
                  WHERE project_id = ${input.projectId}
                    AND primary_thread_id = ${input.threadId}
                    AND occurred_at >= ${fromBound}
                    AND (occurred_at, entry_id) < (${afterOccurredAt}, ${afterEntryId})
                  ORDER BY occurred_at DESC, entry_id DESC
                  LIMIT ${queryLimit}
                `
              : yield* sql<ChronicleRow>`
                  SELECT entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
                         citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
                         occurred_at, metadata_json
                  FROM civilization_chronicle_entries
                  WHERE project_id = ${input.projectId}
                    AND primary_thread_id = ${input.threadId}
                    AND kind = ${input.kind}
                    AND occurred_at >= ${fromBound}
                    AND (occurred_at, entry_id) < (${afterOccurredAt}, ${afterEntryId})
                  ORDER BY occurred_at DESC, entry_id DESC
                  LIMIT ${queryLimit}
                `;
          const secondary =
            input.kind === undefined
              ? yield* sql<ChronicleRow>`
                  SELECT entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
                         citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
                         occurred_at, metadata_json
                  FROM civilization_chronicle_entries
                  WHERE project_id = ${input.projectId}
                    AND secondary_thread_id = ${input.threadId}
                    AND occurred_at >= ${fromBound}
                    AND (occurred_at, entry_id) < (${afterOccurredAt}, ${afterEntryId})
                  ORDER BY occurred_at DESC, entry_id DESC
                  LIMIT ${queryLimit}
                `
              : yield* sql<ChronicleRow>`
                  SELECT entry_id, project_id, kind, primary_thread_id, secondary_thread_id,
                         citizen_epoch, citizen_revision, source_kind, source_id, source_sequence,
                         occurred_at, metadata_json
                  FROM civilization_chronicle_entries
                  WHERE project_id = ${input.projectId}
                    AND secondary_thread_id = ${input.threadId}
                    AND kind = ${input.kind}
                    AND occurred_at >= ${fromBound}
                    AND (occurred_at, entry_id) < (${afterOccurredAt}, ${afterEntryId})
                  ORDER BY occurred_at DESC, entry_id DESC
                  LIMIT ${queryLimit}
                `;
          rows = mergeBoundedRows(primary, secondary, queryLimit);
        }
        const entries: Array<CivilizationChronicleEntry> = [];
        let byteLimited = false;
        for (const row of rows.slice(0, limit)) {
          const candidate = rowToEntry(row);
          const nextCursor = encodeCursor({
            v: CURSOR_VERSION,
            projectId: input.projectId,
            revision: state.chronicle_revision,
            kind: input.kind ?? null,
            threadId: input.threadId ?? null,
            from: normalizedFrom ?? null,
            to: normalizedTo ?? null,
            afterOccurredAt: row.occurred_at,
            afterEntryId: row.entry_id,
          });
          const candidatePage: CivilizationChroniclePage = {
            projectId: input.projectId,
            revision: state.chronicle_revision,
            entries: [...entries, candidate],
            nextCursor,
            partial: true,
          };
          if (
            utf8Length(JSON.stringify(candidatePage)) >
            effective.config.operations.responseBodyBytes
          ) {
            byteLimited = true;
            break;
          }
          entries.push(candidate);
        }
        if (rows.length > 0 && entries.length === 0) {
          return yield* invalid(
            "response_too_large",
            "Chronicle response limit cannot fit one entry.",
          );
        }
        const partial = byteLimited || rows.length > entries.length;
        const last = entries.length === 0 ? undefined : rows[entries.length - 1];
        return {
          projectId: input.projectId,
          revision: state.chronicle_revision,
          entries,
          nextCursor:
            !partial || last === undefined
              ? null
              : encodeCursor({
                  v: CURSOR_VERSION,
                  projectId: input.projectId,
                  revision: state.chronicle_revision,
                  kind: input.kind ?? null,
                  threadId: input.threadId ?? null,
                  from: normalizedFrom ?? null,
                  to: normalizedTo ?? null,
                  afterOccurredAt: last.occurred_at,
                  afterEntryId: last.entry_id,
                }),
          partial,
        } satisfies CivilizationChroniclePage;
      }),
    );
  });

  const listAchievements = Effect.fn("CivilizationChronicle.listAchievements")(function* (
    input: AchievementListInput,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const effective = yield* getEffectiveCivilizationConfig(input.projectId).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
        );
        if (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1)) {
          return yield* invalid("invalid_limit", "Achievement limit must be a positive integer.");
        }
        const limit = Math.min(
          input.limit ?? effective.config.operations.censusPageSize,
          effective.config.operations.censusPageSize,
        );
        const state = (yield* sql<{ readonly achievement_revision: number }>`
          SELECT achievement_revision FROM civilization_project_state
          WHERE project_id = ${input.projectId} LIMIT 1
        `)[0] ?? { achievement_revision: 0 };
        const cursor = yield* Effect.try({
          try: () => decodeAchievementCursor(input.cursor, input),
          catch: () =>
            invalid(
              "invalid_cursor",
              "Achievement cursor is invalid or does not match this query.",
            ),
        });
        if (cursor !== null && cursor.revision !== state.achievement_revision) {
          return yield* invalid(
            "invalid_cursor",
            "Achievements changed while paging; restart from the first page.",
          );
        }
        const afterAwardedAt = cursor?.afterAwardedAt ?? "9999-12-31T23:59:59.999Z";
        const afterAwardId = cursor?.afterAwardId ?? "\uffff";
        const queryLimit = limit + 1;
        const rows =
          input.threadId === undefined
            ? yield* sql<AchievementRow>`
                SELECT award_id, project_id, achievement_id, definition_version,
                       subject_thread_id, trigger_entry_id, awarded_at
                FROM civilization_achievement_awards
                WHERE project_id = ${input.projectId}
                  AND (awarded_at, award_id) < (${afterAwardedAt}, ${afterAwardId})
                ORDER BY awarded_at DESC, award_id DESC
                LIMIT ${queryLimit}
              `
            : yield* sql<AchievementRow>`
                SELECT award_id, project_id, achievement_id, definition_version,
                       subject_thread_id, trigger_entry_id, awarded_at
                FROM civilization_achievement_awards
                WHERE project_id = ${input.projectId}
                  AND subject_thread_id = ${input.threadId}
                  AND (awarded_at, award_id) < (${afterAwardedAt}, ${afterAwardId})
                ORDER BY awarded_at DESC, award_id DESC
                LIMIT ${queryLimit}
              `;
        const awards: Array<CivilizationAchievementAward> = [];
        let byteLimited = false;
        for (const row of rows.slice(0, limit)) {
          const candidate = rowToAchievement(row);
          const candidatePage: CivilizationAchievementPage = {
            projectId: input.projectId,
            revision: state.achievement_revision,
            awards: [...awards, candidate],
            nextCursor: encodeAchievementCursor({
              v: ACHIEVEMENT_CURSOR_VERSION,
              projectId: input.projectId,
              revision: state.achievement_revision,
              threadId: input.threadId ?? null,
              afterAwardedAt: row.awarded_at,
              afterAwardId: row.award_id,
            }),
            partial: true,
          };
          if (
            utf8Length(JSON.stringify(candidatePage)) >
            effective.config.operations.responseBodyBytes
          ) {
            byteLimited = true;
            break;
          }
          awards.push(candidate);
        }
        if (rows.length > 0 && awards.length === 0) {
          return yield* invalid(
            "response_too_large",
            "Achievement response limit cannot fit one award.",
          );
        }
        const partial = byteLimited || rows.length > awards.length;
        const last = awards.length === 0 ? undefined : rows[awards.length - 1];
        return {
          projectId: input.projectId,
          revision: state.achievement_revision,
          awards,
          nextCursor:
            !partial || last === undefined
              ? null
              : encodeAchievementCursor({
                  v: ACHIEVEMENT_CURSOR_VERSION,
                  projectId: input.projectId,
                  revision: state.achievement_revision,
                  threadId: input.threadId ?? null,
                  afterAwardedAt: last.awarded_at,
                  afterAwardId: last.award_id,
                }),
          partial,
        } satisfies CivilizationAchievementPage;
      }),
    );
  });

  return { list, listAchievements, record: recordChronicleEntry } as const;
});

export type CivilizationChronicleServiceShape = Effect.Success<typeof make>;

export class CivilizationChronicleService extends Context.Service<
  CivilizationChronicleService,
  Effect.Success<typeof make>
>()("t3/civilization/ChronicleService/CivilizationChronicleService") {}

export const layer = Layer.effect(CivilizationChronicleService, make);
