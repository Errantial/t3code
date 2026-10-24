import { ProviderSessionId, ProviderThreadId, RunAttemptId } from "@t3tools/contracts";
import {
  ChatGptBrowserOperationStore,
  ChatGptBrowserOperationStoreError,
  samePreparedChatGptBrowserOperationIdentity,
  type ChatGptBrowserOperationRecord,
  type ChatGptBrowserOperationStoreShape,
} from "@t3tools/provider-chatgpt-browser/server";
import {
  ChatGptBrowserProviderOperationId,
  ChatGptBrowserProviderV1EventSequence,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

interface OperationRow {
  readonly run_attempt_id: string;
  readonly provider_operation_id: string;
  readonly provider_session_id: string;
  readonly provider_thread_id: string;
  readonly consumer_high_water: number;
  readonly cancel_requested: number;
}

const decodeRow = (row: OperationRow): ChatGptBrowserOperationRecord => ({
  attemptId: RunAttemptId.make(row.run_attempt_id),
  providerOperationId: ChatGptBrowserProviderOperationId.make(row.provider_operation_id),
  providerSessionId: ProviderSessionId.make(row.provider_session_id),
  providerThreadId: ProviderThreadId.make(row.provider_thread_id),
  consumerHighWater: ChatGptBrowserProviderV1EventSequence.make(row.consumer_high_water),
  cancelRequested: row.cancel_requested === 1,
});

export const layer: Layer.Layer<ChatGptBrowserOperationStore, never, SqlClient.SqlClient> =
  Layer.effect(
    ChatGptBrowserOperationStore,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const read = (attemptId: RunAttemptId) =>
        sql<OperationRow>`
          SELECT run_attempt_id, provider_operation_id, provider_session_id, provider_thread_id,
                 consumer_high_water, cancel_requested
          FROM chatgpt_browser_provider_operations
          WHERE run_attempt_id = ${attemptId}
        `.pipe(Effect.map((rows) => (rows[0] === undefined ? undefined : decodeRow(rows[0]))));

      const get: ChatGptBrowserOperationStoreShape["get"] = (attemptId) =>
        read(attemptId).pipe(
          Effect.mapError(
            (cause) =>
              new ChatGptBrowserOperationStoreError({ operation: "read", attemptId, cause }),
          ),
        );

      const prepare: ChatGptBrowserOperationStoreShape["prepare"] = (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                INSERT INTO chatgpt_browser_provider_operations (
                  run_attempt_id,
                  provider_operation_id,
                  provider_session_id,
                  provider_thread_id,
                  consumer_high_water,
                  cancel_requested
                ) VALUES (
                  ${input.attemptId},
                  ${input.providerOperationId},
                  ${input.providerSessionId},
                  ${input.providerThreadId},
                  0,
                  0
                )
                ON CONFLICT(run_attempt_id) DO NOTHING
              `;
              const record = yield* read(input.attemptId);
              if (
                record === undefined ||
                !samePreparedChatGptBrowserOperationIdentity(record, input)
              ) {
                return yield* Effect.fail("ChatGPT Browser operation identity conflict");
              }
              return record;
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ChatGptBrowserOperationStoreError({
                  operation: "prepare",
                  attemptId: input.attemptId,
                  cause,
                }),
            ),
          );

      const advanceHighWater: ChatGptBrowserOperationStoreShape["advanceHighWater"] = (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE chatgpt_browser_provider_operations
                SET consumer_high_water = ${input.sequence}
                WHERE run_attempt_id = ${input.attemptId}
                  AND provider_operation_id = ${input.providerOperationId}
                  AND consumer_high_water < ${input.sequence}
              `;
              const record = yield* read(input.attemptId);
              if (
                record === undefined ||
                record.providerOperationId !== input.providerOperationId ||
                record.consumerHighWater < input.sequence
              ) {
                return yield* Effect.fail("ChatGPT Browser operation high-water identity conflict");
              }
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ChatGptBrowserOperationStoreError({
                  operation: "advance-high-water",
                  attemptId: input.attemptId,
                  cause,
                }),
            ),
          );

      const requestCancel: ChatGptBrowserOperationStoreShape["requestCancel"] = (input) =>
        sql
          .withTransaction(
            Effect.gen(function* () {
              yield* sql`
                UPDATE chatgpt_browser_provider_operations
                SET cancel_requested = 1
                WHERE run_attempt_id = ${input.attemptId}
                  AND provider_operation_id = ${input.providerOperationId}
              `;
              const record = yield* read(input.attemptId);
              if (
                record === undefined ||
                record.providerOperationId !== input.providerOperationId ||
                !record.cancelRequested
              ) {
                return yield* Effect.fail("ChatGPT Browser operation cancel identity conflict");
              }
            }),
          )
          .pipe(
            Effect.mapError(
              (cause) =>
                new ChatGptBrowserOperationStoreError({
                  operation: "request-cancel",
                  attemptId: input.attemptId,
                  cause,
                }),
            ),
          );

      return ChatGptBrowserOperationStore.of({ prepare, get, advanceHighWater, requestCancel });
    }),
  );
