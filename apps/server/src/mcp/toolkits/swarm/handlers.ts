// @effect-diagnostics effectFnOpportunity:off
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as ServerSettings from "../../../serverSettings.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { SwarmToolkit } from "./tools.ts";

const swarmFailure = (
  code: ConstructorParameters<typeof OrchestratorMcpFailure>[0]["code"],
  message: string,
) => new OrchestratorMcpFailure({ code, message });

/** Every swarm tool refuses while the Labs setting is off, even when a client calls it unlisted. */
export const requireSwarmV2 = Effect.gen(function* () {
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(
    Effect.mapError(() => swarmFailure("orchestration_error", "Unable to read settings.")),
  );
  if (!current.swarmV2Enabled) {
    return yield* swarmFailure(
      "capability_denied",
      "Swarm v2 is off on this machine. Turn it on in Settings > Labs.",
    );
  }
});

const notYetAvailable = (tool: string) =>
  requireSwarmV2.pipe(
    Effect.andThen(
      Effect.fail(swarmFailure("capability_denied", `${tool} is not available in this build yet.`)),
    ),
  );

export const layer = McpToolAccess.toLayer(SwarmToolkit, {
  swarm_create: McpToolAccess.actsAsCaller(() => notYetAvailable("swarm_create")),
  swarm_status: McpToolAccess.readsAsCaller(() => notYetAvailable("swarm_status")),
  swarm_cancel: McpToolAccess.actsAsCaller(() => notYetAvailable("swarm_cancel")),
  swarm_retry: McpToolAccess.actsAsCaller(() => notYetAvailable("swarm_retry")),
  swarm_collect: McpToolAccess.readsAsCaller(() => notYetAvailable("swarm_collect")),
  swarm_add_members: McpToolAccess.actsAsCaller(() => notYetAvailable("swarm_add_members")),
  swarm_followup: McpToolAccess.actsAsCaller(() => notYetAvailable("swarm_followup")),
});
