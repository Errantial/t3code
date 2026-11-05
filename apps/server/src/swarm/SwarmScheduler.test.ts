import { describe, expect, it } from "@effect/vitest";
import { ProviderDriverKind, SwarmId } from "@t3tools/contracts";

import {
  type PlannedMember,
  type SwarmCaps,
  instanceCap,
  memberRef,
  narrowerInteractionMode,
  narrowerRuntimeMode,
  ownsPathsOverlapWarnings,
  pathsOverlap,
  planAdmissions,
  serialInstanceWarnings,
  sharedWriterRefusal,
} from "./swarmPlanning.ts";

// The scheduler's decisions are pure (swarmPlanning.ts); the clock and the dispatcher are inputs.

const codex = ProviderDriverKind.make("codex");
const chatgpt = ProviderDriverKind.make("chatgptBrowser");
const caps: SwarmCaps = { global: 8, perInstance: 4, instanceOverrides: {} };
const now = "2026-11-04T12:00:00.000Z";
const swarmA = SwarmId.make("swarm:a");
const swarmB = SwarmId.make("swarm:b");

const member = (
  swarmId: SwarmId,
  ordinal: number,
  overrides: Partial<PlannedMember> = {},
): PlannedMember => ({
  swarmId,
  memberKey: `m${ordinal}`,
  ordinal,
  status: "queued",
  providerInstanceId: "codex",
  driver: codex,
  ...overrides,
});

const swarm = (swarmId: SwarmId, createdAt: string, maxConcurrent: number | null = null) => ({
  swarmId,
  createdAt,
  maxConcurrent,
  admits: true,
});

const keys = (members: ReadonlyArray<PlannedMember>) =>
  members.map((planned) => `${planned.swarmId}/${planned.memberKey}`);

describe("planAdmissions", () => {
  it("admits up to the global cap in creation then ordinal order", () => {
    const plan = planAdmissions({
      swarms: [
        swarm(swarmB, "2026-11-04T11:00:01.000Z"),
        swarm(swarmA, "2026-11-04T11:00:00.000Z"),
      ],
      members: [member(swarmB, 0), member(swarmA, 1), member(swarmA, 0)],
      caps: { ...caps, global: 2 },
      pauses: new Map(),
      now,
    });
    expect(keys(plan.admit)).toEqual(["swarm:a/m0", "swarm:a/m1"]);
    expect(plan.queueReasons.get(memberRef(member(swarmB, 0)))).toBe("global_cap");
  });

  it("counts members that hold a slot, and not final or limit-waiting ones", () => {
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [
        member(swarmA, 0, { status: "running" }),
        member(swarmA, 1, { status: "verifying" }),
        member(swarmA, 2, { status: "limit_wait" }),
        member(swarmA, 3, { status: "claimed_done" }),
        member(swarmA, 4),
        member(swarmA, 5),
      ],
      caps: { ...caps, global: 3 },
      pauses: new Map(),
      now,
    });
    expect(keys(plan.admit)).toEqual(["swarm:a/m4"]);
    expect(plan.queueReasons.get(memberRef(member(swarmA, 5)))).toBe("global_cap");
  });

  it("applies the per-swarm maxConcurrent below the global cap", () => {
    const plan = planAdmissions({
      swarms: [
        swarm(swarmA, "2026-11-04T11:00:00.000Z", 1),
        swarm(swarmB, "2026-11-04T11:00:01.000Z"),
      ],
      members: [member(swarmA, 0), member(swarmA, 1), member(swarmB, 0)],
      caps,
      pauses: new Map(),
      now,
    });
    expect(keys(plan.admit)).toEqual(["swarm:a/m0", "swarm:b/m0"]);
    expect(plan.queueReasons.get(memberRef(member(swarmA, 1)))).toBe("swarm_cap");
  });

  it("does not let a full or paused instance block later members", () => {
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [
        member(swarmA, 0, { status: "running", providerInstanceId: "busy" }),
        member(swarmA, 1, { providerInstanceId: "busy" }),
        member(swarmA, 2, { providerInstanceId: "paused" }),
        member(swarmA, 3, { providerInstanceId: "free" }),
      ],
      caps: { ...caps, instanceOverrides: { busy: 1 } },
      pauses: new Map([
        ["paused", "2026-11-04T12:05:00.000Z"],
        ["expired", "2026-11-04T11:00:00.000Z"],
      ]),
      now,
    });
    expect(keys(plan.admit)).toEqual(["swarm:a/m3"]);
    expect(plan.queueReasons.get(memberRef(member(swarmA, 1)))).toBe("instance_cap:busy");
    expect(plan.queueReasons.get(memberRef(member(swarmA, 2)))).toBe(
      "instance_paused:paused:2026-11-04T12:05:00.000Z",
    );
  });

  it("ignores an expired pause and swarms that no longer admit", () => {
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now), { ...swarm(swarmB, now), admits: false }],
      members: [member(swarmA, 0, { providerInstanceId: "expired" }), member(swarmB, 0)],
      caps,
      pauses: new Map([["expired", "2026-11-04T11:00:00.000Z"]]),
      now,
    });
    expect(keys(plan.admit)).toEqual(["swarm:a/m0"]);
    expect(plan.queueReasons.has(memberRef(member(swarmB, 0)))).toBe(false);
  });

  it("reads caps from settings, with ChatGPT/CoS serial by default", () => {
    expect(instanceCap(caps, "codex", codex)).toBe(4);
    expect(instanceCap(caps, "cos", chatgpt)).toBe(1);
    expect(instanceCap({ ...caps, instanceOverrides: { cos: 3 } }, "cos", chatgpt)).toBe(3);
    expect(instanceCap({ ...caps, perInstance: 48 }, "codex", codex)).toBe(48);
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [
        member(swarmA, 0, { providerInstanceId: "cos", driver: chatgpt }),
        member(swarmA, 1, { providerInstanceId: "cos", driver: chatgpt }),
      ],
      caps: { ...caps, global: 48 },
      pauses: new Map(),
      now,
    });
    expect(keys(plan.admit)).toEqual(["swarm:a/m0"]);
    expect(plan.queueReasons.get(memberRef(member(swarmA, 1)))).toBe("instance_cap:cos");
  });
});

