// @effect-diagnostics nodeBuiltinImport:off -- Route and remote bearer secrets are process-local only.
import * as NodeCrypto from "node:crypto";
import type * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import {
  HttpClient,
  HttpClientRequest,
  HttpRouter,
  HttpServerRequest,
  HttpServerResponse,
} from "effect/http";

export const PROVIDER_MCP_RELAY_ROUTE_PREFIX = "/api/provider-mcp";

export interface ProviderMcpPublication {
  readonly providerSessionId: string;
  readonly routeId: string;
  readonly routePath: string;
  readonly authorizationHeader: string;
}

export class ProviderMcpPublicationConflict extends Data.TaggedError(
  "ProviderMcpPublicationConflict",
)<{
  readonly providerSessionId: string;
}> {}

export interface ProviderMcpResolvedRoute {
  readonly providerSessionId: string;
  readonly routeId: string;
  readonly routePath: string;
  readonly remoteAuthorizationHeader: string;
  readonly remoteTokenHash: Buffer;
  readonly upstreamEndpoint: string;
  readonly providerAuthorizationHeader: string;
}

interface RelayState {
  readonly routes: ReadonlyMap<string, ProviderMcpResolvedRoute>;
  readonly routesByProviderSession: ReadonlyMap<string, string>;
}

export interface ProviderMcpRelayShape {
  readonly publish: (
    config: McpProviderSession.McpProviderSessionConfig,
  ) => Effect.Effect<ProviderMcpPublication, ProviderMcpPublicationConflict>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  /** Internal transport lookup. Remote callers never receive this route record. */
  readonly resolveRoute: (
    routeId: string,
    authorization: string | undefined,
  ) => Effect.Effect<ProviderMcpResolvedRoute | undefined>;
}

export class ProviderMcpRelay extends Context.Service<ProviderMcpRelay, ProviderMcpRelayShape>()(
  "t3/mcp/ProviderMcpRelay",
) {}

const routePath = (routeId: string) => `${PROVIDER_MCP_RELAY_ROUTE_PREFIX}/${routeId}/mcp`;

const hashToken = (token: string): Buffer =>
  NodeCrypto.createHash("sha256").update(token, "utf8").digest();

const sameHash = (left: Buffer, right: Buffer): boolean =>
  left.length === right.length && NodeCrypto.timingSafeEqual(left, right);

const parseBearer = (value: string | undefined): string | undefined => {
  const match = /^Bearer\s+(.+)$/iu.exec(value?.trim() ?? "");
  return match?.[1]?.trim() || undefined;
};

const newSecret = (bytes: number): string => NodeCrypto.randomBytes(bytes).toString("base64url");

const make = Effect.gen(function* () {
  const state = yield* Ref.make<RelayState>({
    routes: new Map(),
    routesByProviderSession: new Map(),
  });

  const publish: ProviderMcpRelayShape["publish"] = Effect.fn("ProviderMcpRelay.publish")(
    function* (config) {
      const current = yield* Ref.get(state);
      const existingRouteId = current.routesByProviderSession.get(config.providerSessionId);
      if (existingRouteId !== undefined) {
        const existing = current.routes.get(existingRouteId);
        if (
          existing !== undefined &&
          existing.upstreamEndpoint === config.endpoint &&
          existing.providerAuthorizationHeader === config.authorizationHeader
        ) {
          return {
            providerSessionId: existing.providerSessionId,
            routeId: existing.routeId,
            routePath: existing.routePath,
            authorizationHeader: existing.remoteAuthorizationHeader,
          };
        }
        return yield* new ProviderMcpPublicationConflict({
          providerSessionId: config.providerSessionId,
        });
      }

      const routeId = newSecret(24);
      const remoteToken = newSecret(32);
      const publication: ProviderMcpResolvedRoute = {
        providerSessionId: config.providerSessionId,
        routeId,
        routePath: routePath(routeId),
        remoteAuthorizationHeader: `Bearer ${remoteToken}`,
        remoteTokenHash: hashToken(remoteToken),
        upstreamEndpoint: config.endpoint,
        providerAuthorizationHeader: config.authorizationHeader,
      };
      yield* Ref.update(state, (current) => ({
        routes: new Map(current.routes).set(routeId, publication),
        routesByProviderSession: new Map(current.routesByProviderSession).set(
          config.providerSessionId,
          routeId,
        ),
      }));
      return {
        providerSessionId: publication.providerSessionId,
        routeId: publication.routeId,
        routePath: publication.routePath,
        authorizationHeader: publication.remoteAuthorizationHeader,
      };
    },
  );

  const revokeProviderSession: ProviderMcpRelayShape["revokeProviderSession"] = Effect.fn(
    "ProviderMcpRelay.revokeProviderSession",
  )(function* (providerSessionId) {
    yield* Ref.update(state, (current) => {
      const routeId = current.routesByProviderSession.get(providerSessionId);
      if (routeId === undefined) return current;
      const routes = new Map(current.routes);
      routes.delete(routeId);
      const routesByProviderSession = new Map(current.routesByProviderSession);
      routesByProviderSession.delete(providerSessionId);
      return { routes, routesByProviderSession };
    });
  });

  const resolveRoute = (routeId: string, authorization: string | undefined) =>
    Ref.get(state).pipe(
      Effect.map((current) => {
        const route = current.routes.get(routeId);
        const remoteToken = parseBearer(authorization);
        return route !== undefined && remoteToken !== undefined
          ? sameHash(route.remoteTokenHash, hashToken(remoteToken))
            ? route
            : undefined
          : undefined;
      }),
    );

  return ProviderMcpRelay.of({ publish, revokeProviderSession, resolveRoute });
});

