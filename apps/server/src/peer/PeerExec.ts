// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalTimersInEffect:off globalDate:off globalDateInEffect:off effectFnOpportunity:off tryCatchInEffectGen:off -- The peer executor owns process-tree control and real wall-clock timeouts, which the platform APIs do not expose.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import {
  OrchestratorMcpFailure,
  PEER_EXEC_DEFAULT_OUTPUT_BYTES,
  PEER_EXEC_DEFAULT_TIMEOUT_MS,
  PEER_EXEC_MAX_OUTPUT_BYTES,
  PEER_EXEC_MAX_RUNNING,
  PEER_EXEC_MAX_TIMEOUT_MS,
  PEER_FS_LIST_MAX_ENTRIES,
  PEER_FS_READ_MAX_BYTES,
  type PeerExecCancelResult,
  type PeerExecGrant,
  type PeerExecInput,
  type PeerExecResult,
  type PeerFsListInput,
  type PeerFsListResult,
  type PeerFsReadInput,
  type PeerFsReadResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as BoundedExec from "../process/boundedExec.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as PeerExecReceipts from "./PeerExecReceipts.ts";

const failure = (
  code: ConstructorParameters<typeof OrchestratorMcpFailure>[0]["code"],
  message: string,
) => new OrchestratorMcpFailure({ code, message });

const canonicalRequest = (input: {
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}) =>
  JSON.stringify({
    argv: [...input.argv],
    cwd: input.cwd,
    env: Object.fromEntries(
      Object.entries(input.env).sort(([left], [right]) => left.localeCompare(right)),
    ),
    maxOutputBytes: input.maxOutputBytes,
    timeoutMs: input.timeoutMs,
  });

const sha256 = (text: string) => NodeCrypto.createHash("sha256").update(text).digest("hex");

/** Drops PATH from caller env: a link may add variables, not redirect program lookup. */
const callerEnvironment = (env: Readonly<Record<string, string>> | undefined) =>
  Object.fromEntries(Object.entries(env ?? {}).filter(([key]) => key.toLowerCase() !== "path"));

const isInside = (root: string, target: string, platform: NodeJS.Platform) => {
  const from = platform === "win32" ? root.toLowerCase() : root;
  const to = platform === "win32" ? target.toLowerCase() : target;
  const relative = NodePath.relative(from, to);
  return (
    relative === "" ||
    (!relative.startsWith(`..${NodePath.sep}`) &&
      relative !== ".." &&
      !NodePath.isAbsolute(relative))
  );
};

const errorCodeOf = (error: unknown): string | undefined =>
  typeof error === "object" && error !== null && "code" in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;

/**
 * The peer-local executor behind `peer-exec-v1`. It runs on the machine that
 * serves the call, spawns `argv` directly with no shell, confines paths to
 * configured and project roots, and records one durable receipt per caller
 * `execId`. It is also the local transport for the caller's own machine.
 */
