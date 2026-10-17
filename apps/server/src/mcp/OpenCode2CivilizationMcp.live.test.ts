// @effect-diagnostics nodeBuiltinImport:off globalFetchInEffect:off unknownInEffectCatch:off anyUnknownInErrorContext:off globalErrorInEffectCatch:off globalErrorInEffectFailure:off globalTimers:off multipleEffectProvide:off -- Live qualification intentionally exercises a real OpenCode child process, loopback HTTP API, and bounded native timers.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";
import * as NodeFSP from "node:fs/promises";

import { NodeHttpServer } from "@effect/platform-node";
import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as NetAddress from "effect/net/NetAddress";
import * as SqlClient from "effect/sql/SqlClient";
import { HttpRouter, HttpServer } from "effect/http";
import * as FetchHttpClient from "effect/http/FetchHttpClient";

import * as ConfigService from "../civilization/ConfigService.ts";
import * as ContextService from "../civilization/ContextService.ts";
import * as KnowledgeService from "../civilization/KnowledgeService.ts";
import * as MailService from "../civilization/MailService.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as McpSessionRegistry from "./McpSessionRegistry.ts";
import * as McpToolAccessTestkit from "./McpToolAccess.testkit.ts";
import * as OpenCode2Client from "@t3tools/provider-opencode/server/v2/OpenCode2Client";

const ROOT = process.env.OPENCODE2_CIV_MCP_LIVE_ROOT ?? "";
const FREE_HOME = process.env.OPENCODE2_FREE_HOME ?? "";
const BIN = process.env.OPENCODE2_BIN ?? "";
const MODEL = process.env.OPENCODE2_MODEL ?? "opencode/mimo-v2.6-flash-free";
const MANAGED_PASSWORD = "opencode2-civ-live-password";

const environmentId = EnvironmentId.make("environment:opencode2-civ-mcp-live");
const projectId = ProjectId.make("project:opencode2-civ-mcp-live");
const senderThreadId = ThreadId.make("thread:opencode2-civ-mcp-sender");
const targetThreadId = ThreadId.make("thread:opencode2-civ-mcp-target");
const senderRunId = RunId.make("run:opencode2-civ-mcp-sender");
const instanceId = ProviderInstanceId.make("opencode-civ-live");
const token = "opencode2-civilization-live-token";

const candidateAdapter = {
  instanceId,
  driver: "opencode",
  getCivilizationCapability: () =>
    Effect.succeed({
      support: "full" as const,
      contextInjection: true,
      keyedContextReplacement: false,
      actionablePromptRefresh: true,
      providerContinuationRefresh: false,
      providerCommandRefresh: false,
      messaging: true,
      contextTransport: {
        kind: "opencode2.user_prompt",
        description: "Qualification candidate ordinary user prompt transport.",
        trust: "untrusted" as const,
      },
    }),
} as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

const database = SqlitePersistence.layerMemory;
const providers = Layer.succeed(
  ProviderAdapterRegistry.ProviderAdapterRegistryV2,
  ProviderAdapterRegistry.ProviderAdapterRegistryV2.of({
    get: () => Effect.succeed(candidateAdapter),
    list: () => Effect.succeed([instanceId]),
  }),
);
const config = ConfigService.layer.pipe(Layer.provide(database));
const mail = MailService.layer.pipe(Layer.provide(Layer.mergeAll(database, providers)));
const knowledge = KnowledgeService.layer.pipe(Layer.provide(database));
const context = ContextService.layer.pipe(
  Layer.provide(Layer.mergeAll(database, config, providers, mail)),
);

const senderShell = {
  ...McpToolAccessTestkit.liveThreadShell(senderThreadId, { activeRunId: senderRunId }),
  projectId,
  providerInstanceId: instanceId,
  modelSelection: { instanceId, model: MODEL },
};
const threads = Layer.mock(ThreadManagement.ThreadManagementService)({
  getThreadShell: (threadId) => Effect.succeed(threadId === senderThreadId ? senderShell : null),
});

