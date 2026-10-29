import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Shorter turns are dominated by startup latency, so a rate would mislead. */
const MIN_ELAPSED_MS = 500;

export interface TokenThroughput {
  readonly tokensPerSecond: number;
  readonly outputTokens: number;
  readonly elapsedMs: number;
}

type ThroughputTurn = Pick<
  OrchestrationV2ProviderTurn,
  "status" | "startedAt" | "completedAt" | "turnTokenUsage"
>;

function toEpochMs(value: ThroughputTurn["startedAt"]): number | null {
  if (value === null) return null;
  const ms = DateTime.toEpochMillis(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Average output tokens per second over the thread's most recent finished
 * provider turn. Returns null whenever the provider did not report a complete
 * main-agent total, so the UI shows nothing instead of an estimate.
 *
 * Elapsed time is the whole turn (tools and waiting included), not pure
 * generation time. Turns with subagents are skipped because their wall time
 * overlaps work the main-agent token count does not cover.
 */
export function deriveTokenThroughput(
  turns: ReadonlyArray<ThroughputTurn>,
): TokenThroughput | null {
  let latest: { readonly startedMs: number; readonly turn: ThroughputTurn } | null = null;
  for (const turn of turns) {
    if (turn.status !== "completed") continue;
    const startedMs = toEpochMs(turn.startedAt);
    if (startedMs === null) continue;
    // Ties go to the later entry, matching latestProviderTurnTokenUsage.
    if (latest === null || startedMs >= latest.startedMs) latest = { startedMs, turn };
  }
  if (latest === null) return null;

  const usage = latest.turn.turnTokenUsage;
  if (usage === undefined || usage.usageStatus !== "complete" || usage.hasSubagents) return null;
  const completedMs = toEpochMs(latest.turn.completedAt);
  if (completedMs === null) return null;
  const elapsedMs = completedMs - latest.startedMs;
  if (elapsedMs < MIN_ELAPSED_MS || usage.outputTokens <= 0) return null;

  return {
    tokensPerSecond: usage.outputTokens / (elapsedMs / 1000),
    outputTokens: usage.outputTokens,
    elapsedMs,
  };
}

export function formatTokensPerSecond(tokensPerSecond: number): string {
  if (tokensPerSecond >= 100) return `${Math.round(tokensPerSecond)} tok/s`;
  return `${tokensPerSecond.toFixed(1)} tok/s`;
}
