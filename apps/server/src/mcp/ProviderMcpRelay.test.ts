// @effect-diagnostics nodeBuiltinImport:off -- This is a loopback network fixture for the relay boundary.
import * as NodeHttp from "node:http";
import { expect, it } from "@effect/vitest";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import { describe } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { FetchHttpClient, HttpClient, HttpClientResponse, HttpRouter } from "effect/http";

import * as ProviderMcpRelay from "./ProviderMcpRelay.ts";

const protocolVersion = "2025-06-18";

const listen = (server: NodeHttp.Server): Promise<number> =>
  new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address === null || typeof address === "string") return reject(new Error("missing port"));
      resolve(address.port);
    });
  });

const close = (server: NodeHttp.Server): Promise<void> =>
  new Promise((resolve, reject) =>
    server.close((error) => (error === undefined ? resolve() : reject(error))),
  );

const readBody = async (request: NodeHttp.IncomingMessage): Promise<Buffer> => {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
};

const writeJson = (
  response: NodeHttp.ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
) => {
  const bytes = Buffer.from(JSON.stringify(body));
  response.writeHead(status, {
    "content-type": "application/json",
    "content-length": String(bytes.length),
    ...headers,
  });
  response.end(bytes);
};

const rpcResult = (id: unknown, result: unknown) => ({ jsonrpc: "2.0", id, result });
const rpcError = (id: unknown, code: number, message: string) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message },
});

interface FakeScope {
  readonly threadId: string;
  readonly providerSessionId: string;
  readonly providerInstanceId: string;
}

const makeFakeT3 = () => {
  const tokens = new Map<string, FakeScope>();
  const sessions = new Map<string, FakeScope>();
  const effects = new Map<string, number>();
  let requests = 0;
  let lastAuthorization: string | undefined;

  const server = NodeHttp.createServer(async (request, response) => {
    requests += 1;
    lastAuthorization = request.headers.authorization;
    if (request.url !== "/mcp") return writeJson(response, 404, { error: "not_found" });
    const presented = request.headers.authorization?.replace(/^Bearer\s+/iu, "") ?? "";
    const scope = tokens.get(presented);
    if (scope === undefined) return writeJson(response, 401, { error: "invalid_token" });

    const sessionId = request.headers["mcp-session-id"];
    if (request.method === "DELETE") {
      if (typeof sessionId !== "string" || !sessions.has(sessionId)) {
        return writeJson(response, 404, { error: "unknown_session" });
      }
      sessions.delete(sessionId);
      response.writeHead(204);
      return response.end();
    }
    if (request.method !== "POST") return writeJson(response, 405, { error: "method_not_allowed" });

    let body: any;
    try {
      body = JSON.parse((await readBody(request)).toString("utf8"));
    } catch {
      return writeJson(response, 400, rpcError(null, -32700, "parse_error"));
    }
    if (body.method === "initialize") {
      const createdSessionId = `mcp-${scope.providerSessionId}`;
      sessions.set(createdSessionId, scope);
      return writeJson(
        response,
        200,
        rpcResult(body.id, {
          protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "t3-code", version: "s9-test" },
        }),
        { "mcp-session-id": createdSessionId },
      );
    }

    if (
      typeof sessionId !== "string" ||
      sessions.get(sessionId)?.providerSessionId !== scope.providerSessionId
    ) {
      return writeJson(response, 404, { error: "unknown_session" });
    }
    if (request.headers["mcp-protocol-version"] !== protocolVersion) {
      return writeJson(response, 400, { error: "missing_protocol_version" });
    }

    if (body.method === "tools/list") {
      return writeJson(
        response,
        200,
        rpcResult(body.id, {
          tools: [
            { name: "orchestrator_capabilities", inputSchema: { type: "object" } },
            { name: "delegate_task", inputSchema: { type: "object" } },
            { name: "task_status", inputSchema: { type: "object" } },
            { name: "scope_probe", inputSchema: { type: "object" } },
            { name: "mutate_once", inputSchema: { type: "object" } },
            { name: "slow_probe", inputSchema: { type: "object" } },
          ],
        }),
      );
    }
    if (body.method !== "tools/call") {
      return writeJson(response, 200, rpcError(body.id, -32601, "method_not_found"));
    }

    if (body.params?.name === "scope_probe") {
      return writeJson(response, 200, rpcResult(body.id, { scope }));
    }
    if (body.params?.name === "mutate_once") {
      const clientRequestId = String(body.params.arguments?.clientRequestId ?? "");
      if (clientRequestId.length === 0) {
        return writeJson(response, 200, rpcError(body.id, -32602, "clientRequestId_required"));
      }
      const key = `${scope.providerSessionId}\0${clientRequestId}`;
      const prior = effects.get(key) ?? 0;
      if (prior === 0) effects.set(key, 1);
      if (body.params.arguments?.dropAfterCommit === true && prior === 0) {
        response.socket?.destroy();
        return;
      }
      return writeJson(response, 200, rpcResult(body.id, { applied: effects.get(key) }));
    }
    return writeJson(response, 200, rpcError(body.id, -32602, "unknown_tool"));
  });

  return {
    server,
    addToken: (token: string, scope: FakeScope) => tokens.set(token, scope),
    requests: () => requests,
    lastAuthorization: () => lastAuthorization,
    effectCount: (providerSessionId: string, clientRequestId: string) =>
      effects.get(`${providerSessionId}\0${clientRequestId}`) ?? 0,
  };
};

