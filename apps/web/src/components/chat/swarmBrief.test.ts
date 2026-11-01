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
});
