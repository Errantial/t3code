// @effect-diagnostics nodeBuiltinImport:off - Managed Chromium staging needs native recursive copy,
// lstat and an incremental digest while stable extension publication preserves the directory inode.
// OS-specific launch, secret and durable pointer semantics remain behind ChatGptBrowserPlatformPort.
import { createHash, randomUUID } from "node:crypto";
import { promises as NodeFs } from "node:fs";
import * as NodePath from "node:path";

import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

import {
  ChatGptBrowserHostError,
  type ChatGptBrowserHostIdentity,
  type ChatGptBrowserHostPort,
  type ChatGptBrowserHostSession,
  type ChatGptBrowserPlatformPaths,
  type ChatGptBrowserPlatformPort,
  type ChatGptBrowserProcessHandle,
  type ChatGptBrowserProviderV1Transport,
} from "./chatgptBrowserProviderV1.ts";

const ACTIVE_POINTER_VERSION = 1 as const;
const INSTALL_SENTINEL = ".t3-chatgpt-browser-install.json";
const EXTENSION_FINGERPRINT = ".t3-chatgpt-browser-source";
const EXTENSION_BUILD_STAMP = "build-stamp.txt";
const EXTENSION_BUILD_MODULE = "managed-build.js";
const EXTENSION_PUBLISH_LAST = new Set([
  "manifest.json",
  EXTENSION_FINGERPRINT,
  EXTENSION_BUILD_STAMP,
]);

export function chatGptBrowserManagedExtensionBuildId(
  identity: ChatGptBrowserHostIdentity,
): string {
  return createHash("sha256")
    .update("t3-chatgpt-browser-extension\0", "utf8")
    .update(identity.providerReleaseVersion, "utf8")
    .digest("hex")
    .slice(0, 12);
}

export interface ChatGptBrowserManagedReleaseDescriptor {
  readonly identity: ChatGptBrowserHostIdentity;
  readonly browserExecutableRelativePath: string;
  readonly extensionRelativePath: string;
  readonly browserArgs?: ReadonlyArray<string>;
}

/**
 * Sources are immutable release inputs. The host copies them into its managed version roots before
 * validation or activation, so neither packaged resources nor an update download ever become the
 * Chrome-visible extension path or the durable browser profile.
 */
export interface ChatGptBrowserManagedReleaseSource extends ChatGptBrowserManagedReleaseDescriptor {
  readonly browserSourceDirectory: string;
  readonly providerSourceDirectory: string;
  readonly validationArgs?: ReadonlyArray<string>;
}

export interface ChatGptBrowserCandidateValidationInput {
  readonly release: ChatGptBrowserManagedReleaseDescriptor;
  readonly browserExecutablePath: string;
  readonly profileDirectory: string;
  readonly extensionRoot: string;
  readonly process: ChatGptBrowserProcessHandle;
}

export interface ChatGptBrowserTransportConnectInput {
  readonly release: ChatGptBrowserManagedReleaseDescriptor;
  readonly browserExecutablePath: string;
  readonly profileDirectory: string;
  readonly extensionRoot: string;
  readonly process: ChatGptBrowserProcessHandle;
}

export interface ChatGptBrowserManagedHostOptions {
  readonly platform: ChatGptBrowserPlatformPort;
  readonly release: ChatGptBrowserManagedReleaseSource;
  /** Proves a staged browser/provider pair in a disposable profile before it can become active. */
  readonly validateCandidate: (
    input: ChatGptBrowserCandidateValidationInput,
  ) => Effect.Effect<void, ChatGptBrowserHostError>;
  readonly connectTransport: (
    input: ChatGptBrowserTransportConnectInput,
  ) => Effect.Effect<ChatGptBrowserProviderV1Transport, ChatGptBrowserHostError>;
  /** Browser revisions never change implicitly because a durable profile cannot be downgraded. */
  readonly allowBrowserRevisionChange?: (input: {
    readonly active: ChatGptBrowserManagedReleaseDescriptor;
    readonly candidate: ChatGptBrowserManagedReleaseDescriptor;
  }) => Effect.Effect<boolean, ChatGptBrowserHostError>;
}

export interface ChatGptBrowserManagedHost extends ChatGptBrowserHostPort {
  /** Installs and validates the configured release, then activates it at an idle boundary. */
  readonly prepareRelease: Effect.Effect<
    ChatGptBrowserManagedReleaseDescriptor,
    ChatGptBrowserHostError
  >;
  /** Rolls back only the provider/extension release. Browser-revision rollback is refused. */
  readonly rollbackProviderRelease: Effect.Effect<boolean, ChatGptBrowserHostError>;
  readonly activeRelease: Effect.Effect<
    ChatGptBrowserManagedReleaseDescriptor | null,
    ChatGptBrowserHostError
  >;
}

