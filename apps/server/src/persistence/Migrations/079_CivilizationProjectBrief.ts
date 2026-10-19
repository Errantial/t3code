import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE civilization_project_brief (
      project_id TEXT PRIMARY KEY,
      revision INTEGER NOT NULL CHECK (revision >= 1),
      content_json TEXT,
      body_bytes INTEGER NOT NULL CHECK (body_bytes >= 0),
      updated_at TEXT NOT NULL,
      CHECK (
        (content_json IS NULL AND body_bytes = 0) OR
        (content_json IS NOT NULL AND body_bytes > 0)
      )
    )
  `;

  // Only bounded Brief provenance is retained with packet references and
  // inspections. The operator-authored body remains solely in the Brief row
  // (and in diagnostic packet text when existing diagnostics policy retains it).
  yield* sql`ALTER TABLE civilization_context_references ADD COLUMN brief_revision INTEGER`;
  yield* sql`ALTER TABLE civilization_context_references ADD COLUMN brief_body_bytes INTEGER NOT NULL DEFAULT 0 CHECK (brief_body_bytes >= 0)`;
  yield* sql`ALTER TABLE civilization_context_references ADD COLUMN brief_included INTEGER NOT NULL DEFAULT 0 CHECK (brief_included IN (0, 1))`;

  yield* sql`ALTER TABLE civilization_context_inspections ADD COLUMN brief_revision INTEGER`;
  yield* sql`ALTER TABLE civilization_context_inspections ADD COLUMN brief_body_bytes INTEGER NOT NULL DEFAULT 0 CHECK (brief_body_bytes >= 0)`;
  yield* sql`ALTER TABLE civilization_context_inspections ADD COLUMN brief_included INTEGER NOT NULL DEFAULT 0 CHECK (brief_included IN (0, 1))`;
});
