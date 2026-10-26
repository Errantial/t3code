import { describe, expect, it } from "vite-plus/test";

import { ProviderDriverKind, RunAttemptId } from "@t3tools/contracts";

import {
  isProviderStreamRecoveryVisible,
  providerStreamRecoveryBannerItem,
} from "./ThreadActivityBanners";

describe("provider stream recovery banner", () => {
  it("presents reconnecting as neutral activity while ChatGPT may still be working", () => {
    const item = providerStreamRecoveryBannerItem({ providerSessionId: "provider-session-1" });

    expect(item.id).toBe("provider-stream-recovery:provider-session-1");
    expect(item.variant).toBe("info");
    expect(item.priority).toBe("activity");
    expect(item.title).toBe("Provider stream reconnecting");
    expect(item.description).toBe(
      "ChatGPT may still be working. T3 will resume live updates from the existing turn when the stream reconnects.",
    );
  });

  it("does not expose dismiss, error, or recovery actions", () => {
    const item = providerStreamRecoveryBannerItem({ providerSessionId: "provider-session-2" });

    expect(item.variant).not.toBe("error");
    expect(item.actions).toBeUndefined();
    expect(item.dismissLabel).toBeUndefined();
    expect(item.onDismiss).toBeUndefined();
  });

  it("only shows after an exact ChatGPT provider turn was already accepted", () => {
    const attemptId = RunAttemptId.make("attempt-provider-stream-recovery");
    const providerSession = {
      driver: ProviderDriverKind.make("chatgptBrowser"),
      status: "starting" as const,
    };

    expect(
      isProviderStreamRecoveryVisible({
        providerSession,
        activeAttemptId: attemptId,
        providerTurns: [],
      }),
    ).toBe(false);
    expect(
      isProviderStreamRecoveryVisible({
        providerSession,
        activeAttemptId: attemptId,
        providerTurns: [{ runAttemptId: attemptId }],
      }),
    ).toBe(true);
    expect(
      isProviderStreamRecoveryVisible({
        providerSession: { driver: ProviderDriverKind.make("codex"), status: "starting" },
        activeAttemptId: attemptId,
        providerTurns: [{ runAttemptId: attemptId }],
      }),
    ).toBe(false);
  });
});
