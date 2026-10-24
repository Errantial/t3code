// @effect-diagnostics nodeBuiltinImport:off -- Release-source resolution is the native packaging boundary for immutable browser/provider assets.
import { createHash } from "node:crypto";
import { promises as NodeFs } from "node:fs";
import * as NodePath from "node:path";
import * as NodeUrl from "node:url";

import type { ChatGptBrowserManagedReleaseSource } from "@t3tools/provider-core/server/chatgptBrowserHost";
import { chatGptBrowserManagedTargetForHost } from "@t3tools/provider-core/server/chatgptBrowserPlatform";
import type { ChatGptBrowserManagedTarget } from "@t3tools/provider-core/server/chatgptBrowserProviderV1";

const RESOURCES_ROOT_ENV = "T3CODE_CHATGPT_BROWSER_RESOURCES_DIR";
const PLAYWRIGHT_BROWSERS_ENV = "PLAYWRIGHT_BROWSERS_PATH";
const SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
export const CHATGPT_BROWSER_CHROMIUM_REVISION = 1223 as const;
const CHATGPT_BROWSER_CHROMIUM_VERSION = `chromium-${CHATGPT_BROWSER_CHROMIUM_REVISION}`;

const EXECUTABLE_PATH: Record<ChatGptBrowserManagedTarget, string> = {
  "windows-x64": "chrome-win64/chrome.exe",
  "linux-x64": "chrome-linux64/chrome",
};

export interface NativeChatGptBrowserReleaseSourceOptions {
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
  readonly chromiumDirectory?: string;
  readonly chromiumRevision?: string;
  readonly providerAssetsDirectory?: string;
}

