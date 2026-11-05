import type {
  ModelSelection,
  ProviderDriverKind,
  ProviderInteractionMode,
  RuntimeMode,
  SwarmId,
  SwarmMemberStatus,
  SwarmWarning,
} from "@t3tools/contracts";

import { interactionModeRank, runtimeModeRank } from "../mcp/delegatedTaskModes.ts";

// Pure Swarm v2 planning: what a member may run as, who may write where, and who is admitted
// next under the caps. No I/O, so the scheduler and its tests share it exactly.

/** One instance an `anyOf` member may run on. */
export interface SwarmPlacementOption {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly driver: ProviderDriverKind;
}

/** What `swarm_members.spec_json` holds for a member. Task text is stored, never logged. */
export interface SwarmMemberSpec {
  readonly key: string;
  readonly title: string;
  /** The prompt the child receives, with its role applied. */
  readonly task: string;
  /** Architect-written fields `swarm_shared` carries (SW-A3c); untrusted. */
  readonly role?: string;
  readonly doneCriteria?: string;
  readonly verifyArgv?: ReadonlyArray<string>;
  /** SW-A6: with `verifyArgv`; defaults 600,000 ms and 2 retries. */
  readonly verifyTimeoutMs?: number;
  readonly verifyMaxRetries?: number;
  /** swarm_retry: the previous attempt's result, wrapped as data, put before the task. */
  readonly previousAttempt?: string;
  /** swarm_followup: the latest follow-up's text and request key, for re-dispatch and replays. */
  readonly followupText?: string;
  readonly followupRequestKey?: string;
  /** swarm_add_members: the request key of the call that added this member, for replays. */
  readonly addRequestKey?: string;
  readonly isolation: "shared" | "worktree";
  readonly ownsPaths?: ReadonlyArray<string>;
  readonly allowNestedSwarm?: boolean;
  /** Resolved once at create, per distinct target. */
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  readonly driver: ProviderDriverKind;
  /**
   * `target.anyOf` (SW-A3b): each listed instance resolved at create, in `anyOf` order. The
   * member is placed on one at admission and stays there; `modelSelection` is the first.
   */
  readonly anyOf?: ReadonlyArray<SwarmPlacementOption>;
  /** The modes resolved at create are ceilings; an admission never runs above them. */
  readonly runtimeCeiling: RuntimeMode;
  readonly interactionCeiling: ProviderInteractionMode;
}

export const narrowerRuntimeMode = (left: RuntimeMode, right: RuntimeMode): RuntimeMode =>
  runtimeModeRank(left) <= runtimeModeRank(right) ? left : right;

export const narrowerInteractionMode = (
  left: ProviderInteractionMode,
  right: ProviderInteractionMode,
): ProviderInteractionMode =>
  interactionModeRank(left) <= interactionModeRank(right) ? left : right;

/** A writer edits files: its interaction mode is `default`, not `plan`. */
export const isWriter = (interactionMode: ProviderInteractionMode) =>
  interactionModeRank(interactionMode) > 0;

const FINAL_STATUSES: ReadonlySet<SwarmMemberStatus> = new Set([
  "verified",
  "claimed_done",
  "failed",
  "cancelled",
  "detached",
]);

export const isFinalMemberStatus = (status: SwarmMemberStatus) => FINAL_STATUSES.has(status);

/** Statuses that hold a concurrency slot. `limit_wait` frees its slot (SW-A8). */
const SLOT_STATUSES: ReadonlySet<SwarmMemberStatus> = new Set([
  "launching",
  "running",
  "verifying",
]);

const holdsSlot = (status: SwarmMemberStatus) => SLOT_STATUSES.has(status);

/** Drivers that serve one turn at a time per account, so their default per-instance cap is 1. */
const SERIAL_DRIVERS: ReadonlySet<string> = new Set(["chatgptBrowser"]);

export interface SwarmCaps {
  readonly global: number;
  readonly perInstance: number;
  readonly instanceOverrides: Readonly<Record<string, number>>;
}

export const instanceCap = (
  caps: SwarmCaps,
  instanceId: string,
  driver: ProviderDriverKind | undefined,
): number =>
  caps.instanceOverrides[instanceId] ??
  (driver !== undefined && SERIAL_DRIVERS.has(driver) ? 1 : caps.perInstance);

