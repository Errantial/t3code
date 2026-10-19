import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationOnboardingPreviewUnavailableError,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type CivilizationCitizenSummary,
  type CivilizationOnboardingPreviewUnavailableReason,
  type CivilizationProviderCapability,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as OnboardingService from "./OnboardingService.ts";

const PROJECT_ID = ProjectId.make("project:civilization:onboarding");
const OTHER_PROJECT_ID = ProjectId.make("project:civilization:onboarding:other");
const THREAD_ID = ThreadId.make("thread:civilization:onboarding");
const RUN_ID = RunId.make("run:civilization:onboarding");
const PROVIDER_ID = ProviderInstanceId.make("codex-main");

const CAPABILITY = {
  providerInstanceId: PROVIDER_ID,
  support: "full",
  contextInjection: true,
  keyedContextReplacement: true,
  actionablePromptRefresh: true,
  providerContinuationRefresh: true,
  messaging: true,
} satisfies CivilizationProviderCapability;

const BUDGET = {
  limitBytes: 4096,
  packetBytes: 128,
  requiredBytes: 64,
  briefBytes: 0,
  rosterBytes: 32,
  noteBytes: 16,
  inboxBytes: 16,
  unusedBytes: 3968,
} as const;

const COMPOSITION = {
  brief: { candidates: 0, included: 0, omitted: 0 },
  roster: { candidates: 1, included: 1, omitted: 0 },
  notes: { candidates: 1, included: 1, omitted: 0 },
  inbox: { candidates: 1, included: 1, omitted: 0 },
} as const;

const openCitizen = (
  overrides: Partial<CivilizationCitizenSummary> = {},
): CivilizationCitizenSummary => ({
  threadId: THREAD_ID,
  projectId: PROJECT_ID,
  name: "Ada",
  profileId: "calm",
  profileLabel: "Calm",
  generation: 0,
  lineageStatus: "resolved",
  parentThreadId: null,
  relationshipToParent: null,
  observedOnly: false,
  epoch: 0,
  closed: false,
  deleted: false,
  titleManaged: true,
  revision: 1,
  ...overrides,
});

const liveShell = (
  overrides: Partial<
    Pick<
      OrchestrationV2ThreadShell,
      | "projectId"
      | "providerInstanceId"
      | "runtimeMode"
      | "interactionMode"
      | "activeRunId"
      | "archivedAt"
      | "deletedAt"
    >
  > = {},
): OrchestrationV2ThreadShell =>
  ({
    projectId: PROJECT_ID,
    providerInstanceId: PROVIDER_ID,
    runtimeMode: "full-access",
    interactionMode: "default",
    activeRunId: RUN_ID,
    archivedAt: null,
    deletedAt: null,
    ...overrides,
  }) as OrchestrationV2ThreadShell;

interface HarnessState {
  citizen: CivilizationCitizenSummary | null;
  shell: OrchestrationV2ThreadShell | null;
  providerUnavailable: boolean;
  citizenReads: number;
  shellReads: number;
  previewInputs: Array<ContextService.CivilizationContextExistingCitizenPreviewInput>;
}

const makeState = (): HarnessState => ({
  citizen: openCitizen(),
  shell: liveShell(),
  providerUnavailable: false,
  citizenReads: 0,
  shellReads: 0,
  previewInputs: [],
});

const fakePreviewResult = (
  input: ContextService.CivilizationContextExistingCitizenPreviewInput,
): ContextService.CivilizationContextExistingCitizenPreviewResult =>
  ({
    capability: { ...CAPABILITY, providerInstanceId: input.providerInstanceId },
    budget: BUDGET,
    composition: COMPOSITION,
    packet: {
      revision: "sha256:onboarding-preview",
      text: "SENSITIVE PREVIEW BODY",
      bytes: 128,
      reference: {
        referenceId: "civilization:onboarding:preview",
        projectId: input.projectId,
        threadId: input.threadId,
        runId: input.runId,
        attemptId: input.attemptId,
        providerTurnOrdinal: input.providerTurnOrdinal,
        providerInstanceId: input.providerInstanceId,
        environmentRevision: input.effective.environmentRevision,
        projectRevision: input.effective.projectRevision,
        citizenRevision: 1,
        censusRevision: 2,
        notesRevision: 3,
        inboxRevision: 4,
        briefRevision: null,
        briefBodyBytes: 0,
        briefIncluded: false,
        packetHash: "sha256:onboarding-preview-packet",
        packetBytes: 128,
        selectedCitizenIds: [input.threadId],
        selectedNoteIds: [],
        selectedInboxIds: [],
        createdAt: "2026-10-18T00:00:00.000Z",
      },
    },
  }) as ContextService.CivilizationContextExistingCitizenPreviewResult;