describe("writers and paths", () => {
  it("refuses two shared writers unless allowSharedWriters and ownsPaths are both set", () => {
    const shared = { isolation: "shared" as const, writer: true };
    expect(
      sharedWriterRefusal({ members: [{ key: "a", ...shared }], allowSharedWriters: false }),
    ).toBe(undefined);
    const two = [
      { key: "a", ...shared, ownsPaths: ["src/a"] },
      { key: "b", ...shared },
    ];
    expect(sharedWriterRefusal({ members: two, allowSharedWriters: false })).toContain(
      `isolation: "worktree"`,
    );
    expect(sharedWriterRefusal({ members: two, allowSharedWriters: true })).toBeDefined();
    expect(
      sharedWriterRefusal({
        members: [two[0]!, { ...two[1]!, ownsPaths: ["src/b"] }],
        allowSharedWriters: true,
      }),
    ).toBe(undefined);
    // Planning members and worktree writers do not share the checkout.
    expect(
      sharedWriterRefusal({
        members: [
          { key: "a", ...shared },
          { key: "b", isolation: "shared", writer: false },
          { key: "c", isolation: "worktree", writer: true },
        ],
        allowSharedWriters: false,
      }),
    ).toBe(undefined);
  });

  it("finds overlaps for equal paths, directory prefixes, and glob prefixes", () => {
    expect(pathsOverlap("src/a.ts", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src", "src/a.ts")).toBe(true);
    expect(pathsOverlap("src/", "./src/a.ts")).toBe(true);
    expect(pathsOverlap("src/**/*.ts", "src/lib/a.ts")).toBe(true);
    expect(pathsOverlap("src/ab", "src/a")).toBe(false);
    expect(pathsOverlap("docs", "src")).toBe(false);
    const warnings = ownsPathsOverlapWarnings([
      { key: "a", isolation: "worktree", writer: true, ownsPaths: ["src/lib"] },
      { key: "b", isolation: "worktree", writer: true, ownsPaths: ["docs", "src/lib/x.ts"] },
      { key: "c", isolation: "shared", writer: false, ownsPaths: ["src"] },
    ]);
    expect(warnings).toEqual([
      {
        kind: "owns_paths_overlap",
        keys: ["a", "b"],
        path: "src/lib",
        message: "Members 'a' and 'b' both own 'src/lib'.",
      },
    ]);
  });

  it("warns once per serial instance", () => {
    expect(
      serialInstanceWarnings({
        members: [
          { key: "a", instanceId: "cos", driver: chatgpt },
          { key: "b", instanceId: "cos", driver: chatgpt },
          { key: "c", instanceId: "codex", driver: codex },
        ],
        caps,
      }).map((warning) => [warning.kind, warning.instanceId, warning.keys]),
    ).toEqual([["serial_instance", "cos", ["a", "b"]]]);
  });

  it("never raises a ceiling", () => {
    expect(narrowerRuntimeMode("full-access", "auto")).toBe("auto");
    expect(narrowerRuntimeMode("approval-required", "full-access")).toBe("approval-required");
    expect(narrowerInteractionMode("default", "plan")).toBe("plan");
    expect(narrowerInteractionMode("plan", "default")).toBe("plan");
  });
});

describe("anyOf placement", () => {
  const anyOf = ["a", "b", "c"];
  const queued = (ordinal: number, overrides: Partial<PlannedMember> = {}) =>
    member(swarmA, ordinal, { providerInstanceId: null, anyOf, ...overrides });
  const placed = (plan: ReturnType<typeof planAdmissions>) =>
    plan.admit.map((admission) => admission.placedInstanceId);
  const healthy = new Set(anyOf);

  it("places on the instance with the fewest active members", () => {
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [
        member(swarmA, 0, { status: "running", providerInstanceId: "a" }),
        member(swarmA, 1, { status: "running", providerInstanceId: "c" }),
        queued(2),
      ],
      caps,
      pauses: new Map(),
      now,
      healthy,
    });
    expect(placed(plan)).toEqual(["b"]);
  });

  it("breaks ties by fewer recent failures, then by anyOf order", () => {
    const tie = (recentFailures: ReadonlyMap<string, number>) =>
      placed(
        planAdmissions({
          swarms: [swarm(swarmA, now)],
          members: [queued(0)],
          caps,
          pauses: new Map(),
          now,
          healthy,
          recentFailures,
        }),
      );
    expect(tie(new Map())).toEqual(["a"]);
    expect(
      tie(
        new Map([
          ["a", 2],
          ["b", 1],
        ]),
      ),
    ).toEqual(["c"]);
  });

  it("skips paused, unhealthy, and full instances, and queues when none qualifies", () => {
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [
        member(swarmA, 0, { status: "running", providerInstanceId: "c" }),
        queued(1),
        queued(2),
      ],
      caps: { ...caps, instanceOverrides: { c: 1 } },
      pauses: new Map([["a", "2026-11-04T12:05:00.000Z"]]),
      now,
      // b is in error or signed out, so the registry does not list it as healthy.
      healthy: new Set(["a", "c"]),
    });
    expect(placed(plan)).toEqual([]);
    expect(plan.queueReasons.get(memberRef(queued(1)))).toBe("any_of_unavailable");
    expect(plan.queueReasons.get(memberRef(queued(2)))).toBe("any_of_unavailable");
  });

  it("avoids a failed instance whenever another one qualifies", () => {
    const plan = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [
        queued(0, { avoidInstanceId: "a" }),
        queued(1, { anyOf: ["a"], avoidInstanceId: "a" }),
      ],
      caps,
      pauses: new Map(),
      now,
      healthy,
    });
    expect(placed(plan)).toEqual(["b", "a"]);
  });

  it("spreads 12 members 2/2/2 over three instances, and a pause moves the rest", () => {
    const tight: SwarmCaps = { global: 6, perInstance: 2, instanceOverrides: {} };
    const members = Array.from({ length: 12 }, (_, index) => queued(index));
    const first = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members,
      caps: tight,
      pauses: new Map(),
      now,
      healthy,
    });
    const spread = (instances: ReadonlyArray<string | null>) =>
      Object.fromEntries(anyOf.map((id) => [id, instances.filter((value) => value === id).length]));
    expect(spread(placed(first))).toEqual({ a: 2, b: 2, c: 2 });

    // Three finish, one per instance; then c pauses. Its free slot is not used.
    const running = first.admit.map(
      ({ anyOf: _anyOf, placedInstanceId, ...admission }, index): PlannedMember => ({
        ...admission,
        status: index % 2 === 0 ? "claimed_done" : "running",
        providerInstanceId: placedInstanceId,
      }),
    );
    const second = planAdmissions({
      swarms: [swarm(swarmA, now)],
      members: [...running, ...members.slice(6)],
      caps: tight,
      pauses: new Map([["c", "2026-11-04T12:30:00.000Z"]]),
      now,
      healthy,
    });
    expect(spread(placed(second))).toEqual({ a: 1, b: 1, c: 0 });
  });
});
