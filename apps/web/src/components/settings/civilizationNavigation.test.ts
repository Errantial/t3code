import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  CIVILIZATION_ACTIVITY_MODE_OPTIONS,
  CIVILIZATION_CONTEXT_MODE_OPTIONS,
  CIVILIZATION_SETTINGS_VIEW_OPTIONS,
  civilizationViewForTargetId,
  mergeCivilizationNavigationSearch,
} from "./civilizationNavigation";

describe("Civilization settings navigation", () => {
  it("exposes one canonical destination for every view and local mode", () => {
    expect(
      CIVILIZATION_SETTINGS_VIEW_OPTIONS.map(({ value, targetId }) => [value, targetId]),
    ).toEqual([
      ["overview", "civilization-status"],
      ["citizens", "civilization-citizens"],
      ["activity", "civilization-chronicle"],
      ["context", "civilization-context-analytics"],
      ["configuration", "civilization-config"],
    ]);
    expect(CIVILIZATION_ACTIVITY_MODE_OPTIONS.map(({ value }) => value)).toEqual([
      "chronicle",
      "messages",
      "notes",
    ]);
    expect(CIVILIZATION_CONTEXT_MODE_OPTIONS.map(({ value }) => value)).toEqual([
      "analytics",
      "inspector",
    ]);
  });

  it.each([
    ["civilization-status", { view: "overview" }],
    ["civilization-citizens", { view: "citizens" }],
    ["civilization-lineage", { view: "citizens" }],
    ["civilization-chronicle", { view: "activity", activity: "chronicle" }],
    ["civilization-retained-mail", { view: "activity", activity: "messages" }],
    ["civilization-notes", { view: "activity", activity: "notes" }],
    ["civilization-context-analytics", { view: "context", contextMode: "analytics" }],
    ["civilization-context-inspector", { view: "context", contextMode: "inspector" }],
    ["civilization-personality", { view: "configuration" }],
    ["civilization-data-retention", { view: "configuration" }],
    ["civilization-onboarding", { view: "configuration" }],
  ] as const)("maps %s to its owning view", (targetId, expected) => {
    expect(civilizationViewForTargetId(targetId)).toEqual(expected);
    expect(civilizationViewForTargetId(`#${targetId}`)).toEqual(expected);
  });

  it("does not reinterpret an unrelated Settings target", () => {
    expect(civilizationViewForTargetId("default-model")).toBeNull();
  });

  it("replaces stale Civilization child fields while preserving Settings scope", () => {
    expect(
      mergeCivilizationNavigationSearch(
        {
          project: "logical-project",
          machine: "environment-a",
          checkout: "environment-a:/repo",
          view: "context",
          contextMode: "inspector",
          contextFilterProvider: "provider-old",
          contextFilterOutcome: "built",
          contextFilterSuppression: "provider_unsupported",
          contextFilterFrom: "2026-10-17T00:00:00.000Z",
          contextFilterTo: "2026-10-18T00:00:00.000Z",
          contextThread: "thread-old",
          contextRun: "run-old",
          contextAttempt: "attempt-old",
          contextTurn: 4,
        },
        {
          view: "activity",
          activity: "chronicle",
          activityThread: ThreadId.make("thread-new"),
        },
      ),
    ).toEqual({
      project: "logical-project",
      machine: "environment-a",
      checkout: "environment-a:/repo",
      view: "activity",
      activity: "chronicle",
      activityThread: "thread-new",
    });
  });

  it("keeps only safe onboarding stage/choice fields and removes them when the wizard closes", () => {
    const scope = {
      project: "logical-project",
      machine: "environment-a",
      checkout: "environment-a:/repo",
    };
    const opened = mergeCivilizationNavigationSearch(scope, {
      view: "configuration",
      onboarding: "privacy",
      onboardingPreset: "minimal",
      onboardingAdoption: "future_only",
      onboardingTitlePolicy: "preserve",
    });
    expect(opened).toEqual({
      ...scope,
      view: "configuration",
      onboarding: "privacy",
      onboardingPreset: "minimal",
      onboardingAdoption: "future_only",
      onboardingTitlePolicy: "preserve",
    });
    expect(mergeCivilizationNavigationSearch(opened, { view: "configuration" })).toEqual({
      ...scope,
      view: "configuration",
    });
  });
});