interface ActivePointer {
  readonly version: typeof ACTIVE_POINTER_VERSION;
  readonly active: ChatGptBrowserManagedReleaseDescriptor;
  readonly previous?: ChatGptBrowserManagedReleaseDescriptor;
}

interface InstalledAssetSentinel {
  readonly version: 1;
  readonly kind: "browser" | "provider";
  readonly target: ChatGptBrowserHostIdentity["target"];
  readonly browserRevision?: string;
  readonly providerReleaseVersion?: string;
  readonly extensionVersion?: string;
}

interface InstalledReleasePaths {
  readonly browserDirectory: string;
  readonly providerDirectory: string;
  readonly browserExecutablePath: string;
  readonly extensionDirectory: string;
}

const hostError = (operation: string, cause?: unknown) =>
  new ChatGptBrowserHostError({ operation, ...(cause === undefined ? {} : { cause }) });

const tryFs = <A>(
  operation: string,
  run: () => Promise<A>,
): Effect.Effect<A, ChatGptBrowserHostError> =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => hostError(operation, cause),
  });

const cleanSegment = (
  value: string,
  field: string,
): Effect.Effect<string, ChatGptBrowserHostError> =>
  /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value) && value !== "." && value !== ".."
    ? Effect.succeed(value)
    : Effect.fail(hostError(`validating-${field}`));

function descriptorEqual(
  left: ChatGptBrowserManagedReleaseDescriptor,
  right: ChatGptBrowserManagedReleaseDescriptor,
): boolean {
  return (
    left.identity.target === right.identity.target &&
    left.identity.browserRevision === right.identity.browserRevision &&
    left.identity.providerReleaseVersion === right.identity.providerReleaseVersion &&
    left.identity.extensionVersion === right.identity.extensionVersion &&
    left.browserExecutableRelativePath === right.browserExecutableRelativePath &&
    left.extensionRelativePath === right.extensionRelativePath &&
    JSON.stringify(left.browserArgs ?? []) === JSON.stringify(right.browserArgs ?? [])
  );
}

function descriptorFromSource(
  source: ChatGptBrowserManagedReleaseSource,
): ChatGptBrowserManagedReleaseDescriptor {
  return {
    identity: source.identity,
    browserExecutableRelativePath: source.browserExecutableRelativePath,
    extensionRelativePath: source.extensionRelativePath,
    ...(source.browserArgs === undefined ? {} : { browserArgs: source.browserArgs }),
  };
}

function isIdentity(value: unknown): value is ChatGptBrowserHostIdentity {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChatGptBrowserHostIdentity>;
  return (
    (candidate.target === "windows-x64" || candidate.target === "linux-x64") &&
    typeof candidate.browserRevision === "string" &&
    candidate.browserRevision.length > 0 &&
    typeof candidate.providerReleaseVersion === "string" &&
    candidate.providerReleaseVersion.length > 0 &&
    typeof candidate.extensionVersion === "string" &&
    candidate.extensionVersion.length > 0
  );
}

function isDescriptor(value: unknown): value is ChatGptBrowserManagedReleaseDescriptor {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ChatGptBrowserManagedReleaseDescriptor>;
  return (
    isIdentity(candidate.identity) &&
    typeof candidate.browserExecutableRelativePath === "string" &&
    candidate.browserExecutableRelativePath.length > 0 &&
    typeof candidate.extensionRelativePath === "string" &&
    candidate.extensionRelativePath.length > 0 &&
    (candidate.browserArgs === undefined ||
      (Array.isArray(candidate.browserArgs) &&
        candidate.browserArgs.every((argument) => typeof argument === "string")))
  );
}

function isPointer(value: unknown): value is ActivePointer {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ActivePointer>;
  return (
    candidate.version === ACTIVE_POINTER_VERSION &&
    isDescriptor(candidate.active) &&
    (candidate.previous === undefined || isDescriptor(candidate.previous))
  );
}

function isSentinel(value: unknown): value is InstalledAssetSentinel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<InstalledAssetSentinel>;
  return (
    candidate.version === 1 &&
    (candidate.kind === "browser" || candidate.kind === "provider") &&
    (candidate.target === "windows-x64" || candidate.target === "linux-x64")
  );
}

const readJson = (
  file: string,
  operation: string,
): Effect.Effect<unknown | null, ChatGptBrowserHostError> =>
  tryFs(operation, async () => {
    try {
      return JSON.parse(await NodeFs.readFile(file, "utf8")) as unknown;
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    }
  });

const readPointer = (
  paths: ChatGptBrowserPlatformPaths,
): Effect.Effect<ActivePointer | null, ChatGptBrowserHostError> =>
  readJson(paths.activeProviderPointer, "reading-active-provider-pointer").pipe(
    Effect.flatMap((value) => {
      if (value === null) return Effect.succeed(null);
      return isPointer(value)
        ? Effect.succeed(value)
        : Effect.fail(hostError("decoding-active-provider-pointer"));
    }),
  );

