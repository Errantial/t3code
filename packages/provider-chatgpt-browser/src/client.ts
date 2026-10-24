import { ProviderDriverKind } from "@t3tools/contracts";
import { defineProviderClient } from "@t3tools/provider-core/client";

import { ChatGptBrowserSettings } from "./settings.ts";

export const chatGptBrowserClient = defineProviderClient({
  driverKind: ProviderDriverKind.make("chatgptBrowser"),
  label: "ChatGPT Browser",
  settingsSchema: ChatGptBrowserSettings,
  badgeLabel: "Beta",
});
