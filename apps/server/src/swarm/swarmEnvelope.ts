import type { SwarmEnvelope, SwarmMemberStatus } from "@t3tools/contracts";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

// Swarm v2 envelopes (SW-A5): a member's result, parsed from the last t3-swarm-result block of
// its run, and the compact digest a wake carries. Envelope text is stored, never logged.

const SUMMARY_MAX_BYTES = 2_048;
const DIGEST_SUMMARY_MAX_CHARACTERS = 512;
const DIGEST_MAX_BYTES = 1_024;
const DATA_MAX_BYTES = 8_192;
const LIST_MAX_ITEMS = 10;
const LIST_ITEM_MAX_CHARACTERS = 200;
const PATH_MAX_CHARACTERS = 512;
const PATHS_MAX = 200;

const utf8 = new TextEncoder();
const byteLength = (text: string) => utf8.encode(text).length;

/** Cuts to at most `maxBytes` UTF-8 bytes without splitting a character. */
const cutBytes = (text: string, maxBytes: number): string => {
  if (byteLength(text) <= maxBytes) return text;
  let end = Math.min(text.length, maxBytes);
  while (end > 0 && byteLength(text.slice(0, end)) > maxBytes) end -= 1;
  // Do not leave half of a surrogate pair.
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return text.slice(0, end);
};

const RESULT_BLOCK = /```t3-swarm-result[^\n]*\n([\s\S]*?)\n?```/g;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value
        .filter((item): item is string => typeof item === "string")
        .slice(0, LIST_MAX_ITEMS)
        .map((item) => item.slice(0, LIST_ITEM_MAX_CHARACTERS))
    : [];

const JsonText = Schema.fromJsonString(Schema.Unknown);
const decodeJsonText = Schema.decodeOption(JsonText);
const parseJson = (text: string): unknown => Option.getOrUndefined(decodeJsonText(text));
const toJson = Schema.encodeSync(JsonText);

export interface ParsedResult {
  readonly structured: boolean;
  readonly summary: string;
  readonly decisions: ReadonlyArray<string>;
  readonly assumptions: ReadonlyArray<string>;
  readonly data?: unknown;
  readonly dataDropped: boolean;
}

/**
 * The last valid t3-swarm-result block of a run's final text. Without one, the summary is the
 * first 2 KB of the text. `data` is kept only when it is JSON of at most 8 KB; otherwise it is
 * dropped whole, never cut.
 */
export const parseSwarmResult = (text: string): ParsedResult => {
  const blocks = [...text.matchAll(RESULT_BLOCK)].map((match) => match[1] ?? "");
  for (const block of blocks.toReversed()) {
    const parsed = parseJson(block.trim());
    if (!isRecord(parsed) || typeof parsed.summary !== "string") continue;
    const hasData = "data" in parsed && parsed.data !== undefined;
    const dataJson = hasData ? toJson(parsed.data) : undefined;
    const keepData = dataJson !== undefined && byteLength(dataJson) <= DATA_MAX_BYTES;
    return {
      structured: true,
      summary: cutBytes(parsed.summary, SUMMARY_MAX_BYTES),
      decisions: strings(parsed.decisions),
      assumptions: strings(parsed.assumptions),
      ...(keepData ? { data: parsed.data } : {}),
      dataDropped: hasData && !keepData,
    };
  }
  return {
    structured: false,
    summary: cutBytes(text.trim(), SUMMARY_MAX_BYTES),
    decisions: [],
    assumptions: [],
    dataDropped: false,
  };
};

/** A glob as a whole-path regular expression: `**` spans directories, `*` and `?` do not. */
const globToRegExp = (glob: string): RegExp => {
  let pattern = "";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index]!;
    if (char === "*" && glob[index + 1] === "*") {
      const slash = glob[index + 2] === "/";
      pattern += slash ? "(?:.*/)?" : ".*";
      index += slash ? 2 : 1;
    } else if (char === "*") pattern += "[^/]*";
    else if (char === "?") pattern += "[^/]";
    else pattern += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${pattern}$`);
};

export const matchesAnyGlob = (path: string, globs: ReadonlyArray<string>): boolean =>
  globs.some((glob) => globToRegExp(glob).test(path));

/** Paths for the envelope: at most 200, each at most 512 characters with a trailing ellipsis. */
export const capChangedPaths = (paths: ReadonlyArray<string>) => {
  const unique = [...new Set(paths)];
  return {
    changedPaths: unique
      .slice(0, PATHS_MAX)
      .map((path) =>
        path.length <= PATH_MAX_CHARACTERS ? path : `${path.slice(0, PATH_MAX_CHARACTERS - 1)}…`,
      ),
    changedPathsTruncated: unique.length > PATHS_MAX,
  };
};

const escapeForWake = (json: string) => json.replace(/</g, "\\u003c");

/**
 * The compact digest a wake carries for one member, at most 1 KB of UTF-8: no output tail and
 * no `data`. The full envelope is read with swarm_collect.
 */
export const swarmDigest = (input: {
  readonly key: string;
  readonly envelope: SwarmEnvelope;
}): string => {
  const { envelope } = input;
  const render = (summary: string) => {
    const body = {
      key: input.key,
      status: envelope.status,
      attempt: envelope.attempt,
      followup: envelope.followup,
      structured: envelope.structured,
      summary,
      ...(envelope.verify === undefined
        ? {}
        : {
            verify: {
              passed: envelope.verify.passed,
              exitCode: envelope.verify.exitCode,
              timedOut: envelope.verify.timedOut,
            },
          }),
      changedPaths: envelope.artifacts.changedPaths.length,
      changedPathsTruncated: envelope.artifacts.changedPathsTruncated,
      testFilesChanged: envelope.testFilesChanged,
      ...(envelope.failure === undefined ? {} : { failureClass: envelope.failure.class }),
      hasData: envelope.data !== undefined,
    };
    return `<swarm-member-result trust="data">${escapeForWake(toJson(body))}\nFull result: swarm_collect</swarm-member-result>`;
  };
  let summary = envelope.summary.slice(0, DIGEST_SUMMARY_MAX_CHARACTERS);
  let digest = render(summary);
  // Multibyte summaries can still overflow; shorten until the digest fits.
  while (byteLength(digest) > DIGEST_MAX_BYTES && summary.length > 0) {
    summary = summary.slice(0, Math.max(0, summary.length - 16));
    digest = render(summary);
  }
  return digest;
};

/** A member status a final envelope may carry. */
export type FinalMemberStatus = Extract<
  SwarmMemberStatus,
  "claimed_done" | "verified" | "failed" | "cancelled"
>;