const writePointer = (
  platform: ChatGptBrowserPlatformPort,
  paths: ChatGptBrowserPlatformPaths,
  pointer: ActivePointer,
): Effect.Effect<void, ChatGptBrowserHostError> =>
  platform.replaceFileAtomically({
    path: paths.activeProviderPointer,
    contents: new TextEncoder().encode(`${JSON.stringify(pointer, null, 2)}\n`),
  });

const assertRelativePath = (
  value: string,
  field: string,
): Effect.Effect<string, ChatGptBrowserHostError> => {
  if (NodePath.isAbsolute(value)) return Effect.fail(hostError(`validating-${field}`));
  const normalized = NodePath.normalize(value);
  if (
    normalized === "." ||
    normalized === ".." ||
    normalized.startsWith(`..${NodePath.sep}`) ||
    normalized.split(NodePath.sep).includes("..")
  ) {
    return Effect.fail(hostError(`validating-${field}`));
  }
  return Effect.succeed(normalized);
};

const fileExists = (file: string): Promise<boolean> =>
  NodeFs.stat(file).then(
    (stat) => stat.isFile(),
    (cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw cause;
    },
  );

async function directoryExists(directory: string): Promise<boolean> {
  try {
    return (await NodeFs.stat(directory)).isDirectory();
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function expectedSentinel(
  kind: InstalledAssetSentinel["kind"],
  identity: ChatGptBrowserHostIdentity,
): InstalledAssetSentinel {
  return kind === "browser"
    ? {
        version: 1,
        kind,
        target: identity.target,
        browserRevision: identity.browserRevision,
      }
    : {
        version: 1,
        kind,
        target: identity.target,
        providerReleaseVersion: identity.providerReleaseVersion,
        extensionVersion: identity.extensionVersion,
      };
}

function sentinelEqual(left: InstalledAssetSentinel, right: InstalledAssetSentinel): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

const verifyInstalledAsset = (input: {
  readonly directory: string;
  readonly sentinel: InstalledAssetSentinel;
  readonly requiredRelativePath: string;
  readonly operation: string;
}): Effect.Effect<boolean, ChatGptBrowserHostError> =>
  tryFs(input.operation, async () => {
    if (!(await directoryExists(input.directory))) return false;
    const raw = await NodeFs.readFile(
      NodePath.join(input.directory, INSTALL_SENTINEL),
      "utf8",
    ).catch((cause: unknown) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw cause;
    });
    if (raw === null) return false;
    const value = JSON.parse(raw) as unknown;
    if (!isSentinel(value) || !sentinelEqual(value, input.sentinel)) return false;
    return fileExists(NodePath.join(input.directory, input.requiredRelativePath));
  });

const installImmutableAsset = (input: {
  readonly sourceDirectory: string;
  readonly versionsDirectory: string;
  readonly versionSegment: string;
  readonly sentinel: InstalledAssetSentinel;
  readonly requiredRelativePath: string;
  readonly operation: string;
}): Effect.Effect<string, ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    const finalDirectory = NodePath.join(input.versionsDirectory, input.versionSegment);
    const valid = yield* verifyInstalledAsset({
      directory: finalDirectory,
      sentinel: input.sentinel,
      requiredRelativePath: input.requiredRelativePath,
      operation: `${input.operation}-checking-installed`,
    });
    if (valid) return finalDirectory;

    const finalExists = yield* tryFs(`${input.operation}-checking-version-directory`, () =>
      directoryExists(finalDirectory),
    );
    if (finalExists) {
      return yield* Effect.fail(hostError(`${input.operation}-immutable-version-conflict`));
    }

    yield* tryFs(`${input.operation}-preparing-versions-directory`, () =>
      NodeFs.mkdir(input.versionsDirectory, { recursive: true }),
    );
    const stage = NodePath.join(
      input.versionsDirectory,
      `.staging-${input.versionSegment}-${randomUUID()}`,
    );
    return yield* Effect.gen(function* () {
      yield* tryFs(`${input.operation}-copying-candidate`, () =>
        NodeFs.cp(input.sourceDirectory, stage, {
          recursive: true,
          force: false,
          errorOnExist: true,
          verbatimSymlinks: true,
        }),
      );
      const required = NodePath.join(stage, input.requiredRelativePath);
      const requiredExists = yield* tryFs(`${input.operation}-validating-candidate`, () =>
        fileExists(required),
      );
      if (!requiredExists)
        return yield* Effect.fail(hostError(`${input.operation}-missing-required-file`));
      yield* tryFs(`${input.operation}-recording-install`, () =>
        NodeFs.writeFile(
          NodePath.join(stage, INSTALL_SENTINEL),
          `${JSON.stringify(input.sentinel, null, 2)}\n`,
          { mode: 0o600 },
        ),
      );
      yield* tryFs(`${input.operation}-publishing-install`, () =>
        NodeFs.rename(stage, finalDirectory),
      );
      return finalDirectory;
    }).pipe(
      Effect.ensuring(
        tryFs(`${input.operation}-cleaning-staging`, () =>
          NodeFs.rm(stage, { recursive: true, force: true }),
        ).pipe(Effect.ignore),
      ),
    );
  });

