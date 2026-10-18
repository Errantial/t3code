import type {
  CivilizationContextInspectionOutcome,
  CivilizationContextSuppressionReason,
} from "@t3tools/contracts";

export const CIVILIZATION_CONTEXT_OUTCOME_OPTIONS: ReadonlyArray<{
  readonly value: CivilizationContextInspectionOutcome;
  readonly label: string;
}> = [
  { value: "skipped", label: "Skipped" },
  { value: "built", label: "Built · provider start unresolved" },
  { value: "provider_start_accepted", label: "Provider start accepted" },
  { value: "provider_start_failed", label: "Provider start failed" },
];

export const CIVILIZATION_CONTEXT_SUPPRESSION_OPTIONS: ReadonlyArray<{
  readonly value: CivilizationContextSuppressionReason;
  readonly label: string;
}> = [
  { value: "participation_disabled", label: "Participation disabled" },
  { value: "emergency_off", label: "Emergency off" },
  { value: "citizen_not_adopted", label: "Citizen not adopted" },
  { value: "citizen_deleted", label: "Citizen deleted" },
  { value: "citizen_closed", label: "Citizen closed" },
  { value: "observed_agent_read_only", label: "Observed agent read only" },
  { value: "provider_unsupported", label: "Provider unsupported" },
  { value: "provider_continuation", label: "Provider continuation" },
  { value: "provider_command", label: "Provider command" },
  { value: "claude_provider_continuation", label: "Claude continuation" },
  { value: "claude_slash_command", label: "Claude slash command" },
  { value: "packet_budget_zero", label: "Packet budget zero" },
  { value: "packet_budget_too_small", label: "Packet budget too small" },
];

export function civilizationContextOutcomeLabel(
  outcome: CivilizationContextInspectionOutcome,
): string {
  return (
    CIVILIZATION_CONTEXT_OUTCOME_OPTIONS.find((option) => option.value === outcome)?.label ??
    outcome
  );
}

export function civilizationContextSuppressionLabel(
  reason: CivilizationContextSuppressionReason,
): string {
  return (
    CIVILIZATION_CONTEXT_SUPPRESSION_OPTIONS.find((option) => option.value === reason)?.label ??
    reason
  );
}
