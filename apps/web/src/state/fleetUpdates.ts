import { type EnvironmentId, WS_METHODS } from "@t3tools/contracts";
import { EnvironmentRegistry } from "@t3tools/client-runtime/connection";
import { request } from "@t3tools/client-runtime/rpc";
import { createRuntimeCommand } from "@t3tools/client-runtime/state/runtime";
import * as Effect from "effect/Effect";

import { connectionAtomRuntime } from "../connection/runtime";

export interface FleetStatusTarget {
  readonly environmentId: EnvironmentId;
  readonly tag?: string;
}

export interface FleetUpdateTarget {
  readonly environmentId: EnvironmentId;
  readonly tag?: string;
  readonly dryRun?: boolean;
  readonly confirm?: boolean;
}

export const fleetStatusCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:fleet:status",
  execute: Effect.fn("fleetStatus.execute")(function* (target: FleetStatusTarget) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(
      target.environmentId,
      request(WS_METHODS.fleetStatus, { tag: target.tag }),
    );
  }),
});

export const fleetUpdateCommand = createRuntimeCommand(connectionAtomRuntime, {
  label: "environment-data:fleet:update",
  concurrency: {
    mode: "singleFlight",
    key: (target: FleetUpdateTarget) => target.environmentId,
  },
  execute: Effect.fn("fleetUpdate.execute")(function* (target: FleetUpdateTarget) {
    const registry = yield* EnvironmentRegistry.EnvironmentRegistry;
    return yield* registry.run(
      target.environmentId,
      request(WS_METHODS.fleetUpdate, {
        tag: target.tag,
        dryRun: target.dryRun,
        confirm: target.confirm,
      }),
    );
  }),
});
