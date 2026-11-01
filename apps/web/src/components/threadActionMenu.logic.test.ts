import { describe, expect, it } from "vite-plus/test";

import { buildThreadActionMenuItems, type ThreadActionMenuState } from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

describe("buildThreadActionMenuItems", () => {
  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "save",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "save",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });

  it("offers the ChatGPT tab controls only for a provider that owns one", () => {
    expect(
      buildThreadActionMenuItems(baseState).filter((item) => item.id.includes("chatgpt-tab")),
    ).toEqual([]);
    const items = buildThreadActionMenuItems({ ...baseState, canControlChatGptTab: true });
    expect(items.find((item) => item.id === "show-chatgpt-tab")?.label).toBe("Show ChatGPT tab");
    expect(items.find((item) => item.id === "reload-chatgpt-tab")?.label).toBe(
      "Reload ChatGPT tab",
    );
  });

  it("hides Settle for a pinned thread until it is unpinned when the Labs pin overhaul is off", () => {
    const ids = (state: ThreadActionMenuState) =>
      buildThreadActionMenuItems(state).map((item) => item.id);
    const overhaulOff = ids({ ...baseState, isPinned: true, pinnedThreadsOnTop: false });
    expect(overhaulOff).toContain("unpin");
    expect(overhaulOff).toContain("save");
    expect(overhaulOff).not.toContain("settle");
    // An unpinned thread keeps Settle even with the overhaul off.
    expect(ids({ ...baseState, isPinned: false, pinnedThreadsOnTop: false })).toContain("settle");
    // On is the current behavior.
    expect(ids({ ...baseState, isPinned: true, pinnedThreadsOnTop: true })).toContain("settle");
  });
});
