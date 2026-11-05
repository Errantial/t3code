import { assert, it } from "@effect/vitest";
import { OrchestratorMcpFailure, SwarmId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import type * as SwarmService from "./SwarmService.ts";
import { makeSwarmRpc } from "./swarmRpc.ts";

const fakeSwarms = {
  summaries: Effect.succeed({ summaries: [] }),
  act: () =>
    Effect.fail(
      new OrchestratorMcpFailure({ code: "capability_denied", message: "Not this thread's." }),
    ),
} as unknown as SwarmService.SwarmService["Service"];

const call = (enabled: boolean, swarms: Option.Option<SwarmService.SwarmService["Service"]>) =>
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    return makeSwarmRpc(settings, swarms);
  }).pipe(Effect.provide(ServerSettings.layerTest({ swarmV2Enabled: enabled })));

it.effect("refuses every swarm RPC while Swarm v2 is off, without reaching the service", () =>
  Effect.gen(function* () {
    const rpc = yield* call(false, Option.some(fakeSwarms));
    const refused = yield* rpc((swarms) => swarms.summaries).pipe(Effect.flip);
    assert.equal(refused.reason, "disabled");
  }),
);

it.effect("answers while on, and reports another thread's swarm as not found", () =>
  Effect.gen(function* () {
    const rpc = yield* call(true, Option.some(fakeSwarms));
    assert.deepEqual(yield* rpc((swarms) => swarms.summaries), { summaries: [] });
    const denied = yield* rpc((swarms) =>
      swarms.act({
        threadId: ThreadId.make("thread:other"),
        swarmId: SwarmId.make("swarm:x"),
        action: "stop_all",
      }),
    ).pipe(Effect.flip);
    assert.equal(denied.reason, "not_found");
    const missing = yield* (yield* call(true, Option.none()))((swarms) => swarms.summaries).pipe(
      Effect.flip,
    );
    assert.equal(missing.reason, "unavailable");
  }),
);
