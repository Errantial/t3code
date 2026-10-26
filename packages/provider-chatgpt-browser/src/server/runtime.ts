// @effect-diagnostics-next-line nodeBuiltinImport:off -- The provider WAL needs Node's stable SHA-256 and collision-resistant temp-file nonce.
import { createHash, randomUUID } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- This scoped host is the concrete Node durable-state owner behind the abstract S0 host port.
import { promises as fs } from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- WAL paths are resolved entirely inside the injected provider state directory.
import path from "node:path";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Windows atomic replacement retries use bounded promise-based delay without global timers.
import { setTimeout as delay } from "node:timers/promises";

import {
  ChatGptBrowserHostError,
  ChatGptBrowserProviderV1CoreEvent,
  ChatGptBrowserProviderV1Error,
  ChatGptBrowserProviderV1EventSequence,
  CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16,
  type ChatGptBrowserHostIdentity,
  type ChatGptBrowserHostPort,
  type ChatGptBrowserProviderOperationId,
  type ChatGptBrowserProviderV1NativeIdentity,
  type ChatGptBrowserProviderV1OperationSnapshot,
  type ChatGptBrowserProviderV1ProtocolIdentity,
  type ChatGptBrowserProviderV1SendRequest,
  type ChatGptBrowserProviderV1TerminalStatus,
  type ChatGptBrowserProviderV1Transport,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  CHATGPT_BROWSER_S8_FEATURE,
  type ChatGptBrowserS8FeaturePayload,
  type ChatGptBrowserS8FeatureTransport,
} from "./features.ts";
import type { ChatGptBrowserProviderV1FeatureMessage } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";

export interface ChatGptBrowserProviderSecretsPort {
  readonly read: (key: string) => Promise<Uint8Array | null>;
  readonly write: (key: string, value: Uint8Array) => Promise<void>;
  readonly delete: (key: string) => Promise<void>;
}

export interface ChatGptBrowserProviderAssets {
  readonly stateDirectory: string;
  readonly hostIdentity: ChatGptBrowserHostIdentity;
}

export interface ChatGptBrowserProviderAssetsPort {
  readonly prepare: () => Promise<ChatGptBrowserProviderAssets>;
}

export interface ChatGptBrowserProviderBrowserObservation {
  readonly providerOperationId: ChatGptBrowserProviderOperationId;
  readonly state: "claimed" | "sent" | "running" | "terminal" | "drained";
  readonly nativeIdentity: ChatGptBrowserProviderV1NativeIdentity;
  /** Exact browser-side proof that the one-time Send authorization fence has been crossed. */
  readonly sendAuthorized?: boolean;
  readonly terminalStatus?: ChatGptBrowserProviderV1TerminalStatus;
  /** Exact-owned browser message snapshots. Revisions replace by item id; the WAL sequences them. */
  readonly assistantRevisions?: ReadonlyArray<{
    readonly itemId: string;
    readonly order: number;
    readonly text: string;
  }>;
  /** Exact-owned native tool snapshots. No arguments or page-private payloads cross this boundary. */
  readonly toolRevisions?: ReadonlyArray<{
    readonly itemId: string;
    readonly order: number;
    readonly toolName?: string;
    readonly title?: string;
    readonly output?: string;
    readonly status: "running" | "completed";
  }>;
  /** Canonical complete assistant final. No interim or presentation text is accepted here. */
  readonly finalText?: string;
  /** Stable browser message identity for the canonical final, when the page exposes one. */
  readonly finalMessageId?: string;
}

