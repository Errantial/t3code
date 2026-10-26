// @effect-diagnostics-next-line nodeBuiltinImport:off -- This test exercises the real private loopback HTTP boundary without Effect HttpClient machinery.
import * as NodeHttp from "node:http";

import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId, RunAttemptId } from "@t3tools/contracts";
import { chatGptBrowserProviderOperationIdForAttempt } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";

import { CHATGPT_BROWSER_S8_FEATURE } from "./features.ts";
import { startNativeChatGptBrowserBroker } from "./nativeBrowser.ts";

const peerHeaders = {
  "content-type": "application/json",
  "x-provider-protocol": "provider-v1",
  "x-provider-version": "1",
  "x-provider-browser": "browser-test",
  "x-provider-extension-version": "2.1.39",
  "x-provider-extension-build": "build-test",
};

function requestJson<T>(input: {
  readonly port: number;
  readonly path: string;
  readonly headers?: Record<string, string>;
  readonly body?: unknown;
}): Promise<{ readonly status: number; readonly body: T }> {
  const encoded = input.body === undefined ? undefined : JSON.stringify(input.body);
  return new Promise((resolve, reject) => {
    const request = NodeHttp.request(
      {
        host: "127.0.0.1",
        port: input.port,
        path: input.path,
        method: encoded === undefined ? "GET" : "POST",
        headers: {
          ...peerHeaders,
          ...(input.headers ?? {}),
          ...(encoded === undefined
            ? {}
            : { "content-length": String(Buffer.byteLength(encoded)) }),
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk) =>
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)),
        );
        response.on("end", () => {
          try {
            resolve({
              status: response.statusCode ?? 0,
              body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as T,
            });
          } catch (cause) {
            reject(cause);
          }
        });
      },
    );
    request.on("error", reject);
    if (encoded !== undefined) request.end(encoded);
    else request.end();
  });
}

async function startReadyBroker() {
  const secrets = new Map<string, Uint8Array>();
  const broker = await startNativeChatGptBrowserBroker({
    ports: [0],
    readyTimeoutMs: 5_000,
    secrets: {
      read: async (key) => secrets.get(key) ?? null,
      write: async (key, value) => {
        secrets.set(key, value);
      },
      delete: async (key) => {
        secrets.delete(key);
      },
    },
  });
  const pair = await requestJson<{ token: string }>({
    port: broker.port,
    path: "/provider-v1/pair",
    body: { reuse: true },
  });
  const headers = { authorization: `Bearer ${pair.body.token}` };
  await requestJson({
    port: broker.port,
    path: "/provider-v1/browser/status",
    headers,
    body: { operations: [], after: 0, wait: false },
  });
  const session = await broker.waitForSession();
  return { broker, headers, session };
}

