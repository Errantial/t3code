import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";

/** What a user confirms before cancelling a wake that carries swarm results (D12). */
export const SWARM_DETACH_CONFIRMATION =
  "This stops further swarm updates to this thread. Members keep running. Cancel this wake?";

/**
 * Whether a queued run is a completion wake for a cohort that carries a swarm: cancelling it
 * disposes the cohort, which detaches the swarm.
 */
export function queuedWakeCarriesSwarm(
  projection: Pick<OrchestrationV2ThreadProjection, "runs" | "messages"> | undefined,
  runId: RunId,
): boolean {
  if (projection === undefined) return false;
  const run = projection.runs.find((candidate) => candidate.id === runId);
  if (run === undefined) return false;
  const message = projection.messages.find((candidate) => candidate.id === run.userMessageId);
  const parentRunId = message?.delegatedCompletion?.parentRunId;
  if (parentRunId === undefined) return false;
  const anchor = projection.runs.find((candidate) => candidate.id === parentRunId);
  return (anchor?.delegatedCompletion?.swarmIds?.length ?? 0) > 0;
}
