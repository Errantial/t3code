// @effect-diagnostics nodeBuiltinImport:off -- Release-source tests use isolated real filesystem fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  CHATGPT_BROWSER_CHROMIUM_REVISION,
  resolveNativeChatGptBrowserReleaseSource,
} from "./releaseSource.ts";

async function fixtureRoot() {
  const root = await NodeFS.promises.mkdtemp(
    NodePath.join(NodeOS.tmpdir(), "t3-chatgpt-browser-release-"),
  );
  const chromium = NodePath.join(root, `chromium-${CHATGPT_BROWSER_CHROMIUM_REVISION}`);
  const provider = NodePath.join(root, "provider");
  await NodeFS.promises.mkdir(NodePath.join(chromium, "chrome-win64"), { recursive: true });
  await NodeFS.promises.writeFile(NodePath.join(chromium, "chrome-win64", "chrome.exe"), "browser");
  await NodeFS.promises.mkdir(NodePath.join(chromium, "chrome-linux64"), { recursive: true });
  await NodeFS.promises.writeFile(
    NodePath.join(chromium, "chrome-linux64", "chrome"),
    "browser-linux",
  );
  await NodeFS.promises.mkdir(NodePath.join(provider, "extension"), { recursive: true });
  await NodeFS.promises.writeFile(
    NodePath.join(provider, "extension", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      version: "2.1.39",
      background: { service_worker: "background.js", type: "module" },
    }),
  );
  await NodeFS.promises.writeFile(
    NodePath.join(provider, "extension", "background.js"),
    "export {};\n",
  );
  return { root, chromium, provider };
}

