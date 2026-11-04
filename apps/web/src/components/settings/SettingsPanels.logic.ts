import type {
  BackgroundActivityProfile,
  BackgroundActivitySettings,
  ProviderInstanceConfig,
  PreviewViewportSetting,
  ProviderInstanceId,
  ServerSettings,
  SidebarProjectGroupingMode,
  UnifiedSettings,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import {
  getBackgroundActivityBaseProfile,
  normalizeBackgroundActivitySettings,
  normalizeServerBackgroundActivitySettings,
  resolveServerBackgroundActivitySettings,
} from "@t3tools/shared/backgroundActivitySettings";
import * as Duration from "effect/Duration";
import * as Equal from "effect/Equal";

export function isProjectGroupingEnabled(mode: SidebarProjectGroupingMode): boolean {
  return mode !== "separate";
}

export function projectGroupingModeFromToggle(
  enabled: boolean,
  lastEnabledMode: SidebarProjectGroupingMode = "repository",
): SidebarProjectGroupingMode {
  if (!enabled) return "separate";
  return lastEnabledMode === "repository_path" ? "repository_path" : "repository";
}

const LAST_ENABLED_PROJECT_GROUPING_MODE_KEY = "t3code:last-enabled-project-grouping-mode";

export function readLastEnabledProjectGroupingMode(): SidebarProjectGroupingMode {
  try {
    return localStorage.getItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY) === "repository_path"
      ? "repository_path"
      : "repository";
  } catch {
    return "repository";
  }
}

export function rememberEnabledProjectGroupingMode(mode: SidebarProjectGroupingMode): void {
  if (mode === "separate") return;
  try {
    localStorage.setItem(LAST_ENABLED_PROJECT_GROUPING_MODE_KEY, mode);
  } catch {}
}

export function hasChangedBackgroundActivitySettings(
  settings: Pick<
    UnifiedSettings,
    | "backgroundActivity"
    | "backgroundActivityProfile"
    | "automaticGitFetchInterval"
    | "providerHealthRefreshInterval"
  >,
): boolean {
  return (
    !Equal.equals(settings.backgroundActivity, DEFAULT_UNIFIED_SETTINGS.backgroundActivity) ||
    settings.backgroundActivityProfile !== DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile ||
    !Equal.equals(
      settings.automaticGitFetchInterval,
      DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    ) ||
    !Equal.equals(
      settings.providerHealthRefreshInterval,
      DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    )
  );
}

type TypographySettings = Pick<
  UnifiedSettings,
  | "fontFamilySans"
  | "fontFamilyComposer"
  | "fontFamilyCode"
  | "fontFamilyTerminal"
  | "fontSizeInterface"
  | "fontSizePrompt"
  | "fontSizeCode"
  | "fontSizeTerminal"
>;

export function getChangedTypographySettingLabels(settings: TypographySettings): string[] {
  return [
    ...(settings.fontFamilySans !== DEFAULT_UNIFIED_SETTINGS.fontFamilySans ||
    settings.fontSizeInterface !== DEFAULT_UNIFIED_SETTINGS.fontSizeInterface
      ? ["Interface font"]
      : []),
    ...(settings.fontFamilyComposer !== DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer ||
    settings.fontSizePrompt !== DEFAULT_UNIFIED_SETTINGS.fontSizePrompt
      ? ["Prompt font"]
      : []),
    ...(settings.fontFamilyCode !== DEFAULT_UNIFIED_SETTINGS.fontFamilyCode ||
    settings.fontSizeCode !== DEFAULT_UNIFIED_SETTINGS.fontSizeCode
      ? ["Code font"]
      : []),
    ...(settings.fontFamilyTerminal !== DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal ||
    settings.fontSizeTerminal !== DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal
      ? ["Terminal font"]
      : []),
  ];
}

export type BrowserDefaultSettings = Pick<
  UnifiedSettings,
  | "browserDefaultViewport"
  | "browserDefaultZoomFactor"
  | "browserDefaultAppearance"
  | "browserRecordingFrameRate"
  | "browserRecordingShowKeyPresses"
  | "browserRecordingShowMousePresses"
  | "browserLinkTarget"
  | "browserSearchEngine"
  | "browserCustomSearchUrl"
  | "browserAutoShowFloatingPreview"
  | "pullRequestLinksOpenInApp"
