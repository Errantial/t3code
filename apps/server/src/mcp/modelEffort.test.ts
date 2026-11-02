import { describe, expect, it } from "@effect/vitest";
import {
  type ProviderOptionDescriptor,
  ProviderInstanceId,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import {
  effortOptionDescriptor,
  mergeOptionSelections,
  resolveEffortSelection,
} from "./modelEffort.ts";

const claudeInstanceId = ProviderInstanceId.make("claude");
const codexInstanceId = ProviderInstanceId.make("codex");

/** Claude names the option `effort` and stops at `max`. */
const claudeDescriptors: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "effort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium", isDefault: true },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
      { id: "max", label: "Max" },
    ],
  },
  { id: "fastMode", label: "Fast Mode", type: "boolean" },
];

/** Codex names the option `reasoningEffort` and starts at `minimal`. */
const codexDescriptors: ReadonlyArray<ProviderOptionDescriptor> = [
  {
    id: "reasoningEffort",
    label: "Reasoning",
    type: "select",
    options: [
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra High" },
    ],
  },
];

const resolve = (input: {
  readonly effort: string | undefined;
  readonly model?: string;
  readonly instanceId?: ProviderInstanceId;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  readonly selections?: ReadonlyArray<ProviderOptionSelection>;
}) =>
  resolveEffortSelection({
    effort: input.effort,
    model: input.model ?? "a-model",
    instanceId: input.instanceId ?? claudeInstanceId,
    descriptors: input.descriptors,
    ...(input.selections === undefined ? {} : { selections: input.selections }),
  });

describe("modelEffort", () => {
  it.effect("writes the effort to the option the provider advertises", () =>
    Effect.gen(function* () {
      expect(
        yield* resolve({
          effort: "max",
          instanceId: claudeInstanceId,
          descriptors: claudeDescriptors,
        }),
      ).toEqual({ id: "effort", value: "max" });
      expect(
        yield* resolve({
          effort: "xhigh",
          instanceId: codexInstanceId,
          descriptors: codexDescriptors,
        }),
      ).toEqual({ id: "reasoningEffort", value: "xhigh" });
    }),
  );

  it.effect("leaves the selection alone when no effort is given", () =>
    Effect.gen(function* () {
      expect(yield* resolve({ effort: undefined, descriptors: claudeDescriptors })).toBeUndefined();
      expect(yield* resolve({ effort: "   ", descriptors: claudeDescriptors })).toBeUndefined();
    }),
  );

  it.effect("refuses a level the model does not offer, naming the ones it does", () =>
    Effect.gen(function* () {
      const failure = yield* resolve({
        effort: "minimal",
        instanceId: claudeInstanceId,
        descriptors: claudeDescriptors,
      }).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toContain("Effort 'minimal' is not supported by model a-model");
      expect(failure.message).toContain("Allowed: low, medium, high, xhigh, max.");
    }),
  );

  it.effect("refuses a model without an effort option", () =>
    Effect.gen(function* () {
      const failure = yield* resolve({
        effort: "high",
        descriptors: [{ id: "fastMode", label: "Fast Mode", type: "boolean" }],
      }).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toContain("has no effort setting");
      expect(failure.message).toContain("Supported options: fastMode.");
    }),
  );

  it.effect("refuses effort when the provider has not reported model options", () =>
    Effect.gen(function* () {
      const failure = yield* resolve({ effort: "high", descriptors: undefined }).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toContain("has not reported options for model a-model");
    }),
  );

  it.effect("refuses effort given twice", () =>
    Effect.gen(function* () {
      const failure = yield* resolve({
        effort: "high",
        descriptors: claudeDescriptors,
        selections: [{ id: "effort", value: "low" }],
      }).pipe(Effect.flip);
      expect(failure.code).toBe("invalid_request");
      expect(failure.message).toContain("Set effort once");
    }),
  );

  it("finds the effort option under either provider id", () => {
    expect(effortOptionDescriptor(claudeDescriptors)?.id).toBe("effort");
    expect(effortOptionDescriptor(codexDescriptors)?.id).toBe("reasoningEffort");
    expect(effortOptionDescriptor([])).toBeUndefined();
    expect(effortOptionDescriptor(undefined)).toBeUndefined();
  });

  it("merges an effort over the same option and keeps the others", () => {
    expect(
      mergeOptionSelections(
        [
          { id: "fastMode", value: true },
          { id: "effort", value: "low" },
        ],
        [{ id: "effort", value: "max" }],
      ),
    ).toEqual([
      { id: "fastMode", value: true },
      { id: "effort", value: "max" },
    ]);
    expect(mergeOptionSelections(undefined, [{ id: "effort", value: "max" }])).toEqual([
      { id: "effort", value: "max" },
    ]);
  });
});
