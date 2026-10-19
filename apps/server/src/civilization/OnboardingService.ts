import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationOnboardingPreviewUnavailableError,
  RunAttemptId,
  type CivilizationConfigOverride,
  type CivilizationContextBudget,
  type CivilizationContextComposition,
  type CivilizationOnboardingContentPreviewRequest,
  type CivilizationOnboardingContentPreviewResult,
  type CivilizationOnboardingPresetDefinition,
  type CivilizationOnboardingPresetsResult,
  type CivilizationOnboardingPreviewEligibility,
  type CivilizationOnboardingPreviewRequest,
  type CivilizationOnboardingPreviewResult,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";

const unavailable = (
  reason: ConstructorParameters<typeof CivilizationOnboardingPreviewUnavailableError>[0]["reason"],
  message: string,
) =>
  new CivilizationOnboardingPreviewUnavailableError({
    code: "civilization_onboarding_preview_unavailable",
    reason,
    message,
  });

const emptyComposition = (): CivilizationContextComposition => ({
  brief: { candidates: 0, included: 0, omitted: 0 },
  roster: { candidates: 0, included: 0, omitted: 0 },
  notes: { candidates: 0, included: 0, omitted: 0 },
  inbox: { candidates: 0, included: 0, omitted: 0 },
});

const configurationOnlyBudget = (limitBytes: number): CivilizationContextBudget => ({
  limitBytes,
  packetBytes: 0,
  requiredBytes: 0,
  briefBytes: 0,
  rosterBytes: 0,
  noteBytes: 0,
  inboxBytes: 0,
  unusedBytes: Math.max(0, limitBytes),
});

const mergeCandidateOverride = (
  base: CivilizationConfigOverride,
  patch: Partial<Omit<CivilizationConfigOverride, "version">>,
): CivilizationConfigOverride => ({
  ...structuredClone(base),
  version: CIVILIZATION_CONFIG_VERSION,
  ...(patch.participation === undefined
    ? {}
    : { participation: { ...base.participation, ...patch.participation } }),
  ...(patch.names === undefined ? {} : { names: { ...base.names, ...patch.names } }),
  ...(patch.personalities === undefined
    ? {}
    : { personalities: { ...base.personalities, ...patch.personalities } }),
  ...(patch.knowledge === undefined
    ? {}
    : { knowledge: { ...base.knowledge, ...patch.knowledge } }),
  ...(patch.context === undefined ? {} : { context: { ...base.context, ...patch.context } }),
  ...(patch.messaging === undefined
    ? {}
    : { messaging: { ...base.messaging, ...patch.messaging } }),
  ...(patch.operations === undefined
    ? {}
    : { operations: { ...base.operations, ...patch.operations } }),
});

export const onboardingPresetCandidates = (
  base: CivilizationConfigOverride,
): ReadonlyArray<
  Pick<CivilizationOnboardingPresetDefinition, "id" | "label" | "description" | "candidateOverride">
> => [
  {
    id: "minimal",
    label: "Minimal",
    description:
      "Identity and roster orientation only: personality rendering, note packet inclusion, and messaging are off.",
    candidateOverride: mergeCandidateOverride(base, {
      personalities: { rendering: "off" },
      knowledge: { packetInclusion: false },
      context: { inboxExcerptCount: 0 },
      messaging: { enabled: false },
    }),
  },
  {
    id: "standard",
    label: "Standard",
    description:
      "Keep the current bounded knowledge and messaging settings with mild personality rendering.",
    candidateOverride: mergeCandidateOverride(base, {
      personalities: { rendering: "mild" },
    }),
  },
  {
    id: "rich",
    label: "Rich",
    description:
      "Keep the current bounded knowledge and messaging settings with rich personality rendering.",
    candidateOverride: mergeCandidateOverride(base, {
      personalities: { rendering: "rich" },
    }),
  },
  {
    id: "custom",
    label: "Custom",
    description: "Keep the current project override for direct review and editing.",
    candidateOverride: structuredClone(base),
  },
];

