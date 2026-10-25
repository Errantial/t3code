// @effect-diagnostics nodeBuiltinImport:off - Platform tests use real temp files while process and
// Linux host probes stay deterministic behind the platform runtime seam.
import * as NodeChildProcess from "node:child_process";
import { promises as NodeFs } from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  chatGptBrowserManagedTargetForHost,
  makeChatGptBrowserPlatformForHost,
  makeLinuxChatGptBrowserPlatform,
  makeWindowsChatGptBrowserPlatform,
  type ChatGptBrowserPlatformRuntime,
} from "./chatgptBrowserPlatform.ts";

interface RuntimeFixture {
  readonly runtime: ChatGptBrowserPlatformRuntime;
  readonly commands: Array<{ readonly command: string; readonly args: ReadonlyArray<string> }>;
  readonly launches: Array<{
    readonly executablePath: string;
    readonly args: ReadonlyArray<string>;
    readonly detached: boolean;
    readonly visible: boolean;
  }>;
  readonly signals: Array<{ readonly pid: number; readonly signal: NodeJS.Signals | 0 }>;
}

const ALL_LINUX_LIBRARIES = [
  "libnss3.so",
  "libnspr4.so",
  "libglib-2.0.so.0",
  "libatk-1.0.so.0",
  "libatk-bridge-2.0.so.0",
  "libatspi.so.0",
  "libdbus-1.so.3",
  "libX11.so.6",
  "libxcb.so.1",
  "libXcomposite.so.1",
  "libXdamage.so.1",
  "libXext.so.6",
  "libXfixes.so.3",
  "libXrandr.so.2",
  "libxkbcommon.so.0",
  "libgbm.so.1",
  "libdrm.so.2",
  "libcups.so.2",
  "libpango-1.0.so.0",
  "libcairo.so.2",
  "libasound.so.2",
  "libexpat.so.1",
] as const;