async function fingerprintExtensionDirectory(root: string): Promise<string> {
  const hash = createHash("sha256");
  const visit = async (directory: string, relativeDirectory = ""): Promise<void> => {
    const entries = (await NodeFs.readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relative = relativeDirectory
        ? NodePath.posix.join(relativeDirectory, entry.name)
        : entry.name;
      if (
        relative === EXTENSION_FINGERPRINT ||
        relative === EXTENSION_BUILD_STAMP ||
        relative === EXTENSION_BUILD_MODULE
      )
        continue;
      const absolute = NodePath.join(directory, entry.name);
      if (entry.isDirectory()) {
        hash.update(`d\0${relative}\0`);
        await visit(absolute, relative);
      } else if (entry.isFile()) {
        hash.update(`f\0${relative}\0`);
        hash.update(await NodeFs.readFile(absolute));
        hash.update("\0");
      } else {
        throw new Error(`Unsupported extension entry: ${relative}`);
      }
    }
  };
  await visit(root);
  return hash.digest("hex");
}

const fingerprintExtension = (root: string): Effect.Effect<string, ChatGptBrowserHostError> =>
  tryFs("fingerprinting-extension", () => fingerprintExtensionDirectory(root));

async function entryKind(target: string): Promise<"directory" | "file" | "other" | "missing"> {
  try {
    const stat = await NodeFs.lstat(target);
    if (stat.isDirectory()) return "directory";
    if (stat.isFile()) return "file";
    return "other";
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw cause;
  }
}

async function ensureDirectory(target: string): Promise<void> {
  const kind = await entryKind(target);
  if (kind === "directory") return;
  if (kind !== "missing") await NodeFs.rm(target, { recursive: true, force: true });
  await NodeFs.mkdir(target, { recursive: true });
}

async function validExtension(directory: string): Promise<boolean> {
  return fileExists(NodePath.join(directory, "manifest.json"));
}

