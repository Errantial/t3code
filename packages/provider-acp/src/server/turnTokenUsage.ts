import type { TurnTokenUsage } from "@t3tools/contracts";
import type * as EffectAcpSchema from "effect-acp/compat";

/**
 * Maps the usage an ACP agent reports for a finished prompt into T3's
 * normalized per-turn usage. ACP marks this field unstable and does not say
 * whether `outputTokens` already includes `thoughtTokens`, so a report that
 * carries thought tokens is only `partial`: the count is valid but may leave
 * the reasoning share out, and consumers such as the tokens/sec readout skip
 * partial totals rather than understate a rate.
 */
export function acpTurnTokenUsage(
  usage: EffectAcpSchema.Usage | null | undefined,
  hasSubagents: boolean,
): TurnTokenUsage | undefined {
  if (usage === null || usage === undefined) return undefined;
  const valid = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (!valid(usage.inputTokens) || !valid(usage.outputTokens)) return undefined;

  const common = {
    usageScope: "main_agent" as const,
    hasSubagents,
    ...(valid(usage.cachedReadTokens) ? { cachedInputTokens: usage.cachedReadTokens } : {}),
    ...(valid(usage.cachedWriteTokens) ? { cacheCreationTokens: usage.cachedWriteTokens } : {}),
    ...(valid(usage.thoughtTokens) ? { reasoningTokens: usage.thoughtTokens } : {}),
  };
  const mayExcludeThoughts = valid(usage.thoughtTokens) && usage.thoughtTokens > 0;
  return mayExcludeThoughts
    ? {
        ...common,
        usageStatus: "partial",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      }
    : {
        ...common,
        usageStatus: "complete",
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
      };
}
