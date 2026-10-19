import type {
  CivilizationConfigOverride,
  CivilizationOnboardingPresetDefinition,
  CivilizationOnboardingPresetId,
  CivilizationOnboardingPreviewRequest,
  CivilizationOnboardingPreviewResult,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";

import type {
  CivilizationNavigationSearch,
  CivilizationOnboardingAdoption,
  CivilizationOnboardingStage,
  CivilizationOnboardingTitlePolicy,
} from "./civilizationNavigation";

export const CIVILIZATION_ONBOARDING_TARGET_ID = "civilization-onboarding";

export interface CivilizationOnboardingCandidate {
  readonly presetId: CivilizationOnboardingPresetId;
  readonly candidateOverride: CivilizationConfigOverride;
}

export interface CivilizationOnboardingChoices {
  readonly presetId: CivilizationOnboardingPresetId;
  readonly adoption: CivilizationOnboardingAdoption;
  readonly titlePolicy: CivilizationOnboardingTitlePolicy;
}

export function selectCivilizationOnboardingCandidate(
  presets: ReadonlyArray<CivilizationOnboardingPresetDefinition>,
  presetId: CivilizationOnboardingPresetId,
): CivilizationOnboardingCandidate | null {
  const preset = presets.find((candidate) => candidate.id === presetId);
  return preset === undefined
    ? null
    : { presetId: preset.id, candidateOverride: structuredClone(preset.candidateOverride) };
}

export function overlayCivilizationOnboardingChoices(
  candidate: CivilizationOnboardingCandidate,
  choices: Pick<CivilizationOnboardingChoices, "adoption" | "titlePolicy">,
): CivilizationOnboardingCandidate {
  return {
    ...candidate,
    candidateOverride: {
      ...candidate.candidateOverride,
      participation: {
        ...candidate.candidateOverride.participation,
        adoption: choices.adoption,
      },
      names: {
        ...candidate.candidateOverride.names,
        adoptionTitlePolicy: choices.titlePolicy,
      },
    },
  };
}

export function buildCivilizationOnboardingPreviewRequest(input: {
  readonly projectId: ProjectId;
  readonly candidate: CivilizationOnboardingCandidate;
  readonly threadId: ThreadId | null;
}): CivilizationOnboardingPreviewRequest {
  return input.threadId === null
    ? {
        previewKind: "configuration_only",
        projectId: input.projectId,
        candidateOverride: input.candidate.candidateOverride,
      }
    : {
        previewKind: "exact_existing_citizen",
        projectId: input.projectId,
        threadId: input.threadId,
        candidateOverride: input.candidate.candidateOverride,
      };
}

export function onboardingApplyBinding(
  projectId: ProjectId,
  candidate: CivilizationOnboardingCandidate,
  preview: CivilizationOnboardingPreviewResult,
) {
  if (preview.projectId !== projectId) return null;
  return {
    projectId,
    override: candidate.candidateOverride,
    expectedRevision: preview.projectRevision,
    expectedEnvironmentRevision: preview.environmentRevision,
  } as const;
}

export function onboardingPreviewMatchesCandidate(
  projectId: ProjectId,
  preview: CivilizationOnboardingPreviewResult | null,
): preview is CivilizationOnboardingPreviewResult {
  return preview !== null && preview.projectId === projectId;
}

export function onboardingCanReveal(
  preview: CivilizationOnboardingPreviewResult | null,
  threadId: ThreadId | null,
): boolean {
  return (
    preview !== null &&
    preview.previewKind === "exact_existing_citizen" &&
    preview.eligibility.exactContent &&
    threadId !== null
  );
}

export function isCivilizationOnboardingConflict(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "CivilizationConfigConflictError"
  );
}

export function civilizationOnboardingSafeSearch(input: {
  readonly stage?: CivilizationOnboardingStage | undefined;
  readonly presetId?: CivilizationOnboardingPresetId | undefined;
  readonly adoption?: CivilizationOnboardingAdoption | undefined;
  readonly titlePolicy?: CivilizationOnboardingTitlePolicy | undefined;
}): CivilizationNavigationSearch {
  return {
    view: "configuration",
    ...(input.stage === undefined ? {} : { onboarding: input.stage }),
    ...(input.presetId === undefined ? {} : { onboardingPreset: input.presetId }),
    ...(input.adoption === undefined ? {} : { onboardingAdoption: input.adoption }),
    ...(input.titlePolicy === undefined ? {} : { onboardingTitlePolicy: input.titlePolicy }),
  };
}

export function clampCivilizationOnboardingStage(input: {
  readonly requested: CivilizationOnboardingStage;
  readonly presetId: CivilizationOnboardingPresetId | undefined;
  readonly adoption: CivilizationOnboardingAdoption | undefined;
  readonly titlePolicy: CivilizationOnboardingTitlePolicy | undefined;
  readonly hasReviewedPreview: boolean;
}): CivilizationOnboardingStage {
  const order: ReadonlyArray<CivilizationOnboardingStage> = [
    "target",
    "providers",
    "preset",
    "adoption",
    "privacy",
    "preview",
    "apply",
  ];
  const requestedIndex = order.indexOf(input.requested);
  if (requestedIndex <= order.indexOf("preset")) return input.requested;
  if (input.presetId === undefined) return "preset";
  if (requestedIndex <= order.indexOf("adoption")) return input.requested;
  if (input.adoption === undefined) return "adoption";
  if (requestedIndex <= order.indexOf("privacy")) return input.requested;
  if (input.titlePolicy === undefined) return "privacy";
  if (input.requested === "apply" && !input.hasReviewedPreview) return "preview";
  return input.requested;
}
