// @effect-diagnostics nodeBuiltinImport:off -- the fixture makes a temporary git repository and inspects process ids.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expect, it } from "@effect/vitest";
import { ProjectId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ProjectService from "../project/ProjectService.ts";
import * as SwarmVerifier from "./SwarmVerifier.ts";

// The real verify runner (SW-A6) on a temporary git repository, through the bounded spawn core.

const node = process.execPath;

const withRepo = <A, E, R>(use: (repo: string) => Effect.Effect<A, E, R>) =>
  Effect.acquireUseRelease(
    Effect.promise(async () => {
      const directory = await NodeFSP.realpath(
        await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-swarm-verify-")),
      );
      NodeChildProcess.execFileSync("git", ["init", "--quiet"], { cwd: directory });
      return directory;
    }),
    use,
    (directory) =>
      Effect.promise(() => NodeFSP.rm(directory, { recursive: true, force: true })).pipe(
        Effect.ignore,
      ),
  );

const layerFor = (workspaceRoot: string) =>
  SwarmVerifier.layer.pipe(
    Layer.provide(
      Layer.mock(ProjectService.ProjectService)({
        getById: (projectId) =>
          Effect.succeed(
            projectId === "project:known" ? Option.some({ workspaceRoot } as never) : Option.none(),
          ),
      }),
    ),
  );

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/** A parent that starts a long-lived grandchild, records its pid, and never exits. */
const spawnsGrandchild = (pidFile: string) => [
  node,
  "-e",
  `const { spawn } = require('node:child_process'); const fs = require('node:fs');
   const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
   fs.writeFileSync(process.argv[1], String(child.pid));
   setInterval(() => {}, 1000);`,
  pidFile,
];

it.live("runs argv in the checkout and reports a pass, a failure, and the output tail", () =>
  withRepo((repo) =>
    Effect.gen(function* () {
      const verifier = yield* SwarmVerifier.SwarmVerifier;
      const cwd = yield* verifier.checkoutOf({
        worktreePath: null,
        projectId: ProjectId.make("project:known"),
      });
      expect(cwd).toBe(repo);
      expect(
        yield* verifier.checkoutOf({ worktreePath: "/w", projectId: ProjectId.make("p:x") }),
      ).toBe("/w");
      const status = yield* verifier.run({
        argv: ["git", "status", "--porcelain"],
        cwd,
        timeoutMs: 30_000,
      });
      expect(status.passed).toBe(true);
      const failed = yield* verifier.run({
        argv: [node, "-e", "console.log('out'); console.error('x'.repeat(9000)); process.exit(2)"],
        cwd,
        timeoutMs: 30_000,
      });
      expect(failed.passed).toBe(false);
      expect(failed.exitCode).toBe(2);
      expect(failed.outputTail.length).toBe(SwarmVerifier.VERIFY_OUTPUT_TAIL_CHARACTERS);
      const missing = yield* verifier.run({
        argv: ["t3-no-such-program"],
        cwd,
        timeoutMs: 30_000,
      });
      expect(missing.passed).toBe(false);
      expect(missing.notStarted).toBe(true);
      expect(failed.notStarted).toBe(false);
      const unknownProject = yield* verifier
        .checkoutOf({ worktreePath: null, projectId: ProjectId.make("project:gone") })
        .pipe(Effect.flip);
      expect(unknownProject._tag).toBe("SwarmVerifyCheckoutError");
    }).pipe(Effect.provide(layerFor(repo))),
  ),
);

it.live.skipIf(HostProcess.Platform.defaultValue() !== "win32")(
  "kills the whole tree on timeout and on interruption (Windows taskkill /T)",
  () =>
    withRepo((repo) =>
      Effect.gen(function* () {
        const verifier = yield* SwarmVerifier.SwarmVerifier;
        const timedPid = NodePath.join(repo, "timed.pid");
        const timed = yield* verifier.run({
          argv: spawnsGrandchild(timedPid),
          cwd: repo,
          timeoutMs: 1_000,
        });
        expect(timed.timedOut).toBe(true);
        expect(timed.passed).toBe(false);
        expect(alive(Number(yield* Effect.promise(() => NodeFSP.readFile(timedPid, "utf8"))))).toBe(
          false,
        );

        // A verify race aborts the check: interrupting the run kills the tree.
        const abortedPid = NodePath.join(repo, "aborted.pid");
        const written = yield* Deferred.make<void>();
        const watcher = NodeFS.watch(repo, (_event, filename) => {
          if (filename === "aborted.pid") Deferred.doneUnsafe(written, Effect.void);
        });
        const fiber = yield* verifier
          .run({ argv: spawnsGrandchild(abortedPid), cwd: repo, timeoutMs: 60_000 })
          .pipe(Effect.forkChild);
        yield* Deferred.await(written);
        watcher.close();
        const grandchild = Number(
          yield* Effect.promise(() => NodeFSP.readFile(abortedPid, "utf8")),
        );
        expect(grandchild).toBeGreaterThan(0);
        yield* Fiber.interrupt(fiber);
        expect(alive(grandchild)).toBe(false);
      }).pipe(Effect.provide(layerFor(repo))),
    ),
);
