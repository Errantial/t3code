import { ThreadId } from "@t3tools/contracts";
import type {
  TurnContextContributor,
  TurnContextEntry,
} from "@t3tools/provider-core/server/turnContext";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as SwarmStore from "./SwarmStore.ts";
import type { SwarmMemberSpec } from "./swarmPlanning.ts";

// Swarm v2 turn context. `swarm_member` (SW-A4) is the server's contract with a member:
// trusted, server-authored text only, at priority 95 so the total budget never cuts it.
// `swarm_shared` (SW-A3c) carries what the architect wrote for every member: model-written,
// so untrusted. Neither text is logged.

const SWARM_MEMBER_KEY = "swarm_member";
const SWARM_MEMBER_PRIORITY = 95;
const SWARM_MEMBER_MAX_BYTES = 2_048;

const SWARM_SHARED_KEY = "swarm_shared";
const SWARM_SHARED_PRIORITY = 105;
const SWARM_SHARED_MAX_BYTES = 20_480;

const decodeSpec = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

/**
 * The architect-written member fields, then the shared context last, so a byte cap that cuts
 * the entry only shortens the shared context (rev 3.2).
 */
export const formatSwarmShared = (input: {
  readonly spec: SwarmMemberSpec;
  readonly dataShape: string | null;
  readonly sharedContext: string | null;
}): string | undefined => {
  const { spec } = input;
  const lines: Array<string> = [];
  if (spec.role !== undefined) lines.push(`Role: ${spec.role}`);
  if (spec.doneCriteria !== undefined) lines.push(`Done when: ${spec.doneCriteria}`);
  if (spec.ownsPaths !== undefined && spec.ownsPaths.length > 0) {
    lines.push(`Paths you own: ${spec.ownsPaths.join(", ")}`);
  }
  if (spec.verifyArgv !== undefined)
    lines.push(`Verify command: ${JSON.stringify(spec.verifyArgv)}`);
  if (input.dataShape !== null) lines.push(`Shape of your result data: ${input.dataShape}`);
  if (input.sharedContext !== null)
    lines.push("Shared context from the architect:", input.sharedContext);
  return lines.length === 0 ? undefined : lines.join("\n");
};

const buildEntry = Effect.fn("SwarmTurnContext.buildShared")(function* (
  store: SwarmStore.SwarmStore["Service"],
  threadId: string,
) {
  const member = yield* store.findMemberByChildThread(ThreadId.make(threadId));
  if (Option.isNone(member)) return undefined;
  const swarm = yield* store.getSwarm(member.value.swarmId);
  const spec = decodeSpec(member.value.specJson);
  if (Option.isNone(swarm) || Option.isNone(spec)) return undefined;
  const text = formatSwarmShared({
    spec: spec.value as SwarmMemberSpec,
    dataShape: swarm.value.dataShape,
    sharedContext: swarm.value.sharedContext,
  });
  return text === undefined
    ? undefined
    : ({ key: SWARM_SHARED_KEY, trust: "untrusted", text } satisfies TurnContextEntry);
});

/** The block a member ends its final message with; SW-A5 parses the last one. */
const SWARM_RESULT_FENCE = "t3-swarm-result";

/** Server-authored only: nothing here comes from the architect or a member. */
export const formatSwarmMember = (input: {
  readonly planning: boolean;
  readonly verifies: boolean;
  readonly allowNestedSwarm: boolean;
  readonly hasDataShape: boolean;
}): string =>
  [
    "You are a member of a T3 swarm. Your task is your first message, and the swarm context holds what the architect shared with every member.",
    ...(input.planning
      ? ["You are a planning member: investigate and report; do not edit files."]
      : []),
    ...(input.verifies
      ? [
          "The server runs your verify command after you finish; the command is in the swarm context.",
        ]
      : []),
    input.allowNestedSwarm
      ? "You may start a swarm of your own for this task."
      : "Do not start a swarm of your own; delegate_task is fine.",
    ...(input.hasDataShape
      ? [
          "Put your findings in `data`, shaped as described in the swarm context. Keep `data` under 8 KB of JSON.",
        ]
      : []),
    "End your final message with:",
    "```" + SWARM_RESULT_FENCE,
    '{"summary": "...", "decisions": ["..."], "assumptions": ["..."], "data": <optional JSON>}',
    "```",
  ].join("\n");