const scope: McpInvocationContext.McpThreadInvocationScope = {
  environmentId,
  requestNamespace: "provider-session:opencode2-civ-live",
  thread: {
    threadId: senderThreadId,
    providerSessionId: "provider-session:opencode2-civ-live",
    providerInstanceId: instanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
};
const sessions = Layer.mock(McpSessionRegistry.McpSessionRegistry)({
  resolve: (presented) => Effect.succeed(presented === token ? scope : undefined),
});

const dependencies = Layer.mergeAll(database, config, providers, mail, knowledge, context, threads);
const mcpLayer = McpHttpServer.layerCivilizationToolkit.pipe(
  Layer.provide(dependencies),
  Layer.provideMerge(McpHttpServer.layerMcpTransport.pipe(Layer.provide(sessions))),
);

const registerManagedMcp = Effect.fn("OpenCode2CivilizationMcpLive.registerManagedMcp")(function* (
  baseUrl: string,
  endpoint: string,
) {
  const url = new URL(`/api/experimental/mcp/t3-civ-live`, baseUrl);
  url.searchParams.set("location[directory]", ROOT);
  const authorization = `Basic ${Buffer.from(`opencode:${MANAGED_PASSWORD}`, "utf8").toString("base64")}`;
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(url, {
        method: "PUT",
        headers: {
          Authorization: authorization,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          config: {
            type: "remote",
            url: endpoint,
            headers: { Authorization: `Bearer ${token}` },
            oauth: false,
          },
        }),
      }),
    catch: (cause) => cause,
  });
  if (response.status !== 204) {
    const body = yield* Effect.tryPromise({
      try: () => response.text(),
      catch: () => "",
    });
    return yield* Effect.die(
      new Error(`OpenCode MCP registration failed: ${response.status} ${body}`),
    );
  }
});

const managedRequest = Effect.fn("OpenCode2CivilizationMcpLive.managedRequest")(function* (
  baseUrl: string,
  pathname: string,
  init?: RequestInit,
) {
  const authorization = `Basic ${Buffer.from(`opencode:${MANAGED_PASSWORD}`, "utf8").toString("base64")}`;
  const response = yield* Effect.tryPromise({
    try: () =>
      fetch(new URL(pathname, baseUrl), {
        ...init,
        headers: {
          Authorization: authorization,
          ...(init?.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...init?.headers,
        },
      }),
    catch: (cause) => cause,
  });
  const body = yield* Effect.tryPromise({
    try: () => response.text(),
    catch: () => "",
  });
  if (!response.ok) {
    return yield* Effect.die(
      new Error(`OpenCode request failed: ${response.status} ${pathname} ${body}`),
    );
  }
  return body.length === 0 ? undefined : (JSON.parse(body) as unknown);
});

const responseData = (value: unknown): unknown =>
  typeof value === "object" && value !== null && "data" in value
    ? (value as { readonly data: unknown }).data
    : value;

const runManagedPrompt = Effect.fn("OpenCode2CivilizationMcpLive.runManagedPrompt")(function* (
  baseUrl: string,
  prompt: string,
) {
  const created = responseData(
    yield* managedRequest(baseUrl, "/api/session", {
      method: "POST",
      body: JSON.stringify({
        title: "OpenCode 2 Civilization MCP live qualification",
        location: { directory: ROOT },
        model: { providerID: "opencode", id: MODEL.replace(/^opencode\//u, "") },
      }),
    }),
  ) as { readonly id?: string };
  if (typeof created?.id !== "string") {
    return yield* Effect.die(new Error("OpenCode session.create did not return an id."));
  }
  yield* managedRequest(baseUrl, `/api/session/${encodeURIComponent(created.id)}/prompt`, {
    method: "POST",
    body: JSON.stringify({ text: prompt }),
  });
  for (let attempt = 0; attempt < 240; attempt += 1) {
    const messages = responseData(
      yield* managedRequest(
        baseUrl,
        `/api/session/${encodeURIComponent(created.id)}/message?order=asc&limit=100`,
      ),
    );
    if (Array.isArray(messages)) {
      const assistantText = messages
        .filter(
          (
            message,
          ): message is { readonly type: string; readonly content?: ReadonlyArray<unknown> } =>
            typeof message === "object" && message !== null && "type" in message,
        )
        .filter((message) => message.type === "assistant")
        .flatMap((message) => message.content ?? [])
        .flatMap((part) =>
          typeof part === "object" && part !== null && "text" in part
            ? [String((part as { readonly text: unknown }).text)]
            : [],
        )
        .join("\n");
      if (assistantText.includes("MCP_CIV_OK")) return assistantText;
      const idle = messages.some(
        (message) =>
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          (message as { readonly type: unknown }).type === "idle",
      );
      if (idle && assistantText.length > 0) return assistantText;
    }
    yield* Effect.sleep("500 millis");
  }
  return yield* Effect.die(new Error("Timed out waiting for managed OpenCode MCP prompt."));
});

const probeTcp = (port: number) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const script = [
          "$ErrorActionPreference='Stop'",
          "$client = New-Object System.Net.Sockets.TcpClient",
          `try { $client.Connect('127.0.0.1', ${port}); if (-not $client.Connected) { throw 'not connected' } } finally { $client.Dispose() }`,
        ].join("; ");
        NodeChildProcess.execFile(
          "powershell.exe",
          ["-NoProfile", "-Command", script],
          { timeout: 10_000 },
          (error, stdout, stderr) =>
            error === null
              ? resolve()
              : reject(new Error(`TCP probe failed: ${error.message}\n${stdout}\n${stderr}`)),
        );
      }),
    catch: (cause) => cause,
  });

