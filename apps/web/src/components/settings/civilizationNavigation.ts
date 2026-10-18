import type {
  CivilizationContextInspectionOutcome,
  CivilizationContextSuppressionReason,
  CivilizationMessageId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

export const CIVILIZATION_SETTINGS_VIEWS = [
  "overview",
  "citizens",
  "activity",
  "context",
  "configuration",
] as const;
export type CivilizationSettingsView = (typeof CIVILIZATION_SETTINGS_VIEWS)[number];

export const CIVILIZATION_ACTIVITY_MODES = ["chronicle", "messages", "notes"] as const;
export type CivilizationActivityMode = (typeof CIVILIZATION_ACTIVITY_MODES)[number];

export const CIVILIZATION_CONTEXT_MODES = ["analytics", "inspector"] as const;
export type CivilizationContextMode = (typeof CIVILIZATION_CONTEXT_MODES)[number];

export const CIVILIZATION_CONTEXT_OUTCOMES = [
  "skipped",
  "built",
  "provider_start_accepted",
  "provider_start_failed",
] as const satisfies readonly CivilizationContextInspectionOutcome[];

export const CIVILIZATION_CONTEXT_SUPPRESSION_REASONS = [
  "participation_disabled",
  "emergency_off",
  "citizen_not_adopted",
  "citizen_deleted",
  "citizen_closed",
  "observed_agent_read_only",
  "provider_unsupported",
  "provider_continuation",
  "provider_command",
  "claude_provider_continuation",
  "claude_slash_command",
  "packet_budget_zero",
  "packet_budget_too_small",
] as const satisfies readonly CivilizationContextSuppressionReason[];

export const CIVILIZATION_SETTINGS_VIEW_OPTIONS = [
  { value: "overview", label: "Overview", targetId: "civilization-status" },
  { value: "citizens", label: "Citizens", targetId: "civilization-citizens" },
  { value: "activity", label: "Activity", targetId: "civilization-chronicle" },
  { value: "context", label: "Context", targetId: "civilization-context-analytics" },
  { value: "configuration", label: "Configuration", targetId: "civilization-config" },
] as const satisfies ReadonlyArray<{
  readonly value: CivilizationSettingsView;
  readonly label: string;
  readonly targetId: string;
}>;

export const CIVILIZATION_ACTIVITY_MODE_OPTIONS = [
  { value: "chronicle", label: "Chronicle", targetId: "civilization-chronicle" },
  { value: "messages", label: "Correspondence", targetId: "civilization-retained-mail" },
  { value: "notes", label: "Notes", targetId: "civilization-notes" },
] as const satisfies ReadonlyArray<{
  readonly value: CivilizationActivityMode;
  readonly label: string;
  readonly targetId: string;
}>;

export const CIVILIZATION_CONTEXT_MODE_OPTIONS = [
  { value: "analytics", label: "Analytics", targetId: "civilization-context-analytics" },
  { value: "inspector", label: "Inspector", targetId: "civilization-context-inspector" },
] as const satisfies ReadonlyArray<{
  readonly value: CivilizationContextMode;
  readonly label: string;
  readonly targetId: string;
}>;

export interface CivilizationViewTarget {
  readonly view: CivilizationSettingsView;
  readonly activity?: CivilizationActivityMode | undefined;
  readonly contextMode?: CivilizationContextMode | undefined;
}

const CIVILIZATION_TARGET_VIEWS: Readonly<Record<string, CivilizationViewTarget>> = {
  "civilization-status": { view: "overview" },
  "civilization-citizens": { view: "citizens" },
  "civilization-lineage": { view: "citizens" },
  "civilization-chronicle": { view: "activity", activity: "chronicle" },
  "civilization-retained-mail": { view: "activity", activity: "messages" },
  "civilization-notes": { view: "activity", activity: "notes" },
  "civilization-context-analytics": { view: "context", contextMode: "analytics" },
  "civilization-context-inspector": { view: "context", contextMode: "inspector" },
  "civilization-names": { view: "configuration" },
  "civilization-personality": { view: "configuration" },
  "civilization-context": { view: "configuration" },
  "civilization-messaging": { view: "configuration" },
  "civilization-diagnostics": { view: "configuration" },
  "civilization-providers": { view: "configuration" },
  "civilization-config": { view: "configuration" },
  "civilization-data-retention": { view: "configuration" },
};

export function civilizationViewForTargetId(targetId: string): CivilizationViewTarget | null {
  const normalized = targetId.replace(/^#/, "");
  return CIVILIZATION_TARGET_VIEWS[normalized] ?? null;
}

export interface CivilizationHistoricalContextSearch {
  readonly contextThread: ThreadId;
  readonly contextRun: RunId;
  readonly contextAttempt: RunAttemptId;
  readonly contextTurn: number;
}

interface CivilizationNavigationSearchBase {
  readonly view?: CivilizationSettingsView | undefined;
  readonly activity?: CivilizationActivityMode | undefined;
  readonly contextMode?: CivilizationContextMode | undefined;
  readonly citizen?: ThreadId | undefined;
  readonly lineage?: ThreadId | undefined;
  readonly activityThread?: ThreadId | undefined;
  readonly activitySource?: string | undefined;
  readonly activityMessage?: CivilizationMessageId | undefined;
  readonly contextFilterThread?: ThreadId | undefined;
  readonly contextFilterProvider?: ProviderInstanceId | undefined;
  readonly contextFilterOutcome?: CivilizationContextInspectionOutcome | undefined;
  readonly contextFilterSuppression?: CivilizationContextSuppressionReason | undefined;
  readonly contextFilterFrom?: string | undefined;
  readonly contextFilterTo?: string | undefined;
}

type WithoutHistoricalContext = {
  readonly contextThread?: never;
  readonly contextRun?: never;
  readonly contextAttempt?: never;
  readonly contextTurn?: never;
};

export type CivilizationNavigationSearch = CivilizationNavigationSearchBase &
  (WithoutHistoricalContext | CivilizationHistoricalContextSearch);

export const CIVILIZATION_NAVIGATION_SEARCH_KEYS = [
  "view",
  "activity",
  "contextMode",
  "citizen",
  "lineage",
  "activityThread",
  "activitySource",
  "activityMessage",
  "contextFilterThread",
  "contextFilterProvider",
  "contextFilterOutcome",
  "contextFilterSuppression",
  "contextFilterFrom",
  "contextFilterTo",
  "contextThread",
  "contextRun",
  "contextAttempt",
  "contextTurn",
] as const;

const CIVILIZATION_NAVIGATION_SEARCH_KEY_SET = new Set<string>(CIVILIZATION_NAVIGATION_SEARCH_KEYS);

export function mergeCivilizationNavigationSearch(
  current: Readonly<Record<string, unknown>>,
  next: CivilizationNavigationSearch,
): Record<string, unknown> {
  const retained = Object.fromEntries(
    Object.entries(current).filter(([key]) => !CIVILIZATION_NAVIGATION_SEARCH_KEY_SET.has(key)),
  );
  const child = Object.fromEntries(Object.entries(next).filter(([, value]) => value !== undefined));
  return { ...retained, ...child };
}
