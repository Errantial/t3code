import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  NodeId,
  OrchestratorMcpFailure,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const callerThreadId = ThreadId.make("thread:swarm-caller");
const codexInstanceId = ProviderInstanceId.make("codex");

const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:swarm-test"),
  requestNamespace: "mcp-provider-session-swarm",
  thread: {
    threadId: callerThreadId,
    providerSessionId: "mcp-provider-session-swarm",
    providerInstanceId: codexInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const delegatedResult = (
  input: OrchestratorMcpDelegateTaskInput,
  index: number,
): OrchestratorMcpDelegateTaskResult => ({
  taskId: NodeId.make(`task:swarm-${index}`),
  childThreadId: ThreadId.make(`thread:swarm-member-${index}`),
  childRunId: RunId.make(`run:swarm-member-${index}`),
  childNodeId: NodeId.make(`node:swarm-member-${index}`),
  status: "running",
  workState: "working",
  hasPendingChildRuns: false,
  latestTerminalRunId: null,
  latestTerminalStatus: null,
  latestTerminalSummary: null,
  latestTerminalResultContextTransferId: null,
  providerInstanceId: input.target?.providerInstanceId ?? codexInstanceId,
  model: input.target?.model ?? "gpt-5.4",
  summary: null,
  resultContextTransferId: null,
  hasPendingQuestion: false,
  pendingApproval: null,
  waitTimedOut: false,
});

const makeToolkit = (
  delegateTask: OrchestratorMcpService.OrchestratorMcpService["Service"]["delegateTask"],
) => {
  const layerDependencies = Layer.mergeAll(
    McpToolAccessTestkit.liveThreadsLayer,
    Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
    Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({ delegateTask }),
    Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({}),
  );
  return OrchestratorToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(OrchestratorHandlers.layer).pipe(
        Layer.provide(layerDependencies),
      ),
    ),
    Effect.map((toolkit) => ({ toolkit, layerDependencies })),
  );
};

it.effect("launches each swarm member as an async delegated child", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<OrchestratorMcpDelegateTaskInput>>([]);
    const { toolkit, layerDependencies } = yield* makeToolkit((_scope, input) =>
      Ref.updateAndGet(calls, (current) => [...current, input]).pipe(
        Effect.map((current) => delegatedResult(input, current.length - 1)),
      ),
    );

    const batches = yield* toolkit
      .handle("create_swarm", {
        title: "Release hardening",
        members: [
          {
            key: "research",
            title: "Researcher: prior art",
            task: "Read the release notes and list the risky areas.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-5.4" },
          },
          {
            key: "reviewer",
            title: "Reviewer: failure modes",
            task: "Stress-test the plan and name the failure modes.",
            isolation: "worktree",
          },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    expect(batches.at(-1)?.result).toMatchObject({
      title: "Release hardening",
      launched: [
        {
          key: "research",
          title: "Researcher: prior art",
          taskId: "task:swarm-0",
          childThreadId: "thread:swarm-member-0",
          status: "running",
          providerInstanceId: codexInstanceId,
          model: "gpt-5.4",
        },
        {
          key: "reviewer",
          title: "Reviewer: failure modes",
          taskId: "task:swarm-1",
          childThreadId: "thread:swarm-member-1",
          status: "running",
          model: "gpt-5.4",
        },
      ],
      failed: [],
    });
    const sent = yield* Ref.get(calls);
    expect(sent).toHaveLength(2);
    expect(sent.map((input) => input.mode)).toEqual(["async", "async"]);
    expect(sent[0]?.clientRequestId).toBe("mcp-provider-session-swarm:swarm:0:research");
    expect(sent[1]?.clientRequestId).toBe("mcp-provider-session-swarm:swarm:1:reviewer");
    expect(sent[1]?.isolation).toBe("worktree");
  }),
);

it.effect("passes each member's effort through to its delegated task", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<OrchestratorMcpDelegateTaskInput>>([]);
    const { toolkit, layerDependencies } = yield* makeToolkit((_scope, input) =>
      Ref.updateAndGet(calls, (current) => [...current, input]).pipe(
        Effect.map((current) => delegatedResult(input, current.length - 1)),
      ),
    );

    const batches = yield* toolkit
      .handle("create_swarm", {
        title: "Release hardening",
        members: [
          {
            key: "research",
            title: "Researcher: prior art",
            task: "Read the release notes and list the risky areas.",
            target: { providerInstanceId: codexInstanceId, model: "gpt-5.4", effort: "xhigh" },
          },
          {
            key: "reviewer",
            title: "Reviewer: failure modes",
            task: "Stress-test the plan and name the failure modes.",
          },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    expect(batches.at(-1)?.result).toMatchObject({ failed: [] });
    const sent = yield* Ref.get(calls);
    expect(sent.map((input) => input.target?.effort)).toEqual(["xhigh", undefined]);
    // The provider instance and model the member named travel with it.
    expect(sent[0]?.target).toMatchObject({
      providerInstanceId: codexInstanceId,
      model: "gpt-5.4",
    });
  }),
);

it.effect("keeps the rest of the swarm when one member fails to launch", () =>
  Effect.gen(function* () {
    let index = 0;
    const { toolkit, layerDependencies } = yield* makeToolkit((_scope, input) => {
      index += 1;
      if (input.title === "Reviewer: failure modes") {
        return Effect.fail(
          new OrchestratorMcpFailure({
            code: "model_unavailable",
            message: "That model is not available on this provider.",
          }),
        );
      }
      return Effect.succeed(delegatedResult(input, index));
    });

    const batches = yield* toolkit
      .handle("create_swarm", {
        title: "Release hardening",
        members: [
          {
            key: "research",
            title: "Researcher: prior art",
            task: "Read the release notes and list the risky areas.",
          },
          {
            key: "reviewer",
            title: "Reviewer: failure modes",
            task: "Stress-test the plan and name the failure modes.",
          },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    expect(batches.at(-1)?.result).toMatchObject({
      launched: [{ key: "research" }],
      failed: [
        {
          key: "reviewer",
          title: "Reviewer: failure modes",
          message: "That model is not available on this provider.",
        },
      ],
    });
  }),
);

it.effect("refuses a roster with a repeated member key", () =>
  Effect.gen(function* () {
    const { toolkit, layerDependencies } = yield* makeToolkit(() =>
      Effect.die("a repeated key must not launch anything"),
    );
    const batches = yield* toolkit
      .handle("create_swarm", {
        title: "Release hardening",
        members: [
          { key: "research", title: "One", task: "Do the first thing." },
          { key: "research", title: "Two", task: "Do the second thing." },
        ],
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));

    expect(batches.at(-1)?.result).toMatchObject({
      _tag: "OrchestratorMcpFailure",
      code: "invalid_request",
    });
  }),
);
