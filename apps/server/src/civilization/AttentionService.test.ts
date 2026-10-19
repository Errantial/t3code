import { assert, it } from "@effect/vitest";
import {
  CivilizationAttentionResult,
  ProjectId,
  ProviderInstanceId,
  type CivilizationAttentionResult as CivilizationAttentionResultType,
  type CivilizationProviderCapability,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as AttentionService from "./AttentionService.ts";

const projectId = ProjectId.make("project:civilization:attention");
const now = "2026-10-18T12:34:56.000Z";
const expectedFrom = "2026-10-17T12:34:56.000Z";
const isCivilizationAttentionResult = Schema.is(CivilizationAttentionResult);

type ConfigStatus = {
  readonly status: "disabled" | "adopting" | "active";
  readonly environmentRevision: number;
  readonly projectRevision: number;
  readonly citizenCount: number;
  readonly openCitizenCount: number;
  readonly detail?: string;
};

const baseStatus: ConfigStatus = {
  status: "active",
  environmentRevision: 7,
  projectRevision: 11,
  citizenCount: 20,
  openCitizenCount: 8,
};

const fullProvider: CivilizationProviderCapability = {
  providerInstanceId: ProviderInstanceId.make("codex-main"),
  support: "full",
  contextInjection: true,
  keyedContextReplacement: true,
  actionablePromptRefresh: true,
  providerContinuationRefresh: true,
  messaging: true,
};

const metadataOnlyProvider: CivilizationProviderCapability = {
  providerInstanceId: ProviderInstanceId.make("observed-main"),
  support: "metadata_only",
  contextInjection: false,
  keyedContextReplacement: false,
  actionablePromptRefresh: false,
  providerContinuationRefresh: false,
  messaging: false,
};

const unsupportedProvider: CivilizationProviderCapability = {
  providerInstanceId: ProviderInstanceId.make("offline-main"),
  support: "unsupported",
  contextInjection: false,
  keyedContextReplacement: false,
  actionablePromptRefresh: false,
  providerContinuationRefresh: false,
  messaging: false,
};

const analytics = (providerStartFailed = 0, packetBudgetZero = 0, packetBudgetTooSmall = 0) => ({
  projectId,
  from: expectedFrom,
  to: now,
  bucketSize: "hour" as const,
  appliedDiagnosticRetentionDays: 30,
  buckets: [
    {
      bucketStart: "2026-10-18T12:00:00.000Z",
      bucketEnd: "2026-10-18T13:00:00.000Z",
      totalInspections: providerStartFailed + packetBudgetZero + packetBudgetTooSmall,
      outcomes: {
        skipped: 0,
        built: 0,
        providerStartAccepted: 0,
        providerStartFailed,
      },
      suppressions: [
        ...(packetBudgetZero === 0
          ? []
          : [{ reason: "packet_budget_zero" as const, count: packetBudgetZero }]),
        ...(packetBudgetTooSmall === 0
          ? []
          : [{ reason: "packet_budget_too_small" as const, count: packetBudgetTooSmall }]),
      ],
      packetSize: { zero: 0, low: 0, medium: 0, high: 0, over: 0 },
      budgetUtilization: { zero: 0, low: 0, medium: 0, high: 0, over: 0 },
      roster: { candidates: 0, included: 0, omitted: 0 },
      notes: { candidates: 0, included: 0, omitted: 0 },
      inbox: { candidates: 0, included: 0, omitted: 0 },
    },
  ],
});

function makeLayer(input: {
  readonly status?: ConfigStatus;
  readonly capabilities?: Array<CivilizationProviderCapability>;
  readonly analytics?: ReturnType<typeof analytics>;
  readonly calls: Ref.Ref<ReadonlyArray<string>>;
}) {
  const record = (call: string) => Ref.update(input.calls, (calls) => [...calls, call]);
  const config = ConfigService.CivilizationConfigService.of({
    describe: Effect.die("attention must not read config description"),
    getEffective: () => Effect.die("attention must not read effective config directly"),
    getRuntime: () => Effect.die("attention must not read runtime config"),
    validate: () => Effect.die("attention must not validate config"),
    diff: () => Effect.die("attention must not diff config"),
    set: () => Effect.die("attention must not mutate config"),
    reset: () => Effect.die("attention must not reset config"),
    import: () => Effect.die("attention must not import config"),
    export: () => Effect.die("attention must not export config"),
    status: (requestedProjectId) =>
      record(`status:${requestedProjectId ?? "environment"}`).pipe(
        Effect.as(input.status ?? baseStatus),
      ),
    readEnvironment: Effect.die("attention must not read environment config rows"),
    readProject: () => Effect.die("attention must not read project config rows"),
  });
  const context = ContextService.CivilizationContextService.of({
    listCapabilities: () =>
      record("capabilities").pipe(Effect.as(input.capabilities ?? [fullProvider])),
    analytics: (request) =>
      record(
        `analytics:${request.projectId}:${request.bucketSize}:${request.from}:${request.to}`,
      ).pipe(Effect.as(input.analytics ?? analytics())),
    forTurn: () => Effect.die("attention must not build context packets"),
    forExplicitRead: () => Effect.die("attention must not read context packets"),
    previewExistingCitizen: () => Effect.die("attention must not preview context packets"),
    listInspections: () => Effect.die("attention must not read inspection rows"),
    readInspection: () => Effect.die("attention must not read inspection packet text"),
    markProviderStartAccepted: () => Effect.die("attention must not mutate inspection state"),
    markProviderStartFailed: () => Effect.die("attention must not mutate inspection state"),
  });
  return AttentionService.layer.pipe(
    Layer.provide(Layer.succeed(ConfigService.CivilizationConfigService, config)),
    Layer.provide(Layer.succeed(ContextService.CivilizationContextService, context)),
  );
}

const runSnapshot = (
  input: {
    readonly status?: ConfigStatus;
    readonly capabilities?: Array<CivilizationProviderCapability>;
    readonly analytics?: ReturnType<typeof analytics>;
  } = {},
) =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);
    const snapshot = yield* Effect.gen(function* () {
      yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe(now)));
      const service = yield* AttentionService.CivilizationAttentionService;
      return yield* service.snapshot(projectId);
    }).pipe(Effect.provide(makeLayer({ ...input, calls })));
    return { snapshot, calls: yield* Ref.get(calls) } as const;
  });

