#!/usr/bin/env node
/**
 * Mirrors the instruction library from one T3 server to others. Dry run by default.
 * `--apply` writes files, syncs, profiles, then materializes. A newer target
 * revision, or the same revision with different content, stops the run unless
 * `--force`. The token is read from T3_TOKEN or --token-file and never printed.
 */
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";

const args = process.argv.slice(2);

function option(name, { repeat = false } = {}) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name) {
      const value = args[index + 1];
      if (value === undefined) throw new Error(`${name} needs a value`);
      values.push(value);
      index += 1;
    }
  }
  if (values.length === 0) return repeat ? [] : undefined;
  if (!repeat && values.length > 1) throw new Error(`${name} was given more than once`);
  return repeat ? values : values[0];
}

const apply = args.includes("--apply");
const force = args.includes("--force");
const from = (option("--from") ?? "http://127.0.0.1:3773").replace(/\/$/u, "");
const targets = option("--to", { repeat: true }).map((value) => value.replace(/\/$/u, ""));
const tokenFile = option("--token-file");
const token = tokenFile ? NodeFS.readFileSync(tokenFile, "utf8").trim() : process.env.T3_TOKEN;
if (targets.length === 0) throw new Error("Pass at least one --to <baseUrl>");
if (!token) throw new Error("Set T3_TOKEN or pass --token-file");
if (!apply && force) throw new Error("--force only applies with --apply");

const headers = {
  authorization: `Bearer ${token}`,
  "x-t3-orchestration-protocol": "2",
  "content-type": "application/json",
};

async function request(base, path, init = {}) {
  const response = await fetch(`${base}${path}`, { ...init, headers });
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    body = { raw: text.slice(0, 500) };
  }
  if (!response.ok) {
    throw new Error(
      `${base}${path} failed (${response.status}): ${JSON.stringify(body).slice(0, 500)}`,
    );
  }
  return body;
}

const hash = (text) => NodeCrypto.createHash("sha256").update(text, "utf8").digest("hex");

function sameValues(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function conflictsFor(source, target) {
  const targetFiles = new Map(target.files.map((file) => [file.id, file]));
  const conflicts = [];
  for (const file of source.files) {
    const existing = targetFiles.get(file.id);
    if (existing === undefined) continue;
    if (existing.revision > file.revision) {
      conflicts.push(
        `${file.id} is newer on the target (r${existing.revision} > r${file.revision})`,
      );
    } else if (
      existing.revision === file.revision &&
      hash(existing.content) !== hash(file.content)
    ) {
      conflicts.push(`${file.id} has the same revision but different content`);
    }
  }
  return conflicts;
}

async function syncOne(base, source) {
  console.log(`\n${base}`);
  const target = await request(base, "/api/instructions", { method: "GET" });
  const conflicts = conflictsFor(source, target);
  if (conflicts.length > 0 && !force) {
    console.log("  stopped:");
    for (const conflict of conflicts) console.log(`    - ${conflict}`);
    return { base, ok: false, conflicts: conflicts.length, written: 0 };
  }
  if (conflicts.length > 0) {
    console.log(`  forcing over ${conflicts.length} conflict${conflicts.length === 1 ? "" : "s"}`);
  }

  const targetFiles = new Map(target.files.map((file) => [file.id, file]));
  const changes = source.files.filter((file) => {
    const existing = targetFiles.get(file.id);
    return (
      existing === undefined ||
      existing.revision !== file.revision ||
      hash(existing.content) !== hash(file.content)
    );
  });
  const targetSyncs = new Map(target.syncs.map((sync) => [sync.fileId, sync]));
  const syncChanges = source.syncs.filter((sync) => {
    const existing = targetSyncs.get(sync.fileId);
    return existing === undefined || !sameValues(existing.targets, sync.targets);
  });
  const profileChanges = Object.values(source.profiles ?? {}).filter((profile) => {
    const existing = (target.profiles ?? {})[profile.projectId];
    return existing === undefined || !sameValues(existing, profile);
  });

  console.log(
    `  files ${changes.length}, syncs ${syncChanges.length}, profiles ${profileChanges.length}`,
  );
  if (!apply) return { base, ok: true, conflicts: conflicts.length, written: 0 };

  for (const file of changes) {
    await request(base, "/api/instructions/files", {
      method: "POST",
      body: JSON.stringify({
        id: file.id,
        kind: file.kind,
        scope: file.scope,
        ...(file.projectId === undefined ? {} : { projectId: file.projectId }),
        title: file.title,
        ...(file.filename === undefined ? {} : { filename: file.filename }),
        content: file.content,
        ...(force || targetFiles.get(file.id) === undefined
          ? {}
          : { expectedRevision: targetFiles.get(file.id).revision }),
      }),
    });
  }
  for (const sync of syncChanges) {
    const existing = targetSyncs.get(sync.fileId);
    await request(base, "/api/instructions/syncs", {
      method: "POST",
      body: JSON.stringify({
        ...(existing === undefined ? {} : { id: existing.id }),
        fileId: sync.fileId,
        targets: sync.targets,
      }),
    });
  }
  for (const profile of profileChanges) {
    await request(base, "/api/instructions/profile", {
      method: "POST",
      body: JSON.stringify({
        projectId: profile.projectId,
        mode: profile.mode,
        shared: profile.shared,
        environments: profile.environments,
      }),
    });
  }
  const materialized = await request(base, "/api/instructions/materialize", {
    method: "POST",
    body: JSON.stringify({ force }),
  });
  if (materialized.conflicts.length > 0) {
    console.log(`  materialize stopped on ${materialized.conflicts.length} drifted target(s)`);
    for (const conflict of materialized.conflicts) console.log(`    - ${conflict.path}`);
    return {
      base,
      ok: false,
      conflicts: materialized.conflicts.length,
      written: materialized.written.length,
    };
  }
  console.log(`  wrote ${materialized.written.length} target(s)`);
  return { base, ok: true, conflicts: 0, written: materialized.written.length };
}

const source = await request(from, "/api/instructions", { method: "GET" });
console.log(
  `${apply ? "Applying" : "Dry run"} ${source.files.length} file(s) from ${from} to ${targets.length} target(s)`,
);

const results = [];
for (const base of targets) {
  try {
    results.push(await syncOne(base, source));
  } catch (error) {
    console.log(
      `\n${base}\n  unreachable: ${error instanceof Error ? error.message : String(error)}`,
    );
    results.push({ base, ok: false, conflicts: 0, written: 0, unreachable: true });
  }
}

const failed = results.filter((result) => !result.ok);
console.log(
  `\n${results.length - failed.length}/${results.length} target(s) ${apply ? "updated" : "ready"}`,
);
process.exitCode = failed.length === 0 ? 0 : 1;
