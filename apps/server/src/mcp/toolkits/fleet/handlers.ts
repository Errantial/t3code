import {
  type EnvironmentId,
  FleetStatusResult,
  FleetUpdateError,
  FleetUpdateResult,
  type FleetUpdateMachineResult,
  type PeerLinkSummary,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as FleetUpdates from "../../../fleetUpdate/FleetUpdates.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller } from "../../threadAccess.ts";
import { FleetToolkit } from "./tools.ts";

const orchestrationFailure = (message: string) =>
  new OrchestratorMcpFailure({ code: "orchestration_error", message });

const confirmationFailure = () =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message:
      "A fleet update changes machines. Plan with dryRun:true, then call again with confirm:true after the user confirms.",
  });

const toToolFailure = (error: FleetUpdateError) =>
  new OrchestratorMcpFailure({
    code:
      error.reason === "release_unavailable" || error.reason === "failed"
        ? "orchestration_error"
        : "invalid_request",
    message: error.message,
  });

const toMachineResult = (result: FleetUpdateResult): FleetUpdateMachineResult => ({
  environmentId: result.machine.environmentId,
  label: result.machine.label,
  action: result.action,
  fromVersion: result.fromVersion,
  toVersion: result.toVersion,
  ...(result.reason === undefined ? {} : { reason: result.reason }),
});

const failedMachineResult = (input: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly fromVersion: string;
  readonly toVersion: string;
  readonly reason: string;
}): FleetUpdateMachineResult => ({
  environmentId: input.environmentId,
  label: input.label,
  action: "failed",
  fromVersion: input.fromVersion,
  toVersion: input.toVersion,
  reason: input.reason,
});

interface Inventory {
  readonly local: FleetStatusResult;
  readonly release: FleetStatusResult["release"];
  readonly links: ReadonlyArray<PeerLinkSummary>;
  readonly machines: ReadonlyArray<FleetStatusResult["machine"]>;
  readonly errors: ReadonlyArray<{ readonly environmentId: string; readonly message: string }>;
}

/** This machine plus every enabled, unexpired link, as the fleet sees them. */
const inventory = Effect.fn("FleetToolkit.inventory")(function* (input: {
  readonly tag?: string | undefined;
}) {
  const fleet = yield* FleetUpdates.makeService();
  const peers = yield* PeerLinks.PeerLinks;
  const client = yield* PeerMcpClient.PeerMcpClient;
  const caller = yield* readCaller();
  const local = yield* fleet.status({ tag: input.tag });
  const enabled = yield* peers.enabled.pipe(Effect.orElseSucceed(() => false));
  const links = enabled
    ? yield* peers.list.pipe(Effect.orElseSucceed((): ReadonlyArray<PeerLinkSummary> => []))
    : [];
  let release = local.release;
  const machines: Array<FleetStatusResult["machine"]> = [local.machine];
  const errors: Array<{ readonly environmentId: string; readonly message: string }> = [];
  for (const link of links) {
    if (link.status === "expired") {
      errors.push({
        environmentId: link.environmentId,
        message: link.lastError ?? "The link expired; link this environment again there.",
      });
      continue;
    }
    const remote = yield* client
      .call({
        environmentId: link.environmentId,
        tool: "t3_server_fleet_status",
        arguments: { tag: input.tag },
        limits: caller.limits,
        success: FleetStatusResult,
      })
      .pipe(Effect.result);
    if (remote._tag === "Failure") {
      errors.push({ environmentId: link.environmentId, message: remote.failure.message });
      continue;
    }
    machines.push(remote.success.machine);
    if (release === null && remote.success.release !== null) release = remote.success.release;
  }
  return { local, release, links, machines, errors } satisfies Inventory;
});

const fleetUpdateStatus = (input: { readonly tag?: string | undefined }) =>
  inventory(input).pipe(
    Effect.map((found) => ({
      release: found.release,
      machines: found.machines,
      errors: found.errors,
    })),
  );

