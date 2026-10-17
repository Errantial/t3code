import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  civilizationProviderCapability,
  resolveCivilizationProviderCapability,
} from "./ProviderCapability.ts";

const capability = (
  driver: string | undefined,
  overrides: Partial<Parameters<typeof civilizationProviderCapability>[0]> = {},
) =>
  civilizationProviderCapability({
    providerInstanceId: ProviderInstanceId.make("provider-test"),
    observedOnly: false,
    ...(driver === undefined ? {} : { driver }),
    ...overrides,
  });

it("keeps the release-one Civilization provider capability truth table explicit", () => {
  assert.deepInclude(capability("codex"), {
    support: "full",
    contextInjection: true,
    keyedContextReplacement: true,
    providerContinuationRefresh: true,
    messaging: true,
  });
  assert.deepInclude(capability("claudeAgent"), {
    support: "full",
    contextInjection: true,
    keyedContextReplacement: false,
    providerContinuationRefresh: false,
    messaging: true,
  });
  assert.deepInclude(capability("cursor"), {
    support: "metadata_only",
    contextInjection: false,
    messaging: false,
  });
  assert.deepInclude(capability("codex", { observedOnly: true }), {
    support: "metadata_only",
    contextInjection: false,
    messaging: false,
  });
  assert.deepInclude(capability(undefined, { available: false }), {
    support: "unsupported",
    contextInjection: false,
    messaging: false,
  });
});

it.effect("prefers adapter-owned Civilization capability and transport truth", () =>
  Effect.gen(function* () {
    const adapter = {
      instanceId: ProviderInstanceId.make("opencode-test"),
      driver: ProviderDriverKind.make("opencode"),
      getCivilizationCapability: () =>
        Effect.succeed({
          support: "full" as const,
          contextInjection: true,
          keyedContextReplacement: false,
          actionablePromptRefresh: true,
          providerContinuationRefresh: false,
          providerCommandRefresh: false,
          messaging: true,
          contextTransport: {
            kind: "opencode2.user_prompt",
            description: "ordinary prompt",
            trust: "untrusted" as const,
          },
        }),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

    const resolved = yield* resolveCivilizationProviderCapability({
      adapter,
      providerInstanceId: adapter.instanceId,
      observedOnly: false,
    });
    assert.deepInclude(resolved.capability, {
      providerInstanceId: adapter.instanceId,
      support: "full",
      contextInjection: true,
      keyedContextReplacement: false,
      actionablePromptRefresh: true,
      providerContinuationRefresh: false,
      messaging: true,
    });
    assert.deepEqual(resolved.transport, {
      kind: "opencode2.user_prompt",
      description: "ordinary prompt",
      trust: "untrusted",
    });
    assert.isFalse(resolved.providerCommandRefresh);
  }),
);

it.effect("keeps observed agents metadata-only without consulting the adapter hook", () =>
  Effect.gen(function* () {
    let calls = 0;
    const adapter = {
      instanceId: ProviderInstanceId.make("opencode-observed"),
      driver: ProviderDriverKind.make("opencode"),
      getCivilizationCapability: () => {
        calls += 1;
        return Effect.die("observed agents must not consult controllable capability");
      },
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

    const resolved = yield* resolveCivilizationProviderCapability({
      adapter,
      providerInstanceId: adapter.instanceId,
      observedOnly: true,
    });
    assert.strictEqual(calls, 0);
    assert.deepInclude(resolved.capability, {
      support: "metadata_only",
      contextInjection: false,
      messaging: false,
    });
  }),
);

it.effect("fails capability inspection closed when an adapter-owned hook fails", () =>
  Effect.gen(function* () {
    const adapter = {
      instanceId: ProviderInstanceId.make("opencode-broken"),
      driver: ProviderDriverKind.make("opencode"),
      getCivilizationCapability: () => Effect.fail("probe failed" as never),
    } as unknown as ProviderAdapter.ProviderAdapterV2["Service"];

    const resolved = yield* resolveCivilizationProviderCapability({
      adapter,
      providerInstanceId: adapter.instanceId,
      observedOnly: false,
    });
    assert.deepInclude(resolved.capability, {
      support: "unsupported",
      contextInjection: false,
      messaging: false,
    });
    assert.isUndefined(resolved.transport);
  }),
);
