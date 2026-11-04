import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";
import { requireSwarmV2 } from "./handlers.ts";

it.effect("refuses every swarm tool while Swarm v2 is off", () =>
  Effect.gen(function* () {
    const failure = yield* requireSwarmV2.pipe(Effect.flip);
    assert.equal(failure.code, "capability_denied");
    assert.equal(
      failure.message,
      "Swarm v2 is off on this machine. Turn it on in Settings > Labs.",
    );
  }).pipe(Effect.provide(ServerSettings.layerTest())),
);

it.effect("passes while Swarm v2 is on", () =>
  requireSwarmV2.pipe(Effect.provide(ServerSettings.layerTest({ swarmV2Enabled: true }))),
);