export class PeerExec extends Context.Service<
  PeerExec,
  {
    readonly run: (input: PeerExecInput) => Effect.Effect<PeerExecResult, OrchestratorMcpFailure>;
    readonly cancel: (execId: string) => Effect.Effect<PeerExecCancelResult>;
    readonly readFile: (
      input: PeerFsReadInput,
    ) => Effect.Effect<PeerFsReadResult, OrchestratorMcpFailure>;
    readonly list: (
      input: PeerFsListInput,
    ) => Effect.Effect<PeerFsListResult, OrchestratorMcpFailure>;
    /** Startup or periodic maintenance: stale running receipts become unknown, old ones go. */
    readonly sweep: Effect.Effect<void>;
    readonly grant: Effect.Effect<PeerExecGrant>;
    readonly enabled: Effect.Effect<boolean>;
    readonly roots: Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/peer/PeerExec") {}

const make = Effect.gen(function* () {
  const receipts = yield* PeerExecReceipts.PeerExecReceipts;
  const settings = yield* ServerSettings.ServerSettingsService;
  const projects = yield* ProjectService.ProjectService;
  const platform = yield* HostProcess.Platform;

  const running = yield* Ref.make(0);
  const inFlight = yield* Ref.make(
    new Map<string, Deferred.Deferred<PeerExecResult, OrchestratorMcpFailure>>(),
  );
  const states = yield* Ref.make(new Map<string, BoundedExec.BoundedProcess>());
  const lastSweep = yield* Ref.make(0);

  const settingsNow = settings.getSettings.pipe(Effect.orElseSucceed(() => undefined));
  const grant = settingsNow.pipe(Effect.map((current) => current?.peerExecGrant ?? "off"));
  const enabled = settingsNow.pipe(
    Effect.map((current) => current?.executionTargetsEnabled === true),
  );

  const roots = Effect.gen(function* () {
    const current = yield* settingsNow;
    const configured = current?.peerExecRoots ?? [];
    const registered = yield* projects
      .listShells()
      .pipe(Effect.orElseSucceed((): ReadonlyArray<{ readonly workspaceRoot: string }> => []));
    const candidates = [...configured, ...registered.map((project) => project.workspaceRoot)];
    const resolved: Array<string> = [];
    for (const candidate of candidates) {
      const real = yield* Effect.tryPromise({
        try: () => NodeFSP.realpath(candidate),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      if (
        real !== undefined &&
        !resolved.some((root) => isInside(root, real, platform) && isInside(real, root, platform))
      ) {
        resolved.push(real);
      }
    }
    return resolved;
  });

  const resolveInsideRoots = Effect.fn("PeerExec.resolveInsideRoots")(function* (
    requested: string,
  ) {
    const absolute = NodePath.resolve(requested);
    const real = yield* Effect.tryPromise({
      try: () => NodeFSP.realpath(absolute),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined));
    const resolved =
      real ??
      (yield* Effect.gen(function* () {
        const parent = yield* Effect.tryPromise({
          try: () => NodeFSP.realpath(NodePath.dirname(absolute)),
          catch: () => undefined,
        }).pipe(Effect.orElseSucceed(() => undefined));
        return parent === undefined
          ? undefined
          : NodePath.join(parent, NodePath.basename(absolute));
      }));
    if (resolved === undefined) {
      return yield* failure(
        "target_path_not_found",
        `The path does not exist on this machine: ${requested}`,
      );
    }
    const allowed = yield* roots;
    if (!allowed.some((root) => isInside(root, resolved, platform))) {
      return yield* failure(
        "target_path_outside_roots",
        `The path is outside this machine's allowed roots: ${requested}`,
      );
    }
    return resolved;
  });

  const sweep = Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* receipts.sweep({ now }).pipe(Effect.orElseSucceed(() => 0));
  });

  const maybeSweep = Effect.gen(function* () {
    const now = Date.now();
    const previous = yield* Ref.get(lastSweep);
    if (now - previous < 60 * 60 * 1_000) return;
    yield* Ref.set(lastSweep, now);
    yield* sweep;
  });

  const acquire = Ref.modify(running, (count) =>
    count >= PEER_EXEC_MAX_RUNNING ? ([false, count] as const) : ([true, count + 1] as const),
  );

  const release = Ref.update(running, (count) => Math.max(0, count - 1));

  const begin = Effect.fn("PeerExec.begin")(function* (input: PeerExecInput) {
    const timeoutMs = input.timeoutMs ?? PEER_EXEC_DEFAULT_TIMEOUT_MS;
    const maxOutputBytes = input.maxOutputBytes ?? PEER_EXEC_DEFAULT_OUTPUT_BYTES;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0 || timeoutMs > PEER_EXEC_MAX_TIMEOUT_MS) {
      return yield* failure(
        "invalid_request",
        `timeoutMs must be between 1 and ${PEER_EXEC_MAX_TIMEOUT_MS}.`,
      );
    }
    if (
      !Number.isFinite(maxOutputBytes) ||
      maxOutputBytes <= 0 ||
      maxOutputBytes > PEER_EXEC_MAX_OUTPUT_BYTES
    ) {
      return yield* failure(
        "invalid_request",
        `maxOutputBytes must be between 1 and ${PEER_EXEC_MAX_OUTPUT_BYTES}.`,
      );
    }
    const cwd = yield* resolveInsideRoots(input.cwd);
    const env = callerEnvironment(input.env);
    const requestHash = sha256(
      canonicalRequest({
        argv: input.argv,
        cwd,
        env,
        timeoutMs,
        maxOutputBytes,
      }),
    );
    return { cwd, env, timeoutMs, maxOutputBytes, requestHash };
  });

  // eslint-disable-next-line t3code/prefer-effect-fn -- the interrupt cleanup needs the whole run scope.
  const run: PeerExec["Service"]["run"] = (input: PeerExecInput) =>
    Effect.gen(function* () {
      // One leader per execId: a concurrent retry waits for the first answer
      // instead of spawning the same command twice.
      const deferred = Deferred.makeUnsafe<PeerExecResult, OrchestratorMcpFailure>();
      const leader = yield* Ref.modify(inFlight, (current) =>
        current.has(input.execId)
          ? ([false, current] as const)
          : ([true, new Map(current).set(input.execId, deferred)] as const),
      );
      if (!leader) {
        const active = (yield* Ref.get(inFlight)).get(input.execId);
        if (active === undefined) {
          return yield* failure(
            "exec_state_unknown",
            "The execution could not be tracked; retry with a new execId.",
          );
        }
        return yield* Deferred.await(active);
      }
      const releaseDeferred = Ref.update(inFlight, (current) => {
        const next = new Map(current);
        next.delete(input.execId);
        return next;
      });
      const succeed = (result: PeerExecResult) =>
        Deferred.succeed(deferred, result).pipe(Effect.andThen(releaseDeferred));
      const failWith = (
        error: OrchestratorMcpFailure,
      ): Effect.Effect<never, OrchestratorMcpFailure> =>
        Deferred.fail(deferred, error).pipe(
          Effect.andThen(releaseDeferred),
          Effect.andThen(Effect.fail(error)),
        );

      yield* maybeSweep;
      const slot = yield* acquire;
      if (!slot) {
        return yield* failWith(
          failure(
            "target_busy",
            `This machine is already running ${PEER_EXEC_MAX_RUNNING} commands. Retry shortly.`,
          ),
        );
      }
      const outcome: Effect.Effect<PeerExecResult, OrchestratorMcpFailure> = Effect.gen(
        function* () {
          const prepared = yield* begin(input);
          const now = yield* DateTime.now;
          const receipt = yield* receipts.begin({
            execId: input.execId,
            requestHash: prepared.requestHash,
            now,
          });
          if (receipt.kind === "conflict") {
            return yield* failure(
              "exec_id_conflict",
              "This execId was already used for a different command. Use a new execId for a new execution.",
            );
          }
          if (receipt.kind === "unknown") {
            return yield* failure(
              "exec_state_unknown",
              "This execId was left by an interrupted run and is never rerun. Use a new execId if a new execution is intended.",
            );
          }
          if (receipt.kind === "replay") {
            return {
              execId: input.execId,
              ...receipt.metadata,
              stdoutTail: "",
              stderrTail: "",
              outputRetained: false,
            } satisfies PeerExecResult;
          }

          const started = yield* BoundedExec.startBounded({
            argv: input.argv,
            cwd: prepared.cwd,
            env: prepared.env,
            timeoutMs: prepared.timeoutMs,
            maxOutputBytes: prepared.maxOutputBytes,
            platform,
          }).pipe(
            Effect.mapError(() => failure("invalid_request", "The command could not be started.")),
          );
          yield* Ref.update(states, (current) => {
            const next = new Map(current);
            next.set(input.execId, started);
            return next;
          });

          const outcome = yield* started.await;
          const result: PeerExecResult = {
            execId: input.execId,
            ...outcome,
            cwd: prepared.cwd,
            platform,
            outputRetained: true,
          };

          yield* receipts.finish({
            execId: input.execId,
            metadata: PeerExecReceipts.receiptMetadataOf(result),
            now: yield* DateTime.now,
          });
          return result;
        },
      ).pipe(
        Effect.onError(() =>
          Effect.gen(function* () {
            yield* receipts
              .markUnknown({ execId: input.execId, now: yield* DateTime.now })
              .pipe(Effect.ignore);
          }),
        ),
        Effect.ensuring(
          Effect.gen(function* () {
            yield* release;
            yield* Ref.update(states, (current) => {
              const next = new Map(current);
              next.delete(input.execId);
              return next;
            });
          }),
        ),
      );
      const settled = yield* Effect.result(outcome);
      if (settled._tag === "Failure") {
        return yield* failWith(settled.failure);
      }
      yield* succeed(settled.success);
      return settled.success;
    }).pipe(
      Effect.onInterrupt(() =>
        Effect.gen(function* () {
          const active = (yield* Ref.get(inFlight)).get(input.execId);
          if (active !== undefined) {
            yield* Deferred.fail(
              active,
              failure(
                "exec_state_unknown",
                "The request was interrupted while the command was running.",
              ),
            ).pipe(Effect.ignore);
            yield* Ref.update(inFlight, (current) => {
              const next = new Map(current);
              next.delete(input.execId);
              return next;
            });
          }
          yield* receipts
            .markUnknown({ execId: input.execId, now: yield* DateTime.now })
            .pipe(Effect.ignore);
        }),
      ),
    );

  const cancel: PeerExec["Service"]["cancel"] = Effect.fn("PeerExec.cancel")(function* (execId) {
    const started = (yield* Ref.get(states)).get(execId);
    if (started !== undefined) {
      started.cancel();
      return { cancelled: true, state: "running" };
    }
    const stored = yield* receipts
      .stateOf(execId)
      .pipe(Effect.orElseSucceed(() => "unknown" as const));
    if (stored === "running") {
      yield* receipts
        .markUnknown({ execId, now: yield* DateTime.now })
        .pipe(Effect.orElseSucceed(() => false));
      return { cancelled: false, state: "unknown" };
    }
    return { cancelled: false, state: stored };
  });
  const readFile: PeerExec["Service"]["readFile"] = Effect.fn("PeerExec.readFile")(
    function* (input) {
      const path = yield* resolveInsideRoots(input.path);
      const stat = yield* Effect.tryPromise({
        try: () => NodeFSP.stat(path),
        catch: () =>
          failure(
            "target_path_not_found",
            `The file does not exist on this machine: ${input.path}`,
          ),
      });
      if (!stat.isFile()) {
        return yield* failure("invalid_request", `The path is not a regular file: ${input.path}`);
      }
      const offset = Math.max(0, Math.floor(input.offset ?? 0));
      const limit = Math.min(
        PEER_FS_READ_MAX_BYTES,
        Math.max(1, Math.floor(input.limit ?? PEER_FS_READ_MAX_BYTES)),
      );
      if (offset > stat.size) {
        return yield* failure("invalid_request", "offset is past the end of the file.");
      }
      const buffer = Buffer.alloc(Math.min(limit, stat.size - offset));
      const handle = yield* Effect.tryPromise({
        try: () => NodeFSP.open(path, "r"),
        catch: () => failure("target_path_not_found", `The file could not be read: ${input.path}`),
      });
      const bytes = yield* Effect.tryPromise({
        try: () => handle.read(buffer, 0, buffer.length, offset),
        catch: () => failure("target_path_not_found", `The file could not be read: ${input.path}`),
      }).pipe(Effect.ensuring(Effect.promise(() => handle.close())));
      let encoding: "utf8" | "base64" = "utf8";
      let content: string;
      const body = bytes.buffer.subarray(0, bytes.bytesRead);
      try {
        content = new TextDecoder("utf-8", { fatal: true }).decode(body);
      } catch {
        encoding = "base64";
        content = body.toString("base64");
      }
      return {
        path,
        size: stat.size,
        offset,
        bytes: bytes.bytesRead,
        encoding,
        content,
        eof: offset + bytes.bytesRead >= stat.size,
      };
    },
  );

  const list: PeerExec["Service"]["list"] = Effect.fn("PeerExec.list")(function* (input) {
    const path = yield* resolveInsideRoots(input.path);
    const entries = yield* Effect.tryPromise({
      try: () => NodeFSP.readdir(path, { withFileTypes: true }),
      catch: (error) =>
        errorCodeOf(error) === "ENOENT"
          ? failure(
              "target_path_not_found",
              `The directory does not exist on this machine: ${input.path}`,
            )
          : failure("invalid_request", `The directory could not be listed: ${input.path}`),
    });
    const limit = Math.min(
      PEER_FS_LIST_MAX_ENTRIES,
      Math.max(1, Math.floor(input.limit ?? PEER_FS_LIST_MAX_ENTRIES)),
    );
    const start = Math.max(0, Number.parseInt(input.cursor ?? "0", 10) || 0);
    const page = entries
      .slice()
      .sort((left, right) => left.name.localeCompare(right.name))
      .slice(start, start + limit);
    const rows = [];
    for (const entry of page) {
      const entryPath = NodePath.join(path, entry.name);
      const stat = yield* Effect.tryPromise({
        try: () => NodeFSP.lstat(entryPath),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined));
      rows.push({
        name: entry.name,
        kind: entry.isDirectory()
          ? ("directory" as const)
          : entry.isSymbolicLink()
            ? ("symlink" as const)
            : entry.isFile()
              ? ("file" as const)
              : ("other" as const),
        size: stat?.size ?? null,
        mtime: stat === undefined ? null : stat.mtime.toISOString(),
      });
    }
    const next = start + page.length;
    return {
      path,
      entries: rows,
      nextCursor: next < entries.length ? String(next) : null,
    };
  });

  // A process that stopped with a running receipt cannot have finished it.
  yield* receipts
    .markAllRunningUnknown({ now: yield* DateTime.now })
    .pipe(Effect.orElseSucceed(() => 0));
  yield* sweep;

  return PeerExec.of({
    run,
    cancel,
    readFile,
    list,
    sweep,
    grant,
    enabled,
    roots,
  });
});

export const layer = Layer.effect(PeerExec, make);
