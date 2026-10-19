import { createFileRoute } from "@tanstack/react-router";
import {
  type CivilizationContextInspectionOutcome,
  type CivilizationContextSuppressionReason,
  CivilizationMessageId,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";

import { CivilizationSettingsPanel } from "../components/settings/CivilizationSettings";
import {
  CIVILIZATION_ACTIVITY_MODES,
  CIVILIZATION_CONTEXT_MODES,
  CIVILIZATION_CONTEXT_OUTCOMES,
  CIVILIZATION_CONTEXT_SUPPRESSION_REASONS,
  CIVILIZATION_ONBOARDING_ADOPTIONS,
  CIVILIZATION_ONBOARDING_PRESETS,
  CIVILIZATION_ONBOARDING_STAGES,
  CIVILIZATION_ONBOARDING_TITLE_POLICIES,
  CIVILIZATION_SETTINGS_VIEWS,
  type CivilizationActivityMode,
  type CivilizationContextMode,
  type CivilizationHistoricalContextSearch,
  type CivilizationNavigationSearch,
  type CivilizationOnboardingAdoption,
  type CivilizationOnboardingStage,
  type CivilizationOnboardingTitlePolicy,
  type CivilizationSettingsView,
  mergeCivilizationNavigationSearch,
} from "../components/settings/civilizationNavigation";

const stringValue = (value: unknown) =>
  typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;

const enumValue = <Value extends string>(
  value: unknown,
  values: readonly Value[],
): Value | undefined =>
  typeof value === "string" && values.includes(value as Value) ? (value as Value) : undefined;

const positiveInteger = (value: unknown): number | undefined => {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 1 ? value : undefined;
  }
  if (typeof value !== "string") return undefined;
  const normalized = value.trim();
  if (!/^[1-9]\d*$/.test(normalized)) return undefined;
  const parsed = Number(normalized);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
};

export function parseCivilizationHistoricalContextSearch(
  raw: Record<string, unknown>,
): CivilizationHistoricalContextSearch | null {
  const contextThread = stringValue(raw.contextThread);
  const contextRun = stringValue(raw.contextRun);
  const contextAttempt = stringValue(raw.contextAttempt);
  const contextTurn = positiveInteger(raw.contextTurn);
  if (
    contextThread === undefined ||
    contextRun === undefined ||
    contextAttempt === undefined ||
    contextTurn === undefined
  ) {
    return null;
  }
  return {
    contextThread: ThreadId.make(contextThread),
    contextRun: RunId.make(contextRun),
    contextAttempt: RunAttemptId.make(contextAttempt),
    contextTurn,
  };
}