export interface WriterCandidate {
  readonly key: string;
  readonly swarmId?: SwarmId;
  readonly isolation: "shared" | "worktree";
  readonly writer: boolean;
  readonly ownsPaths?: ReadonlyArray<string> | undefined;
}

const sharedWriters = (members: ReadonlyArray<WriterCandidate>) =>
  members.filter((member) => member.writer && member.isolation === "shared");

/**
 * Two or more non-final shared-checkout writers would edit the architect's checkout at once.
 * That is refused unless `allowSharedWriters` is set and every shared writer has `ownsPaths`.
 * Returns the refusal message, or undefined when the members may run.
 */
export const sharedWriterRefusal = (input: {
  readonly members: ReadonlyArray<WriterCandidate>;
  readonly allowSharedWriters: boolean;
}): string | undefined => {
  const writers = sharedWriters(input.members);
  if (writers.length < 2) return undefined;
  if (input.allowSharedWriters && writers.every((writer) => (writer.ownsPaths?.length ?? 0) > 0)) {
    return undefined;
  }
  const keys = writers.map((writer) => `'${writer.key}'`).join(", ");
  return `Members ${keys} would edit the same checkout at once. Give them isolation: "worktree", set interactionMode: "plan" for read-only work, or set allowSharedWriters with ownsPaths on every shared writer.`;
};

