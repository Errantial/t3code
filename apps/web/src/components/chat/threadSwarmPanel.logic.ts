import type { SwarmMemberView, SwarmThreadView } from "@t3tools/contracts";

// Swarm v2 panel (SW-A10): pure helpers for the roster of up to 48 members. Labels are the
// server's facts in words; nothing here invents a state the server did not report.

export type SwarmStatusFilter = "all" | "failed" | "attention" | "running" | "queued" | "done";

export interface SwarmSummaryCounts {
  readonly running: number;
  readonly queued: number;
  readonly limitWait: number;
  readonly verifying: number;
  readonly verified: number;
  readonly unchecked: number;
  readonly failed: number;
  readonly cancelled: number;
  readonly detached: number;
}

export function swarmSummaryCounts(members: ReadonlyArray<SwarmMemberView>): SwarmSummaryCounts {
  const counts = {
    running: 0,
    queued: 0,
    limitWait: 0,
    verifying: 0,
    verified: 0,
    unchecked: 0,
    failed: 0,
    cancelled: 0,
    detached: 0,
  };
  for (const member of members) {
    switch (member.status) {
      case "launching":
      case "running":
        counts.running += 1;
        break;
      case "queued":
        counts.queued += 1;
        break;
      case "limit_wait":
        counts.limitWait += 1;
        break;
      case "verifying":
        counts.verifying += 1;
        break;
      case "verified":
        counts.verified += 1;
        break;
      case "claimed_done":
        counts.unchecked += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
      case "detached":
        counts.detached += 1;
        break;
    }
  }
  return counts;
}

/** The summary bar's parts, zero counts left out. */
export function swarmSummaryParts(counts: SwarmSummaryCounts): ReadonlyArray<string> {
  const parts: Array<[number, string]> = [
    [counts.running, "running"],
    [counts.queued, "queued"],
    [counts.limitWait, "waiting on a limit"],
    [counts.verifying, "verifying"],
    [counts.verified, "verified"],
    [counts.unchecked, "done, unchecked"],
    [counts.failed, "failed"],
    [counts.cancelled, "cancelled"],
    [counts.detached, "detached"],
  ];
  return parts.filter(([count]) => count > 0).map(([count, label]) => `${count} ${label}`);
}

/** Default order: failed, waiting for approval, running, verifying, queued, then done. */
function sortRank(member: SwarmMemberView): number {
  if (member.status === "failed") return 0;
  if (member.waitingForApproval) return 1;
  switch (member.status) {
    case "launching":
    case "running":
      return 2;
    case "limit_wait":
      return 3;
    case "verifying":
      return 4;
    case "queued":
      return 5;
    default:
      return 6;
  }
}

export function sortSwarmMembers(
  members: ReadonlyArray<SwarmMemberView>,
): ReadonlyArray<SwarmMemberView> {
  return members
    .map((member, index) => ({ member, index }))
    .toSorted(
      (left, right) => sortRank(left.member) - sortRank(right.member) || left.index - right.index,
    )
    .map(({ member }) => member);
}

const DONE_STATUSES: ReadonlySet<SwarmMemberView["status"]> = new Set([
  "claimed_done",
  "verified",
  "cancelled",
  "detached",
]);

export function filterSwarmMembers(
  members: ReadonlyArray<SwarmMemberView>,
  filter: { readonly status: SwarmStatusFilter; readonly instanceId: string | null },
): ReadonlyArray<SwarmMemberView> {
  return members.filter((member) => {
    if (filter.instanceId !== null && member.providerInstanceId !== filter.instanceId) return false;
    switch (filter.status) {
      case "all":
        return true;
      case "failed":
        return member.status === "failed";
      case "attention":
        return member.waitingForApproval || member.stopGivenUp;
      case "running":
        return (
          member.status === "launching" ||
          member.status === "running" ||
          member.status === "verifying" ||
          member.status === "limit_wait"
        );
      case "queued":
        return member.status === "queued";
      case "done":
        return DONE_STATUSES.has(member.status);
    }
  });
}

