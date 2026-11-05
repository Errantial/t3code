import type { EnvironmentId, SwarmSummary, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  isUnknownMethodFailure,
  mergeSwarmSummaries,
  nextSwarmPollDelay,
  swarmChipLabel,
  swarmSummaryKey,
} from "./swarmSummaries";

const summary = (threadId: string, counts: Partial<SwarmSummary> = {}): SwarmSummary => ({
  threadId: threadId as ThreadId,
  running: 0,
  queued: 0,
  failed: 0,
  ...counts,
});

describe("swarm sidebar chip", () => {
  it("leaves zero counts out and shows nothing when all are zero", () => {
    expect(swarmChipLabel(summary("t", { running: 2, failed: 1 }))).toBe(
      "Swarm · 2 running · 1 failed",
    );
    expect(swarmChipLabel(summary("t", { queued: 4 }))).toBe("Swarm · 4 queued");
    expect(swarmChipLabel(summary("t"))).toBeNull();
    expect(swarmChipLabel(undefined)).toBeNull();
  });

  it("polls every 10 s with swarms and every 60 s without", () => {
    expect(nextSwarmPollDelay(true)).toBe(10_000);
    expect(nextSwarmPollDelay(false)).toBe(60_000);
  });

  it("treats a server without the RPC as unsupported", () => {
    expect(isUnknownMethodFailure(new Error("Unknown request tag: swarm.summaries"))).toBe(true);
    expect(isUnknownMethodFailure("SwarmRpcError: Swarm v2 is off")).toBe(false);
  });

  it("replaces one environment's entries and keeps the others", () => {
    const a = "env-a" as EnvironmentId;
    const b = "env-b" as EnvironmentId;
    const first = mergeSwarmSummaries(
      mergeSwarmSummaries(new Map(), a, [summary("t1", { running: 1 })]),
      b,
      [summary("t2", { queued: 1 })],
    );
    const next = mergeSwarmSummaries(first, a, []);
    expect(next.has(swarmSummaryKey(a, "t1"))).toBe(false);
    expect(next.get(swarmSummaryKey(b, "t2"))?.queued).toBe(1);
  });
});
