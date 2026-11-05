import { useAtomSet, useAtomValue } from "@effect/atom-react";
import type { EnvironmentId, SwarmSummary, ThreadId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { Atom } from "effect/reactivity";
import { useEffect } from "react";

import { environmentPresentations } from "./presentation";
import { swarmSummariesCommand } from "./swarm";
import { useAtomCommand } from "./use-atom-command";

// Swarm v2 sidebar chip (SW-A10, rev 3.1): counts per architect thread, polled only for
// environments whose Swarm v2 Labs setting is on: every 10 s while the last answer had swarms,
// every 60 s otherwise. A server without the RPC answers "unknown request": that environment
// is treated as empty and not asked again this session.

const BUSY_POLL_MS = 10_000;
const IDLE_POLL_MS = 60_000;

export const swarmSummaryKey = (
  environmentId: EnvironmentId | string,
  threadId: ThreadId | string,
) => `${environmentId}\u0000${threadId}`;

/** The latest counts by environment and architect thread. */
const swarmSummariesAtom = Atom.make<ReadonlyMap<string, SwarmSummary>>(new Map()).pipe(
  Atom.keepAlive,
  Atom.withLabel("swarm-v2:summaries"),
);

/** "Swarm · N running · M queued · K failed", zero counts left out; null when all are zero. */
export function swarmChipLabel(summary: SwarmSummary | undefined): string | null {
  if (summary === undefined) return null;
  const parts = [
    summary.running > 0 ? `${summary.running} running` : null,
    summary.queued > 0 ? `${summary.queued} queued` : null,
    summary.failed > 0 ? `${summary.failed} failed` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : ["Swarm", ...parts].join(" · ");
}

/** One architect row's counts, so a row re-renders only when its own entry changes. */
export const swarmSummaryAtom = Atom.family((key: string) =>
  Atom.make((get) => get(swarmSummariesAtom).get(key)).pipe(
    Atom.withLabel(`swarm-v2:summary:${key}`),
  ),
);

export const nextSwarmPollDelay = (lastHadSwarms: boolean) =>
  lastHadSwarms ? BUSY_POLL_MS : IDLE_POLL_MS;

/** A server older than the RPC rejects it as an unknown request. */
export function isUnknownMethodFailure(failure: unknown): boolean {
  const text =
    failure instanceof Error
      ? failure.message
      : typeof failure === "string"
        ? failure
        : String(failure);
  return /unknown request tag/i.test(text);
}

/** Replaces one environment's entries with its latest answer. */
export function mergeSwarmSummaries(
  current: ReadonlyMap<string, SwarmSummary>,
  environmentId: EnvironmentId,
  summaries: ReadonlyArray<SwarmSummary>,
): ReadonlyMap<string, SwarmSummary> {
  const prefix = `${environmentId}\u0000`;
  const next = new Map([...current].filter(([key]) => !key.startsWith(prefix)));
  for (const summary of summaries)
    next.set(swarmSummaryKey(environmentId, summary.threadId), summary);
  return next;
}

const enabledEnvironmentIdsAtom = Atom.make((get) =>
  [...get(environmentPresentations.serverConfigsAtom)]
    .filter(([, config]) => config.settings.swarmV2Enabled === true)
    .map(([environmentId]) => environmentId)
    .toSorted()
    .join("\n"),
).pipe(Atom.withLabel("swarm-v2:enabled-environments"));

const unsupportedEnvironments = new Set<string>();

/** Mounted once by the sidebar: polls each Swarm v2 environment and fills swarmSummariesAtom. */
export function useSwarmSummariesPolling() {
  const enabledKey = useAtomValue(enabledEnvironmentIdsAtom);
  const setSummaries = useAtomSet(swarmSummariesAtom);
  const summariesCommand = useAtomCommand(swarmSummariesCommand, { reportFailure: false });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- the chip's counts come from an RPC per environment, polled; there is no atom stream for them.
  useEffect(() => {
    const environmentIds =
      enabledKey === "" ? [] : (enabledKey.split("\n") as Array<EnvironmentId>);
    // Environments that turned the flag off lose their chips.
    setSummaries(
      (current) =>
        new Map(
          [...current].filter(([key]) =>
            environmentIds.some((id) => key.startsWith(`${id}\u0000`)),
          ),
        ),
    );
    let cancelled = false;
    const timers: Array<ReturnType<typeof setTimeout>> = [];
    const poll = async (environmentId: EnvironmentId) => {
      if (cancelled || unsupportedEnvironments.has(environmentId)) return;
      const result = await summariesCommand({ environmentId });
      if (cancelled) return;
      let summaries: ReadonlyArray<SwarmSummary> = [];
      if (result._tag === "Success") {
        summaries = result.value.summaries;
      } else if (isUnknownMethodFailure(squashAtomCommandFailure(result))) {
        unsupportedEnvironments.add(environmentId);
      }
      setSummaries((current) => mergeSwarmSummaries(current, environmentId, summaries));
      if (unsupportedEnvironments.has(environmentId)) return;
      timers.push(
        setTimeout(() => void poll(environmentId), nextSwarmPollDelay(summaries.length > 0)),
      );
    };
    for (const environmentId of environmentIds) void poll(environmentId);
    return () => {
      cancelled = true;
      for (const timer of timers) clearTimeout(timer);
    };
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the command and setter are stable; the enabled environments select what to poll.
  }, [enabledKey]);
}