export function validateCivilizationSettingsSearch(
  raw: Record<string, unknown>,
): CivilizationNavigationSearch {
  const view = enumValue<CivilizationSettingsView>(raw.view, CIVILIZATION_SETTINGS_VIEWS);
  const activity =
    view === "activity"
      ? enumValue<CivilizationActivityMode>(raw.activity, CIVILIZATION_ACTIVITY_MODES)
      : undefined;
  const contextMode =
    view === "context"
      ? enumValue<CivilizationContextMode>(raw.contextMode, CIVILIZATION_CONTEXT_MODES)
      : undefined;
  const citizen = view === "citizens" ? stringValue(raw.citizen) : undefined;
  const lineage = view === "citizens" ? stringValue(raw.lineage) : undefined;
  const activityThread = view === "activity" ? stringValue(raw.activityThread) : undefined;
  const activitySource =
    view === "activity" && activity === "chronicle" ? stringValue(raw.activitySource) : undefined;
  const activityMessage =
    view === "activity" && activity === "messages" ? stringValue(raw.activityMessage) : undefined;
  const contextFilterThread =
    view === "context" && contextMode === "inspector"
      ? stringValue(raw.contextFilterThread)
      : undefined;
  const contextFilterProvider =
    view === "context" && contextMode === "inspector"
      ? stringValue(raw.contextFilterProvider)
      : undefined;
  const contextFilterOutcome =
    view === "context" && contextMode === "inspector"
      ? enumValue<CivilizationContextInspectionOutcome>(
          raw.contextFilterOutcome,
          CIVILIZATION_CONTEXT_OUTCOMES,
        )
      : undefined;
  const contextFilterSuppression =
    view === "context" && contextMode === "inspector"
      ? enumValue<CivilizationContextSuppressionReason>(
          raw.contextFilterSuppression,
          CIVILIZATION_CONTEXT_SUPPRESSION_REASONS,
        )
      : undefined;
  const contextFilterFrom =
    view === "context" && contextMode === "inspector"
      ? stringValue(raw.contextFilterFrom)
      : undefined;
  const contextFilterTo =
    view === "context" && contextMode === "inspector"
      ? stringValue(raw.contextFilterTo)
      : undefined;
  const onboarding =
    view === "configuration"
      ? enumValue<CivilizationOnboardingStage>(raw.onboarding, CIVILIZATION_ONBOARDING_STAGES)
      : undefined;
  const onboardingPreset =
    onboarding === undefined
      ? undefined
      : enumValue(raw.onboardingPreset, CIVILIZATION_ONBOARDING_PRESETS);
  const onboardingAdoption =
    onboarding === undefined
      ? undefined
      : enumValue<CivilizationOnboardingAdoption>(
          raw.onboardingAdoption,
          CIVILIZATION_ONBOARDING_ADOPTIONS,
        );
  const onboardingTitlePolicy =
    onboarding === undefined
      ? undefined
      : enumValue<CivilizationOnboardingTitlePolicy>(
          raw.onboardingTitlePolicy,
          CIVILIZATION_ONBOARDING_TITLE_POLICIES,
        );
  const historicalContext = parseCivilizationHistoricalContextSearch(raw);
  return {
    ...(view === undefined ? {} : { view }),
    ...(activity === undefined ? {} : { activity }),
    ...(contextMode === undefined ? {} : { contextMode }),
    ...(citizen === undefined ? {} : { citizen: ThreadId.make(citizen) }),
    ...(lineage === undefined ? {} : { lineage: ThreadId.make(lineage) }),
    ...(activityThread === undefined ? {} : { activityThread: ThreadId.make(activityThread) }),
    ...(activitySource === undefined ? {} : { activitySource }),
    ...(activityMessage === undefined
      ? {}
      : { activityMessage: CivilizationMessageId.make(activityMessage) }),
    ...(contextFilterThread === undefined
      ? {}
      : { contextFilterThread: ThreadId.make(contextFilterThread) }),
    ...(contextFilterProvider === undefined
      ? {}
      : { contextFilterProvider: ProviderInstanceId.make(contextFilterProvider) }),
    ...(contextFilterOutcome === undefined ? {} : { contextFilterOutcome }),
    ...(contextFilterSuppression === undefined ? {} : { contextFilterSuppression }),
    ...(contextFilterFrom === undefined ? {} : { contextFilterFrom }),
    ...(contextFilterTo === undefined ? {} : { contextFilterTo }),
    ...(onboarding === undefined ? {} : { onboarding }),
    ...(onboardingPreset === undefined ? {} : { onboardingPreset }),
    ...(onboardingAdoption === undefined ? {} : { onboardingAdoption }),
    ...(onboardingTitlePolicy === undefined ? {} : { onboardingTitlePolicy }),
    ...historicalContext,
  };
}

function SettingsCivilizationRoute() {
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
  const initialInspectionFilters =
    search.contextThread === undefined
      ? undefined
      : {
          threadId: search.contextThread,
          runId: search.contextRun,
          attemptId: search.contextAttempt,
          providerTurnOrdinal: search.contextTurn,
        };
  return (
    <CivilizationSettingsPanel
      search={search}
      initialInspectionFilters={initialInspectionFilters}
      onNavigate={(next, options) => {
        void navigate({
          search: (current) => mergeCivilizationNavigationSearch(current, next),
          replace: options?.replace ?? false,
          ...(options?.hash === undefined ? {} : { hash: options.hash }),
        });
      }}
    />
  );
}

export const Route = createFileRoute("/settings/civilization")({
  validateSearch: validateCivilizationSettingsSearch,
  component: SettingsCivilizationRoute,
});
