import { TextGenerationError, type ServerProvider } from "@t3tools/contracts";
import { CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";
import {
  defaultProviderContinuationIdentity,
  type ProviderDriver,
  type ProviderInstance,
} from "@t3tools/provider-core/server/driver";
import { makeManualOnlyProviderMaintenanceCapabilities } from "@t3tools/provider-core/server/maintenanceResolver";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import type { ProviderTextGeneration } from "@t3tools/provider-core/server/textGeneration";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import { ChatGptBrowserSettings } from "../settings.ts";
import { CHATGPT_BROWSER_DRIVER_KIND, makeChatGptBrowserAdapterV2 } from "./adapter.ts";
import { ChatGptBrowserHost } from "./host.ts";

const decodeSettings = Schema.decodeSync(ChatGptBrowserSettings);
const MAINTENANCE = makeManualOnlyProviderMaintenanceCapabilities({
  provider: CHATGPT_BROWSER_DRIVER_KIND,
  packageName: null,
});

const makeUnsupportedTextGeneration = (): ProviderTextGeneration => {
  const unsupported = (operation: string) =>
    Effect.fail(
      new TextGenerationError({
        operation,
        detail: "ChatGPT Browser does not provide application text generation in provider-v1.",
      }),
    );
  return {
    generateCommitMessage: () => unsupported("generateCommitMessage"),
    generatePrContent: () => unsupported("generatePrContent"),
    generateBranchName: () => unsupported("generateBranchName"),
    generateThreadTitle: () => unsupported("generateThreadTitle"),
    generateReviewGuide: () => unsupported("generateReviewGuide"),
  };
};

export type ChatGptBrowserDriverEnv =
  | ChatGptBrowserHost
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost;

export const ChatGptBrowserDriver: ProviderDriver<ChatGptBrowserSettings, ChatGptBrowserDriverEnv> =
  {
    driverKind: CHATGPT_BROWSER_DRIVER_KIND,
    metadata: {
      displayName: "ChatGPT Browser",
      supportsMultipleInstances: true,
      operationConcurrency: CHATGPT_BROWSER_PROVIDER_OPERATION_CONCURRENCY,
    },
    configSchema: ChatGptBrowserSettings,
    defaultConfig: () => decodeSettings({}),
    create: Effect.fn("ChatGptBrowserDriver.create")(function* ({
      instanceId,
      displayName,
      accentColor,
      enabled,
      config,
    }) {
      const hostPort = yield* ChatGptBrowserHost;
      const providerHost = yield* ProviderHost.ProviderHost;
      const checkedAt = DateTime.formatIso(yield* DateTime.now);
      const continuationIdentity = defaultProviderContinuationIdentity({
        driverKind: CHATGPT_BROWSER_DRIVER_KIND,
        instanceId,
      });
      const effectiveConfig = { ...config, enabled } satisfies ChatGptBrowserSettings;
      const snapshotValue: ServerProvider = {
        instanceId,
        driver: CHATGPT_BROWSER_DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        requiresNewThreadForModelChange: true,
        supportsTextGeneration: false,
        enabled: effectiveConfig.enabled,
        installed: false,
        version: null,
        status: effectiveConfig.enabled ? "warning" : "disabled",
        auth: { status: "unknown" },
        checkedAt,
        ...(effectiveConfig.enabled
          ? { message: "ChatGPT Browser is not ready on this environment." }
          : {}),
        setup: { canAuthenticate: false, canInstall: false },
        models: [
          {
            slug: "default",
            name: "Default",
            isCustom: false,
            isDefault: true,
            capabilities: null,
          },
        ],
        slashCommands: [],
        skills: [],
      };
      const snapshot = {
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSnapshot: Effect.succeed(snapshotValue),
        refresh: Effect.succeed(snapshotValue),
        streamChanges: Stream.empty,
        applyUsageLimits: () => Effect.void,
      } satisfies ProviderInstance["snapshot"];
      const orchestrationAdapter = yield* makeChatGptBrowserAdapterV2({
        instanceId,
        defaultCwd: providerHost.paths.cwd,
        host: hostPort,
      });
      return {
        instanceId,
        driverKind: CHATGPT_BROWSER_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: effectiveConfig.enabled,
        snapshot,
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
  };
