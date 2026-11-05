import {
  type EnvironmentId,
  type SwarmActInput,
  type ThreadId,
  WS_METHODS,
} from "@t3tools/contracts";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

// Swarm v2 (SW-A10): the architect thread's panel and the sidebar chip. The server refuses all
// three while its Swarm v2 Labs setting is off, so callers check the flag first.

export const swarmListForThreadCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:swarm:list-for-thread",
  execute: Effect.fn("swarmListForThread.execute")(function* (target: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(
      target.environmentId,
      request(WS_METHODS.swarmListForThread, { threadId: target.threadId }),
    );
  }),
});

export const swarmActCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:swarm:act",
  execute: Effect.fn("swarmAct.execute")(function* (target: {
    readonly environmentId: EnvironmentId;
    readonly input: SwarmActInput;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(target.environmentId, request(WS_METHODS.swarmAct, target.input));
  }),
});
export const swarmSummariesCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:swarm:summaries",
  execute: Effect.fn("swarmSummaries.execute")(function* (target: {
    readonly environmentId: EnvironmentId;
  }) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(target.environmentId, request(WS_METHODS.swarmSummaries, {}));
  }),
});
