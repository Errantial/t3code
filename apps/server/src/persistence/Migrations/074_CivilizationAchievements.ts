import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    ALTER TABLE civilization_project_state
    ADD COLUMN achievement_revision INTEGER NOT NULL DEFAULT 0 CHECK (achievement_revision >= 0)
  `;

  yield* sql`
    CREATE TABLE civilization_achievement_awards (
      award_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      achievement_id TEXT NOT NULL CHECK (achievement_id IN (
        'project_founder',
        'first_descendant',
        'first_acknowledged_correspondence',
        'lineage_generation_3'
      )),
      definition_version INTEGER NOT NULL CHECK (definition_version >= 1),
      subject_thread_id TEXT,
      subject_key TEXT NOT NULL,
      trigger_entry_id TEXT NOT NULL,
      awarded_at TEXT NOT NULL,
      UNIQUE (project_id, achievement_id, subject_key)
    )
  `;
  yield* sql`
    CREATE INDEX civilization_achievement_project_recent_idx
    ON civilization_achievement_awards(project_id, awarded_at DESC, award_id DESC)
  `;
  yield* sql`
    CREATE INDEX civilization_achievement_subject_recent_idx
    ON civilization_achievement_awards(project_id, subject_thread_id, awarded_at DESC, award_id DESC)
  `;

  yield* sql`
    CREATE TRIGGER civilization_achievement_revision_insert
    AFTER INSERT ON civilization_achievement_awards
    BEGIN
      INSERT INTO civilization_project_state (project_id, achievement_revision, updated_at)
      VALUES (NEW.project_id, 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      ON CONFLICT(project_id) DO UPDATE SET
        achievement_revision = achievement_revision + 1,
        updated_at = excluded.updated_at;
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_revision_delete
    AFTER DELETE ON civilization_achievement_awards
    BEGIN
      UPDATE civilization_project_state
      SET achievement_revision = achievement_revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE project_id = OLD.project_id;
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_revision_update
    AFTER UPDATE ON civilization_achievement_awards
    BEGIN
      UPDATE civilization_project_state
      SET achievement_revision = achievement_revision + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE project_id = NEW.project_id;
    END
  `;

  // A founder award is also the proof that Chronicle covered this project from
  // its first authoritative citizen. Projects that predate v1.1 never receive
  // this marker, which prevents later "first" awards from fabricating prehistory.
  yield* sql`
    CREATE TRIGGER civilization_achievement_project_founder
    AFTER INSERT ON civilization_chronicle_entries
    WHEN NEW.kind = 'citizen_joined'
      AND NEW.primary_thread_id IS NOT NULL
      AND NEW.primary_thread_id = (
        SELECT thread_id
        FROM civilization_citizens
        WHERE project_id = NEW.project_id AND observed_only = 0
        ORDER BY birth_sequence ASC, thread_id ASC
        LIMIT 1
      )
    BEGIN
      INSERT INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      ) VALUES (
        'award:project_founder:' || NEW.project_id,
        NEW.project_id, 'project_founder', 1, NEW.primary_thread_id,
        '__project__', NEW.entry_id, NEW.occurred_at
      )
      ON CONFLICT(project_id, achievement_id, subject_key) DO UPDATE SET
        subject_thread_id = excluded.subject_thread_id,
        trigger_entry_id = excluded.trigger_entry_id,
        awarded_at = excluded.awarded_at
      WHERE excluded.awarded_at < civilization_achievement_awards.awarded_at
         OR (
           excluded.awarded_at = civilization_achievement_awards.awarded_at
           AND excluded.trigger_entry_id < civilization_achievement_awards.trigger_entry_id
         );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_first_descendant
    AFTER INSERT ON civilization_chronicle_entries
    WHEN NEW.kind = 'child_joined'
      AND NEW.primary_thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM civilization_achievement_awards
        WHERE project_id = NEW.project_id AND achievement_id = 'project_founder'
      )
    BEGIN
      INSERT INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      )
      SELECT
        'award:first_descendant:' || NEW.project_id,
        NEW.project_id, 'first_descendant', 1, h.primary_thread_id,
        '__project__', h.entry_id, h.occurred_at
      FROM civilization_chronicle_entries h
      WHERE h.project_id = NEW.project_id
        AND h.kind = 'child_joined'
        AND h.primary_thread_id IS NOT NULL
      ORDER BY h.occurred_at ASC, h.entry_id ASC
      LIMIT 1
      ON CONFLICT(project_id, achievement_id, subject_key) DO UPDATE SET
        subject_thread_id = excluded.subject_thread_id,
        trigger_entry_id = excluded.trigger_entry_id,
        awarded_at = excluded.awarded_at
      WHERE excluded.awarded_at < civilization_achievement_awards.awarded_at
         OR (
           excluded.awarded_at = civilization_achievement_awards.awarded_at
           AND excluded.trigger_entry_id < civilization_achievement_awards.trigger_entry_id
         );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_first_acknowledged_correspondence
    AFTER INSERT ON civilization_chronicle_entries
    WHEN NEW.kind = 'mail_acknowledged'
      AND NEW.primary_thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM civilization_achievement_awards
        WHERE project_id = NEW.project_id AND achievement_id = 'project_founder'
      )
    BEGIN
      INSERT INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      )
      SELECT
        'award:first_acknowledged_correspondence:' || NEW.project_id,
        NEW.project_id, 'first_acknowledged_correspondence', 1, h.primary_thread_id,
        '__project__', h.entry_id, h.occurred_at
      FROM civilization_chronicle_entries h
      WHERE h.project_id = NEW.project_id
        AND h.kind = 'mail_acknowledged'
        AND h.primary_thread_id IS NOT NULL
      ORDER BY h.occurred_at ASC, h.entry_id ASC
      LIMIT 1
      ON CONFLICT(project_id, achievement_id, subject_key) DO UPDATE SET
        subject_thread_id = excluded.subject_thread_id,
        trigger_entry_id = excluded.trigger_entry_id,
        awarded_at = excluded.awarded_at
      WHERE excluded.awarded_at < civilization_achievement_awards.awarded_at
         OR (
           excluded.awarded_at = civilization_achievement_awards.awarded_at
           AND excluded.trigger_entry_id < civilization_achievement_awards.trigger_entry_id
         );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_lineage_generation_3
    AFTER INSERT ON civilization_chronicle_entries
    WHEN NEW.kind = 'child_joined'
      AND NEW.primary_thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1
        FROM civilization_citizens
        WHERE project_id = NEW.project_id
          AND thread_id = NEW.primary_thread_id
          AND generation >= 3
      )
    BEGIN
      INSERT INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      ) VALUES (
        'award:lineage_generation_3:' || NEW.project_id || ':' || NEW.primary_thread_id,
        NEW.project_id, 'lineage_generation_3', 1, NEW.primary_thread_id,
        NEW.primary_thread_id, NEW.entry_id, NEW.occurred_at
      )
      ON CONFLICT(project_id, achievement_id, subject_key) DO UPDATE SET
        trigger_entry_id = excluded.trigger_entry_id,
        awarded_at = excluded.awarded_at
      WHERE excluded.awarded_at < civilization_achievement_awards.awarded_at
         OR (
           excluded.awarded_at = civilization_achievement_awards.awarded_at
           AND excluded.trigger_entry_id < civilization_achievement_awards.trigger_entry_id
         );
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_founder_unlock_first_descendant
    AFTER INSERT ON civilization_achievement_awards
    WHEN NEW.achievement_id = 'project_founder'
    BEGIN
      INSERT OR IGNORE INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      )
      SELECT
        'award:first_descendant:' || NEW.project_id,
        NEW.project_id, 'first_descendant', 1, h.primary_thread_id,
        '__project__', h.entry_id, h.occurred_at
      FROM civilization_chronicle_entries h
      WHERE h.project_id = NEW.project_id
        AND h.kind = 'child_joined'
        AND h.primary_thread_id IS NOT NULL
      ORDER BY h.occurred_at ASC, h.entry_id ASC
      LIMIT 1;
    END
  `;
  yield* sql`
    CREATE TRIGGER civilization_achievement_founder_unlock_first_acknowledged_correspondence
    AFTER INSERT ON civilization_achievement_awards
    WHEN NEW.achievement_id = 'project_founder'
    BEGIN
      INSERT OR IGNORE INTO civilization_achievement_awards (
        award_id, project_id, achievement_id, definition_version, subject_thread_id,
        subject_key, trigger_entry_id, awarded_at
      )
      SELECT
        'award:first_acknowledged_correspondence:' || NEW.project_id,
        NEW.project_id, 'first_acknowledged_correspondence', 1, h.primary_thread_id,
        '__project__', h.entry_id, h.occurred_at
      FROM civilization_chronicle_entries h
      WHERE h.project_id = NEW.project_id
        AND h.kind = 'mail_acknowledged'
        AND h.primary_thread_id IS NOT NULL
      ORDER BY h.occurred_at ASC, h.entry_id ASC
      LIMIT 1;
    END
  `;

  // Chronicle is durable from migration 073 onward. Replaying its already
  // recorded rows here is truthful; no pre-073 citizen/mail row is converted
  // into an achievement without Chronicle provenance.
  yield* sql`
    INSERT OR IGNORE INTO civilization_achievement_awards (
      award_id, project_id, achievement_id, definition_version, subject_thread_id,
      subject_key, trigger_entry_id, awarded_at
    )
    SELECT
      'award:project_founder:' || h.project_id,
      h.project_id, 'project_founder', 1, h.primary_thread_id,
      '__project__', h.entry_id, h.occurred_at
    FROM civilization_chronicle_entries h
    WHERE h.kind = 'citizen_joined'
      AND h.primary_thread_id IS NOT NULL
      AND h.primary_thread_id = (
        SELECT c.thread_id
        FROM civilization_citizens c
        WHERE c.project_id = h.project_id AND c.observed_only = 0
        ORDER BY c.birth_sequence ASC, c.thread_id ASC
        LIMIT 1
      )
      AND h.entry_id = (
        SELECT h2.entry_id
        FROM civilization_chronicle_entries h2
        WHERE h2.project_id = h.project_id
          AND h2.kind = 'citizen_joined'
          AND h2.primary_thread_id = h.primary_thread_id
        ORDER BY h2.occurred_at ASC, h2.entry_id ASC
        LIMIT 1
      )
  `;
  yield* sql`
    INSERT OR IGNORE INTO civilization_achievement_awards (
      award_id, project_id, achievement_id, definition_version, subject_thread_id,
      subject_key, trigger_entry_id, awarded_at
    )
    SELECT
      'award:first_descendant:' || h.project_id,
      h.project_id, 'first_descendant', 1, h.primary_thread_id,
      '__project__', h.entry_id, h.occurred_at
    FROM civilization_chronicle_entries h
    WHERE h.kind = 'child_joined'
      AND h.primary_thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM civilization_achievement_awards a
        WHERE a.project_id = h.project_id AND a.achievement_id = 'project_founder'
      )
      AND h.entry_id = (
        SELECT h2.entry_id
        FROM civilization_chronicle_entries h2
        WHERE h2.project_id = h.project_id AND h2.kind = 'child_joined'
        ORDER BY h2.occurred_at ASC, h2.entry_id ASC
        LIMIT 1
      )
  `;
  yield* sql`
    INSERT OR IGNORE INTO civilization_achievement_awards (
      award_id, project_id, achievement_id, definition_version, subject_thread_id,
      subject_key, trigger_entry_id, awarded_at
    )
    SELECT
      'award:first_acknowledged_correspondence:' || h.project_id,
      h.project_id, 'first_acknowledged_correspondence', 1, h.primary_thread_id,
      '__project__', h.entry_id, h.occurred_at
    FROM civilization_chronicle_entries h
    WHERE h.kind = 'mail_acknowledged'
      AND h.primary_thread_id IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM civilization_achievement_awards a
        WHERE a.project_id = h.project_id AND a.achievement_id = 'project_founder'
      )
      AND h.entry_id = (
        SELECT h2.entry_id
        FROM civilization_chronicle_entries h2
        WHERE h2.project_id = h.project_id AND h2.kind = 'mail_acknowledged'
        ORDER BY h2.occurred_at ASC, h2.entry_id ASC
        LIMIT 1
      )
  `;
  yield* sql`
    INSERT OR IGNORE INTO civilization_achievement_awards (
      award_id, project_id, achievement_id, definition_version, subject_thread_id,
      subject_key, trigger_entry_id, awarded_at
    )
    SELECT
      'award:lineage_generation_3:' || h.project_id || ':' || h.primary_thread_id,
      h.project_id, 'lineage_generation_3', 1, h.primary_thread_id,
      h.primary_thread_id, h.entry_id, h.occurred_at
    FROM civilization_chronicle_entries h
    JOIN civilization_citizens c
      ON c.project_id = h.project_id AND c.thread_id = h.primary_thread_id
    WHERE h.kind = 'child_joined'
      AND h.primary_thread_id IS NOT NULL
      AND c.generation >= 3
      AND h.entry_id = (
        SELECT h2.entry_id
        FROM civilization_chronicle_entries h2
        WHERE h2.project_id = h.project_id
          AND h2.kind = 'child_joined'
          AND h2.primary_thread_id = h.primary_thread_id
        ORDER BY h2.occurred_at ASC, h2.entry_id ASC
        LIMIT 1
      )
  `;
});
