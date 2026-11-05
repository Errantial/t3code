import { type OrchestratorMcpFailure, SwarmRpcError } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import type * as ServerSettings from "../serverSettings.ts";
import type * as SwarmService from "./SwarmService.ts";

/**
 * The gate for the Swarm v2 panel and chip RPCs (SW-A10): refused while the Labs setting is off,
 * or without a swarm service; another thread's swarm reads as not found.
 */
export const makeSwarmRpc =
  (
    settings: ServerSettings.ServerSettingsService["Service"],
    swarmService: Option.Option<SwarmService.SwarmService["Service"]>,
  ) =>
  <A>(
    use: (swarms: SwarmService.SwarmService["Service"]) => Effect.Effect<A, OrchestratorMcpFailure>,
  ): Effect.Effect<A, SwarmRpcError> =>
    Effect.gen(function* () {
      const enabled = yield* settings.getSettings.pipe(
        Effect.map((current) => current.swarmV2Enabled),
        Effect.orElseSucceed(() => false),
      );
      if (!enabled) {
        return yield* new SwarmRpcError({
          reason: "disabled",
          message: "Swarm v2 is off on this machine.",
        });
      }
      if (Option.isNone(swarmService)) {
        return yield* new SwarmRpcError({
          reason: "unavailable",
          message: "Swarms are not available on this server.",
        });
      }
      return yield* use(swarmService.value).pipe(
        Effect.mapError(
          (error) =>
            new SwarmRpcError({
              reason: error.code === "capability_denied" ? "not_found" : "invalid_request",
              message: error.message,
            }),
        ),
      );
    });