async function materializedFingerprint(directory: string): Promise<string | null> {
  try {
    return (
      (await NodeFs.readFile(NodePath.join(directory, EXTENSION_FINGERPRINT), "utf8")).trim() ||
      null
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw cause;
  }
}

async function replaceExtensionFile(source: string, target: string): Promise<void> {
  await ensureDirectory(NodePath.dirname(target));
  const temporary = NodePath.join(
    NodePath.dirname(target),
    `.${NodePath.basename(target)}.t3-next-${process.pid}-${randomUUID()}`,
  );
  await NodeFs.rm(temporary, { recursive: true, force: true });
  await NodeFs.copyFile(source, temporary);
  await NodeFs.chmod(temporary, (await NodeFs.stat(source)).mode);
  if ((await entryKind(target)) !== "missing")
    await NodeFs.rm(target, { recursive: true, force: true });
  await NodeFs.rename(temporary, target);
}

async function writeExtensionBuildStamp(directory: string, buildId: string): Promise<void> {
  if (!/^[0-9a-f]{12}$/.test(buildId)) throw new Error("Managed extension build id is invalid");
  const target = NodePath.join(directory, EXTENSION_BUILD_STAMP);
  const temporary = NodePath.join(
    directory,
    `.${EXTENSION_BUILD_STAMP}.t3-next-${process.pid}-${randomUUID()}`,
  );
  await NodeFs.writeFile(temporary, `${buildId}\n`, { mode: 0o600 });
  await NodeFs.rename(temporary, target);
}

async function writeExtensionBuildModule(directory: string, buildId: string): Promise<void> {
  if (!/^[0-9a-f]{12}$/.test(buildId)) throw new Error("Managed extension build id is invalid");
  const target = NodePath.join(directory, EXTENSION_BUILD_MODULE);
  const temporary = NodePath.join(
    directory,
    `.${EXTENSION_BUILD_MODULE}.t3-next-${process.pid}-${randomUUID()}`,
  );
  await NodeFs.writeFile(
    temporary,
    `export const T3_MANAGED_EXTENSION_BUILD_ID = ${JSON.stringify(buildId)};\n`,
    { mode: 0o600 },
  );
  await NodeFs.rename(temporary, target);
}

async function materializedBuildMatches(directory: string, buildId: string): Promise<boolean> {
  try {
    const [stamp, module] = await Promise.all([
      NodeFs.readFile(NodePath.join(directory, EXTENSION_BUILD_STAMP), "utf8"),
      NodeFs.readFile(NodePath.join(directory, EXTENSION_BUILD_MODULE), "utf8"),
    ]);
    return (
      stamp.trim() === buildId &&
      module === `export const T3_MANAGED_EXTENSION_BUILD_ID = ${JSON.stringify(buildId)};\n`
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

async function syncExtensionTreeInPlace(
  source: string,
  target: string,
  root = true,
): Promise<void> {
  await ensureDirectory(target);
  const sourceEntries = (await NodeFs.readdir(source, { withFileTypes: true })).sort(
    (left, right) => left.name.localeCompare(right.name),
  );
  const sourceNames = new Set(sourceEntries.map((entry) => entry.name));
  const ordinary = sourceEntries.filter(
    (entry) => !root || !EXTENSION_PUBLISH_LAST.has(entry.name),
  );
  const publishLast = root
    ? sourceEntries
        .filter((entry) => EXTENSION_PUBLISH_LAST.has(entry.name))
        .sort((left, right) => {
          const rank = (name: string) =>
            name === "manifest.json" ? 0 : name === EXTENSION_FINGERPRINT ? 1 : 2;
          return rank(left.name) - rank(right.name) || left.name.localeCompare(right.name);
        })
    : [];

  const publish = async (entry: (typeof sourceEntries)[number]): Promise<void> => {
    const from = NodePath.join(source, entry.name);
    const to = NodePath.join(target, entry.name);
    if (entry.isDirectory()) return syncExtensionTreeInPlace(from, to, false);
    if (!entry.isFile()) throw new Error(`Unsupported staged extension entry: ${entry.name}`);
    await replaceExtensionFile(from, to);
  };

  for (const entry of ordinary) await publish(entry);
  for (const entry of await NodeFs.readdir(target, { withFileTypes: true })) {
    if (sourceNames.has(entry.name)) continue;
    await NodeFs.rm(NodePath.join(target, entry.name), { recursive: true, force: true });
  }
  for (const entry of publishLast) await publish(entry);
}

async function recoverInterruptedExtensionMaterialization(
  stable: string,
  stage: string,
  backup: string,
): Promise<void> {
  if (await validExtension(backup)) {
    if ((await entryKind(stable)) === "directory") await syncExtensionTreeInPlace(backup, stable);
    else {
      await NodeFs.rm(stable, { recursive: true, force: true });
      await NodeFs.cp(backup, stable, { recursive: true, force: true });
    }
    if (await validExtension(stable)) {
      await NodeFs.rm(backup, { recursive: true, force: true });
      await NodeFs.rm(stage, { recursive: true, force: true });
    }
    return;
  }

  if ((await validExtension(stage)) && (await materializedFingerprint(stage)) !== null) {
    if ((await entryKind(stable)) === "directory") {
      await syncExtensionTreeInPlace(stage, stable);
      if (await validExtension(stable)) await NodeFs.rm(stage, { recursive: true, force: true });
    } else {
      await NodeFs.rm(stable, { recursive: true, force: true });
      await NodeFs.rename(stage, stable);
    }
    return;
  }

  if (await validExtension(stable)) {
    await NodeFs.rm(stage, { recursive: true, force: true });
    await NodeFs.rm(backup, { recursive: true, force: true });
  }
}

const materializeStableExtension = (
  source: string,
  stable: string,
  buildId: string,
): Effect.Effect<void, ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    const fingerprint = yield* fingerprintExtension(source);
    yield* tryFs("materializing-extension", async () => {
      const stage = `${stable}.new`;
      const backup = `${stable}.old`;
      await NodeFs.mkdir(NodePath.dirname(stable), { recursive: true });
      await recoverInterruptedExtensionMaterialization(stable, stage, backup);
      if (!(await validExtension(source)))
        throw new Error("Provider extension is missing manifest.json");
      if (
        (await validExtension(stable)) &&
        (await materializedFingerprint(stable)) === fingerprint
      ) {
        if (
          (await fingerprintExtensionDirectory(stable)) === fingerprint &&
          (await materializedBuildMatches(stable, buildId))
        )
          return;
      }

      await NodeFs.rm(stage, { recursive: true, force: true });
      try {
        await NodeFs.cp(source, stage, { recursive: true, force: true });
        if (!(await validExtension(stage)))
          throw new Error("Staged extension is missing manifest.json");
        await writeExtensionBuildModule(stage, buildId);
        await writeExtensionBuildStamp(stage, buildId);
        await NodeFs.writeFile(NodePath.join(stage, EXTENSION_FINGERPRINT), `${fingerprint}\n`, {
          mode: 0o600,
        });

        await NodeFs.rm(backup, { recursive: true, force: true });
        const stableKind = await entryKind(stable);
        const hadPublishedDirectory = stableKind === "directory";
        const hadValidPublishedCopy = await validExtension(stable);
        if (hadValidPublishedCopy)
          await NodeFs.cp(stable, backup, { recursive: true, force: true });

        if (hadPublishedDirectory) {
          await syncExtensionTreeInPlace(stage, stable);
          if (
            !(await validExtension(stable)) ||
            (await materializedFingerprint(stable)) !== fingerprint
          ) {
            throw new Error("Published extension did not match staged source");
          }
          await NodeFs.rm(stage, { recursive: true, force: true });
        } else {
          await NodeFs.rm(stable, { recursive: true, force: true });
          await NodeFs.rename(stage, stable);
        }
        await NodeFs.rm(backup, { recursive: true, force: true });
      } catch (cause) {
        if (await validExtension(backup)) {
          if ((await entryKind(stable)) === "directory")
            await syncExtensionTreeInPlace(backup, stable);
          else {
            await NodeFs.rm(stable, { recursive: true, force: true });
            await NodeFs.cp(backup, stable, { recursive: true, force: true });
          }
        }
        if (await validExtension(stable)) {
          await NodeFs.rm(stage, { recursive: true, force: true });
          await NodeFs.rm(backup, { recursive: true, force: true });
        }
        throw cause;
      }
    });
  });

const installedReleasePaths = (
  paths: ChatGptBrowserPlatformPaths,
  release: ChatGptBrowserManagedReleaseDescriptor,
): Effect.Effect<InstalledReleasePaths, ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    const browserRevision = yield* cleanSegment(
      release.identity.browserRevision,
      "browser-revision",
    );
    const providerReleaseVersion = yield* cleanSegment(
      release.identity.providerReleaseVersion,
      "provider-release-version",
    );
    const browserExecutableRelativePath = yield* assertRelativePath(
      release.browserExecutableRelativePath,
      "browser-executable-path",
    );
    const extensionRelativePath = yield* assertRelativePath(
      release.extensionRelativePath,
      "extension-path",
    );
    const browserDirectory = NodePath.join(paths.browserVersionsDirectory, browserRevision);
    const providerDirectory = NodePath.join(
      paths.providerVersionsDirectory,
      providerReleaseVersion,
    );
    return {
      browserDirectory,
      providerDirectory,
      browserExecutablePath: NodePath.join(browserDirectory, browserExecutableRelativePath),
      extensionDirectory: NodePath.join(providerDirectory, extensionRelativePath),
    };
  });