describe("native ChatGPT browser release source", () => {
  it("accepts only the pinned full Chromium revision and exact Windows executable layout", async () => {
    const fixture = await fixtureRoot();
    try {
      const release = await resolveNativeChatGptBrowserReleaseSource({
        platform: "win32",
        architecture: "x64",
        chromiumDirectory: fixture.chromium,
        chromiumRevision: `chromium-${CHATGPT_BROWSER_CHROMIUM_REVISION}`,
        providerAssetsDirectory: fixture.provider,
        environment: {},
      });
      expect(release.identity.browserRevision).toBe(
        `chromium-${CHATGPT_BROWSER_CHROMIUM_REVISION}`,
      );
      expect(release.browserExecutableRelativePath).toBe("chrome-win64/chrome.exe");
      expect(release.extensionRelativePath).toBe("extension");
      expect(release.browserArgs).toEqual([
        "--disable-renderer-backgrounding",
        "--disable-background-timer-throttling",
        "--disable-backgrounding-occluded-windows",
        "--window-position=-10000,-10000",
        "--new-window",
        "--disable-session-crashed-bubble",
      ]);

      await expect(
        resolveNativeChatGptBrowserReleaseSource({
          platform: "win32",
          architecture: "x64",
          chromiumDirectory: fixture.chromium,
          chromiumRevision: "chromium-9999",
          providerAssetsDirectory: fixture.provider,
          environment: {},
        }),
      ).rejects.toThrow("pinned chromium-1223");
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("accepts the pinned Linux x64 full Chromium layout", async () => {
    const fixture = await fixtureRoot();
    try {
      const release = await resolveNativeChatGptBrowserReleaseSource({
        platform: "linux",
        architecture: "x64",
        chromiumDirectory: fixture.chromium,
        chromiumRevision: `chromium-${CHATGPT_BROWSER_CHROMIUM_REVISION}`,
        providerAssetsDirectory: fixture.provider,
        environment: {},
      });
      expect(release.identity.target).toBe("linux-x64");
      expect(release.browserExecutableRelativePath).toBe("chrome-linux64/chrome");
      expect(release.browserArgs).toBeUndefined();
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses packaged Linux resources ahead of any Playwright cache", async () => {
    const fixture = await fixtureRoot();
    const packaged = NodePath.join(fixture.root, "packaged");
    const packagedProvider = NodePath.join(packaged, "provider");
    const packagedChromium = NodePath.join(packaged, "chromium", "chromium-1223");
    try {
      await NodeFS.promises.cp(fixture.provider, packagedProvider, { recursive: true });
      await NodeFS.promises.cp(fixture.chromium, packagedChromium, { recursive: true });
      const release = await resolveNativeChatGptBrowserReleaseSource({
        platform: "linux",
        architecture: "x64",
        environment: {
          T3CODE_CHATGPT_BROWSER_RESOURCES_DIR: packaged,
          PLAYWRIGHT_BROWSERS_PATH: fixture.root,
        },
      });
      expect(release.browserSourceDirectory).toBe(packagedChromium);
      expect(release.providerSourceDirectory).toBe(packagedProvider);
      expect(release.browserExecutableRelativePath).toBe("chrome-linux64/chrome");
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not fall back to Playwright when packaged Linux resources are incomplete", async () => {
    const fixture = await fixtureRoot();
    const packaged = NodePath.join(fixture.root, "packaged-incomplete");
    try {
      await NodeFS.promises.cp(fixture.provider, NodePath.join(packaged, "provider"), {
        recursive: true,
      });
      await expect(
        resolveNativeChatGptBrowserReleaseSource({
          platform: "linux",
          architecture: "x64",
          environment: {
            T3CODE_CHATGPT_BROWSER_RESOURCES_DIR: packaged,
            PLAYWRIGHT_BROWSERS_PATH: fixture.root,
          },
        }),
      ).rejects.toThrow("Configured managed Chromium directory does not exist");
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("finds the Windows installer payload when a service runs the packaged executable", async () => {
    // A background service runs `T3 Code (Beta).exe` in node mode without the desktop's
    // resources-directory variable; the payload sits in `resources/chatgpt-browser`.
    const fixture = await fixtureRoot();
    const install = NodePath.join(fixture.root, "install");
    const packaged = NodePath.join(install, "resources", "chatgpt-browser");
    const packagedProvider = NodePath.join(packaged, "provider");
    const packagedChromium = NodePath.join(packaged, "chromium", "chromium-1223");
    try {
      await NodeFS.promises.cp(fixture.provider, packagedProvider, { recursive: true });
      await NodeFS.promises.cp(fixture.chromium, packagedChromium, { recursive: true });
      const release = await resolveNativeChatGptBrowserReleaseSource({
        platform: "win32",
        architecture: "x64",
        executablePath: NodePath.join(install, "T3 Code (Beta).exe"),
        environment: {},
      });
      expect(release.browserSourceDirectory).toBe(packagedChromium);
      expect(release.providerSourceDirectory).toBe(packagedProvider);
      expect(release.browserExecutableRelativePath).toBe("chrome-win64/chrome.exe");
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("still reports an unavailable runtime when no packaged payload is beside the executable", async () => {
    const fixture = await fixtureRoot();
    try {
      await expect(
        resolveNativeChatGptBrowserReleaseSource({
          platform: "win32",
          architecture: "x64",
          executablePath: NodePath.join(fixture.root, "missing", "T3 Code (Beta).exe"),
          providerAssetsDirectory: fixture.provider,
          environment: { PLAYWRIGHT_BROWSERS_PATH: NodePath.join(fixture.root, "no-playwright") },
        }),
      ).rejects.toThrow("Managed Chromium source is unavailable");
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects headless-shell even when explicitly configured", async () => {
    const fixture = await fixtureRoot();
    try {
      const headless = NodePath.join(fixture.root, "chromium_headless_shell-1223");
      await NodeFS.promises.mkdir(NodePath.join(headless, "chrome-win64"), { recursive: true });
      await NodeFS.promises.writeFile(
        NodePath.join(headless, "chrome-win64", "chrome.exe"),
        "headless",
      );
      await expect(
        resolveNativeChatGptBrowserReleaseSource({
          platform: "win32",
          architecture: "x64",
          chromiumDirectory: headless,
          providerAssetsDirectory: fixture.provider,
          environment: {},
        }),
      ).rejects.toThrow("chrome-headless-shell");
    } finally {
      await NodeFS.promises.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
