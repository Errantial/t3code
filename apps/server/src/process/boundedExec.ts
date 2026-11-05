// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off globalDate:off globalDateInEffect:off tryCatchInEffectGen:off -- Bounded execution owns process-tree control and real wall-clock timeouts, which the platform APIs do not expose.
import * as NodeChildProcess from "node:child_process";

import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

/**
 * The spawn core shared by the peer executor and the swarm verifier: argv with no shell, tail
 * buffers for stdout and stderr, a wall-clock timeout, and a process-tree kill (`taskkill /T /F`
 * on Windows, the process group elsewhere). Callers own their own policy (roots, receipts,
 * flags); this module never logs, and never sees what the output means.
 */

/** How long a timed-out process may keep its pipes open after the tree kill. */
const SETTLE_AFTER_KILL_MS = 5_000;

interface TailBuffer {
  readonly push: (chunk: Buffer) => void;
  readonly text: string;
}

/** Keeps the last `cap` bytes pushed. */
const makeTail = (cap: number): TailBuffer => {
  const chunks: Array<Buffer> = [];
  let length = 0;
  return {
    push: (chunk) => {
      chunks.push(chunk);
      length += chunk.length;
      while (length > cap && chunks.length > 1) {
        const first = chunks.shift();
        if (first === undefined) break;
        length -= first.length;
      }
      const head = chunks[0];
      if (head !== undefined && length > cap) {
        const keep = head.subarray(length - cap);
        chunks[0] = keep;
        length = cap;
      }
    },
    get text() {
      return Buffer.concat(chunks).toString("utf8");
    },
  };
};

interface ExecState {
  child: NodeChildProcess.ChildProcess | undefined;
  readonly stdout: TailBuffer;
  readonly stderr: TailBuffer;
  stdoutBytes: number;
  stderrBytes: number;
  truncated: boolean;
  cancelled: boolean;
  timedOut: boolean;
  spawned: boolean;
  spawnFailed: boolean;
  readonly startedAt: number;
  readonly maxOutputBytes: number;
  readonly platform: NodeJS.Platform;
  settled: boolean;
  settle: ((exitCode: number | null, signal: NodeJS.Signals | null) => void) | undefined;
  timer: NodeJS.Timeout | undefined;
}

const killTree = (state: ExecState) => {
  if (state.settled) return;
  const child = state.child;
  if (child === undefined) return;
  const pid = child.pid;
  if (pid === undefined) return;
  if (state.platform === "win32") {
    NodeChildProcess.spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // Already gone.
    }
  }
  const timer = setTimeout(() => {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // Already gone.
      }
    }
  }, 2_000);
  timer.unref();
};

const append = (state: ExecState, stream: "stdout" | "stderr", chunk: Buffer) => {
  const target = stream === "stdout" ? state.stdout : state.stderr;
  target.push(chunk);
  if (stream === "stdout") state.stdoutBytes += chunk.length;
  else state.stderrBytes += chunk.length;
  if (state.stdoutBytes > state.maxOutputBytes || state.stderrBytes > state.maxOutputBytes) {
    state.truncated = true;
  }
};

/** How a bounded process ended. Output tails are the caller's to store; never log them. */
export interface BoundedExecOutcome {
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  /** The program never started (not found, not executable): no exit code to report. */
  readonly spawnFailed: boolean;
  readonly cancelled: boolean;
  readonly durationMs: number;
  readonly stdoutTail: string;
  readonly stderrTail: string;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly truncated: boolean;
}

const outcomeOf = (
  state: ExecState,
  exitCode: number | null,
  signal: NodeJS.Signals | null,
): BoundedExecOutcome => ({
  exitCode,
  signal: signal ?? null,
  timedOut: state.timedOut,
  spawnFailed: state.spawnFailed,
  cancelled: state.cancelled,
  durationMs: Date.now() - state.startedAt,
  stdoutTail: state.stdout.text,
  stderrTail: state.stderr.text,
  stdoutBytes: state.stdoutBytes,
  stderrBytes: state.stderrBytes,
  truncated: state.truncated,
});

