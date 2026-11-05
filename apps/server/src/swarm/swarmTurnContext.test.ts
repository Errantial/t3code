import { assert, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, SwarmId, ThreadId } from "@t3tools/contracts";
import {
  buildTurnContext,
  type TurnContextContributor,
} from "@t3tools/provider-core/server/turnContext";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as SwarmStore from "./SwarmStore.ts";
import type { SwarmMemberSpec } from "./swarmPlanning.ts";
import {
  formatSwarmMember,
  formatSwarmShared,
  makeSwarmMemberContributor,
  makeSwarmSharedContributor,
} from "./swarmTurnContext.ts";

const spec: SwarmMemberSpec = {
  key: "web",
  title: "Web",
  task: "Act as the review sub-agent for this task.\n\nReview the forms.",
  role: "review",
  isolation: "worktree",
  ownsPaths: ["apps/web/src/forms"],
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  driver: ProviderDriverKind.make("codex"),
  runtimeCeiling: "full-access",
  interactionCeiling: "default",
};

const storeWith = (input: {
  readonly memberThreadId: string;
  readonly sharedContext: string | null;
  readonly dataShape?: string | null;
  readonly spec?: SwarmMemberSpec;
  readonly effectiveInteractionMode?: "plan" | "default" | null;
}): SwarmStore.SwarmStore["Service"] =>
  ({
    findMemberByChildThread: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === input.memberThreadId
          ? Option.some({
              swarmId: SwarmId.make("swarm:1"),
              specJson: JSON.stringify(input.spec ?? spec),
              effectiveInteractionMode: input.effectiveInteractionMode ?? null,
            })
          : Option.none(),
      ),
    getSwarm: () =>
      Effect.succeedSome({
        dataShape: input.dataShape ?? null,
        sharedContext: input.sharedContext,
      }),
  }) as unknown as SwarmStore.SwarmStore["Service"];

const instructionFiles: TurnContextContributor<{ readonly threadId: string }> = {
  key: "instruction_files",
  trust: "trusted",
  priority: 100,
  maxBytes: 32 * 1024,
  build: () => Effect.succeed({ key: "instruction_files", trust: "trusted", text: "files" }),
};

it.effect(
  "gives a swarm member its shared fields as untrusted context after instruction files",
  () =>
    Effect.gen(function* () {
      const store = storeWith({ memberThreadId: "thread:member", sharedContext: "Background." });
      const entries = yield* buildTurnContext({
        contributors: [makeSwarmSharedContributor(store), instructionFiles],
        turn: { threadId: "thread:member" },
      });
      assert.deepEqual(
        entries.map((entry) => [entry.key, entry.trust]),
        [
          ["instruction_files", "trusted"],
          ["swarm_shared", "untrusted"],
        ],
      );
      assert.equal(
        entries[1]?.text,
        "Role: review\nPaths you own: apps/web/src/forms\nShared context from the architect:\nBackground.",
      );
    }),
);

it.effect("gives a thread that is not a swarm member nothing", () =>
  Effect.gen(function* () {
    const store = storeWith({ memberThreadId: "thread:member", sharedContext: "Background." });
    const entries = yield* buildTurnContext({
      contributors: [makeSwarmSharedContributor(store)],
      turn: { threadId: "thread:other" },
    });
    assert.deepEqual(entries, []);
  }),
);

it.effect("caps the entry at 20 KB, cutting only the shared context", () =>
  Effect.gen(function* () {
    const store = storeWith({ memberThreadId: "thread:member", sharedContext: "s".repeat(30_000) });
    const [entry] = yield* buildTurnContext({
      contributors: [makeSwarmSharedContributor(store)],
      turn: { threadId: "thread:member" },
    });
    assert.equal(Buffer.byteLength(entry!.text), 20_480);
    assert.isTrue(entry!.text.startsWith("Role: review\nPaths you own: apps/web/src/forms\n"));
  }),
);

it("orders the architect's fields with the shared context last", () => {
  assert.equal(
    formatSwarmShared({
      spec: { ...spec, doneCriteria: "Tests pass.", verifyArgv: ["pnpm", "test"] },
      dataShape: "{ findings: string[] }",
      sharedContext: "Background.",
    }),
    [
      "Role: review",
      "Done when: Tests pass.",
      "Paths you own: apps/web/src/forms",
      'Verify command: ["pnpm","test"]',
      "Shape of your result data: { findings: string[] }",
      "Shared context from the architect:",
      "Background.",
    ].join("\n"),
  );
  const { role: _role, ownsPaths: _ownsPaths, ...bare } = spec;
  assert.isUndefined(formatSwarmShared({ spec: bare, dataShape: null, sharedContext: null }));
});

