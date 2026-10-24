// @effect-diagnostics nodeBuiltinImport:off - The managed-browser platform boundary intentionally
// owns native filesystem durability, process launch/containment and host prerequisite probes.
import * as NodeChildProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { promises as NodeFs } from "node:fs";
import * as NodePath from "node:path";
import { setTimeout as sleep } from "node:timers/promises";

import * as Effect from "effect/Effect";

import {
  ChatGptBrowserHostError,
  type ChatGptBrowserManagedTarget,
  type ChatGptBrowserPlatformPaths,
  type ChatGptBrowserPlatformPort,
  type ChatGptBrowserProcessHandle,
} from "./chatgptBrowserProviderV1.ts";

const SECRET_KEY = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WINDOWS_RENAME_RETRY_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_RENAME_RETRY_DELAYS_MS = [0, 10, 25, 50, 100, 200] as const;
const BROWSER_STOP_GRACE_MS = 2_000;
const SANDBOX_BYPASS_FLAGS = new Set([
  "--no-sandbox",
  "--disable-setuid-sandbox",
  "--disable-seccomp-filter-sandbox",
  "--disable-namespace-sandbox",
  "--disable-gpu-sandbox",
]);

const LINUX_APPARMOR_USERNS_RESTRICTION = "/proc/sys/kernel/apparmor_restrict_unprivileged_userns";
const LINUX_UNPRIVILEGED_USERNS = "/proc/sys/kernel/unprivileged_userns_clone";
const LINUX_APPARMOR_PROFILES = "/sys/kernel/security/apparmor/profiles";
const LINUX_APPARMOR_PROFILE_NAME = "t3-chatgpt-browser";

const LINUX_REQUIRED_LIBRARY_SONAMES = [
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

interface PlatformCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

interface SpawnedBrowserProcess {
  readonly pid: number;
  readonly wait: Promise<void>;
  readonly isRunning: () => boolean;
}

interface SpawnBrowserInput {
  readonly executablePath: string;
  readonly args: ReadonlyArray<string>;
  readonly detached: boolean;
  readonly environment: NodeJS.ProcessEnv;
}

/** @internal Exported only so the platform boundary can be tested without launching a real browser. */
export interface ChatGptBrowserPlatformRuntime {
  readonly spawnBrowser: (input: SpawnBrowserInput) => Promise<SpawnedBrowserProcess>;
  readonly runCommand: (
    command: string,
    args: ReadonlyArray<string>,
  ) => Promise<PlatformCommandResult>;
  readonly readTextFile: (path: string) => Promise<string | null>;
  readonly userId: () => number | undefined;
  readonly signalPosixProcessGroup: (pid: number, signal: NodeJS.Signals | 0) => boolean;
  readonly sleep: (milliseconds: number) => Promise<void>;
}

interface PlatformAdapterOptions {
  readonly rootDirectory: string;
  readonly environment?: NodeJS.ProcessEnv;
  /** @internal Test seam; production callers use the native runtime. */
  readonly runtime?: ChatGptBrowserPlatformRuntime;
}

export interface ChatGptBrowserHostPlatformOptions extends PlatformAdapterOptions {
  readonly platform?: NodeJS.Platform;
  readonly architecture?: NodeJS.Architecture;
}

const hostError = (operation: string, cause?: unknown) =>
  new ChatGptBrowserHostError({ operation, ...(cause === undefined ? {} : { cause }) });

const tryPlatform = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, ChatGptBrowserHostError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => hostError(operation, cause),
  });

function commandResult(
  command: string,
  args: ReadonlyArray<string>,
  environment: NodeJS.ProcessEnv,
): Promise<PlatformCommandResult> {
  return new Promise((resolve, reject) => {
    NodeChildProcess.execFile(
      command,
      [...args],
      {
        encoding: "utf8",
        env: environment,
        windowsHide: true,
        maxBuffer: 2 * 1024 * 1024,
        timeout: 5_000,
      },
      (error, stdout, stderr) => {
        if (error !== null && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          exitCode: typeof error?.code === "number" ? error.code : 0,
          stdout,
          stderr,
        });
      },
    );
  });
}