export interface ChatGptBrowserProviderBrowserSession {
  readonly identity: ChatGptBrowserProviderV1ProtocolIdentity;
  readonly sendExact: (
    request: ChatGptBrowserProviderV1SendRequest,
    signal: AbortSignal,
    context?: { readonly conversationId?: string },
  ) => Promise<ChatGptBrowserProviderBrowserObservation>;
  readonly queryExact: (
    providerOperationId: ChatGptBrowserProviderOperationId,
    signal: AbortSignal,
  ) => Promise<ChatGptBrowserProviderBrowserObservation | null>;
  readonly cancelExact: (
    providerOperationId: ChatGptBrowserProviderOperationId,
    signal: AbortSignal,
  ) => Promise<ChatGptBrowserProviderBrowserObservation>;
  readonly waitForChange: (
    providerOperationId: ChatGptBrowserProviderOperationId,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly feature?: (
    message: ChatGptBrowserProviderV1FeatureMessage<
      typeof CHATGPT_BROWSER_S8_FEATURE,
      ChatGptBrowserS8FeaturePayload
    >,
  ) => Promise<unknown>;
  readonly close: () => Promise<void>;
}

export interface ChatGptBrowserProviderBrowserPort {
  readonly open: (input: {
    readonly assets: ChatGptBrowserProviderAssets;
    readonly secrets: ChatGptBrowserProviderSecretsPort;
  }) => Promise<ChatGptBrowserProviderBrowserSession>;
}

export interface ChatGptBrowserProviderSettlementPort {
  /**
   * T3-owned effect fence. The provider may seal `operation.drained` only after this resolves for
   * the exact terminal operation. It does not schedule work or infer browser completion.
   */
  readonly settleBeforeDrain: (input: {
    readonly providerOperationId: ChatGptBrowserProviderOperationId;
    readonly nativeIdentity: ChatGptBrowserProviderV1NativeIdentity;
    readonly terminalStatus: ChatGptBrowserProviderV1TerminalStatus;
  }) => Promise<void>;
}

export interface ScopedChatGptBrowserHostOptions {
  readonly browser: ChatGptBrowserProviderBrowserPort;
  readonly secrets: ChatGptBrowserProviderSecretsPort;
  readonly assets: ChatGptBrowserProviderAssetsPort;
  readonly settlement: ChatGptBrowserProviderSettlementPort;
}

interface DurableOperation {
  readonly schemaVersion: 1;
  readonly providerOperationId: string;
  readonly providerSessionId: string;
  readonly text: string;
  readonly textHash: string;
  readonly dispatchState: "prepared" | "dispatched";
  readonly state: "claimed" | "sent" | "running" | "terminal" | "drained";
  readonly nativeIdentity: ChatGptBrowserProviderV1NativeIdentity;
  /** Monotonic provider event sequence, independent from compacted retained event rows. */
  readonly highWater: number;
  readonly events: ReadonlyArray<ChatGptBrowserProviderV1CoreEvent>;
  readonly assistantRevisions?: ReadonlyArray<{
    readonly itemId: string;
    readonly ordinal: number;
    readonly text: string;
  }>;
  readonly toolRevisions?: ReadonlyArray<{
    readonly itemId: string;
    readonly ordinal: number;
    readonly toolName?: string;
    readonly title?: string;
    readonly output?: string;
    readonly status: "running" | "completed";
  }>;
  readonly finalText?: string;
  readonly finalMessageId?: string;
}

const terminalStates = new Set<DurableOperation["state"]>(["terminal", "drained"]);
const MAX_LIVE_REVISION_ITEMS = 256;
const MAX_LIVE_REVISION_BYTES = 4 * 1024 * 1024;
const stateRank: Record<DurableOperation["state"], number> = {
  claimed: 0,
  sent: 1,
  running: 2,
  terminal: 3,
  drained: 4,
};

const providerFailure = (
  code: ChatGptBrowserProviderV1Error["code"],
  message: string,
  retryable = false,
): ChatGptBrowserProviderV1Error => ({ code, retryable, message: message.slice(0, 512) });

const isProviderFailure = (value: unknown): value is ChatGptBrowserProviderV1Error =>
  Boolean(
    value &&
    typeof value === "object" &&
    "code" in value &&
    "retryable" in value &&
    "message" in value,
  );

const hostFailure = (operation: string, cause?: unknown) =>
  new ChatGptBrowserHostError({ operation, ...(cause === undefined ? {} : { cause }) });

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");
const fileName = (operationId: string): string => `${sha256(operationId)}.json`;

function liveRevisionBudget(
  assistantRevisions: DurableOperation["assistantRevisions"],
  toolRevisions: DurableOperation["toolRevisions"],
): { readonly items: number; readonly bytes: number } {
  const assistants = assistantRevisions ?? [];
  const tools = toolRevisions ?? [];
  let bytes = 0;
  for (const revision of assistants) {
    bytes += Buffer.byteLength(revision.itemId, "utf8") + Buffer.byteLength(revision.text, "utf8");
  }
  for (const revision of tools) {
    bytes += Buffer.byteLength(revision.itemId, "utf8");
    if (revision.toolName) bytes += Buffer.byteLength(revision.toolName, "utf8");
    if (revision.title) bytes += Buffer.byteLength(revision.title, "utf8");
    if (revision.output) bytes += Buffer.byteLength(revision.output, "utf8");
  }
  return { items: assistants.length + tools.length, bytes };
}

function liveRevisionBudgetValid(
  assistantRevisions: DurableOperation["assistantRevisions"],
  toolRevisions: DurableOperation["toolRevisions"],
): boolean {
  const budget = liveRevisionBudget(assistantRevisions, toolRevisions);
  return budget.items <= MAX_LIVE_REVISION_ITEMS && budget.bytes <= MAX_LIVE_REVISION_BYTES;
}

function parseOperation(value: unknown): DurableOperation | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Partial<DurableOperation>;
  if (
    row.schemaVersion !== 1 ||
    typeof row.providerOperationId !== "string" ||
    typeof row.providerSessionId !== "string" ||
    typeof row.text !== "string" ||
    typeof row.textHash !== "string" ||
    (row.dispatchState !== "prepared" && row.dispatchState !== "dispatched") ||
    !row.state ||
    !(row.state in stateRank) ||
    !row.nativeIdentity ||
    !Array.isArray(row.events)
  ) {
    return null;
  }
  let events: ReadonlyArray<ChatGptBrowserProviderV1CoreEvent>;
  try {
    events = Schema.decodeSync(Schema.Array(ChatGptBrowserProviderV1CoreEvent))(row.events);
  } catch {
    return null;
  }
  let previousSequence = -1;
  for (const event of events) {
    if (event.providerOperationId !== row.providerOperationId || event.sequence <= previousSequence)
      return null;
    previousSequence = event.sequence;
  }
  const highWater = row.highWater ?? Math.max(0, previousSequence);
  if (!Number.isSafeInteger(highWater) || highWater < Math.max(0, previousSequence)) return null;
  const assistantRevisions = row.assistantRevisions;
  if (
    assistantRevisions !== undefined &&
    (!Array.isArray(assistantRevisions) ||
      assistantRevisions.some(
        (revision) =>
          !revision ||
          typeof revision !== "object" ||
          typeof revision.itemId !== "string" ||
          revision.itemId.length === 0 ||
          revision.itemId.length > 256 ||
          !Number.isSafeInteger(revision.ordinal) ||
          revision.ordinal < 0 ||
          typeof revision.text !== "string" ||
          revision.text.length > 65_536,
      ))
  ) {
    return null;
  }
  const toolRevisions = row.toolRevisions;
  if (
    toolRevisions !== undefined &&
    (!Array.isArray(toolRevisions) ||
      toolRevisions.some(
        (revision) =>
          !revision ||
          typeof revision !== "object" ||
          typeof revision.itemId !== "string" ||
          revision.itemId.length === 0 ||
          revision.itemId.length > 256 ||
          !Number.isSafeInteger(revision.ordinal) ||
          revision.ordinal < 0 ||
          (revision.toolName !== undefined &&
            (typeof revision.toolName !== "string" ||
              revision.toolName.length === 0 ||
              revision.toolName.length > 128)) ||
          (revision.title !== undefined &&
            (typeof revision.title !== "string" ||
              revision.title.length === 0 ||
              revision.title.length > 512)) ||
          (revision.output !== undefined &&
            (typeof revision.output !== "string" || revision.output.length > 32_768)) ||
          (revision.status !== "running" && revision.status !== "completed"),
      ))
  ) {
    return null;
  }
  if (
    row.finalMessageId !== undefined &&
    (typeof row.finalMessageId !== "string" ||
      row.finalMessageId.length === 0 ||
      row.finalMessageId.length > 256)
  ) {
    return null;
  }
  if (!liveRevisionBudgetValid(assistantRevisions, toolRevisions)) return null;
  return { ...row, highWater, events } as DurableOperation;
}