/** Members by instance, instances in first-seen order; unplaced members under "unplaced". */
export function groupSwarmMembersByInstance(
  members: ReadonlyArray<SwarmMemberView>,
): ReadonlyArray<{
  readonly instanceId: string;
  readonly members: ReadonlyArray<SwarmMemberView>;
}> {
  const groups = new Map<string, Array<SwarmMemberView>>();
  for (const member of members) {
    const key = member.providerInstanceId ?? "unplaced";
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  return [...groups].map(([instanceId, grouped]) => ({ instanceId, members: grouped }));
}

const FAILURE_LABELS: Readonly<Record<string, string>> = {
  launch: "could not start",
  usage_limit: "usage limit",
  provider_error: "provider error",
  transport_error: "connection error",
  permission_error: "permission error",
  validation_error: "rejected by the provider",
  unknown: "failed",
  verify: "failed its check",
  budget: "stopped by its budget",
  cancelled_by_architect_stop: "stopped by your Stop",
};

export function swarmMemberStatusLabel(member: SwarmMemberView): string {
  if (member.waitingForApproval && member.status !== "failed") return "waiting for your approval";
  switch (member.status) {
    case "queued":
      return "queued";
    case "launching":
      return "starting";
    case "running":
      return "running";
    case "limit_wait":
      return "waiting for its usage limit to reset";
    case "verifying":
      return "verifying";
    case "verified":
      return "verified";
    case "claimed_done":
      return member.verifySkipped !== undefined
        ? "done, check skipped"
        : member.hasVerify
          ? "done, not yet checked"
          : "done, unchecked";
    case "failed":
      return `failed: ${FAILURE_LABELS[member.failureClass ?? "unknown"] ?? "failed"}`;
    case "cancelled":
      return member.failureClass === "cancelled_by_architect_stop"
        ? "stopped by your Stop"
        : member.failureClass === "budget"
          ? "stopped by its budget"
          : "cancelled";
    case "detached":
      return "detached: runs on its own";
  }
}

function clock(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime())
    ? iso
    : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

/** Why a queued member waits, from the server's queue reason. */
export function swarmQueueReasonLabel(queueReason: string | null): string | null {
  if (queueReason === null) return null;
  const [kind, ...rest] = queueReason.split(":");
  switch (kind) {
    case "global_cap":
      return "waiting for a free slot";
    case "swarm_cap":
      return "waiting for the swarm's limit";
    case "instance_cap":
      return `waiting for ${rest[0] ?? "its instance"} to free a slot`;
    case "instance_paused":
      return `paused on ${rest[0] ?? "its instance"} until ${clock(rest.slice(1).join(":"))}`;
    case "instance_unhealthy":
      return `${rest[0] ?? "its instance"} is signed out or failing`;
    case "any_of_unavailable":
      return "no listed instance is available";
    case "retry_after":
      return `retrying at ${clock(rest.join(":"))}`;
    case "budget":
      return "the swarm's turn budget is used";
    default:
      return queueReason;
  }
}

export function swarmInstanceBadge(instance: SwarmThreadView["instances"][number]): string {
  const parts = [`${instance.active}/${instance.cap}`];
  if (instance.pausedUntil !== undefined) {
    parts.push(
      `paused until ${clock(instance.pausedUntil)} (${instance.pauseClass === "instance_down" ? "instance down" : "usage limit"})`,
    );
  }
  if (instance.cap === 1) parts.push("runs one at a time");
  return parts.join(" · ");
}

export function swarmElapsedLabel(member: SwarmMemberView, nowMs: number): string | null {
  if (member.startedAt === null) return null;
  const start = Date.parse(member.startedAt);
  const end = member.endedAt === null ? nowMs : Date.parse(member.endedAt);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const minutes = Math.max(0, Math.round((end - start) / 60_000));
  return minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function swarmVerifyLabel(member: SwarmMemberView): string | null {
  if (member.verifySkipped !== undefined) {
    return member.verifySkipped === "plan_mode"
      ? "check skipped: plan mode"
      : member.verifySkipped === "runtime_mode"
        ? "check skipped: not full access"
        : "check skipped";
  }
  if (member.verify === undefined) return null;
  if (member.verify.notStarted === true) return "check could not start";
  if (member.verify.passed) return `check passed (${member.verify.attempts})`;
  return member.verify.timedOut ? "check timed out" : `check failed (${member.verify.attempts})`;
}

/** Small flags beside a member: follow-ups, an automatic retry, a stop that was given up. */
export function swarmMemberFlags(member: SwarmMemberView): ReadonlyArray<string> {
  return [
    ...(member.followups > 0
      ? [`${member.followups} follow-up${member.followups === 1 ? "" : "s"}`]
      : []),
    ...(member.autoRetried ? ["retried automatically"] : []),
    ...(member.attempt > 1 && !member.autoRetried ? [`attempt ${member.attempt}`] : []),
    ...(member.stopGivenUp ? ["could not be stopped"] : []),
    ...(member.interactionMode === "plan" ? ["plan mode"] : []),
  ];
}

export function swarmBudgetLabel(view: SwarmThreadView): string | null {
  if (view.maxTotalTurns === null) return null;
  return `${view.turnsUsed}/${view.maxTotalTurns} turns${view.budgetExhausted ? " · budget used" : ""}`;
}

/** Stop all's confirmation, with what it stops. */
export function swarmStopAllMessage(counts: SwarmSummaryCounts): string {
  const running = counts.running + counts.verifying + counts.limitWait;
  return `Stop this swarm? ${running} running member${running === 1 ? "" : "s"} will be stopped and ${counts.queued} queued member${counts.queued === 1 ? "" : "s"} will not start.`;
}

/** Whether the panel keeps polling: while a swarm is active. */
export function swarmPanelShouldPoll(views: ReadonlyArray<SwarmThreadView>): boolean {
  return views.some((view) => view.status === "active");
}
