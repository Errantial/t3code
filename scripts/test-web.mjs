#!/usr/bin/env node
/**
 * The browser project needs Playwright Chromium and a POSIX font/layout baseline.
 * Windows runs the unit project; Linux and macOS run both.
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

const repoRoot = NodePath.dirname(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)));
const vpBin = NodePath.join(repoRoot, "node_modules", "vite-plus", "dist", "bin.js");
const args = ["test", "run", "--passWithNoTests", "--project", "unit"];
// oxlint-disable-next-line t3code/no-global-process-runtime -- standalone test launcher before any Effect runtime
if (NodeOS.platform() !== "win32") {
  args.push("--project", "browser");
}
if (!NodeFS.existsSync(vpBin)) {
  throw new Error(`Missing ${vpBin}; run pnpm install first.`);
}
const result = NodeChildProcess.spawnSync(process.execPath, [vpBin, ...args], {
  cwd: NodePath.join(repoRoot, "apps", "web"),
  stdio: "inherit",
});
process.exit(result.status ?? 1);