const REQUEST_HEADER_ALLOWLIST = new Set([
  "accept",
  "content-type",
  "mcp-session-id",
  "mcp-protocol-version",
  "last-event-id",
]);

const RESPONSE_HEADER_DENYLIST = new Set([
  "connection",
  "content-encoding",
  "set-cookie",
  "transfer-encoding",
]);

const forwardHeaders = (
  request: HttpServerRequest.HttpServerRequest,
  providerAuthorizationHeader: string,
): Readonly<Record<string, string>> => {
  const headers: Record<string, string> = { authorization: providerAuthorizationHeader };
  for (const [name, value] of Object.entries(request.headers)) {
    if (!REQUEST_HEADER_ALLOWLIST.has(name) || value === undefined) continue;
    headers[name] = value;
  }
  return headers;
};

const proxyResponseHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
): Readonly<Record<string, string>> => {
  const forwarded: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (RESPONSE_HEADER_DENYLIST.has(name) || value === undefined) continue;
    forwarded[name] = value;
  }
  return forwarded;
};

const routeHandler = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const url = HttpServerRequest.toURL(request);
  if (url._tag === "None") return HttpServerResponse.text("Bad Request", { status: 400 });
  const match = /^\/api\/provider-mcp\/([A-Za-z0-9_-]{32})\/mcp$/u.exec(url.value.pathname);
  if (!match) return HttpServerResponse.text("Not Found", { status: 404 });
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "DELETE") {
    return HttpServerResponse.text("Method Not Allowed", { status: 405 });
  }

  const relay = yield* ProviderMcpRelay;
  const route = yield* relay.resolveRoute(match[1]!, request.headers.authorization);
  if (route === undefined) {
    return HttpServerResponse.text("Unauthorized", {
      status: 401,
      headers: { "www-authenticate": "Bearer" },
    });
  }

  const httpClient = HttpClient.withScope(yield* HttpClient.HttpClient);
  const upstreamRequest = HttpClientRequest.make(request.method)(route.upstreamEndpoint).pipe(
    HttpClientRequest.setHeaders(forwardHeaders(request, route.providerAuthorizationHeader)),
    request.method === "POST"
      ? HttpClientRequest.bodyStream(request.stream, {
          contentType: request.headers["content-type"],
        })
      : (self) => self,
  );
  return yield* httpClient.execute(upstreamRequest).pipe(
    Effect.map((response) => {
      const headers = proxyResponseHeaders(response.headers);
      return HttpServerResponse.stream(response.stream, {
        status: response.status,
        headers,
        ...(headers["content-type"] ? { contentType: headers["content-type"] } : {}),
      });
    }),
    // A committed MCP mutation may have succeeded before transport failure. The relay reports the
    // ambiguity to its caller and never retries it on the caller's behalf.
    Effect.orElseSucceed(() => HttpServerResponse.text("Bad Gateway", { status: 502 })),
  );
});

export const layer = Layer.effect(ProviderMcpRelay, make);

export const routeLayer = HttpRouter.add("*", `${PROVIDER_MCP_RELAY_ROUTE_PREFIX}/*`, routeHandler);

export const __testing = { make };