const requireInstalledRelease = (input: {
  readonly paths: ChatGptBrowserPlatformPaths;
  readonly release: ChatGptBrowserManagedReleaseDescriptor;
}): Effect.Effect<InstalledReleasePaths, ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    const resolved = yield* installedReleasePaths(input.paths, input.release);
    const browserExecutableRelativePath = yield* assertRelativePath(
      input.release.browserExecutableRelativePath,
      "browser-executable-path",
    );
    const extensionManifestRelativePath = NodePath.join(
      yield* assertRelativePath(input.release.extensionRelativePath, "extension-path"),
      "manifest.json",
    );
    const [browserValid, providerValid] = yield* Effect.all([
      verifyInstalledAsset({
        directory: resolved.browserDirectory,
        sentinel: expectedSentinel("browser", input.release.identity),
        requiredRelativePath: browserExecutableRelativePath,
        operation: "resolving-installed-browser",
      }),
      verifyInstalledAsset({
        directory: resolved.providerDirectory,
        sentinel: expectedSentinel("provider", input.release.identity),
        requiredRelativePath: extensionManifestRelativePath,
        operation: "resolving-installed-provider",
      }),
    ]);
    if (!browserValid || !providerValid) {
      return yield* Effect.fail(hostError("resolving-installed-release"));
    }
    return resolved;
  });

const installRelease = (input: {
  readonly paths: ChatGptBrowserPlatformPaths;
  readonly release: ChatGptBrowserManagedReleaseSource;
}): Effect.Effect<InstalledReleasePaths, ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    const descriptor = descriptorFromSource(input.release);
    const browserRevision = yield* cleanSegment(
      descriptor.identity.browserRevision,
      "browser-revision",
    );
    const providerReleaseVersion = yield* cleanSegment(
      descriptor.identity.providerReleaseVersion,
      "provider-release-version",
    );
    const browserExecutableRelativePath = yield* assertRelativePath(
      descriptor.browserExecutableRelativePath,
      "browser-executable-path",
    );
    const extensionRelativePath = yield* assertRelativePath(
      descriptor.extensionRelativePath,
      "extension-path",
    );
    yield* Effect.all([
      installImmutableAsset({
        sourceDirectory: input.release.browserSourceDirectory,
        versionsDirectory: input.paths.browserVersionsDirectory,
        versionSegment: browserRevision,
        sentinel: expectedSentinel("browser", descriptor.identity),
        requiredRelativePath: browserExecutableRelativePath,
        operation: "installing-browser",
      }),
      installImmutableAsset({
        sourceDirectory: input.release.providerSourceDirectory,
        versionsDirectory: input.paths.providerVersionsDirectory,
        versionSegment: providerReleaseVersion,
        sentinel: expectedSentinel("provider", descriptor.identity),
        requiredRelativePath: NodePath.join(extensionRelativePath, "manifest.json"),
        operation: "installing-provider",
      }),
    ]);
    return yield* requireInstalledRelease({ paths: input.paths, release: descriptor });
  });

