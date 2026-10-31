import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { InstructionStore } from "./InstructionStore.ts";
import { makeInstructionTurnContextContributor } from "./instructionTurnContext.ts";

it.effect("delivers attached optional files as one trusted turn-context entry", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-instructions-" });
    const store = new InstructionStore(root, root);
    const role = store.putFile({
      kind: "optional",
      scope: "project",
      title: "Reviewer",
      content: "Review for race conditions.",
    });
    const sync = store.putFile({
      kind: "sync",
      scope: "global",
      title: "Global rules",
      content: "Always run tests.",
    });
    store.setThreadAttachments("thread-1", [role.id, sync.id]);

    const contributor = makeInstructionTurnContextContributor(store);
    const entry = yield* contributor.build({ threadId: "thread-1" });

    assert.isDefined(entry);
    assert.equal(entry!.key, "instruction_files");
    assert.equal(entry!.trust, "trusted");
    assert.include(entry!.text, "Review for race conditions.");
    assert.include(entry!.text, role.id);
    assert.notInclude(entry!.text, "Always run tests.");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("contributes nothing when a thread has no optional files", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-instructions-" });
    const store = new InstructionStore(root, root);
    const contributor = makeInstructionTurnContextContributor(store);
    const entry = yield* contributor.build({ threadId: "thread-empty" });
    assert.isUndefined(entry);
  }).pipe(Effect.provide(NodeServices.layer)),
);
