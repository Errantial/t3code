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
