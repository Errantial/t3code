import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";

import { DEFAULT_SERVER_SETTINGS, ServerSettingsPatch } from "./settings.ts";
import {
  OrchestrationV2Command,
  OrchestrationV2DelegatedCompletionCohort,
  OrchestrationV2DelegatedCompletionDetail,
  OrchestrationV2DelegatedCompletionWake,
} from "./orchestrationV2.ts";
import {
  SwarmAddMembersInput,
  SwarmCancelInput,
  SwarmCollectInput,
  SwarmCreateInput,
  SwarmEnvelope,
  SwarmEnvelopeField,
  SwarmFailureClass,
  SwarmFollowupInput,
  SwarmMap,
  SwarmMemberInput,
  SwarmMemberStatus,
  SwarmMemberTarget,
  SwarmPauseClass,
  SwarmRetryInput,
  SwarmStatus,
  SwarmStatusInput,
  SwarmVerify,
  SwarmWakeBatch,
  SwarmWakePolicy,
  SwarmWarningKind,
} from "./swarm.ts";

const accepts = <S extends Schema.Top>(schema: S, value: unknown) =>
  Exit.isSuccess(Schema.decodeUnknownExit(schema as never)(value));

const member = { key: "a", title: "Member A", task: "Do part A." };

describe("swarm contracts", () => {
  it("decodes every literal", () => {
    const literals: ReadonlyArray<readonly [Schema.Top, ReadonlyArray<string>]> = [
      [
        SwarmMemberStatus,
        [
          "queued",
          "launching",
          "running",
          "limit_wait",
          "claimed_done",
          "verifying",
          "verified",
          "failed",
          "cancelled",
          "detached",
        ],
      ],
      [
        SwarmFailureClass,
        [
          "launch",
          "usage_limit",
          "provider_error",
          "transport_error",
          "permission_error",
          "validation_error",
          "unknown",
          "verify",
          "budget",
          "cancelled_by_architect_stop",
        ],
      ],
      [SwarmPauseClass, ["usage_limit", "instance_down"]],
      [SwarmStatus, ["active", "completed", "cancelled", "detached"]],
      [SwarmWakePolicy, ["group", "failure", "batch"]],
      [SwarmEnvelopeField, ["summary", "decisions", "assumptions", "verify", "artifacts", "data"]],
      [
        SwarmWarningKind,
        [
          "owns_paths_overlap",
          "serial_instance",
          "base_behind_head",
          "no_retry_room",
          "limit_lowered",
        ],
      ],
      [OrchestrationV2DelegatedCompletionWake, ["always", "settled_only", "held"]],
    ];
    for (const [schema, values] of literals) {
      for (const value of values) expect(accepts(schema, value), value).toBe(true);
      expect(accepts(schema, "not-a-literal")).toBe(false);
    }
    // `all` was removed in revision 3.
    expect(accepts(SwarmWakePolicy, "all")).toBe(false);
  });

  it("bounds the create input", () => {
    expect(accepts(SwarmCreateInput, { title: "Swarm", members: [member] })).toBe(true);
    expect(accepts(SwarmCreateInput, { title: "Swarm", members: [] })).toBe(false);
    const members = (count: number) =>
      Array.from({ length: count }, (_, index) => ({ ...member, key: `m${index}` }));
    expect(accepts(SwarmCreateInput, { title: "Swarm", members: members(12) })).toBe(true);
    expect(accepts(SwarmCreateInput, { title: "Swarm", members: members(13) })).toBe(false);
    expect(accepts(SwarmCreateInput, { title: "x".repeat(513), members: [member] })).toBe(false);
    const ranges: ReadonlyArray<readonly [string, number, number]> = [
      ["maxConcurrent", 1, 48],
      ["maxTotalTurns", 1, 2_400],
    ];
    for (const [field, minimum, maximum] of ranges) {
      for (const [value, ok] of [
        [minimum, true],
        [maximum, true],
        [minimum - 1, false],
        [maximum + 1, false],
        [minimum + 0.5, false],
      ] as const) {
        expect(
          accepts(SwarmCreateInput, { title: "Swarm", members: [member], [field]: value }),
          `${field}=${value}`,
        ).toBe(ok);
      }
    }
    expect(
      accepts(SwarmCreateInput, {
        title: "Swarm",
        members: [member],
        sharedContext: "s".repeat(16_385),
      }),
    ).toBe(false);
    expect(
      accepts(SwarmCreateInput, {
        title: "Swarm",
        members: [member],
        dataShape: "d".repeat(2_001),
      }),
    ).toBe(false);
  });

  it("bounds member settings", () => {
    const ranges: ReadonlyArray<readonly [string, number, number]> = [
      ["maxTurns", 1, 50],
      ["maxWallClockMs", 60_000, 86_400_000],
    ];
    for (const [field, minimum, maximum] of ranges) {
      expect(accepts(SwarmMemberInput, { ...member, [field]: minimum })).toBe(true);
      expect(accepts(SwarmMemberInput, { ...member, [field]: maximum })).toBe(true);
      expect(accepts(SwarmMemberInput, { ...member, [field]: minimum - 1 })).toBe(false);
      expect(accepts(SwarmMemberInput, { ...member, [field]: maximum + 1 })).toBe(false);
    }
    expect(accepts(SwarmMemberInput, { ...member, key: "k".repeat(65) })).toBe(false);
    expect(accepts(SwarmMemberInput, { ...member, doneCriteria: "d".repeat(2_001) })).toBe(false);
    expect(accepts(SwarmMemberInput, { ...member, ownsPaths: Array(51).fill("src/") })).toBe(false);
    expect(accepts(SwarmMemberInput, { ...member, isolation: "worktree" })).toBe(true);
    expect(accepts(SwarmMemberInput, { ...member, isolation: "remote" })).toBe(false);
    expect(accepts(SwarmMemberInput, { ...member, runtimeMode: "inherit" })).toBe(true);
    expect(accepts(SwarmMemberInput, { ...member, interactionMode: "plan" })).toBe(true);
  });

  it("bounds anyOf, verify, and wake batches", () => {
    expect(accepts(SwarmMemberTarget, { anyOf: ["a", "b"], model: "m" })).toBe(true);
    expect(accepts(SwarmMemberTarget, { anyOf: ["a"] })).toBe(false);
    expect(accepts(SwarmMemberTarget, { anyOf: Array(9).fill("a") })).toBe(false);
    expect(accepts(SwarmVerify, { argv: ["pnpm", "test"] })).toBe(true);
    expect(accepts(SwarmVerify, { argv: [] })).toBe(false);
    expect(accepts(SwarmVerify, { argv: ["x"], timeoutMs: 999 })).toBe(false);
    expect(accepts(SwarmVerify, { argv: ["x"], timeoutMs: 1_800_001 })).toBe(false);
    expect(accepts(SwarmVerify, { argv: ["x"], maxRetries: 3 })).toBe(true);
    expect(accepts(SwarmVerify, { argv: ["x"], maxRetries: 4 })).toBe(false);
    expect(accepts(SwarmWakeBatch, { minCount: 2, maxWaitMs: 30_000 })).toBe(true);
    expect(accepts(SwarmWakeBatch, { minCount: 1 })).toBe(false);
    expect(accepts(SwarmWakeBatch, { minCount: 49 })).toBe(false);
    expect(accepts(SwarmWakeBatch, { maxWaitMs: 29_999 })).toBe(false);
    expect(accepts(SwarmWakeBatch, { maxWaitMs: 1_800_001 })).toBe(false);
  });

  it("bounds a map and its rows", () => {
    const row = (index: number) => ({ key: `r${index}`, vars: { name: "value" } });
    const map = (rows: ReadonlyArray<unknown>) => ({
      task: "Do {{name}}.",
      title: "{{key}}",
      rows,
    });
    expect(accepts(SwarmMap, map([row(0)]))).toBe(true);
    expect(accepts(SwarmMap, map([]))).toBe(false);
    expect(accepts(SwarmMap, map(Array.from({ length: 48 }, (_, index) => row(index))))).toBe(true);
    expect(accepts(SwarmMap, map(Array.from({ length: 49 }, (_, index) => row(index))))).toBe(
      false,
    );
    expect(accepts(SwarmMap, map([{ key: "r", vars: { "bad-name": "v" } }]))).toBe(false);
    expect(accepts(SwarmMap, map([{ key: "r", vars: { ["n".repeat(33)]: "v" } }]))).toBe(false);
    expect(accepts(SwarmMap, map([{ key: "r", vars: { name: "v".repeat(4_001) } }]))).toBe(false);
  });

  it("decodes the other tool inputs", () => {
    const swarmId = "swarm:1";
    expect(accepts(SwarmAddMembersInput, { swarmId, members: [member] })).toBe(true);
    expect(accepts(SwarmFollowupInput, { swarmId, key: "a", message: "More." })).toBe(true);
    expect(accepts(SwarmFollowupInput, { swarmId, key: "a" })).toBe(false);
    expect(accepts(SwarmStatusInput, { swarmId, view: "members", offset: 0, limit: 50 })).toBe(
      true,
    );
    expect(accepts(SwarmStatusInput, { swarmId, limit: 51 })).toBe(false);
    expect(accepts(SwarmStatusInput, { swarmId, view: "all" })).toBe(false);
    expect(accepts(SwarmCancelInput, { swarmId })).toBe(true);
    expect(accepts(SwarmCancelInput, { swarmId, keys: [] })).toBe(false);
    expect(accepts(SwarmRetryInput, { swarmId, keys: ["a"] })).toBe(true);
    expect(accepts(SwarmRetryInput, { swarmId })).toBe(false);
    expect(accepts(SwarmCollectInput, { swarmId, fields: ["data"], maxBytes: 4_096 })).toBe(true);
    expect(accepts(SwarmCollectInput, { swarmId, maxBytes: 4_095 })).toBe(false);
    expect(accepts(SwarmCollectInput, { swarmId, maxBytes: 32_769 })).toBe(false);
    expect(accepts(SwarmCollectInput, { swarmId: "" })).toBe(false);
  });

  it("bounds the envelope", () => {
    const envelope = {
      status: "verified",
      attempt: 1,
      followup: 0,
      structured: true,
      summary: "Done.",
      decisions: [],
      assumptions: [],
      dataDropped: false,
      artifacts: {
        changedPaths: ["src/a.ts"],
        changedPathsTracked: true,
        changedPathsTruncated: false,
        uncommittedCount: 0,
      },
      testFilesChanged: false,
    };
    expect(accepts(SwarmEnvelope, envelope)).toBe(true);
    expect(accepts(SwarmEnvelope, { ...envelope, summary: "s".repeat(2_049) })).toBe(false);
    expect(accepts(SwarmEnvelope, { ...envelope, decisions: Array(11).fill("d") })).toBe(false);
    expect(accepts(SwarmEnvelope, { ...envelope, decisions: ["d".repeat(201)] })).toBe(false);
    expect(
      accepts(SwarmEnvelope, {
        ...envelope,
        artifacts: { ...envelope.artifacts, changedPaths: Array(201).fill("p") },
      }),
    ).toBe(false);
    expect(
      accepts(SwarmEnvelope, {
        ...envelope,
        failure: { class: "verify", message: "m".repeat(1_001) },
      }),
    ).toBe(false);
  });
});