const probeMcpInitialize = (endpoint: string) =>
  Effect.tryPromise({
    try: () =>
      new Promise<void>((resolve, reject) => {
        const payload = JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2025-06-18",
            capabilities: {},
            clientInfo: { name: "opencode2-civilization-live-probe", version: "1" },
          },
        });
        NodeChildProcess.execFile(
          "curl.exe",
          [
            "--fail-with-body",
            "--silent",
            "--show-error",
            "--max-time",
            "10",
            "--request",
            "POST",
            endpoint,
            "--header",
            `Authorization: Bearer ${token}`,
            "--header",
            "Accept: application/json, text/event-stream",
            "--header",
            "Content-Type: application/json",
            "--data-binary",
            payload,
          ],
          { timeout: 15_000 },
          (error, stdout, stderr) => {
            if (error !== null) {
              reject(
                new Error(`MCP initialize probe failed: ${error.message}\n${stdout}\n${stderr}`),
              );
              return;
            }
            if (!String(stdout).includes('"protocolVersion":"2025-06-18"')) {
              reject(new Error(`Unexpected MCP initialize response: ${stdout}\n${stderr}`));
              return;
            }
            resolve();
          },
        );
      }),
    catch: (cause) => cause,
  });

const startManagedOpenCode = Effect.fn("OpenCode2CivilizationMcpLive.startManagedOpenCode")(
  function* () {
    const child = NodeChildProcess.spawn(BIN, ["serve", "--hostname=127.0.0.1", "--port=0"], {
      cwd: ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        HOME: FREE_HOME,
        XDG_CONFIG_HOME: NodePath.join(FREE_HOME, "config"),
        XDG_DATA_HOME: NodePath.join(FREE_HOME, "data"),
        XDG_STATE_HOME: NodePath.join(FREE_HOME, "state"),
        XDG_CACHE_HOME: NodePath.join(FREE_HOME, "cache"),
        OPENCODE_PASSWORD: MANAGED_PASSWORD,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        try {
          child.kill("SIGTERM");
        } catch {}
      }),
    );
    const baseUrl = yield* Effect.tryPromise({
      try: () =>
        new Promise<string>((resolve, reject) => {
          let buffered = "";
          const timeout = setTimeout(
            () => reject(new Error(`Timed out waiting for OpenCode server. ${buffered}`)),
            30_000,
          );
          const onData = (chunk: Buffer) => {
            buffered += chunk.toString("utf8");
            const match = /server listening on\s+(https?:\/\/\S+)/iu.exec(buffered);
            if (match?.[1] === undefined) return;
            clearTimeout(timeout);
            child.stdout.off("data", onData);
            resolve(match[1]);
          };
          child.stdout.on("data", onData);
          child.stderr.on("data", (chunk: Buffer) => {
            buffered += chunk.toString("utf8");
          });
        }),
      catch: (cause) => cause as Error,
    });
    return { baseUrl } as const;
  },
);

