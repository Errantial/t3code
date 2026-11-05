export type SwarmIsolation = "shared" | "worktree";
export type SwarmWakePolicy = "group" | "failure" | "batch";

export interface SwarmBriefInput {
  readonly brief: string;
  /** A hard cap the architect must not exceed. Null lets the architect size the swarm. */
  readonly maxAgents: number | null;
  readonly isolation: SwarmIsolation;
  /** 2 when the environment's Swarm v2 Labs setting is on: `swarm_create` and its rules. */
  readonly version?: 1 | 2;
  /** Version 2: when results wake the architect. */
  readonly wakePolicy?: SwarmWakePolicy;
  /** Version 2: verify needs full-access on the architect and every member. */
  readonly architectFullAccess?: boolean;
}

export const SWARM_AGENT_LIMIT_OPTIONS = [3, 5, 8] as const;

/**
 * The message a swarm entry point sends. It asks the agent in the new thread to
 * design a roster and launch it with T3's orchestration tools, so the members
 * become ordinary child threads that the app already lists and opens.
 */
export function buildSwarmBriefPrompt(input: SwarmBriefInput): string {
  if (input.version === 2) return buildSwarmBriefPromptV2(input);
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

const WAKE_POLICY_RULES: Readonly<Record<SwarmWakePolicy, string>> = {
  group: '`wakePolicy: "group"`: each member\'s result wakes you as it finishes.',
  failure:
    '`wakePolicy: "failure"`: failures wake you at once; the rest arrive together at the end.',
  batch: '`wakePolicy: "batch"`: results arrive in groups.',
};

/**
 * Version 2 (Swarm v2, SW-A10): the same architect role, launched with `swarm_create`, which
 * queues members beyond the caps and wakes this thread with compact digests.
 */
function buildSwarmBriefPromptV2(input: SwarmBriefInput): string {
  const brief = input.brief.trim();
  const budget =
    input.maxAgents === null
      ? "Size each wave at three to five members, and at most 12 in one call; larger list-shaped work goes in a `map`."
      : `Use at most ${input.maxAgents} members, and fewer when the work does not need them.`;
  const isolation =
    input.isolation === "worktree"
      ? 'Give every member that edits its own worktree (`isolation: "worktree"`).'
      : 'Keep members in this thread\'s checkout (`isolation: "shared"`) unless one truly needs an isolated branch; two shared writers each need `ownsPaths`.';
  const wakePolicy = input.wakePolicy ?? "group";
  const verify = input.architectFullAccess
    ? '- Give each member `doneCriteria`. When the project has tests, add a `verify` command from the project\'s own test script (argv, no shell; on Windows use `["cmd", "/c", ...]` for .cmd scripts). Verify needs full-access on this thread and every member.'
    : "- Give each member `doneCriteria`. Do not add `verify`: it needs this thread and every member in full-access, and this thread is not.";

  return [
    "Build and launch a swarm for this brief.",
    "",
    "You are the swarm architect. Turn the brief into a team of T3 agents, then launch it.",
    "",
    "Brief:",
    '"""',
    brief,
    '"""',
    "",
    "First, decide whether the work can run in parallel. Keep sequential work in one agent or a short chain; a swarm only helps when members can work independently.",
    "",
    "Rules:",
    `- ${budget}`,
    "- Every member must do real work that advances the brief. Do not add agents just to look busy.",
    "- Call `orchestrator_capabilities` before choosing providers and models. Use only the provider instance ids and models it lists. When it lists several instances of one driver with the same model, spread members with `target.anyOf`.",
    "- A member's task is self-contained: it does not see this conversation. Include the goal, the exact scope, the expected output, and its interface with other members.",
    `- ${isolation}`,
    "- Give each writer `ownsPaths`, and agree the interfaces between members up front.",
    verify,
    '- Use `interactionMode: "plan"` for audit, research, and review members; they do not edit.',
    "- For list-shaped work (files, packages, items), use `map` with `sharedContext` instead of repeating the same task.",
    '- For findings, set `dataShape` and have members return `data`; read it back with `swarm_collect` and `fields: ["data"]`.',
    `- ${WAKE_POLICY_RULES[wakePolicy]}${wakePolicy === "group" ? ' Above 8 members prefer `wakePolicy: "batch"`.' : ""}`,
    "- Set `maxTotalTurns` to a budget that fits the work.",
    "",
    "How to launch:",
    "1. Restate the outcome in one or two lines, then write the roster: role title, provider/model, and a one-line instruction for each member.",
    "2. Launch the roster in ONE `swarm_create` call. Members beyond the concurrency limits queue and start as slots free up, even after your turn ends.",
    "3. Report the roster briefly, then end the turn. Do not wait or poll: results wake this thread as digests.",
    "4. Read full results with `swarm_collect`. To correct one member, use `swarm_followup` rather than a new swarm; to run a failed one again, `swarm_retry`.",
    "",
    "If the brief is genuinely ambiguous, ask one specific question before launching instead of guessing.",
  ].join("\n");
}
