import * as Schema from "effect/Schema";

import { EnvironmentId, TrimmedNonEmptyString } from "./baseSchemas.ts";

/** How a machine installs a T3 Code release. */
export const FleetUpdateVariant = Schema.Literals([
  /** A desktop app managed by its own Electron updater, on Windows. */
  "windows-desktop",
  /** A background service that installs pinned runtimes from release archives, on Linux. */
  "linux-service",
  /** The machine cannot update itself from a release. */
  "manual",
]);
export type FleetUpdateVariant = typeof FleetUpdateVariant.Type;

/** The t3onsteroids release the fleet plan targets. */
export const FleetRelease = Schema.Struct({
  /** GitHub release tag, for example `v1.1.7`. */
  tag: TrimmedNonEmptyString,
  /** Full fork version, for example `0.1.5-v1.1.7.20261101.<sha12>.connect1`. */
  version: TrimmedNonEmptyString,
  publishedAt: Schema.optionalKey(Schema.String),
  /** Release page, for humans. */
  url: Schema.optionalKey(Schema.String),
});
export type FleetRelease = typeof FleetRelease.Type;

export const FleetMachineStatus = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  /** `windows-x64`, `linux-arm64`, ... */
  platform: Schema.String,
  variant: FleetUpdateVariant,
  currentVersion: Schema.String,
  /** Whether `fleet_update` can act on this machine. */
  updateSupported: Schema.Boolean,
  /** Why it cannot, when `updateSupported` is false. */
  reason: Schema.optionalKey(Schema.String),
});
export type FleetMachineStatus = typeof FleetMachineStatus.Type;

export const FleetStatusResult = Schema.Struct({
  release: Schema.NullOr(FleetRelease),
  machine: FleetMachineStatus,
  /** Set when the release lookup failed; the machine status is still valid. */
  releaseError: Schema.optionalKey(Schema.String),
});
export type FleetStatusResult = typeof FleetStatusResult.Type;

/** What the plan says would happen, and what actually happened. */
export const FleetUpdateAction = Schema.Literals([
  /** The machine already runs the release. */
  "current",
  /** A dry run: this machine would be updated. */
  "planned",
  /** The machine cannot update itself; see `reason`. */
  "unsupported",
  /** The update was accepted and the server is handing off or restarting. */
  "accepted",
  /** The update attempt failed; see `reason`. */
  "failed",
]);
export type FleetUpdateAction = typeof FleetUpdateAction.Type;

export const FleetUpdateInput = Schema.Struct({
  /** Release tag to target; defaults to the latest published release. */
  tag: Schema.optional(TrimmedNonEmptyString),
  /** Plans only. Defaults to true, so a call that forgets it changes nothing. */
  dryRun: Schema.optional(Schema.Boolean),
  /** Must be true for a real update. */
  confirm: Schema.optional(Schema.Boolean),
});
export type FleetUpdateInput = typeof FleetUpdateInput.Type;

export const FleetUpdateResult = Schema.Struct({
  release: FleetRelease,
  dryRun: Schema.Boolean,
  machine: FleetMachineStatus,
  action: FleetUpdateAction,
  fromVersion: Schema.String,
  toVersion: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export type FleetUpdateResult = typeof FleetUpdateResult.Type;

export const FleetUpdateErrorReason = Schema.Literals([
  "confirmation_required",
  "release_unavailable",
  "unsupported",
  "failed",
]);
export type FleetUpdateErrorReason = typeof FleetUpdateErrorReason.Type;

/** What one hub sees across itself and the environments it links to. */
export const FleetUpdateStatusResult = Schema.Struct({
  release: Schema.NullOr(FleetRelease),
  machines: Schema.Array(FleetMachineStatus),
  errors: Schema.Array(
    Schema.Struct({
      environmentId: Schema.String,
      message: Schema.String,
    }),
  ),
});
export type FleetUpdateStatusResult = typeof FleetUpdateStatusResult.Type;

export const FleetUpdateMachineResult = Schema.Struct({
  environmentId: EnvironmentId,
  label: Schema.String,
  action: FleetUpdateAction,
  fromVersion: Schema.String,
  toVersion: Schema.String,
  reason: Schema.optionalKey(Schema.String),
});
export type FleetUpdateMachineResult = typeof FleetUpdateMachineResult.Type;

export const FleetUpdateReport = Schema.Struct({
  release: FleetRelease,
  dryRun: Schema.Boolean,
  results: Schema.Array(FleetUpdateMachineResult),
});
export type FleetUpdateReport = typeof FleetUpdateReport.Type;

export class FleetUpdateError extends Schema.TaggedError<FleetUpdateError>()("FleetUpdateError", {
  reason: FleetUpdateErrorReason,
  message: Schema.String,
}) {}
