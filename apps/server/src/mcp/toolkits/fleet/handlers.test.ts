// @effect-diagnostics anyUnknownInErrorContext:off globalErrorInEffectFailure:off
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";
import { FetchHttpClient } from "effect/http";

import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerExec from "../../../peer/PeerExec.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";
import * as ServerSelfUpdate from "../../../cloud/selfUpdate.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { FleetToolkit } from "./tools.ts";

const homeId = EnvironmentId.make("exec-home");
const peerId = EnvironmentId.make("exec-peer");
const threadId = ThreadId.make("exec-thread");

const threadShell = {
  id: threadId,
  projectId: "project",
  title: "Thread",
  providerInstanceId: ProviderInstanceId.make("codex"),
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  archivedAt: null,
  activeRunId: "run-1",
  deletedAt: null,
} as never;

const execResult = {
  execId: "exec-1",
  exitCode: 0,
  signal: null,
  timedOut: false,
  cancelled: false,
  durationMs: 1,
  stdoutTail: "ok",
  stderrTail: "",
  stdoutBytes: 2,
  stderrBytes: 0,
  truncated: false,
  cwd: "/tmp",
  platform: "linux",
  outputRetained: true,
} as const;

const capabilities = (overrides: Record<string, unknown> = {}) => ({
  parentThreadId: null,
  inheritedProviderInstanceId: null,
  inheritedModel: null,
  inheritedOptions: [],
  runtimeMode: "full-access",
  interactionMode: "default",
  providers: [],
  features: {
    appOwnedSubagents: true,
    asyncPolling: true,
    cancellation: true,
    batchThreadCreation: true,
    threadManagement: true,
    incrementalThreadRead: true,
    scheduledTasks: true,
    maxBatchThreads: 20,
  },
  contracts: ["peer-exec-v1"],
  remoteExecution: "full-access",
  ...overrides,
});

const layerToolkit = (
  input: {
    readonly enabled?: boolean;
    readonly peerCapabilities?: Record<string, unknown>;
    readonly seen?: Array<string>;
  } = {},
) =>
  McpHttpServer.toolkitRegistration(FleetToolkit, Handlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(PeerExec.PeerExec)({
        enabled: Effect.succeed(input.enabled ?? true),
        grant: Effect.succeed("full-access"),
        roots: Effect.succeed(["/tmp"]),
        run: () => Effect.succeed(execResult),
        cancel: () => Effect.succeed({ cancelled: true, state: "running" }),
        readFile: () =>
          Effect.succeed({
            path: "/tmp/a",
            size: 2,
            offset: 0,
            bytes: 2,
            encoding: "utf8",
            content: "ok",
            eof: true,
          }),
        list: () => Effect.succeed({ path: "/tmp", entries: [], nextCursor: null }),
        sweep: Effect.void,
      }),
    ),
    Layer.provide(
      Layer.mock(PeerMcpClient.PeerMcpClient)({
        call: (callInput) => {
          input.seen?.push(callInput.tool);
          if (callInput.tool === "orchestrator_capabilities") {
            return Effect.succeed(capabilities(input.peerCapabilities) as never) as never;
          }
          if (callInput.tool === "peer_exec") return Effect.succeed(execResult) as never;
          if (callInput.tool === "peer_fs_read") {
            return Effect.succeed({
              path: "/tmp/a",
              size: 2,
              offset: 0,
              bytes: 2,
              encoding: "utf8",
              content: "ok",
              eof: true,
            }) as never;
          }
          return Effect.fail(new Error("unexpected peer call")) as never;
        },
      }),
    ),
    Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
    Layer.provide(
      Layer.mock(ServerEnvironment.ServerEnvironment)({
        getEnvironmentId: Effect.succeed(homeId),
      }),
    ),
    Layer.provide(Layer.mock(ServerSelfUpdate.ServerSelfUpdate)({})),
    Layer.provide(
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(threadShell),
      }),
    ),
    Layer.provide(
      ServerSettings.ServerSettingsService.layerTest({
        executionTargetsEnabled: input.enabled ?? true,
      } as never),
    ),
    Layer.provide(FetchHttpClient.layer),
  );

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: homeId,
  requestNamespace: "exec-test",
  thread: {
    threadId,
    providerSessionId: "exec-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "exec-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "exec-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (
  server: McpServer.McpServer["Service"],
  name: string,
  args: Record<string, unknown>,
) =>
  server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("t3_shell runs at home through the local executor", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(server, "t3_shell", {
      target: "home",
      argv: [process.execPath, "-e", "0"],
      cwd: "/tmp",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({
      targetId: "home",
      environmentId: homeId,
      stdoutTail: "ok",
    });
  }).pipe(Effect.provide(layerToolkit())),
);

it.effect("t3_shell refuses a peer without peer-exec-v1", () => {
  const seen: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(server, "t3_shell", {
      target: peerId,
      argv: [process.execPath, "-e", "0"],
      cwd: "/tmp",
    });
    expect(failureOf(result)).toMatchObject({ code: "target_capability_missing" });
    expect(seen).toEqual(["orchestrator_capabilities"]);
  }).pipe(Effect.provide(layerToolkit({ peerCapabilities: { contracts: ["effort-v1"] }, seen })));
});

it.effect("t3_shell refuses a peer with remote execution off", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(server, "t3_shell", {
      target: peerId,
      argv: [process.execPath, "-e", "0"],
      cwd: "/tmp",
    });
    expect(failureOf(result)).toMatchObject({ code: "remote_approval_required" });
  }).pipe(Effect.provide(layerToolkit({ peerCapabilities: { remoteExecution: "off" } }))),
);

it.effect("t3_shell runs on a full-access peer after the capability probe", () => {
  const seen: Array<string> = [];
  return Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(server, "t3_shell", {
      target: peerId,
      argv: [process.execPath, "-e", "0"],
      cwd: "/tmp",
    });
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ targetId: String(peerId), stdoutTail: "ok" });
    expect(seen).toEqual(["orchestrator_capabilities", "peer_exec"]);
  }).pipe(Effect.provide(layerToolkit({ seen })));
});

it.effect("t3_fs_read runs at home and reads a peer", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const home = yield* call(server, "t3_fs_read", { target: "home", path: "/tmp/a" });
    expect(home.isError).toBe(false);
    expect(home.structuredContent).toMatchObject({ targetId: "home", content: "ok" });
    const peer = yield* call(server, "t3_fs_read", { target: peerId, path: "/tmp/a" });
    expect(peer.isError).toBe(false);
    expect(peer.structuredContent).toMatchObject({ targetId: String(peerId), content: "ok" });
  }).pipe(Effect.provide(layerToolkit())),
);

it.effect("execution targets off refuses t3_shell and t3_fs_read", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const shell = yield* call(server, "t3_shell", {
      target: "home",
      argv: [process.execPath, "-e", "0"],
      cwd: "/tmp",
    });
    expect(failureOf(shell)).toMatchObject({ code: "capability_denied" });
    const read = yield* call(server, "t3_fs_read", { target: "home", path: "/tmp/a" });
    expect(failureOf(read)).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerToolkit({ enabled: false }))),
);
