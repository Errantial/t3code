import { describe, expect, it } from "vite-plus/test";

import { toggleThreadInList } from "./threadTokenRatePreference";

describe("toggleThreadInList", () => {
  it("adds a thread once and removes it again", () => {
    const on = toggleThreadInList(["a"], "b", true);
    expect(on).toEqual(["a", "b"]);
    expect(toggleThreadInList(on, "b", true)).toEqual(["a", "b"]);
    expect(toggleThreadInList(on, "b", false)).toEqual(["a"]);
  });

  it("keeps the most recently enabled threads when the cap is hit", () => {
    const full = Array.from({ length: 500 }, (_, index) => `t${index}`);
    const next = toggleThreadInList(full, "new", true);
    expect(next).toHaveLength(500);
    expect(next[0]).toBe("t1");
    expect(next.at(-1)).toBe("new");
  });
});