const database = SqlitePersistence.layerMemory;

const makeLayer = (state: HarnessState) => {
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const citizens = Layer.succeed(
    CitizenService.CivilizationCitizenService,
    CitizenService.CivilizationCitizenService.of({
      adoptExisting: () => Effect.die("onboarding preview must not adopt citizens"),
      reconcileExisting: () => Effect.die("onboarding preview must not reconcile citizens"),
      getCitizen: () => {
        state.citizenReads += 1;
        return Effect.succeed(state.citizen);
      },
      getCitizenDetail: () => Effect.die("onboarding preview must not read citizen detail"),
    }),
  );
  const context = Layer.succeed(
    ContextService.CivilizationContextService,
    ContextService.CivilizationContextService.of({
      listCapabilities: () => Effect.succeed([CAPABILITY]),
      forTurn: () => Effect.die("onboarding preview must not run a provider turn"),
      forExplicitRead: () => Effect.die("onboarding preview must not persist an explicit read"),
      previewExistingCitizen: ((
        input: ContextService.CivilizationContextExistingCitizenPreviewInput,
      ) => {
        state.previewInputs.push(input);
        return state.providerUnavailable
          ? Effect.fail(
              new ProviderAdapterRegistry.ProviderAdapterRegistryMetadataError({
                instanceId: input.providerInstanceId,
                cause: new Error("capability probe failed"),
              }),
            )
          : Effect.succeed(fakePreviewResult(input));
      }) as never,
      analytics: ({ projectId, bucketSize }) =>
        Effect.succeed({
          projectId,
          from: "1970-01-01T00:00:00.000Z",
          to: "1970-01-01T00:00:00.000Z",
          bucketSize,
          appliedDiagnosticRetentionDays: 0,
          buckets: [],
        }),
      listInspections: ({ projectId }) =>
        Effect.succeed({ projectId, inspections: [], nextCursor: null, partial: false }),
      readInspection: () => Effect.succeed(null),
      markProviderStartAccepted: () => Effect.void,
      markProviderStartFailed: () => Effect.void,
    }),
  );
  const projections = Layer.succeed(ProjectionStore.ProjectionStoreV2, {
    getThreadShell: () => {
      state.shellReads += 1;
      return Effect.succeed(state.shell);
    },
  } as unknown as ProjectionStore.ProjectionStoreV2Shape);
  const dependencies = Layer.mergeAll(database, config, citizens, context, projections);
  return Layer.mergeAll(dependencies, OnboardingService.layer.pipe(Layer.provide(dependencies)));
};