>;

function isSamePreviewViewport(
  left: PreviewViewportSetting,
  right: PreviewViewportSetting,
): boolean {
  if (left._tag !== right._tag) return false;
  if (left._tag === "fill" || right._tag === "fill") return true;
  if (left.width !== right.width || left.height !== right.height) return false;
  return left._tag === "preset" && right._tag === "preset"
    ? left.presetId === right.presetId
    : true;
}

export function getChangedBrowserSettingLabels(settings: BrowserDefaultSettings): string[] {
  return [
    ...(isSamePreviewViewport(
      settings.browserDefaultViewport,
      DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
    )
      ? []
      : ["Browser viewport"]),
    ...(settings.browserDefaultZoomFactor !== DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor
      ? ["Browser zoom"]
      : []),
    ...(settings.browserDefaultAppearance !== DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance
      ? ["Browser appearance"]
      : []),
    ...(settings.browserRecordingFrameRate !== DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate
      ? ["Recording frame rate"]
      : []),
    ...(settings.browserRecordingShowKeyPresses ? ["Recording key presses"] : []),
    ...(settings.browserRecordingShowMousePresses ? ["Recording mouse presses"] : []),
    ...(settings.browserLinkTarget !== DEFAULT_UNIFIED_SETTINGS.browserLinkTarget
      ? ["Open links in"]
      : []),
    ...(settings.browserSearchEngine !== DEFAULT_UNIFIED_SETTINGS.browserSearchEngine ||
    settings.browserCustomSearchUrl !== DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl
      ? ["Search engine"]
      : []),
    ...(settings.browserAutoShowFloatingPreview !==
    DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview
      ? ["Floating preview"]
      : []),
    ...(settings.pullRequestLinksOpenInApp !== DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp
      ? ["Open pull requests in T3 Code"]
      : []),
  ];
}

export function resolveBackgroundActivityProfileOption(
  settings: ServerSettings,
): BackgroundActivityProfile | "advanced" {
  const resolved = resolveServerBackgroundActivitySettings(settings);
  const normalized = normalizeBackgroundActivitySettings({
    schemaVersion: 1,
    profile: "custom",
    baseProfile: resolved.profile,
    overrides: {
      automaticGitFetchInterval: resolved.automaticGitFetchInterval,
      providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
      hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
      hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
      pauseWhenHostLocked: resolved.pauseWhenHostLocked,
      pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
      pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
      pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    },
  });
  return normalized.profile === "custom" ? "advanced" : normalized.profile;
}

export function backgroundActivitySharedPolicySettings(
  settings: ServerSettings,
  profile: BackgroundActivityProfile,
): BackgroundActivitySettings {
  const normalized = normalizeServerBackgroundActivitySettings(settings);
  return {
    schemaVersion: 1,
    profile: "custom",
    baseProfile: profile,
    overrides: normalized.profile === "custom" ? normalized.overrides : {},
  };
}

export function buildProviderInstanceUpdatePatch(input: {
  readonly settings: Pick<ServerSettings, "providerInstances">;
  readonly instanceId: ProviderInstanceId;
  readonly instance: ProviderInstanceConfig;
  readonly textGenerationModelSelection?:
    | ServerSettings["textGenerationModelSelection"]
    | undefined;
}): Partial<UnifiedSettings> {
  return {
    providerInstances: {
      ...input.settings.providerInstances,
      [input.instanceId]: input.instance,
    },
    ...(input.textGenerationModelSelection !== undefined
      ? { textGenerationModelSelection: input.textGenerationModelSelection }
      : {}),
  };
}

export const PROVIDER_HEALTH_INTERVAL_STEP_SECONDS = 30;

type BackgroundActivityOverridePatch = Partial<{
  [K in keyof BackgroundActivitySettings["overrides"]]:
    | BackgroundActivitySettings["overrides"][K]
    | undefined;
}>;

export function durationToSeconds(duration: Duration.Duration): number {
  return Math.round(Duration.toMillis(duration) / 1_000);
}

