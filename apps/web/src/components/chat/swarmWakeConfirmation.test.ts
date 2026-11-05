import type { OrchestrationV2ThreadProjection, RunId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { queuedWakeCarriesSwarm } from "./swarmWakeConfirmation";

const projection = (swarmIds: ReadonlyArray<string> | undefined) =>
  ({
    runs: [
      {
        id: "run:anchor",
        userMessageId: "message:anchor",
        ...(swarmIds === undefined ? {} : { delegatedCompletion: { swarmIds } }),
      },
      { id: "run:wake", userMessageId: "message:wake" },
      { id: "run:plain", userMessageId: "message:plain" },
    ],
    messages: [
      { id: "message:wake", delegatedCompletion: { parentRunId: "run:anchor" } },
      { id: "message:plain" },
    ],
  }) as unknown as Pick<OrchestrationV2ThreadProjection, "runs" | "messages">;

describe("swarm wake confirmation", () => {
  it("asks only before cancelling a wake whose cohort carries a swarm", () => {
    expect(queuedWakeCarriesSwarm(projection(["swarm:1"]), "run:wake" as RunId)).toBe(true);
    expect(queuedWakeCarriesSwarm(projection([]), "run:wake" as RunId)).toBe(false);
    expect(queuedWakeCarriesSwarm(projection(undefined), "run:wake" as RunId)).toBe(false);
    expect(queuedWakeCarriesSwarm(projection(["swarm:1"]), "run:plain" as RunId)).toBe(false);
    expect(queuedWakeCarriesSwarm(undefined, "run:wake" as RunId)).toBe(false);
  });
});
