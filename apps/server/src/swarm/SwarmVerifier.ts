import type { OrchestrationV2ThreadProjection } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as BoundedExec from "../process/boundedExec.ts";
import * as ProjectService from "../project/ProjectService.ts";

// Swarm v2 verify (SW-A6): runs a member's verify argv in the member's checkout through the
// bounded spawn core, with no shell. Output is returned for the envelope and the retry message;
// it is never logged.

/** The envelope keeps at most this much output (`SwarmEnvelope.verify.outputTail`). */
export const VERIFY_OUTPUT_TAIL_CHARACTERS = 4_096;
const VERIFY_STREAM_TAIL_BYTES = 16_384;

/**
 * What a verify command may see of the server's environment: what tools need to start and find
 * their programs, never the server's secrets or provider tokens.
 */
const VERIFY_ENV_NAMES: ReadonlySet<string> = new Set(
  [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "TEMP",
    "TMP",
    "TMPDIR",
    "HOME",
    "USERPROFILE",
    "HOMEDRIVE",
    "HOMEPATH",
    "APPDATA",
    "LOCALAPPDATA",
    "PROGRAMDATA",
    "PROGRAMFILES",
    "PROGRAMFILES(X86)",
    "COMMONPROGRAMFILES",
    "NUMBER_OF_PROCESSORS",
    "PROCESSOR_ARCHITECTURE",
    "OS",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SHELL",
    "LANG",
    "LANGUAGE",
    "TERM",
    "TZ",
    // Toolchain homes.
    "CARGO_HOME",
    "RUSTUP_HOME",
    "RUSTUP_TOOLCHAIN",
    "GOPATH",
    "GOROOT",
    "GOCACHE",
    "JAVA_HOME",
    "VIRTUAL_ENV",
    "CONDA_PREFIX",
    "PYTHONPATH",
    "PNPM_HOME",
    "COREPACK_HOME",
    "NVM_DIR",
    // Proxies and certificates.
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "NO_PROXY",
    "SSL_CERT_FILE",
    "NODE_EXTRA_CA_CERTS",
    // Windows.
    "ALLUSERSPROFILE",
    "PUBLIC",
    "PROGRAMW6432",
    "COMMONPROGRAMW6432",
    "PSMODULEPATH",
    "USERDOMAIN",
  ].map((name) => name.toUpperCase()),
);

/** The allowlisted variables, plus `LC_*`; names compare case-insensitively (Windows). */
export const verifyEnvironment = (
  source: Readonly<Record<string, string | undefined>>,
  extraNames: ReadonlyArray<string> = [],
): Record<string, string> => {
  const extra = new Set(extraNames.map((name) => name.toUpperCase()));
  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        entry[1] !== undefined &&
        (VERIFY_ENV_NAMES.has(entry[0].toUpperCase()) ||
          extra.has(entry[0].toUpperCase()) ||
          entry[0].toUpperCase().startsWith("LC_") ||
          entry[0].toUpperCase().startsWith("XDG_")),
    ),
  );
};

export interface SwarmVerifyOutcome {
  readonly passed: boolean;
  readonly exitCode: number | null;
  readonly timedOut: boolean;
  /** The command could not be started at all; a retry would fail the same way. */
  readonly notStarted: boolean;
  /** stdout, then stderr, cut to the last 4,096 characters. */
  readonly outputTail: string;
}

/** A running verify command: its OS pid and when it started (epoch ms). */
export interface VerifyProcess {
  readonly pid: number;
  readonly startedAtMs: number;
}

export class SwarmVerifyCheckoutError extends Data.TaggedError("SwarmVerifyCheckoutError")<{}> {}

export class SwarmVerifier extends Context.Service<
  SwarmVerifier,
  {
    /** The member's checkout: its worktree, else its project's workspace root. */
    readonly checkoutOf: (
      thread: Pick<OrchestrationV2ThreadProjection["thread"], "worktreePath" | "projectId">,
    ) => Effect.Effect<string, SwarmVerifyCheckoutError>;
    /** Runs argv to completion; interrupting it kills the process tree. */
    readonly run: (input: {
      readonly argv: ReadonlyArray<string>;
      readonly cwd: string;
      readonly timeoutMs: number;
      /** Called once the process exists, so its pid can be persisted. */
      readonly onStarted?: (process: VerifyProcess) => void;
      /** More variable names to pass through (the `swarmVerifyEnv` setting for the project). */
      readonly extraEnvNames?: ReadonlyArray<string>;
    }) => Effect.Effect<SwarmVerifyOutcome>;
    /** Kills a check's process tree left by an earlier server process, if it is still that one. */
    readonly killStale: (process: VerifyProcess) => Effect.Effect<boolean>;
  }
>()("t3/swarm/SwarmVerifier") {}

const tailOf = (outcome: BoundedExec.BoundedExecOutcome) => {
  const text =
    outcome.stderrTail.length === 0
      ? outcome.stdoutTail
      : outcome.stdoutTail.length === 0
        ? outcome.stderrTail
        : `${outcome.stdoutTail}\n${outcome.stderrTail}`;
  return text.length <= VERIFY_OUTPUT_TAIL_CHARACTERS
    ? text
    : text.slice(text.length - VERIFY_OUTPUT_TAIL_CHARACTERS);
};

const make = Effect.gen(function* () {
  const projects = yield* ProjectService.ProjectService;
  const platform = yield* HostProcess.Platform;

  const checkoutOf: SwarmVerifier["Service"]["checkoutOf"] = Effect.fn("SwarmVerifier.checkoutOf")(
    function* (thread) {
      if (thread.worktreePath !== null) return thread.worktreePath;
      const project = yield* projects
        .getById(thread.projectId)
        .pipe(Effect.mapError(() => new SwarmVerifyCheckoutError()));
      if (Option.isNone(project)) return yield* new SwarmVerifyCheckoutError();
      return project.value.workspaceRoot;
    },
  );

  const run: SwarmVerifier["Service"]["run"] = (input) =>
    BoundedExec.startBounded({
      argv: input.argv,
      cwd: input.cwd,
      env: { ...verifyEnvironment(process.env, input.extraEnvNames), CI: "1" },
      inheritEnv: false,
      timeoutMs: input.timeoutMs,
      maxOutputBytes: VERIFY_STREAM_TAIL_BYTES,
      platform,
    }).pipe(
      Effect.tap((started) =>
        Effect.sync(() => {
          if (started.pid !== undefined) {
            input.onStarted?.({ pid: started.pid, startedAtMs: started.startedAtMs });
          }
        }),
      ),
      Effect.flatMap((started) => started.await),
      Effect.map((outcome): SwarmVerifyOutcome => ({
        passed: outcome.exitCode === 0 && !outcome.timedOut && !outcome.cancelled,
        exitCode: outcome.exitCode,
        timedOut: outcome.timedOut,
        notStarted: outcome.spawnFailed,
        outputTail: tailOf(outcome),
      })),
      Effect.catchTags({
        BoundedExecSpawnError: () =>
          Effect.succeed<SwarmVerifyOutcome>({
            passed: false,
            exitCode: null,
            timedOut: false,
            notStarted: true,
            outputTail: "",
          }),
      }),
    );

  const killStale: SwarmVerifier["Service"]["killStale"] = (stale) =>
    BoundedExec.killStaleTree({ ...stale, platform });

  return SwarmVerifier.of({ checkoutOf, run, killStale });
});

export const layer = Layer.effect(SwarmVerifier, make);