const insertProject = Effect.fn("OnboardingService.test.insertProject")(function* (
  projectId = PROJECT_ID,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/civilization-onboarding', '[]',
      '2026-10-18T00:00:00.000Z', '2026-10-18T00:00:00.000Z', NULL
    )
  `;
});

const isPreviewUnavailable = Schema.is(CivilizationOnboardingPreviewUnavailableError);

it.effect(
  "describes transparent presets from the committed project override without mutating revisions",
  () => {
    const state = makeState();
    return Effect.gen(function* () {
      const config = yield* ConfigService.CivilizationConfigService;
      const onboarding = yield* OnboardingService.CivilizationOnboardingService;
      yield* insertProject();
      yield* config.set({
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
        },
      });
      const base = {
        version: CIVILIZATION_CONFIG_VERSION,
        participation: {
          emergencyOff: false,
          adoption: "all_existing" as const,
          includeControllableChildren: false,
          showObservedAgents: false,
        },
        names: { automaticTitles: false, adoptionTitlePolicy: "managed" as const },
        personalities: { rendering: "mild" as const },
        knowledge: { packetInclusion: true, retentionDays: 31 },
        context: { packetBytes: 4096, inboxExcerptCount: 2 },
        messaging: { enabled: true, unreadTtlDays: 29 },
        operations: {
          terminalRetentionDays: 31,
          operationReceiptRetentionDays: 32,
          diagnosticRetentionDays: 8,
          tombstoneRetentionDays: 33,
        },
      } as const;
      yield* config.set({
        projectId: PROJECT_ID,
        expectedRevision: 0,
        expectedEnvironmentRevision: 1,
        override: base,
      });

      const result = yield* onboarding.listPresets(PROJECT_ID);
      assert.equal(result.environmentRevision, 1);
      assert.equal(result.projectRevision, 1);
      assert.deepEqual(
        result.presets.map((preset) => preset.id),
        ["minimal", "standard", "rich", "custom"],
      );
      for (const preset of result.presets) {
        const candidate = preset.candidateOverride;
        assert.deepEqual(candidate.participation, base.participation);
        assert.deepEqual(candidate.names, base.names);
        assert.equal(candidate.knowledge?.retentionDays, base.knowledge.retentionDays);
        assert.equal(candidate.context?.packetBytes, base.context.packetBytes);
        assert.equal(candidate.messaging?.unreadTtlDays, base.messaging.unreadTtlDays);
        assert.deepEqual(candidate.operations, base.operations);
      }
      const minimal = result.presets.find((preset) => preset.id === "minimal")!;
      assert.equal(minimal.candidateOverride.personalities?.rendering, "off");
      assert.equal(minimal.candidateOverride.knowledge?.packetInclusion, false);
      assert.equal(minimal.candidateOverride.context?.inboxExcerptCount, 0);
      assert.equal(minimal.candidateOverride.messaging?.enabled, false);
      assert.equal(
        result.presets.find((preset) => preset.id === "standard")!.candidateOverride.personalities
          ?.rendering,
        "mild",
      );
      assert.equal(
        result.presets.find((preset) => preset.id === "rich")!.candidateOverride.personalities
          ?.rendering,
        "rich",
      );
      assert.deepEqual(
        result.presets.find((preset) => preset.id === "custom")!.candidateOverride,
        base,
      );

      const storedAfter = yield* config.readProject(PROJECT_ID);
      assert.equal(storedAfter.revision, 1);
      assert.deepEqual(storedAfter.override, base);
      const repeated = yield* onboarding.listPresets(PROJECT_ID);
      assert.deepEqual(repeated, result);
      assert.equal(state.citizenReads, 0);
      assert.equal(state.shellReads, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(state))));
  },
);

it.effect(
  "keeps configuration-only preview redacted, pre-adoption safe, and identity-reservation free",
  () => {
    const state = makeState();
    state.citizen = null;
    return Effect.gen(function* () {
      const onboarding = yield* OnboardingService.CivilizationOnboardingService;
      yield* insertProject();
      const preview = yield* onboarding.preview({
        previewKind: "configuration_only",
        projectId: PROJECT_ID,
        providerInstanceId: PROVIDER_ID,
        candidateOverride: {
          version: CIVILIZATION_CONFIG_VERSION,
          personalities: { rendering: "rich" },
        },
      });

      assert.equal(preview.previewKind, "configuration_only");
      assert.equal(preview.environmentRevision, 0);
      assert.equal(preview.projectRevision, 0);
      assert.equal(preview.effectiveConfig.config.personalities.rendering, "rich");
      assert.equal(preview.selectedCapability?.providerInstanceId, PROVIDER_ID);
      assert.equal(preview.budget.packetBytes, 0);
      assert.deepEqual(preview.composition, {
        brief: { candidates: 0, included: 0, omitted: 0 },
        roster: { candidates: 0, included: 0, omitted: 0 },
        notes: { candidates: 0, included: 0, omitted: 0 },
        inbox: { candidates: 0, included: 0, omitted: 0 },
      });
      assert.isFalse(preview.eligibility.exactContent);
      assert.isTrue(
        preview.warnings.some((warning) => warning.includes("does not reserve a name")),
      );
      assert.notProperty(preview, "packet");
      assert.notProperty(preview, "threadId");
      assert.notInclude(JSON.stringify(preview), "SENSITIVE PREVIEW BODY");
      assert.equal(state.citizenReads, 0);
      assert.equal(state.shellReads, 0);
      assert.lengthOf(state.previewInputs, 0);
    }).pipe(Effect.provide(Layer.fresh(makeLayer(state))));
  },
);

it.effect(
  "resolves exact preview authority only from the current same-project citizen shell",
  () => {
    const state = makeState();
    state.shell = liveShell({ runtimeMode: "approval-required", interactionMode: "plan" });
    return Effect.gen(function* () {
      const onboarding = yield* OnboardingService.CivilizationOnboardingService;
      yield* insertProject();
      const candidateOverride = {
        version: CIVILIZATION_CONFIG_VERSION,
        participation: { enabled: true },
        personalities: { rendering: "rich" as const },
      };

      const redacted = yield* onboarding.preview({
        previewKind: "exact_existing_citizen",
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        candidateOverride,
      });
      assert.equal(redacted.previewKind, "exact_existing_citizen");
      assert.equal(redacted.effectiveConfig.config.personalities.rendering, "rich");
      assert.notProperty(redacted, "authority");
      assert.notProperty(redacted, "packet");
      assert.notInclude(JSON.stringify(redacted), "SENSITIVE PREVIEW BODY");
      assert.equal(redacted.selectedCapability?.providerInstanceId, PROVIDER_ID);
      assert.equal(redacted.budget.packetBytes, 0);
      assert.deepEqual(redacted.composition, {
        brief: { candidates: 0, included: 0, omitted: 0 },
        roster: { candidates: 0, included: 0, omitted: 0 },
        notes: { candidates: 0, included: 0, omitted: 0 },
        inbox: { candidates: 0, included: 0, omitted: 0 },
      });
      assert.lengthOf(state.previewInputs, 0);

      const content = yield* onboarding.previewContent({
        projectId: PROJECT_ID,
        threadId: THREAD_ID,
        candidateOverride,
      });
      assert.deepEqual(content.authority, {
        runId: RUN_ID,
        providerInstanceId: PROVIDER_ID,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      });
      assert.equal(content.packet?.revisionKind, "preview_only");
      assert.equal(content.packet?.text, "SENSITIVE PREVIEW BODY");
      assert.lengthOf(state.previewInputs, 1);
      for (const input of state.previewInputs) {
        assert.equal(input.runId, RUN_ID);
        assert.equal(input.providerInstanceId, PROVIDER_ID);
        assert.equal(input.runtimeMode, "approval-required");
        assert.equal(input.interactionMode, "plan");
        assert.equal(input.effective.config.personalities.rendering, "rich");
      }
    }).pipe(Effect.provide(Layer.fresh(makeLayer(state))));
  },
);

it.effect(
  "fails exact preview closed across invalid citizen, project, authority, and provider states",
  () => {
    const state = makeState();
    return Effect.gen(function* () {
      const onboarding = yield* OnboardingService.CivilizationOnboardingService;
      yield* insertProject();

      const expectUnavailable = (reason: CivilizationOnboardingPreviewUnavailableReason) =>
        onboarding.previewContent({ projectId: PROJECT_ID, threadId: THREAD_ID }).pipe(
          Effect.flip,
          Effect.tap((error) =>
            Effect.sync(() => {
              assert.isTrue(isPreviewUnavailable(error));
              if (isPreviewUnavailable(error)) assert.equal(error.reason, reason);
            }),
          ),
        );

      state.citizen = null;
      yield* expectUnavailable("citizen_not_found");

      state.citizen = openCitizen({ projectId: OTHER_PROJECT_ID });
      yield* expectUnavailable("project_mismatch");

      state.citizen = openCitizen({ observedOnly: true });
      yield* expectUnavailable("citizen_not_live");
      state.citizen = openCitizen({ closed: true });
      yield* expectUnavailable("citizen_not_live");
      state.citizen = openCitizen({ deleted: true });
      yield* expectUnavailable("citizen_not_live");

      state.citizen = openCitizen();
      state.shell = liveShell({ activeRunId: null });
      yield* expectUnavailable("authority_unavailable");
      state.shell = liveShell({ projectId: OTHER_PROJECT_ID });
      yield* expectUnavailable("project_mismatch");

      state.shell = liveShell();
      state.providerUnavailable = true;
      yield* expectUnavailable("provider_unavailable");
    }).pipe(Effect.provide(Layer.fresh(makeLayer(state))));
  },
);