const makeRuntime = (input?: {
  readonly files?: Readonly<Record<string, string>>;
  readonly missingLibraries?: ReadonlyArray<string>;
  readonly userId?: number;
  readonly windowsCloseExits?: boolean;
}): RuntimeFixture => {
  const commands: RuntimeFixture["commands"] = [];
  const launches: RuntimeFixture["launches"] = [];
  const signals: RuntimeFixture["signals"] = [];
  let running = true;
  let resolveExit: (() => void) | undefined;
  const wait = new Promise<void>((resolve) => {
    resolveExit = resolve;
  });
  const availableLibraries = ALL_LINUX_LIBRARIES.filter(
    (library) => !input?.missingLibraries?.includes(library),
  );
  const runtime: ChatGptBrowserPlatformRuntime = {
    spawnBrowser: async (launch) => {
      launches.push(launch);
      running = true;
      return { pid: 4242, wait, isRunning: () => running };
    },
    runCommand: async (command, args) => {
      commands.push({ command, args });
      if (command === "ldconfig") {
        return {
          exitCode: 0,
          stdout: availableLibraries
            .map((library) => `\t${library} (libc6,x86-64) => /lib/${library}`)
            .join("\n"),
          stderr: "",
        };
      }
      if (command === "fc-match") {
        return { exitCode: 0, stdout: "DejaVu Sans\n", stderr: "" };
      }
      if (command.toLowerCase().endsWith("powershell.exe") && input?.windowsCloseExits === true) {
        const script = args.at(-1) ?? "";
        if (script.includes("T3ManagedBrowserWindow")) {
          running = false;
          resolveExit?.();
        }
      }
      if (command === "taskkill.exe") {
        running = false;
        resolveExit?.();
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    },
    readTextFile: async (path) => input?.files?.[path] ?? null,
    userId: () => input?.userId ?? 1000,
    signalPosixProcessGroup: (pid, signal) => {
      signals.push({ pid, signal });
      if (signal === "SIGTERM" || signal === "SIGKILL") {
        running = false;
        resolveExit?.();
        return true;
      }
      return running;
    },
    sleep: async () => undefined,
  };
  return { runtime, commands, launches, signals };
};

const withTempRoot = <A, E>(use: (root: string) => Effect.Effect<A, E>) =>
  Effect.acquireUseRelease(
    Effect.tryPromise(() => NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-browser-platform-"))),
    use,
    (root) => Effect.promise(() => NodeFs.rm(root, { recursive: true, force: true })),
  );

describe("ChatGPT browser managed target", () => {
  it("maps only the migration-supported x64 targets", () => {
    expect(chatGptBrowserManagedTargetForHost("win32", "x64")).toBe("windows-x64");
    expect(chatGptBrowserManagedTargetForHost("linux", "x64")).toBe("linux-x64");
    expect(chatGptBrowserManagedTargetForHost("darwin", "x64")).toBeNull();
    expect(chatGptBrowserManagedTargetForHost("linux", "arm64")).toBeNull();
    expect(chatGptBrowserManagedTargetForHost("win32", "arm64")).toBeNull();
  });

  it.effect("fails closed for unsupported hosts", () =>
    Effect.gen(function* () {
      const error = yield* makeChatGptBrowserPlatformForHost({
        rootDirectory: "/tmp/t3",
        platform: "darwin",
        architecture: "x64",
      }).pipe(Effect.flip);
      expect(error.operation).toBe("resolving-managed-browser-target");
    }),
  );
});

describe("Windows ChatGPT browser platform", () => {
  it.effect("uses deterministic managed paths and principal-only secret operations", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fixture = makeRuntime();
        const platform = makeWindowsChatGptBrowserPlatform({
          rootDirectory: root,
          runtime: fixture.runtime,
        });
        const paths = yield* platform.paths;
        expect(paths.profileDirectory).toBe(
          NodePath.win32.join(NodePath.win32.resolve(root), "profile"),
        );
        expect(paths.extensionRoot).toBe(
          NodePath.win32.join(NodePath.win32.resolve(root), "extension"),
        );

        const first = new TextEncoder().encode("first");
        const second = new TextEncoder().encode("second");
        yield* platform.writeSecret({ key: "browser-pairing", value: first });
        expect(new TextDecoder().decode((yield* platform.readSecret("browser-pairing"))!)).toBe(
          "first",
        );
        yield* platform.writeSecret({ key: "browser-pairing", value: second });
        expect(new TextDecoder().decode((yield* platform.readSecret("browser-pairing"))!)).toBe(
          "second",
        );
        yield* platform.deleteSecret("browser-pairing");
        expect(yield* platform.readSecret("browser-pairing")).toBeNull();

        const powershellCalls = fixture.commands.filter((entry) =>
          entry.command.toLowerCase().endsWith("powershell.exe"),
        );
        expect(powershellCalls.length).toBeGreaterThanOrEqual(3);
        expect(
          powershellCalls.some((entry) => entry.args.at(-1)?.includes("$kind = 'directory'")),
        ).toBe(true);
        expect(
          powershellCalls.filter((entry) => entry.args.at(-1)?.includes("$kind = 'file'")),
        ).toHaveLength(2);
      }),
    ),
  );

  it.effect("rejects secret path traversal", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fixture = makeRuntime();
        const platform = makeWindowsChatGptBrowserPlatform({
          rootDirectory: root,
          runtime: fixture.runtime,
        });
        const error = yield* platform.readSecret("../escape").pipe(Effect.flip);
        expect(error.operation).toBe("validating-browser-secret-key");
      }),
    ),
  );

  it.effect.skipIf(process.platform !== "win32")(
    "applies a non-inherited current-principal-only ACL to secret files",
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const platform = makeWindowsChatGptBrowserPlatform({ rootDirectory: root });
          yield* platform.writeSecret({
            key: "browser-pairing",
            value: new TextEncoder().encode("secret"),
          });
          const secretPath = NodePath.join(root, "secrets", "browser-pairing.bin");
          const encodedSecretPath = Buffer.from(secretPath, "utf8").toString("base64");
          const json = yield* Effect.tryPromise(
            () =>
              new Promise<string>((resolve, reject) => {
                const script = String.raw`
$path = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedSecretPath}'))
$acl = Get-Acl -LiteralPath $path
$result = [pscustomobject]@{
  Protected = $acl.AreAccessRulesProtected
  Rules = @($acl.Access | ForEach-Object {
    [pscustomobject]@{
      Inherited = $_.IsInherited
      Type = $_.AccessControlType.ToString()
      Rights = $_.FileSystemRights.ToString()
    }
  })
}
$result | ConvertTo-Json -Depth 4 -Compress
`;
                NodeChildProcess.execFile(
                  "powershell.exe",
                  ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
                  { encoding: "utf8", windowsHide: true },
                  (error, stdout) => (error === null ? resolve(stdout) : reject(error)),
                );
              }),
          );
          const acl = JSON.parse(json) as {
            readonly Protected: boolean;
            readonly Rules:
              | { readonly Inherited: boolean; readonly Type: string; readonly Rights: string }
              | ReadonlyArray<{
                  readonly Inherited: boolean;
                  readonly Type: string;
                  readonly Rights: string;
                }>;
          };
          const rules = Array.isArray(acl.Rules) ? acl.Rules : [acl.Rules];
          expect(acl.Protected).toBe(true);
          expect(rules).toHaveLength(1);
          expect(rules[0]).toMatchObject({ Inherited: false, Type: "Allow" });
          expect(rules[0]!.Rights).toContain("FullControl");
        }),
      ),
  );

  it.effect.skipIf(process.platform !== "win32")(
    "reopens already-secured secret storage from a fresh platform instance",
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const first = makeWindowsChatGptBrowserPlatform({ rootDirectory: root });
          yield* first.writeSecret({
            key: "browser-pairing",
            value: new TextEncoder().encode("first"),
          });

          const reopened = makeWindowsChatGptBrowserPlatform({ rootDirectory: root });
          expect(new TextDecoder().decode((yield* reopened.readSecret("browser-pairing"))!)).toBe(
            "first",
          );
          yield* reopened.writeSecret({
            key: "browser-pairing",
            value: new TextEncoder().encode("second"),
          });
          expect(new TextDecoder().decode((yield* reopened.readSecret("browser-pairing"))!)).toBe(
            "second",
          );
        }),
      ),
  );

  it.effect(
    "launches the dedicated profile and gracefully closes only the captured browser pid",
    () =>
      withTempRoot((root) =>
        Effect.gen(function* () {
          const fixture = makeRuntime({ windowsCloseExits: true });
          const platform = makeWindowsChatGptBrowserPlatform({
            rootDirectory: root,
            runtime: fixture.runtime,
          });
          const handle = yield* platform.launchBrowser({
            executablePath: NodePath.win32.join(root, "browser", "chrome.exe"),
            profileDirectory: NodePath.win32.join(root, "profile"),
            extensionRoot: NodePath.win32.join(root, "extension"),
            args: ["--headless=new"],
          });
          expect(fixture.launches).toEqual([
            expect.objectContaining({
              detached: false,
              visible: false,
              args: expect.arrayContaining([
                `--user-data-dir=${NodePath.win32.join(root, "profile")}`,
                `--load-extension=${NodePath.win32.join(root, "extension")}`,
                "--headless=new",
              ]),
            }),
          ]);
          expect(fixture.launches[0]!.args).not.toContain("--no-sandbox");
          yield* platform.stopBrowser(handle);
          const closeCommand = fixture.commands.find(
            (entry) =>
              entry.command.toLowerCase().endsWith("powershell.exe") &&
              entry.args.at(-1)?.includes("T3ManagedBrowserWindow"),
          );
          expect(closeCommand?.args.at(-1)).toContain("$targetPid = 4242");
          expect(fixture.commands.some((entry) => entry.command === "taskkill.exe")).toBe(false);
        }),
      ),
  );

  it.effect("forces only the captured browser tree when graceful close does not exit", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fixture = makeRuntime();
        const platform = makeWindowsChatGptBrowserPlatform({
          rootDirectory: root,
          runtime: fixture.runtime,
        });
        const handle = yield* platform.launchBrowser({
          executablePath: NodePath.win32.join(root, "browser", "chrome.exe"),
          profileDirectory: NodePath.win32.join(root, "profile"),
          extensionRoot: NodePath.win32.join(root, "extension"),
          args: [],
        });

        yield* platform.stopBrowser(handle);

        expect(
          fixture.commands
            .filter((entry) => entry.command === "taskkill.exe")
            .map((entry) => entry.args),
        ).toEqual([["/PID", "4242", "/T", "/F"]]);
      }),
    ),
  );

  it.effect("refuses sandbox-disabling and managed-path overrides", () =>
    withTempRoot((root) =>
      Effect.gen(function* () {
        const fixture = makeRuntime();
        const platform = makeWindowsChatGptBrowserPlatform({
          rootDirectory: root,
          runtime: fixture.runtime,
        });
        for (const reserved of [
          "--no-sandbox",
          "--disable-setuid-sandbox",
          "--disable-seccomp-filter-sandbox",
          "--disable-namespace-sandbox",
          "--disable-gpu-sandbox",
          "--user-data-dir=elsewhere",
          "--load-extension=elsewhere",
          "--disable-extensions-except=elsewhere",
        ]) {
          const error = yield* platform
            .launchBrowser({
              executablePath: "chrome.exe",
              profileDirectory: "profile",
              extensionRoot: "extension",
              args: [reserved],
            })
            .pipe(Effect.flip);
          expect(error.operation).toBe("validating-managed-browser-arguments");
        }
        expect(fixture.launches).toHaveLength(0);
      }),
    ),
  );
});