const seed = Effect.fn("OpenCode2CivilizationMcpLive.seed")(function* () {
  const sql = yield* SqlClient.SqlClient;
  const civilizationConfig = yield* ConfigService.CivilizationConfigService;
  yield* civilizationConfig.set({
    expectedRevision: 0,
    override: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { enabled: true },
      messaging: { enabled: true },
    },
  });
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'OpenCode 2 MCP live', ${ROOT}, '[]',
      '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL
    )
  `;
  for (const [threadId, name] of [
    [senderThreadId, "Sender Vale"],
    [targetThreadId, "Target Vale"],
  ] as const) {
    yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, provider_instance_id,
        runtime_mode, interaction_mode, active_provider_thread_id,
        created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, ${projectId}, ${name}, 'opencode', ${instanceId},
        'full-access', 'default', NULL,
        '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL, NULL, '{}'
      )
    `;
    yield* sql`
      INSERT INTO civilization_citizens (
        thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
        generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
        name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
        name_environment_revision, name_project_revision,
        profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
        profile_rich_label, profile_rich_traits_json, profile_rich_axiom, profile_rich_voice, profile_rich_style_text,
        profile_environment_revision, profile_project_revision,
        title_managed, preserved_title, last_managed_title, title_topic,
        pending_title_command_id, pending_managed_title, pending_title_topic,
        epoch, closed, deleted, revision, created_at, updated_at
      ) VALUES (
        ${threadId}, ${projectId}, NULL, NULL, ${threadId},
        0, 'resolved', 0, 1, 1,
        ${`name:${threadId}`}, 1, ${name}, ${name}, ${String(threadId)}, 'main',
        1, 0,
        'calm', 'Calm', '[]', '', 'profiles',
        'Stoic Architect', '["deliberate"]', 'Build carefully.', 'Measured.', 'Stay task-focused.',
        1, 0,
        0, ${name}, NULL, ${name}, NULL, NULL, NULL,
        0, 0, 0, 1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
      )
    `;
  }
  yield* sql`
    INSERT INTO orchestration_v2_projection_runs (
      run_id, thread_id, ordinal, provider, provider_instance_id, provider_thread_id,
      status, requested_at, completed_at, payload_json
    ) VALUES (
      ${senderRunId}, ${senderThreadId}, 1, 'opencode', ${instanceId}, NULL,
      'running', '2026-10-16T00:00:00.000Z', NULL, '{}'
    )
  `;
});

it.live.runIf(ROOT !== "" && FREE_HOME !== "" && BIN !== "")(
  "lets managed OpenCode 2 read the real Civilization census and durably send passive mail",
  () =>
    Effect.gen(function* () {
      yield* seed();
      yield* Effect.tryPromise(() => NodeFSP.mkdir(ROOT, { recursive: true }));
      yield* Effect.tryPromise(() =>
        NodeFSP.rm(NodePath.join(ROOT, "opencode.json"), { force: true }),
      );

      yield* HttpRouter.serve(mcpLayer, {
        disableListenLog: true,
        disableLogger: true,
      }).pipe(Layer.build);
      const server = yield* HttpServer.HttpServer;
      if (!NetAddress.isInetAddress(server.address)) {
        return yield* Effect.die(new Error("Expected TCP MCP test server"));
      }
      const loopbackHost = NetAddress.isUnspecified(server.address.address)
        ? "127.0.0.1"
        : NetAddress.formatUrlHostString(NetAddress.formatIp(server.address.address));
      const endpoint = `http://${loopbackHost}:${server.address.port}/mcp`;
      yield* probeTcp(server.address.port);
      yield* probeMcpInitialize(endpoint);

      const managed = yield* startManagedOpenCode();
      const opencode = yield* OpenCode2Client.make.pipe(Effect.provide(FetchHttpClient.layer));
      const api = yield* opencode.connect({ baseUrl: managed.baseUrl, password: MANAGED_PASSWORD });
      yield* api.client.server.info();
      yield* registerManagedMcp(managed.baseUrl, endpoint);
      const registered = yield* api.client.mcp.list({ location: { directory: ROOT } });
      assert.include(
        registered.data.map((entry) => entry.name),
        "t3-civ-live",
      );
      const prompt = [
        "Use only the T3 Civilization MCP tools for these two operations.",
        "First call civilization_census and confirm that Sender Vale and Target Vale are present.",
        `Then call civilization_mail_send with targetThreadId ${targetThreadId}, clientRequestId live-mcp-send-1, and body LIVE_MCP_HELLO.`,
        "Do not wake, steer, or otherwise contact the target. Reply exactly MCP_CIV_OK after both tool calls succeed.",
      ].join(" ");
      const result = yield* runManagedPrompt(managed.baseUrl, prompt);
      assert.include(result, "MCP_CIV_OK");

      const sql = yield* SqlClient.SqlClient;
      const messages = yield* sql<{
        readonly sender_thread_id: string;
        readonly recipient_thread_id: string;
        readonly body: string;
        readonly offer_count: number;
        readonly acknowledged_at: string | null;
        readonly terminal_at: string | null;
      }>`
        SELECT sender_thread_id, recipient_thread_id, body,
               offer_count, acknowledged_at, terminal_at
        FROM civilization_messages
        WHERE project_id = ${projectId}
      `;
      assert.deepEqual(messages, [
        {
          sender_thread_id: senderThreadId,
          recipient_thread_id: targetThreadId,
          body: "LIVE_MCP_HELLO",
          offer_count: 0,
          acknowledged_at: null,
          terminal_at: null,
        },
      ]);
    }).pipe(Effect.provide(dependencies), Effect.provide(NodeHttpServer.layerTest), Effect.scoped),
  180_000,
);
