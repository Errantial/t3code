import {
  ChatGptBrowserHost,
  makeNativeManagedChatGptBrowserHost,
  resolveNativeChatGptBrowserReleaseSource,
  shareChatGptBrowserHost,
} from "@t3tools/provider-chatgpt-browser/server";
import { ChatGptBrowserHostError } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";

import * as ServerConfig from "../config.ts";

/**
 * Production ChatGPT Browser host. T3 owns this lifecycle and all scheduling. The S7 lane exposes
 * no T3 MCP/tool surface yet, so there are no admitted T3 side effects to settle before browser
 * drain. S9 replaces this no-op settlement fence when provider-scoped MCP routing is enabled.
 */
export const layer = Layer.effect(
  ChatGptBrowserHost,
  Effect.gen(function* () {
    const config = yield* ServerConfig.ServerConfig;
    const path = yield* Path.Path;
    let shutdownManagedHost: Effect.Effect<void> = Effect.void;
    yield* Effect.addFinalizer(() => shutdownManagedHost);
    const managed = yield* Effect.cached(
      Effect.gen(function* () {
        const release = yield* Effect.tryPromise({
          try: () => resolveNativeChatGptBrowserReleaseSource(),
          catch: (cause) =>
            new ChatGptBrowserHostError({
              operation: "resolving-native-browser-release",
              cause,
            }),
        });
        const host = yield* makeNativeManagedChatGptBrowserHost({
          rootDirectory: path.join(config.stateDir, "chatgpt-browser"),
          release,
          settlement: { settleBeforeDrain: async () => undefined },
          // A persistent Chromium profile is never implicitly migrated across browser revisions.
          allowBrowserRevisionChange: () => Effect.succeed(false),
        });
        shutdownManagedHost = host.shutdown;
        return shareChatGptBrowserHost(host);
      }),
    );
    return ChatGptBrowserHost.of({
      readiness: managed.pipe(Effect.flatMap((host) => host.readiness)),
      status: managed.pipe(Effect.flatMap((host) => host.status)),
      authenticate: managed.pipe(Effect.flatMap((host) => host.authenticate)),
      controlTab: Effect.fn("ChatGptBrowserHost.controlTab")(function* (input) {
        const host = yield* managed;
        return yield* host.controlTab(input);
      }),
      open: managed.pipe(Effect.flatMap((host) => host.open)),
    });
  }),
);
