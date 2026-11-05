import { describe, expect, it } from "vite-plus/test";

import { confirmSwarmAction } from "./swarmConfirm";

describe("confirmSwarmAction", () => {
  it("asks the fallback when no dialog host is mounted, and never assumes a yes", async () => {
    const asked: Array<string> = [];
    await expect(
      confirmSwarmAction("Stop this swarm?", (message) => {
        asked.push(message);
        return false;
      }),
    ).resolves.toBe(false);
    expect(asked).toEqual(["Stop this swarm?"]);
    await expect(confirmSwarmAction("Stop this swarm?", () => true)).resolves.toBe(true);
  });
});
