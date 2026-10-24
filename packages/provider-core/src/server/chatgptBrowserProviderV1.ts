import {
  NonNegativeInt,
  PositiveInt,
  ProviderSessionId,
  RunAttemptId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import type { ProviderOperationConcurrencyPolicy } from "./driver.ts";

export const CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL = "provider-v1" as const;
export const CHATGPT_BROWSER_PROVIDER_V1_VERSION = 1 as const;
export const CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16 = 65_536 as const;

const BrandedNonEmptyString = <Brand extends string>(
  brand: Parameters<typeof Schema.brand<Brand>>[0],
) => TrimmedNonEmptyString.pipe(Schema.brand<Brand>(brand));

/**
 * T3 owns this identity. One durable run attempt maps to one browser-provider
 * operation for its whole lifetime, including adapter/process restart and recovery.
 */
export const ChatGptBrowserProviderOperationId = BrandedNonEmptyString(
  "ChatGptBrowserProviderOperationId",
);
export type ChatGptBrowserProviderOperationId = typeof ChatGptBrowserProviderOperationId.Type;

export function chatGptBrowserProviderOperationIdForAttempt(
  attemptId: RunAttemptId,
): ChatGptBrowserProviderOperationId {
  return ChatGptBrowserProviderOperationId.make(`chatgpt-browser:${attemptId}`);
}

export const ChatGptBrowserProviderV1EventSequence = NonNegativeInt.pipe(
  Schema.brand("ChatGptBrowserProviderV1EventSequence"),
);
export type ChatGptBrowserProviderV1EventSequence =
  typeof ChatGptBrowserProviderV1EventSequence.Type;

export const ChatGptBrowserProviderV1ProtocolIdentity = Schema.Struct({
  protocol: Schema.Literal(CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL),
  version: Schema.Literal(CHATGPT_BROWSER_PROVIDER_V1_VERSION),
  browserInstanceId: BrandedNonEmptyString("ChatGptBrowserInstanceId"),
  providerInstanceId: BrandedNonEmptyString("ChatGptBrowserNativeProviderInstanceId"),
  extensionVersion: TrimmedNonEmptyString,
  extensionBuildId: TrimmedNonEmptyString,
  ready: Schema.Boolean,
  features: Schema.Array(TrimmedNonEmptyString),
});
export type ChatGptBrowserProviderV1ProtocolIdentity =
  typeof ChatGptBrowserProviderV1ProtocolIdentity.Type;

export const ChatGptBrowserProviderV1ErrorCode = Schema.Literals([
  "protocol_mismatch",
  "not_ready",
  "auth_required",
  "operation_conflict",
  "operation_unknown",
  "invalid_state",
  "browser_unavailable",
  "provider_unavailable",
  "rate_limited",
  "cancel_failed",
  "internal",
]);
export type ChatGptBrowserProviderV1ErrorCode = typeof ChatGptBrowserProviderV1ErrorCode.Type;

export const ChatGptBrowserProviderV1Error = Schema.Struct({
  code: ChatGptBrowserProviderV1ErrorCode,
  retryable: Schema.Boolean,
  message: Schema.String.check(Schema.isMaxLength(512)),
});
export type ChatGptBrowserProviderV1Error = typeof ChatGptBrowserProviderV1Error.Type;

export const ChatGptBrowserProviderV1NativeIdentity = Schema.Struct({
  conversationId: Schema.optional(TrimmedNonEmptyString),
  userMessageId: Schema.optional(TrimmedNonEmptyString),
  providerTurnId: Schema.optional(TrimmedNonEmptyString),
});
export type ChatGptBrowserProviderV1NativeIdentity =
  typeof ChatGptBrowserProviderV1NativeIdentity.Type;

export const ChatGptBrowserProviderV1OperationState = Schema.Literals([
  "unknown",
  "claimed",
  "sent",
  "running",
  "terminal",
  "drained",
]);
export type ChatGptBrowserProviderV1OperationState =
  typeof ChatGptBrowserProviderV1OperationState.Type;

export const ChatGptBrowserProviderV1TerminalStatus = Schema.Literals([
  "completed",
  "cancelled",
  "failed",
]);
export type ChatGptBrowserProviderV1TerminalStatus =
  typeof ChatGptBrowserProviderV1TerminalStatus.Type;

const ChatGptBrowserProviderV1OperationSnapshotBase = {
  providerOperationId: ChatGptBrowserProviderOperationId,
  providerSessionId: ProviderSessionId,
  nativeIdentity: ChatGptBrowserProviderV1NativeIdentity,
  highWater: ChatGptBrowserProviderV1EventSequence,
} as const;

export const ChatGptBrowserProviderV1OperationSnapshot = Schema.Union([
  Schema.Struct({
    ...ChatGptBrowserProviderV1OperationSnapshotBase,
    state: Schema.Literals(["unknown", "claimed", "sent", "running"]),
  }),
  Schema.Struct({
    ...ChatGptBrowserProviderV1OperationSnapshotBase,
    state: Schema.Literal("terminal"),
    terminalStatus: ChatGptBrowserProviderV1TerminalStatus,
    terminalSequence: ChatGptBrowserProviderV1EventSequence,
    error: Schema.optional(ChatGptBrowserProviderV1Error),
  }),
  Schema.Struct({
    ...ChatGptBrowserProviderV1OperationSnapshotBase,
    state: Schema.Literal("drained"),
    terminalStatus: ChatGptBrowserProviderV1TerminalStatus,
    terminalSequence: ChatGptBrowserProviderV1EventSequence,
    drainedThrough: ChatGptBrowserProviderV1EventSequence,
    error: Schema.optional(ChatGptBrowserProviderV1Error),
  }),
]);
export type ChatGptBrowserProviderV1OperationSnapshot =
  typeof ChatGptBrowserProviderV1OperationSnapshot.Type;

export const ChatGptBrowserProviderV1SendRequest = Schema.Struct({
  type: Schema.Literal("operation.send"),
  providerOperationId: ChatGptBrowserProviderOperationId,
  providerSessionId: ProviderSessionId,
  text: Schema.String,
});
export type ChatGptBrowserProviderV1SendRequest = typeof ChatGptBrowserProviderV1SendRequest.Type;

export const ChatGptBrowserProviderV1SendReceipt = Schema.Struct({
  type: Schema.Literal("operation.send_receipt"),
  providerOperationId: ChatGptBrowserProviderOperationId,
  providerSessionId: ProviderSessionId,
  state: Schema.Literals(["claimed", "sent", "running", "terminal", "drained"]),
  nativeIdentity: ChatGptBrowserProviderV1NativeIdentity,
  highWater: ChatGptBrowserProviderV1EventSequence,
});
export type ChatGptBrowserProviderV1SendReceipt = typeof ChatGptBrowserProviderV1SendReceipt.Type;

export const ChatGptBrowserProviderV1QueryOperationRequest = Schema.Struct({
  type: Schema.Literal("operation.query"),
  providerOperationId: ChatGptBrowserProviderOperationId,
});
export type ChatGptBrowserProviderV1QueryOperationRequest =
  typeof ChatGptBrowserProviderV1QueryOperationRequest.Type;

export const ChatGptBrowserProviderV1ReplayRequest = Schema.Struct({
  type: Schema.Literal("events.replay"),
  providerOperationId: ChatGptBrowserProviderOperationId,
  after: ChatGptBrowserProviderV1EventSequence,
});
export type ChatGptBrowserProviderV1ReplayRequest =
  typeof ChatGptBrowserProviderV1ReplayRequest.Type;

export const ChatGptBrowserProviderV1CancelRequest = Schema.Struct({
  type: Schema.Literal("operation.cancel"),
  providerOperationId: ChatGptBrowserProviderOperationId,
});
export type ChatGptBrowserProviderV1CancelRequest =
  typeof ChatGptBrowserProviderV1CancelRequest.Type;

export const ChatGptBrowserProviderV1ReadFinalContentRequest = Schema.Struct({
  type: Schema.Literal("assistant.read_final"),
  providerOperationId: ChatGptBrowserProviderOperationId,
  offset: NonNegativeInt,
  limit: PositiveInt.check(
    Schema.isGreaterThanOrEqualTo(2),
    Schema.isLessThanOrEqualTo(CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16),
  ),
});
export type ChatGptBrowserProviderV1ReadFinalContentRequest =
  typeof ChatGptBrowserProviderV1ReadFinalContentRequest.Type;

export const ChatGptBrowserProviderV1FinalContentChunk = Schema.Struct({
  type: Schema.Literal("assistant.final_chunk"),
  providerOperationId: ChatGptBrowserProviderOperationId,
  /** UTF-16 code-unit offset. Implementations reject offsets inside surrogate pairs. */
  offset: NonNegativeInt,
  text: Schema.String.check(
    Schema.isMaxLength(CHATGPT_BROWSER_PROVIDER_V1_FINAL_CONTENT_MAX_UTF16),
  ),
  totalLength: NonNegativeInt,
  contentHash: Schema.String.check(Schema.isMaxLength(128)),
  complete: Schema.Boolean,
});
export type ChatGptBrowserProviderV1FinalContentChunk =
  typeof ChatGptBrowserProviderV1FinalContentChunk.Type;

export const ChatGptBrowserProviderV1CoreEventPayload = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("assistant.delta"),
    text: Schema.String.check(Schema.isMaxLength(65_536)),
  }),
  Schema.Struct({
    type: Schema.Literal("assistant.final"),
    contentHash: Schema.String.check(Schema.isMaxLength(128)),
    contentLength: NonNegativeInt,
  }),
  Schema.Struct({
    type: Schema.Literal("operation.terminal"),
    status: ChatGptBrowserProviderV1TerminalStatus,
    error: Schema.optional(ChatGptBrowserProviderV1Error),
  }),
  Schema.Struct({
    type: Schema.Literal("operation.drained"),
    terminalSequence: ChatGptBrowserProviderV1EventSequence,
  }),
]);
export type ChatGptBrowserProviderV1CoreEventPayload =
  typeof ChatGptBrowserProviderV1CoreEventPayload.Type;