function spawnBrowser(input: SpawnBrowserInput): Promise<SpawnedBrowserProcess> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(input.executablePath, [...input.args], {
      env: input.environment,
      detached: input.detached,
      shell: false,
      windowsHide: true,
      stdio: "ignore",
    });
    let settled = false;
    const wait = new Promise<void>((waitResolve) => child.once("exit", () => waitResolve()));
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      reject(cause);
    });
    child.once("spawn", () => {
      if (settled) return;
      settled = true;
      if (child.pid === undefined) {
        reject(new Error("Browser process started without a pid"));
        return;
      }
      resolve({
        pid: child.pid,
        wait,
        isRunning: () => child.exitCode === null && child.signalCode === null,
      });
    });
  });
}

const nativeRuntime = (environment: NodeJS.ProcessEnv): ChatGptBrowserPlatformRuntime => ({
  spawnBrowser,
  runCommand: (command, args) => commandResult(command, args, environment),
  readTextFile: async (path) => {
    try {
      return await NodeFs.readFile(path, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  },
  userId: () => process.getuid?.(),
  signalPosixProcessGroup: (pid, signal) => {
    try {
      process.kill(-pid, signal);
      return true;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ESRCH") return false;
      throw cause;
    }
  },
  sleep: (milliseconds) => sleep(milliseconds),
});

export function chatGptBrowserManagedTargetForHost(
  platform: NodeJS.Platform,
  architecture: NodeJS.Architecture,
): ChatGptBrowserManagedTarget | null {
  if (architecture !== "x64") return null;
  if (platform === "win32") return "windows-x64";
  if (platform === "linux") return "linux-x64";
  return null;
}

function platformPaths(
  target: ChatGptBrowserManagedTarget,
  rootDirectory: string,
): ChatGptBrowserPlatformPaths & { readonly secretsDirectory: string } {
  const path = target === "windows-x64" ? NodePath.win32 : NodePath.posix;
  const root = path.resolve(rootDirectory);
  return {
    providerVersionsDirectory: path.join(root, "provider-versions"),
    browserVersionsDirectory: path.join(root, "browser-versions"),
    profileDirectory: path.join(root, "profile"),
    extensionRoot: path.join(root, "extension"),
    activeProviderPointer: path.join(root, "state", "active-provider.json"),
    secretsDirectory: path.join(root, "secrets"),
  };
}

function validateSecretKey(key: string): Effect.Effect<string, ChatGptBrowserHostError> {
  return SECRET_KEY.test(key)
    ? Effect.succeed(key)
    : Effect.fail(hostError("validating-browser-secret-key"));
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await NodeFs.open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function renameWithWindowsSharingRetries(
  source: string,
  destination: string,
  runtime: ChatGptBrowserPlatformRuntime,
): Promise<void> {
  let lastCause: unknown;
  for (const delay of WINDOWS_RENAME_RETRY_DELAYS_MS) {
    if (delay > 0) await runtime.sleep(delay);
    try {
      await NodeFs.rename(source, destination);
      return;
    } catch (cause) {
      lastCause = cause;
      if (!WINDOWS_RENAME_RETRY_CODES.has((cause as NodeJS.ErrnoException).code ?? "")) throw cause;
    }
  }
  throw lastCause;
}

async function replaceFileAtomically(input: {
  readonly target: ChatGptBrowserManagedTarget;
  readonly path: string;
  readonly contents: Uint8Array;
  readonly runtime: ChatGptBrowserPlatformRuntime;
}): Promise<void> {
  const path = input.target === "windows-x64" ? NodePath.win32 : NodePath.posix;
  const directory = path.dirname(input.path);
  const temporary = path.join(directory, `.${path.basename(input.path)}.next-${randomUUID()}`);
  let directoryExisted = true;
  try {
    directoryExisted = (await NodeFs.stat(directory)).isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    directoryExisted = false;
  }
  await NodeFs.mkdir(directory, { recursive: true });
  if (input.target === "linux-x64" && !directoryExisted) {
    await syncDirectory(path.dirname(directory));
  }
  try {
    const file = await NodeFs.open(temporary, "wx", 0o600);
    try {
      await file.writeFile(input.contents);
      await file.sync();
    } finally {
      await file.close();
    }
    await NodeFs.chmod(temporary, 0o600);
    if (input.target === "windows-x64") {
      await renameWithWindowsSharingRetries(temporary, input.path, input.runtime);
    } else {
      await NodeFs.rename(temporary, input.path);
      await syncDirectory(directory);
    }
  } finally {
    await NodeFs.rm(temporary, { force: true }).catch(() => undefined);
  }
}

const WINDOWS_ACL_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$targetPath = __TARGET_PATH__
$kind = __TARGET_KIND__
$identity = [System.Security.Principal.WindowsIdentity]::GetCurrent()
if ($kind -eq 'directory') {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]'ContainerInherit,ObjectInherit'
} else {
  $inheritance = [System.Security.AccessControl.InheritanceFlags]::None
}
$current = Get-Acl -LiteralPath $targetPath
$currentRules = @($current.Access)
$ownerSid = $current.GetOwner([System.Security.Principal.SecurityIdentifier])
$alreadySecure = $current.AreAccessRulesProtected -and
  $ownerSid.Value -eq $identity.User.Value -and
  $currentRules.Count -eq 1 -and
  -not $currentRules[0].IsInherited -and
  $currentRules[0].AccessControlType -eq [System.Security.AccessControl.AccessControlType]::Allow -and
  $currentRules[0].FileSystemRights -eq [System.Security.AccessControl.FileSystemRights]::FullControl -and
  $currentRules[0].InheritanceFlags -eq $inheritance -and
  $currentRules[0].PropagationFlags -eq [System.Security.AccessControl.PropagationFlags]::None -and
  $currentRules[0].IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value -eq $identity.User.Value
if ($alreadySecure) { exit 0 }
if ($kind -eq 'directory') {
  $acl = [System.Security.AccessControl.DirectorySecurity]::new()
} else {
  $acl = [System.Security.AccessControl.FileSecurity]::new()
}
$acl.SetAccessRuleProtection($true, $false)
$acl.SetOwner($identity.User)
$rule = [System.Security.AccessControl.FileSystemAccessRule]::new(
  $identity.User,
  [System.Security.AccessControl.FileSystemRights]::FullControl,
  $inheritance,
  [System.Security.AccessControl.PropagationFlags]::None,
  [System.Security.AccessControl.AccessControlType]::Allow
)
$acl.AddAccessRule($rule)
Set-Acl -LiteralPath $targetPath -AclObject $acl
`;

function windowsPowerShellPath(environment: NodeJS.ProcessEnv): string {
  const windowsDirectory = environment.SystemRoot ?? environment.SYSTEMROOT ?? environment.windir;
  return windowsDirectory === undefined
    ? "powershell.exe"
    : NodePath.win32.join(
        windowsDirectory,
        "System32",
        "WindowsPowerShell",
        "v1.0",
        "powershell.exe",
      );
}

async function secureWindowsPath(
  path: string,
  kind: "directory" | "file",
  environment: NodeJS.ProcessEnv,
  runtime: ChatGptBrowserPlatformRuntime,
): Promise<void> {
  const encodedPath = Buffer.from(path, "utf8").toString("base64");
  const script = WINDOWS_ACL_SCRIPT.replace(
    "__TARGET_PATH__",
    `[System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${encodedPath}'))`,
  ).replace("__TARGET_KIND__", `'${kind}'`);
  const result = await runtime.runCommand(windowsPowerShellPath(environment), [
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-ExecutionPolicy",
    "Bypass",
    "-Command",
    script,
  ]);
  if (result.exitCode !== 0) {
    throw new Error(`PowerShell failed to secure ${kind} ACL (${result.exitCode})`);
  }
}

function managedBrowserArgs(input: {
  readonly profileDirectory: string;
  readonly extensionRoot: string;
  readonly args: ReadonlyArray<string>;
}): ReadonlyArray<string> {
  for (const argument of input.args) {
    const flag = argument.split("=", 1)[0] ?? "";
    if (
      SANDBOX_BYPASS_FLAGS.has(flag) ||
      flag === "--user-data-dir" ||
      flag === "--load-extension" ||
      flag === "--disable-extensions-except"
    ) {
      throw new Error(`Managed browser argument is reserved: ${flag}`);
    }
  }
  return [
    `--user-data-dir=${input.profileDirectory}`,
    `--disable-extensions-except=${input.extensionRoot}`,
    `--load-extension=${input.extensionRoot}`,
    "--no-first-run",
    "--no-default-browser-check",
    ...input.args,
  ];
}

async function waitForExit(
  browserProcess: SpawnedBrowserProcess,
  runtime: ChatGptBrowserPlatformRuntime,
  milliseconds: number,
): Promise<boolean> {
  if (!browserProcess.isRunning()) return true;
  return Promise.race([
    browserProcess.wait.then(() => true),
    runtime.sleep(milliseconds).then(() => !browserProcess.isRunning()),
  ]);
}

async function stopWindowsBrowserTree(
  browserProcess: SpawnedBrowserProcess,
  runtime: ChatGptBrowserPlatformRuntime,
): Promise<void> {
  if (!browserProcess.isRunning()) return;
  const graceful = await runtime.runCommand("taskkill.exe", [
    "/PID",
    String(browserProcess.pid),
    "/T",
  ]);
  if (
    graceful.exitCode === 0 &&
    (await waitForExit(browserProcess, runtime, BROWSER_STOP_GRACE_MS))
  ) {
    return;
  }
  if (!browserProcess.isRunning()) return;
  const forced = await runtime.runCommand("taskkill.exe", [
    "/PID",
    String(browserProcess.pid),
    "/T",
    "/F",
  ]);
  if (forced.exitCode !== 0) {
    // `taskkill` can lose a race with Chromium's own shutdown: Windows reports a non-zero
    // "process not found" result while Node has not received the child exit event yet. Give the
    // captured process handle the same bounded exit grace before treating that result as fatal.
    if (await waitForExit(browserProcess, runtime, BROWSER_STOP_GRACE_MS)) return;
    if (!browserProcess.isRunning()) return;
    throw new Error(`taskkill failed for managed browser pid ${browserProcess.pid}`);
  }
  if (
    !(await waitForExit(browserProcess, runtime, BROWSER_STOP_GRACE_MS)) &&
    browserProcess.isRunning()
  ) {
    throw new Error(`Managed browser pid ${browserProcess.pid} did not exit`);
  }
}

async function stopLinuxBrowserTree(
  browserProcess: SpawnedBrowserProcess,
  runtime: ChatGptBrowserPlatformRuntime,
): Promise<void> {
  if (!browserProcess.isRunning()) return;
  runtime.signalPosixProcessGroup(browserProcess.pid, "SIGTERM");
  const exited = await waitForExit(browserProcess, runtime, BROWSER_STOP_GRACE_MS);
  if (exited && !runtime.signalPosixProcessGroup(browserProcess.pid, 0)) return;
  runtime.signalPosixProcessGroup(browserProcess.pid, "SIGKILL");
  if (
    !(await waitForExit(browserProcess, runtime, BROWSER_STOP_GRACE_MS)) &&
    browserProcess.isRunning()
  ) {
    throw new Error(`Managed browser process group ${browserProcess.pid} did not exit`);
  }
}

function parseLdConfigLibraries(output: string): ReadonlySet<string> {
  const libraries = new Set<string>();
  for (const line of output.split(/\r?\n/u)) {
    const match = /^\s*(\S+)\s+\(/u.exec(line);
    if (match?.[1] !== undefined) libraries.add(match[1]);
  }
  return libraries;
}

async function linuxPrerequisites(
  runtime: ChatGptBrowserPlatformRuntime,
): Promise<ReadonlyArray<{ readonly code: string; readonly detail: string }>> {
  const issues: Array<{ readonly code: string; readonly detail: string }> = [];
  const run = (command: string, args: ReadonlyArray<string>) =>
    runtime.runCommand(command, args).catch(() => ({ exitCode: 127, stdout: "", stderr: "" }));
  const read = (path: string) => runtime.readTextFile(path).catch(() => null);
  if (runtime.userId() === 0) {
    issues.push({
      code: "linux-browser-root-user",
      detail:
        "Managed Chromium keeps its sandbox enabled and cannot run as root. Run the T3 server as a non-root user.",
    });
  }

  const libraries = await run("ldconfig", ["-p"]);
  if (libraries.exitCode !== 0) {
    issues.push({
      code: "linux-library-probe-unavailable",
      detail:
        "Unable to query the dynamic linker cache with `ldconfig -p`; install the standard glibc loader tools before launching managed Chromium.",
    });
  } else {
    const available = parseLdConfigLibraries(libraries.stdout);
    const missing = LINUX_REQUIRED_LIBRARY_SONAMES.filter((library) => !available.has(library));
    if (missing.length > 0) {
      issues.push({
        code: "linux-browser-libraries-missing",
        detail: `Managed Chromium is missing shared libraries: ${missing.join(", ")}. Install the corresponding Ubuntu 24.04 Chromium runtime packages before launch.`,
      });
    }
  }

  const font = await run("fc-match", ["-f", "%{family}\n", "sans-serif"]);
  if (font.exitCode !== 0 || font.stdout.trim().length === 0) {
    issues.push({
      code: "linux-browser-fonts-missing",
      detail:
        "Managed Chromium needs fontconfig plus at least one usable sans-serif font. Install `fontconfig` and the standard Ubuntu fonts before launch.",
    });
  }

  const userNamespaces = await read(LINUX_UNPRIVILEGED_USERNS);
  if (userNamespaces?.trim() === "0") {
    issues.push({
      code: "linux-browser-userns-disabled",
      detail:
        "Unprivileged user namespaces are disabled, so Chromium's sandbox cannot start. Enable user namespaces rather than adding `--no-sandbox`.",
    });
  }

  const appArmorRestricted = (await read(LINUX_APPARMOR_USERNS_RESTRICTION))?.trim() === "1";
  if (appArmorRestricted) {
    const profiles = (await read(LINUX_APPARMOR_PROFILES)) ?? "";
    if (!profiles.includes(LINUX_APPARMOR_PROFILE_NAME)) {
      issues.push({
        code: "linux-browser-apparmor-userns",
        detail:
          "AppArmor restricts unprivileged user namespaces and no loaded `t3-chatgpt-browser` profile was found. Install/load a profile granting userns to the managed Chromium path; do not disable the browser sandbox.",
      });
    }
  }
  return issues;
}

function makePlatform(
  target: ChatGptBrowserManagedTarget,
  options: PlatformAdapterOptions,
): ChatGptBrowserPlatformPort {
  const environment = options.environment ?? process.env;
  const runtime = options.runtime ?? nativeRuntime(environment);
  const paths = platformPaths(target, options.rootDirectory);
  const path = target === "windows-x64" ? NodePath.win32 : NodePath.posix;
  const processes = new Map<string, SpawnedBrowserProcess>();
  const securedSecretFiles = new Set<string>();
  let secretDirectoryReady: Promise<void> | undefined;

  const ensureSecretDirectory = (): Promise<void> => {
    if (secretDirectoryReady !== undefined) return secretDirectoryReady;
    secretDirectoryReady = (async () => {
      await NodeFs.mkdir(paths.secretsDirectory, { recursive: true, mode: 0o700 });
      if (target === "windows-x64") {
        await secureWindowsPath(paths.secretsDirectory, "directory", environment, runtime);
      } else {
        await NodeFs.chmod(paths.secretsDirectory, 0o700);
        await syncDirectory(path.dirname(paths.secretsDirectory));
      }
    })().catch((cause) => {
      secretDirectoryReady = undefined;
      throw cause;
    });
    return secretDirectoryReady;
  };

  const resolveSecret = (key: string) =>
    validateSecretKey(key).pipe(
      Effect.map((safeKey) => path.join(paths.secretsDirectory, `${safeKey}.bin`)),
    );

  const secureSecretFile = async (secretPath: string, force = false): Promise<void> => {
    if (!force && securedSecretFiles.has(secretPath)) return;
    if (target === "windows-x64") {
      await secureWindowsPath(secretPath, "file", environment, runtime);
    } else {
      await NodeFs.chmod(secretPath, 0o600);
    }
    securedSecretFiles.add(secretPath);
  };

  return {
    target,
    paths: Effect.succeed(paths),
    checkPrerequisites:
      target === "linux-x64"
        ? tryPlatform("checking-linux-browser-prerequisites", () => linuxPrerequisites(runtime))
        : Effect.succeed([]),
    launchBrowser: (input) =>
      Effect.gen(function* () {
        const args = yield* Effect.try({
          try: () => managedBrowserArgs(input),
          catch: (cause) => hostError("validating-managed-browser-arguments", cause),
        });
        const spawned = yield* tryPlatform("launching-managed-browser", () =>
          runtime.spawnBrowser({
            executablePath: input.executablePath,
            args,
            detached: target === "linux-x64",
            environment,
          }),
        );
        if (!Number.isSafeInteger(spawned.pid) || spawned.pid <= 1) {
          return yield* Effect.fail(hostError("validating-managed-browser-pid"));
        }
        const opaqueId = randomUUID();
        processes.set(opaqueId, spawned);
        return { opaqueId } satisfies ChatGptBrowserProcessHandle;
      }),
    stopBrowser: (handle) =>
      Effect.gen(function* () {
        const browserProcess = processes.get(handle.opaqueId);
        if (browserProcess === undefined) {
          return yield* Effect.fail(hostError("stopping-unknown-managed-browser"));
        }
        yield* tryPlatform("stopping-managed-browser", () =>
          target === "windows-x64"
            ? stopWindowsBrowserTree(browserProcess, runtime)
            : stopLinuxBrowserTree(browserProcess, runtime),
        );
        processes.delete(handle.opaqueId);
      }),
    replaceFileAtomically: (input) =>
      tryPlatform("replacing-managed-browser-file", () =>
        replaceFileAtomically({ target, ...input, runtime }),
      ),
    readSecret: (key) =>
      Effect.gen(function* () {
        const secretPath = yield* resolveSecret(key);
        yield* tryPlatform("securing-browser-secret-directory", ensureSecretDirectory);
        const exists = yield* tryPlatform("checking-browser-secret", async () => {
          try {
            return (await NodeFs.stat(secretPath)).isFile();
          } catch (cause) {
            if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
            throw cause;
          }
        });
        if (!exists) return null;
        yield* tryPlatform("securing-browser-secret-file", () => secureSecretFile(secretPath));
        return yield* tryPlatform("reading-browser-secret", async () =>
          Uint8Array.from(await NodeFs.readFile(secretPath)),
        );
      }),
    writeSecret: ({ key, value }) =>
      Effect.gen(function* () {
        const secretPath = yield* resolveSecret(key);
        yield* tryPlatform("securing-browser-secret-directory", ensureSecretDirectory);
        yield* tryPlatform("writing-browser-secret", () =>
          replaceFileAtomically({ target, path: secretPath, contents: value, runtime }),
        );
        securedSecretFiles.delete(secretPath);
        yield* tryPlatform("securing-browser-secret-file", () =>
          secureSecretFile(secretPath, true),
        );
      }),
    deleteSecret: (key) =>
      Effect.gen(function* () {
        const secretPath = yield* resolveSecret(key);
        yield* tryPlatform("securing-browser-secret-directory", ensureSecretDirectory);
        yield* tryPlatform("deleting-browser-secret", async () => {
          await NodeFs.rm(secretPath, { force: true });
          if (target === "linux-x64") await syncDirectory(paths.secretsDirectory);
        });
        securedSecretFiles.delete(secretPath);
      }),
  };
}

export function makeWindowsChatGptBrowserPlatform(
  options: PlatformAdapterOptions,
): ChatGptBrowserPlatformPort {
  return makePlatform("windows-x64", options);
}

export function makeLinuxChatGptBrowserPlatform(
  options: PlatformAdapterOptions,
): ChatGptBrowserPlatformPort {
  return makePlatform("linux-x64", options);
}

export function makeChatGptBrowserPlatformForHost(
  options: ChatGptBrowserHostPlatformOptions,
): Effect.Effect<ChatGptBrowserPlatformPort, ChatGptBrowserHostError> {
  const platform = options.platform ?? process.platform;
  const architecture = options.architecture ?? process.arch;
  const target = chatGptBrowserManagedTargetForHost(platform, architecture);
  if (target === null) {
    return Effect.fail(hostError("resolving-managed-browser-target", { platform, architecture }));
  }
  return Effect.succeed(
    target === "windows-x64"
      ? makeWindowsChatGptBrowserPlatform(options)
      : makeLinuxChatGptBrowserPlatform(options),
  );
}