class ProviderWal {
  readonly directory: string;

  constructor(stateDirectory: string) {
    this.directory = path.join(stateDirectory, "chatgpt-browser-provider-v1");
  }

  async init(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true, mode: 0o700 });
    if (process.platform !== "win32") {
      await fs.chmod(this.directory, 0o700);
      await syncDirectory(path.dirname(this.directory));
    }
  }

  private file(operationId: string): string {
    return path.join(this.directory, fileName(operationId));
  }

  async read(operationId: string): Promise<DurableOperation | null> {
    let bytes: string;
    try {
      bytes = await fs.readFile(this.file(operationId), "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes);
    } catch {
      throw new Error("provider_wal_corrupt");
    }
    const record = parseOperation(parsed);
    if (
      !record ||
      record.providerOperationId !== operationId ||
      record.textHash !== sha256(record.text)
    ) {
      throw new Error("provider_wal_corrupt");
    }
    return record;
  }

  async all(): Promise<ReadonlyArray<DurableOperation>> {
    await this.init();
    const records: DurableOperation[] = [];
    for (const name of await fs.readdir(this.directory)) {
      if (!name.endsWith(".json")) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(await fs.readFile(path.join(this.directory, name), "utf8"));
      } catch {
        throw new Error("provider_wal_corrupt");
      }
      const record = parseOperation(raw);
      if (
        !record ||
        fileName(record.providerOperationId) !== name ||
        record.textHash !== sha256(record.text)
      ) {
        throw new Error("provider_wal_corrupt");
      }
      records.push(record);
    }
    return records;
  }

  async write(record: DurableOperation): Promise<void> {
    await this.init();
    const target = this.file(record.providerOperationId);
    const temp = `${target}.${process.pid}.${randomUUID()}.tmp`;
    const handle = await fs.open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(record), "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await replaceFile(temp, target);
      if (process.platform !== "win32") await syncDirectory(this.directory);
    } finally {
      await fs.rm(temp, { force: true }).catch(() => undefined);
    }
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await fs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function replaceFile(source: string, target: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(source, target);
      return;
    } catch (cause) {
      const code = (cause as NodeJS.ErrnoException).code;
      const sharingViolation =
        process.platform === "win32" && (code === "EACCES" || code === "EPERM" || code === "EBUSY");
      if (!sharingViolation || attempt >= 7) throw cause;
      await delay(Math.min(100, 5 * 2 ** attempt));
    }
  }
}

class OperationSerial {
  private readonly tails = new Map<string, Promise<void>>();