const config = (
  providerSessionId: string,
  token: string,
  endpoint: string,
): McpProviderSession.McpProviderSessionConfig => ({
  environmentId: EnvironmentId.make("environment-s9-relay"),
  threadId: ThreadId.make(`thread:${providerSessionId}`),
  providerSessionId,
  providerInstanceId: ProviderInstanceId.make("chatgpt-browser"),
  endpoint,
  authorizationHeader: `Bearer ${token}`,
  browserToolsAvailable: false,
  capabilities: new Set(["orchestration"]),
});

const parseJson = async (response: Response): Promise<any> => JSON.parse(await response.text());

describe("provider MCP relay", () => {
  it.live("preserves the 13-check relay semantics while exposing only T3 MCP authority", () =>
    Effect.gen(function* () {
      const fake = makeFakeT3();
      const upstreamPort = yield* Effect.promise(() => listen(fake.server));
      const relay = yield* ProviderMcpRelay.__testing.make;
      const { handler, dispose } = HttpRouter.toWebHandler(
        ProviderMcpRelay.routeLayer.pipe(
          Layer.provideMerge(Layer.succeed(ProviderMcpRelay.ProviderMcpRelay, relay)),
          Layer.provideMerge(FetchHttpClient.layer),
        ),
        { disableLogger: true },
      );

      try {
        const endpoint = `http://127.0.0.1:${upstreamPort}/mcp`;
        const providerTokenA = "provider-token-a";
        const providerTokenB = "provider-token-b";
        const scopeA: FakeScope = {
          threadId: "thread-a",
          providerSessionId: "provider-session-a",
          providerInstanceId: "chatgpt-browser",
        };
        const scopeB: FakeScope = {
          threadId: "thread-b",
          providerSessionId: "provider-session-b",
          providerInstanceId: "chatgpt-browser",
        };
        fake.addToken(providerTokenA, scopeA);
        fake.addToken(providerTokenB, scopeB);
        const publicationA = yield* relay.publish(
          config(scopeA.providerSessionId, providerTokenA, endpoint),
        );
        const publicationB = yield* relay.publish(
          config(scopeB.providerSessionId, providerTokenB, endpoint),
        );
        expect(publicationA.authorizationHeader).not.toContain(providerTokenA);
        expect(publicationA.routePath).not.toContain(providerTokenA);

        const request = (
          publication: ProviderMcpRelay.ProviderMcpPublication,
          body?: unknown,
          init: RequestInit = {},
        ) =>
          handler(
            new Request(`http://t3.test${publication.routePath}`, {
              method: body === undefined ? "DELETE" : "POST",
              ...init,
              headers: {
                authorization: publication.authorizationHeader,
                accept: "application/json, text/event-stream",
                ...(body === undefined ? {} : { "content-type": "application/json" }),
                ...init.headers,
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            }),
          );
        const initialize = Effect.fn(function* (
          publication: ProviderMcpRelay.ProviderMcpPublication,
          id: number,
        ) {
          const response = yield* Effect.promise(() =>
            request(publication, {
              jsonrpc: "2.0",
              id,
              method: "initialize",
              params: {
                protocolVersion,
                capabilities: {},
                clientInfo: { name: "s9-relay-test", version: "1" },
              },
            }),
          );
          const json = yield* Effect.promise(() => parseJson(response));
          expect(json.result.serverInfo.name).toBe("t3-code");
          expect(json.result.protocolVersion).toBe(protocolVersion);
          return response.headers.get("mcp-session-id")!;
        });
        const call = (
          publication: ProviderMcpRelay.ProviderMcpPublication,
          sessionId: string,
          id: number,
          name: string,
          args: Record<string, unknown> = {},
          init: RequestInit = {},
        ) =>
          Effect.promise(() =>
            request(
              publication,
              { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } },
              {
                ...init,
                headers: {
                  "mcp-session-id": sessionId,
                  "mcp-protocol-version": protocolVersion,
                  "x-t3-thread-id": "remote-selector-must-not-be-forwarded",
                  ...init.headers,
                },
              },
            ),
          );

        const beforeWrongAuth = fake.requests();
        const wrongAuth = yield* Effect.promise(() =>
          handler(
            new Request(`http://t3.test${publicationA.routePath}`, {
              method: "POST",
              headers: { authorization: "Bearer provider-token-a" },
              body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
            }),
          ),
        );
        expect(wrongAuth.status).toBe(401);
        expect(fake.requests()).toBe(beforeWrongAuth);

        const sessionA = yield* initialize(publicationA, 1);
        const listA = yield* Effect.promise(() =>
          request(
            publicationA,
            { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
            { headers: { "mcp-session-id": sessionA, "mcp-protocol-version": protocolVersion } },
          ),
        );
        const listedNames = (yield* Effect.promise(() => parseJson(listA))).result.tools.map(
          (tool: { name: string }) => tool.name,
        );
        expect(listedNames).toEqual(
          expect.arrayContaining(["orchestrator_capabilities", "delegate_task", "task_status"]),
        );
        expect(listedNames).not.toEqual(
          expect.arrayContaining(["core", "desktop", "plugins", "agents", "goal", "loop"]),
        );

        const sessionB = yield* initialize(publicationB, 3);
        const scopeFrom = (response: Response): Effect.Effect<FakeScope> =>
          Effect.promise(() => parseJson(response)).pipe(Effect.map((json) => json.result.scope));
        expect(yield* scopeFrom(yield* call(publicationA, sessionA, 4, "scope_probe"))).toEqual(
          scopeA,
        );
        expect(yield* scopeFrom(yield* call(publicationB, sessionB, 5, "scope_probe"))).toEqual(
          scopeB,
        );

        let cancellationSignal: AbortSignal | undefined;
        const cancellationClient = HttpClient.make((upstreamRequest, _url, signal) => {
          cancellationSignal = signal;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              upstreamRequest,
              new Response(
                new ReadableStream({
                  start(controller) {
                    controller.enqueue(new TextEncoder().encode("stream-open"));
                  },
                }),
                { status: 200, headers: { "content-type": "text/event-stream" } },
              ),
            ),
          );
        });
        const cancellationWeb = HttpRouter.toWebHandler(
          ProviderMcpRelay.routeLayer.pipe(
            Layer.provideMerge(Layer.succeed(ProviderMcpRelay.ProviderMcpRelay, relay)),
            Layer.provideMerge(Layer.succeed(HttpClient.HttpClient, cancellationClient)),
          ),
          { disableLogger: true },
        );
        try {
          const slow = yield* Effect.promise(() =>
            cancellationWeb.handler(
              new Request(`http://t3.test${publicationA.routePath}`, {
                method: "POST",
                headers: {
                  authorization: publicationA.authorizationHeader,
                  "content-type": "application/json",
                  "mcp-session-id": sessionA,
                  "mcp-protocol-version": protocolVersion,
                },
                body: JSON.stringify({
                  jsonrpc: "2.0",
                  id: 6,
                  method: "tools/call",
                  params: { name: "slow_probe", arguments: {} },
                }),
              }),
            ),
          );
          yield* Effect.promise(() => slow.body?.cancel() ?? Promise.resolve());
          expect(cancellationSignal?.aborted).toBe(true);
        } finally {
          yield* Effect.promise(() => cancellationWeb.dispose());
        }

        const beforeAmbiguous = fake.requests();
        const lost = yield* call(publicationA, sessionA, 7, "mutate_once", {
          clientRequestId: "stable-request-1",
          dropAfterCommit: true,
        });
        expect(lost.status).toBe(502);
        expect(fake.requests()).toBe(beforeAmbiguous + 1);
        expect(fake.effectCount(scopeA.providerSessionId, "stable-request-1")).toBe(1);
        const retry = yield* call(publicationA, sessionA, 8, "mutate_once", {
          clientRequestId: "stable-request-1",
        });
        expect(retry.status).toBe(200);
        expect(fake.effectCount(scopeA.providerSessionId, "stable-request-1")).toBe(1);

        yield* relay.revokeProviderSession(scopeA.providerSessionId);
        const revoked = yield* Effect.promise(() =>
          handler(
            new Request(`http://t3.test${publicationA.routePath}`, {
              method: "POST",
              headers: { authorization: publicationA.authorizationHeader },
              body: JSON.stringify({ jsonrpc: "2.0", id: 9, method: "ping" }),
            }),
          ),
        );
        expect(revoked.status).toBe(401);

        const providerTokenA2 = "provider-token-a2";
        const scopeA2 = { ...scopeA, providerSessionId: "provider-session-a2" };
        fake.addToken(providerTokenA2, scopeA2);
        const publicationA2 = yield* relay.publish(
          config(scopeA2.providerSessionId, providerTokenA2, endpoint),
        );
        expect(publicationA2.routeId).not.toBe(publicationA.routeId);
        const sessionA2 = yield* initialize(publicationA2, 10);
        expect(yield* scopeFrom(yield* call(publicationA2, sessionA2, 11, "scope_probe"))).toEqual(
          scopeA2,
        );
        expect(yield* scopeFrom(yield* call(publicationB, sessionB, 12, "scope_probe"))).toEqual(
          scopeB,
        );

        const deleted = yield* Effect.promise(() =>
          request(publicationA2, undefined, {
            method: "DELETE",
            headers: { "mcp-session-id": sessionA2, "mcp-protocol-version": protocolVersion },
          }),
        );
        expect(deleted.status).toBe(204);
        const reuseDeleted = yield* call(publicationA2, sessionA2, 13, "scope_probe");
        expect(reuseDeleted.status).toBe(404);

        const checks = {
          callerAuthorizationStripped: fake.lastAuthorization() === `Bearer ${providerTokenA2}`,
          providerAuthorizationInjected: fake.lastAuthorization() === `Bearer ${providerTokenA2}`,
          serverIdentityPreserved: true,
          toolDiscoveryPreserved:
            listedNames.includes("delegate_task") && listedNames.includes("task_status"),
          protocolAndSessionHeadersPreserved: true,
          cancellationPropagated: cancellationSignal?.aborted === true,
          relayDidNotAutoReplayAmbiguousMutation:
            fake.effectCount(scopeA.providerSessionId, "stable-request-1") === 1,
          stableClientRequestIdDedupedRetry:
            fake.effectCount(scopeA.providerSessionId, "stable-request-1") === 1,
          providerSessionRoutesIsolated: true,
          revokedRouteRejected: revoked.status === 401,
          replacementProviderSessionWorked: true,
          unrelatedProviderSessionSurvivedRotation: true,
          deleteTerminatedMcpSession: reuseDeleted.status === 404,
        };
        expect(Object.keys(checks)).toHaveLength(13);
        expect(Object.values(checks)).toEqual(Array.from({ length: 13 }, () => true));
      } finally {
        yield* Effect.promise(() => dispose());
        yield* Effect.promise(() => close(fake.server));
      }
    }),
  );

  it.effect("keeps one immutable route per provider session", () =>
    Effect.gen(function* () {
      const relay = yield* ProviderMcpRelay.__testing.make;
      const first = yield* relay.publish(
        config("provider-session", "provider-token", "http://a.test/mcp"),
      );
      const repeated = yield* relay.publish(
        config("provider-session", "provider-token", "http://a.test/mcp"),
      );
      expect(repeated).toEqual(first);
      const conflict = yield* Effect.flip(
        relay.publish(config("provider-session", "different-token", "http://a.test/mcp")),
      );
      expect(conflict._tag).toBe("ProviderMcpPublicationConflict");
    }),
  );
});
