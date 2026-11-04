import {
  type EnvironmentId,
  type ProjectId,
  OrchestratorMcpFailure,
  OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpEnvironmentLinksResult,
  OrchestratorMcpThreadInterruptInput,
  OrchestratorMcpThreadInterruptResult,
  OrchestratorMcpThreadReadInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadWaitInput,
  OrchestratorMcpThreadWaitResult,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import type * as Tool from "effect/ai/Tool";

import { assertNotLinked } from "../mcp/linkOrigin.ts";
import * as McpInvocationContext from "../mcp/McpInvocationContext.ts";
import { readCaller, unavailable } from "../mcp/threadAccess.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as RepositoryIdentityResolver from "../project/RepositoryIdentityResolver.ts";
import * as PeerLinks from "./PeerLinks.ts";
import * as PeerMcpClient from "./PeerMcpClient.ts";

/**
 * A peer's `/mcp` holds a wait open for its whole timeout without sending
 * anything, and T3 Connect's edge drops a request idle for about 100 s, so a
 * forwarded wait goes out in pieces no longer than this.
 */
export const FORWARDED_WAIT_CHUNK_MS = 50_000;
const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;

type Scope = McpInvocationContext.McpInvocationScope;

/**
 * Runs T3 MCP tools in a linked environment for an agent here. The tool's own
 * declaration checks the agent here first; the linked environment then holds
 * the call to the link's access, narrowed to the agent's modes, which every
 * forwarded call carries.
 */
export class PeerForwarding extends Context.Service<
  PeerForwarding,
  {
    /**
     * Runs `tool` in the linked environment `environmentId` with `params`. A
     * `t3_thread_wait` goes in pieces short enough to survive any route.
     */
    readonly call: <T extends Tool.Any>(
      scope: Scope,
      tool: T,
      environmentId: EnvironmentId,
      params: Tool.Parameters<T>,
    ) => Effect.Effect<Tool.Success<T>, OrchestratorMcpFailure>;
    /** `t3_thread_read` there. */
    readonly readThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadReadInput,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /** `t3_thread_interrupt` there. */
    readonly interruptThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadInterruptInput,
    ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
    /** `t3_thread_wait` there, in pieces short enough to survive any route. */
    readonly waitForThread: (
      scope: Scope,
      environmentId: EnvironmentId,
      input: OrchestratorMcpThreadWaitInput,
    ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
    /** The environments this one links to, as an agent sees them. */
    readonly links: (
      scope: Scope,
    ) => Effect.Effect<OrchestratorMcpEnvironmentLinksResult, OrchestratorMcpFailure>;
  }
>()("t3/peer/PeerForwarding") {}

/** What an agent hears when it names another machine while the beta is off here. */
export const linkedEnvironmentsOff = new OrchestratorMcpFailure({
  code: "capability_denied",
  message:
    "Linked environments is off on this machine, so no tool can act on another machine. Leave out environmentId to work here; the user can turn it on in Settings → Labs.",
});

/** The linked environment a call names, or nothing when it names this one. */
export const remoteTarget = (scope: Scope, environmentId: EnvironmentId | undefined) =>
  environmentId === scope.environmentId ? undefined : environmentId;

/** A peer older than v1.2.0 has no `contracts`, so any effort cannot be honored there. */
const carriesEffort = (value: unknown, depth = 0): boolean => {
  if (value === null || typeof value !== "object" || depth > 4) return false;
  if (Array.isArray(value)) return value.some((entry) => carriesEffort(entry, depth + 1));
  const record = value as Record<string, unknown>;
  if (typeof record.effort === "string") return true;
  if (
    Array.isArray(record.options) &&
    record.options.some(
      (option) =>
        option !== null &&
        typeof option === "object" &&
        ["effort", "reasoningEffort", "thinking"].includes(String((option as { id?: unknown }).id)),
    )
  ) {
    return true;
  }
  return ["target", "modelSelection", "members", "threads"].some((key) =>
    carriesEffort(record[key], depth + 1),
  );
};

const make = Effect.gen(function* () {
  const peers = yield* PeerMcpClient.PeerMcpClient;
  const links = yield* PeerLinks.PeerLinks;
  const crypto = yield* Crypto.Crypto;
  const threads = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const repositoryIdentities = yield* RepositoryIdentityResolver.RepositoryIdentityResolver;

  /**
   * The caller's own limits, which travel with every forwarded call: the peer sees only the
   * link's credential, so a caller that may not control threads here is refused here. Work a
   * link started never uses this environment's links, since the peer would see this
   * environment's session instead of that link, and its fence could not hold.
   */
  const callerLimits = (scope: Scope) =>
    readCaller().pipe(
      Effect.tap((caller) => assertNotLinked(caller, "use this environment's links")),
      Effect.map((caller) => caller.limits),
      Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
      Effect.provideService(ThreadManagement.ThreadManagementService, threads),
    );

  /**
   * Every caller here reaches the peer as the one link session, so a retry
   * key is scoped to its caller before it leaves: two agents here reusing a
   * key never collide there, and one agent retrying gets its first result.
   */
  const scopedRequestId = (namespace: string, clientRequestId: string) =>
    crypto.digest("SHA-256", new TextEncoder().encode(`${namespace}\n${clientRequestId}`)).pipe(
      Effect.map((digest) => `fwd:${Hex.encode(digest)}`),
      Effect.orDie,
    );

  /**
   * A launch that names a project here but no explicit repository key travels
   * as that project's canonical repository key, never as a local id. An id the
   * peer owns is left alone; the peer refuses repository keys it cannot match.
   */
  const placeLaunch = Effect.fn("PeerForwarding.placeLaunch")(function* (
    scope: Scope,
    params: unknown,
  ) {
    // A caller without orchestration access is refused by the normal path;
    // do not touch project services before that check.
    if (!scope.capabilities.has("orchestration")) return params;
    const input = params as {
      readonly projectId?: ProjectId;
      readonly repositoryKey?: string;
      readonly scratch?: boolean;
    };
    if (input.repositoryKey !== undefined) {
      const { projectId: _projectId, ...rest } = input;
      return rest;
    }
    if (input.scratch === true) return input;
    let projectId = input.projectId;
    if (projectId === undefined && scope.thread !== undefined) {
      const shell = yield* threads
        .getThreadShell(scope.thread.threadId)
        .pipe(Effect.orElseSucceed(() => null));
      projectId = shell?.projectId;
    }
    if (projectId === undefined) return input;
    const looked = yield* Effect.result(projects.getById(projectId));
    if (looked._tag === "Failure") {
      return yield* new OrchestratorMcpFailure({
        code: "orchestration_error",
        message:
          "Could not read this project to resolve its repository key. Pass repositoryKey explicitly or retry.",
      });
    }
    if (Option.isNone(looked.success)) return input;
    const key = (yield* repositoryIdentities.resolve(looked.success.value.workspaceRoot))
      ?.canonicalKey;
    if (key === undefined) {
      return yield* new OrchestratorMcpFailure({
        code: "repository_identity_missing",
        message: "This project has no repository identity to match on the target. Pass projectId.",
      });
    }
    const { projectId: _projectId, ...rest } = input;
    return { ...rest, repositoryKey: key };
  });

  /** Tool and contract schemas are plain data: they encode and decode without services. */
  const forward = Effect.fn("PeerForwarding.forward")(function* <A>(
    scope: Scope,
    toolName: string,
    parameters: Schema.Top,
    success: Schema.Top,
    environmentId: EnvironmentId,
    params: unknown,
  ) {
    const limits = yield* callerLimits(scope);
    const encoded = (yield* Schema.encodeUnknownEffect(parameters as Schema.Encoder<unknown>)(
      params,
    ).pipe(Effect.mapError(unavailable))) as Record<string, unknown>;
    const { environmentId: _target, ...args } = encoded;
    // A pending upload lives here, so it cannot go with the call.
    if (Array.isArray(args.attachments) && args.attachments.length > 0) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "A launch in a linked environment cannot carry attachments yet.",
      });
    }
    if (typeof args.clientRequestId === "string") {
      args.clientRequestId = yield* scopedRequestId(scope.requestNamespace, args.clientRequestId);
    }
    return yield* peers.call({
      environmentId,
      tool: toolName,
      arguments: args,
      limits,
      success: success as Schema.Decoder<A>,
    });
  });

  const readThread: PeerForwarding["Service"]["readThread"] = (scope, environmentId, input) =>
    forward<OrchestratorMcpThreadReadResult>(
      scope,
      "t3_thread_read",
      OrchestratorMcpThreadReadInput,
      OrchestratorMcpThreadReadResult,
      environmentId,
      input,
    );

  const interruptThread: PeerForwarding["Service"]["interruptThread"] = (
    scope,
    environmentId,
    input,
  ) =>
    forward<OrchestratorMcpThreadInterruptResult>(
      scope,
      "t3_thread_interrupt",
      OrchestratorMcpThreadInterruptInput,
      OrchestratorMcpThreadInterruptResult,
      environmentId,
      input,
    );

  const waitForThread: PeerForwarding["Service"]["waitForThread"] = Effect.fn(
    "PeerForwarding.waitForThread",
  )(function* (scope, environmentId, input) {
    let remaining = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    let runId = input.runId;
    while (true) {
      const chunk = Math.min(remaining, FORWARDED_WAIT_CHUNK_MS);
      const result = yield* forward<OrchestratorMcpThreadWaitResult>(
        scope,
        "t3_thread_wait",
        OrchestratorMcpThreadWaitInput,
        OrchestratorMcpThreadWaitResult,
        environmentId,
        {
          threadId: input.threadId,
          ...(runId === undefined ? {} : { runId }),
          timeoutMs: chunk,
          ...(input.untilDelegatedWorkSettled === undefined
            ? {}
            : { untilDelegatedWorkSettled: input.untilDelegatedWorkSettled }),
        },
      );
      remaining -= chunk;
      if (!result.timedOut || remaining <= 0) return result;
      // Later pieces wait for the run the first one picked, not a newer one.
      runId = result.runId ?? undefined;
    }
  });

  // While the beta is off, agents start nothing over links. Tasks already running there keep
  // following through readThread, waitForThread and interruptThread, so they still finish.
  const requireEnabled = links.enabled.pipe(
    Effect.flatMap((enabled) => (enabled ? Effect.void : Effect.fail(linkedEnvironmentsOff))),
  );

  const call: PeerForwarding["Service"]["call"] = (scope, tool, environmentId, params) =>
    Effect.andThen(
      requireEnabled,
      Effect.gen(function* () {
        const placed =
          tool.name === "t3_thread_launch" ? yield* placeLaunch(scope, params) : params;
        const placedRepositoryKey =
          typeof (placed as { readonly repositoryKey?: unknown }).repositoryKey === "string"
            ? (placed as { readonly repositoryKey: string }).repositoryKey
            : undefined;
        if (carriesEffort(params) || placedRepositoryKey !== undefined) {
          const limits = yield* callerLimits(scope);
          const capabilities = yield* peers.call({
            environmentId,
            tool: "orchestrator_capabilities",
            arguments: {},
            limits,
            success: OrchestratorMcpCapabilitiesResult,
          });
          if (carriesEffort(params) && capabilities.contracts?.includes("effort-v1") !== true) {
            return yield* new OrchestratorMcpFailure({
              code: "target_capability_missing",
              message: `The linked environment ${environmentId} does not support effort; update it to a build with the effort-v1 contract or retry without effort.`,
            });
          }
          if (
            placedRepositoryKey !== undefined &&
            capabilities.contracts?.includes("thread-placement-v1") !== true
          ) {
            return yield* new OrchestratorMcpFailure({
              code: "target_capability_missing",
              message: `The linked environment ${environmentId} cannot place a thread by repository key. Update it to a build with the thread-placement-v1 contract, or pass projectId from t3_project_list there.`,
            });
          }
        }
        return yield* tool.name === "t3_thread_wait"
          ? (waitForThread(
              scope,
              environmentId,
              placed as OrchestratorMcpThreadWaitInput,
            ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>)
          : (forward(
              scope,
              tool.name,
              tool.parametersSchema,
              tool.successSchema,
              environmentId,
              placed,
            ) as Effect.Effect<Tool.Success<typeof tool>, OrchestratorMcpFailure>);
      }),
    );

  /**
   * The next step for an agent whose machine is not linked: without it, an
   * empty list reads as a dead end and agents go looking elsewhere.
   */
  const NOT_LISTED =
    "Not listed: not linked yet. Call t3_environment_link with a hint from the user's words.";

  const listLinks: PeerForwarding["Service"]["links"] = Effect.fn("PeerForwarding.listLinks")(
    function* (scope) {
      yield* callerLimits(scope);
      yield* requireEnabled;
      const listed = yield* links.list.pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
      return {
        environmentId: scope.environmentId,
        links: listed.map((link) => ({
          environmentId: link.environmentId,
          label: link.label,
          status: link.status,
          access: link.access,
          expiresAt: DateTime.formatIso(link.expiresAt),
          lastError: link.lastError,
        })),
        notListed: NOT_LISTED,
      };
    },
  );

  return PeerForwarding.of({
    call,
    readThread,
    interruptThread,
    waitForThread,
    links: listLinks,
  });
});

export const layer = Layer.effect(PeerForwarding, make);
