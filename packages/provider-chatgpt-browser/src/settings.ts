/** Shared by the server driver and clients; platform/browser state belongs behind the host port. */
import { makeProviderSettingsSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export const ChatGptBrowserSettings = makeProviderSettingsSchema({
  enabled: Schema.Boolean.pipe(
    Schema.withDecodingDefault(Effect.succeed(false)),
    Schema.annotateKey({ providerSettingsForm: { hidden: true } }),
  ),
});
export type ChatGptBrowserSettings = typeof ChatGptBrowserSettings.Type;
