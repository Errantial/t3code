import type { ScopedThreadRef } from "@t3tools/contracts";
import { useMemo } from "react";

import { deriveTokenThroughput, formatTokensPerSecond } from "~/lib/tokenThroughput";
import { useThreadProjection } from "../../state/entities";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { useThreadTokenRatePreference } from "./threadTokenRatePreference";

/**
 * Everything the tokens/sec feature needs from a thread ref: the opt-in, and the
 * last finished turn's rate read straight from the thread projection. Keeping
 * this out of ChatView/ChatComposer leaves those files with a single prop.
 */
export function useThreadTokenRate(threadRef: ScopedThreadRef | null | undefined) {
  const { enabled, setEnabled } = useThreadTokenRatePreference(threadRef ?? null);
  const providerTurns = useThreadProjection(enabled ? (threadRef ?? null) : null)?.projection
    .providerTurns;
  const throughput = useMemo(
    () => (enabled && providerTurns ? deriveTokenThroughput(providerTurns) : null),
    [enabled, providerTurns],
  );
  return { enabled, setEnabled, throughput };
}

/** Last finished turn's output rate; renders nothing when off or when the provider reported no complete total. */
export function ThreadTokenRateBadge(props: { threadRef: ScopedThreadRef | undefined }) {
  const { throughput } = useThreadTokenRate(props.threadRef);
  if (throughput === null) return null;
  const label = formatTokensPerSecond(throughput.tokensPerSecond);
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            data-slot="token-rate-badge"
            aria-label={`Last turn averaged ${label}`}
            className="shrink-0 cursor-default px-1 text-muted-foreground text-2xs tabular-nums"
          />
        }
      >
        {label}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {throughput.outputTokens.toLocaleString()} output tokens over{" "}
        {(throughput.elapsedMs / 1000).toFixed(1)}s, including tool time
      </TooltipPopup>
    </Tooltip>
  );
}

export function TokenRateToggleRow(props: {
  enabled: boolean;
  hasReading: boolean;
  onEnabledChange: (enabled: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <label className="flex items-center justify-between gap-3 text-2xs leading-4">
        <span className="text-secondary-label">Show tokens/sec</span>
        <Switch size="sm" checked={props.enabled} onCheckedChange={props.onEnabledChange} />
      </label>
      {props.enabled && !props.hasReading ? (
        <div className="text-pretty text-secondary-label text-2xs">
          No complete token total from the provider for the last turn.
        </div>
      ) : null}
    </div>
  );
}