const fleetUpdate = Effect.fn("FleetToolkit.update")(function* (input: {
  readonly targets?: "all" | ReadonlyArray<EnvironmentId> | undefined;
  readonly tag?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly confirm?: boolean | undefined;
  readonly continueOnFailure?: boolean | undefined;
}) {
  const dryRun = input.dryRun ?? true;
  if (!dryRun && input.confirm !== true) return yield* confirmationFailure();
  const found = yield* inventory({ tag: input.tag });
  const release = found.release;
  if (release === null) {
    return yield* orchestrationFailure(
      found.local.releaseError ?? "The fleet release could not be resolved.",
    );
  }
  const fleet = yield* FleetUpdates.makeService();
  const client = yield* PeerMcpClient.PeerMcpClient;
  const caller = yield* readCaller();
  const localId = found.local.machine.environmentId;
  const linkById = new Map(found.links.map((link) => [String(link.environmentId), link]));
  const named =
    input.targets === undefined || input.targets === "all"
      ? [
          localId,
          ...found.links
            .filter((link) => link.status !== "expired")
            .map((link) => link.environmentId),
        ]
      : input.targets;
  // Update peers first: updating this machine can restart the server running this call.
  const ordered = [
    ...named.filter((environmentId) => String(environmentId) !== String(localId)),
    ...(named.some((environmentId) => String(environmentId) === String(localId)) ? [localId] : []),
  ];
  const machineById = new Map(
    found.machines.map((machine) => [String(machine.environmentId), machine]),
  );
  const results: Array<FleetUpdateMachineResult> = [];
  const updateInput = {
    tag: release.tag,
    dryRun,
    ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
  } as const;
  for (const environmentId of ordered) {
    const known = machineById.get(String(environmentId));
    if (known === undefined) {
      results.push(
        failedMachineResult({
          environmentId,
          label: String(environmentId),
          fromVersion: "",
          toVersion: release.version,
          reason: "This environment is not linked here, so the fleet cannot reach it.",
        }),
      );
      if (input.continueOnFailure !== true) break;
      continue;
    }
    if (String(environmentId) === String(localId)) {
      const updated = yield* fleet.update(updateInput).pipe(Effect.result);
      results.push(
        updated._tag === "Failure"
          ? failedMachineResult({
              environmentId,
              label: known.label,
              fromVersion: known.currentVersion,
              toVersion: release.version,
              reason: updated.failure.message,
            })
          : toMachineResult(updated.success),
      );
    } else {
      const link = linkById.get(String(environmentId));
      const remote = yield* client
        .call({
          environmentId,
          tool: "t3_server_fleet_update",
          arguments: {
            tag: release.tag,
            dryRun,
            ...(input.confirm === undefined ? {} : { confirm: input.confirm }),
          },
          limits: caller.limits,
          success: FleetUpdateResult,
        })
        .pipe(Effect.result);
      results.push(
        remote._tag === "Failure"
          ? failedMachineResult({
              environmentId,
              label: link?.label ?? known.label,
              fromVersion: known.currentVersion,
              toVersion: release.version,
              reason: remote.failure.message,
            })
          : toMachineResult(remote.success),
      );
    }
    const last = results[results.length - 1];
    if (last?.action === "failed" && input.continueOnFailure !== true) break;
  }
  return { release, dryRun, results };
});

export const layer = McpToolAccess.toLayer(FleetToolkit, {
  fleet_update_status: McpToolAccess.reads(fleetUpdateStatus),
  fleet_update: McpToolAccess.writesEnvironment(
    (input, check) => check.pipe(Effect.andThen(fleetUpdate(input))),
    { linkedCallers: "allowed" },
  ),
  t3_server_fleet_status: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const fleet = yield* FleetUpdates.makeService();
      return yield* fleet.status({ tag: input.tag });
    }),
  ),
  t3_server_fleet_update: McpToolAccess.writesEnvironment(
    (input, check) =>
      check.pipe(
        Effect.andThen(
          Effect.gen(function* () {
            const fleet = yield* FleetUpdates.makeService();
            return yield* fleet.update(input).pipe(Effect.mapError(toToolFailure));
          }),
        ),
      ),
    { linkedCallers: "allowed" },
  ),
} satisfies McpToolAccess.Handlers<typeof FleetToolkit.tools>);
