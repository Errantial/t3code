// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test-only temp WAL inspection uses the real Node filesystem.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Test-only temporary WAL path composition.
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";
import { ProviderSessionId, RunAttemptId } from "@t3tools/contracts";
import {
  ChatGptBrowserProviderV1EventSequence,
  ChatGptBrowserProviderV1ProtocolIdentity,
  chatGptBrowserProviderOperationIdForAttempt,
  type ChatGptBrowserProviderOperationId,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  makeDurableChatGptBrowserTransport,
  makeScopedChatGptBrowserHost,
  type ChatGptBrowserProviderBrowserObservation,
  type ChatGptBrowserProviderBrowserSession,
  type ScopedChatGptBrowserHostOptions,
} from "./runtime.ts";

const providerSessionId = ProviderSessionId.make("provider-session:provider-instance:test:shared");
const operationId = chatGptBrowserProviderOperationIdForAttempt(
  RunAttemptId.make("attempt-runtime-test"),
);

async function tempRoot(): Promise<string> {
  return fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "t3-chatgpt-browser-runtime-")));
}

function fakeBrowser() {
  const observations = new Map<string, ChatGptBrowserProviderBrowserObservation>();
  const waits = new Map<string, Set<() => void>>();
  const calls = {
    send: 0,
    cancel: 0,
    close: 0,
    sendContexts: [] as Array<{ readonly conversationId?: string } | undefined>,
  };
  let failNextSend = false;
  const wake = (id: string) => {
    for (const release of waits.get(id) ?? []) release();
    waits.delete(id);
  };
  const observe = (value: ChatGptBrowserProviderBrowserObservation) => {
    observations.set(value.providerOperationId, value);
    wake(value.providerOperationId);
  };
  const session: ChatGptBrowserProviderBrowserSession = {
    identity: Schema.decodeSync(ChatGptBrowserProviderV1ProtocolIdentity)({
      protocol: "provider-v1",
      version: 1,
      providerInstanceId: "provider-instance-test",
      browserInstanceId: "browser-instance-test",
      extensionVersion: "extension-test",
      extensionBuildId: "extension-build-test",
      ready: true,
      features: ["provider-v1-durable-authority"],
    }),
    sendExact: async (request, _signal, context) => {
      calls.send += 1;
      calls.sendContexts.push(context);
      if (failNextSend) {
        failNextSend = false;
        throw new Error("lost before exact browser receipt");
      }
      const existing = observations.get(request.providerOperationId);
      if (existing) return existing;
      const value: ChatGptBrowserProviderBrowserObservation = {
        providerOperationId: request.providerOperationId,
        state: "running",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
      };
      observations.set(request.providerOperationId, value);
      return value;
    },
    queryExact: async (id) => observations.get(id) ?? null,
    cancelExact: async (id) => {
      calls.cancel += 1;
      const current = observations.get(id);
      if (!current) throw new Error("unknown exact operation");
      const value: ChatGptBrowserProviderBrowserObservation = {
        ...current,
        state: "drained",
        terminalStatus: "cancelled",
      };
      observations.set(id, value);
      return value;
    },
    waitForChange: (id, signal) =>
      new Promise<void>((resolve, reject) => {
        if (signal.aborted) return reject(signal.reason);
        const finish = () => {
          signal.removeEventListener("abort", aborted);
          resolve();
        };
        const aborted = () => {
          waits.get(id)?.delete(finish);
          reject(signal.reason);
        };
        signal.addEventListener("abort", aborted, { once: true });
        const set = waits.get(id) ?? new Set<() => void>();
        set.add(finish);
        waits.set(id, set);
      }),
    close: async () => {
      calls.close += 1;
    },
  };
  return {
    session,
    observations,
    observe,
    calls,
    failNextSend: () => {
      failNextSend = true;
    },
  };
}

function options(
  root: string,
  browser: ReturnType<typeof fakeBrowser>,
  settled: Array<string>,
): ScopedChatGptBrowserHostOptions {
  return {
    assets: {
      prepare: async () => ({
        stateDirectory: root,
        hostIdentity: {
          target: "windows-x64",
          browserRevision: "browser-revision-test",
          providerReleaseVersion: "provider-release-test",
          extensionVersion: "extension-test",
        },
      }),
    },
    secrets: {
      read: async () => null,
      write: async () => undefined,
      delete: async () => undefined,
    },
    browser: { open: async () => browser.session },
    settlement: {
      settleBeforeDrain: async ({ providerOperationId }) => {
        settled.push(providerOperationId);
      },
    },
  };
}

