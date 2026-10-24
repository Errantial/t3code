// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off -- The native loopback broker runs at the browser/process boundary outside an Effect runtime.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- The embedded provider owns one private loopback HTTP listener for its managed extension.
import * as NodeHttp from "node:http";

import {
  CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL,
  CHATGPT_BROWSER_PROVIDER_V1_VERSION,
  ChatGptBrowserProviderV1ProtocolIdentity,
  type ChatGptBrowserProviderOperationId,
  type ChatGptBrowserProviderV1NativeIdentity,
  type ChatGptBrowserProviderV1SendRequest,
  type ChatGptBrowserProviderV1TerminalStatus,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Schema from "effect/Schema";

import type {
  ChatGptBrowserProviderBrowserObservation,
  ChatGptBrowserProviderBrowserSession,
  ChatGptBrowserProviderSecretsPort,
} from "./runtime.ts";

export const CHATGPT_BROWSER_NATIVE_PROVIDER_PORTS = [
  8765, 8766, 8767, 8768, 8769, 18_765, 18_766, 18_767, 18_768, 18_769, 38_765, 38_766, 38_767,
  38_768, 38_769,
] as const;

const MAX_BODY_BYTES = 5 * 1024 * 1024;
const TOKEN_SECRET = "provider-v1-browser-token";
const INSTANCE_SECRET = "provider-v1-provider-instance-id";
const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

type BrowserState = ChatGptBrowserProviderBrowserObservation["state"];

interface BrowserPeer {
  readonly browserInstanceId: string;
  readonly extensionVersion: string;
  readonly extensionBuildId: string;
}

interface OperationRecord {
  readonly providerOperationId: ChatGptBrowserProviderOperationId;
  providerSessionId?: string;
  text?: string;
  readonly commandId: string;
  readonly stopCommandId: string;
  state: BrowserState;
  nativeIdentity: ChatGptBrowserProviderV1NativeIdentity;
  terminalStatus?: ChatGptBrowserProviderV1TerminalStatus;
  finalText?: string;
  owner?: string;
  authorized: boolean;
  cancelRequested: boolean;
  stopAck?: "sent" | "failed";
  version: number;
}

interface ExtensionOperationSummary {
  readonly providerOperationId: string;
  readonly commandId?: string;
  readonly state?: BrowserState;
  readonly conversationId?: string;
  readonly userMessageId?: string;
  readonly providerTurnId?: string;
  readonly terminalStatus?: ChatGptBrowserProviderV1TerminalStatus;
  readonly authorized?: boolean;
}

interface NativeBrokerOptions {
  readonly secrets: ChatGptBrowserProviderSecretsPort;
  readonly ports?: ReadonlyArray<number>;
  readonly readyTimeoutMs?: number;
  readonly buildMismatchGraceMs?: number;
  readonly expectedExtensionBuildId?: string;
  readonly persistObservation?: (
    observation: ChatGptBrowserProviderBrowserObservation,
  ) => Promise<void>;
}

export interface NativeChatGptBrowserBroker {
  readonly port: number;
  readonly waitForSession: (signal?: AbortSignal) => Promise<ChatGptBrowserProviderBrowserSession>;
  readonly close: () => Promise<void>;
}

const stateRank: Record<BrowserState, number> = {
  claimed: 0,
  sent: 1,
  running: 2,
  terminal: 3,
  drained: 4,
};

const sha256 = (value: string): Buffer => createHash("sha256").update(value, "utf8").digest();

function deterministicUuid(namespace: string, value: string): string {
  const bytes = Uint8Array.from(sha256(`${namespace}\0${value}`).subarray(0, 16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x50;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Buffer.from(bytes).toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function nonEmptyHeader(value: string | string[] | undefined, maxLength = 256): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function peerFromHeaders(headers: NodeHttp.IncomingHttpHeaders): BrowserPeer | null {
  if (headers["x-provider-protocol"] !== CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL) return null;
  if (headers["x-provider-version"] !== String(CHATGPT_BROWSER_PROVIDER_V1_VERSION)) return null;
  const browserInstanceId = nonEmptyHeader(headers["x-provider-browser"]);
  const extensionVersion = nonEmptyHeader(headers["x-provider-extension-version"], 64);
  const extensionBuildId = nonEmptyHeader(headers["x-provider-extension-build"], 128);
  return browserInstanceId && extensionVersion && extensionBuildId
    ? { browserInstanceId, extensionVersion, extensionBuildId }
    : null;
}

function originAllowed(value: string | undefined): boolean {
  return value === undefined || value.startsWith("chrome-extension://");
}

function json(
  response: NodeHttp.ServerResponse,
  status: number,
  body: unknown,
  origin?: string,
): void {
  const encoded = JSON.stringify(body);
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    ...(origin && originAllowed(origin) ? { "access-control-allow-origin": origin } : {}),
  });
  response.end(encoded);
}

async function readJson(request: NodeHttp.IncomingMessage): Promise<unknown> {
  let bytes = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.length;
    if (bytes > MAX_BODY_BYTES) throw new Error("body_too_large");
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function cleanString(value: unknown, maxLength = 4096): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength
    ? value
    : undefined;
}

function terminalStatus(outcome: unknown): ChatGptBrowserProviderV1TerminalStatus {
  if (outcome === "completed") return "completed";
  if (outcome === "stopped" || outcome === "interrupted" || outcome === "cancelled")
    return "cancelled";
  return "failed";
}

function observation(record: OperationRecord): ChatGptBrowserProviderBrowserObservation {
  return {
    providerOperationId: record.providerOperationId,
    state: record.state,
    nativeIdentity: record.nativeIdentity,
    ...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}),
    ...(record.finalText !== undefined ? { finalText: record.finalText } : {}),
  };
}

