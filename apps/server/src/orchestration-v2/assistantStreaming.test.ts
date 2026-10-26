import { describe, expect, it } from "vite-plus/test";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeAssistantStreamingFilter, splitBufferedAssistantText } from "./assistantStreaming.ts";

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

it("streams bounded live revisions when the provider has authoritative snapshots", () => {
  const filter = makeAssistantStreamingFilter("paragraph", { preferLiveRevisions: true });
  const event = (text: string) =>
    ({
      type: "turn_item.updated",
      driver: "chatgptBrowser",
      turnItem: {
        id: "turn-item:live-revision",
        type: "assistant_message",
        streaming: true,
        text,
      },
    }) as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>;

  expect(filter(event("0001 live without a paragraph boundary"), 1_000)).toMatchObject({
    turnItem: { text: "0001 live without a paragraph boundary" },
  });
  expect(
    filter(event("0001 live without a paragraph boundary\n0002 still growing"), 1_200),
  ).toBeNull();
  expect(
    filter(event("0001 live without a paragraph boundary\n0002 still growing"), 1_450),
  ).toMatchObject({
    turnItem: { text: "0001 live without a paragraph boundary\n0002 still growing" },
  });
});

it("keeps turn-only mode buffered even for authoritative live revisions", () => {
  const filter = makeAssistantStreamingFilter("turn", { preferLiveRevisions: true });
  expect(
    filter(
      {
        type: "turn_item.updated",
        driver: "chatgptBrowser",
        turnItem: {
          id: "turn-item:turn-only",
          type: "assistant_message",
          streaming: true,
          text: "still hidden until final",
        },
      } as Extract<ProviderAdapter.ProviderAdapterV2Event, { type: "turn_item.updated" }>,
      1_000,
    ),
  ).toBeNull();
});
