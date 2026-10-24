import { ProviderSessionId, ProviderThreadId, RunAttemptId } from "@t3tools/contracts";
import {
  ChatGptBrowserProviderOperationId,
  ChatGptBrowserProviderV1EventSequence,
  type ChatGptBrowserProviderOperationId as ChatGptBrowserProviderOperationIdType,
  type ChatGptBrowserProviderV1EventSequence as ChatGptBrowserProviderV1EventSequenceType,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

export interface ChatGptBrowserOperationRecord {
  readonly attemptId: RunAttemptId;
  readonly providerOperationId: ChatGptBrowserProviderOperationIdType;
  readonly providerSessionId: ProviderSessionId;
  readonly providerThreadId: ProviderThreadId;
  readonly consumerHighWater: ChatGptBrowserProviderV1EventSequenceType;
  readonly cancelRequested: boolean;
}

export class ChatGptBrowserOperationStoreError extends Schema.TaggedError<ChatGptBrowserOperationStoreError>()(
  "ChatGptBrowserOperationStoreError",
  {
    operation: Schema.Literals(["prepare", "read", "advance-high-water", "request-cancel"]),
    attemptId: RunAttemptId,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ChatGptBrowserOperationStoreShape {
  readonly prepare: (input: {
    readonly attemptId: RunAttemptId;
    readonly providerOperationId: ChatGptBrowserProviderOperationIdType;
    readonly providerSessionId: ProviderSessionId;
    readonly providerThreadId: ProviderThreadId;
  }) => Effect.Effect<ChatGptBrowserOperationRecord, ChatGptBrowserOperationStoreError>;
  readonly get: (
    attemptId: RunAttemptId,
  ) => Effect.Effect<ChatGptBrowserOperationRecord | undefined, ChatGptBrowserOperationStoreError>;
  readonly advanceHighWater: (input: {
    readonly attemptId: RunAttemptId;
    readonly providerOperationId: ChatGptBrowserProviderOperationIdType;
    readonly sequence: ChatGptBrowserProviderV1EventSequenceType;
  }) => Effect.Effect<void, ChatGptBrowserOperationStoreError>;
  readonly requestCancel: (input: {
    readonly attemptId: RunAttemptId;
    readonly providerOperationId: ChatGptBrowserProviderOperationIdType;
  }) => Effect.Effect<void, ChatGptBrowserOperationStoreError>;
}

export class ChatGptBrowserOperationStore extends Context.Service<
  ChatGptBrowserOperationStore,
  ChatGptBrowserOperationStoreShape
>()("@t3tools/provider-chatgpt-browser/server/operationRecovery/ChatGptBrowserOperationStore") {}

export function samePreparedChatGptBrowserOperationIdentity(
  record: ChatGptBrowserOperationRecord,
  input: Parameters<ChatGptBrowserOperationStoreShape["prepare"]>[0],
): boolean {
  return (
    record.attemptId === input.attemptId &&
    record.providerOperationId === input.providerOperationId &&
    record.providerSessionId === input.providerSessionId &&
    record.providerThreadId === input.providerThreadId
  );
}

export const layerMemory = Layer.effect(
  ChatGptBrowserOperationStore,
  Effect.gen(function* () {
    const state = yield* Ref.make(new Map<RunAttemptId, ChatGptBrowserOperationRecord>());
    const get: ChatGptBrowserOperationStoreShape["get"] = (attemptId) =>
      Ref.get(state).pipe(Effect.map((records) => records.get(attemptId)));
    const prepare: ChatGptBrowserOperationStoreShape["prepare"] = (input) =>
      Ref.modify(state, (records) => {
        const existing = records.get(input.attemptId);
        if (existing !== undefined) {
          return [existing, records] as const;
        }
        const record: ChatGptBrowserOperationRecord = {
          ...input,
          consumerHighWater: ChatGptBrowserProviderV1EventSequence.make(0),
          cancelRequested: false,
        };
        return [record, new Map(records).set(input.attemptId, record)] as const;
      }).pipe(
        Effect.flatMap((record) =>
          samePreparedChatGptBrowserOperationIdentity(record, input)
            ? Effect.succeed(record)
            : Effect.fail(
                new ChatGptBrowserOperationStoreError({
                  operation: "prepare",
                  attemptId: input.attemptId,
                  cause: "ChatGPT Browser operation identity conflict",
                }),
              ),
        ),
      );
    const advanceHighWater: ChatGptBrowserOperationStoreShape["advanceHighWater"] = (input) =>
      Ref.modify(state, (records) => {
        const current = records.get(input.attemptId);
        if (current === undefined || current.providerOperationId !== input.providerOperationId) {
          return [false, records] as const;
        }
        if (current.consumerHighWater >= input.sequence) return [true, records] as const;
        return [
          true,
          new Map(records).set(input.attemptId, {
            ...current,
            consumerHighWater: input.sequence,
          }),
        ] as const;
      }).pipe(
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(
                new ChatGptBrowserOperationStoreError({
                  operation: "advance-high-water",
                  attemptId: input.attemptId,
                  cause: "ChatGPT Browser operation high-water identity conflict",
                }),
              ),
        ),
      );
    const requestCancel: ChatGptBrowserOperationStoreShape["requestCancel"] = (input) =>
      Ref.modify(state, (records) => {
        const current = records.get(input.attemptId);
        if (current === undefined || current.providerOperationId !== input.providerOperationId) {
          return [false, records] as const;
        }
        return [
          true,
          new Map(records).set(input.attemptId, { ...current, cancelRequested: true }),
        ] as const;
      }).pipe(
        Effect.flatMap((ok) =>
          ok
            ? Effect.void
            : Effect.fail(
                new ChatGptBrowserOperationStoreError({
                  operation: "request-cancel",
                  attemptId: input.attemptId,
                  cause: "ChatGPT Browser operation cancel identity conflict",
                }),
              ),
        ),
      );
    return ChatGptBrowserOperationStore.of({ prepare, get, advanceHighWater, requestCancel });
  }),
);

const eventCheckpoints = new WeakMap<
  object,
  Effect.Effect<void, ChatGptBrowserOperationStoreError>
>();

export function registerChatGptBrowserProviderEventCheckpoint(
  event: object,
  checkpoint: Effect.Effect<void, ChatGptBrowserOperationStoreError>,
): void {
  eventCheckpoints.set(event, checkpoint);
}

export function checkpointChatGptBrowserProviderEvent(
  event: object,
): Effect.Effect<void, ChatGptBrowserOperationStoreError> {
  return eventCheckpoints.get(event) ?? Effect.void;
}