export class BoundedExecSpawnError extends Data.TaggedError("BoundedExecSpawnError")<{}> {}

/** A started process. `await` interrupted cancels it (tree kill). */
export interface BoundedProcess {
  readonly await: Effect.Effect<BoundedExecOutcome>;
  /** Marks the process cancelled, kills its tree, and settles `await` at once. */
  readonly cancel: () => void;
}

export interface BoundedExecInput {
  /** argv[0] is the program; no shell is involved. */
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  /** Merged over the server's environment, unless `inheritEnv` is false. */
  readonly env?: Readonly<Record<string, string>>;
  /** False: the process gets only `env`, nothing of the server's own environment. */
  readonly inheritEnv?: boolean;
  readonly timeoutMs: number;
  /** Each of stdout and stderr keeps its last `maxOutputBytes` bytes. */
  readonly maxOutputBytes: number;
  readonly platform: NodeJS.Platform;
}

/** Spawns `argv` and arms its timeout. */
const startBounded = (
  input: BoundedExecInput,
): Effect.Effect<BoundedProcess, BoundedExecSpawnError> =>
  Effect.try({
    try: () => {
      const child = NodeChildProcess.spawn(input.argv[0] as string, input.argv.slice(1), {
        cwd: input.cwd,
        env: input.inheritEnv === false ? { ...input.env } : { ...process.env, ...input.env },
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        detached: input.platform !== "win32",
      });
      const state: ExecState = {
        child,
        stdout: makeTail(input.maxOutputBytes),
        stderr: makeTail(input.maxOutputBytes),
        stdoutBytes: 0,
        stderrBytes: 0,
        truncated: false,
        cancelled: false,
        timedOut: false,
        startedAt: Date.now(),
        maxOutputBytes: input.maxOutputBytes,
        platform: input.platform,
        settled: false,
        spawned: false,
        spawnFailed: false,
        settle: undefined,
        timer: undefined,
      };
      let outcome: BoundedExecOutcome | undefined;
      const listeners: Array<(outcome: BoundedExecOutcome) => void> = [];
      const finish = (exitCode: number | null, signal: NodeJS.Signals | null) => {
        if (state.settled) return;
        state.settled = true;
        if (state.timer !== undefined) clearTimeout(state.timer);
        const settled = outcomeOf(state, exitCode, signal);
        outcome = settled;
        for (const listener of listeners.splice(0)) listener(settled);
      };
      state.settle = finish;
      child.once("spawn", () => {
        state.spawned = true;
      });
      child.once("error", () => {
        if (!state.spawned) state.spawnFailed = true;
        finish(null, null);
      });
      child.once("close", (code, signal) => finish(code, signal));
      child.stdout?.on("data", (chunk: Buffer) => append(state, "stdout", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append(state, "stderr", chunk));
      state.timer = setTimeout(() => {
        state.timedOut = true;
        killTree(state);
        // A grandchild that inherited the pipes can keep them open after the kill; settle
        // anyway once the kill has had time to land.
        const settleTimer = setTimeout(() => finish(null, null), SETTLE_AFTER_KILL_MS);
        settleTimer.unref();
      }, input.timeoutMs);
      state.timer.unref();

      const cancel = () => {
        if (state.settled) return;
        state.cancelled = true;
        killTree(state);
        finish(null, "SIGTERM");
      };
      const awaitOutcome = Effect.callback<BoundedExecOutcome>((resume) => {
        if (outcome !== undefined) {
          resume(Effect.succeed(outcome));
          return;
        }
        listeners.push((settled) => resume(Effect.succeed(settled)));
        return Effect.sync(() => {
          if (!state.settled) {
            state.cancelled = true;
            killTree(state);
          }
        });
      });
      return { await: awaitOutcome, cancel } satisfies BoundedProcess;
    },
    catch: () => new BoundedExecSpawnError(),
  });

/** Starts `argv` and waits for it; interrupting the wait kills the process tree. */
export const runBounded = (
  input: BoundedExecInput,
): Effect.Effect<BoundedExecOutcome, BoundedExecSpawnError> =>
  startBounded(input).pipe(Effect.flatMap((process) => process.await));
