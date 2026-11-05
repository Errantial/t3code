import { describe, expect, it } from "@effect/vitest";
import type { SwarmMap } from "@t3tools/contracts";

import { expandSwarmMap } from "./swarmMap.ts";

const map = (overrides: Partial<SwarmMap> = {}): SwarmMap => ({
  task: "Audit {{area}} in {{key}}.",
  title: "Audit {{key}}",
  rows: [
    { key: "web", vars: { area: "forms" } },
    { key: "server", vars: { area: "routes" }, ownsPaths: ["apps/server"] },
  ],
  ...overrides,
});

const members = (input: SwarmMap) => {
  const expanded = expandSwarmMap(input);
  if (!expanded.ok) throw new Error(expanded.message);
  return expanded.members;
};

const refusal = (input: SwarmMap) => {
  const expanded = expandSwarmMap(input);
  return expanded.ok ? undefined : expanded.message;
};

describe("expandSwarmMap", () => {
  it("fills placeholders per row, in row order, with the template's settings", () => {
    const expanded = members(map({ isolation: "worktree", interactionMode: "plan" }));
    expect(expanded.map((member) => [member.key, member.title, member.task])).toEqual([
      ["web", "Audit web", "Audit forms in web."],
      ["server", "Audit server", "Audit routes in server."],
    ]);
    expect(expanded.every((member) => member.isolation === "worktree")).toBe(true);
    expect(expanded[1]?.ownsPaths).toEqual(["apps/server"]);
    expect(expanded[0]?.ownsPaths).toBeUndefined();
  });

  it("names the row for an unknown placeholder or an unused var", () => {
    expect(refusal(map({ task: "Do {{missing}}." }))).toBe(
      "Map row 'web' has no var 'missing' for placeholder {{missing}}.",
    );
    expect(refusal(map({ rows: [{ key: "web", vars: { area: "forms", extra: "x" } }] }))).toBe(
      "Map row 'web' sets unused var 'extra'.",
    );
  });

  it("reads {{{{ as a literal {{ and passes other braces through", () => {
    const [member] = members(
      map({
        task: "Keep {{{{area}} and {single} and {{ and }} and {{not valid}} for {{area}}.",
        rows: [{ key: "web", vars: { area: "forms" } }],
      }),
    );
    expect(member?.task).toBe(
      "Keep {{area}} and {single} and {{ and }} and {{not valid}} for forms.",
    );
  });

  it("substitutes into each verify argv element without splitting it", () => {
    const [member] = members(
      map({
        verify: { argv: ["pnpm", "test", "--filter", "{{area}} and more"] },
        rows: [{ key: "web", vars: { area: "forms" } }],
      }),
    );
    expect(member?.verify?.argv).toEqual(["pnpm", "test", "--filter", "forms and more"]);
  });

  it("refuses a task or title too long after expansion", () => {
    expect(
      refusal(
        map({ task: "{{area}}", rows: [{ key: "web", vars: { area: "x".repeat(120_001) } }] }),
      ),
    ).toContain("Map row 'web' expands to a task of 120001 characters");
    expect(
      refusal(map({ title: "{{area}}", rows: [{ key: "web", vars: { area: "x".repeat(513) } }] })),
    ).toContain("Map row 'web' expands to a title of 513 characters");
  });
});