export const ChatGptBrowserProviderV1CoreEvent = Schema.Struct({
  providerOperationId: ChatGptBrowserProviderOperationId,
  sequence: ChatGptBrowserProviderV1EventSequence,
  payload: ChatGptBrowserProviderV1CoreEventPayload,
});
export type ChatGptBrowserProviderV1CoreEvent = typeof ChatGptBrowserProviderV1CoreEvent.Type;

export const ChatGptBrowserProviderV1ReplayPage = Schema.Struct({
  providerOperationId: ChatGptBrowserProviderOperationId,
  events: Schema.Array(ChatGptBrowserProviderV1CoreEvent),
  highWater: ChatGptBrowserProviderV1EventSequence,
});
export type ChatGptBrowserProviderV1ReplayPage = typeof ChatGptBrowserProviderV1ReplayPage.Type;

/**
 * Capability schemas plug into this feature envelope. The provider-v1 core does
 * not need a new message kind when approvals, model/reasoning or attachments land.
 */
export const ChatGptBrowserProviderV1FeatureMessageEnvelope = Schema.Struct({
  type: Schema.Literal("feature.message"),
  feature: TrimmedNonEmptyString.check(Schema.isMaxLength(128)),
  providerOperationId: Schema.optional(ChatGptBrowserProviderOperationId),
  payload: Schema.Json,
});
export type ChatGptBrowserProviderV1FeatureMessageEnvelope =
  typeof ChatGptBrowserProviderV1FeatureMessageEnvelope.Type;

