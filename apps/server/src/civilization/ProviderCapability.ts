import type { CivilizationProviderCapability, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export interface CivilizationProviderCapabilityInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driver?: string;
  readonly observedOnly: boolean;
  readonly available?: boolean;
}

/**
 * Release-one Civilization capability truth shared by context and messaging.
 * Provider-native observed agents never gain controllable capabilities, and
 * an unavailable adapter is reported as unsupported rather than guessed.
 */
export function civilizationProviderCapability(
  input: CivilizationProviderCapabilityInput,
): CivilizationProviderCapability {
  if (input.available === false) {
    return {
      providerInstanceId: input.providerInstanceId,
      support: "unsupported",
      contextInjection: false,
      keyedContextReplacement: false,
      actionablePromptRefresh: false,
      providerContinuationRefresh: false,
      messaging: false,
      detail: "The registered provider adapter is currently unavailable for capability inspection.",
    };
  }
  if (input.observedOnly) {
    return {
      providerInstanceId: input.providerInstanceId,
      support: "metadata_only",
      contextInjection: false,
      keyedContextReplacement: false,
      actionablePromptRefresh: false,
      providerContinuationRefresh: false,
      messaging: false,
      detail: "Provider-owned observed agents are census/lineage metadata only.",
    };
  }
  if (input.driver === "codex") {
    return {
      providerInstanceId: input.providerInstanceId,
      support: "full",
      contextInjection: true,
      keyedContextReplacement: true,
      actionablePromptRefresh: true,
      providerContinuationRefresh: true,
      messaging: true,
    };
  }
  if (input.driver === "claudeAgent") {
    return {
      providerInstanceId: input.providerInstanceId,
      support: "full",
      contextInjection: true,
      keyedContextReplacement: false,
      actionablePromptRefresh: true,
      providerContinuationRefresh: false,
      messaging: true,
      detail:
        "Claude receives the latest packet on actionable prompts; provider-native continuation frames have no injection boundary.",
    };
  }
  return {
    providerInstanceId: input.providerInstanceId,
    support: "metadata_only",
    contextInjection: false,
    keyedContextReplacement: false,
    actionablePromptRefresh: false,
    providerContinuationRefresh: false,
    messaging: false,
    detail: "This provider is release-one census/identity metadata only.",
  };
}

export const resolveCivilizationProviderCapability = Effect.fn(
  "Civilization.resolveProviderCapability",
)(function* (input: {
  readonly adapter: ProviderAdapter.ProviderAdapterV2["Service"];
  readonly providerInstanceId: ProviderInstanceId;
  readonly observedOnly: boolean;
}) {
  if (input.observedOnly || input.adapter.getCivilizationCapability === undefined) {
    return {
      capability: civilizationProviderCapability({
        providerInstanceId: input.providerInstanceId,
        driver: input.adapter.driver,
        observedOnly: input.observedOnly,
      }),
      transport: input.adapter.civilizationContextTransport,
      providerCommandRefresh: input.adapter.driver === "codex",
    } as const;
  }

  return yield* input.adapter.getCivilizationCapability().pipe(
    Effect.map((profile) => {
      const { contextTransport, providerCommandRefresh, ...capability } = profile;
      return {
        capability: {
          providerInstanceId: input.providerInstanceId,
          ...capability,
        } satisfies CivilizationProviderCapability,
        transport: contextTransport,
        providerCommandRefresh,
      } as const;
    }),
    Effect.catch(() =>
      Effect.succeed({
        capability: civilizationProviderCapability({
          providerInstanceId: input.providerInstanceId,
          observedOnly: false,
          available: false,
        }),
        transport: undefined,
        providerCommandRefresh: false,
      } as const),
    ),
  );
});
