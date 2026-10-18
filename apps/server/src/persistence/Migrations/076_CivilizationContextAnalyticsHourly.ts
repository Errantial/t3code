import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  // Measured 100k-row on-demand aggregation is well above the v1.1 read gate.
  // Keep the persisted acceleration deliberately narrow: one derived row per
  // project/hour/provider/outcome/suppression tuple. Thread remains a request-
  // time selector over the source table so this does not become a second
  // inspection/event authority or a high-cardinality analytics warehouse.
  yield* sql`
    CREATE TABLE civilization_context_analytics_hourly (
      project_id TEXT NOT NULL,
      bucket_start TEXT NOT NULL,
      provider_instance_id TEXT NOT NULL,
      outcome TEXT NOT NULL,
      suppression_reason TEXT NOT NULL,
      inspection_count INTEGER NOT NULL CHECK (inspection_count >= 0),
      packet_zero INTEGER NOT NULL CHECK (packet_zero >= 0),
      packet_low INTEGER NOT NULL CHECK (packet_low >= 0),
      packet_medium INTEGER NOT NULL CHECK (packet_medium >= 0),
      packet_high INTEGER NOT NULL CHECK (packet_high >= 0),
      packet_over INTEGER NOT NULL CHECK (packet_over >= 0),
      utilization_zero INTEGER NOT NULL CHECK (utilization_zero >= 0),
      utilization_low INTEGER NOT NULL CHECK (utilization_low >= 0),
      utilization_medium INTEGER NOT NULL CHECK (utilization_medium >= 0),
      utilization_high INTEGER NOT NULL CHECK (utilization_high >= 0),
      utilization_over INTEGER NOT NULL CHECK (utilization_over >= 0),
      roster_candidates INTEGER NOT NULL CHECK (roster_candidates >= 0),
      roster_included INTEGER NOT NULL CHECK (roster_included >= 0),
      note_candidates INTEGER NOT NULL CHECK (note_candidates >= 0),
      note_included INTEGER NOT NULL CHECK (note_included >= 0),
      inbox_candidates INTEGER NOT NULL CHECK (inbox_candidates >= 0),
      inbox_included INTEGER NOT NULL CHECK (inbox_included >= 0),
      PRIMARY KEY (
        project_id, bucket_start, provider_instance_id, outcome, suppression_reason
      )
    ) WITHOUT ROWID
  `;
  yield* sql`
    INSERT INTO civilization_context_analytics_hourly (
      project_id, bucket_start, provider_instance_id, outcome, suppression_reason,
      inspection_count,
      packet_zero, packet_low, packet_medium, packet_high, packet_over,
      utilization_zero, utilization_low, utilization_medium, utilization_high, utilization_over,
      roster_candidates, roster_included, note_candidates, note_included,
      inbox_candidates, inbox_included
    )
    SELECT
      project_id,
      substr(created_at, 1, 13) || ':00:00.000Z',
      provider_instance_id,
      outcome,
      COALESCE(suppression_reason, ''),
      COUNT(*),
      SUM(CASE WHEN packet_bytes = 0 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes > 0 AND packet_bytes <= 1024 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes > 1024 AND packet_bytes <= 4096 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes > 4096 AND packet_bytes <= 8192 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes > 8192 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes = 0 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes > 0 AND packet_budget_bytes > 0 AND packet_bytes * 100 <= packet_budget_bytes * 50 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_budget_bytes > 0 AND packet_bytes * 100 > packet_budget_bytes * 50 AND packet_bytes * 100 <= packet_budget_bytes * 80 THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_budget_bytes > 0 AND packet_bytes * 100 > packet_budget_bytes * 80 AND packet_bytes <= packet_budget_bytes THEN 1 ELSE 0 END),
      SUM(CASE WHEN packet_bytes > 0 AND (packet_budget_bytes = 0 OR packet_bytes > packet_budget_bytes) THEN 1 ELSE 0 END),
      SUM(roster_candidates), SUM(roster_included),
      SUM(note_candidates), SUM(note_included),
      SUM(inbox_candidates), SUM(inbox_included)
    FROM civilization_context_inspections
    GROUP BY
      project_id,
      substr(created_at, 1, 13) || ':00:00.000Z',
      provider_instance_id,
      outcome,
      COALESCE(suppression_reason, '')
  `;

  yield* sql`
    CREATE TRIGGER civilization_context_analytics_hourly_insert
    AFTER INSERT ON civilization_context_inspections
    BEGIN
      INSERT INTO civilization_context_analytics_hourly (
        project_id, bucket_start, provider_instance_id, outcome, suppression_reason,
        inspection_count,
        packet_zero, packet_low, packet_medium, packet_high, packet_over,
        utilization_zero, utilization_low, utilization_medium, utilization_high, utilization_over,
        roster_candidates, roster_included, note_candidates, note_included,
        inbox_candidates, inbox_included
      ) VALUES (
        NEW.project_id,
        substr(NEW.created_at, 1, 13) || ':00:00.000Z',
        NEW.provider_instance_id,
        NEW.outcome,
        COALESCE(NEW.suppression_reason, ''),
        1,
        CASE WHEN NEW.packet_bytes = 0 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 0 AND NEW.packet_bytes <= 1024 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 1024 AND NEW.packet_bytes <= 4096 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 4096 AND NEW.packet_bytes <= 8192 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 8192 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes = 0 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 0 AND NEW.packet_budget_bytes > 0 AND NEW.packet_bytes * 100 <= NEW.packet_budget_bytes * 50 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_budget_bytes > 0 AND NEW.packet_bytes * 100 > NEW.packet_budget_bytes * 50 AND NEW.packet_bytes * 100 <= NEW.packet_budget_bytes * 80 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_budget_bytes > 0 AND NEW.packet_bytes * 100 > NEW.packet_budget_bytes * 80 AND NEW.packet_bytes <= NEW.packet_budget_bytes THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 0 AND (NEW.packet_budget_bytes = 0 OR NEW.packet_bytes > NEW.packet_budget_bytes) THEN 1 ELSE 0 END,
        NEW.roster_candidates, NEW.roster_included,
        NEW.note_candidates, NEW.note_included,
        NEW.inbox_candidates, NEW.inbox_included
      )
      ON CONFLICT(project_id, bucket_start, provider_instance_id, outcome, suppression_reason)
      DO UPDATE SET
        inspection_count = inspection_count + excluded.inspection_count,
        packet_zero = packet_zero + excluded.packet_zero,
        packet_low = packet_low + excluded.packet_low,
        packet_medium = packet_medium + excluded.packet_medium,
        packet_high = packet_high + excluded.packet_high,
        packet_over = packet_over + excluded.packet_over,
        utilization_zero = utilization_zero + excluded.utilization_zero,
        utilization_low = utilization_low + excluded.utilization_low,
        utilization_medium = utilization_medium + excluded.utilization_medium,
        utilization_high = utilization_high + excluded.utilization_high,
        utilization_over = utilization_over + excluded.utilization_over,
        roster_candidates = roster_candidates + excluded.roster_candidates,
        roster_included = roster_included + excluded.roster_included,
        note_candidates = note_candidates + excluded.note_candidates,
        note_included = note_included + excluded.note_included,
        inbox_candidates = inbox_candidates + excluded.inbox_candidates,
        inbox_included = inbox_included + excluded.inbox_included;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_context_analytics_hourly_delete
    AFTER DELETE ON civilization_context_inspections
    BEGIN
      UPDATE civilization_context_analytics_hourly SET
        inspection_count = inspection_count - 1,
        packet_zero = packet_zero - CASE WHEN OLD.packet_bytes = 0 THEN 1 ELSE 0 END,
        packet_low = packet_low - CASE WHEN OLD.packet_bytes > 0 AND OLD.packet_bytes <= 1024 THEN 1 ELSE 0 END,
        packet_medium = packet_medium - CASE WHEN OLD.packet_bytes > 1024 AND OLD.packet_bytes <= 4096 THEN 1 ELSE 0 END,
        packet_high = packet_high - CASE WHEN OLD.packet_bytes > 4096 AND OLD.packet_bytes <= 8192 THEN 1 ELSE 0 END,
        packet_over = packet_over - CASE WHEN OLD.packet_bytes > 8192 THEN 1 ELSE 0 END,
        utilization_zero = utilization_zero - CASE WHEN OLD.packet_bytes = 0 THEN 1 ELSE 0 END,
        utilization_low = utilization_low - CASE WHEN OLD.packet_bytes > 0 AND OLD.packet_budget_bytes > 0 AND OLD.packet_bytes * 100 <= OLD.packet_budget_bytes * 50 THEN 1 ELSE 0 END,
        utilization_medium = utilization_medium - CASE WHEN OLD.packet_budget_bytes > 0 AND OLD.packet_bytes * 100 > OLD.packet_budget_bytes * 50 AND OLD.packet_bytes * 100 <= OLD.packet_budget_bytes * 80 THEN 1 ELSE 0 END,
        utilization_high = utilization_high - CASE WHEN OLD.packet_budget_bytes > 0 AND OLD.packet_bytes * 100 > OLD.packet_budget_bytes * 80 AND OLD.packet_bytes <= OLD.packet_budget_bytes THEN 1 ELSE 0 END,
        utilization_over = utilization_over - CASE WHEN OLD.packet_bytes > 0 AND (OLD.packet_budget_bytes = 0 OR OLD.packet_bytes > OLD.packet_budget_bytes) THEN 1 ELSE 0 END,
        roster_candidates = roster_candidates - OLD.roster_candidates,
        roster_included = roster_included - OLD.roster_included,
        note_candidates = note_candidates - OLD.note_candidates,
        note_included = note_included - OLD.note_included,
        inbox_candidates = inbox_candidates - OLD.inbox_candidates,
        inbox_included = inbox_included - OLD.inbox_included
      WHERE project_id = OLD.project_id
        AND bucket_start = substr(OLD.created_at, 1, 13) || ':00:00.000Z'
        AND provider_instance_id = OLD.provider_instance_id
        AND outcome = OLD.outcome
        AND suppression_reason = COALESCE(OLD.suppression_reason, '');
      DELETE FROM civilization_context_analytics_hourly
      WHERE project_id = OLD.project_id
        AND bucket_start = substr(OLD.created_at, 1, 13) || ':00:00.000Z'
        AND provider_instance_id = OLD.provider_instance_id
        AND outcome = OLD.outcome
        AND suppression_reason = COALESCE(OLD.suppression_reason, '')
        AND inspection_count = 0;
    END
  `;

  yield* sql`
    CREATE TRIGGER civilization_context_analytics_hourly_update
    AFTER UPDATE OF
      project_id, provider_instance_id, outcome, suppression_reason,
      packet_bytes, packet_budget_bytes,
      roster_candidates, roster_included,
      note_candidates, note_included,
      inbox_candidates, inbox_included,
      created_at
    ON civilization_context_inspections
    BEGIN
      UPDATE civilization_context_analytics_hourly SET
        inspection_count = inspection_count - 1,
        packet_zero = packet_zero - CASE WHEN OLD.packet_bytes = 0 THEN 1 ELSE 0 END,
        packet_low = packet_low - CASE WHEN OLD.packet_bytes > 0 AND OLD.packet_bytes <= 1024 THEN 1 ELSE 0 END,
        packet_medium = packet_medium - CASE WHEN OLD.packet_bytes > 1024 AND OLD.packet_bytes <= 4096 THEN 1 ELSE 0 END,
        packet_high = packet_high - CASE WHEN OLD.packet_bytes > 4096 AND OLD.packet_bytes <= 8192 THEN 1 ELSE 0 END,
        packet_over = packet_over - CASE WHEN OLD.packet_bytes > 8192 THEN 1 ELSE 0 END,
        utilization_zero = utilization_zero - CASE WHEN OLD.packet_bytes = 0 THEN 1 ELSE 0 END,
        utilization_low = utilization_low - CASE WHEN OLD.packet_bytes > 0 AND OLD.packet_budget_bytes > 0 AND OLD.packet_bytes * 100 <= OLD.packet_budget_bytes * 50 THEN 1 ELSE 0 END,
        utilization_medium = utilization_medium - CASE WHEN OLD.packet_budget_bytes > 0 AND OLD.packet_bytes * 100 > OLD.packet_budget_bytes * 50 AND OLD.packet_bytes * 100 <= OLD.packet_budget_bytes * 80 THEN 1 ELSE 0 END,
        utilization_high = utilization_high - CASE WHEN OLD.packet_budget_bytes > 0 AND OLD.packet_bytes * 100 > OLD.packet_budget_bytes * 80 AND OLD.packet_bytes <= OLD.packet_budget_bytes THEN 1 ELSE 0 END,
        utilization_over = utilization_over - CASE WHEN OLD.packet_bytes > 0 AND (OLD.packet_budget_bytes = 0 OR OLD.packet_bytes > OLD.packet_budget_bytes) THEN 1 ELSE 0 END,
        roster_candidates = roster_candidates - OLD.roster_candidates,
        roster_included = roster_included - OLD.roster_included,
        note_candidates = note_candidates - OLD.note_candidates,
        note_included = note_included - OLD.note_included,
        inbox_candidates = inbox_candidates - OLD.inbox_candidates,
        inbox_included = inbox_included - OLD.inbox_included
      WHERE project_id = OLD.project_id
        AND bucket_start = substr(OLD.created_at, 1, 13) || ':00:00.000Z'
        AND provider_instance_id = OLD.provider_instance_id
        AND outcome = OLD.outcome
        AND suppression_reason = COALESCE(OLD.suppression_reason, '');
      DELETE FROM civilization_context_analytics_hourly
      WHERE project_id = OLD.project_id
        AND bucket_start = substr(OLD.created_at, 1, 13) || ':00:00.000Z'
        AND provider_instance_id = OLD.provider_instance_id
        AND outcome = OLD.outcome
        AND suppression_reason = COALESCE(OLD.suppression_reason, '')
        AND inspection_count = 0;

      INSERT INTO civilization_context_analytics_hourly (
        project_id, bucket_start, provider_instance_id, outcome, suppression_reason,
        inspection_count,
        packet_zero, packet_low, packet_medium, packet_high, packet_over,
        utilization_zero, utilization_low, utilization_medium, utilization_high, utilization_over,
        roster_candidates, roster_included, note_candidates, note_included,
        inbox_candidates, inbox_included
      ) VALUES (
        NEW.project_id,
        substr(NEW.created_at, 1, 13) || ':00:00.000Z',
        NEW.provider_instance_id,
        NEW.outcome,
        COALESCE(NEW.suppression_reason, ''),
        1,
        CASE WHEN NEW.packet_bytes = 0 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 0 AND NEW.packet_bytes <= 1024 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 1024 AND NEW.packet_bytes <= 4096 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 4096 AND NEW.packet_bytes <= 8192 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 8192 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes = 0 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 0 AND NEW.packet_budget_bytes > 0 AND NEW.packet_bytes * 100 <= NEW.packet_budget_bytes * 50 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_budget_bytes > 0 AND NEW.packet_bytes * 100 > NEW.packet_budget_bytes * 50 AND NEW.packet_bytes * 100 <= NEW.packet_budget_bytes * 80 THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_budget_bytes > 0 AND NEW.packet_bytes * 100 > NEW.packet_budget_bytes * 80 AND NEW.packet_bytes <= NEW.packet_budget_bytes THEN 1 ELSE 0 END,
        CASE WHEN NEW.packet_bytes > 0 AND (NEW.packet_budget_bytes = 0 OR NEW.packet_bytes > NEW.packet_budget_bytes) THEN 1 ELSE 0 END,
        NEW.roster_candidates, NEW.roster_included,
        NEW.note_candidates, NEW.note_included,
        NEW.inbox_candidates, NEW.inbox_included
      )
      ON CONFLICT(project_id, bucket_start, provider_instance_id, outcome, suppression_reason)
      DO UPDATE SET
        inspection_count = inspection_count + excluded.inspection_count,
        packet_zero = packet_zero + excluded.packet_zero,
        packet_low = packet_low + excluded.packet_low,
        packet_medium = packet_medium + excluded.packet_medium,
        packet_high = packet_high + excluded.packet_high,
        packet_over = packet_over + excluded.packet_over,
        utilization_zero = utilization_zero + excluded.utilization_zero,
        utilization_low = utilization_low + excluded.utilization_low,
        utilization_medium = utilization_medium + excluded.utilization_medium,
        utilization_high = utilization_high + excluded.utilization_high,
        utilization_over = utilization_over + excluded.utilization_over,
        roster_candidates = roster_candidates + excluded.roster_candidates,
        roster_included = roster_included + excluded.roster_included,
        note_candidates = note_candidates + excluded.note_candidates,
        note_included = note_included + excluded.note_included,
        inbox_candidates = inbox_candidates + excluded.inbox_candidates,
        inbox_included = inbox_included + excluded.inbox_included;
    END
  `;
});
