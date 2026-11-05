import { ThreadId } from "@t3tools/contracts";
import type {
  TurnContextContributor,
  TurnContextEntry,
} from "@t3tools/provider-core/server/turnContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import type * as SwarmStore from "./SwarmStore.ts";
import type { SwarmMemberSpec } from "./swarmPlanning.ts";

// Swarm v2 turn context (SW-A3c). `swarm_shared` carries what the architect wrote for every
// member: model-written, so untrusted. Its text is never logged.

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
