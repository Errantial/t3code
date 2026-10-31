import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  DEFAULT_TURN_CONTEXT_TOTAL_MAX_BYTES,
  buildTurnContext,
  insertTurnContext,
  truncateTurnContextText,
  turnContextAdditionalContext,
  type TurnContextContributor,
} from "./turnContext.ts";

const contributor = (
  key: string,
  priority: number,
  text: string | undefined,
  extra: { readonly maxBytes?: number; readonly trust?: "trusted" | "untrusted" } = {},
): TurnContextContributor<{ readonly threadId: string }> => ({
  key,
  priority,
  trust: extra.trust ?? "trusted",
  maxBytes: extra.maxBytes ?? 4096,
  build: () =>
    Effect.succeed(text === undefined ? undefined : { key, trust: extra.trust ?? "trusted", text }),
});

describe("buildTurnContext", () => {
  it.effect("returns no entries when no contributor contributes", () =>
    Effect.gen(function* () {
      const entries = yield* buildTurnContext({
        contributors: [contributor("empty", 1, undefined), contributor("blank", 2, "   \n")],
        turn: { threadId: "thread" },
      });
      assert.deepEqual(entries, []);
    }),
  );

  it.effect("orders by priority and then key", () =>
    Effect.gen(function* () {
      const entries = yield* buildTurnContext({
        contributors: [
          contributor("late", 20, "late"),
          contributor("early_b", 10, "early b"),
          contributor("early_a", 10, "early a"),
        ],
        turn: { threadId: "thread" },
      });
      assert.deepEqual(
        entries.map((entry) => entry.key),
        ["early_a", "early_b", "late"],
      );
    }),
  );

  it.effect("caps each contributor and the total budget without splitting characters", () =>
    Effect.gen(function* () {
      const entries = yield* buildTurnContext({
        contributors: [
          contributor("first", 1, "ééééé", { maxBytes: 5 }),
          contributor("second", 2, "abcdefgh", { maxBytes: 8 }),
        ],
        turn: { threadId: "thread" },
        totalMaxBytes: 9,
      });
      assert.equal(entries.length, 2);
      assert.equal(entries[0]!.text, "éé");
      assert.equal(entries[1]!.text, "abcde");
      assert.equal(new TextEncoder().encode(entries[0]!.text).length, 4);
      assert.equal(new TextEncoder().encode(entries[1]!.text).length, 5);
      assert.isAtMost(
        entries.reduce((total, entry) => total + new TextEncoder().encode(entry.text).length, 0),
        9,
      );
    }),
  );

  it.effect("stops once the total budget is spent", () =>
    Effect.gen(function* () {
      const entries = yield* buildTurnContext({
        contributors: [
          contributor("first", 1, "1234"),
          contributor("second", 2, "5678"),
          contributor("third", 3, "9"),
        ],
        turn: { threadId: "thread" },
        totalMaxBytes: 6,
      });
      assert.deepEqual(
        entries.map((entry) => entry.text),
        ["1234", "56"],
      );
      assert.isAtMost(DEFAULT_TURN_CONTEXT_TOTAL_MAX_BYTES, 64 * 1024);
    }),
  );
});

describe("truncateTurnContextText", () => {
  it("cuts on a UTF-8 boundary", () => {
    assert.equal(truncateTurnContextText("éé", 3), "é");
    assert.equal(truncateTurnContextText("abc", 10), "abc");
    assert.equal(truncateTurnContextText("abc", 0), "");
  });
});

describe("turnContext delivery forms", () => {
  it("keys Codex additional context by contributor trust", () => {
    assert.deepEqual(
      turnContextAdditionalContext([
        { key: "files", trust: "trusted", text: "role" },
        { key: "web", trust: "untrusted", text: "page" },
      ]),
      {
        files: { kind: "application", value: "role" },
        web: { kind: "untrusted", value: "page" },
      },
    );
  });

  it("leaves a prompt identical when there is no context", () => {
    assert.equal(insertTurnContext("/compact", []), "/compact");
    assert.equal(insertTurnContext("hello", []), "hello");
  });

  it("prepends by default and keeps a slash command first when asked", () => {
    const entries = [{ key: "files", trust: "trusted" as const, text: "role" }];
    assert.match(
      insertTurnContext("hello", entries),
      /^<t3_turn_context[^>]*>\nrole\n<\/t3_turn_context>\n\nhello$/u,
    );
    const command = insertTurnContext("/review the diff", entries, { afterSlashCommand: true });
    assert.match(
      command,
      /^\/review\n\n<t3_turn_context[^>]*>\nrole\n<\/t3_turn_context> the diff$/u,
    );
    const bare = insertTurnContext("/compact", entries, { afterSlashCommand: true });
    assert.match(bare, /^\/compact\n\n<t3_turn_context/u);
  });
});
