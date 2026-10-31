import * as Effect from "effect/Effect";

/** Who authored a context entry; adapters map this to their own trust model. */
export type TurnContextTrust = "trusted" | "untrusted";

/**
 * One neutral block handed to every provider adapter. Adapters decide where it
 * rides: Codex keys it into `additionalContext`, Claude leads the prompt text,
 * ACP-based providers prefix the prompt.
 */
export interface TurnContextEntry {
  readonly key: string;
  readonly trust: TurnContextTrust;
  readonly text: string;
}

/**
 * Ordered, budgeted contributor registry. Contributors run after the run's
 * ownership check so a settled run never pays for context their turn cannot use.
 */
export interface TurnContextContributor<Turn, R = never> {
  /** Stable key; also the Codex `additionalContext` key. */
  readonly key: string;
  readonly trust: TurnContextTrust;
  /** Lower runs first. */
  readonly priority: number;
  /** Hard cap for this contributor's own entry. */
  readonly maxBytes: number;
  readonly build: (turn: Turn) => Effect.Effect<TurnContextEntry | undefined, never, R>;
}

export const DEFAULT_TURN_CONTEXT_TOTAL_MAX_BYTES = 64 * 1024;

const encoder = new TextEncoder();

/** Truncates on a UTF-8 boundary so a byte budget cannot split a character. */
export function truncateTurnContextText(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return "";
  const bytes = encoder.encode(text);
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0) {
    try {
      return new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, end));
    } catch {
      end -= 1;
    }
  }
  return "";
}

/**
 * Builds the turn's context in priority order, applying each contributor's own
 * cap first and the shared total budget second. A contributor that fails never
 * fails the turn; it contributes nothing.
 */
export function buildTurnContext<Turn, R = never>(input: {
  readonly contributors: ReadonlyArray<TurnContextContributor<Turn, R>>;
  readonly turn: Turn;
  readonly totalMaxBytes?: number;
}): Effect.Effect<ReadonlyArray<TurnContextEntry>, never, R> {
  const totalMaxBytes = input.totalMaxBytes ?? DEFAULT_TURN_CONTEXT_TOTAL_MAX_BYTES;
  const ordered = [...input.contributors].sort(
    (left, right) => left.priority - right.priority || left.key.localeCompare(right.key),
  );
  return Effect.gen(function* () {
    const entries: TurnContextEntry[] = [];
    const seen = new Set<string>();
    let used = 0;
    for (const contributor of ordered) {
      if (seen.has(contributor.key)) continue;
      const built = yield* contributor
        .build(input.turn)
        .pipe(Effect.catchCause(() => Effect.void.pipe(Effect.as(undefined))));
      if (built === undefined || built.text.trim().length === 0) continue;
      const perContributor = truncateTurnContextText(built.text, contributor.maxBytes);
      if (perContributor.length === 0) continue;
      const remaining = totalMaxBytes - used;
      if (remaining <= 0) break;
      const text = truncateTurnContextText(perContributor, remaining);
      if (text.length === 0) break;
      entries.push({ key: contributor.key, trust: built.trust, text });
      seen.add(contributor.key);
      used += encoder.encode(text).length;
      if (used >= totalMaxBytes) break;
    }
    return entries;
  });
}

export function turnContextAdditionalContext(
  entries: ReadonlyArray<TurnContextEntry> | undefined,
): Record<string, { readonly kind: "application" | "untrusted"; readonly value: string }> {
  return Object.fromEntries(
    (entries ?? []).map((entry) => [
      entry.key,
      {
        kind: entry.trust === "trusted" ? ("application" as const) : ("untrusted" as const),
        value: entry.text,
      },
    ]),
  );
}

const escapeAttribute = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

/** The shared prompt form used by Claude and ACP-based providers. */
function turnContextPromptBlock(entries: ReadonlyArray<TurnContextEntry>): string {
  return entries
    .map(
      (entry) =>
        `<t3_turn_context key="${escapeAttribute(entry.key)}" trust="${entry.trust}">\n${entry.text}\n</t3_turn_context>`,
    )
    .join("\n\n");
}

/**
 * Prepends a context block. With `afterSlashCommand`, a native slash command
 * keeps the first token so providers still recognize it; the context follows
 * the command and precedes its arguments.
 */
export function insertTurnContext(
  prompt: string,
  entries: ReadonlyArray<TurnContextEntry> | undefined,
  options: { readonly afterSlashCommand?: boolean } = {},
): string {
  if (entries === undefined || entries.length === 0) return prompt;
  const block = turnContextPromptBlock(entries);
  if (!options.afterSlashCommand) return `${block}\n\n${prompt}`;
  const leading = prompt.length - prompt.trimStart().length;
  const trimmed = prompt.trimStart();
  if (!trimmed.startsWith("/")) return `${block}\n\n${prompt}`;
  const commandEnd = trimmed.search(/\s/);
  if (commandEnd === -1) return `${prompt}\n\n${block}`;
  const command = trimmed.slice(0, commandEnd);
  const rest = trimmed.slice(commandEnd);
  return `${prompt.slice(0, leading)}${command}\n\n${block}${rest}`;
}