export function normalizeIntervalSeconds(value: number | null, minimum = 0): number {
  if (value === null || !Number.isFinite(value)) {
    return minimum;
  }
  return Math.max(minimum, Math.round(value));
}

export function backgroundActivityOverrideSettings(
  current: BackgroundActivitySettings,
  resolved: ReturnType<typeof resolveServerBackgroundActivitySettings>,
  overrides: BackgroundActivityOverridePatch,
) {
  const nextOverrides: BackgroundActivityOverridePatch = {
    automaticGitFetchInterval: resolved.automaticGitFetchInterval,
    providerHealthRefreshInterval: resolved.providerHealthRefreshInterval,
    hostPowerMonitorActiveInterval: resolved.hostPowerMonitorActiveInterval,
    hostPowerMonitorIdleInterval: resolved.hostPowerMonitorIdleInterval,
    pauseWhenHostLocked: resolved.pauseWhenHostLocked,
    pauseWhenHostLowPower: resolved.pauseWhenHostLowPower,
    pauseWhenClientLowPower: resolved.pauseWhenClientLowPower,
    pauseWhenOnBattery: resolved.pauseWhenOnBattery,
    ...overrides,
  };
  for (const [key, value] of Object.entries(nextOverrides)) {
    if (value === undefined) {
      delete nextOverrides[key as keyof typeof nextOverrides];
    }
  }
  return {
    backgroundActivity: {
      schemaVersion: 1 as const,
      profile: "custom" as const,
      baseProfile: getBackgroundActivityBaseProfile(current),
      overrides: nextOverrides as BackgroundActivitySettings["overrides"],
    },
  };
}

