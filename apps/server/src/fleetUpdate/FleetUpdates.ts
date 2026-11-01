import {
  type ExecutionEnvironmentDescriptor,
  FleetUpdateError,
  type FleetMachineStatus,
  type FleetRelease,
  type FleetStatusResult,
  type FleetUpdateResult,
  type FleetUpdateVariant,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as ServerSelfUpdate from "../cloud/selfUpdate.ts";

/** The maintained fork's release page; every fleet release is published there. */
const FLEET_RELEASE_REPOSITORY = "Errantial/t3onsteroids";
const FLEET_RELEASE_CHECKSIUMS_FILE = "SHA256SUMS.txt";

const GITHUB_API = "https://api.github.com";
const RELEASE_LOOKUP_TIMEOUT = Duration.seconds(20);
const RELEASE_CACHE_TTL = Duration.minutes(1);

const GithubRelease = Schema.Struct({
  tag_name: Schema.String,
  published_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.optionalKey(Schema.String),
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
type GithubRelease = typeof GithubRelease.Type;

const decodeGithubRelease = Schema.decodeUnknownEffect(Schema.fromJsonString(GithubRelease));

/**
 * The full fork version is encoded in the platform asset names, not in the tag.
 * A release is usable only when every recognized asset agrees on one version.
 */
export function releaseVersionFromAssets(names: ReadonlyArray<string>): string | null {
  const versions = new Set<string>();
  for (const name of names) {
    const match =
      /^T3-Code-(.+)-x64\.exe$/.exec(name) ??
      /^t3-(.+)-linux-arm64\.tar\.gz$/.exec(name) ??
      /^t3-(.+)-linux-x64\.tar\.gz$/.exec(name);
    const version = match?.[1];
    if (version !== undefined && version.length > 0) versions.add(version);
  }
  return versions.size === 1 ? [...versions][0]! : null;
}

/** How this install receives a release, and whether the fleet updater can drive it. */
function fleetMachineVariant(descriptor: ExecutionEnvironmentDescriptor): {
  readonly variant: FleetUpdateVariant;
  readonly supported: boolean;
  readonly reason?: string;
} {
  const platform = descriptor.platform;
  const selfUpdate = descriptor.capabilities.serverSelfUpdate;
  if (platform.os === "windows" && selfUpdate === "desktop-managed") {
    return descriptor.capabilities.desktopAppUpdate === true
      ? { variant: "windows-desktop", supported: true }
      : {
          variant: "windows-desktop",
          supported: false,
          reason:
            "The desktop app on this machine cannot receive updates from its server. Update it from its own window.",
        };
  }
  if (platform.os === "linux" && selfUpdate === "boot-service") {
    return { variant: "linux-service", supported: true };
  }
  if (platform.os === "windows") {
    return {
      variant: "manual",
      supported: false,
      reason:
        "This Windows install has no desktop app updater. Run the installer or `t3 update` by hand.",
    };
  }
  return {
    variant: "manual",
    supported: false,
    reason:
      selfUpdate === undefined || selfUpdate === null
        ? "The T3 background service is not installed here. Run `t3 service install` or update by hand."
        : `A ${platform.os}-${platform.arch} install cannot be updated from the fleet release.`,
  };
}

export function fleetMachineStatus(descriptor: ExecutionEnvironmentDescriptor): FleetMachineStatus {
  const { variant, supported, reason } = fleetMachineVariant(descriptor);
  return {
    environmentId: descriptor.environmentId,
    label: descriptor.label,
    platform: `${descriptor.platform.os}-${descriptor.platform.arch}`,
    variant,
    currentVersion: descriptor.serverVersion,
    updateSupported: supported,
    ...(reason === undefined ? {} : { reason }),
  };
}

export interface FleetUpdateRequest {
  readonly tag?: string | undefined;
  readonly dryRun?: boolean | undefined;
  readonly confirm?: boolean | undefined;
}

class FleetUpdates extends Context.Service<
  FleetUpdates,
  {
    /** The latest (or named) fork release plus this machine's readiness. */
    readonly status: (input?: {
      readonly tag?: string | undefined;
    }) => Effect.Effect<FleetStatusResult>;
    /** Plans, or with `dryRun: false` and `confirm: true`, updates this machine. */
    readonly update: (
      input: FleetUpdateRequest,
    ) => Effect.Effect<FleetUpdateResult, FleetUpdateError>;
  }
>()("t3/fleetUpdate/FleetUpdates") {}

const fetchRelease = Effect.fn("FleetUpdates.fetchRelease")(function* (
  httpClient: HttpClient.HttpClient,
  tag: string | undefined,
) {
  const url =
    tag === undefined
      ? `${GITHUB_API}/repos/${FLEET_RELEASE_REPOSITORY}/releases/latest`
      : `${GITHUB_API}/repos/${FLEET_RELEASE_REPOSITORY}/releases/tags/${encodeURIComponent(tag)}`;
  const response = yield* httpClient
    .execute(
      HttpClientRequest.get(url).pipe(
        HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
        HttpClientRequest.setHeader("user-agent", "t3-fleet-update"),
      ),
    )
    .pipe(
      Effect.timeout(RELEASE_LOOKUP_TIMEOUT),
      Effect.mapError(
        (cause) =>
          new FleetUpdateError({
            reason: "release_unavailable",
            message:
              cause._tag === "TimeoutError"
                ? `Timed out asking GitHub for ${FLEET_RELEASE_REPOSITORY} releases.`
                : `Could not ask GitHub for ${FLEET_RELEASE_REPOSITORY} releases.`,
          }),
      ),
    );
  if (response.status === 404) {
    return yield* new FleetUpdateError({
      reason: "release_unavailable",
      message:
        tag === undefined
          ? `${FLEET_RELEASE_REPOSITORY} has no published release.`
          : `${FLEET_RELEASE_REPOSITORY} has no release tagged ${tag}.`,
    });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap((ok) => ok.text),
    Effect.mapError(
      () =>
        new FleetUpdateError({
          reason: "release_unavailable",
          message: `GitHub answered HTTP ${response.status} for ${FLEET_RELEASE_REPOSITORY}.`,
        }),
    ),
  );
  const release = yield* decodeGithubRelease(body).pipe(
    Effect.mapError(
      () =>
        new FleetUpdateError({
          reason: "release_unavailable",
          message: `GitHub returned an unexpected release shape for ${FLEET_RELEASE_REPOSITORY}.`,
        }),
    ),
  );
  const version = releaseVersionFromAssets(release.assets.map((asset) => asset.name));
  if (version === null) {
    return yield* new FleetUpdateError({
      reason: "release_unavailable",
      message: `Release ${release.tag_name} has no platform assets with one full version.`,
    });
  }
  return {
    tag: release.tag_name,
    version,
    ...(release.published_at === undefined || release.published_at === null
      ? {}
      : { publishedAt: release.published_at }),
    ...(release.html_url === undefined ? {} : { url: release.html_url }),
  };
});

export const makeService = Effect.fn("FleetUpdates.makeService")(function* () {
  const environment = yield* ServerEnvironment.ServerEnvironment;
  const selfUpdate = yield* ServerSelfUpdate.ServerSelfUpdate;
  const httpClient = yield* HttpClient.HttpClient;
  const cache = yield* Ref.make<
    Option.Option<{ readonly at: number; readonly release: FleetRelease }>
  >(Option.none());

  const releaseFor = Effect.fn("FleetUpdates.releaseFor")(function* (tag: string | undefined) {
    if (tag !== undefined) return yield* fetchRelease(httpClient, tag);
    const cached = yield* Ref.get(cache);
    const now = yield* Clock.currentTimeMillis;
    if (Option.isSome(cached)) {
      const age = now - cached.value.at;
      if (age >= 0 && age < Duration.toMillis(RELEASE_CACHE_TTL)) {
        return cached.value.release;
      }
    }
    const release = yield* fetchRelease(httpClient, undefined);
    yield* Ref.set(cache, Option.some({ at: now, release }));
    return release;
  });

  const status = Effect.fn("FleetUpdates.status")(function* (input?: {
    readonly tag?: string | undefined;
  }) {
    const descriptor = yield* environment.getDescriptor;
    const machine = fleetMachineStatus(descriptor);
    const release = yield* releaseFor(input?.tag).pipe(Effect.result);
    if (release._tag === "Failure") {
      return {
        release: null,
        machine,
        releaseError: release.failure.message,
      };
    }
    return { release: release.success, machine };
  });

  const update = Effect.fn("FleetUpdates.update")(function* (input: FleetUpdateRequest) {
    const dryRun = input.dryRun ?? true;
    const current = yield* status({ tag: input.tag });
    if (current.release === null) {
      return yield* new FleetUpdateError({
        reason: "release_unavailable",
        message: current.releaseError ?? "The fleet release could not be resolved.",
      });
    }
    const release = current.release;
    const machine = current.machine;
    const result = (action: FleetUpdateResult["action"], reason?: string): FleetUpdateResult => ({
      release,
      dryRun,
      machine,
      action,
      fromVersion: machine.currentVersion,
      toVersion: release.version,
      ...(reason === undefined ? {} : { reason }),
    });

    if (!machine.updateSupported) {
      return result("unsupported", machine.reason ?? "This machine cannot update itself.");
    }
    if (machine.currentVersion === release.version) {
      return result("current");
    }
    if (dryRun) {
      return result("planned");
    }
    if (input.confirm !== true) {
      return yield* new FleetUpdateError({
        reason: "confirmation_required",
        message: "A fleet update changes machines. Pass confirm:true after the user confirms.",
      });
    }

    const updated = yield* selfUpdate
      .update({
        targetVersion: release.version,
        release: { tag: release.tag, checksumsFile: FLEET_RELEASE_CHECKSIUMS_FILE },
      })
      .pipe(Effect.result);
    if (updated._tag === "Failure") {
      return result("failed", updated.failure.message);
    }
    if (updated.success.targetVersion !== release.version) {
      return result(
        "failed",
        `The machine offered ${updated.success.targetVersion}, not ${release.version}.`,
      );
    }
    if (
      updated.success.method === "desktop-app" &&
      updated.success.desktopUpdateToken !== undefined
    ) {
      // Let the response leave before the app quits to install. The token is one-shot.
      const token = updated.success.desktopUpdateToken;
      yield* Effect.forkDetach(
        Effect.sleep(Duration.seconds(2)).pipe(
          Effect.andThen(selfUpdate.commitDesktopUpdate(token)),
          Effect.ignore,
        ),
      );
    }
    return result("accepted");
  });

  return FleetUpdates.of({ status, update });
});