const makeDisposableValidation = (input: {
  readonly platform: ChatGptBrowserPlatformPort;
  readonly paths: ChatGptBrowserPlatformPaths;
  readonly release: ChatGptBrowserManagedReleaseSource;
  readonly installed: InstalledReleasePaths;
  readonly validateCandidate: ChatGptBrowserManagedHostOptions["validateCandidate"];
}): Effect.Effect<void, ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    yield* tryFs("preparing-disposable-browser-validation", () =>
      NodeFs.mkdir(NodePath.dirname(input.paths.profileDirectory), { recursive: true }),
    );
    const disposableRoot = yield* tryFs("preparing-disposable-browser-validation", () =>
      NodeFs.mkdtemp(
        NodePath.join(NodePath.dirname(input.paths.profileDirectory), ".chatgpt-browser-validate-"),
      ),
    );
    const disposableProfile = NodePath.join(disposableRoot, "profile");
    const disposableExtension = NodePath.join(disposableRoot, "extension");
    const cleanup = tryFs("cleaning-disposable-browser-validation", () =>
      NodeFs.rm(disposableRoot, { recursive: true, force: true }),
    );
    yield* Effect.gen(function* () {
      yield* tryFs("preparing-disposable-browser-validation", async () => {
        await NodeFs.mkdir(disposableProfile, { recursive: true });
        await NodeFs.cp(input.installed.extensionDirectory, disposableExtension, {
          recursive: true,
          force: true,
        });
        const buildId = chatGptBrowserManagedExtensionBuildId(input.release.identity);
        await writeExtensionBuildModule(disposableExtension, buildId);
        await writeExtensionBuildStamp(disposableExtension, buildId);
      });
      const process = yield* input.platform.launchBrowser({
        executablePath: input.installed.browserExecutablePath,
        profileDirectory: disposableProfile,
        extensionRoot: disposableExtension,
        args: input.release.validationArgs ?? input.release.browserArgs ?? [],
      });
      yield* input
        .validateCandidate({
          release: descriptorFromSource(input.release),
          browserExecutablePath: input.installed.browserExecutablePath,
          profileDirectory: disposableProfile,
          extensionRoot: disposableExtension,
          process,
        })
        .pipe(Effect.onError(() => input.platform.stopBrowser(process).pipe(Effect.ignore)));
      yield* input.platform.stopBrowser(process);
    }).pipe(Effect.onError(() => cleanup.pipe(Effect.ignore)));
    yield* cleanup;
  });

function pointerForActivation(
  active: ChatGptBrowserManagedReleaseDescriptor,
  previous: ChatGptBrowserManagedReleaseDescriptor | undefined,
): ActivePointer {
  return {
    version: ACTIVE_POINTER_VERSION,
    active,
    ...(previous === undefined ? {} : { previous }),
  };
}