describe("swarm orchestration contract pieces", () => {
  const request = {
    type: "delegated_task.request",
    createdBy: "agent",
    creationSource: "server",
    commandId: "command:1",
    parentThreadId: "thread:1",
    parentRunId: "run:1",
    parentNodeId: "node:1",
    task: "Do it.",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
  };

  it("carries held, swarmAdmission, and completionDetail", () => {
    expect(
      accepts(OrchestrationV2Command, {
        ...request,
        completionWake: "held",
        swarmAdmission: { swarmId: "swarm:1" },
      }),
    ).toBe(true);
    expect(accepts(OrchestrationV2Command, { ...request, swarmAdmission: { swarmId: " " } })).toBe(
      false,
    );
    const wakePolicy = {
      type: "delegated_task.wake-policy",
      commandId: "command:2",
      parentThreadId: "thread:1",
      taskId: "node:2",
      completionWake: "always",
    };
    expect(accepts(OrchestrationV2Command, { ...wakePolicy, completionDetail: "digest" })).toBe(
      true,
    );
    expect(accepts(OrchestrationV2Command, { ...wakePolicy, completionWake: "held" })).toBe(true);
  });

  it("caps completionDetail at 16,000 UTF-8 bytes, not characters", () => {
    expect(accepts(OrchestrationV2DelegatedCompletionDetail, "a".repeat(16_000))).toBe(true);
    expect(accepts(OrchestrationV2DelegatedCompletionDetail, "a".repeat(16_001))).toBe(false);
    // 5,334 three-byte characters are 16,002 bytes.
    expect(accepts(OrchestrationV2DelegatedCompletionDetail, "€".repeat(5_334))).toBe(false);
    expect(accepts(OrchestrationV2DelegatedCompletionDetail, "€".repeat(5_333))).toBe(true);
  });

  it("keeps swarmIds optional on the cohort", () => {
    const cohort = { disposition: "open", nextGeneration: 1, delivery: null };
    expect(accepts(OrchestrationV2DelegatedCompletionCohort, cohort)).toBe(true);
    expect(
      accepts(OrchestrationV2DelegatedCompletionCohort, { ...cohort, swarmIds: ["swarm:1"] }),
    ).toBe(true);
    expect(accepts(OrchestrationV2DelegatedCompletionCohort, { ...cohort, swarmIds: [""] })).toBe(
      false,
    );
  });

  it("does not let a client send swarm.anchor", () => {
    expect(
      accepts(OrchestrationV2Command, {
        type: "swarm.anchor",
        commandId: "command:3",
        threadId: "thread:1",
        runId: "run:1",
        swarmId: "swarm:1",
      }),
    ).toBe(false);
  });
});

describe("swarmV2Enabled", () => {
  it("defaults to off and can be patched", () => {
    expect(DEFAULT_SERVER_SETTINGS.swarmV2Enabled).toBe(false);
    expect(accepts(ServerSettingsPatch, { swarmV2Enabled: true })).toBe(true);
    expect(accepts(ServerSettingsPatch, { swarmV2Enabled: "yes" })).toBe(false);
  });
});
