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
import { formatSwarmShared, makeSwarmSharedContributor } from "./swarmTurnContext.ts";

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
}): SwarmStore.SwarmStore["Service"] =>
  ({
    findMemberByChildThread: (threadId: ThreadId) =>
      Effect.succeed(
        threadId === input.memberThreadId
          ? Option.some({ swarmId: SwarmId.make("swarm:1"), specJson: JSON.stringify(spec) })
          : Option.none(),
      ),
    getSwarm: () => Effect.succeedSome({ dataShape: null, sharedContext: input.sharedContext }),
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
