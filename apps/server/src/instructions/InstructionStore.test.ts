import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { InstructionStore } from "./InstructionStore.ts";

it.effect("stores a per-environment profile and filters unknown file ids", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-instructions-" });
    const store = new InstructionStore(root, root);
    const shared = store.putFile({ scope: "project", title: "Shared", content: "s" });
    const env = store.putFile({ scope: "project", title: "Env", content: "e" });

    const profile = store.setProfile({
      projectId: "project-1",
      mode: "per-environment",
      shared: [shared.id, "missing"],
      environments: { "environment-1": [env.id, "missing"] },
    });
    assert.deepEqual(profile.shared, [shared.id]);
    assert.deepEqual(profile.environments["environment-1"], [env.id]);
    assert.equal(store.profile("project-1").mode, "per-environment");
    assert.deepEqual(store.profile("unset").shared, []);
    assert.equal(store.snapshot().profiles["project-1"]?.mode, "per-environment");
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("materialize stops on drift unless forced", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-instructions-" });
    const store = new InstructionStore(root, root);
    const target = path.join(root, "AGENTS.md");
    const file = store.putFile({ scope: "global", title: "Rules", content: "first" });
    store.setSync({
      fileId: file.id,
      targets: [{ provider: "custom", scope: "global", path: target }],
    });
    assert.include(yield* fileSystem.readFileString(target), "first");

    yield* fileSystem.writeFileString(target, "edited locally");
    const stopped = store.materializeAll();
    assert.equal(stopped.written.length, 0);
    assert.deepEqual(stopped.conflicts, [{ fileId: file.id, path: target }]);
    assert.equal(yield* fileSystem.readFileString(target), "edited locally");

    const forced = store.materializeAll({ force: true });
    assert.equal(forced.conflicts.length, 0);
    assert.equal(forced.written.length, 1);
    assert.include(yield* fileSystem.readFileString(target), "first");
  }).pipe(Effect.provide(NodeServices.layer)),
);
