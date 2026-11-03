#!/usr/bin/env node
// Read-only projection check for the v1.2.0 thread-visibility work.
// Prints ids (first 8 characters), counts, and flags only. It never selects or
// prints titles, prompts, messages, payloads, tool bodies, or configuration.

import * as NodeSqlite from "node:sqlite";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const valueOf = (name, fallback) => {
  const index = args.indexOf(name);
  return index >= 0 && args[index + 1] !== undefined ? args[index + 1] : fallback;
};

const dbPath = valueOf(
  "--db",
  NodePath.join(NodeOS.homedir(), ".t3", "userdata", "statev2.sqlite"),
);
const repair = flag("--repair");
const db = new NodeSqlite.DatabaseSync(dbPath, { readOnly: !repair });
const all = (sql, ...params) => db.prepare(sql).all(...params);
const has = (table) =>
  all("SELECT 1 AS ok FROM sqlite_master WHERE type='table' AND name=?", table).length > 0;
const short = (id) => String(id).slice(0, 8);

const out = {
  db: dbPath,
  mode: repair ? "repair" : "check",
  counts: {},
  missingProjection: [],
  missingProject: [],
  deletedWithoutEvent: [],
  repair: null,
};

if (!has("orchestration_v2_projection_threads")) {
  console.log(JSON.stringify({ ...out, error: "not_a_v2_database" }, null, 2));
  process.exit(2);
}

out.counts.v2Threads = all("SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads")[0].n;
out.counts.v2Events = has("orchestration_v2_events")
  ? all("SELECT COUNT(*) AS n FROM orchestration_v2_events")[0].n
  : 0;
out.counts.legacyThreads = has("projection_threads")
  ? all("SELECT COUNT(*) AS n FROM projection_threads")[0].n
  : 0;
out.counts.legacyEvents = has("orchestration_events")
  ? all("SELECT COUNT(*) AS n FROM orchestration_events")[0].n
  : 0;

if (has("orchestration_events")) {
  out.missingProjection = all(
    `SELECT DISTINCT stream_id AS threadId
     FROM orchestration_events
     WHERE event_type = 'thread.created'
       AND stream_id NOT IN (SELECT thread_id FROM orchestration_v2_projection_threads)
     ORDER BY stream_id LIMIT 100`,
  ).map((row) => short(row.threadId));
}

if (has("projection_projects")) {
  out.missingProject = all(
    `SELECT t.thread_id AS threadId
     FROM orchestration_v2_projection_threads AS t
     LEFT JOIN projection_projects AS p ON p.project_id = t.project_id
     WHERE t.deleted_at IS NULL AND (p.project_id IS NULL OR p.deleted_at IS NOT NULL)
     ORDER BY t.thread_id LIMIT 100`,
  ).map((row) => short(row.threadId));
}

if (has("orchestration_events")) {
  out.deletedWithoutEvent = all(
    `SELECT t.thread_id AS threadId
     FROM orchestration_v2_projection_threads AS t
     WHERE t.deleted_at IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM orchestration_events AS e
         WHERE e.stream_id = t.thread_id
           AND e.event_type IN ('thread.deleted', 'thread.metadata-updated')
       )
     ORDER BY t.thread_id LIMIT 100`,
  ).map((row) => short(row.threadId));
}

if (repair) {
  // No safe automatic repair exists for legacy event streams: the importer
  // reads legacy projection tables, not orchestration_events. Refuse rather
  // than inventing rows or deleting history.
  out.repair = {
    status: "blocked",
    reason: "legacy_event_replay_unavailable",
    message:
      "No safe automatic replay from orchestration_events to the v2 projection exists in this build. Use the read-only report and a reviewed migration; do not insert rows by hand.",
  };
}

console.log(JSON.stringify(out, null, 2));
process.exit(0);