const make = Effect.gen(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  const citizens = yield* CitizenService.CivilizationCitizenService;
  const context = yield* ContextService.CivilizationContextService;
  const projections = yield* ProjectionStore.ProjectionStoreV2;

  const currentProjectOverride = Effect.fn("CivilizationOnboarding.currentProjectOverride")(
    function* (projectId: ProjectId) {
      // `getEffective` performs the authoritative open-project validation.
      const effective = yield* config.getEffective(projectId);
      const stored = yield* config.readProject(projectId);
      return {
        effective,
        override:
          stored.override ??
          ({
            version: CIVILIZATION_CONFIG_VERSION,
          } satisfies CivilizationConfigOverride),
      } as const;
    },
  );

  const candidateDiff = Effect.fn("CivilizationOnboarding.candidateDiff")(function* (input: {
    readonly projectId: ProjectId;
    readonly candidateOverride?: CivilizationConfigOverride | undefined;
  }) {
    const current = yield* currentProjectOverride(input.projectId);
    const override = input.candidateOverride ?? current.override;
    return yield* config.diff({ projectId: input.projectId, override });
  });

  const listPresets = Effect.fn("CivilizationOnboarding.listPresets")(function* (
    projectId: ProjectId,
  ) {
    const current = yield* currentProjectOverride(projectId);
    const presets = yield* Effect.forEach(onboardingPresetCandidates(current.override), (preset) =>
      Effect.gen(function* () {
        const diff = yield* config.diff({ projectId, override: preset.candidateOverride });
        return {
          ...preset,
          changes: diff.changes,
        } satisfies CivilizationOnboardingPresetDefinition;
      }),
    );
    return {
      projectId,
      environmentRevision: current.effective.environmentRevision,
      projectRevision: current.effective.projectRevision,
      presets,
    } satisfies CivilizationOnboardingPresetsResult;
  });

  const resolveExactAuthority = Effect.fn("CivilizationOnboarding.resolveExactAuthority")(
    function* (input: {
      readonly projectId: ProjectId;
      readonly threadId: CivilizationOnboardingContentPreviewRequest["threadId"];
    }) {
      const citizen = yield* citizens.getCitizen(input.threadId);
      if (citizen === null) {
        return yield* unavailable(
          "citizen_not_found",
          "The selected thread is not an enrolled Civilization citizen.",
        );
      }
      if (citizen.projectId !== input.projectId) {
        return yield* unavailable(
          "project_mismatch",
          "The selected citizen belongs to a different project.",
        );
      }
      if (citizen.closed || citizen.deleted || citizen.observedOnly) {
        return yield* unavailable(
          "citizen_not_live",
          "The selected citizen is not an open controllable citizen.",
        );
      }
      const shell = yield* projections
        .getThreadShell(input.threadId)
        .pipe(
          Effect.catch(() =>
            Effect.fail(
              unavailable(
                "authority_unavailable",
                "The selected citizen's authoritative thread state is unavailable.",
              ),
            ),
          ),
        );
      if (shell === null || shell.projectId !== input.projectId) {
        return yield* unavailable(
          "project_mismatch",
          "The selected thread is not present in the requested project.",
        );
      }
      if (shell.archivedAt !== null || shell.deletedAt !== null || shell.activeRunId === null) {
        return yield* unavailable(
          "authority_unavailable",
          "The selected citizen has no unique live run that can authorize an exact preview.",
        );
      }
      return {
        runId: shell.activeRunId,
        providerInstanceId: shell.providerInstanceId,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
      } as const;
    },
  );

  const buildExact = Effect.fn("CivilizationOnboarding.buildExact")(function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: CivilizationOnboardingContentPreviewRequest["threadId"];
    readonly candidateOverride?: CivilizationConfigOverride | undefined;
  }) {
    const diff = yield* candidateDiff(input);
    const authority = yield* resolveExactAuthority(input);
    const built = yield* context
      .previewExistingCitizen({
        projectId: input.projectId,
        threadId: input.threadId,
        runId: authority.runId,
        attemptId: RunAttemptId.make(`civilization:onboarding-preview:${authority.runId}`),
        providerTurnOrdinal: 0,
        providerInstanceId: authority.providerInstanceId,
        runtimeMode: authority.runtimeMode,
        interactionMode: authority.interactionMode,
        effective: diff.effective,
      })
      .pipe(
        Effect.catchTags({
          ProviderAdapterRegistryLookupError: () =>
            Effect.fail(
              unavailable(
                "provider_unavailable",
                "The selected citizen's authoritative provider is unavailable.",
              ),
            ),
          ProviderAdapterRegistryMetadataError: () =>
            Effect.fail(
              unavailable(
                "provider_unavailable",
                "The selected citizen's authoritative provider metadata is unavailable.",
              ),
            ),
          ProviderAdapterDriverCreateError: () =>
            Effect.fail(
              unavailable(
                "provider_unavailable",
                "The selected citizen's authoritative provider could not be prepared for preview.",
              ),
            ),
        }),
      );
    return { diff, authority, built } as const;
  });

  const eligibilityFor = (
    configValue: CivilizationOnboardingPreviewResult["effectiveConfig"]["config"],
    exactContent: boolean,
  ): CivilizationOnboardingPreviewEligibility => ({
    brief: configValue.context.packetBytes > 0,
    roster: configValue.context.packetBytes > 0 && configValue.context.rosterCount > 0,
    notes:
      configValue.context.packetBytes > 0 &&
      configValue.knowledge.packetInclusion &&
      configValue.context.noteCount > 0,
    inbox:
      configValue.context.packetBytes > 0 &&
      configValue.messaging.enabled &&
      configValue.context.inboxExcerptCount > 0,
    exactContent,
  });

  const commonWarnings = (effective: CivilizationOnboardingPreviewResult["effectiveConfig"]) => {
    const warnings: string[] = [];
    if (!effective.config.participation.enabled) {
      warnings.push("Civilization remains disabled until participation is explicitly enabled.");
    }
    if (effective.config.participation.adoption === "all_existing") {
      warnings.push("All-existing adoption may enroll eligible existing threads after Apply.");
    }
    return warnings;
  };

  const preview = Effect.fn("CivilizationOnboarding.preview")(function* (
    input: CivilizationOnboardingPreviewRequest,
  ) {
    const capabilities = yield* context.listCapabilities();
    if (input.previewKind === "configuration_only") {
      const diff = yield* candidateDiff(input);
      const selectedCapability =
        input.providerInstanceId === undefined
          ? null
          : (capabilities.find(
              (capability) => capability.providerInstanceId === input.providerInstanceId,
            ) ?? null);
      if (input.providerInstanceId !== undefined && selectedCapability === null) {
        return yield* unavailable(
          "provider_unavailable",
          "The selected provider instance is not registered on this environment.",
        );
      }
      return {
        projectId: input.projectId,
        previewKind: "configuration_only",
        effectiveConfig: diff.effective,
        environmentRevision: diff.effective.environmentRevision,
        projectRevision: diff.effective.projectRevision,
        changes: diff.changes,
        capabilities,
        selectedCapability,
        budget: configurationOnlyBudget(diff.effective.config.context.packetBytes),
        composition: emptyComposition(),
        eligibility: eligibilityFor(diff.effective.config, false),
        warnings: [
          ...commonWarnings(diff.effective),
          "Future citizen identity is randomly assigned only at enrollment; this preview does not reserve a name or profile.",
          ...(selectedCapability?.support === "unsupported"
            ? ["The selected provider currently reports Civilization context as unsupported."]
            : []),
        ],
      } satisfies CivilizationOnboardingPreviewResult;
    }

    const diff = yield* candidateDiff(input);
    const authority = yield* resolveExactAuthority(input);
    const selectedCapability =
      capabilities.find(
        (capability) => capability.providerInstanceId === authority.providerInstanceId,
      ) ?? null;
    if (selectedCapability === null) {
      return yield* unavailable(
        "provider_unavailable",
        "The selected citizen's authoritative provider is not registered on this environment.",
      );
    }
    return {
      projectId: input.projectId,
      previewKind: "exact_existing_citizen",
      effectiveConfig: diff.effective,
      environmentRevision: diff.effective.environmentRevision,
      projectRevision: diff.effective.projectRevision,
      changes: diff.changes,
      capabilities,
      selectedCapability,
      budget: configurationOnlyBudget(diff.effective.config.context.packetBytes),
      composition: emptyComposition(),
      eligibility: eligibilityFor(diff.effective.config, true),
      warnings: [
        ...commonWarnings(diff.effective),
        "Sensitive packet sources and exact composition are read only after an explicit Reveal with settings:write.",
      ],
    } satisfies CivilizationOnboardingPreviewResult;
  });

  const previewContent = Effect.fn("CivilizationOnboarding.previewContent")(function* (
    input: CivilizationOnboardingContentPreviewRequest,
  ) {
    const exact = yield* buildExact(input);
    const packet = exact.built.packet;
    return {
      projectId: input.projectId,
      threadId: input.threadId,
      effectiveConfig: exact.diff.effective,
      environmentRevision: exact.diff.effective.environmentRevision,
      projectRevision: exact.diff.effective.projectRevision,
      capability: exact.built.capability,
      authority: exact.authority,
      budget: exact.built.budget,
      composition: exact.built.composition,
      packet:
        packet === null
          ? null
          : {
              revisionKind: "preview_only" as const,
              previewRevision: packet.revision,
              text: packet.text,
              bytes: packet.bytes,
              selectedCitizenIds: packet.reference.selectedCitizenIds,
              selectedNoteIds: packet.reference.selectedNoteIds,
              selectedInboxIds: packet.reference.selectedInboxIds,
            },
      warnings: [
        ...commonWarnings(exact.diff.effective),
        "Preview packet revision and rendered content are provisional; concurrent state may change the next runtime packet.",
      ],
    } satisfies CivilizationOnboardingContentPreviewResult;
  });

  return { listPresets, preview, previewContent } as const;
});

export type CivilizationOnboardingServiceShape = Effect.Success<typeof make>;

export class CivilizationOnboardingService extends Context.Service<
  CivilizationOnboardingService,
  CivilizationOnboardingServiceShape
>()("t3/civilization/OnboardingService/CivilizationOnboardingService") {}

export const layer = Layer.effect(CivilizationOnboardingService, make);