const buildMemberEntry = Effect.fn("SwarmTurnContext.buildMember")(function* (
  store: SwarmStore.SwarmStore["Service"],
  threadId: string,
) {
  const member = yield* store.findMemberByChildThread(ThreadId.make(threadId));
  if (Option.isNone(member)) return undefined;
  const swarm = yield* store.getSwarm(member.value.swarmId);
  const spec = decodeSpec(member.value.specJson);
  if (Option.isNone(swarm) || Option.isNone(spec)) return undefined;
  const memberSpec = spec.value as SwarmMemberSpec;
  const interactionMode = member.value.effectiveInteractionMode ?? memberSpec.interactionCeiling;
  return {
    key: SWARM_MEMBER_KEY,
    trust: "trusted",
    text: formatSwarmMember({
      planning: interactionMode === "plan",
      verifies: memberSpec.verifyArgv !== undefined,
      allowNestedSwarm: memberSpec.allowNestedSwarm === true,
      hasDataShape: swarm.value.dataShape !== null,
    }),
  } satisfies TurnContextEntry;
});

/** The member contract; non-members get no entry. */
export const makeSwarmMemberContributor = (
  store: SwarmStore.SwarmStore["Service"],
): TurnContextContributor<{ readonly threadId: string }> => ({
  key: SWARM_MEMBER_KEY,
  trust: "trusted",
  priority: SWARM_MEMBER_PRIORITY,
  maxBytes: SWARM_MEMBER_MAX_BYTES,
  build: (turn): Effect.Effect<TurnContextEntry | undefined> =>
    buildMemberEntry(store, turn.threadId).pipe(Effect.orElseSucceed(() => undefined)),
});

/** Reads the turn's thread as a swarm member; non-members get no entry. */
export const makeSwarmSharedContributor = (
  store: SwarmStore.SwarmStore["Service"],
): TurnContextContributor<{ readonly threadId: string }> => ({
  key: SWARM_SHARED_KEY,
  trust: "untrusted",
  priority: SWARM_SHARED_PRIORITY,
  maxBytes: SWARM_SHARED_MAX_BYTES,
  build: (turn): Effect.Effect<TurnContextEntry | undefined> =>
    buildEntry(store, turn.threadId).pipe(Effect.orElseSucceed(() => undefined)),
});

const SWARM_NOTICES_KEY = "swarm_notices";
const SWARM_NOTICES_PRIORITY = 90;
const SWARM_NOTICES_MAX_BYTES = 4_096;

/** Server-authored notices about the architect's swarms, as one entry. */
const formatSwarmNotices = (notices: ReadonlyArray<{ readonly text: string }>): string =>
  ["Swarm updates since your last turn:", ...notices.map((notice) => `- ${notice.text}`)].join(
    "\n",
  );

const buildNoticesEntry = Effect.fn("SwarmTurnContext.buildNotices")(function* (
  store: SwarmStore.SwarmStore["Service"],
  threadId: string,
) {
  const notices = yield* store.takeNotices({
    parentThreadId: ThreadId.make(threadId),
    deliveredAt: DateTime.formatIso(yield* DateTime.now),
  });
  if (notices.length === 0) return undefined;
  return {
    key: SWARM_NOTICES_KEY,
    trust: "trusted",
    text: formatSwarmNotices(notices),
  } satisfies TurnContextEntry;
});

/**
 * The architect's pending swarm notices (Stop, detach, pauses, approvals, budget): delivered
 * once, with its next turn, so a notice never starts a turn of its own.
 */
export const makeSwarmNoticesContributor = (
  store: SwarmStore.SwarmStore["Service"],
): TurnContextContributor<{ readonly threadId: string }> => ({
  key: SWARM_NOTICES_KEY,
  trust: "trusted",
  priority: SWARM_NOTICES_PRIORITY,
  maxBytes: SWARM_NOTICES_MAX_BYTES,
  build: (turn): Effect.Effect<TurnContextEntry | undefined> =>
    buildNoticesEntry(store, turn.threadId).pipe(Effect.orElseSucceed(() => undefined)),
});
