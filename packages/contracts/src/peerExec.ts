import * as Schema from "effect/Schema";

import { TrimmedNonEmptyString } from "./baseSchemas.ts";
import { EnvironmentId } from "./baseSchemas.ts";

/** The capability contract a peer advertises when it can run commands for a link. */
export const PEER_EXEC_CONTRACT = "peer-exec-v1" as const;

/**
 * What a peer link may do on the target, separate from orchestration access. A
 * link that can launch threads does not silently gain raw shell: the target
 * chooses this, and it defaults to `off`.
 */
export const PeerExecGrant = Schema.Literals(["off", "read-only", "auto", "full-access"]);
export type PeerExecGrant = typeof PeerExecGrant.Type;

export const PeerExecId = TrimmedNonEmptyString;
export type PeerExecId = typeof PeerExecId.Type;

/** Bounded command limits. Defaults are applied before hashing, so omitting one equals naming it. */
export const PEER_EXEC_DEFAULT_TIMEOUT_MS = 60_000;
export const PEER_EXEC_MAX_TIMEOUT_MS = 600_000;
export const PEER_EXEC_DEFAULT_OUTPUT_BYTES = 65_536;
export const PEER_EXEC_MAX_OUTPUT_BYTES = 262_144;
export const PEER_FS_READ_MAX_BYTES = 262_144;
export const PEER_FS_LIST_MAX_ENTRIES = 1_000;
export const PEER_EXEC_MAX_RUNNING = 4;
export const PEER_EXEC_RECEIPT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
export const PEER_EXEC_RECEIPT_MAX_ROWS = 10_000;
export const PEER_EXEC_RECEIPT_MAX_BYTES = 16 * 1024 * 1024;

/**
 * Runs one bounded command on the peer that serves the call. `argv` is spawned
 * directly: there is no implicit shell, quoting, or interpolation.
 */
export const PeerExecInput = Schema.Struct({
  execId: PeerExecId.annotate({
    description:
      "Caller-generated idempotency id (a uuid). Retry a lost reply with the same id; never reuse one for a different command.",
  }),
  argv: Schema.NonEmptyArray(TrimmedNonEmptyString).annotate({
    description:
      'Program and arguments, spawned without a shell. Name a shell in argv to use one, for example ["pwsh","-NoProfile","-Command","..."].',
  }),
  cwd: TrimmedNonEmptyString,
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.Number),
  maxOutputBytes: Schema.optionalKey(Schema.Number),
});
export type PeerExecInput = typeof PeerExecInput.Type;

export const PeerExecResult = Schema.Struct({
  execId: PeerExecId,
  exitCode: Schema.NullOr(Schema.Number),
  signal: Schema.NullOr(Schema.String),
  timedOut: Schema.Boolean,
  cancelled: Schema.Boolean,
  durationMs: Schema.Number,
  stdoutTail: Schema.String,
  stderrTail: Schema.String,
  stdoutBytes: Schema.Number,
  stderrBytes: Schema.Number,
  truncated: Schema.Boolean,
  cwd: Schema.String,
  platform: TrimmedNonEmptyString,
  /** False on a replay: the receipt keeps metadata only, never output tails. */
  outputRetained: Schema.Boolean,
});
export type PeerExecResult = typeof PeerExecResult.Type;

export const PeerExecCancelInput = Schema.Struct({ execId: PeerExecId });
export type PeerExecCancelInput = typeof PeerExecCancelInput.Type;

export const PeerExecState = Schema.Literals(["running", "finished", "unknown"]);
export type PeerExecState = typeof PeerExecState.Type;

export const PeerExecCancelResult = Schema.Struct({
  cancelled: Schema.Boolean,
  state: PeerExecState,
});
export type PeerExecCancelResult = typeof PeerExecCancelResult.Type;

export const PeerFsReadInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
export type PeerFsReadInput = typeof PeerFsReadInput.Type;

export const PeerFsReadResult = Schema.Struct({
  path: Schema.String,
  size: Schema.Number,
  offset: Schema.Number,
  bytes: Schema.Number,
  encoding: Schema.Literals(["utf8", "base64"]),
  content: Schema.String,
  eof: Schema.Boolean,
});
export type PeerFsReadResult = typeof PeerFsReadResult.Type;

export const PeerFsEntryKind = Schema.Literals(["file", "directory", "symlink", "other"]);
export type PeerFsEntryKind = typeof PeerFsEntryKind.Type;

export const PeerFsEntry = Schema.Struct({
  name: Schema.String,
  kind: PeerFsEntryKind,
  size: Schema.NullOr(Schema.Number),
  mtime: Schema.NullOr(Schema.String),
});
export type PeerFsEntry = typeof PeerFsEntry.Type;

export const PeerFsListInput = Schema.Struct({
  path: TrimmedNonEmptyString,
  limit: Schema.optionalKey(Schema.Number),
  cursor: Schema.optionalKey(Schema.String),
});
export type PeerFsListInput = typeof PeerFsListInput.Type;

export const PeerFsListResult = Schema.Struct({
  path: Schema.String,
  entries: Schema.Array(PeerFsEntry),
  nextCursor: Schema.NullOr(Schema.String),
});
export type PeerFsListResult = typeof PeerFsListResult.Type;

/** The caller's own machine, or a linked environment id. P0 requires one on every call. */
export const ExecutionTarget = Schema.Union([Schema.Literal("home"), EnvironmentId]);
export type ExecutionTarget = typeof ExecutionTarget.Type;

export const T3ShellInput = Schema.Struct({
  target: ExecutionTarget.annotate({
    description:
      'Where to run: "home" or a linked environment id from `orchestrator_capabilities`.',
  }),
  argv: Schema.NonEmptyArray(TrimmedNonEmptyString),
  cwd: Schema.optionalKey(
    Schema.String.annotate({
      description: "Required for a linked target; defaults to the caller's workspace at home.",
    }),
  ),
  env: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  timeoutMs: Schema.optionalKey(Schema.Number),
  maxOutputBytes: Schema.optionalKey(Schema.Number),
  execId: Schema.optionalKey(
    PeerExecId.annotate({
      description:
        "Optional idempotency id. On a lost reply, retry the same id; it never runs twice. Omit for a new execution.",
    }),
  ),
});
export type T3ShellInput = typeof T3ShellInput.Type;

export const T3ShellResult = Schema.Struct({
  targetId: Schema.String,
  environmentId: EnvironmentId,
  ...PeerExecResult.fields,
});
export type T3ShellResult = typeof T3ShellResult.Type;

export const T3FsReadInput = Schema.Struct({
  target: ExecutionTarget,
  path: TrimmedNonEmptyString,
  offset: Schema.optionalKey(Schema.Number),
  limit: Schema.optionalKey(Schema.Number),
});
export type T3FsReadInput = typeof T3FsReadInput.Type;

export const T3FsReadResult = Schema.Struct({
  targetId: Schema.String,
  environmentId: EnvironmentId,
  ...PeerFsReadResult.fields,
});
export type T3FsReadResult = typeof T3FsReadResult.Type;
