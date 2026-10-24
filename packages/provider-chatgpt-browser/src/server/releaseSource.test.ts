// @effect-diagnostics nodeBuiltinImport:off -- Release-source tests use isolated real filesystem fixtures.
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, it } from "@effect/vitest";

import {
  CHATGPT_BROWSER_CHROMIUM_REVISION,
  resolveNativeChatGptBrowserReleaseSource,
} from "./releaseSource.ts";

async function fixtureRoot() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "t3-chatgpt-browser-release-"));
  const chromium = path.join(root, `chromium-${CHATGPT_BROWSER_CHROMIUM_REVISION}`);
  const provider = path.join(root, "provider");
  await fs.mkdir(path.join(chromium, "chrome-win64"), { recursive: true });
  await fs.writeFile(path.join(chromium, "chrome-win64", "chrome.exe"), "browser");
  await fs.mkdir(path.join(chromium, "chrome-linux64"), { recursive: true });
  await fs.writeFile(path.join(chromium, "chrome-linux64", "chrome"), "browser-linux");
  await fs.mkdir(path.join(provider, "extension"), { recursive: true });
  await fs.writeFile(
    path.join(provider, "extension", "manifest.json"),
    JSON.stringify({
      manifest_version: 3,
      version: "2.1.39",
      background: { service_worker: "background.js", type: "module" },
    }),
  );
  await fs.writeFile(path.join(provider, "extension", "background.js"), "export {};\n");
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
      await fs.rm(fixture.root, { recursive: true, force: true });
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
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("uses packaged Linux resources ahead of any Playwright cache", async () => {
    const fixture = await fixtureRoot();
    const packaged = path.join(fixture.root, "packaged");
    const packagedProvider = path.join(packaged, "provider");
    const packagedChromium = path.join(packaged, "chromium", "chromium-1223");
    try {
      await fs.cp(fixture.provider, packagedProvider, { recursive: true });
      await fs.cp(fixture.chromium, packagedChromium, { recursive: true });
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
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("does not fall back to Playwright when packaged Linux resources are incomplete", async () => {
    const fixture = await fixtureRoot();
    const packaged = path.join(fixture.root, "packaged-incomplete");
    try {
      await fs.cp(fixture.provider, path.join(packaged, "provider"), { recursive: true });
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
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });

  it("rejects headless-shell even when explicitly configured", async () => {
    const fixture = await fixtureRoot();
    try {
      const headless = path.join(fixture.root, "chromium_headless_shell-1223");
      await fs.mkdir(path.join(headless, "chrome-win64"), { recursive: true });
      await fs.writeFile(path.join(headless, "chrome-win64", "chrome.exe"), "headless");
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
      await fs.rm(fixture.root, { recursive: true, force: true });
    }
  });
});
