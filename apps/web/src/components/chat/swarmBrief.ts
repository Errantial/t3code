export type SwarmIsolation = "shared" | "worktree";

export interface SwarmBriefInput {
  readonly brief: string;
  /** A hard cap the architect must not exceed. Null lets the architect size the swarm. */
  readonly maxAgents: number | null;
  readonly isolation: SwarmIsolation;
}

export const SWARM_AGENT_LIMIT_OPTIONS = [3, 5, 8] as const;

/**
 * The message a swarm entry point sends. It asks the agent in the new thread to
 * design a roster and launch it with T3's orchestration tools, so the members
 * become ordinary child threads that the app already lists and opens.
 */
export function buildSwarmBriefPrompt(input: SwarmBriefInput): string {
  const brief = input.brief.trim();
  const budget =
    input.maxAgents === null
      ? "Let the work decide the size, but keep the swarm small: three to five members usually beats a large one. Never launch more than eight."
      : `Use at most ${input.maxAgents} members, and fewer when the work does not need them.`;
  const isolation =
    input.isolation === "worktree"
      ? 'Give every member its own worktree (`isolation: "worktree"`) so each works on an isolated checkout.'
      : 'Keep members in this thread\'s checkout (`isolation: "shared"`) unless one truly needs an isolated branch.';

  return [
    "Build and launch a swarm for this brief.",
    "",
    "You are the swarm architect. Turn the brief into a small team of T3 agents, then launch it.",
    "",
    "Brief:",
    '"""',
    brief,
    '"""',
    "",
    "Rules:",
    `- ${budget}`,
    "- Every member must do real work that advances the brief. Do not add agents just to look busy.",
    "- Call `orchestrator_capabilities` before choosing providers and models. Use only the provider instance ids and models it lists, and let a member inherit this thread's model when the work does not need a different one.",
    "- A member's task is self-contained: it does not see this conversation. Include the goal, the exact scope, the expected output, and where its results go.",
    `- ${isolation}`,
    "",
    "How to launch:",
    "1. Restate the outcome in one or two lines, then write the roster: role title, provider/model, and a one-line instruction for each member.",
    "2. Decide the hierarchy. Give the brief to one lead when the work needs coordination, and say who reports to whom. A member that should lead its own sub-team gets that instruction in its own task.",
    "3. Launch the whole roster in ONE `create_swarm` call, not one `delegate_task` call per member. Mark a member's `isolation` as `worktree` only when separate checkouts belong in the plan.",
    "4. After it returns, report the roster as a compact table with each member's role, provider/model, and thread link, plus the order the work will arrive in.",
    "5. End the turn after launching. The members run in parallel and their completion wakes this thread; do not wait or poll. When results arrive, integrate them and close the loop with the user.",
    "",
    "If the brief is genuinely ambiguous, ask one specific question before launching instead of guessing.",
  ].join("\n");
}
