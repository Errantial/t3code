import { describe, expect, it } from "vite-plus/test";

import { acpTurnTokenUsage } from "./turnTokenUsage.ts";

const usage = (extra: Record<string, number | null> = {}) => ({
  totalTokens: 150,
  inputTokens: 100,
  outputTokens: 50,
  ...extra,
});

describe("acpTurnTokenUsage", () => {
  it("reports nothing when the agent sent no usage", () => {
    expect(acpTurnTokenUsage(undefined, false)).toBeUndefined();
    expect(acpTurnTokenUsage(null, false)).toBeUndefined();
  });

  it("maps input and output as a complete total", () => {
    expect(acpTurnTokenUsage(usage({ cachedReadTokens: 20, cachedWriteTokens: 5 }), false)).toEqual(
      {
        usageScope: "main_agent",
        usageStatus: "complete",
        hasSubagents: false,
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 20,
        cacheCreationTokens: 5,
      },
    );
  });

  it("treats a report with thought tokens as partial because ACP leaves their accounting open", () => {
    expect(acpTurnTokenUsage(usage({ thoughtTokens: 30 }), false)).toMatchObject({
      usageStatus: "partial",
      outputTokens: 50,
      reasoningTokens: 30,
    });
    expect(acpTurnTokenUsage(usage({ thoughtTokens: 0 }), false)?.usageStatus).toBe("complete");
  });

  it("rejects malformed counts instead of guessing", () => {
    expect(acpTurnTokenUsage(usage({ outputTokens: -1 }), false)).toBeUndefined();
    expect(acpTurnTokenUsage(usage({ inputTokens: 1.5 }), false)).toBeUndefined();
  });

  it("flags subagent turns", () => {
    expect(acpTurnTokenUsage(usage(), true)?.hasSubagents).toBe(true);
  });
});