interface ExtensionManifest {
  readonly manifest_version?: unknown;
  readonly version?: unknown;
  readonly background?: unknown;
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await NodeFs.stat(path)).isFile();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    return (await NodeFs.stat(path)).isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function directoryHash(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relative: string): Promise<void> => {
    const entries = (await NodeFs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const childRelative = relative ? `${relative}/${entry.name}` : entry.name;
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${childRelative}\0`);
        await visit(absolute, childRelative);
      } else if (entry.isFile()) {
        hash.update(`f\0${childRelative}\0`);
        hash.update(await NodeFs.readFile(absolute));
        hash.update("\0");
      } else {
        throw new Error(`Unsupported provider asset entry: ${childRelative}`);
      }
    }
  };
  await visit(root, "");
  return hash.digest("hex");
}

function defaultProviderAssetsDirectory(): string {
  return NodeUrl.fileURLToPath(new URL("../../assets/", import.meta.url));
}

function playwrightRoot(
  target: ChatGptBrowserManagedTarget,
  environment: NodeJS.ProcessEnv,
): string | null {
  const explicit = environment[PLAYWRIGHT_BROWSERS_ENV];
  if (explicit && explicit !== "0") return NodePath.resolve(explicit);
  if (target === "windows-x64") {
    const local = environment.LOCALAPPDATA;
    return local ? NodePath.join(local, "ms-playwright") : null;
  }
  const home = environment.HOME;
  return home ? NodePath.join(home, ".cache", "ms-playwright") : null;
}

async function findExecutable(
  target: ChatGptBrowserManagedTarget,
  sourceDirectory: string,
): Promise<string | null> {
  const relative = EXECUTABLE_PATH[target];
  return (await exists(NodePath.join(sourceDirectory, ...relative.split("/")))) ? relative : null;
}

async function discoverPlaywrightChromium(
  target: ChatGptBrowserManagedTarget,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly directory: string; readonly revision: string; readonly executable: string }> {
  const root = playwrightRoot(target, environment);
  if (!root || !(await directoryExists(root)))
    throw new Error("Managed Chromium source is unavailable");
  const directory = NodePath.join(root, CHATGPT_BROWSER_CHROMIUM_VERSION);
  const executable = await findExecutable(target, directory);
  if (!executable)
    throw new Error(
      "Pinned full Playwright Chromium 1223 is unavailable (headless-shell is not accepted)",
    );
  return {
    directory,
    revision: CHATGPT_BROWSER_CHROMIUM_VERSION,
    executable,
  };
}

async function resolveChromium(
  target: ChatGptBrowserManagedTarget,
  options: NativeChatGptBrowserReleaseSourceOptions,
  environment: NodeJS.ProcessEnv,
): Promise<{ readonly directory: string; readonly revision: string; readonly executable: string }> {
  const configuredDirectory = options.chromiumDirectory;
  if (!configuredDirectory) return discoverPlaywrightChromium(target, environment);
  const directory = NodePath.resolve(configuredDirectory);
  if (/headless[_-]shell/i.test(directory))
    throw new Error("chrome-headless-shell cannot be a managed provider browser");
  if (!(await directoryExists(directory)))
    throw new Error("Configured managed Chromium directory does not exist");
  const executable = await findExecutable(target, directory);
  if (!executable) throw new Error("Configured directory is not a supported full Chromium release");
  const revision = options.chromiumRevision ?? CHATGPT_BROWSER_CHROMIUM_VERSION;
  if (revision !== CHATGPT_BROWSER_CHROMIUM_VERSION) {
    throw new Error(`Managed ChatGPT browser must use pinned ${CHATGPT_BROWSER_CHROMIUM_VERSION}`);
  }
  return { directory, revision, executable };
}

export async function resolveNativeChatGptBrowserReleaseSource(
  options: NativeChatGptBrowserReleaseSourceOptions = {},
): Promise<ChatGptBrowserManagedReleaseSource> {
  const environment = options.environment ?? process.env;
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const target = chatGptBrowserManagedTargetForHost(platform, architecture);
  if (!target)
    throw new Error(`Unsupported managed ChatGPT browser host: ${platform}/${architecture}`);

  const configuredResourcesRoot = environment[RESOURCES_ROOT_ENV];
  const siblingResourcesRoot = NodePath.join(NodePath.dirname(process.execPath), "chatgpt-browser");
  const packagedResourcesRoot = configuredResourcesRoot
    ? NodePath.resolve(configuredResourcesRoot)
    : (await directoryExists(NodePath.join(siblingResourcesRoot, "provider"))) &&
        (await directoryExists(
          NodePath.join(siblingResourcesRoot, "chromium", CHATGPT_BROWSER_CHROMIUM_VERSION),
        ))
      ? siblingResourcesRoot
      : null;
  const providerAssetsDirectory = NodePath.resolve(
    options.providerAssetsDirectory ??
      (packagedResourcesRoot
        ? NodePath.join(packagedResourcesRoot, "provider")
        : defaultProviderAssetsDirectory()),
  );
  const extensionDirectory = NodePath.join(providerAssetsDirectory, "extension");
  const manifestPath = NodePath.join(extensionDirectory, "manifest.json");
  let manifest: ExtensionManifest;
  try {
    manifest = JSON.parse(await NodeFs.readFile(manifestPath, "utf8")) as ExtensionManifest;
  } catch (cause) {
    throw new Error("Managed ChatGPT provider extension manifest is unavailable", { cause });
  }
  if (
    manifest.manifest_version !== 3 ||
    typeof manifest.version !== "string" ||
    !SEGMENT.test(manifest.version)
  ) {
    throw new Error("Managed ChatGPT provider extension manifest is invalid");
  }
  const chromium = await resolveChromium(
    target,
    packagedResourcesRoot && !options.chromiumDirectory
      ? {
          ...options,
          chromiumDirectory: NodePath.join(
            packagedResourcesRoot,
            "chromium",
            CHATGPT_BROWSER_CHROMIUM_VERSION,
          ),
          chromiumRevision: CHATGPT_BROWSER_CHROMIUM_VERSION,
        }
      : options,
    environment,
  );
  const providerHash = await directoryHash(extensionDirectory);

  return {
    identity: {
      target,
      browserRevision: chromium.revision,
      providerReleaseVersion: `native-${providerHash.slice(0, 20)}`,
      extensionVersion: manifest.version,
    },
    browserSourceDirectory: chromium.directory,
    providerSourceDirectory: providerAssetsDirectory,
    browserExecutableRelativePath: chromium.executable,
    extensionRelativePath: "extension",
    // Starting Chromium minimized can leave an unpacked MV3 worker asleep until foreground
    // activation. A crashed prior profile can also restore without committing the command-line
    // wake URL. Force a fresh ordinary window, keep it off-screen, and suppress the crash bubble;
    // the document_start wake script then deterministically primes provider-v1 in the background.
    // Preserve the qualified CoS browser's Windows anti-throttling policy as well: an off-screen
    // renderer must keep observing/recording the turn after Send rather than requiring a later
    // restart to recover a response that ChatGPT already completed.
    ...(target === "windows-x64"
      ? {
          browserArgs: [
            "--disable-renderer-backgrounding",
            "--disable-background-timer-throttling",
            "--disable-backgrounding-occluded-windows",
            "--window-position=-10000,-10000",
            "--new-window",
            "--disable-session-crashed-bubble",
          ],
        }
      : {}),
  };
}
