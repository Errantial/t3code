import type { SwarmMemberView, SwarmThreadView } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  filterSwarmMembers,
  groupSwarmMembersByInstance,
  sortSwarmMembers,
  swarmBudgetLabel,
  swarmInstanceBadge,
  swarmMemberFlags,
  swarmMemberStatusLabel,
  swarmPanelRetryDelay,
  swarmPanelShouldPoll,
  swarmQueueReasonLabel,
  swarmStopAllMessage,
  swarmSummaryCounts,
  swarmSummaryParts,
  swarmVerifyLabel,
} from "./threadSwarmPanel.logic";

const member = (key: string, overrides: Partial<SwarmMemberView> = {}): SwarmMemberView =>
  ({
    key,
    title: key,
    status: "running",
    queueReason: null,
    providerInstanceId: "codex",
    model: "gpt",
    runtimeMode: "full-access",
    interactionMode: "default",
    childThreadId: null,
    attempt: 1,
    followups: 0,
    autoRetried: false,
    failureClass: null,
    waitingForApproval: false,
    stopGivenUp: false,
    hasVerify: false,
    startedAt: null,
    endedAt: null,
    turnsUsed: 1,
    ...overrides,
  }) as SwarmMemberView;

describe("swarm panel logic", () => {
  it("counts every status for the summary bar and leaves zeros out", () => {
    const counts = swarmSummaryCounts([
      member("a", { status: "running" }),
      member("b", { status: "launching" }),
      member("c", { status: "queued" }),
      member("d", { status: "claimed_done" }),
      member("e", { status: "failed" }),
      member("f", { status: "limit_wait" }),
    ]);
    expect(counts.running).toBe(2);
    expect(swarmSummaryParts(counts)).toEqual([
      "2 running",
      "1 queued",
      "1 waiting on a limit",
      "1 done, unchecked",
      "1 failed",
    ]);
  });

  it("sorts failed, then waiting for approval, running, verifying, queued, and done", () => {
    const sorted = sortSwarmMembers([
      member("done", { status: "verified" }),
      member("queued", { status: "queued" }),
      member("running", { status: "running" }),
      member("verifying", { status: "verifying" }),
      member("approval", { status: "running", waitingForApproval: true }),
      member("failed", { status: "failed" }),
    ]);
    expect(sorted.map((row) => row.key)).toEqual([
      "failed",
      "approval",
      "running",
      "verifying",
      "queued",
      "done",
    ]);
  });

  it("filters by status and instance, and groups by instance", () => {
    const members = [
      member("a", { status: "failed", providerInstanceId: "codex" as never }),
      member("b", { status: "queued", providerInstanceId: "codex-b" as never }),
      member("c", { status: "verified", providerInstanceId: "codex-b" as never }),
      member("d", { status: "running", providerInstanceId: null, stopGivenUp: true }),
    ];
    expect(
      filterSwarmMembers(members, { status: "failed", instanceId: null }).map((m) => m.key),
    ).toEqual(["a"]);
    expect(
      filterSwarmMembers(members, { status: "all", instanceId: "codex-b" }).map((m) => m.key),
    ).toEqual(["b", "c"]);
    expect(
      filterSwarmMembers(members, { status: "attention", instanceId: null }).map((m) => m.key),
    ).toEqual(["d"]);
    expect(
      filterSwarmMembers(members, { status: "done", instanceId: null }).map((m) => m.key),
    ).toEqual(["c"]);
    expect(
      groupSwarmMembersByInstance(members).map((group) => [group.instanceId, group.members.length]),
    ).toEqual([
      ["codex", 1],
      ["codex-b", 2],
      ["unplaced", 1],
    ]);
  });

  it("labels statuses, failures, Stop, budget stops, and approvals", () => {
    expect(
      swarmMemberStatusLabel(member("a", { status: "running", waitingForApproval: true })),
    ).toBe("waiting for your approval");
    expect(
      swarmMemberStatusLabel(
        member("a", { status: "cancelled", failureClass: "cancelled_by_architect_stop" }),
      ),
    ).toBe("stopped by your Stop");
    expect(
      swarmMemberStatusLabel(member("a", { status: "cancelled", failureClass: "budget" })),
    ).toBe("stopped by its budget");
    expect(swarmMemberStatusLabel(member("a", { status: "failed", failureClass: "verify" }))).toBe(
      "failed: failed its check",
    );
    expect(swarmMemberStatusLabel(member("a", { status: "detached" }))).toBe(
      "detached: runs on its own",
    );
    expect(swarmMemberStatusLabel(member("a", { status: "claimed_done", hasVerify: true }))).toBe(
      "done, not yet checked",
    );
  });

  it("explains queue reasons, including pauses, unhealthy instances, and retries", () => {
    expect(swarmQueueReasonLabel("global_cap")).toBe("waiting for a free slot");
    expect(swarmQueueReasonLabel("instance_unhealthy:codex")).toBe(
      "codex is signed out or failing",
    );
    expect(swarmQueueReasonLabel("instance_paused:codex:2026-11-05T10:00:00.000Z")).toMatch(
      /^paused on codex until /,
    );
    expect(swarmQueueReasonLabel("retry_after:2026-11-05T10:00:30.000Z")).toMatch(/^retrying at /);
    expect(swarmQueueReasonLabel(null)).toBeNull();
  });

  it("badges instances with slots, pauses, and serial instances", () => {
    expect(swarmInstanceBadge({ id: "codex" as never, active: 2, cap: 4 })).toBe("2/4");
    expect(
      swarmInstanceBadge({
        id: "codex" as never,
        active: 0,
        cap: 1,
        pausedUntil: "2026-11-05T10:00:00.000Z",
        pauseClass: "instance_down",
      }),
    ).toMatch(/^0\/1 · paused until .* \(instance down\) · runs one at a time$/);
  });

  it("flags follow-ups, automatic retries, given-up stops, and plan mode; shows verify and budget", () => {
    expect(
      swarmMemberFlags(
        member("a", {
          followups: 2,
          autoRetried: true,
          attempt: 2,
          stopGivenUp: true,
          interactionMode: "plan",
        }),
      ),
    ).toEqual(["2 follow-ups", "retried automatically", "could not be stopped", "plan mode"]);
    expect(swarmVerifyLabel(member("a", { verifySkipped: "runtime_mode" }))).toBe(
      "check skipped: not full access",
    );
    expect(
      swarmVerifyLabel(member("a", { verify: { passed: false, attempts: 3, timedOut: false } })),
    ).toBe("check failed (3)");
    const view = { maxTotalTurns: 240, turnsUsed: 31, budgetExhausted: false } as SwarmThreadView;
    expect(swarmBudgetLabel(view)).toBe("31/240 turns");
    expect(swarmBudgetLabel({ ...view, budgetExhausted: true })).toBe("31/240 turns · budget used");
  });

  it("confirms Stop all with what it stops, and polls only while a swarm is active", () => {
    expect(
      swarmStopAllMessage(swarmSummaryCounts([member("a"), member("b", { status: "queued" })])),
    ).toBe("Stop this swarm? 1 running member will be stopped and 1 queued member will not start.");
    expect(swarmPanelShouldPoll([{ status: "completed" } as SwarmThreadView])).toBe(false);
    expect(swarmPanelShouldPoll([{ status: "active" } as SwarmThreadView])).toBe(true);
  });

  it("backs off a failed load from 3 s to at most 60 s", () => {
    expect([1, 2, 3, 4, 5, 6, 9].map(swarmPanelRetryDelay)).toEqual([
      3_000, 6_000, 12_000, 24_000, 48_000, 60_000, 60_000,
    ]);
  });
});