export interface ChatGptBrowserProviderV1FeatureMessage<
  Feature extends string = string,
  Payload = unknown,
> {
  readonly type: "feature.message";
  readonly feature: Feature;
  readonly providerOperationId?: ChatGptBrowserProviderOperationId;
  readonly payload: Payload;
}

export interface ChatGptBrowserProviderV1FeatureHandler<
  Feature extends string = string,
  Payload = unknown,
  Result = unknown,
  Error = never,
  Requirements = never,
> {
  readonly feature: Feature;
  readonly handle: (
    message: ChatGptBrowserProviderV1FeatureMessage<Feature, Payload>,
  ) => Effect.Effect<Result, Error, Requirements>;
}

export const ChatGptBrowserProviderV1RequestEnvelope = Schema.Struct({
  protocol: Schema.Literal(CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL),
  version: Schema.Literal(CHATGPT_BROWSER_PROVIDER_V1_VERSION),
  requestId: TrimmedNonEmptyString,
  message: Schema.Union([
    ChatGptBrowserProviderV1SendRequest,
    ChatGptBrowserProviderV1QueryOperationRequest,
    ChatGptBrowserProviderV1ReplayRequest,
    ChatGptBrowserProviderV1CancelRequest,
    ChatGptBrowserProviderV1ReadFinalContentRequest,
    ChatGptBrowserProviderV1FeatureMessageEnvelope,
  ]),
});
export type ChatGptBrowserProviderV1RequestEnvelope =
  typeof ChatGptBrowserProviderV1RequestEnvelope.Type;

export const ChatGptBrowserProviderV1ResponseEnvelope = Schema.Struct({
  protocol: Schema.Literal(CHATGPT_BROWSER_PROVIDER_V1_PROTOCOL),
  version: Schema.Literal(CHATGPT_BROWSER_PROVIDER_V1_VERSION),
  requestId: TrimmedNonEmptyString,
  result: Schema.Union([
    ChatGptBrowserProviderV1SendReceipt,
    ChatGptBrowserProviderV1OperationSnapshot,
    ChatGptBrowserProviderV1ReplayPage,
    ChatGptBrowserProviderV1CoreEvent,
    ChatGptBrowserProviderV1FinalContentChunk,
    ChatGptBrowserProviderV1Error,
    ChatGptBrowserProviderV1FeatureMessageEnvelope,
  ]),
});
export type ChatGptBrowserProviderV1ResponseEnvelope =
  typeof ChatGptBrowserProviderV1ResponseEnvelope.Type;