describe("native ChatGPT browser broker", () => {
  it("tracks the managed ChatGPT sign-in and wakes authentication waiters", async () => {
    const { broker, headers } = await startReadyBroker();
    try {
      expect(broker.authenticationStatus()).toBe("unknown");
      const known = broker.waitForAuthenticationStatus();
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false, chatGptSignedIn: false },
      });
      await expect(known).resolves.toBe("unauthenticated");
      expect(broker.authenticationStatus()).toBe("unauthenticated");

      const authenticated = broker.waitForAuthentication();
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false, chatGptSignedIn: true },
      });
      await authenticated;
      expect(broker.authenticationStatus()).toBe("authenticated");
    } finally {
      await broker.close();
    }
  });

  it("stages S8 configuration without claiming browser ownership before the durable send", async () => {
    const { broker, session } = await startReadyBroker();
    try {
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-configure-before-send"),
      );
      await session.feature!({
        type: "feature.message",
        feature: CHATGPT_BROWSER_S8_FEATURE,
        providerOperationId,
        payload: {
          kind: "operation.configure",
          selection: {
            requestedModel: "gpt-6-thinking",
            selectedModel: "gpt-6-thinking",
            requestedReasoningEffort: "medium",
            selectedReasoningEffort: "medium",
          },
          attachments: [],
        },
      });

      await expect(
        session.queryExact(providerOperationId, new AbortController().signal),
      ).resolves.toBeNull();

      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-configure-before-send"),
          text: "configured send",
        },
        new AbortController().signal,
      );
      await expect(
        session.feature!({
          type: "feature.message",
          feature: CHATGPT_BROWSER_S8_FEATURE,
          providerOperationId,
          payload: { kind: "operation.read" },
        }),
      ).resolves.toMatchObject({
        selection: {
          selectedModel: "gpt-6-thinking",
          selectedReasoningEffort: "medium",
        },
        attachments: [],
      });
    } finally {
      await broker.close();
    }
  });

  it("rejects an approval answer after the browser document changes", async () => {
    const { broker, headers, session } = await startReadyBroker();
    try {
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-stale-approval"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-stale-approval"),
          text: "approval please",
        },
        controller.signal,
      );
      const pending = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = pending.body.inputs[0]!.id;
      const owner = "1:approval-document:0";
      const conversationId = "44444444-4444-4444-4444-444444444444";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId, authorize: true },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId,
          messageId: "user-approval-test",
          ack: true,
        },
      });

      const observe = (documentId: string, cardId: string) =>
        requestJson({
          port: broker.port,
          path: "/provider-v1/browser/feature",
          headers,
          body: {
            providerOperationId,
            payload: {
              kind: "approval.observe",
              documentId,
              conversationId,
              card: { id: cardId, lines: ["Allow this action?"], allow: true },
            },
          },
        });
      expect((await observe("document-a", "card-a")).status).toBe(200);
      expect((await observe("document-b", "card-b")).status).toBe(200);

      await expect(
        session.feature!({
          type: "feature.message",
          feature: CHATGPT_BROWSER_S8_FEATURE,
          providerOperationId,
          payload: {
            kind: "approval.answer",
            documentId: "document-a",
            cardId: "card-a",
            token: "stale-token",
            choice: "allow",
          },
        }),
      ).rejects.toThrow("provider_approval_stale");
    } finally {
      await broker.close();
    }
  });

  it("prevents a document reload from re-claiming an attachment upload", async () => {
    const { broker, headers, session } = await startReadyBroker();
    try {
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-attachment-reload"),
      );
      await session.feature!({
        type: "feature.message",
        feature: CHATGPT_BROWSER_S8_FEATURE,
        providerOperationId,
        payload: {
          kind: "operation.configure",
          selection: {
            requestedModel: "gpt-6-thinking",
            selectedModel: "gpt-6-thinking",
            requestedReasoningEffort: "medium",
            selectedReasoningEffort: "medium",
          },
          attachments: [
            {
              id: "attachment-one",
              name: "one.txt",
              mimeType: "text/plain",
              size: 3,
              sha256: "7692c3ad3540bb803c020b3aee66cd8887123234ea0c6e7143c0add73ff431ed",
              bytesBase64: Buffer.from("one").toString("base64"),
            },
          ],
        },
      });
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-attachment-reload"),
          text: "send file",
        },
        new AbortController().signal,
      );
      const pending = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = pending.body.inputs[0]!.id;
      const first = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner: "document-a", conversationId: null },
      });
      expect(first.status).toBe(200);
      const chunk = await requestJson<{ chunk: string }>({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner: "document-a",
          conversationId: null,
          attachmentId: "attachment-one",
          offset: 0,
        },
      });
      expect(Buffer.from(chunk.body.chunk, "base64").toString()).toBe("one");
      const reloaded = await requestJson<{ error: string }>({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner: "document-b", conversationId: null },
      });
      expect(reloaded.status).toBe(409);
      expect(reloaded.body.error).toBe("input_document_changed");
    } finally {
      await broker.close();
    }
  });

  it("does not allow attachment upload to repeat after Send when the ACK is lost", async () => {
    const { broker, headers, session } = await startReadyBroker();
    try {
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-attachment-lost-ack"),
      );
      await session.feature!({
        type: "feature.message",
        feature: CHATGPT_BROWSER_S8_FEATURE,
        providerOperationId,
        payload: {
          kind: "operation.configure",
          selection: {
            requestedModel: "gpt-6",
            selectedModel: "gpt-6",
            requestedReasoningEffort: "none",
            selectedReasoningEffort: "none",
          },
          attachments: [
            {
              id: "attachment-two",
              name: "two.txt",
              mimeType: "text/plain",
              size: 3,
              sha256: "3fc4ccfe745870e2c0d99f71f30ff0656c8dedd41cc1d7d3d376b0dbe685e2f3",
              bytesBase64: Buffer.from("two").toString("base64"),
            },
          ],
        },
      });
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-attachment-lost-ack"),
          text: "send file once",
        },
        new AbortController().signal,
      );
      const pending = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = pending.body.inputs[0]!.id;
      const owner = "document-send";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId: null },
      });
      const firstChunk = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId: null,
          attachmentId: "attachment-two",
          offset: 0,
        },
      });
      expect(firstChunk.status).toBe(200);
      expect(
        (
          await requestJson({
            port: broker.port,
            path: "/provider-v1/browser/input",
            headers,
            body: { providerOperationId, id, owner, conversationId: null, authorize: true },
          })
        ).status,
      ).toBe(200);

      const retryClaim = await requestJson<{ error: string }>({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId: null },
      });
      expect(retryClaim.status).toBe(409);
      expect(retryClaim.body.error).toBe("input_send_ambiguous");
      const retryChunk = await requestJson<{ error: string }>({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId: null,
          attachmentId: "attachment-two",
          offset: 0,
        },
      });
      expect(retryChunk.status).toBe(409);
      expect(retryChunk.body.error).toBe("input_not_owned");
    } finally {
      await broker.close();
    }
  });

  it("fails closed on protocol mismatch and missing provider bearer", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    try {
      const mismatch = await requestJson({
        port: broker.port,
        path: "/provider-v1/hello",
        headers: { "x-provider-version": "999" },
      });
      expect(mismatch.status).toBe(426);

      const unauthorized = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        body: { operations: [], after: 0, wait: false },
      });
      expect(unauthorized.status).toBe(401);
    } finally {
      await broker.close();
    }
  });

  it("rejects a stale extension build before pairing", async () => {
    const secrets = new Map<string, Uint8Array>();
    const expectedExtensionBuildId = "abcdef123456";
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      buildMismatchGraceMs: 10,
      expectedExtensionBuildId,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    try {
      const stale = await requestJson<{ error: string; expectedBuild: string }>({
        port: broker.port,
        path: "/provider-v1/hello",
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toEqual({
        error: "extension_build_mismatch",
        expectedBuild: expectedExtensionBuildId,
      });
      await expect(broker.waitForSession()).rejects.toThrow("provider_v1_extension_build_mismatch");

      const current = await requestJson({
        port: broker.port,
        path: "/provider-v1/hello",
        headers: { "x-provider-extension-build": expectedExtensionBuildId },
      });
      expect(current.status).toBe(200);
    } finally {
      await broker.close();
    }
  });

  it("allows a stale MV3 worker to reload into the expected build before readiness fails", async () => {
    const secrets = new Map<string, Uint8Array>();
    const expectedExtensionBuildId = "abcdef123456";
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      buildMismatchGraceMs: 500,
      expectedExtensionBuildId,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    try {
      const ready = broker.waitForSession();
      const stale = await requestJson({
        port: broker.port,
        path: "/provider-v1/hello",
      });
      expect(stale.status).toBe(409);

      const currentHeaders = { "x-provider-extension-build": expectedExtensionBuildId };
      const current = await requestJson({
        port: broker.port,
        path: "/provider-v1/hello",
        headers: currentHeaders,
      });
      expect(current.status).toBe(200);
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        headers: currentHeaders,
        body: { reuse: true },
      });
      expect(pair.status).toBe(200);
      const status = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers: { ...currentHeaders, authorization: `Bearer ${pair.body.token}` },
        body: { operations: [], after: 0, wait: false },
      });
      expect(status.status).toBe(200);
      await expect(ready).resolves.toMatchObject({
        identity: { extensionBuildId: expectedExtensionBuildId, ready: true },
      });
    } finally {
      await broker.close();
    }
  });

  it("closes promptly while an authenticated browser status long-poll is in flight", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    const pair = await requestJson<{ token: string }>({
      port: broker.port,
      path: "/provider-v1/pair",
      body: { reuse: true },
    });
    const headers = { authorization: `Bearer ${pair.body.token}` };
    const initial = await requestJson<{ generation: number }>({
      port: broker.port,
      path: "/provider-v1/browser/status",
      headers,
      body: { operations: [], after: 0, wait: false },
    });
    const waiting = requestJson({
      port: broker.port,
      path: "/provider-v1/browser/status",
      headers,
      body: { operations: [], after: initial.body.generation, wait: true },
    }).catch(() => null);
    // @effect-diagnostics-next-line globalTimers:off -- The real Node HTTP long-poll needs time to enter the server before close.
    await new Promise((resolve) => setTimeout(resolve, 25));

    // @effect-diagnostics-next-line globalDate:off -- Wall-clock bound verifies native server teardown does not wait for the long-poll timeout.
    const startedAt = Date.now();
    await broker.close();
    // @effect-diagnostics-next-line globalDate:off -- Same bounded teardown assertion as above.
    expect(Date.now() - startedAt).toBeLessThan(1_000);
    await waiting;
  });

  it("rehydrates exact extension ownership before reporting the browser session ready", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-ready-rehydrate"),
      );
      const commandId = "95b0f906-909b-4f47-80e4-91045bd30772";
      const ready = broker.waitForSession();
      const status = requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: {
          operations: [{ providerOperationId, commandId, state: "claimed" }],
          after: 0,
          wait: true,
        },
      });

      const session = await ready;
      const controller = new AbortController();
      expect(await session.queryExact(providerOperationId, controller.signal)).toMatchObject({
        providerOperationId,
        state: "claimed",
        sendAuthorized: false,
      });
      expect((await status).status).toBe(200);
    } finally {
      await broker.close();
    }
  });

  it("does not treat an authorized-but-unacked send as safe pre-send cancellation", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      expect(pair.status).toBe(200);
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-authorized-unacked"),
      );
      const providerSessionId = ProviderSessionId.make("provider-session-native-test");
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId,
          text: "hello",
        },
        controller.signal,
      );

      const status = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = status.body.inputs[0]?.id;
      expect(id).toMatch(/^[a-f0-9-]{36}$/i);
      const owner = "1:document-test:0";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId: null },
      });
      const authorized = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId: null, authorize: true },
      });
      expect(authorized.status).toBe(200);

      await expect(session.cancelExact(providerOperationId, controller.signal)).rejects.toThrow(
        "native_send_receipt_ambiguous",
      );
      await expect(
        session.queryExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({
        state: "claimed",
        nativeIdentity: {},
        sendAuthorized: true,
      });
    } finally {
      await broker.close();
    }
  });

  it("redeems and acknowledges the exact running Stop command without waiting for the cancel timeout", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      stopAckTimeoutMs: 100,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      persistObservation: async () => undefined,
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      expect(pair.status).toBe(200);
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-running-stop"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-native-running-stop"),
          text: "keep going",
        },
        controller.signal,
      );

      const pending = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = pending.body.inputs[0]!.id;
      const owner = "1:document-stop-test:0";
      const conversationId = "33333333-3333-3333-3333-333333333333";
      const turnId = "turn-running-stop";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId, authorize: true },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId,
          messageId: "user-running-stop",
          ack: true,
        },
      });
      const cancellation = session.cancelExact(providerOperationId, controller.signal);
      let cancellationSettled = false;
      void cancellation.finally(() => {
        cancellationSettled = true;
      });

      const started = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId,
          entries: [{ conversationId, event: { kind: "turn_start", turnId } }],
          operations: [],
        },
      });
      expect(started.status).toBe(200);
      expect(cancellationSettled).toBe(false);
      await expect(
        session.queryExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({
        state: "running",
        nativeIdentity: {
          conversationId,
          userMessageId: "user-running-stop",
          providerTurnId: turnId,
        },
      });

      const repeatedStart = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId,
          entries: [{ conversationId, event: { kind: "turn_start", turnId } }],
          operations: [],
        },
      });
      expect(repeatedStart.status).toBe(200);
      expect(cancellationSettled).toBe(false);
      const stopStatus = await requestJson<{
        stopTurns: Array<{
          id: string;
          providerOperationId: string;
          conversationId: string;
          turnId: string;
        }>;
      }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      expect(stopStatus.status).toBe(200);
      const stop = stopStatus.body.stopTurns[0]!;
      expect(stop).toMatchObject({ providerOperationId, conversationId, turnId });

      const redeemed = await requestJson<{
        ok: boolean;
        command: {
          id: string;
          type: string;
          conversationId: string;
          turnId: string;
          userMessageId: string;
        };
      }>({
        port: broker.port,
        path: "/provider-v1/browser/stop/redeem",
        headers,
        body: { providerOperationId, id: stop.id, conversationId },
      });
      expect(redeemed.status).toBe(200);
      expect(redeemed.body.command).toMatchObject({
        id: stop.id,
        type: "stop",
        conversationId,
        turnId,
        userMessageId: "user-running-stop",
      });

      const acknowledged = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/stop/ack",
        headers,
        body: { providerOperationId, id: stop.id, conversationId, turnId, status: "sent" },
      });
      expect(acknowledged.status).toBe(200);
      await expect(cancellation).resolves.toMatchObject({ state: "running" });

      await expect(session.cancelExact(providerOperationId, controller.signal)).rejects.toThrow(
        "native_stop_unacknowledged",
      );
    } finally {
      await broker.close();
    }
  });

  it("returns non-2xx until a final browser observation is durably accepted", async () => {
    const secrets = new Map<string, Uint8Array>();
    const accepted: Array<{ readonly finalText?: string; readonly terminalStatus?: string }> = [];
    let rejectObservation = false;
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      persistObservation: async (observation) => {
        if (rejectObservation) throw new Error("simulated_wal_failure");
        accepted.push(observation);
      },
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-durable-events"),
      );
      const providerSessionId = ProviderSessionId.make("provider-session-native-durable-events");
      const controller = new AbortController();
      await session.sendExact(
        { type: "operation.send", providerOperationId, providerSessionId, text: "hello" },
        controller.signal,
      );
      const status = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = status.body.inputs[0]!.id;
      const owner = "1:document-test:0";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId: null },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId: null, authorize: true },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId: "11111111-1111-1111-1111-111111111111",
          messageId: "user-message-1",
          ack: true,
        },
      });

      const events = {
        conversationId: "11111111-1111-1111-1111-111111111111",
        entries: [
          {
            conversationId: "11111111-1111-1111-1111-111111111111",
            event: { kind: "turn_start", turnId: "turn-1" },
          },
          {
            conversationId: "11111111-1111-1111-1111-111111111111",
            event: {
              kind: "assistant_message",
              turnId: "turn-1",
              state: "final",
              final: true,
              text: "answer",
            },
          },
          {
            conversationId: "11111111-1111-1111-1111-111111111111",
            event: { kind: "turn_end", turnId: "turn-1", outcome: "completed" },
          },
        ],
        operations: [],
      };
      rejectObservation = true;
      const refused = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: events,
      });
      expect(refused.status).toBe(500);

      rejectObservation = false;
      const acceptedRetry = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: events,
      });
      expect(acceptedRetry.status).toBe(200);
      expect(accepted.at(-1)).toMatchObject({ finalText: "answer", terminalStatus: "completed" });
    } finally {
      await broker.close();
    }
  });

  it("repairs completed drains that are missing final content and refuses to drain them again", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      persistObservation: async () => undefined,
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-incomplete-drain"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-native-incomplete-drain"),
          text: "hello",
        },
        controller.signal,
      );
      const pending = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const commandId = pending.body.inputs[0]!.id;
      const conversationId = "22222222-2222-2222-2222-222222222222";
      const turnId = "turn-incomplete-drain";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: {
          operations: [
            {
              providerOperationId,
              commandId,
              state: "drained",
              terminalStatus: "completed",
              conversationId,
              providerTurnId: turnId,
            },
          ],
          after: 0,
          wait: false,
        },
      });

      await expect(
        session.queryExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({
        state: "running",
        terminalStatus: "completed",
      });
      const drain = await requestJson<{ error: string; retryable: boolean }>({
        port: broker.port,
        path: "/provider-v1/browser/drain",
        headers,
        body: { providerOperationId, conversationId, turnId, phase: "probe" },
      });
      expect(drain.status).toBe(409);
      expect(drain.body).toEqual({
        ok: false,
        error: "provider_turn_not_closing",
        retryable: true,
      });
    } finally {
      await broker.close();
    }
  });

  it("does not attribute historical finals before the exact turn starts", async () => {
    const secrets = new Map<string, Uint8Array>();
    const accepted: Array<{ readonly finalText?: string; readonly terminalStatus?: string }> = [];
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      persistObservation: async (observation) => {
        accepted.push(observation);
      },
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-history-isolation"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make("provider-session-native-history-isolation"),
          text: "hello",
        },
        controller.signal,
      );
      const status = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = status.body.inputs[0]!.id;
      const owner = "1:document-test:0";
      const conversationId = "11111111-1111-1111-1111-111111111111";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner, conversationId, authorize: true },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId,
          messageId: "user-message-new",
          ack: true,
        },
      });
      const acceptedBeforeHistory = accepted.length;

      const history = await requestJson<{ operations: unknown[] }>({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId,
          entries: [
            {
              conversationId,
              event: {
                kind: "assistant_message",
                messageId: "assistant-history-turnless",
                state: "final",
                final: true,
                text: "turnless history",
              },
            },
            {
              conversationId,
              event: {
                kind: "assistant_message",
                turnId: "turn-history",
                messageId: "assistant-history-bound",
                state: "final",
                final: true,
                text: "turn-bound history",
              },
            },
          ],
          operations: [],
        },
      });
      expect(history.status).toBe(200);
      expect(history.body.operations).toEqual([]);
      expect(accepted).toHaveLength(acceptedBeforeHistory);
      expect(accepted.at(-1)?.finalText).toBeUndefined();
      await expect(
        session.queryExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({ state: "sent" });

      const exact = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId,
          entries: [
            { conversationId, event: { kind: "turn_start", turnId: "turn-new" } },
            {
              conversationId,
              event: {
                kind: "assistant_message",
                turnId: "turn-new",
                messageId: "assistant-new",
                state: "final",
                final: true,
                text: "answer",
              },
            },
            {
              conversationId,
              event: { kind: "turn_end", turnId: "turn-new", outcome: "completed" },
            },
          ],
          operations: [],
        },
      });
      expect(exact.status).toBe(200);
      expect(accepted.at(-1)).toMatchObject({ finalText: "answer", terminalStatus: "completed" });
    } finally {
      await broker.close();
    }
  });

  it("does not let a stale terminal from another operation settle the target session", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      persistObservation: async () => undefined,
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const operationA = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-cross-session-stale-a"),
      );
      const operationB = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-cross-session-stale-b"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId: operationA,
          providerSessionId: ProviderSessionId.make("provider-session-native-cross-session-a"),
          text: "source",
        },
        controller.signal,
      );
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId: operationB,
          providerSessionId: ProviderSessionId.make("provider-session-native-cross-session-b"),
          text: "target",
        },
        controller.signal,
      );
      const status = await requestJson<{
        inputs: Array<{ id: string; providerOperationId: string }>;
      }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const inputA = status.body.inputs.find((input) => input.providerOperationId === operationA)!;
      const inputB = status.body.inputs.find((input) => input.providerOperationId === operationB)!;
      const conversationA = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const conversationB = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const turnA = "turn-cross-session-a";
      const turnB = "turn-cross-session-b";
      const bind = async (
        input: { id: string; providerOperationId: string },
        conversationId: string,
      ) => {
        const owner = `${input.providerOperationId}:document`;
        await requestJson({
          port: broker.port,
          path: "/provider-v1/browser/input",
          headers,
          body: {
            providerOperationId: input.providerOperationId,
            id: input.id,
            owner,
            conversationId,
          },
        });
        await requestJson({
          port: broker.port,
          path: "/provider-v1/browser/input",
          headers,
          body: {
            providerOperationId: input.providerOperationId,
            id: input.id,
            owner,
            conversationId,
            authorize: true,
          },
        });
        await requestJson({
          port: broker.port,
          path: "/provider-v1/browser/input",
          headers,
          body: {
            providerOperationId: input.providerOperationId,
            id: input.id,
            owner,
            conversationId,
            messageId: `user-${input.providerOperationId}`,
            ack: true,
          },
        });
      };
      await bind(inputA, conversationA);
      await bind(inputB, conversationB);
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId: conversationA,
          entries: [
            { conversationId: conversationA, event: { kind: "turn_start", turnId: turnA } },
          ],
          operations: [],
        },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId: conversationB,
          entries: [
            { conversationId: conversationB, event: { kind: "turn_start", turnId: turnB } },
          ],
          operations: [],
        },
      });

      const stale = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId: conversationB,
          entries: [
            {
              conversationId: conversationB,
              event: { kind: "turn_end", turnId: turnA, outcome: "cancelled" },
            },
          ],
          operations: [],
        },
      });
      expect(stale.status).toBe(200);
      await expect(session.queryExact(operationA, controller.signal)).resolves.toMatchObject({
        state: "terminal",
        terminalStatus: "cancelled",
        nativeIdentity: { conversationId: conversationA, providerTurnId: turnA },
      });
      await expect(session.queryExact(operationB, controller.signal)).resolves.toMatchObject({
        state: "running",
        nativeIdentity: { conversationId: conversationB, providerTurnId: turnB },
      });

      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/events",
        headers,
        body: {
          conversationId: conversationB,
          entries: [
            {
              conversationId: conversationB,
              event: {
                kind: "assistant_message",
                turnId: turnB,
                state: "final",
                final: true,
                text: "target answer",
              },
            },
            {
              conversationId: conversationB,
              event: { kind: "turn_end", turnId: turnB, outcome: "completed" },
            },
          ],
          operations: [],
        },
      });
      const probe = await requestJson<{ drainToken: string }>({
        port: broker.port,
        path: "/provider-v1/browser/drain",
        headers,
        body: {
          providerOperationId: operationB,
          conversationId: conversationB,
          turnId: turnB,
          phase: "probe",
        },
      });
      expect(probe.status).toBe(200);
      const committed = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/drain",
        headers,
        body: {
          providerOperationId: operationB,
          conversationId: conversationB,
          turnId: turnB,
          phase: "commit",
          drainToken: probe.body.drainToken,
        },
      });
      expect(committed.status).toBe(200);
      await expect(session.queryExact(operationB, controller.signal)).resolves.toMatchObject({
        state: "drained",
        terminalStatus: "completed",
        nativeIdentity: { conversationId: conversationB, providerTurnId: turnB },
      });
    } finally {
      await broker.close();
    }
  });

  it("rehydrates the same claimed operation after broker restart without creating a new operation", async () => {
    const secrets = new Map<string, Uint8Array>();
    const secretPort = {
      read: async (key: string) => secrets.get(key) ?? null,
      write: async (key: string, value: Uint8Array) => {
        secrets.set(key, value);
      },
      delete: async (key: string) => {
        secrets.delete(key);
      },
    };
    const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
      RunAttemptId.make("attempt-native-broker-restart"),
    );
    const providerSessionId = ProviderSessionId.make("provider-session-native-broker-restart");
    const request = {
      type: "operation.send" as const,
      providerOperationId,
      providerSessionId,
      text: "resume me",
    };
    const controller = new AbortController();

    const first = await startNativeChatGptBrowserBroker({
      ports: [0],
      secrets: secretPort,
      readyTimeoutMs: 5_000,
    });
    let summary: unknown;
    try {
      const pair = await requestJson<{ token: string }>({
        port: first.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: first.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await first.waitForSession();
      await session.sendExact(request, controller.signal);
      const status = await requestJson<{ operations: unknown[] }>({
        port: first.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      summary = status.body.operations[0];
    } finally {
      await first.close();
    }

    const second = await startNativeChatGptBrowserBroker({
      ports: [0],
      secrets: secretPort,
      readyTimeoutMs: 5_000,
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: second.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      const before = await requestJson<{ inputs: unknown[] }>({
        port: second.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [summary], after: 0, wait: false },
      });
      expect(before.body.inputs).toHaveLength(0);
      const session = await second.waitForSession();
      await expect(
        session.queryExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({ state: "claimed" });

      await session.sendExact(request, controller.signal);
      const after = await requestJson<{ inputs: Array<{ providerOperationId: string }> }>({
        port: second.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [summary], after: 0, wait: false },
      });
      expect(after.body.inputs).toEqual([expect.objectContaining({ providerOperationId })]);
    } finally {
      await second.close();
    }
  });

  it("rejects a send receipt that moves a pre-bound operation to another conversation", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
      persistObservation: async () => undefined,
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-conversation-conflict"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-native-conversation-conflict",
          ),
          text: "next",
        },
        controller.signal,
        { conversationId: "11111111-1111-1111-1111-111111111111" },
      );
      const status = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = status.body.inputs[0]!.id;
      const owner = "1:document-test:0";
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId: "11111111-1111-1111-1111-111111111111",
        },
      });
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId: "11111111-1111-1111-1111-111111111111",
          authorize: true,
        },
      });
      const wrong = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: {
          providerOperationId,
          id,
          owner,
          conversationId: "22222222-2222-2222-2222-222222222222",
          messageId: "user-2",
          ack: true,
        },
      });
      expect(wrong.status).toBe(409);
      await expect(
        session.queryExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({
        nativeIdentity: { conversationId: "11111111-1111-1111-1111-111111111111" },
      });
    } finally {
      await broker.close();
    }
  });

  it("does not allow a pre-send-cancelled operation to be claimed later", async () => {
    const secrets = new Map<string, Uint8Array>();
    const broker = await startNativeChatGptBrowserBroker({
      ports: [0],
      readyTimeoutMs: 5_000,
      secrets: {
        read: async (key) => secrets.get(key) ?? null,
        write: async (key, value) => {
          secrets.set(key, value);
        },
        delete: async (key) => {
          secrets.delete(key);
        },
      },
    });
    try {
      const pair = await requestJson<{ token: string }>({
        port: broker.port,
        path: "/provider-v1/pair",
        body: { reuse: true },
      });
      const headers = { authorization: `Bearer ${pair.body.token}` };
      await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const session = await broker.waitForSession();
      const providerOperationId = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-native-cancel-before-authorize"),
      );
      const controller = new AbortController();
      await session.sendExact(
        {
          type: "operation.send",
          providerOperationId,
          providerSessionId: ProviderSessionId.make(
            "provider-session-native-cancel-before-authorize",
          ),
          text: "cancel",
        },
        controller.signal,
      );
      const status = await requestJson<{ inputs: Array<{ id: string }> }>({
        port: broker.port,
        path: "/provider-v1/browser/status",
        headers,
        body: { operations: [], after: 0, wait: false },
      });
      const id = status.body.inputs[0]!.id;
      await expect(
        session.cancelExact(providerOperationId, controller.signal),
      ).resolves.toMatchObject({ state: "drained", terminalStatus: "cancelled" });
      const staleClaim = await requestJson({
        port: broker.port,
        path: "/provider-v1/browser/input",
        headers,
        body: { providerOperationId, id, owner: "1:document-test:0", conversationId: null },
      });
      expect(staleClaim.status).toBe(409);
    } finally {
      await broker.close();
    }
  });
});
