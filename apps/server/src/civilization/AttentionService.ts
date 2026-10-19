import type {
  CivilizationContextAnalyticsBucket,
  CivilizationProviderCapability,
  CivilizationStatus,
  ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";

export const CIVILIZATION_ATTENTION_MAX_ITEMS = 8;
export const CIVILIZATION_ATTENTION_RECENT_WINDOW_HOURS = 24;

export type CivilizationAttentionKind =
  | "adoption_in_progress"
  | "civilization_degraded"
  | "provider_support_limited"
  | "context_provider_start_failures"
  | "packet_budget_pressure";

export type CivilizationAttentionSeverity = "info" | "warning" | "error";
export type CivilizationAttentionTarget = "overview" | "configuration" | "context_analytics";

export interface CivilizationAttentionItem {
  readonly key: string;
  readonly kind: CivilizationAttentionKind;
  readonly severity: CivilizationAttentionSeverity;
  readonly target: CivilizationAttentionTarget;
  readonly title: string;
  readonly detail: string;
}

export interface CivilizationAttentionSnapshot {
  readonly projectId: ProjectId;
  readonly generatedAt: string;
  readonly items: ReadonlyArray<CivilizationAttentionItem>;
}

const statusRevisionKey = (status: CivilizationStatus) =>
  `${status.environmentRevision}:${status.projectRevision}`;

const capabilitySignature = (capabilities: ReadonlyArray<CivilizationProviderCapability>) =>
  capabilities
    .map((capability) => `${capability.providerInstanceId}:${capability.support}`)
    .toSorted()
    .join(",");

const diagnosticWindowKey = (from: string) => from.slice(0, 13);

const sumProviderStartFailures = (buckets: ReadonlyArray<CivilizationContextAnalyticsBucket>) =>
  buckets.reduce((total, bucket) => total + bucket.outcomes.providerStartFailed, 0);

const sumPacketBudgetSuppressions = (buckets: ReadonlyArray<CivilizationContextAnalyticsBucket>) =>
  buckets.reduce(
    (total, bucket) =>
      total +
      bucket.suppressions.reduce(
        (bucketTotal, suppression) =>
          suppression.reason === "packet_budget_zero" ||
          suppression.reason === "packet_budget_too_small"
            ? bucketTotal + suppression.count
            : bucketTotal,
        0,
      ),
    0,
  );

const make = Effect.gen(function* () {
  const config = yield* ConfigService.CivilizationConfigService;
  const context = yield* ContextService.CivilizationContextService;

  const snapshot = Effect.fn("CivilizationAttentionService.snapshot")(function* (
    projectId: ProjectId,
  ) {
    const now = yield* DateTime.now;
    const generatedAt = DateTime.formatIso(now);
    const status = yield* config.status(projectId);

    if (status.status === "disabled") {
      return {
        projectId,
        generatedAt,
        items: [],
      } satisfies CivilizationAttentionSnapshot;
    }

    const from = DateTime.formatIso(
      DateTime.subtract(now, { hours: CIVILIZATION_ATTENTION_RECENT_WINDOW_HOURS }),
    );
    const [capabilities, analytics] = yield* Effect.all(
      [
        context.listCapabilities(),
        context.analytics({
          projectId,
          bucketSize: "hour",
          from,
          to: generatedAt,
        }),
      ] as const,
      { concurrency: 2 },
    );

    const items: CivilizationAttentionItem[] = [];
    const revisionKey = statusRevisionKey(status);
    const providerSignature = capabilitySignature(capabilities);

    const unsupportedCount = capabilities.filter(
      (capability) => capability.support === "unsupported",
    ).length;
    const metadataOnlyCount = capabilities.filter(
      (capability) => capability.support === "metadata_only",
    ).length;
    const fullCount = capabilities.filter((capability) => capability.support === "full").length;

    if (unsupportedCount > 0) {
      items.push({
        key: `${projectId}:civilization_degraded:${revisionKey}:${providerSignature}`,
        kind: "civilization_degraded",
        severity: "error",
        target: "overview",
        title: "Civilization is degraded",
        detail: `${unsupportedCount} provider ${unsupportedCount === 1 ? "adapter is" : "adapters are"} currently unavailable for Civilization capability inspection.`,
      });
    }

    if (metadataOnlyCount > 0 || fullCount === 0) {
      items.push({
        key: `${projectId}:provider_support_limited:${revisionKey}:${providerSignature}`,
        kind: "provider_support_limited",
        severity: fullCount === 0 ? "error" : "warning",
        target: "configuration",
        title:
          fullCount === 0
            ? "No provider has full Civilization support"
            : "Provider support is limited",
        detail:
          fullCount === 0
            ? "The selected project currently has no provider reporting full Civilization support."
            : `${metadataOnlyCount} provider ${metadataOnlyCount === 1 ? "is" : "are"} limited to Civilization metadata.`,
      });
    }

    if (status.status === "adopting") {
      items.push({
        key: `${projectId}:adoption_in_progress:${revisionKey}`,
        kind: "adoption_in_progress",
        severity: "info",
        target: "overview",
        title: "Existing threads are still being adopted",
        detail: "Civilization adoption is in progress for this project.",
      });
    }

    const providerStartFailures = sumProviderStartFailures(analytics.buckets);
    const windowKey = diagnosticWindowKey(from);
    if (providerStartFailures > 0) {
      items.push({
        key: `${projectId}:context_provider_start_failures:${windowKey}`,
        kind: "context_provider_start_failures",
        severity: "warning",
        target: "context_analytics",
        title: "Recent Civilization provider-start failures",
        detail: `${providerStartFailures} provider-start ${providerStartFailures === 1 ? "failure was" : "failures were"} recorded in the recent diagnostic window.`,
      });
    }

    const packetBudgetSuppressions = sumPacketBudgetSuppressions(analytics.buckets);
    if (packetBudgetSuppressions >= 2) {
      items.push({
        key: `${projectId}:packet_budget_pressure:${windowKey}`,
        kind: "packet_budget_pressure",
        severity: "warning",
        target: "context_analytics",
        title: "Repeated Civilization packet-budget suppression",
        detail: `${packetBudgetSuppressions} packet-budget suppressions were recorded in the recent diagnostic window.`,
      });
    }

    return {
      projectId,
      generatedAt,
      items: items.slice(0, CIVILIZATION_ATTENTION_MAX_ITEMS),
    } satisfies CivilizationAttentionSnapshot;
  });

  return { snapshot } as const;
});

export class CivilizationAttentionService extends Context.Service<
  CivilizationAttentionService,
  Effect.Success<typeof make>
>()("t3/civilization/AttentionService/CivilizationAttentionService") {}

export const layer = Layer.effect(CivilizationAttentionService, make);