/** The settings restored by "Restore defaults" on the general settings panel. */
export function restoredUnifiedSettingsPatch(): Partial<UnifiedSettings> {
  return {
    appearanceContrast: DEFAULT_UNIFIED_SETTINGS.appearanceContrast,
    diffColorScheme: DEFAULT_UNIFIED_SETTINGS.diffColorScheme,
    chatWidth: DEFAULT_UNIFIED_SETTINGS.chatWidth,
    effortDisplay: DEFAULT_UNIFIED_SETTINGS.effortDisplay,
    mathRenderingEnabled: DEFAULT_UNIFIED_SETTINGS.mathRenderingEnabled,
    timestampFormat: DEFAULT_UNIFIED_SETTINGS.timestampFormat,
    notificationMode: DEFAULT_UNIFIED_SETTINGS.notificationMode,
    inAppNotificationsEnabled: DEFAULT_UNIFIED_SETTINGS.inAppNotificationsEnabled,
    wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap,
    persistComposerContextStrip: DEFAULT_UNIFIED_SETTINGS.persistComposerContextStrip,
    diffFilesCollapsed: DEFAULT_UNIFIED_SETTINGS.diffFilesCollapsed,
    diffIgnoreWhitespace: DEFAULT_UNIFIED_SETTINGS.diffIgnoreWhitespace,
    diffLayout: DEFAULT_UNIFIED_SETTINGS.diffLayout,
    proactivePanelsEnabled: DEFAULT_UNIFIED_SETTINGS.proactivePanelsEnabled,
    showSkillsInSlashMenu: DEFAULT_UNIFIED_SETTINGS.showSkillsInSlashMenu,
    composerRichTextEnabled: DEFAULT_UNIFIED_SETTINGS.composerRichTextEnabled,
    sendShortcut: DEFAULT_UNIFIED_SETTINGS.sendShortcut,
    followUpBehavior: DEFAULT_UNIFIED_SETTINGS.followUpBehavior,
    contextWindowMeterEnabled: DEFAULT_UNIFIED_SETTINGS.contextWindowMeterEnabled,
    environmentIdentificationMode: DEFAULT_UNIFIED_SETTINGS.environmentIdentificationMode,
    glassOpacity: DEFAULT_UNIFIED_SETTINGS.glassOpacity,
    panelAnimationDurationMs: DEFAULT_UNIFIED_SETTINGS.panelAnimationDurationMs,
    sidebarProjectGroupingMode: DEFAULT_UNIFIED_SETTINGS.sidebarProjectGroupingMode,
    sidebarProjectSortOrder: DEFAULT_UNIFIED_SETTINGS.sidebarProjectSortOrder,
    sidebarWorkingShelfEnabled: DEFAULT_UNIFIED_SETTINGS.sidebarWorkingShelfEnabled,
    sidebarPinnedThreadsOnTop: DEFAULT_UNIFIED_SETTINGS.sidebarPinnedThreadsOnTop,
    sidebarAutoSettleAfterDays: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleAfterDays,
    sidebarAutoSettleKeepPullRequests: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleKeepPullRequests,
    sidebarAutoSettleOnMerge: DEFAULT_UNIFIED_SETTINGS.sidebarAutoSettleOnMerge,
    autoResumeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.autoResumeLimitedThreads,
    snoozeLimitedThreads: DEFAULT_UNIFIED_SETTINGS.snoozeLimitedThreads,
    snoozePresets: DEFAULT_UNIFIED_SETTINGS.snoozePresets,
    responseStreamingMode: DEFAULT_UNIFIED_SETTINGS.responseStreamingMode,
    enableProviderUpdateChecks: DEFAULT_UNIFIED_SETTINGS.enableProviderUpdateChecks,
    continueThreadsAfterServerUpdate: DEFAULT_UNIFIED_SETTINGS.continueThreadsAfterServerUpdate,
    backgroundActivity: DEFAULT_UNIFIED_SETTINGS.backgroundActivity,
    backgroundActivityProfile: DEFAULT_UNIFIED_SETTINGS.backgroundActivityProfile,
    automaticGitFetchInterval: DEFAULT_UNIFIED_SETTINGS.automaticGitFetchInterval,
    providerHealthRefreshInterval: DEFAULT_UNIFIED_SETTINGS.providerHealthRefreshInterval,
    defaultThreadEnvMode: DEFAULT_UNIFIED_SETTINGS.defaultThreadEnvMode,
    newWorktreesStartFromOrigin: DEFAULT_UNIFIED_SETTINGS.newWorktreesStartFromOrigin,
    addProjectBaseDirectory: DEFAULT_UNIFIED_SETTINGS.addProjectBaseDirectory,
    confirmThreadArchive: DEFAULT_UNIFIED_SETTINGS.confirmThreadArchive,
    confirmThreadDelete: DEFAULT_UNIFIED_SETTINGS.confirmThreadDelete,
    confirmThreadUnpin: DEFAULT_UNIFIED_SETTINGS.confirmThreadUnpin,
    confirmQuit: DEFAULT_UNIFIED_SETTINGS.confirmQuit,
    textGenerationModelSelection: DEFAULT_UNIFIED_SETTINGS.textGenerationModelSelection,
    threadTitleInstructions: DEFAULT_UNIFIED_SETTINGS.threadTitleInstructions,
    fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
    fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
    fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
    fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
    fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
    fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
    fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
    fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
    browserDefaultViewport: DEFAULT_UNIFIED_SETTINGS.browserDefaultViewport,
    browserDefaultZoomFactor: DEFAULT_UNIFIED_SETTINGS.browserDefaultZoomFactor,
    browserDefaultAppearance: DEFAULT_UNIFIED_SETTINGS.browserDefaultAppearance,
    browserRecordingFrameRate: DEFAULT_UNIFIED_SETTINGS.browserRecordingFrameRate,
    browserRecordingShowKeyPresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowKeyPresses,
    browserRecordingShowMousePresses: DEFAULT_UNIFIED_SETTINGS.browserRecordingShowMousePresses,
    browserLinkTarget: DEFAULT_UNIFIED_SETTINGS.browserLinkTarget,
    browserSearchEngine: DEFAULT_UNIFIED_SETTINGS.browserSearchEngine,
    browserCustomSearchUrl: DEFAULT_UNIFIED_SETTINGS.browserCustomSearchUrl,
    browserAutoShowFloatingPreview: DEFAULT_UNIFIED_SETTINGS.browserAutoShowFloatingPreview,
    pullRequestLinksOpenInApp: DEFAULT_UNIFIED_SETTINGS.pullRequestLinksOpenInApp,
    enableAgentBrowserAccess: DEFAULT_UNIFIED_SETTINGS.enableAgentBrowserAccess,
  };
}
