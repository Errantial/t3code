import { describe, expect, it } from "@effect/vitest";
import { ProviderInstanceId, type ModelSelection } from "@t3tools/contracts";

import { resolveChatGptBrowserSelection } from "./features.ts";

const instanceId = ProviderInstanceId.make("chatgpt-browser-test");

const selection = (model: string, reasoningEffort?: string): ModelSelection => ({
  instanceId,
  model,
  ...(reasoningEffort === undefined
    ? {}
    : { options: [{ id: "reasoningEffort", value: reasoningEffort }] }),
});

describe("ChatGPT Browser S8 feature selection", () => {
  it("preserves exact requested and selected model/reasoning evidence", () => {
    expect(resolveChatGptBrowserSelection(selection("gpt-6-thinking", "medium"))).toEqual({
      requestedModel: "gpt-6-thinking",
      selectedModel: "gpt-6-thinking",
      requestedReasoningEffort: "medium",
      selectedReasoningEffort: "medium",
    });
    expect(resolveChatGptBrowserSelection(selection("gpt-6", "none"))).toEqual({
      requestedModel: "gpt-6",
      selectedModel: "gpt-6",
      requestedReasoningEffort: "none",
      selectedReasoningEffort: "none",
    });
  });

  it("fails unsupported model and reasoning values instead of rounding", () => {
    expect(() => resolveChatGptBrowserSelection(selection("gpt-6-thinking", "high"))).toThrow(
      "chatgpt_browser_reasoning_unsupported:high",
    );
    expect(() => resolveChatGptBrowserSelection(selection("gpt-5"))).toThrow(
      "chatgpt_browser_model_unsupported:gpt-5",
    );
  });
});