export function makeChatGptBrowserHost(
  options: ChatGptBrowserManagedHostOptions,
): ChatGptBrowserManagedHost {
  const lifecycleLock = Semaphore.makeUnsafe(1);
  let sessionOpen = false;

  const requireIdle = (operation: string): Effect.Effect<void, ChatGptBrowserHostError> =>
    sessionOpen ? Effect.fail(hostError(operation)) : Effect.void;

  const platformPaths = options.platform.paths.pipe(
    Effect.flatMap((paths) =>
      options.release.identity.target === options.platform.target
        ? Effect.succeed(paths)
        : Effect.fail(hostError("matching-release-platform-target")),
    ),
  );

  const activeRelease = lifecycleLock.withPermit(
    Effect.gen(function* () {
      const paths = yield* platformPaths;
      return (yield* readPointer(paths))?.active ?? null;
    }),
  );

  const prepareRelease = lifecycleLock.withPermit(
    Effect.gen(function* () {
      yield* requireIdle("preparing-release-while-browser-open");
      const paths = yield* platformPaths;
      const issues = yield* options.platform.checkPrerequisites;
      if (issues.length > 0)
        return yield* Effect.fail(hostError("checking-browser-prerequisites", issues));

      const candidate = descriptorFromSource(options.release);
      const pointer = yield* readPointer(paths);
      if (pointer !== null && descriptorEqual(pointer.active, candidate)) {
        const installed = yield* requireInstalledRelease({ paths, release: candidate });
        yield* materializeStableExtension(
          installed.extensionDirectory,
          paths.extensionRoot,
          chatGptBrowserManagedExtensionBuildId(candidate.identity),
        );
        return candidate;
      }

      if (
        pointer !== null &&
        pointer.active.identity.browserRevision !== candidate.identity.browserRevision
      ) {
        const allowed =
          options.allowBrowserRevisionChange === undefined
            ? false
            : yield* options.allowBrowserRevisionChange({ active: pointer.active, candidate });
        if (!allowed) return yield* Effect.fail(hostError("changing-browser-revision"));
      }

      const installed = yield* installRelease({ paths, release: options.release });
      yield* makeDisposableValidation({
        platform: options.platform,
        paths,
        release: options.release,
        installed,
        validateCandidate: options.validateCandidate,
      });
      yield* materializeStableExtension(
        installed.extensionDirectory,
        paths.extensionRoot,
        chatGptBrowserManagedExtensionBuildId(candidate.identity),
      );
      yield* writePointer(
        options.platform,
        paths,
        pointerForActivation(candidate, pointer?.active),
      );
      return candidate;
    }),
  );

  const rollbackProviderRelease = lifecycleLock.withPermit(
    Effect.gen(function* () {
      yield* requireIdle("rolling-back-provider-while-browser-open");
      const paths = yield* platformPaths;
      const pointer = yield* readPointer(paths);
      if (pointer?.previous === undefined) return false;
      if (pointer.previous.identity.browserRevision !== pointer.active.identity.browserRevision) {
        return yield* Effect.fail(hostError("rolling-back-browser-revision"));
      }
      const installed = yield* requireInstalledRelease({ paths, release: pointer.previous });
      yield* materializeStableExtension(
        installed.extensionDirectory,
        paths.extensionRoot,
        chatGptBrowserManagedExtensionBuildId(pointer.previous.identity),
      );
      yield* writePointer(
        options.platform,
        paths,
        pointerForActivation(pointer.previous, pointer.active),
      );
      return true;
    }),
  );

  const open = lifecycleLock.withPermit(
    Effect.gen(function* () {
      yield* requireIdle("opening-browser-while-browser-open");
      const paths = yield* platformPaths;
      const issues = yield* options.platform.checkPrerequisites;
      if (issues.length > 0)
        return yield* Effect.fail(hostError("checking-browser-prerequisites", issues));

      let pointer = yield* readPointer(paths);
      if (pointer === null) {
        const installed = yield* installRelease({ paths, release: options.release });
        yield* makeDisposableValidation({
          platform: options.platform,
          paths,
          release: options.release,
          installed,
          validateCandidate: options.validateCandidate,
        });
        const release = descriptorFromSource(options.release);
        yield* materializeStableExtension(
          installed.extensionDirectory,
          paths.extensionRoot,
          chatGptBrowserManagedExtensionBuildId(release.identity),
        );
        pointer = pointerForActivation(release, undefined);
        yield* writePointer(options.platform, paths, pointer);
      }

      if (pointer.active.identity.target !== options.platform.target) {
        return yield* Effect.fail(hostError("matching-active-platform-target"));
      }
      const installed = yield* requireInstalledRelease({ paths, release: pointer.active });
      yield* materializeStableExtension(
        installed.extensionDirectory,
        paths.extensionRoot,
        chatGptBrowserManagedExtensionBuildId(pointer.active.identity),
      );
      yield* tryFs("preparing-browser-profile", () =>
        NodeFs.mkdir(paths.profileDirectory, { recursive: true }),
      );
      const process = yield* options.platform.launchBrowser({
        executablePath: installed.browserExecutablePath,
        profileDirectory: paths.profileDirectory,
        extensionRoot: paths.extensionRoot,
        args: pointer.active.browserArgs ?? [],
      });
      sessionOpen = true;

      const stopProcess = options.platform.stopBrowser(process).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            sessionOpen = false;
          }),
        ),
      );

      const transport = yield* options
        .connectTransport({
          release: pointer.active,
          browserExecutablePath: installed.browserExecutablePath,
          profileDirectory: paths.profileDirectory,
          extensionRoot: paths.extensionRoot,
          process,
        })
        .pipe(Effect.onError(() => stopProcess.pipe(Effect.ignore)));
      const closeLock = Semaphore.makeUnsafe(1);
      let closed = false;
      const close = closeLock.withPermit(
        Effect.suspend(() => {
          if (closed) return Effect.void;
          return stopProcess.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                closed = true;
              }),
            ),
          );
        }),
      );
      return {
        identity: pointer.active.identity,
        transport,
        close,
      } satisfies ChatGptBrowserHostSession;
    }),
  );

  return { open, prepareRelease, rollbackProviderRelease, activeRelease };
}
