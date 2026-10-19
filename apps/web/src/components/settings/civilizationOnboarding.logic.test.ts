import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  ThreadId,
  type CivilizationOnboardingPresetDefinition,
  type CivilizationOnboardingPreviewResult,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildCivilizationOnboardingPreviewRequest,
  civilizationOnboardingSafeSearch,
  clampCivilizationOnboardingStage,
  isCivilizationOnboardingConflict,
  onboardingApplyBinding,
  onboardingCanReveal,
  overlayCivilizationOnboardingChoices,
  selectCivilizationOnboardingCandidate,
} from "./civilizationOnboarding.logic";

const projectId = ProjectId.make("project:onboarding:logic");
const threadId = ThreadId.make("thread:onboarding:logic");
const presets = [
  {
    id: "minimal",
    label: "Minimal",
    description: "Minimal server preset",
    candidateOverride: {
      version: CIVILIZATION_CONFIG_VERSION,
      participation: { adoption: "all_existing" as const },
      names: { adoptionTitlePolicy: "managed" as const },
      personalities: { rendering: "off" as const },
    },
    changes: [],
  },
] satisfies ReadonlyArray<CivilizationOnboardingPresetDefinition>;
const preview = {
  projectId,
  previewKind: "exact_existing_citizen",
  environmentRevision: 12,
  projectRevision: 34,
  eligibility: { brief: true, roster: true, notes: false, inbox: false, exactContent: true },
} as CivilizationOnboardingPreviewResult;

describe("Civilization onboarding wizard logic", () => {
  it("copies only a server-described preset and overlays explicit adoption/title choices", () => {
    const base = selectCivilizationOnboardingCandidate(presets, "minimal")!;
    expect(base.candidateOverride).not.toBe(presets[0]!.candidateOverride);
    const candidate = overlayCivilizationOnboardingChoices(base, {
      adoption: "future_only",
      titlePolicy: "preserve",
    });
    expect(candidate.candidateOverride.participation?.adoption).toBe("future_only");
    expect(candidate.candidateOverride.names?.adoptionTitlePolicy).toBe("preserve");
    expect(candidate.candidateOverride.personalities?.rendering).toBe("off");
    expect(selectCivilizationOnboardingCandidate(presets, "rich")).toBeNull();
  });

  it("keeps future preview body-free and lets exact citizen authority remain server-resolved", () => {
    const candidate = overlayCivilizationOnboardingChoices(
      selectCivilizationOnboardingCandidate(presets, "minimal")!,
      { adoption: "future_only", titlePolicy: "preserve" },
    );
    expect(
      buildCivilizationOnboardingPreviewRequest({ projectId, candidate, threadId: null }),
    ).toEqual({
      previewKind: "configuration_only",
      projectId,
      candidateOverride: candidate.candidateOverride,
    });
    expect(buildCivilizationOnboardingPreviewRequest({ projectId, candidate, threadId })).toEqual({
      previewKind: "exact_existing_citizen",
      projectId,
      threadId,
      candidateOverride: candidate.candidateOverride,
    });
  });

  it("binds Apply to both exact reviewed revisions", () => {
    const candidate = selectCivilizationOnboardingCandidate(presets, "minimal")!;
    expect(onboardingApplyBinding(projectId, candidate, preview)).toMatchObject({
      projectId,
      expectedRevision: 34,
      expectedEnvironmentRevision: 12,
    });
  });

  it("persists only safe URL state and clamps direct later stages without memory prerequisites", () => {
    expect(
      civilizationOnboardingSafeSearch({
        stage: "apply",
        presetId: "minimal",
        adoption: "future_only",
        titlePolicy: "preserve",
      }),
    ).toEqual({
      view: "configuration",
      onboarding: "apply",
      onboardingPreset: "minimal",
      onboardingAdoption: "future_only",
      onboardingTitlePolicy: "preserve",
    });
    expect(
      clampCivilizationOnboardingStage({
        requested: "apply",
        presetId: "minimal",
        adoption: "future_only",
        titlePolicy: "preserve",
        hasReviewedPreview: false,
      }),
    ).toBe("preview");
    expect(
      clampCivilizationOnboardingStage({
        requested: "privacy",
        presetId: undefined,
        adoption: undefined,
        titlePolicy: undefined,
        hasReviewedPreview: false,
      }),
    ).toBe("preset");
  });

  it("gates Reveal and recognizes only config conflicts", () => {
    expect(onboardingCanReveal(preview, threadId)).toBe(true);
    expect(onboardingCanReveal(preview, null)).toBe(false);
    expect(isCivilizationOnboardingConflict({ _tag: "CivilizationConfigConflictError" })).toBe(
      true,
    );
    expect(isCivilizationOnboardingConflict({ _tag: "CivilizationUnavailableError" })).toBe(false);
  });
});