it.effect("gives a member the trusted contract with the result block, and a non-member none", () =>
  Effect.gen(function* () {
    const store = storeWith({ memberThreadId: "thread:member", sharedContext: null });
    const [entry] = yield* buildTurnContext({
      contributors: [makeSwarmMemberContributor(store)],
      turn: { threadId: "thread:member" },
    });
    assert.equal(entry?.key, "swarm_member");
    assert.equal(entry?.trust, "trusted");
    assert.include(entry!.text, '```t3-swarm-result\n{"summary"');
    assert.include(entry!.text, "Do not start a swarm of your own");
    assert.notInclude(entry!.text, "planning member");
    assert.notInclude(entry!.text, "`data`");
    const none = yield* buildTurnContext({
      contributors: [makeSwarmMemberContributor(store)],
      turn: { threadId: "thread:other" },
    });
    assert.deepEqual(none, []);
  }),
);

it.effect("adds the planning and dataShape lines, and stays within 2 KB with every line", () =>
  Effect.gen(function* () {
    const store = storeWith({
      memberThreadId: "thread:member",
      sharedContext: null,
      dataShape: "{ findings: string[] }",
      effectiveInteractionMode: "plan",
    });
    const [entry] = yield* buildTurnContext({
      contributors: [makeSwarmMemberContributor(store)],
      turn: { threadId: "thread:member" },
    });
    assert.include(entry!.text, "do not edit files");
    assert.include(entry!.text, "Put your findings in `data`");
    // Every optional line together still fits, so the cap never cuts the contract.
    const longest = formatSwarmMember({
      planning: true,
      verifies: true,
      allowNestedSwarm: false,
      hasDataShape: true,
    });
    assert.isAtMost(Buffer.byteLength(longest), 2_048);
  }),
);

it.effect("orders swarm_member, instruction files, then swarm_shared (95, 100, 105)", () =>
  Effect.gen(function* () {
    const store = storeWith({ memberThreadId: "thread:member", sharedContext: "Background." });
    const entries = yield* buildTurnContext({
      contributors: [
        makeSwarmSharedContributor(store),
        instructionFiles,
        makeSwarmMemberContributor(store),
      ],
      turn: { threadId: "thread:member" },
    });
    assert.deepEqual(
      entries.map((entry) => [entry.key, entry.trust]),
      [
        ["swarm_member", "trusted"],
        ["instruction_files", "trusted"],
        ["swarm_shared", "untrusted"],
      ],
    );
    // swarm_shared holds what the architect wrote, never the server's contract.
    assert.notInclude(entries[2]!.text, "t3-swarm-result");
    assert.notInclude(entries[2]!.text, "You are a member");
  }),
);

it.effect(
  "keeps swarm_member whole behind 60 KB of instruction files and a 60 KB contributor",
  () =>
    Effect.gen(function* () {
      const store = storeWith({ memberThreadId: "thread:member", sharedContext: null });
      const sixtyKb = "i".repeat(60 * 1024);
      const bigFiles: TurnContextContributor<{ readonly threadId: string }> = {
        ...instructionFiles,
        build: () => Effect.succeed({ key: "instruction_files", trust: "trusted", text: sixtyKb }),
      };
      const synthetic: TurnContextContributor<{ readonly threadId: string }> = {
        key: "synthetic",
        trust: "trusted",
        priority: 100,
        maxBytes: 64 * 1024,
        build: () => Effect.succeed({ key: "synthetic", trust: "trusted", text: sixtyKb }),
      };
      const entries = yield* buildTurnContext({
        contributors: [bigFiles, synthetic, makeSwarmMemberContributor(store)],
        turn: { threadId: "thread:member" },
      });
      const member = entries.find((entry) => entry.key === "swarm_member");
      assert.equal(
        member?.text,
        formatSwarmMember({
          planning: false,
          verifies: false,
          allowNestedSwarm: false,
          hasDataShape: false,
        }),
      );
      assert.equal(entries[0]?.key, "swarm_member");
      assert.equal(
        Buffer.byteLength(entries.find((entry) => entry.key === "instruction_files")!.text),
        32 * 1024,
      );
    }),
);
