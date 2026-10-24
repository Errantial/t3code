import type { ChatGptBrowserHostPort } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import { ChatGptBrowserHostError } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

/** Effect DI identity for the frozen S0 host port. S5/S7 replace the unavailable binding. */
export class ChatGptBrowserHost extends Context.Service<
  ChatGptBrowserHost,
  ChatGptBrowserHostPort
>()("@t3tools/provider-chatgpt-browser/server/host/ChatGptBrowserHost") {}

export const unavailableChatGptBrowserHost: ChatGptBrowserHostPort = {
  open: Effect.fail(new ChatGptBrowserHostError({ operation: "open" })),
};

export const layerUnavailableChatGptBrowserHost = Layer.succeed(
  ChatGptBrowserHost,
  unavailableChatGptBrowserHost,
);