  async run<A>(providerOperationId: string, operation: () => Promise<A>): Promise<A> {
    const prior = this.tails.get(providerOperationId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const current = prior.then(() => gate);
    this.tails.set(providerOperationId, current);
    await prior;
    try {
      return await operation();
    } finally {
      release();
      if (this.tails.get(providerOperationId) === current) this.tails.delete(providerOperationId);
    }
  }
}

function appendEvent(
  record: DurableOperation,
  payload: ChatGptBrowserProviderV1CoreEvent["payload"],
): DurableOperation {
  const sequence = record.highWater + 1;
  const event: ChatGptBrowserProviderV1CoreEvent = {
    providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
    sequence: ChatGptBrowserProviderV1EventSequence.make(sequence),
    payload,
  };
  // Live snapshots replace older snapshots for the same exact item. Keep the sequence high-water
  // monotonic while compacting superseded text/tool bodies out of the durable WAL. A consumer
  // behind the removed row reconstructs the same current state from the newer snapshot; a
  // consumer ahead of it still receives the newer sequence as the next update.
  const retained =
    payload.type === "assistant.revision" || payload.type === "tool.revision"
      ? record.events.filter(
          (candidate) =>
            candidate.payload.type !== payload.type || candidate.payload.itemId !== payload.itemId,
        )
      : record.events;
  return { ...record, highWater: sequence, events: [...retained, event] };
}

function mergeNativeIdentity(
  current: ChatGptBrowserProviderV1NativeIdentity,
  incoming: ChatGptBrowserProviderV1NativeIdentity,
): ChatGptBrowserProviderV1NativeIdentity {
  for (const key of ["conversationId", "userMessageId", "providerTurnId"] as const) {
    if (
      current[key] !== undefined &&
      incoming[key] !== undefined &&
      current[key] !== incoming[key]
    ) {
      throw new Error(`provider_native_identity_changed:${key}`);
    }
  }
  return { ...current, ...incoming };
}

function terminalEvent(record: DurableOperation) {
  return record.events.findLast((event) => event.payload.type === "operation.terminal");
}

function finalEvent(record: DurableOperation) {
  return record.events.findLast((event) => event.payload.type === "assistant.final");
}

function drainedEvent(record: DurableOperation) {
  return record.events.findLast((event) => event.payload.type === "operation.drained");
}

async function syncObservation(
  wal: ProviderWal,
  record: DurableOperation,
  observation: ChatGptBrowserProviderBrowserObservation,
  settlement: ChatGptBrowserProviderSettlementPort,
): Promise<DurableOperation> {
  if (observation.providerOperationId !== record.providerOperationId)
    throw new Error("provider_operation_mismatch");
  // Drain seals the exact provider event log. Validate that a late observation does not claim a
  // conflicting browser identity, but never append or mutate semantic state after drain.
  if (record.state === "drained") {
    mergeNativeIdentity(record.nativeIdentity, observation.nativeIdentity);
    return record;
  }
  let next: DurableOperation = {
    ...record,
    nativeIdentity: mergeNativeIdentity(record.nativeIdentity, observation.nativeIdentity),
    state:
      stateRank[observation.state] > stateRank[record.state] ? observation.state : record.state,
  };

  if (observation.assistantRevisions !== undefined || observation.toolRevisions !== undefined) {
    const assistantRevisions = new Map(
      (next.assistantRevisions ?? []).map((value) => [value.itemId, value]),
    );
    const toolRevisions = new Map((next.toolRevisions ?? []).map((value) => [value.itemId, value]));
    const incoming = [
      ...(observation.assistantRevisions ?? []).map((revision) => ({
        kind: "assistant" as const,
        revision,
      })),
      ...(observation.toolRevisions ?? []).map((revision) => ({
        kind: "tool" as const,
        revision,
      })),
    ].sort((left, right) => left.revision.order - right.revision.order);
    for (const item of incoming) {
      if (item.kind === "assistant") {
        const previous = assistantRevisions.get(item.revision.itemId);
        if (previous?.text === item.revision.text) continue;
        if (!Number.isSafeInteger(item.revision.order) || item.revision.order < 0)
          throw new Error("provider_live_order_invalid");
        const ordinal = previous?.ordinal ?? item.revision.order;
        next = appendEvent(next, {
          type: "assistant.revision",
          itemId: item.revision.itemId,
          ordinal,
          text: item.revision.text,
        });
        assistantRevisions.set(item.revision.itemId, {
          itemId: item.revision.itemId,
          ordinal,
          text: item.revision.text,
        });
        continue;
      }
      const previous = toolRevisions.get(item.revision.itemId);
      if (
        previous?.toolName === item.revision.toolName &&
        previous?.title === item.revision.title &&
        previous?.output === item.revision.output &&
        previous?.status === item.revision.status
      ) {
        continue;
      }
      if (!Number.isSafeInteger(item.revision.order) || item.revision.order < 0)
        throw new Error("provider_live_order_invalid");
      const ordinal = previous?.ordinal ?? item.revision.order;
      next = appendEvent(next, {
        type: "tool.revision",
        itemId: item.revision.itemId,
        ordinal,
        ...(item.revision.toolName === undefined ? {} : { toolName: item.revision.toolName }),
        ...(item.revision.title === undefined ? {} : { title: item.revision.title }),
        ...(item.revision.output === undefined ? {} : { output: item.revision.output }),
        status: item.revision.status,
      });
      toolRevisions.set(item.revision.itemId, {
        itemId: item.revision.itemId,
        ordinal,
        ...(item.revision.toolName === undefined ? {} : { toolName: item.revision.toolName }),
        ...(item.revision.title === undefined ? {} : { title: item.revision.title }),
        ...(item.revision.output === undefined ? {} : { output: item.revision.output }),
        status: item.revision.status,
      });
    }
    const nextAssistantRevisions = [...assistantRevisions.values()];
    const nextToolRevisions = [...toolRevisions.values()];
    if (!liveRevisionBudgetValid(nextAssistantRevisions, nextToolRevisions))
      throw new Error("provider_live_revision_budget_exceeded");
    next = {
      ...next,
      assistantRevisions: nextAssistantRevisions,
      toolRevisions: nextToolRevisions,
    };
  }

  if (observation.finalText !== undefined) {
    if (next.finalText !== undefined && next.finalText !== observation.finalText)
      throw new Error("provider_final_changed");
    if (
      next.finalMessageId !== undefined &&
      observation.finalMessageId !== undefined &&
      next.finalMessageId !== observation.finalMessageId
    ) {
      throw new Error("provider_final_identity_changed");
    }
    next = {
      ...next,
      finalText: observation.finalText,
      ...((observation.finalMessageId ?? next.finalMessageId) === undefined
        ? {}
        : { finalMessageId: observation.finalMessageId ?? next.finalMessageId }),
    };
    if (!finalEvent(next)) {
      const finalOrdinal =
        next.finalMessageId === undefined
          ? undefined
          : ((next.assistantRevisions ?? []).find(
              (revision) => revision.itemId === next.finalMessageId,
            )?.ordinal ??
            Math.max(
              -1,
              ...(next.assistantRevisions ?? []).map((revision) => revision.ordinal),
              ...(next.toolRevisions ?? []).map((revision) => revision.ordinal),
            ) + 1);
      next = appendEvent(next, {
        type: "assistant.final",
        ...(next.finalMessageId === undefined ? {} : { itemId: next.finalMessageId }),
        ...(finalOrdinal === undefined ? {} : { ordinal: finalOrdinal }),
        contentHash: sha256(observation.finalText),
        contentLength: observation.finalText.length,
      });
    }
  }

  if (
    (observation.state === "terminal" || observation.state === "drained") &&
    !observation.terminalStatus
  ) {
    throw new Error("provider_terminal_missing");
  }
  if (observation.terminalStatus && !terminalEvent(next)) {
    next = appendEvent(next, { type: "operation.terminal", status: observation.terminalStatus });
  }

  if (observation.state === "drained" && !drainedEvent(next)) {
    const terminal = terminalEvent(next);
    if (!terminal || terminal.payload.type !== "operation.terminal")
      throw new Error("provider_drain_without_terminal");
    if (terminal.payload.status === "completed" && !finalEvent(next))
      throw new Error("provider_drain_without_final");
    await settlement.settleBeforeDrain({
      providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
      nativeIdentity: next.nativeIdentity,
      terminalStatus: terminal.payload.status,
    });
    next = appendEvent(next, { type: "operation.drained", terminalSequence: terminal.sequence });
    next = { ...next, state: "drained" };
  }

  await wal.write(next);
  return next;
}

async function sealTerminalAfterBrowserOwnershipLoss(
  wal: ProviderWal,
  record: DurableOperation,
  settlement: ChatGptBrowserProviderSettlementPort,
): Promise<DurableOperation> {
  if (record.state !== "terminal" || drainedEvent(record)) return record;
  const terminal = terminalEvent(record);
  if (!terminal || terminal.payload.type !== "operation.terminal") {
    throw providerFailure(
      "invalid_state",
      "Durable provider state is terminal without an operation.terminal event.",
    );
  }
  if (terminal.payload.status === "completed" && !finalEvent(record)) {
    throw providerFailure(
      "invalid_state",
      "Completed browser operation lost exact browser ownership before final content was durable.",
    );
  }

  // A recovered browser session that no longer owns an already-durable terminal operation cannot
  // append any further exact browser observations for it. Seal from T3's durable provider WAL
  // instead of waiting forever for a browser drain commit that can no longer occur. Preserve the
  // same T3-owned settlement fence used by an ordinary browser-driven drain.
  await settlement.settleBeforeDrain({
    providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
    nativeIdentity: record.nativeIdentity,
    terminalStatus: terminal.payload.status,
  });
  const next = {
    ...appendEvent(record, {
      type: "operation.drained" as const,
      terminalSequence: terminal.sequence,
    }),
    state: "drained" as const,
  };
  await wal.write(next);
  return next;
}

function snapshot(record: DurableOperation): ChatGptBrowserProviderV1OperationSnapshot {
  const highWater = ChatGptBrowserProviderV1EventSequence.make(record.highWater);
  const terminal = terminalEvent(record);
  const drained = drainedEvent(record);
  if (
    drained?.payload.type === "operation.drained" &&
    terminal?.payload.type === "operation.terminal"
  ) {
    return {
      providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
      providerSessionId:
        record.providerSessionId as ChatGptBrowserProviderV1OperationSnapshot["providerSessionId"],
      nativeIdentity: record.nativeIdentity,
      highWater,
      state: "drained",
      terminalStatus: terminal.payload.status,
      terminalSequence: terminal.sequence,
      drainedThrough: drained.sequence,
      ...(terminal.payload.error ? { error: terminal.payload.error } : {}),
    };
  }
  if (terminal?.payload.type === "operation.terminal") {
    return {
      providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
      providerSessionId:
        record.providerSessionId as ChatGptBrowserProviderV1OperationSnapshot["providerSessionId"],
      nativeIdentity: record.nativeIdentity,
      highWater,
      state: "terminal",
      terminalStatus: terminal.payload.status,
      terminalSequence: terminal.sequence,
      ...(terminal.payload.error ? { error: terminal.payload.error } : {}),
    };
  }
  return {
    providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
    providerSessionId:
      record.providerSessionId as ChatGptBrowserProviderV1OperationSnapshot["providerSessionId"],
    nativeIdentity: record.nativeIdentity,
    highWater,
    state: record.state === "drained" || record.state === "terminal" ? "running" : record.state,
  };
}

function finalChunk(record: DurableOperation, offset: number, limit: number) {
  const text = record.finalText;
  if (text === undefined || !finalEvent(record))
    throw providerFailure("invalid_state", "Final content is not complete yet.", true);
  if (offset < 0 || offset > text.length)
    throw providerFailure("invalid_state", "Final content offset is outside the result.");
  if (offset > 0 && offset < text.length) {
    const current = text.charCodeAt(offset);
    const previous = text.charCodeAt(offset - 1);
    if (current >= 0xdc00 && current <= 0xdfff && previous >= 0xd800 && previous <= 0xdbff) {
      throw providerFailure(
        "invalid_state",
        "Final content offset splits a UTF-16 surrogate pair.",
      );
    }
  }
  let end = Math.min(
    text.length,
    offset + Math.min(limit, CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16),
  );
  if (end > offset && end < text.length) {
    const previous = text.charCodeAt(end - 1);
    const current = text.charCodeAt(end);
    if (previous >= 0xd800 && previous <= 0xdbff && current >= 0xdc00 && current <= 0xdfff)
      end -= 1;
  }
  return {
    type: "assistant.final_chunk" as const,
    providerOperationId: record.providerOperationId as ChatGptBrowserProviderOperationId,
    offset,
    text: text.slice(offset, end),
    totalLength: text.length,
    contentHash: sha256(text),
    complete: end === text.length,
  };
}

function interruptible<A>(
  operation: string,
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, ChatGptBrowserProviderV1Error> {
  return Effect.callback<A, ChatGptBrowserProviderV1Error>((resume) => {
    const controller = new AbortController();
    void run(controller.signal).then(
      (value) => resume(Effect.succeed(value)),
      (cause) =>
        resume(
          Effect.fail(
            isProviderFailure(cause)
              ? cause
              : providerFailure(
                  "browser_unavailable",
                  `${operation} failed${cause instanceof Error ? `: ${cause.message}` : "."}`,
                  true,
                ),
          ),
        ),
    );
    return Effect.sync(() => controller.abort(new Error(`${operation} interrupted`)));
  });
}

export interface DurableChatGptBrowserRuntime {
  readonly transport: ChatGptBrowserProviderV1Transport & ChatGptBrowserS8FeatureTransport;
  readonly acceptObservation: (
    observation: ChatGptBrowserProviderBrowserObservation,
  ) => Promise<void>;
}

export function makeDurableChatGptBrowserRuntime(input: {
  readonly stateDirectory: string;
  readonly browser: ChatGptBrowserProviderBrowserSession;
  readonly settlement: ChatGptBrowserProviderSettlementPort;
}): DurableChatGptBrowserRuntime {
  const wal = new ProviderWal(input.stateDirectory);
  const { browser, settlement } = input;
  const serial = new OperationSerial();

  const priorConversation = async (
    providerSessionId: string,
    providerOperationId: string,
  ): Promise<string | undefined> => {
    const conversations = new Set(
      (await wal.all())
        .filter(
          (record) =>
            record.providerSessionId === providerSessionId &&
            record.providerOperationId !== providerOperationId &&
            record.nativeIdentity.conversationId,
        )
        .map((record) => record.nativeIdentity.conversationId!),
    );
    if (conversations.size > 1) {
      throw providerFailure(
        "invalid_state",
        "Provider session maps to multiple ChatGPT conversations.",
      );
    }
    return conversations.values().next().value;
  };

  const loadAndSync = async (
    providerOperationId: ChatGptBrowserProviderOperationId,
    signal: AbortSignal,
  ): Promise<DurableOperation> => {
    const observed = await browser.queryExact(providerOperationId, signal);
    return serial.run(providerOperationId, async () => {
      const record = await wal.read(providerOperationId);
      if (!record) {
        if (observed) {
          throw providerFailure(
            "invalid_state",
            "Browser still owns the exact operation but its durable provider WAL is missing.",
          );
        }
        throw providerFailure("operation_unknown", "Provider operation is unknown.");
      }
      return observed
        ? syncObservation(wal, record, observed, settlement)
        : sealTerminalAfterBrowserOwnershipLoss(wal, record, settlement);
    });
  };

  const waitForObservedChange = async (
    providerOperationId: ChatGptBrowserProviderOperationId,
    current: DurableOperation,
    signal: AbortSignal,
  ): Promise<void> => {
    const controller = new AbortController();
    const abort = () => controller.abort(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    const waiting = browser.waitForChange(providerOperationId, controller.signal);
    try {
      // Subscribe first, then close the read/subscribe race with one exact reread. A browser update
      // that landed after loadAndSync but before waitForChange must not strand replay indefinitely.
      const observed = await browser.queryExact(providerOperationId, signal);
      if (observed) {
        const terminal = terminalEvent(current);
        const terminalStatus =
          terminal?.payload.type === "operation.terminal" ? terminal.payload.status : undefined;
        const changed =
          observed.state !== current.state ||
          observed.terminalStatus !== terminalStatus ||
          observed.finalText !== current.finalText ||
          observed.finalMessageId !== current.finalMessageId ||
          JSON.stringify(observed.assistantRevisions ?? []) !==
            JSON.stringify(current.assistantRevisions ?? []) ||
          JSON.stringify(observed.toolRevisions ?? []) !==
            JSON.stringify(current.toolRevisions ?? []) ||
          JSON.stringify(observed.nativeIdentity) !== JSON.stringify(current.nativeIdentity);
        if (changed) {
          controller.abort(new Error("provider observation already changed"));
          await waiting.catch(() => undefined);
          return;
        }
      }
      await waiting;
    } finally {
      signal.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  const transport: ChatGptBrowserProviderV1Transport & ChatGptBrowserS8FeatureTransport = {
    identity: Effect.succeed(browser.identity),
    send: (request) =>
      interruptible("operation.send", async (signal) =>
        serial.run(request.providerOperationId, async () => {
          await wal.init();
          let record = await wal.read(request.providerOperationId);
          if (record) {
            if (
              record.providerSessionId !== request.providerSessionId ||
              record.text !== request.text
            ) {
              throw providerFailure(
                "operation_conflict",
                "Provider operation id belongs to different input.",
              );
            }
            const observed = await browser.queryExact(request.providerOperationId, signal);
            if (observed) {
              record = await syncObservation(wal, record, observed, settlement);
              // A broker process restart can recover exact browser ownership from the extension while
              // losing only its volatile prompt copy. Re-stage the same immutable operation payload;
              // sendExact is the broker staging primitive and never clicks Send by itself.
              if (record.state === "claimed") {
                const conversationId =
                  record.nativeIdentity.conversationId ??
                  (await priorConversation(request.providerSessionId, request.providerOperationId));
                record = await syncObservation(
                  wal,
                  record,
                  await browser.sendExact(
                    request,
                    signal,
                    conversationId ? { conversationId } : undefined,
                  ),
                  settlement,
                );
              }
            } else if (record.dispatchState === "prepared") {
              record = { ...record, dispatchState: "dispatched" };
              await wal.write(record);
              const conversationId =
                record.nativeIdentity.conversationId ??
                (await priorConversation(request.providerSessionId, request.providerOperationId));
              record = await syncObservation(
                wal,
                record,
                await browser.sendExact(
                  request,
                  signal,
                  conversationId ? { conversationId } : undefined,
                ),
                settlement,
              );
            } else {
              throw providerFailure(
                "invalid_state",
                "Exact provider send is dispatched but browser ownership is ambiguous.",
                true,
              );
            }
          } else {
            const observed = await browser.queryExact(request.providerOperationId, signal);
            if (observed) {
              throw providerFailure(
                "invalid_state",
                "Browser already owns the exact operation but its durable provider WAL is missing.",
              );
            }
            let active = (await wal.all()).find(
              (candidate) =>
                candidate.providerSessionId === request.providerSessionId &&
                !terminalStates.has(candidate.state),
            );
            if (active) {
              // Browser restart recovery can finish an older exact operation before the server
              // WAL has had another reason to query it. Reconcile that one durable owner before
              // enforcing the provider-session concurrency fence. Missing/ambiguous/nonterminal
              // browser truth still fails closed; only an exact terminal observation releases it.
              const observedActive = await browser.queryExact(
                active.providerOperationId as ChatGptBrowserProviderOperationId,
                signal,
              );
              if (observedActive) {
                active = await syncObservation(wal, active, observedActive, settlement);
                // A previous T3 attempt can fail after provider-v1 durably claims the operation but
                // before the browser authorizes the one-time Send. Exact browser truth can prove that
                // this owner is still pre-send. Retire only that explicitly-never-authorized claim;
                // authorized or unknown claims remain ambiguous and continue to fence later sends.
                if (
                  active.state === "claimed" &&
                  observedActive.state === "claimed" &&
                  observedActive.sendAuthorized === false &&
                  observedActive.nativeIdentity.userMessageId === undefined
                ) {
                  active = await syncObservation(
                    wal,
                    active,
                    await browser.cancelExact(
                      active.providerOperationId as ChatGptBrowserProviderOperationId,
                      signal,
                    ),
                    settlement,
                  );
                }
              }
            }
            if (active && !terminalStates.has(active.state))
              throw providerFailure(
                "operation_conflict",
                "Another operation is already active for this provider session.",
              );
            record = {
              schemaVersion: 1,
              providerOperationId: request.providerOperationId,
              providerSessionId: request.providerSessionId,
              text: request.text,
              textHash: sha256(request.text),
              dispatchState: "prepared",
              state: "claimed",
              nativeIdentity: {},
              highWater: 0,
              events: [],
            };
            await wal.write(record);
            record = { ...record, dispatchState: "dispatched" };
            await wal.write(record);
            const conversationId = await priorConversation(
              request.providerSessionId,
              request.providerOperationId,
            );
            record = await syncObservation(
              wal,
              record,
              await browser.sendExact(
                request,
                signal,
                conversationId ? { conversationId } : undefined,
              ),
              settlement,
            );
          }
          const current = snapshot(record);
          return {
            type: "operation.send_receipt",
            providerOperationId: current.providerOperationId,
            providerSessionId: current.providerSessionId,
            state: current.state === "unknown" ? "claimed" : current.state,
            nativeIdentity: current.nativeIdentity,
            highWater: current.highWater,
          };
        }),
      ),
    queryOperation: (request) =>
      interruptible("operation.query", async (signal) =>
        snapshot(await loadAndSync(request.providerOperationId, signal)),
      ),
    replay: (request) =>
      interruptible("events.replay", async (signal) => {
        for (;;) {
          const record = await loadAndSync(request.providerOperationId, signal);
          const highWater = record.highWater;
          if (request.after > highWater)
            throw providerFailure(
              "invalid_state",
              "Replay cursor is ahead of provider high-water.",
            );
          const events = record.events.filter((event) => event.sequence > request.after);
          if (events.length > 0 || terminalStates.has(record.state)) {
            return {
              providerOperationId: request.providerOperationId,
              events,
              highWater: ChatGptBrowserProviderV1EventSequence.make(highWater),
            };
          }
          await waitForObservedChange(request.providerOperationId, record, signal);
        }
      }),
    cancel: (request) =>
      interruptible("operation.cancel", async (signal) =>
        serial.run(request.providerOperationId, async () => {
          let record = await wal.read(request.providerOperationId);
          if (!record) {
            const observed = await browser.queryExact(request.providerOperationId, signal);
            if (observed) {
              throw providerFailure(
                "invalid_state",
                "Browser still owns the exact operation but its durable provider WAL is missing.",
              );
            }
            throw providerFailure("operation_unknown", "Provider operation is unknown.");
          }
          if (record.state === "terminal" || record.state === "drained") return snapshot(record);
          if (record.dispatchState === "prepared") {
            record = appendEvent(record, { type: "operation.terminal", status: "cancelled" });
            const terminal = terminalEvent(record)!;
            record = appendEvent(record, {
              type: "operation.drained",
              terminalSequence: terminal.sequence,
            });
            record = { ...record, state: "drained" };
            await wal.write(record);
            return snapshot(record);
          }
          record = await syncObservation(
            wal,
            record,
            await browser.cancelExact(request.providerOperationId, signal),
            settlement,
          );
          return snapshot(record);
        }),
      ),
    readFinalContent: (request) =>
      interruptible("assistant.read_final", async (signal) => {
        const record = await loadAndSync(request.providerOperationId, signal);
        return finalChunk(record, request.offset, request.limit);
      }),
    feature: (message) =>
      interruptible("feature.message", async () => {
        if (message.feature !== CHATGPT_BROWSER_S8_FEATURE) {
          throw providerFailure("invalid_state", "Unsupported ChatGPT Browser feature message.");
        }
        if (!browser.feature) {
          throw providerFailure(
            "invalid_state",
            "ChatGPT Browser feature transport is unavailable.",
          );
        }
        return await browser.feature(message);
      }),
  };

  const acceptObservation = (observation: ChatGptBrowserProviderBrowserObservation) =>
    serial.run(observation.providerOperationId, async () => {
      const record = await wal.read(observation.providerOperationId);
      if (!record) throw new Error("provider_wal_missing_for_browser_observation");
      await syncObservation(wal, record, observation, settlement);
    });

  return { transport, acceptObservation };
}

export function makeDurableChatGptBrowserTransport(input: {
  readonly stateDirectory: string;
  readonly browser: ChatGptBrowserProviderBrowserSession;
  readonly settlement: ChatGptBrowserProviderSettlementPort;
}): ChatGptBrowserProviderV1Transport & ChatGptBrowserS8FeatureTransport {
  return makeDurableChatGptBrowserRuntime(input).transport;
}

/**
 * In-process provider host used by T3. It owns the single durable provider-v1 operation WAL and
 * delegates only browser execution, secure storage, managed assets and T3 effect settlement to
 * injected ports. No CoS desktop process, project queue, Goal/Loop or product scheduler is present.
 */
export function makeScopedChatGptBrowserHost(
  options: ScopedChatGptBrowserHostOptions,
): ChatGptBrowserHostPort {
  return {
    readiness: Effect.tryPromise({
      try: async () => (await options.assets.prepare()).hostIdentity,
      catch: (cause) => hostFailure("readiness", cause),
    }),
    open: Effect.tryPromise({
      try: async () => {
        const assets = await options.assets.prepare();
        const browser = await options.browser.open({ assets, secrets: options.secrets });
        return {
          identity: assets.hostIdentity,
          transport: makeDurableChatGptBrowserTransport({
            stateDirectory: assets.stateDirectory,
            browser,
            settlement: options.settlement,
          }),
          close: Effect.tryPromise({
            try: () => browser.close(),
            catch: (cause) => hostFailure("close", cause),
          }),
        };
      },
      catch: (cause) => hostFailure("open", cause),
    }),
  };
}
