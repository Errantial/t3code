import { describe, expect, it } from "vite-plus/test";

import { buildSwarmBriefPrompt } from "./swarmBrief";

describe("buildSwarmBriefPrompt", () => {
  it("embeds the brief verbatim and asks for one create_swarm launch", () => {
    const prompt = buildSwarmBriefPrompt({
      brief: "  Research three approaches and rank them.  ",
      maxAgents: null,
      isolation: "shared",
    });

    expect(prompt).toContain('"""\nResearch three approaches and rank them.\n"""');
    expect(prompt).toContain("ONE `create_swarm` call");
    expect(prompt).toContain("three to five members");
    expect(prompt).toContain('isolation: "shared"');
  });

  it("states an explicit agent cap and worktree isolation", () => {
    const prompt = buildSwarmBriefPrompt({
      brief: "Harden the release lane.",
      maxAgents: 5,
      isolation: "worktree",
    });

    expect(prompt).toContain("at most 5 members");
    expect(prompt).not.toContain("three to five members");
    expect(prompt).toContain('isolation: "worktree"');
  });

  it("version 2 has the decomposability gate and swarm_create, never create_swarm", () => {
    const prompt = buildSwarmBriefPrompt({
      brief: "Audit every package for unused exports.",
      maxAgents: null,
      isolation: "worktree",
      version: 2,
      wakePolicy: "batch",
      architectFullAccess: true,
    });
    expect(prompt).toContain("decide whether the work can run in parallel");
    expect(prompt).toContain("ONE `swarm_create` call");
    expect(prompt).not.toContain("create_swarm");
    for (const word of [
      "`map`",
      "`target.anyOf`",
      '"plan"',
      '"batch"',
      "`maxTotalTurns`",
      "`swarm_followup`",
      "`doneCriteria`",
      "`verify`",
    ]) {
      expect(prompt).toContain(word);
    }
  });

  it("version 2 suggests verify only when this thread is in full-access", () => {
    const prompt = buildSwarmBriefPrompt({
      brief: "Fix the flaky tests.",
      maxAgents: 3,
      isolation: "shared",
      version: 2,
      architectFullAccess: false,
    });
    expect(prompt).toContain("Do not add `verify`");
    expect(prompt).toContain("at most 3 members");
  });
});