describe("Linux x64 ChatGPT browser platform", () => {
  it.effect("uses POSIX paths and reports no issues for a sandbox-capable Ubuntu-shaped host", () =>
    Effect.gen(function* () {
      const fixture = makeRuntime({
        files: {
          "/proc/sys/kernel/unprivileged_userns_clone": "1\n",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "0\n",
        },
      });
      const platform = makeLinuxChatGptBrowserPlatform({
        rootDirectory: "/var/lib/t3/userdata/chatgpt-browser",
        runtime: fixture.runtime,
      });
      const paths = yield* platform.paths;
      expect(paths).toEqual({
        providerVersionsDirectory: "/var/lib/t3/userdata/chatgpt-browser/provider-versions",
        browserVersionsDirectory: "/var/lib/t3/userdata/chatgpt-browser/browser-versions",
        profileDirectory: "/var/lib/t3/userdata/chatgpt-browser/profile",
        extensionRoot: "/var/lib/t3/userdata/chatgpt-browser/extension",
        activeProviderPointer: "/var/lib/t3/userdata/chatgpt-browser/state/active-provider.json",
        secretsDirectory: "/var/lib/t3/userdata/chatgpt-browser/secrets",
      });
      expect(yield* platform.checkPrerequisites).toEqual([]);
    }),
  );

  it.effect("returns actionable library, font, userns and AppArmor diagnostics", () =>
    Effect.gen(function* () {
      const fixture = makeRuntime({
        userId: 0,
        missingLibraries: ["libnss3.so", "libgbm.so.1"],
        files: {
          "/proc/sys/kernel/unprivileged_userns_clone": "0\n",
          "/proc/sys/kernel/apparmor_restrict_unprivileged_userns": "1\n",
          "/sys/kernel/security/apparmor/profiles": "other-profile (enforce)\n",
        },
      });
      const runtime: ChatGptBrowserPlatformRuntime = {
        ...fixture.runtime,
        runCommand: async (command, args) => {
          const result = await fixture.runtime.runCommand(command, args);
          return command === "fc-match" ? { exitCode: 1, stdout: "", stderr: "missing" } : result;
        },
      };
      const platform = makeLinuxChatGptBrowserPlatform({ rootDirectory: "/tmp/t3", runtime });
      const issues = yield* platform.checkPrerequisites;
      expect(issues.map((issue) => issue.code)).toEqual([
        "linux-browser-root-user",
        "linux-browser-libraries-missing",
        "linux-browser-fonts-missing",
        "linux-browser-userns-disabled",
        "linux-browser-apparmor-userns",
      ]);
      expect(
        issues.find((issue) => issue.code === "linux-browser-libraries-missing")?.detail,
      ).toContain("libnss3.so, libgbm.so.1");
      expect(
        issues.find((issue) => issue.code === "linux-browser-apparmor-userns")?.detail,
      ).toContain("do not disable the browser sandbox");
    }),
  );

  it.effect("launches a detached process group without disabling the sandbox", () =>
    Effect.gen(function* () {
      const fixture = makeRuntime();
      const platform = makeLinuxChatGptBrowserPlatform({
        rootDirectory: "/tmp/t3",
        runtime: fixture.runtime,
      });
      const handle = yield* platform.launchBrowser({
        executablePath: "/tmp/t3/browser/chrome",
        profileDirectory: "/tmp/t3/profile",
        extensionRoot: "/tmp/t3/extension",
        args: ["--headless=new"],
      });
      expect(fixture.launches[0]).toMatchObject({ detached: true });
      expect(fixture.launches[0]?.visible).toBe(false);
      expect(fixture.launches[0]!.args).not.toContain("--no-sandbox");
      yield* platform.stopBrowser(handle);
      expect(fixture.signals).toContainEqual({ pid: 4242, signal: "SIGTERM" });
    }),
  );
});
