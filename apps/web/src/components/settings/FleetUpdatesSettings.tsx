import type { FleetStatusResult, FleetUpdateResult } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { useEnvironments } from "~/state/environments";
import {
  fleetStatusCommand,
  fleetUpdateCommand,
  type FleetUpdateTarget,
} from "~/state/fleetUpdates";
import { useAtomCommand } from "~/state/use-atom-command";
import { environmentIdsKey } from "~/state/environmentAtomList";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface RowState {
  readonly status?: FleetStatusResult | undefined;
  readonly statusError?: string | undefined;
  readonly result?: FleetUpdateResult | undefined;
  readonly updateError?: string | undefined;
}

function failureMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value);
}

function variantLabel(variant: FleetStatusResult["machine"]["variant"]): string {
  switch (variant) {
    case "windows-desktop":
      return "Windows desktop";
    case "linux-service":
      return "Linux service";
    default:
      return "Manual update";
  }
}

export function FleetUpdatesSettings() {
  const { environments } = useEnvironments();
  const statusCommand = useAtomCommand(fleetStatusCommand, { reportFailure: false });
  const updateCommand = useAtomCommand(fleetUpdateCommand, { reportFailure: false });
  const [rows, setRows] = useState<Record<string, RowState>>({});
  const [busyIds, setBusyIds] = useState<ReadonlySet<string>>(new Set());
  const [refreshToken, setRefreshToken] = useState(0);
  const ids = environmentIdsKey(environments.map((environment) => environment.environmentId));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- fleet status is an RPC per environment; there is no atom for it.
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      const entries = await Promise.all(
        // oxlint-disable-next-line react/exhaustive-effect-dependencies -- useEnvironments returns a new array each render; ids is its stable key.
        environments.map(async (environment) => {
          const result = await statusCommand({ environmentId: environment.environmentId });
          return [String(environment.environmentId), result] as const;
        }),
      );
      if (cancelled) return;
      setRows((previous) => {
        const next = { ...previous };
        for (const [environmentId, result] of entries) {
          next[environmentId] =
            result._tag === "Success"
              ? { ...next[environmentId], status: result.value, statusError: undefined }
              : {
                  ...next[environmentId],
                  statusError: failureMessage(squashAtomCommandFailure(result)),
                };
        }
        return next;
      });
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [ids, refreshToken]);

  const machineRows = environments.map((environment) => {
    const row = rows[String(environment.environmentId)] ?? {};
    return { environment, row };
  });
  const release = machineRows
    .map(({ row }) => row.status?.release)
    .find(
      (candidate): candidate is NonNullable<typeof candidate> =>
        candidate !== null && candidate !== undefined,
    );
  const eligible = machineRows
    .filter(
      ({ environment, row }) =>
        environment.connection.phase === "connected" &&
        row.status !== undefined &&
        row.status.machine.updateSupported &&
        release !== undefined &&
        row.status.machine.currentVersion !== release.version,
    )
    .map(({ environment }) => environment);

  const updateMachines = async (targets: ReadonlyArray<(typeof environments)[number]>) => {
    if (release === undefined || targets.length === 0) return;
    const labels = targets.map((target) => target.label).join(", ");
    const confirmed =
      (await requestConfirmDialog(
        targets.length === 1
          ? `Update ${labels} from ${rows[String(targets[0]!.environmentId)]?.status?.machine.currentVersion ?? "its current version"} to ${release.version}? T3 will restart there.`
          : `Update ${targets.length} machines (${labels}) to ${release.version}? Each T3 will restart and running threads will be interrupted.`,
      )) ?? true;
    if (!confirmed) return;
    const idsToRun = new Set(targets.map((target) => String(target.environmentId)));
    setBusyIds(idsToRun);
    for (const environment of targets) {
      const environmentId = environment.environmentId;
      const key = String(environmentId);
      const next = await updateCommand({
        environmentId,
        tag: release.tag,
        dryRun: false,
        confirm: true,
      } satisfies FleetUpdateTarget);
      setRows((previous) => ({
        ...previous,
        [key]:
          next._tag === "Success"
            ? { ...previous[key], result: next.value, updateError: undefined }
            : { ...previous[key], updateError: failureMessage(squashAtomCommandFailure(next)) },
      }));
    }
    setBusyIds(new Set());
    setRefreshToken((token) => token + 1);
  };

  return (
    <SettingsSection id="fleet" title="Fleet updates">
      <SettingsRow
        id="fleet-release"
        title="Release"
        description={
          release === undefined
            ? (machineRows.find(({ row }) => row.statusError !== undefined)?.row.statusError ??
              "Checking the latest t3onsteroids release…")
            : `${release.tag} · ${release.version}`
        }
        control={
          <Button
            size="sm"
            variant="outline"
            disabled={busyIds.size > 0}
            onClick={() => setRefreshToken((token) => token + 1)}
          >
            Refresh
          </Button>
        }
      />
      {machineRows.map(({ environment, row }) => {
        const machine = row.status?.machine;
        const key = String(environment.environmentId);
        const connected = environment.connection.phase === "connected";
        const current = machine?.currentVersion ?? "unknown";
        const upToDate =
          machine !== undefined && release !== undefined && current === release.version;
        const busy = busyIds.has(key);
        const description =
          machine === undefined
            ? (row.statusError ?? (connected ? "Checking…" : "Offline"))
            : `${machine.platform} · ${variantLabel(machine.variant)} · ${current}${
                release === undefined ? "" : upToDate ? " · up to date" : ` → ${release.version}`
              }${machine.updateSupported ? "" : ` · ${machine.reason ?? "cannot update itself"}`}`;
        return (
          <SettingsRow
            id={`fleet-${key}`}
            key={key}
            title={environment.label}
            description={
              <>
                {description}
                {row.result === undefined ? null : (
                  <>
                    <br />
                    {row.result.action === "accepted"
                      ? "Update accepted; the machine is restarting."
                      : row.result.action === "failed"
                        ? `Update failed: ${row.result.reason ?? "unknown error"}`
                        : row.result.action === "current"
                          ? "Already on the target release."
                          : `Plan: ${row.result.action}.`}
                  </>
                )}
                {row.updateError === undefined ? null : (
                  <>
                    <br />
                    {`Update failed: ${row.updateError}`}
                  </>
                )}
              </>
            }
            control={
              <Button
                size="sm"
                variant="outline"
                disabled={
                  busy ||
                  !connected ||
                  machine === undefined ||
                  !machine.updateSupported ||
                  upToDate ||
                  release === undefined
                }
                onClick={() => void updateMachines([environment])}
              >
                {busy ? "Updating…" : "Update"}
              </Button>
            }
          />
        );
      })}
      {eligible.length > 1 ? (
        <SettingsRow
          id="fleet-all"
          title="All machines"
          description={`Update ${eligible.length} machines to the same release, one at a time. A failure stops the run unless you continue.`}
          control={
            <Button
              size="sm"
              variant="outline"
              disabled={busyIds.size > 0}
              onClick={() => void updateMachines(eligible)}
            >
              Update all
            </Button>
          }
        />
      ) : null}
    </SettingsSection>
  );
}
