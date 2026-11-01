import { expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

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