export interface ChatGptBrowserProviderV1Transport {
  readonly identity: Effect.Effect<
    ChatGptBrowserProviderV1ProtocolIdentity,
    ChatGptBrowserProviderV1Error
  >;
  readonly send: (
    request: ChatGptBrowserProviderV1SendRequest,
  ) => Effect.Effect<ChatGptBrowserProviderV1SendReceipt, ChatGptBrowserProviderV1Error>;
  readonly queryOperation: (
    request: ChatGptBrowserProviderV1QueryOperationRequest,
  ) => Effect.Effect<ChatGptBrowserProviderV1OperationSnapshot, ChatGptBrowserProviderV1Error>;
  readonly replay: (
    request: ChatGptBrowserProviderV1ReplayRequest,
  ) => Effect.Effect<ChatGptBrowserProviderV1ReplayPage, ChatGptBrowserProviderV1Error>;
  readonly cancel: (
    request: ChatGptBrowserProviderV1CancelRequest,
  ) => Effect.Effect<ChatGptBrowserProviderV1OperationSnapshot, ChatGptBrowserProviderV1Error>;
  readonly readFinalContent: (
    request: ChatGptBrowserProviderV1ReadFinalContentRequest,
  ) => Effect.Effect<ChatGptBrowserProviderV1FinalContentChunk, ChatGptBrowserProviderV1Error>;
}

export const CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY = {
  scope: "driver",
  supportedConcurrency: 1,
} as const satisfies ProviderOperationConcurrencyPolicy;

export const ChatGptBrowserManagedTarget = Schema.Literals(["windows-x64", "linux-x64"]);
export type ChatGptBrowserManagedTarget = typeof ChatGptBrowserManagedTarget.Type;

export interface ChatGptBrowserHostIdentity {
  readonly target: ChatGptBrowserManagedTarget;
  readonly browserRevision: string;
  readonly providerReleaseVersion: string;
  readonly extensionVersion: string;
}

export interface ChatGptBrowserHostSession {
  readonly identity: ChatGptBrowserHostIdentity;
  readonly transport: ChatGptBrowserProviderV1Transport;
  readonly close: Effect.Effect<void, ChatGptBrowserHostError>;
}

export interface ChatGptBrowserHostPort {
  readonly open: Effect.Effect<ChatGptBrowserHostSession, ChatGptBrowserHostError>;
}

export interface ChatGptBrowserPlatformPaths {
  readonly providerVersionsDirectory: string;
  readonly browserVersionsDirectory: string;
  readonly profileDirectory: string;
  readonly extensionRoot: string;
  readonly activeProviderPointer: string;
}

export interface ChatGptBrowserProcessHandle {
  readonly opaqueId: string;
}

export interface ChatGptBrowserPlatformPrerequisiteIssue {
  readonly code: string;
  readonly detail: string;
}

export interface ChatGptBrowserPlatformPort {
  readonly target: ChatGptBrowserManagedTarget;
  readonly paths: Effect.Effect<ChatGptBrowserPlatformPaths, ChatGptBrowserHostError>;
  readonly checkPrerequisites: Effect.Effect<
    ReadonlyArray<ChatGptBrowserPlatformPrerequisiteIssue>,
    ChatGptBrowserHostError
  >;
  readonly launchBrowser: (input: {
    readonly executablePath: string;
    readonly profileDirectory: string;
    readonly extensionRoot: string;
    readonly args: ReadonlyArray<string>;
  }) => Effect.Effect<ChatGptBrowserProcessHandle, ChatGptBrowserHostError>;
  readonly stopBrowser: (
    handle: ChatGptBrowserProcessHandle,
  ) => Effect.Effect<void, ChatGptBrowserHostError>;
  readonly replaceFileAtomically: (input: {
    readonly path: string;
    readonly contents: Uint8Array;
  }) => Effect.Effect<void, ChatGptBrowserHostError>;
  readonly readSecret: (key: string) => Effect.Effect<Uint8Array | null, ChatGptBrowserHostError>;
  readonly writeSecret: (input: {
    readonly key: string;
    readonly value: Uint8Array;
  }) => Effect.Effect<void, ChatGptBrowserHostError>;
  readonly deleteSecret: (key: string) => Effect.Effect<void, ChatGptBrowserHostError>;
}

export class ChatGptBrowserHostError extends Schema.TaggedError<ChatGptBrowserHostError>()(
  "ChatGptBrowserHostError",
  {
    operation: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}