it.effect("derives one exact-project bounded body-free attention snapshot", () =>
  Effect.gen(function* () {
    const { snapshot, calls } = yield* runSnapshot();

    assert.equal(snapshot.projectId, projectId);
    assert.equal(snapshot.generatedAt, now);
    assert.deepEqual(snapshot.items, []);
    const contractSnapshot: CivilizationAttentionResultType = snapshot;
    assert.isTrue(isCivilizationAttentionResult(contractSnapshot));
    assert.equal(calls[0], `status:${projectId}`);
    assert.sameMembers(calls.slice(1), [
      "capabilities",
      `analytics:${projectId}:hour:${expectedFrom}:${now}`,
    ]);
    assert.isAtMost(snapshot.items.length, AttentionService.CIVILIZATION_ATTENTION_MAX_ITEMS);
  }),
);

it.effect("reports only supported operational kinds and never invents adoption-blocked state", () =>
  Effect.gen(function* () {
    const { snapshot } = yield* runSnapshot({
      status: { ...baseStatus, status: "adopting" },
      capabilities: [fullProvider, metadataOnlyProvider, unsupportedProvider],
      analytics: analytics(3, 1, 2),
    });

    assert.deepEqual(
      snapshot.items.map((item) => item.kind),
      [
        "civilization_degraded",
        "provider_support_limited",
        "adoption_in_progress",
        "context_provider_start_failures",
        "packet_budget_pressure",
      ],
    );
    assert.isFalse(snapshot.items.some((item) => String(item.kind).includes("blocked")));
    assert.match(snapshot.items[0]!.key, /:7:11:/);
    assert.match(snapshot.items[3]!.key, /:2026-10-17T12$/);
  }),
);

it.effect("requires repeated packet-budget suppression before surfacing pressure", () =>
  Effect.gen(function* () {
    const { snapshot } = yield* runSnapshot({ analytics: analytics(0, 1, 0) });
    assert.deepEqual(snapshot.items, []);
  }),
);

it.effect("stops after project status when Civilization is disabled", () =>
  Effect.gen(function* () {
    const { snapshot, calls } = yield* runSnapshot({
      status: { ...baseStatus, status: "disabled" },
    });

    assert.deepEqual(snapshot.items, []);
    assert.deepEqual(calls, [`status:${projectId}`]);
  }),
);