function extensionSummary(record: OperationRecord): ExtensionOperationSummary {
  return {
    providerOperationId: record.providerOperationId,
    commandId: record.commandId,
    state: record.state,
    ...(record.nativeIdentity.conversationId
      ? { conversationId: record.nativeIdentity.conversationId }
      : {}),
    ...(record.nativeIdentity.userMessageId
      ? { userMessageId: record.nativeIdentity.userMessageId }
      : {}),
    ...(record.nativeIdentity.providerTurnId
      ? { providerTurnId: record.nativeIdentity.providerTurnId }
      : {}),
    ...(record.terminalStatus ? { terminalStatus: record.terminalStatus } : {}),
    ...(record.authorized ? { authorized: true } : {}),
  };
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(done, ms);
    function done() {
      signal?.removeEventListener("abort", aborted);
      resolve();
    }
    function aborted() {
      clearTimeout(timer);
      reject(signal?.reason);
    }
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

async function listen(server: NodeHttp.Server, ports: ReadonlyArray<number>): Promise<number> {
  for (const port of ports) {
    const outcome = await new Promise<"listening" | "busy">((resolve, reject) => {
      const onError = (cause: NodeJS.ErrnoException) => {
        server.removeListener("listening", onListening);
        if (cause.code === "EADDRINUSE" || cause.code === "EACCES") resolve("busy");
        else reject(cause);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        resolve("listening");
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(port, "127.0.0.1");
    });
    if (outcome === "listening") {
      const address = server.address();
      return typeof address === "object" && address !== null ? address.port : port;
    }
  }
  throw new Error("provider_v1_no_loopback_port");
}

export async function startNativeChatGptBrowserBroker(
  options: NativeBrokerOptions,
): Promise<NativeChatGptBrowserBroker> {
  const providerInstanceBytes = await options.secrets.read(INSTANCE_SECRET);
  let providerInstanceId = providerInstanceBytes ? textDecoder.decode(providerInstanceBytes) : "";
  if (!providerInstanceId || providerInstanceId.length > 200) {
    providerInstanceId = `t3-native-${randomUUID()}`;
    await options.secrets.write(INSTANCE_SECRET, textEncoder.encode(providerInstanceId));
  }
  let credentialBytes = await options.secrets.read(TOKEN_SECRET);
  let credential = credentialBytes ? textDecoder.decode(credentialBytes) : null;
  if (credential && !/^[a-f0-9]{64}$/i.test(credential)) credential = null;

  const operations = new Map<string, OperationRecord>();
  const operationWaiters = new Map<string, Set<() => void>>();
  const globalWaiters = new Set<() => void>();
  let brokerGeneration = 0;
  let peer: BrowserPeer | null = null;
  let closed = false;
  let readyResolve: ((session: ChatGptBrowserProviderBrowserSession) => void) | null = null;
  let readyReject: ((cause: unknown) => void) | null = null;
  const readinessDiagnostics = {
    requests: 0,
    protocolMismatch: 0,
    buildMismatch: 0,
    hello: 0,
    pair: 0,
    authRejected: 0,
    status: 0,
  };
  let buildMismatchTimer: ReturnType<typeof setTimeout> | null = null;
  const ready = new Promise<ChatGptBrowserProviderBrowserSession>((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  // Some lifecycle probes intentionally never pair a browser (for example protocol/auth
  // rejection). Keep the same rejection for waitForSession callers without letting an unused
  // readiness promise surface as an unhandled process rejection during teardown.
  void ready.catch(() => undefined);

  const wake = (providerOperationId?: string) => {
    if (providerOperationId) {
      brokerGeneration += 1;
      for (const release of operationWaiters.get(providerOperationId) ?? []) release();
      operationWaiters.delete(providerOperationId);
    }
    for (const release of globalWaiters) release();
    globalWaiters.clear();
  };

  const touch = (record: OperationRecord) => {
    record.version += 1;
    wake(record.providerOperationId);
  };

  const persistObservation = async (record: OperationRecord): Promise<void> => {
    if (!options.persistObservation) throw new Error("provider_observation_sink_unavailable");
    await options.persistObservation(observation(record));
  };

  const waitForGlobalChange = (milliseconds: number, signal?: AbortSignal) =>
    new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        globalWaiters.delete(finish);
        signal?.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        globalWaiters.delete(finish);
        reject(signal?.reason);
      };
      const timer = setTimeout(finish, milliseconds);
      signal?.addEventListener("abort", aborted, { once: true });
      globalWaiters.add(finish);
    });

  const getOrCreate = (providerOperationId: string): OperationRecord => {
    const existing = operations.get(providerOperationId);
    if (existing) return existing;
    const record: OperationRecord = {
      providerOperationId: providerOperationId as ChatGptBrowserProviderOperationId,
      commandId: deterministicUuid("input", providerOperationId),
      stopCommandId: deterministicUuid("stop", providerOperationId),
      state: "claimed",
      nativeIdentity: {},
      authorized: false,
      cancelRequested: false,
      version: 0,
    };
    operations.set(providerOperationId, record);
    wake(providerOperationId);
    return record;
  };

  const reconcileSummary = (summary: ExtensionOperationSummary) => {
    const providerOperationId = cleanString(summary.providerOperationId, 512);
    if (!providerOperationId) return;
    const record = getOrCreate(providerOperationId);
    if (summary.commandId && summary.commandId !== record.commandId) return;
    let changed = false;
    if (summary.state && stateRank[summary.state] > stateRank[record.state]) {
      record.state = summary.state;
      changed = true;
    }
    const incomingIdentity: ChatGptBrowserProviderV1NativeIdentity = {
      ...(summary.conversationId ? { conversationId: summary.conversationId } : {}),
      ...(summary.userMessageId ? { userMessageId: summary.userMessageId } : {}),
      ...(summary.providerTurnId ? { providerTurnId: summary.providerTurnId } : {}),
    };
    for (const key of ["conversationId", "userMessageId", "providerTurnId"] as const) {
      if (
        record.nativeIdentity[key] !== undefined &&
        incomingIdentity[key] !== undefined &&
        record.nativeIdentity[key] !== incomingIdentity[key]
      ) {
        throw new Error(`provider_operation_identity_conflict:${key}`);
      }
    }
    const nextIdentity = { ...record.nativeIdentity, ...incomingIdentity };
    if (JSON.stringify(nextIdentity) !== JSON.stringify(record.nativeIdentity)) {
      record.nativeIdentity = nextIdentity;
      changed = true;
    }
    if (summary.terminalStatus && !record.terminalStatus) {
      record.terminalStatus = summary.terminalStatus;
      changed = true;
    }
    if (summary.authorized === true && !record.authorized) {
      record.authorized = true;
      changed = true;
    }
    if (changed) touch(record);
  };

  const waitForOperationChange = (
    providerOperationId: string,
    version: number,
    signal: AbortSignal,
  ) =>
    new Promise<void>((resolve, reject) => {
      if (signal.aborted) return reject(signal.reason);
      if (operations.get(providerOperationId)?.version !== version) return resolve();
      const done = () => {
        signal.removeEventListener("abort", aborted);
        resolve();
      };
      const aborted = () => {
        operationWaiters.get(providerOperationId)?.delete(done);
        reject(signal.reason);
      };
      signal.addEventListener("abort", aborted, { once: true });
      const waiters = operationWaiters.get(providerOperationId) ?? new Set<() => void>();
      waiters.add(done);
      operationWaiters.set(providerOperationId, waiters);
    });

  const identity = (browserPeer: BrowserPeer) =>
    Schema.decodeSync(ChatGptBrowserProviderV1ProtocolIdentity)({
      protocol: CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL,
      version: CHATGPT_BROWSER_PROVIDER_V1_VERSION,
      browserInstanceId: browserPeer.browserInstanceId,
      providerInstanceId,
      extensionVersion: browserPeer.extensionVersion,
      extensionBuildId: browserPeer.extensionBuildId,
      ready: true,
      features: ["provider-v1-native-browser-v1"],
    });

  const browserSession = (browserPeer: BrowserPeer): ChatGptBrowserProviderBrowserSession => ({
    identity: identity(browserPeer),
    sendExact: async (request: ChatGptBrowserProviderV1SendRequest, _signal, context) => {
      const record = getOrCreate(request.providerOperationId);
      if (record.providerSessionId && record.providerSessionId !== request.providerSessionId) {
        throw new Error("provider_operation_session_conflict");
      }
      if (record.text !== undefined && record.text !== request.text)
        throw new Error("provider_operation_text_conflict");
      record.providerSessionId = request.providerSessionId;
      record.text = request.text;
      if (context?.conversationId) {
        if (
          record.nativeIdentity.conversationId &&
          record.nativeIdentity.conversationId !== context.conversationId
        ) {
          throw new Error("provider_operation_conversation_conflict");
        }
        record.nativeIdentity = {
          ...record.nativeIdentity,
          conversationId: context.conversationId,
        };
      }
      // Older/in-flight extension state could report a completed operation as drained before the
      // broker had received its final assistant body. That state is not durable-provider complete:
      // regress this exact resumed operation to running so the status response reactivates the
      // browser observer under the existing sent/running recovery rule and lets it replay the
      // missing final before a new terminal/drain is accepted. Valid terminal rows stay closed.
      if (
        record.state === "drained" &&
        record.terminalStatus === "completed" &&
        record.finalText === undefined
      ) {
        record.state = "running";
      }
      touch(record);
      return observation(record);
    },
    queryExact: async (providerOperationId, signal) => {
      let record = operations.get(providerOperationId);
      if (!record && !signal.aborted) {
        await waitForGlobalChange(1_500, signal);
        record = operations.get(providerOperationId);
      }
      if (
        record?.state === "drained" &&
        record.terminalStatus === "completed" &&
        record.finalText === undefined
      ) {
        record.state = "running";
        touch(record);
      }
      return record ? observation(record) : null;
    },
    cancelExact: async (providerOperationId, signal) => {
      const record = operations.get(providerOperationId);
      if (!record) throw new Error("provider_operation_unknown");
      if (record.state === "terminal" || record.state === "drained") return observation(record);
      if (!record.nativeIdentity.userMessageId) {
        if (record.authorized) {
          throw new Error("native_send_receipt_ambiguous");
        }
        record.terminalStatus = "cancelled";
        record.state = "drained";
        touch(record);
        return observation(record);
      }
      record.cancelRequested = true;
      delete record.stopAck;
      const version = record.version;
      touch(record);
      if (!record.nativeIdentity.providerTurnId || !record.nativeIdentity.conversationId)
        return observation(record);
      await Promise.race([
        waitForOperationChange(providerOperationId, version + 1, signal),
        abortableDelay(5_000, signal),
      ]);
      if (record.stopAck === "failed") throw new Error("native_stop_failed");
      return observation(record);
    },
    waitForChange: (providerOperationId, signal) => {
      const record = operations.get(providerOperationId);
      if (!record) return Promise.reject(new Error("provider_operation_unknown"));
      return waitForOperationChange(providerOperationId, record.version, signal);
    },
    close: async () => {
      await closeServer();
    },
  });

  const handleStatus = async (body: Record<string, unknown>, onReconciled?: () => void) => {
    const after =
      Number.isSafeInteger(body.after) && Number(body.after) >= 0 ? Number(body.after) : -1;
    for (const value of Array.isArray(body.operations) ? body.operations : []) {
      const summary = asRecord(value);
      if (!summary) continue;
      reconcileSummary(summary as unknown as ExtensionOperationSummary);
    }
    // A browser restart rehydrates exact operation ownership through the first status body. Host
    // readiness must not race ahead of that reconciliation: a dispatched durable WAL queried in
    // the gap would correctly fail closed as ambiguous even though the extension still owns it.
    // Signal readiness here, before the optional long-poll wait, so a cold browser with no pending
    // operations also becomes usable immediately rather than inheriting the 25-second poll bound.
    onReconciled?.();
    if (body.wait === true && after >= brokerGeneration && !closed) {
      await waitForGlobalChange(25_000);
    }
    const inputs = [...operations.values()]
      .filter(
        (record) => record.text !== undefined && record.state === "claimed" && !record.authorized,
      )
      .map((record) => ({
        id: record.commandId,
        providerOperationId: record.providerOperationId,
        conversationId: record.nativeIdentity.conversationId ?? null,
      }));
    const stopTurns = [...operations.values()]
      .filter(
        (record) =>
          record.cancelRequested &&
          record.state !== "terminal" &&
          record.state !== "drained" &&
          record.nativeIdentity.conversationId &&
          record.nativeIdentity.providerTurnId,
      )
      .map((record) => ({
        id: record.stopCommandId,
        providerOperationId: record.providerOperationId,
        conversationId: record.nativeIdentity.conversationId,
        turnId: record.nativeIdentity.providerTurnId,
        expiresAt: Date.now() + 30_000,
      }));
    return {
      ok: true,
      generation: brokerGeneration,
      inputs,
      stopTurns,
      operations: [...operations.values()].map(extensionSummary),
    };
  };

  const exactRecord = (body: Record<string, unknown>): OperationRecord | null => {
    const providerOperationId = cleanString(body.providerOperationId, 512);
    if (!providerOperationId) return null;
    return operations.get(providerOperationId) ?? null;
  };

  const handleInput = async (body: Record<string, unknown>) => {
    const record = exactRecord(body);
    if (!record || body.id !== record.commandId || !record.text)
      return { status: 409, body: { ok: false, error: "input_not_owned" } };
    if (record.state === "terminal" || record.state === "drained") {
      return { status: 409, body: { ok: false, error: "input_not_active" } };
    }
    const owner = cleanString(body.owner, 200);
    if (!owner) return { status: 400, body: { ok: false, error: "invalid_input_owner" } };
    if (body.fail === true) {
      if (record.owner && record.owner !== owner)
        return { status: 409, body: { ok: false, error: "input_not_owned" } };
      record.owner = owner;
      record.terminalStatus = "failed";
      record.state = "drained";
      touch(record);
      await persistObservation(record);
      return { status: 200, body: { ok: true, summary: extensionSummary(record) } };
    }
    if (body.authorize === true) {
      if (record.owner !== owner || record.state !== "claimed")
        return { status: 409, body: { ok: false, error: "input_not_owned" } };
      record.authorized = true;
      touch(record);
      return { status: 200, body: { ok: true, summary: extensionSummary(record) } };
    }
    if (body.ack === true) {
      if (record.owner !== owner || !record.authorized)
        return { status: 409, body: { ok: false, error: "input_not_authorized" } };
      const conversationId = cleanString(body.conversationId, 256);
      const userMessageId = cleanString(body.messageId, 256);
      if (!conversationId || !userMessageId)
        return { status: 400, body: { ok: false, error: "invalid_send_receipt" } };
      if (
        record.nativeIdentity.conversationId &&
        record.nativeIdentity.conversationId !== conversationId
      ) {
        return { status: 409, body: { ok: false, error: "conversation_identity_conflict" } };
      }
      if (
        record.nativeIdentity.userMessageId &&
        record.nativeIdentity.userMessageId !== userMessageId
      ) {
        return { status: 409, body: { ok: false, error: "user_message_identity_conflict" } };
      }
      record.nativeIdentity = { ...record.nativeIdentity, conversationId, userMessageId };
      if (stateRank[record.state] < stateRank.sent) record.state = "sent";
      touch(record);
      await persistObservation(record);
      return { status: 200, body: { ok: true, summary: extensionSummary(record) } };
    }
    if (record.authorized)
      return { status: 409, body: { ok: false, error: "input_send_ambiguous" } };
    record.owner = owner;
    touch(record);
    return {
      status: 200,
      body: {
        ok: true,
        input: { id: record.commandId, owner, text: record.text },
        summary: extensionSummary(record),
      },
    };
  };

  const matchingOperation = (
    conversationId: string | undefined,
    turnId?: string,
  ): OperationRecord | null => {
    const candidates = [...operations.values()].filter(
      (record) =>
        (!conversationId || record.nativeIdentity.conversationId === conversationId) &&
        (!turnId ||
          !record.nativeIdentity.providerTurnId ||
          record.nativeIdentity.providerTurnId === turnId) &&
        record.state !== "drained",
    );
    return candidates.length === 1 ? candidates[0]! : null;
  };

  const handleEvents = async (body: Record<string, unknown>) => {
    for (const value of Array.isArray(body.operations) ? body.operations : []) {
      const summary = asRecord(value);
      if (summary) reconcileSummary(summary as unknown as ExtensionOperationSummary);
    }
    const conversationId = cleanString(body.conversationId, 256);
    const entries = Array.isArray(body.entries) ? body.entries : [];
    const touched = new Set<OperationRecord>();
    for (const value of entries) {
      const envelope = asRecord(value);
      if (!envelope) continue;
      // The qualified recorder journals observations in an envelope carrying conversation/
      // agent custody alongside the actual event. The native background forwards those durable
      // queue rows unchanged. Accept the real recorder shape while retaining the flat event
      // form used by direct broker callers/tests.
      const entry = asRecord(envelope.event) ?? envelope;
      const kind = cleanString(entry.kind, 64);
      const turnId = cleanString(entry.turnId, 256);
      let record = turnId
        ? ([...operations.values()].find(
            (candidate) => candidate.nativeIdentity.providerTurnId === turnId,
          ) ?? null)
        : null;
      if (!record && kind === "user_message") {
        const messageId = cleanString(entry.messageId, 256);
        if (messageId)
          record =
            [...operations.values()].find(
              (candidate) => candidate.nativeIdentity.userMessageId === messageId,
            ) ?? null;
      }
      // Conversation identity alone is not enough to mutate an operation. An observer page can
      // republish settled history when it first mounts; those assistant finals belong to earlier
      // turns in the same conversation and commonly carry no local turn id. Treating the sole
      // non-drained operation in that conversation as their owner can freeze a historical final
      // into the new operation before its exact turn arrives. Require either the exact user
      // message receipt above or a concrete turn id that can be reconciled to this operation.
      record ??= turnId ? matchingOperation(conversationId, turnId) : null;
      if (!record) continue;
      if (kind === "turn_start" && turnId) {
        if (
          record.nativeIdentity.providerTurnId &&
          record.nativeIdentity.providerTurnId !== turnId
        ) {
          throw new Error("provider_operation_identity_conflict:providerTurnId");
        }
        if (!record.nativeIdentity.providerTurnId)
          record.nativeIdentity = { ...record.nativeIdentity, providerTurnId: turnId };
        if (stateRank[record.state] < stateRank.running) record.state = "running";
        touched.add(record);
        continue;
      }
      if (kind === "user_message") {
        const messageId = cleanString(entry.messageId, 256);
        if (
          messageId &&
          record.nativeIdentity.userMessageId &&
          record.nativeIdentity.userMessageId !== messageId
        ) {
          throw new Error("provider_operation_identity_conflict:userMessageId");
        }
        if (messageId && !record.nativeIdentity.userMessageId)
          record.nativeIdentity = { ...record.nativeIdentity, userMessageId: messageId };
        touched.add(record);
        continue;
      }
      if (
        kind === "assistant_message" &&
        (entry.final === true || entry.state === "final") &&
        (!turnId ||
          !record.nativeIdentity.providerTurnId ||
          turnId === record.nativeIdentity.providerTurnId)
      ) {
        const text = typeof entry.text === "string" ? entry.text : undefined;
        if (text !== undefined) record.finalText = text;
        touched.add(record);
        continue;
      }
      if (kind === "turn_end" && turnId && record.nativeIdentity.providerTurnId === turnId) {
        record.terminalStatus = terminalStatus(entry.outcome);
        record.state = "terminal";
        touched.add(record);
      }
    }
    for (const record of touched) touch(record);
    for (const record of touched) await persistObservation(record);
    return { ok: true, operations: [...touched].map(extensionSummary) };
  };

  const handleDrain = async (body: Record<string, unknown>) => {
    const record = exactRecord(body);
    const conversationId = cleanString(body.conversationId, 256);
    const turnId = cleanString(body.turnId, 256);
    const phase = body.phase === "probe" || body.phase === "commit" ? body.phase : null;
    if (
      !record ||
      !conversationId ||
      !turnId ||
      !phase ||
      record.nativeIdentity.conversationId !== conversationId ||
      record.nativeIdentity.providerTurnId !== turnId
    ) {
      return { status: 409, body: { ok: false, error: "provider_turn_mismatch" } };
    }
    if (record.state !== "terminal" && record.state !== "drained") {
      return {
        status: 409,
        body: { ok: false, error: "provider_turn_not_closing", retryable: true },
      };
    }
    if (record.terminalStatus === "completed" && record.finalText === undefined) {
      return {
        status: 409,
        body: { ok: false, error: "provider_final_not_observed", retryable: true },
      };
    }
    const drainToken = createHash("sha256")
      .update(`drain\0${record.providerOperationId}\0${turnId}`)
      .digest("hex")
      .slice(0, 32);
    if (phase === "probe")
      return { status: 200, body: { ok: true, applicable: true, drainToken, state: record.state } };
    if (body.drainToken !== drainToken)
      return { status: 409, body: { ok: false, error: "provider_turn_mismatch" } };
    if (record.state !== "drained") {
      record.state = "drained";
      touch(record);
    }
    await persistObservation(record);
    return {
      status: 200,
      body: {
        ok: true,
        applicable: true,
        drainToken,
        state: record.state,
        summary: extensionSummary(record),
      },
    };
  };

  const handleStopRedeem = (body: Record<string, unknown>) => {
    const record = exactRecord(body);
    if (
      !record ||
      body.id !== record.stopCommandId ||
      !record.cancelRequested ||
      body.conversationId !== record.nativeIdentity.conversationId
    ) {
      return { status: 409, body: { ok: false, error: "stop_not_owned" } };
    }
    return {
      status: 200,
      body: {
        ok: true,
        command: {
          id: record.stopCommandId,
          type: "stop",
          conversationId: record.nativeIdentity.conversationId,
          turnId: record.nativeIdentity.providerTurnId,
          userMessageId: record.nativeIdentity.userMessageId,
        },
      },
    };
  };

  const handleStopAck = (body: Record<string, unknown>) => {
    const record = exactRecord(body);
    if (
      !record ||
      body.id !== record.stopCommandId ||
      body.conversationId !== record.nativeIdentity.conversationId ||
      body.turnId !== record.nativeIdentity.providerTurnId
    ) {
      return { status: 409, body: { ok: false, error: "stop_not_owned" } };
    }
    record.stopAck = body.status === "sent" ? "sent" : "failed";
    touch(record);
    return {
      status: 200,
      body: { ok: record.stopAck === "sent", summary: extensionSummary(record) },
    };
  };

  let server: NodeHttp.Server;
  let session: ChatGptBrowserProviderBrowserSession | null = null;

  const authenticate = async (request: NodeHttp.IncomingMessage): Promise<boolean> => {
    if (!credential) return false;
    const header = request.headers.authorization;
    const candidate =
      typeof header === "string" && header.startsWith("Bearer ") ? header.slice(7) : "";
    if (!/^[a-f0-9]{64}$/i.test(candidate)) return false;
    const expected = Buffer.from(credential, "ascii");
    const actual = Buffer.from(candidate, "ascii");
    return expected.length === actual.length && timingSafeEqual(expected, actual);
  };

  const closeServer = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    if (buildMismatchTimer) {
      clearTimeout(buildMismatchTimer);
      buildMismatchTimer = null;
    }
    wake();
    readyReject?.(new Error("provider_v1_browser_closed"));
    await new Promise<void>((resolve) => {
      server.close(() => resolve());
      // The extension keeps a provider status long-poll open while the browser is alive. Once
      // this broker is closing there is no useful request left to preserve, and waiting for an
      // active keep-alive connection can otherwise deadlock candidate-validation teardown.
      server.closeAllConnections();
    });
  };

  server = NodeHttp.createServer((request, response) => {
    void (async () => {
      readinessDiagnostics.requests += 1;
      const origin =
        typeof request.headers.origin === "string" ? request.headers.origin : undefined;
      if (request.method === "OPTIONS") {
        if (!originAllowed(origin)) return json(response, 403, { error: "forbidden_origin" });
        response.writeHead(204, {
          ...(origin ? { "access-control-allow-origin": origin } : {}),
          "access-control-allow-headers":
            "authorization, content-type, x-provider-protocol, x-provider-version, x-provider-browser, x-provider-extension-version, x-provider-extension-build",
          "access-control-allow-methods": "GET, POST, OPTIONS",
          "access-control-allow-private-network": "true",
          "access-control-max-age": "600",
        });
        response.end();
        return;
      }
      if (!originAllowed(origin)) return json(response, 403, { error: "forbidden_origin" });
      const browserPeer = peerFromHeaders(request.headers);
      if (!browserPeer) {
        readinessDiagnostics.protocolMismatch += 1;
        return json(
          response,
          426,
          {
            error: "protocol_mismatch",
            protocol: CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL,
            version: CHATGPT_BROWSER_PROVIDER_V1_VERSION,
          },
          origin,
        );
      }
      if (
        options.expectedExtensionBuildId &&
        browserPeer.extensionBuildId !== options.expectedExtensionBuildId
      ) {
        readinessDiagnostics.buildMismatch += 1;
        json(
          response,
          409,
          {
            error: "extension_build_mismatch",
            expectedBuild: options.expectedExtensionBuildId,
          },
          origin,
        );
        // The stale MV3 worker must receive this response and execute its guarded runtime.reload().
        // Keep readiness pending during one bounded convergence window: a freshly reloaded worker
        // can re-hello/status with the expected build without the host killing Chromium mid-reload.
        // If that never happens, reject readiness and let the managed host perform its one existing
        // durable-profile relaunch. Stale build identity is never accepted as ready or authenticated.
        if (!buildMismatchTimer && readyReject) {
          buildMismatchTimer = setTimeout(() => {
            buildMismatchTimer = null;
            const cause = new Error("provider_v1_extension_build_mismatch");
            readyReject?.(cause);
            readyResolve = null;
            readyReject = null;
          }, options.buildMismatchGraceMs ?? 5_000);
        }
        return;
      }
      if (buildMismatchTimer) {
        clearTimeout(buildMismatchTimer);
        buildMismatchTimer = null;
      }
      peer = browserPeer;
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      if (url.pathname === "/provider-v1/hello" && request.method === "GET") {
        readinessDiagnostics.hello += 1;
        return json(response, 200, identity(browserPeer), origin);
      }
      if (url.pathname === "/provider-v1/pair" && request.method === "POST") {
        readinessDiagnostics.pair += 1;
        const body = asRecord(await readJson(request));
        if (!body || (body.reuse !== undefined && typeof body.reuse !== "boolean"))
          return json(response, 400, { error: "bad_request" }, origin);
        if (!credential || body.reuse === false) {
          credential = randomBytes(32).toString("hex");
          await options.secrets.write(TOKEN_SECRET, textEncoder.encode(credential));
        }
        return json(response, 200, { token: credential, identity: identity(browserPeer) }, origin);
      }
      if (!(await authenticate(request))) {
        readinessDiagnostics.authRejected += 1;
        return json(response, 401, { error: "unauthorised" }, origin);
      }
      const body = asRecord(await readJson(request));
      if (!body) return json(response, 400, { error: "bad_request" }, origin);
      if (!session) session = browserSession(browserPeer);
      const markReady = () => {
        if (!session || !readyResolve) return;
        readyResolve(session);
        readyResolve = null;
        readyReject = null;
      };
      if (url.pathname === "/provider-v1/browser/status" && request.method === "POST") {
        readinessDiagnostics.status += 1;
        return json(response, 200, await handleStatus(body, markReady), origin);
      }
      // Status is the normal startup route and carries persisted operation summaries. For any
      // other authenticated route, preserve the previous behavior and treat successful auth as
      // sufficient readiness; such a caller is already actively addressing this broker.
      markReady();
      if (url.pathname === "/provider-v1/browser/input" && request.method === "POST") {
        const result = await handleInput(body);
        return json(response, result.status, result.body, origin);
      }
      if (url.pathname === "/provider-v1/browser/events" && request.method === "POST") {
        return json(response, 200, await handleEvents(body), origin);
      }
      if (url.pathname === "/provider-v1/browser/drain" && request.method === "POST") {
        const result = await handleDrain(body);
        return json(response, result.status, result.body, origin);
      }
      if (url.pathname === "/provider-v1/browser/stop/redeem" && request.method === "POST") {
        const result = handleStopRedeem(body);
        return json(response, result.status, result.body, origin);
      }
      if (url.pathname === "/provider-v1/browser/stop/ack" && request.method === "POST") {
        const result = handleStopAck(body);
        return json(response, result.status, result.body, origin);
      }
      return json(response, 404, { error: "not_found" }, origin);
    })().catch((cause) => {
      if (!response.headersSent)
        json(response, 500, {
          error: cause instanceof Error ? cause.message.slice(0, 128) : "internal",
        });
      else response.destroy();
    });
  });

  const port = await listen(server, options.ports ?? CHATGPT_BROWSER_NATIVE_PROVIDER_PORTS);
  const waitForSession = async (
    signal?: AbortSignal,
  ): Promise<ChatGptBrowserProviderBrowserSession> => {
    if (session) return session;
    const timeoutMs = options.readyTimeoutMs ?? 30_000;
    const controller = new AbortController();
    const abort = () => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      return await Promise.race([
        ready,
        abortableDelay(timeoutMs, controller.signal).then(() =>
          Promise.reject(
            new Error(
              `provider_v1_browser_not_ready:${Object.entries(readinessDiagnostics)
                .map(([key, value]) => `${key}=${value}`)
                .join(",")}`,
            ),
          ),
        ),
      ]);
    } finally {
      signal?.removeEventListener("abort", abort);
      controller.abort();
    }
  };

  return { port, waitForSession, close: closeServer };
}
