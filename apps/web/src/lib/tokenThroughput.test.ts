import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import { deriveTokenThroughput, formatTokensPerSecond } from "./tokenThroughput";

type Turn = Parameters<typeof deriveTokenThroughput>[0][number];

const at = (seconds: number) => DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, 0, seconds));

function turn(input: {
  startS: number;
  endS: number | null;
  status?: OrchestrationV2ProviderTurn["status"];
  usage?: Turn["turnTokenUsage"];
}): Turn {
  return {
    status: input.status ?? "completed",
    startedAt: at(input.startS),
    completedAt: input.endS === null ? null : at(input.endS),
    ...(input.usage === undefined ? {} : { turnTokenUsage: input.usage }),
  };
}

const complete = (outputTokens: number, hasSubagents = false): Turn["turnTokenUsage"] => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens: 1000,
  outputTokens,
  hasSubagents,
});

describe("deriveTokenThroughput", () => {
  it("divides complete output tokens by turn wall time", () => {
    const result = deriveTokenThroughput([turn({ startS: 0, endS: 10, usage: complete(500) })]);
    expect(result).toEqual({ tokensPerSecond: 50, outputTokens: 500, elapsedMs: 10_000 });
  });

  it("uses the most recent completed turn, ignoring unfinished ones", () => {
    const result = deriveTokenThroughput([
      turn({ startS: 0, endS: 10, usage: complete(100) }),
      turn({ startS: 20, endS: 30, usage: complete(400) }),
      turn({ startS: 40, endS: null, status: "running", usage: complete(9999) }),
    ]);
    expect(result?.tokensPerSecond).toBe(40);
  });

  it("reports nothing when the provider gave no complete total", () => {
    expect(deriveTokenThroughput([turn({ startS: 0, endS: 10 })])).toBeNull();
    expect(
      deriveTokenThroughput([
        turn({
          startS: 0,
          endS: 10,
          usage: {
            usageScope: "main_agent",
            usageStatus: "partial",
            outputTokens: 500,
            hasSubagents: false,
          },
        }),
      ]),
    ).toBeNull();
  });

  it("skips subagent turns, zero-token turns and sub-threshold durations", () => {
    expect(
      deriveTokenThroughput([turn({ startS: 0, endS: 10, usage: complete(500, true) })]),
    ).toBeNull();
    expect(deriveTokenThroughput([turn({ startS: 0, endS: 10, usage: complete(0) })])).toBeNull();
    expect(
      deriveTokenThroughput([
        {
          status: "completed",
          startedAt: at(0),
          completedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 29, 12, 0, 0, 200)),
          turnTokenUsage: complete(50),
        },
      ]),
    ).toBeNull();
  });
});

describe("formatTokensPerSecond", () => {
  it("rounds large rates and keeps one decimal for small ones", () => {
    expect(formatTokensPerSecond(123.4)).toBe("123 tok/s");
    expect(formatTokensPerSecond(42.26)).toBe("42.3 tok/s");
  });
});
