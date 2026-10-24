import { describe, expect, it } from "@effect/vitest";
import { CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";

import { ChatGptBrowserDriver } from "./driver.ts";

describe("ChatGptBrowserDriver", () => {
  it("registers the frozen driver-global operation concurrency policy", () => {
    expect(ChatGptBrowserDriver.metadata.operationConcurrency).toEqual(
      CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
    );
  });

  it("keeps the built-in provider disabled until its managed host is integrated", () => {
    expect(ChatGptBrowserDriver.defaultConfig().enabled).toBe(false);
  });
});
