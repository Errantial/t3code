import {
  OrchestratorMcpFailure,
  type ModelSelection,
  type ProviderInstanceId,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

/**
 * The provider option that carries an effort or reasoning level: `effort` on
 * Claude, `reasoningEffort` on Codex, `thinking` on Pi/Grok. Agents name a level
 * once, as `effort`, and the server writes it to the option the model
 * advertises.
 */
const EFFORT_OPTION_IDS = ["effort", "reasoningEffort", "thinking"] as const;

export function effortOptionDescriptor(
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ProviderOptionDescriptor | undefined {
  return EFFORT_OPTION_IDS.map((id) => descriptors?.find((candidate) => candidate.id === id)).find(
    (descriptor) => descriptor !== undefined,
  );
}

/** Later selections replace earlier ones with the same option id. */
export function mergeOptionSelections(
  base: ReadonlyArray<ProviderOptionSelection> | undefined,
  overrides: ReadonlyArray<ProviderOptionSelection>,
): ReadonlyArray<ProviderOptionSelection> {
  const merged = new Map((base ?? []).map((selection) => [selection.id, selection]));
  for (const selection of overrides) merged.set(selection.id, selection);
  return [...merged.values()];
}

/**
 * Drops options a model does not advertise, reporting their ids. An undefined
 * descriptor list means the provider has not reported capabilities yet, so the
 * selection is left alone rather than guessed at.
 */
export function retainSupportedOptions(input: {
  readonly selection: ModelSelection;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
}): { readonly selection: ModelSelection; readonly optionsDropped: ReadonlyArray<string> } {
  if (input.descriptors === undefined || input.selection.options === undefined) {
    return { selection: input.selection, optionsDropped: [] };
  }
  const supported = new Set(input.descriptors.map((descriptor) => descriptor.id));
  const kept = input.selection.options.filter((option) => supported.has(option.id));
  const optionsDropped = input.selection.options
    .filter((option) => !supported.has(option.id))
    .map((option) => option.id);
  return {
    selection: { ...input.selection, options: kept },
    optionsDropped,
  };
}

/**
 * Turns an agent's `effort` into the model's own effort option, checked against
 * what that model advertises. A model without the option, or a level it does
 * not offer, is refused rather than silently ignored.
 */
export const resolveEffortSelection = Effect.fn("mcp.resolveEffortSelection")(function* (input: {
  readonly effort: string | undefined;
  readonly model: string;
  readonly instanceId: ProviderInstanceId;
  readonly descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined;
  /** Options already asked for, so one effort source cannot be given twice. */
  readonly selections?: ReadonlyArray<ProviderOptionSelection> | undefined;
}): Effect.fn.Return<ProviderOptionSelection | undefined, OrchestratorMcpFailure> {
  const effort = input.effort?.trim();
  if (effort === undefined || effort.length === 0) return undefined;
  if (input.descriptors === undefined) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Provider ${input.instanceId} has not reported options for model ${input.model}, so effort cannot be set. Call orchestrator_capabilities and retry once it lists that model's options.`,
    });
  }
  const descriptor = effortOptionDescriptor(input.descriptors);
  if (descriptor === undefined) {
    const known = input.descriptors.map((candidate) => candidate.id).join(", ");
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Model ${input.model} on provider ${input.instanceId} has no effort setting. Supported options: ${known.length > 0 ? known : "none"}.`,
    });
  }
  if (descriptor.type !== "select") {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Option ${descriptor.id} on model ${input.model} is not a list of effort levels.`,
    });
  }
  if (input.selections?.some((selection) => selection.id === descriptor.id) === true) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Set effort once: either \`effort\` or the ${descriptor.id} option, not both.`,
    });
  }
  const allowed = descriptor.options.map((choice) => choice.id);
  if (!allowed.includes(effort)) {
    return yield* new OrchestratorMcpFailure({
      code: "invalid_request",
      message: `Effort '${effort}' is not supported by model ${input.model} on provider ${input.instanceId}. Allowed: ${allowed.join(", ")}.`,
    });
  }
  return { id: descriptor.id, value: effort };
});
