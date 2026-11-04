import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, type PeerExecGrant } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerExec from "../../../peer/PeerExec.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as Handlers from "./handlers.ts";
import { PeerExecToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("peer-exec-environment");

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

const layerToolkit = (grant: PeerExecGrant = "full-access", enabled = true) =>
  McpHttpServer.toolkitRegistration(PeerExecToolkit, Handlers.layer).pipe(
    Layer.provideMerge(McpServer.McpServer.layer),
    Layer.provide(NodeCrypto.layer),
    Layer.provide(
      Layer.mock(PeerExec.PeerExec)({
        enabled: Effect.succeed(enabled),
        grant: Effect.succeed(grant),
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
    Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
  );

const scope = (input: {
  readonly linked: boolean;
  readonly access?: "read-only" | "full-access";
  readonly narrowed?: "approval-required";
}): McpInvocationContext.McpInvocationScope => ({
  environmentId,
  requestNamespace: "peer-exec-test",
  thread: undefined,
  client: {
    sessionId: "peer-session",
    label: "T3 Code - peer",
    access: input.access ?? "full-access",
    linked: input.linked,
    ...(input.narrowed === undefined
      ? {}
      : { narrowedTo: { runtimeMode: input.narrowed, interactionMode: "default" as const } }),
  },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
});

const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "peer-exec-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "peer-exec-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const call = (
  server: McpServer.McpServer["Service"],
  name: string,
  args: Record<string, unknown>,
  scopeValue: McpInvocationContext.McpInvocationScope,
) =>
  server
    .callTool({ name, arguments: args })
    .pipe(
      Effect.provideService(McpInvocationContext.McpInvocationContext, scopeValue),
      Effect.provideService(McpSchema.McpServerClient, client),
    );

const failureOf = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError && text?.type === "text" ? JSON.parse(text.text) : undefined;
};

it.effect("a non-linked client cannot use peer execution", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(
      server,
      "peer_exec",
      { execId: "exec-1", argv: [process.execPath, "-e", "0"], cwd: "/tmp" },
      scope({ linked: false }),
    );
    expect(failureOf(result)).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerToolkit())),
);

it.effect("a linked client with the grant off cannot execute or read", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const exec = yield* call(
      server,
      "peer_exec",
      { execId: "exec-1", argv: [process.execPath, "-e", "0"], cwd: "/tmp" },
      scope({ linked: true }),
    );
    expect(failureOf(exec)).toMatchObject({ code: "capability_denied" });
    const read = yield* call(server, "peer_fs_read", { path: "/tmp/a" }, scope({ linked: true }));
    expect(failureOf(read)).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerToolkit("off"))),
);

it.effect("read-only lets a linked client read but not run", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const read = yield* call(server, "peer_fs_read", { path: "/tmp/a" }, scope({ linked: true }));
    expect(read.isError).toBe(false);
    const exec = yield* call(
      server,
      "peer_exec",
      { execId: "exec-1", argv: [process.execPath, "-e", "0"], cwd: "/tmp" },
      scope({ linked: true }),
    );
    expect(failureOf(exec)).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerToolkit("read-only"))),
);

it.effect("an approval-required caller is refused before execution", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(
      server,
      "peer_exec",
      { execId: "exec-1", argv: [process.execPath, "-e", "0"], cwd: "/tmp" },
      scope({ linked: true, narrowed: "approval-required" }),
    );
    expect(failureOf(result)).toMatchObject({ code: "remote_approval_required" });
  }).pipe(Effect.provide(layerToolkit("auto"))),
);

it.effect("a full-access grant runs a linked caller's exec", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(
      server,
      "peer_exec",
      { execId: "exec-1", argv: [process.execPath, "-e", "0"], cwd: "/tmp" },
      scope({ linked: true }),
    );
    expect(result.isError).toBe(false);
    expect(result.structuredContent).toMatchObject({ stdoutTail: "ok", outputRetained: true });
  }).pipe(Effect.provide(layerToolkit("full-access"))),
);

it.effect("execution targets off refuses even a linked full-access caller", () =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const result = yield* call(
      server,
      "peer_exec",
      { execId: "exec-1", argv: [process.execPath, "-e", "0"], cwd: "/tmp" },
      scope({ linked: true }),
    );
    expect(failureOf(result)).toMatchObject({ code: "capability_denied" });
  }).pipe(Effect.provide(layerToolkit("full-access", false))),
);
