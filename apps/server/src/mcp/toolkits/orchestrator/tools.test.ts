import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Context from "effect/Context";
import { McpSchema, Tool } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";

import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

it("accepts a create_swarm roster and keeps member limits in the schema", () => {
  const decode = Schema.decodeUnknownExit(OrchestratorToolkit.tools.create_swarm.parametersSchema);
  const member = {
    key: "research-a",
    title: "Researcher: prior art",
    task: "Read the linked design notes and return the three strongest options.",
  };

  expect(Exit.isSuccess(decode({ title: "Prior art", members: [member] }))).toBe(true);
  expect(Exit.isSuccess(decode({ title: "Prior art", members: [] }))).toBe(false);
  expect(
    Exit.isSuccess(
      decode({
        title: "Prior art",
        members: Array.from({ length: 13 }, (_, index) => ({
          ...member,
          key: `member-${index}`,
        })),
      }),
    ),
  ).toBe(false);
});

it("hides the legacy create_swarm while Swarm v2 is on", () => {
  expect(
    Context.getOrUndefined(
      OrchestratorToolkit.tools.create_swarm.annotations,
      McpSchema.EnabledWhen,
    ),
  ).toBe(McpInvocationContext.hiddenWhileSwarmV2On);
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
});

it("accepts an optional effort on thread creation and on a send", () => {
  const createThreads = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.create_threads.parametersSchema,
  );
  const delegateTask = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.delegate_task.parametersSchema,
  );
  const createSwarm = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.create_swarm.parametersSchema,
  );
  const send = Schema.decodeUnknownExit(OrchestratorToolkit.tools.t3_thread_send.parametersSchema);

  // Each call is the JSON a client sends, so it is unknown until it decodes.
  const withoutEffort: unknown = {
    threads: [{ prompt: "Start.", target: { model: "claude-opus-5-5" } }],
  };
  const withEffort: unknown = {
    threads: [{ prompt: "Start.", target: { model: "claude-opus-5-5", effort: "max" } }],
  };
  const delegated: unknown = { task: "Do the thing.", target: { effort: "xhigh" } };
  const swarm: unknown = {
    title: "Prior art",
    members: [
      {
        key: "research-a",
        title: "Researcher: prior art",
        task: "Read the linked design notes and return the three strongest options.",
        target: { effort: "high" },
      },
    ],
  };
  const sendInput: unknown = { threadId: "thread:one", message: "Keep going." };

  // Omitted effort keeps today's input valid.
  expect(Exit.isSuccess(createThreads(withoutEffort))).toBe(true);
  expect(Exit.isSuccess(createThreads(withEffort))).toBe(true);
  expect(Exit.isSuccess(delegateTask(delegated))).toBe(true);
  expect(Exit.isSuccess(createSwarm(swarm))).toBe(true);
  expect(Exit.isSuccess(send(sendInput))).toBe(true);
  expect(Exit.isSuccess(send({ ...(sendInput as object), effort: "low" }))).toBe(true);
  // An empty level is not an effort.
  expect(Exit.isFailure(send({ ...(sendInput as object), effort: "" }))).toBe(true);
  expect(Exit.isFailure(send({ ...(sendInput as object), effort: 3 }))).toBe(true);
});