/** A path as compared: a glob by its literal prefix, without `./` or trailing slashes. */
const comparablePath = (path: string) => {
  const glob = path.search(/[*?[]/);
  return (glob === -1 ? path : path.slice(0, glob)).replace(/^\.\//, "").replace(/\/+$/, "");
};

/** One path is equal to, or a directory prefix of, the other (globs by their literal prefix). */
export const pathsOverlap = (left: string, right: string): boolean => {
  const a = comparablePath(left);
  const b = comparablePath(right);
  const contains = (outer: string, inner: string) =>
    outer === "" || inner === outer || inner.startsWith(`${outer}/`);
  return contains(a, b) || contains(b, a);
};

/** `owns_paths_overlap` warnings between non-final writers; they never fail the call. */
export const ownsPathsOverlapWarnings = (
  members: ReadonlyArray<WriterCandidate>,
): ReadonlyArray<SwarmWarning> => {
  const writers = members.filter((member) => member.writer && (member.ownsPaths?.length ?? 0) > 0);
  const warnings: Array<SwarmWarning> = [];
  for (let i = 0; i < writers.length; i += 1) {
    for (let j = i + 1; j < writers.length; j += 1) {
      const left = writers[i]!;
      const right = writers[j]!;
      const path = left.ownsPaths!.find((candidate) =>
        right.ownsPaths!.some((other) => pathsOverlap(candidate, other)),
      );
      if (path === undefined) continue;
      warnings.push({
        kind: "owns_paths_overlap",
        keys: [left.key, right.key],
        path,
        message: `Members '${left.key}' and '${right.key}' both own '${path}'.`,
      });
    }
  }
  return warnings;
};

export interface PlannedSwarm {
  readonly swarmId: SwarmId;
  readonly createdAt: string;
  readonly maxConcurrent: number | null;
  /** False once the anchor cohort is no longer open, or the swarm is not active. */
  readonly admits: boolean;
}

export interface PlannedMember {
  readonly swarmId: SwarmId;
  readonly memberKey: string;
  readonly ordinal: number;
  readonly status: SwarmMemberStatus;
  readonly providerInstanceId: string | null;
  readonly driver: ProviderDriverKind | undefined;
  /** An unplaced `anyOf` member: the instances it may be placed on, in `anyOf` order. */
  readonly anyOf?: ReadonlyArray<string>;
  /** Placement avoids this instance whenever another candidate qualifies (a failed retry). */
  readonly avoidInstanceId?: string | undefined;
  /** An automatic retry waits until this time (SW-A8). */
  readonly retryAfter?: string | null | undefined;
}

export interface PlannedAdmission extends PlannedMember {
  /** The instance the member runs on: its own, or the one placement chose. */
  readonly placedInstanceId: string | null;
}

export interface AdmissionPlan {
  readonly admit: ReadonlyArray<PlannedAdmission>;
  /** The queue reason for every queued member that is not admitted. */
  readonly queueReasons: ReadonlyMap<string, string>;
}

export const memberRef = (member: Pick<PlannedMember, "swarmId" | "memberKey">) =>
  `${member.swarmId}\u0000${member.memberKey}`;

/**
 * Who is admitted next: swarm creation time, then member ordinal. A member that cannot start
 * because its instance is full or paused does not block later ones that can.
 */
export const planAdmissions = (input: {
  readonly swarms: ReadonlyArray<PlannedSwarm>;
  readonly members: ReadonlyArray<PlannedMember>;
  readonly caps: SwarmCaps;
  /** Paused instances and the ISO time their pause ends. */
  readonly pauses: ReadonlyMap<string, string>;
  readonly now: string;
  /** Instances placement may use: not `error`/`disabled` and not signed out. */
  readonly healthy?: ReadonlySet<string>;
  /** Failures per instance in the last 10 minutes; placement's tie-break. */
  readonly recentFailures?: ReadonlyMap<string, number>;
}): AdmissionPlan => {
  const active = input.members.filter((member) => holdsSlot(member.status));
  let globalActive = active.length;
  const perInstance = new Map<string, number>();
  const perSwarm = new Map<string, number>();
  for (const member of active)
    perSwarm.set(member.swarmId, (perSwarm.get(member.swarmId) ?? 0) + 1);
  // limit_wait frees its global and swarm slots but keeps its instance slot (SW-A8).
  for (const member of input.members) {
    if (member.providerInstanceId === null) continue;
    if (!holdsSlot(member.status) && member.status !== "limit_wait") continue;
    perInstance.set(
      member.providerInstanceId,
      (perInstance.get(member.providerInstanceId) ?? 0) + 1,
    );
  }
  const admit: Array<PlannedAdmission> = [];
  const isPaused = (instanceId: string) => {
    const until = input.pauses.get(instanceId);
    return until !== undefined && until > input.now;
  };
  const hasRoom = (instanceId: string, driver: ProviderDriverKind | undefined) =>
    (perInstance.get(instanceId) ?? 0) < instanceCap(input.caps, instanceId, driver);
  /** The least busy qualifying instance, then fewer recent failures, then `anyOf` order. */
  const place = (member: PlannedMember, anyOf: ReadonlyArray<string>) => {
    const candidates = anyOf.filter(
      (instanceId) =>
        !isPaused(instanceId) &&
        (input.healthy?.has(instanceId) ?? true) &&
        hasRoom(instanceId, member.driver),
    );
    const preferred =
      member.avoidInstanceId !== undefined &&
      candidates.some((instanceId) => instanceId !== member.avoidInstanceId)
        ? candidates.filter((instanceId) => instanceId !== member.avoidInstanceId)
        : candidates;
    return preferred.toSorted(
      (left, right) =>
        (perInstance.get(left) ?? 0) - (perInstance.get(right) ?? 0) ||
        (input.recentFailures?.get(left) ?? 0) - (input.recentFailures?.get(right) ?? 0) ||
        anyOf.indexOf(left) - anyOf.indexOf(right),
    )[0];
  };
  const queueReasons = new Map<string, string>();
  const swarms = input.swarms.toSorted(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.swarmId.localeCompare(right.swarmId),
  );
  for (const swarm of swarms) {
    if (!swarm.admits) continue;
    const queued = input.members
      .filter((member) => member.swarmId === swarm.swarmId && member.status === "queued")
      .toSorted((left, right) => left.ordinal - right.ordinal);
    const swarmCap = Math.min(input.caps.global, swarm.maxConcurrent ?? input.caps.global);
    for (const member of queued) {
      if (member.retryAfter != null && member.retryAfter > input.now) {
        queueReasons.set(memberRef(member), `retry_after:${member.retryAfter}`);
        continue;
      }
      if (globalActive >= input.caps.global) {
        queueReasons.set(memberRef(member), "global_cap");
        continue;
      }
      if ((perSwarm.get(swarm.swarmId) ?? 0) >= swarmCap) {
        queueReasons.set(memberRef(member), "swarm_cap");
        continue;
      }
      let instanceId = member.providerInstanceId;
      if (instanceId === null && member.anyOf !== undefined) {
        const placed = place(member, member.anyOf);
        if (placed === undefined) {
          queueReasons.set(memberRef(member), "any_of_unavailable");
          continue;
        }
        instanceId = placed;
      } else if (instanceId !== null) {
        if (isPaused(instanceId)) {
          queueReasons.set(
            memberRef(member),
            `instance_paused:${instanceId}:${input.pauses.get(instanceId)}`,
          );
          continue;
        }
        if (!hasRoom(instanceId, member.driver)) {
          queueReasons.set(memberRef(member), `instance_cap:${instanceId}`);
          continue;
        }
      }
      if (instanceId !== null) perInstance.set(instanceId, (perInstance.get(instanceId) ?? 0) + 1);
      globalActive += 1;
      perSwarm.set(swarm.swarmId, (perSwarm.get(swarm.swarmId) ?? 0) + 1);
      admit.push({ ...member, placedInstanceId: instanceId });
    }
  }
  return { admit, queueReasons };
};

/** One `serial_instance` warning per instance whose effective cap is 1. */
export const serialInstanceWarnings = (input: {
  readonly members: ReadonlyArray<{
    readonly key: string;
    readonly instanceId: string;
    readonly driver: ProviderDriverKind;
  }>;
  readonly caps: SwarmCaps;
}): ReadonlyArray<SwarmWarning> => {
  const byInstance = new Map<string, Array<string>>();
  for (const member of input.members) {
    if (instanceCap(input.caps, member.instanceId, member.driver) !== 1) continue;
    byInstance.set(member.instanceId, [...(byInstance.get(member.instanceId) ?? []), member.key]);
  }
  return [...byInstance].map(([instanceId, keys]) => ({
    kind: "serial_instance" as const,
    keys,
    instanceId: instanceId as SwarmWarning["instanceId"] & string,
    message: `Members on instance ${instanceId} run one at a time.`,
  }));
};

/** Statuses a member is released with: final, and not detached from the swarm. */
const RELEASABLE: ReadonlySet<SwarmMemberStatus> = new Set([
  "claimed_done",
  "verified",
  "failed",
  "cancelled",
]);

/**
 * Final, unreleased members whose wake policy lets them wake the architect now (SW-A5):
 * `group` each as it ends; `failure` failures at once and the rest at the end; `batch` together
 * at `minCount`, after `maxWaitMs` for the oldest, or when no member is left non-final.
 */
export const readyForRelease = <
  Member extends {
    readonly status: SwarmMemberStatus;
    readonly released: boolean;
    readonly taskId: string | null;
    readonly envelopeJson: string | null;
    readonly endedAt: string | null;
    readonly updatedAt: string;
  },
>(input: {
  readonly wakePolicy: "group" | "failure" | "batch";
  readonly wakeBatch: {
    readonly minCount?: number | undefined;
    readonly maxWaitMs?: number | undefined;
  };
  readonly members: ReadonlyArray<Member>;
  readonly nowMillis: number;
}): ReadonlyArray<Member> => {
  const waiting = input.members.filter(
    (member) =>
      RELEASABLE.has(member.status) &&
      !member.released &&
      member.taskId !== null &&
      member.envelopeJson !== null,
  );
  if (waiting.length === 0) return [];
  const allFinal = input.members.every((member) => isFinalMemberStatus(member.status));
  switch (input.wakePolicy) {
    case "group":
      return waiting;
    case "failure":
      return allFinal ? waiting : waiting.filter((member) => member.status === "failed");
    case "batch": {
      const oldest = Math.min(
        ...waiting.map((member) => Date.parse(member.endedAt ?? member.updatedAt)),
      );
      return allFinal ||
        waiting.length >= (input.wakeBatch.minCount ?? 4) ||
        input.nowMillis - oldest >= (input.wakeBatch.maxWaitMs ?? 120_000)
        ? waiting
        : [];
    }
  }
};
