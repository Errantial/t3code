// @effect-diagnostics nodeBuiltinImport:off globalDateInEffect:off cryptoRandomUUIDInEffect:off -- the fixture writes files it then asks the executor to read and names its own exec ids.
import * as NodeFSP from "node:fs/promises";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerExec from "./PeerExec.ts";
import * as PeerExecReceipts from "./PeerExecReceipts.ts";

const node = process.execPath;

const root = async () => {
  const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-peer-exec-"));
  return NodeFSP.realpath(directory);
};

const layerTest = (
  executionRoot: string,
  grant: "off" | "read-only" | "auto" | "full-access" = "full-access",
) => {
  const database = NodeSqliteClient.layer({ filename: ":memory:" });
  const settings = ServerSettings.ServerSettingsService.layerTest({
    executionTargetsEnabled: true,
    peerExecGrant: grant,
    peerExecRoots: [executionRoot],
  } as never);
  return Layer.mergeAll(
    PeerExec.layer.pipe(
      Layer.provide(PeerExecReceipts.layer),
      Layer.provide(settings),
      Layer.provide(
        Layer.mock(ProjectService.ProjectService)({
          listShells: () => Effect.succeed([]),
        }),
      ),
      Layer.provide(database),
    ),
    PeerExecReceipts.layer.pipe(Layer.provide(database)),
    database,
  );
};

const withRoot = <A, E, R>(use: (root: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(Effect.promise(root), use, (directory) =>
    Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
      Effect.ignore,
    ),
  );

const runFails = <A>(
  effect: Effect.Effect<A, OrchestratorMcpFailure>,
): Effect.Effect<OrchestratorMcpFailure> =>
  Effect.gen(function* () {
    const settled = yield* Effect.result(effect);
    if (settled._tag === "Success") {
      return yield* Effect.die("Expected the execution to fail.");
    }
    return settled.failure;
  });

it.live("runs argv directly and reports the exit code and output tail", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const result = yield* exec.run({
        execId: globalThis.crypto.randomUUID(),
        argv: [node, "-e", "process.stdout.write('hello'); process.exit(3)"],
        cwd: directory,
      });
      expect(result.exitCode).toBe(3);
      expect(result.stdoutTail).toBe("hello");
      expect(result.outputRetained).toBe(true);
      expect(result.cwd.endsWith(NodePath.basename(directory))).toBe(true);
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("times out and kills the process", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const result = yield* exec.run({
        execId: globalThis.crypto.randomUUID(),
        argv: [node, "-e", "setInterval(() => {}, 1000)"],
        cwd: directory,
        timeoutMs: 200,
      });
      expect(result.timedOut).toBe(true);
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("cancels a running exec by its id", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const execId = globalThis.crypto.randomUUID();
      const marker = NodePath.join(directory, "started");
      const fiber = yield* exec
        .run({
          execId,
          argv: [
            node,
            "-e",
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'x'); setInterval(() => {}, 1000)`,
          ],
          cwd: directory,
          timeoutMs: 30_000,
        })
        .pipe(Effect.forkChild);
      const started = yield* Deferred.make<void>();
      const watcher = NodeFS.watch(directory, (_event, filename) => {
        if (filename === "started") Deferred.doneUnsafe(started, Effect.void);
      });
      yield* Deferred.await(started);
      watcher.close();
      const cancelled = yield* exec.cancel(execId);
      const result = yield* Fiber.join(fiber);
      expect(cancelled.cancelled).toBe(true);
      expect(result.cancelled).toBe(true);
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("replays an execId without spawning twice", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const output = NodePath.join(directory, "side-effect.txt");
      const execId = globalThis.crypto.randomUUID();
      const argv = [
        node,
        "-e",
        "require('node:fs').appendFileSync(process.argv[1], 'x')",
        output,
      ] as const;
      const first = yield* exec.run({ execId, argv, cwd: directory });
      const second = yield* exec.run({ execId, argv, cwd: directory });
      expect(first.outputRetained).toBe(true);
      expect(second.outputRetained).toBe(false);
      expect(second.exitCode).toBe(first.exitCode);
      expect(yield* Effect.promise(() => NodeFSP.readFile(output, "utf8"))).toBe("x");
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly request_hash: string; readonly result_json: string }>`
        SELECT request_hash, result_json FROM peer_exec_receipts WHERE exec_id = ${execId}
      `;
      expect(rows).toHaveLength(1);
      expect(JSON.stringify(rows)).not.toContain("appendFileSync");
      expect(JSON.stringify(rows)).not.toContain("env");
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("refuses a different request on the same execId", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const execId = globalThis.crypto.randomUUID();
      yield* exec.run({ execId, argv: [node, "-e", "process.exit(0)"], cwd: directory });
      const failure = yield* runFails(
        exec.run({ execId, argv: [node, "-e", "process.exit(1)"], cwd: directory }),
      );
      expect(failure.code).toBe("exec_id_conflict");
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("refuses paths outside the allowed roots", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const failure = yield* runFails(
        exec.run({
          execId: globalThis.crypto.randomUUID(),
          argv: [node, "-e", "process.exit(0)"],
          cwd: NodeOS.tmpdir(),
        }),
      );
      expect(failure.code).toBe("target_path_outside_roots");
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("reads text and base64 files, and lists with a cursor", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      const text = NodePath.join(directory, "text.txt");
      const binary = NodePath.join(directory, "binary.bin");
      yield* Effect.promise(() => NodeFSP.writeFile(text, "hello"));
      yield* Effect.promise(() => NodeFSP.writeFile(binary, Buffer.from([0xff, 0xfe, 0x00])));
      const readText = yield* exec.readFile({ path: text });
      expect(readText.encoding).toBe("utf8");
      expect(readText.content).toBe("hello");
      expect(readText.eof).toBe(true);
      const readBinary = yield* exec.readFile({ path: binary });
      expect(readBinary.encoding).toBe("base64");
      const page = yield* exec.list({ path: directory, limit: 1 });
      expect(page.entries).toHaveLength(1);
      expect(page.nextCursor).not.toBeNull();
      const rest = yield* exec.list({
        path: directory,
        limit: 10,
        ...(page.nextCursor === null ? {} : { cursor: page.nextCursor }),
      });
      expect(rest.entries.length).toBeGreaterThanOrEqual(1);
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("a running receipt left by a restart becomes unknown and is never rerun", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const execId = globalThis.crypto.randomUUID();
      const receipts = yield* PeerExecReceipts.PeerExecReceipts;
      yield* receipts.begin({
        execId,
        requestHash: "hash",
        now: yield* DateTime.now,
      });
      const marked = yield* receipts.markAllRunningUnknown({ now: yield* DateTime.now });
      expect(marked).toBe(1);
      expect(yield* receipts.stateOf(execId)).toBe("unknown");
      const retried = yield* receipts.begin({
        execId,
        requestHash: "hash",
        now: yield* DateTime.now,
      });
      expect(retried.kind).toBe("unknown");
    }).pipe(Effect.provide(layerTest(directory))),
  ),
);

it.live("the target grant off refuses execution before spawning", () =>
  withRoot((directory) =>
    Effect.gen(function* () {
      yield* runMigrations();
      const exec = yield* PeerExec.PeerExec;
      expect(yield* exec.grant).toBe("off");
    }).pipe(Effect.provide(layerTest(directory, "off"))),
  ),
);
