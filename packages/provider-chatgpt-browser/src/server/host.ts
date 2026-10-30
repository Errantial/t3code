import type {
  ChatGptBrowserHostIdentity,
  ChatGptBrowserHostPort,
} from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import { ChatGptBrowserHostError } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

export type ChatGptBrowserAuthenticationStatus = "authenticated" | "unauthenticated" | "unknown";

/** A manual control the user can ask of the tab that belongs to one provider thread. */
export type ChatGptBrowserTabAction = "reveal" | "reload";

export interface ChatGptBrowserTabControlResult {
  /** The exact ChatGPT conversation the tab was found by. */
  readonly conversationId: string;
}

export interface ChatGptBrowserHostStatus {
  readonly identity: ChatGptBrowserHostIdentity;
  readonly authentication: ChatGptBrowserAuthenticationStatus;
  readonly availability: "ready" | "recovering";
}

export interface ChatGptBrowserHostService extends ChatGptBrowserHostPort {
  /** Probes the persistent managed profile, including ChatGPT's own session endpoint. */
  readonly status: Effect.Effect<ChatGptBrowserHostStatus, ChatGptBrowserHostError>;
  /** Opens that same managed profile visibly and resolves only after ChatGPT confirms sign-in. */
  readonly authenticate: Effect.Effect<ChatGptBrowserHostStatus, ChatGptBrowserHostError>;
  /**
   * Brings the tab that belongs to one provider session to the foreground, or force-reloads it.
   * The thread's conversation is resolved from the live operation the session owns, so a session
   * with no open tab fails instead of opening an unrelated one.
   */
  readonly controlTab: (input: {
    readonly providerSessionId: string;
    readonly action: ChatGptBrowserTabAction;
  }) => Effect.Effect<ChatGptBrowserTabControlResult, ChatGptBrowserHostError>;
}

/** Effect DI identity for the T3-owned managed ChatGPT browser lifecycle. */
export class ChatGptBrowserHost extends Context.Service<
  ChatGptBrowserHost,
  ChatGptBrowserHostService
>()("@t3tools/provider-chatgpt-browser/server/host/ChatGptBrowserHost") {}

export const unavailableChatGptBrowserHost: ChatGptBrowserHostService = {
  readiness: Effect.fail(new ChatGptBrowserHostError({ operation: "readiness" })),
  status: Effect.fail(new ChatGptBrowserHostError({ operation: "status" })),
  authenticate: Effect.fail(new ChatGptBrowserHostError({ operation: "authenticate" })),
  open: Effect.fail(new ChatGptBrowserHostError({ operation: "open" })),
  controlTab: () => Effect.fail(new ChatGptBrowserHostError({ operation: "controlling-tab" })),
};

export const layerUnavailableChatGptBrowserHost = Layer.succeed(
  ChatGptBrowserHost,
  unavailableChatGptBrowserHost,
);
