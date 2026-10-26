import { ProviderSetupError, TextGenerationError, type ServerProvider } from "@t3tools/contracts";
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
import { CHATGPT_BROWSER_OBSERVED_MODELS, CHATGPT_BROWSER_REASONING_OPTION } from "./features.ts";
import { ChatGptBrowserHost } from "./host.ts";
import { ChatGptBrowserOperationStore } from "./operationRecovery.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { ProviderDriverError } from "@t3tools/provider-core/server/errors";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import * as Crypto from "effect/Crypto";

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
  | ChatGptBrowserOperationStore
  | IdAllocator.IdAllocatorV2
  | ProviderHost.ProviderHost
  | Crypto.Crypto;

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
      const models = CHATGPT_BROWSER_OBSERVED_MODELS.map(({ model, reasoningEffort }, index) => ({
        slug: model,
        name: model === "gpt-6-thinking" ? "GPT-6 Thinking" : "GPT-6",
        isCustom: false,
        isDefault: index === 0,
        capabilities: {
          optionDescriptors: [
            {
              id: CHATGPT_BROWSER_REASONING_OPTION,
              label: "Reasoning effort",
              type: "select" as const,
              currentValue: reasoningEffort,
              options: [
                {
                  id: reasoningEffort,
                  label: reasoningEffort === "none" ? "None" : "Medium",
                  isDefault: true,
                },
              ],
            },
          ],
        },
      }));
      const makeSnapshot = (input: {
        readonly installed: boolean;
        readonly version: string | null;
        readonly status: ServerProvider["status"];
        readonly auth: ServerProvider["auth"];
        readonly canAuthenticate: boolean;
        readonly checkedAt: string;
        readonly message?: string;
      }): ServerProvider => ({
        instanceId,
        driver: CHATGPT_BROWSER_DRIVER_KIND,
        ...(displayName ? { displayName } : {}),
        ...(accentColor ? { accentColor } : {}),
        continuation: { groupKey: continuationIdentity.continuationKey },
        requiresNewThreadForModelChange: true,
        supportsTextGeneration: false,
        enabled: effectiveConfig.enabled,
        installed: input.installed,
        version: input.version,
        status: effectiveConfig.enabled ? input.status : "disabled",
        auth: input.auth,
        checkedAt: input.checkedAt,
        ...(input.message ? { message: input.message } : {}),
        setup: { canAuthenticate: input.canAuthenticate, canInstall: false },
        models,
        slashCommands: [],
        skills: [],
      });
      const checkProvider = Effect.gen(function* () {
        const checkedAt = DateTime.formatIso(yield* DateTime.now);
        if (!effectiveConfig.enabled) {
          return makeSnapshot({
            installed: true,
            version: null,
            status: "disabled",
            auth: { status: "unknown", canLogout: false },
            canAuthenticate: false,
            checkedAt,
          });
        }
        return yield* hostPort.status.pipe(
          Effect.match({
            onFailure: (cause) =>
              makeSnapshot({
                // Once release-source resolution succeeds, failures are launch/readiness failures,
                // not a missing installation. Keep those distinct so the UI does not say "Not found".
                installed: cause.operation !== "resolving-native-browser-release",
                version: null,
                status: "error",
                auth: { status: "unknown", canLogout: false },
                canAuthenticate: cause.operation !== "resolving-native-browser-release",
                checkedAt,
                message:
                  cause.operation === "resolving-native-browser-release"
                    ? "The bundled ChatGPT Browser runtime could not be resolved."
                    : `ChatGPT Browser failed its managed runtime readiness check (${cause.operation}).`,
              }),
            onSuccess: ({ identity, authentication, availability }) => {
              const authenticated = authentication === "authenticated";
              const unauthenticated = authentication === "unauthenticated";
              const recovering = availability === "recovering";
              return makeSnapshot({
                installed: true,
                version: identity.extensionVersion,
                status: authenticated && !recovering ? "ready" : "warning",
                auth: { status: authentication, canLogout: false },
                canAuthenticate: true,
                checkedAt,
                ...(recovering
                  ? {
                      message:
                        "ChatGPT Browser is reconnecting to the managed extension. ChatGPT may still be working.",
                    }
                  : !authenticated
                    ? {
                        message: unauthenticated
                          ? "Sign in to ChatGPT in the managed ChatGPT Browser profile."
                          : "ChatGPT Browser is available, but T3 could not verify the ChatGPT sign-in.",
                      }
                    : {}),
              });
            },
          }),
        );
      });
      const snapshot = yield* makeManagedServerProvider({
        resolveMaintenance: () => Effect.succeed(MAINTENANCE),
        getSettings: Effect.succeed(effectiveConfig),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () =>
          Effect.succeed(
            makeSnapshot({
              installed: true,
              version: null,
              status: "warning",
              auth: { status: "unknown", canLogout: false },
              canAuthenticate: true,
              checkedAt,
              ...(effectiveConfig.enabled
                ? { message: "Checking the bundled ChatGPT Browser runtime." }
                : {}),
            }),
          ),
        checkProvider,
        // Preparing the bundled browser performs disposable validation on first use. Do it on
        // startup/manual refresh, not on a periodic background timer.
        refreshInterval: "1 hour",
        refreshOnInterval: false,
      }).pipe(
        Effect.mapError(
          (cause) =>
            new ProviderDriverError({
              driver: CHATGPT_BROWSER_DRIVER_KIND,
              instanceId,
              detail: "Failed to initialize ChatGPT Browser provider status.",
              cause,
            }),
        ),
      );
      const auth = yield* ProviderAuthFlow.make({
        instanceId,
        credentialBinding: { owner: "provider", key: "chatgpt-browser-managed-profile" },
        methods: Effect.succeed([
          {
            id: "managed-browser",
            name: "Managed ChatGPT Browser",
            description: "Sign in using T3's isolated managed ChatGPT Browser profile.",
            type: "agent",
          },
        ]),
        defaultMethodId: "managed-browser",
        authenticate: (_methodId, context) =>
          Effect.gen(function* () {
            yield* context.waiting("Finish signing in in the managed ChatGPT Browser window.");
            yield* hostPort.authenticate.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSetupError({
                    instanceId,
                    operation: "start",
                    detail: "Could not complete ChatGPT sign-in in the managed browser.",
                    cause,
                  }),
              ),
            );
            yield* context.verifying;
            const refreshed = yield* snapshot.refresh;
            if (refreshed.auth.status !== "authenticated") {
              return yield* new ProviderSetupError({
                instanceId,
                operation: "start",
                detail:
                  "ChatGPT sign-in finished, but T3 could not verify the managed browser session.",
              });
            }
          }),
        logout: Effect.fail(
          new ProviderSetupError({
            instanceId,
            operation: "logout",
            detail: "Sign out from ChatGPT inside the managed browser profile.",
          }),
        ),
      });
      const orchestrationAdapter = yield* makeChatGptBrowserAdapterV2({
        instanceId,
        defaultCwd: providerHost.paths.cwd,
        host: hostPort,
        resolveAttachmentPath: providerHost.resolveAttachmentPath,
      });
      return {
        instanceId,
        driverKind: CHATGPT_BROWSER_DRIVER_KIND,
        continuationIdentity,
        displayName,
        accentColor,
        enabled: effectiveConfig.enabled,
        auth,
        snapshot,
        orchestrationAdapter,
        textGeneration: makeUnsupportedTextGeneration(),
      } satisfies ProviderInstance;
    }),
  };