const sendRequest = (id = operationId, session = providerSessionId, text = "hello provider") => ({
  type: "operation.send" as const,
  providerOperationId: id,
  providerSessionId: session,
  text,
});

describe("scoped in-process ChatGPT browser provider host", () => {
  it("uses one durable operation WAL, refuses provider-side queuing, and replays the same send exactly", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      const first = await Effect.runPromise(opened.transport.send(sendRequest()));
      const repeated = await Effect.runPromise(opened.transport.send(sendRequest()));
      expect(first).toMatchObject({
        providerOperationId: operationId,
        providerSessionId,
        state: "running",
      });
      expect(repeated).toEqual(first);
      expect(browser.calls.send).toBe(1);

      await expect(
        Effect.runPromise(
          opened.transport.send(sendRequest(operationId, providerSessionId, "changed")),
        ),
      ).rejects.toMatchObject({ code: "operation_conflict" });
      const other = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-runtime-other"),
      );
      await expect(
        Effect.runPromise(opened.transport.send(sendRequest(other))),
      ).rejects.toMatchObject({ code: "operation_conflict" });

      const names = await fs.readdir(path.join(root, "chatgpt-browser-provider-v1"));
      expect(names.filter((name) => name.endsWith(".json"))).toHaveLength(1);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reconciles an exact browser-terminal prior operation before enforcing the session fence", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));

      // The browser recovered/completed this exact operation after restart, but the server WAL
      // has not queried it yet and therefore still says running.
      browser.observe({
        providerOperationId: operationId,
        state: "drained",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
        terminalStatus: "completed",
        finalText: "recovered first",
      });

      const next = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-runtime-after-recovered-terminal"),
      );
      await Effect.runPromise(opened.transport.send(sendRequest(next)));

      expect(settled).toEqual([operationId]);
      expect(browser.calls.sendContexts).toEqual([
        undefined,
        { conversationId: "conversation-native" },
      ]);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("retires an exact never-authorized prior claim before enforcing the session fence", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      browser.failNextSend();
      await expect(Effect.runPromise(opened.transport.send(sendRequest()))).rejects.toThrow(
        "lost before exact browser receipt",
      );
      browser.observe({
        providerOperationId: operationId,
        state: "claimed",
        nativeIdentity: { conversationId: "conversation-native" },
        sendAuthorized: false,
      });

      const next = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-runtime-after-pre-send-orphan"),
      );
      await Effect.runPromise(opened.transport.send(sendRequest(next)));

      expect(browser.calls.cancel).toBe(1);
      expect(browser.calls.send).toBe(2);
      expect(settled).toEqual([operationId]);
      expect(browser.calls.sendContexts.at(-1)).toEqual({ conversationId: "conversation-native" });
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("keeps an authorized unacked prior claim fenced", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      browser.failNextSend();
      await expect(Effect.runPromise(opened.transport.send(sendRequest()))).rejects.toThrow(
        "lost before exact browser receipt",
      );
      browser.observe({
        providerOperationId: operationId,
        state: "claimed",
        nativeIdentity: { conversationId: "conversation-native" },
        sendAuthorized: true,
      });

      const next = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-runtime-after-authorized-unacked"),
      );
      await expect(
        Effect.runPromise(opened.transport.send(sendRequest(next))),
      ).rejects.toMatchObject({
        code: "operation_conflict",
      });

      expect(browser.calls.cancel).toBe(0);
      expect(browser.calls.send).toBe(1);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reconstructs final/terminal/drain once, waits on browser change, and preserves UTF-16 final semantics", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      const replay = Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: ChatGptBrowserProviderV1EventSequence.make(0),
        }),
      );

      browser.observe({
        providerOperationId: operationId,
        state: "drained",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
        terminalStatus: "completed",
        finalText: "a😀b",
      });

      const page = await replay;
      expect(page.events.map((event) => event.payload.type)).toEqual([
        "assistant.final",
        "operation.terminal",
        "operation.drained",
      ]);
      expect(page.highWater).toBe(3);
      expect(settled).toEqual([operationId]);
      expect(
        await Effect.runPromise(
          opened.transport.queryOperation({
            type: "operation.query",
            providerOperationId: operationId,
          }),
        ),
      ).toMatchObject({
        state: "drained",
        terminalStatus: "completed",
        terminalSequence: 2,
        drainedThrough: 3,
      });

      expect(
        await Effect.runPromise(
          opened.transport.readFinalContent({
            type: "assistant.read_final",
            providerOperationId: operationId,
            offset: 1,
            limit: 2,
          }),
        ),
      ).toMatchObject({
        text: "😀",
        totalLength: 4,
        complete: false,
        contentHash: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      await expect(
        Effect.runPromise(
          opened.transport.readFinalContent({
            type: "assistant.read_final",
            providerOperationId: operationId,
            offset: 2,
            limit: 2,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });

      // Re-querying/reopening observes the same browser truth but never appends a second terminal/drain.
      const reopened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      const stable = await Effect.runPromise(
        reopened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: ChatGptBrowserProviderV1EventSequence.make(0),
        }),
      );
      expect(stable).toEqual(page);
      expect(settled).toEqual([operationId]);
      await Effect.runPromise(reopened.close);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("seals a durable terminal after restart when exact browser ownership is gone", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      browser.observe({
        providerOperationId: operationId,
        state: "terminal",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
        terminalStatus: "completed",
        finalText: "final before restart",
        finalMessageId: "assistant-before-restart",
        assistantRevisions: [
          {
            itemId: "assistant-before-restart",
            order: 0,
            text: "final before restart",
          },
        ],
        toolRevisions: [
          {
            itemId: "tool-before-restart",
            order: 1,
            toolName: "read",
            status: "running",
          },
        ],
      });
      expect(
        await Effect.runPromise(
          opened.transport.queryOperation({
            type: "operation.query",
            providerOperationId: operationId,
          }),
        ),
      ).toMatchObject({ state: "terminal", terminalStatus: "completed" });
      expect(settled).toEqual([]);
      await Effect.runPromise(opened.close);

      const restartedBrowser = fakeBrowser();
      const reopened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, restartedBrowser, settled)).open,
      );
      expect(
        await Effect.runPromise(
          reopened.transport.queryOperation({
            type: "operation.query",
            providerOperationId: operationId,
          }),
        ),
      ).toMatchObject({ state: "drained", terminalStatus: "completed" });
      expect(settled).toEqual([operationId]);

      const page = await Effect.runPromise(
        reopened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: ChatGptBrowserProviderV1EventSequence.make(0),
        }),
      );
      expect(page.events.map((event) => event.payload.type)).toEqual([
        "assistant.revision",
        "tool.revision",
        "assistant.final",
        "operation.terminal",
        "operation.drained",
      ]);
      await Effect.runPromise(reopened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("sequences browser assistant replacements and tool upserts durably before final settlement", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      const nativeIdentity = {
        conversationId: "conversation-native",
        userMessageId: "user-message-native",
        providerTurnId: "provider-turn-native",
      };

      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-1", order: 0, text: "hel" }],
        toolRevisions: [{ itemId: "tool-1", order: 1, toolName: "web.run", status: "running" }],
      });
      const first = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: ChatGptBrowserProviderV1EventSequence.make(0),
        }),
      );
      expect(first.events.map((event) => event.payload)).toEqual([
        { type: "assistant.revision", itemId: "assistant-1", ordinal: 0, text: "hel" },
        {
          type: "tool.revision",
          itemId: "tool-1",
          ordinal: 1,
          toolName: "web.run",
          status: "running",
        },
      ]);

      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-1", order: 0, text: "hello" }],
        toolRevisions: [{ itemId: "tool-1", order: 1, toolName: "web.run", status: "completed" }],
      });
      const second = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: first.highWater,
        }),
      );
      expect(second.events.map((event) => event.payload)).toEqual([
        { type: "assistant.revision", itemId: "assistant-1", ordinal: 0, text: "hello" },
        {
          type: "tool.revision",
          itemId: "tool-1",
          ordinal: 1,
          toolName: "web.run",
          status: "completed",
        },
      ]);
      const compacted = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: ChatGptBrowserProviderV1EventSequence.make(0),
        }),
      );
      expect(compacted.highWater).toBe(4);
      expect(compacted.events.map((event) => [event.sequence, event.payload])).toEqual([
        [3, { type: "assistant.revision", itemId: "assistant-1", ordinal: 0, text: "hello" }],
        [
          4,
          {
            type: "tool.revision",
            itemId: "tool-1",
            ordinal: 1,
            toolName: "web.run",
            status: "completed",
          },
        ],
      ]);

      browser.observe({
        providerOperationId: operationId,
        state: "terminal",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-1", order: 0, text: "hello" }],
        toolRevisions: [{ itemId: "tool-1", order: 1, toolName: "web.run", status: "completed" }],
        finalText: "hello",
        finalMessageId: "assistant-1",
        terminalStatus: "completed",
      });
      const third = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: second.highWater,
        }),
      );
      expect(third.events.map((event) => event.payload.type)).toEqual([
        "assistant.final",
        "operation.terminal",
      ]);
      expect(third.events[0]?.payload).toMatchObject({
        type: "assistant.final",
        itemId: "assistant-1",
        ordinal: 0,
        contentLength: 5,
      });
      expect(third.highWater).toBe(6);
      expect(settled).toEqual([]);

      browser.observe({
        providerOperationId: operationId,
        state: "terminal",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-1", order: 0, text: "hello" }],
        toolRevisions: [
          { itemId: "tool-1", order: 1, toolName: "web.run", status: "completed" },
          { itemId: "late-page-tool", order: 2, toolName: "ChatGPT", status: "completed" },
          { itemId: "late-native-tool", order: 3, toolName: "read", status: "running" },
        ],
        finalText: "hello",
        finalMessageId: "assistant-1",
        terminalStatus: "completed",
      });
      const lateBeforeDrain = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: third.highWater,
        }),
      );
      expect(lateBeforeDrain.events.map((event) => event.payload)).toEqual([
        {
          type: "tool.revision",
          itemId: "late-page-tool",
          ordinal: 2,
          toolName: "ChatGPT",
          status: "completed",
        },
        {
          type: "tool.revision",
          itemId: "late-native-tool",
          ordinal: 3,
          toolName: "read",
          status: "running",
        },
      ]);
      expect(lateBeforeDrain.highWater).toBe(8);

      browser.observe({
        providerOperationId: operationId,
        state: "drained",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-1", order: 0, text: "hello" }],
        toolRevisions: [
          { itemId: "tool-1", order: 1, toolName: "web.run", status: "completed" },
          { itemId: "late-page-tool", order: 2, toolName: "ChatGPT", status: "completed" },
          { itemId: "late-native-tool", order: 3, toolName: "read", status: "running" },
        ],
        finalText: "hello",
        finalMessageId: "assistant-1",
        terminalStatus: "completed",
      });
      const drained = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: lateBeforeDrain.highWater,
        }),
      );
      expect(drained.events.map((event) => event.payload.type)).toEqual(["operation.drained"]);
      expect(drained.highWater).toBe(9);
      expect(settled).toEqual([operationId]);
      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-1", order: 0, text: "late stale rewrite" }],
        toolRevisions: [{ itemId: "late-tool", order: 1, toolName: "late", status: "completed" }],
      });
      const sealed = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: drained.highWater,
        }),
      );
      expect(sealed).toEqual({ providerOperationId: operationId, events: [], highWater: 9 });
      await Effect.runPromise(opened.close);

      const reopened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      const sealedAfterRestart = await Effect.runPromise(
        reopened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: drained.highWater,
        }),
      );
      expect(sealedAfterRestart).toEqual({
        providerOperationId: operationId,
        events: [],
        highWater: 9,
      });
      await Effect.runPromise(reopened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("preserves browser chronology when a lower-order tool is discovered after assistant text", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      const nativeIdentity = {
        conversationId: "conversation-native",
        userMessageId: "user-message-native",
        providerTurnId: "provider-turn-native",
      };
      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-late-order", order: 2, text: "working" }],
      });
      const assistantPage = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: ChatGptBrowserProviderV1EventSequence.make(0),
        }),
      );
      expect(assistantPage.events[0]?.payload).toMatchObject({
        type: "assistant.revision",
        ordinal: 2,
      });

      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity,
        assistantRevisions: [{ itemId: "assistant-late-order", order: 2, text: "working" }],
        toolRevisions: [
          { itemId: "tool-discovered-late", order: 1, toolName: "web.run", status: "running" },
        ],
      });
      const toolPage = await Effect.runPromise(
        opened.transport.replay({
          type: "events.replay",
          providerOperationId: operationId,
          after: assistantPage.highWater,
        }),
      );
      expect(toolPage.events[0]?.payload).toMatchObject({
        type: "tool.revision",
        itemId: "tool-discovered-late",
        ordinal: 1,
      });
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed before persisting an unbounded live revision set", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
        toolRevisions: Array.from({ length: 257 }, (_, index) => ({
          itemId: `tool-${index}`,
          order: index,
          toolName: "bounded-tool",
          status: "running" as const,
        })),
      });
      await expect(
        Effect.runPromise(
          opened.transport.replay({
            type: "events.replay",
            providerOperationId: operationId,
            after: ChatGptBrowserProviderV1EventSequence.make(0),
          }),
        ),
      ).rejects.toMatchObject({ code: "browser_unavailable" });
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("cancels by exact provider operation and seals drain only after the T3 settlement fence", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      const cancelled = await Effect.runPromise(
        opened.transport.cancel({ type: "operation.cancel", providerOperationId: operationId }),
      );
      expect(cancelled).toMatchObject({ state: "drained", terminalStatus: "cancelled" });
      expect(browser.calls.cancel).toBe(1);
      expect(settled).toEqual([operationId]);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("never re-sends a dispatched operation when browser ownership is ambiguous after restart", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      browser.failNextSend();
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await expect(Effect.runPromise(opened.transport.send(sendRequest()))).rejects.toMatchObject({
        code: "browser_unavailable",
      });
      expect(browser.calls.send).toBe(1);

      const reopened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await expect(Effect.runPromise(reopened.transport.send(sendRequest()))).rejects.toMatchObject(
        { code: "invalid_state" },
      );
      expect(browser.calls.send).toBe(1);
      await Effect.runPromise(reopened.close);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("fails closed when browser ownership survives but the durable provider WAL is missing", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    try {
      browser.observe({
        providerOperationId: operationId,
        state: "running",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
      });
      const transport = makeDurableChatGptBrowserTransport({
        stateDirectory: root,
        browser: browser.session,
        settlement: { settleBeforeDrain: async () => undefined },
      });

      await expect(
        Effect.runPromise(
          transport.queryOperation({
            type: "operation.query",
            providerOperationId: operationId,
          }),
        ),
      ).rejects.toMatchObject({ code: "invalid_state" });
      await expect(Effect.runPromise(transport.send(sendRequest()))).rejects.toMatchObject({
        code: "invalid_state",
      });
      expect(browser.calls.send).toBe(0);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("reuses the exact first-turn conversation for the next operation in one provider session", async () => {
    const root = await tempRoot();
    const browser = fakeBrowser();
    const settled: string[] = [];
    try {
      const opened = await Effect.runPromise(
        makeScopedChatGptBrowserHost(options(root, browser, settled)).open,
      );
      await Effect.runPromise(opened.transport.send(sendRequest()));
      browser.observe({
        providerOperationId: operationId,
        state: "drained",
        nativeIdentity: {
          conversationId: "conversation-native",
          userMessageId: "user-message-native",
          providerTurnId: "provider-turn-native",
        },
        terminalStatus: "completed",
        finalText: "first",
      });
      await Effect.runPromise(
        opened.transport.queryOperation({
          type: "operation.query",
          providerOperationId: operationId,
        }),
      );

      const second = chatGptBrowserProviderOperationIdForAttempt(
        RunAttemptId.make("attempt-runtime-second"),
      );
      await Effect.runPromise(opened.transport.send(sendRequest(second)));

      expect(browser.calls.sendContexts).toEqual([
        undefined,
        { conversationId: "conversation-native" },
      ]);
      await Effect.runPromise(opened.close);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
