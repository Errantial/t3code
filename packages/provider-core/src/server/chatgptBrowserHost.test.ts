// @effect-diagnostics nodeBuiltinImport:off - lifecycle tests exercise real temp-directory,
// inode-preserving materialization and atomic-rename behavior without launching a real browser.
import { promises as NodeFs } from "node:fs";
import * as NodeOs from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import {
  chatGptBrowserManagedExtensionBuildId,
  makeChatGptBrowserHost,
  type ChatGptBrowserManagedReleaseSource,
} from "./chatgptBrowserHost.ts";
import {
  ChatGptBrowserHostError,
  type ChatGptBrowserPlatformPaths,
  type ChatGptBrowserPlatformPort,
  type ChatGptBrowserProviderV1Transport,
} from "./chatgptBrowserProviderV1.ts";

const hostError = (operation: string, cause?: unknown) =>
  new ChatGptBrowserHostError({ operation, ...(cause === undefined ? {} : { cause }) });

const fsEffect = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({ try: run, catch: (cause) => hostError(operation, cause) });

const unusedTransport: ChatGptBrowserProviderV1Transport = {
  identity: Effect.die("unused transport identity"),
  send: () => Effect.die("unused transport send"),
  queryOperation: () => Effect.die("unused transport query"),
  replay: () => Effect.die("unused transport replay"),
  cancel: () => Effect.die("unused transport cancel"),
  readFinalContent: () => Effect.die("unused transport content"),
};

interface PlatformFixture {
  readonly platform: ChatGptBrowserPlatformPort;
  readonly paths: ChatGptBrowserPlatformPaths;
  readonly launches: Array<{
    readonly executablePath: string;
    readonly profileDirectory: string;
    readonly extensionRoot: string;
    readonly args: ReadonlyArray<string>;
    readonly visible?: boolean;
  }>;
  readonly stops: string[];
  readonly pointerWrites: string[];
}

const makePlatform = (base: string): PlatformFixture => {
  const paths: ChatGptBrowserPlatformPaths = {
    providerVersionsDirectory: NodePath.join(base, "provider-versions"),
    browserVersionsDirectory: NodePath.join(base, "browser-versions"),
    profileDirectory: NodePath.join(base, "profile"),
    extensionRoot: NodePath.join(base, "extension"),
    activeProviderPointer: NodePath.join(base, "state", "active-provider.json"),
  };
  const launches: PlatformFixture["launches"] = [];
  const stops: string[] = [];
  const pointerWrites: string[] = [];
  let processOrdinal = 0;
  return {
    paths,
    launches,
    stops,
    pointerWrites,
    platform: {
      target: "windows-x64",
      paths: Effect.succeed(paths),
      checkPrerequisites: Effect.succeed([]),
      launchBrowser: (input) =>
        Effect.sync(() => {
          launches.push(input);
          processOrdinal += 1;
          return { opaqueId: `browser-${processOrdinal}` };
        }),
      stopBrowser: (handle) =>
        Effect.sync(() => {
          stops.push(handle.opaqueId);
        }),
      replaceFileAtomically: ({ path, contents }) =>
        fsEffect("test-pointer-write", async () => {
          await NodeFs.mkdir(NodePath.dirname(path), { recursive: true });
          const temporary = `${path}.next`;
          await NodeFs.writeFile(temporary, contents);
          await NodeFs.rm(path, { force: true });
          await NodeFs.rename(temporary, path);
          pointerWrites.push(new TextDecoder().decode(contents));
        }),
      readSecret: () => Effect.succeed(null),
      writeSecret: () => Effect.void,
      deleteSecret: () => Effect.void,
    },
  };
};

const writeReleaseSource = (input: {
  readonly base: string;
  readonly providerReleaseVersion: string;
  readonly browserRevision?: string;
  readonly extensionVersion?: string;
  readonly background?: string;
}): Effect.Effect<ChatGptBrowserManagedReleaseSource, ChatGptBrowserHostError> =>
  fsEffect("test-release-source", async () => {
    const browserRevision = input.browserRevision ?? "chromium-1";
    const extensionVersion = input.extensionVersion ?? input.providerReleaseVersion;
    const root = NodePath.join(
      input.base,
      "sources",
      `${input.providerReleaseVersion}-${browserRevision}-${extensionVersion}`,
    );
    const browserSourceDirectory = NodePath.join(root, "browser");
    const providerSourceDirectory = NodePath.join(root, "provider");
    const extensionDirectory = NodePath.join(providerSourceDirectory, "extension");
    await NodeFs.mkdir(browserSourceDirectory, { recursive: true });
    await NodeFs.mkdir(extensionDirectory, { recursive: true });
    await NodeFs.writeFile(NodePath.join(browserSourceDirectory, "chromium.exe"), "browser");
    await NodeFs.writeFile(
      NodePath.join(extensionDirectory, "manifest.json"),
      JSON.stringify({ manifest_version: 3, version: extensionVersion }),
    );
    await NodeFs.writeFile(
      NodePath.join(extensionDirectory, "background.js"),
      input.background ?? `provider ${input.providerReleaseVersion}`,
    );
    return {
      identity: {
        target: "windows-x64",
        browserRevision,
        providerReleaseVersion: input.providerReleaseVersion,
        extensionVersion,
      },
      browserSourceDirectory,
      providerSourceDirectory,
      browserExecutableRelativePath: "chromium.exe",
      extensionRelativePath: "extension",
      browserArgs: ["--provider-runtime"],
      validationArgs: ["--candidate-validation"],
    };
  });

const withTempRoot = <A, E>(
  use: (base: string) => Effect.Effect<A, E>,
): Effect.Effect<A, E | ChatGptBrowserHostError> =>
  Effect.gen(function* () {
    const base = yield* fsEffect("test-temp-root", () =>
      NodeFs.mkdtemp(NodePath.join(NodeOs.tmpdir(), "t3-chatgpt-browser-host-")),
    );
    return yield* use(base).pipe(
      Effect.ensuring(
        fsEffect("test-cleanup", () => NodeFs.rm(base, { recursive: true, force: true })).pipe(
          Effect.ignore,
        ),
      ),
    );
  });

const readPointer = (path: string) =>
  fsEffect(
    "test-read-pointer",
    async () => JSON.parse(await NodeFs.readFile(path, "utf8")) as unknown,
  );

const readText = (path: string) => fsEffect("test-read-text", () => NodeFs.readFile(path, "utf8"));
const statPath = (path: string) => fsEffect("test-stat-path", () => NodeFs.stat(path));
const pathExists = (path: string) =>
  fsEffect("test-path-exists", async () => {
    try {
      await NodeFs.access(path);
      return true;
    } catch {
      return false;
    }
  });

describe("ChatGPT managed browser host", () => {
  it.effect(
    "bootstraps immutable assets, validates in a disposable profile, and launches the durable profile",
    () =>
      withTempRoot((base) =>
        Effect.gen(function* () {
          const fixture = makePlatform(base);
          const release = yield* writeReleaseSource({ base, providerReleaseVersion: "provider-1" });
          let validationProfile = "";
          let validationExtension = "";
          let validationBuildStamp = "";
          const host = makeChatGptBrowserHost({
            platform: fixture.platform,
            release,
            validateCandidate: (input) =>
              fsEffect("test-validation-build-stamp", async () => {
                validationProfile = input.profileDirectory;
                validationExtension = input.extensionRoot;
                validationBuildStamp = (
                  await NodeFs.readFile(
                    NodePath.join(input.extensionRoot, "build-stamp.txt"),
                    "utf8",
                  )
                ).trim();
              }),
            connectTransport: () => Effect.succeed(unusedTransport),
          });

          const session = yield* host.open;
          expect(session.identity).toEqual(release.identity);
          expect(fixture.launches).toHaveLength(2);
          expect(fixture.launches[0]?.profileDirectory).toBe(validationProfile);
          expect(fixture.launches[0]?.extensionRoot).toBe(validationExtension);
          expect(validationProfile).not.toBe(fixture.paths.profileDirectory);
          expect(validationExtension).not.toBe(fixture.paths.extensionRoot);
          expect(fixture.launches[1]?.profileDirectory).toBe(fixture.paths.profileDirectory);
          expect(fixture.launches[1]?.extensionRoot).toBe(fixture.paths.extensionRoot);
          expect(fixture.launches[1]?.args).toEqual(["--provider-runtime"]);
          expect(yield* readText(NodePath.join(fixture.paths.extensionRoot, "background.js"))).toBe(
            "provider provider-1",
          );
          expect(
            (yield* readText(NodePath.join(fixture.paths.extensionRoot, "build-stamp.txt"))).trim(),
          ).toBe(chatGptBrowserManagedExtensionBuildId(release.identity));
          expect(
            yield* readText(NodePath.join(fixture.paths.extensionRoot, "managed-build.js")),
          ).toContain(JSON.stringify(chatGptBrowserManagedExtensionBuildId(release.identity)));
          expect(validationBuildStamp).toBe(
            chatGptBrowserManagedExtensionBuildId(release.identity),
          );
          expect(yield* statPath(fixture.paths.profileDirectory)).toBeDefined();
          expect(yield* pathExists(NodePath.dirname(validationProfile))).toBe(false);

          expect(
            yield* readText(
              NodePath.join(fixture.paths.browserVersionsDirectory, "chromium-1", "chromium.exe"),
            ),
          ).toBe("browser");
          expect(
            yield* readText(
              NodePath.join(
                fixture.paths.providerVersionsDirectory,
                "provider-1",
                "extension",
                "manifest.json",
              ),
            ),
          ).toContain("provider-1");
          expect(fixture.pointerWrites).toHaveLength(1);

          yield* session.close;
          yield* session.close;
          expect(fixture.stops).toEqual(["browser-1", "browser-2"]);
          const interactive = yield* host.openWithBrowserArgs(
            ["--provider-runtime", "--window-position=80,80"],
            { visible: true },
          );
          expect(fixture.launches[2]?.profileDirectory).toBe(fixture.paths.profileDirectory);
          expect(fixture.launches[2]?.args).toEqual([
            "--provider-runtime",
            "--window-position=80,80",
          ]);
          expect(fixture.launches[2]?.visible).toBe(true);
          yield* interactive.close;
          expect(fixture.stops).toEqual(["browser-1", "browser-2", "browser-3"]);
          expect(yield* statPath(fixture.paths.profileDirectory)).toBeDefined();
        }),
      ),
  );

  it.effect(
    "updates the provider in place and rolls it back without replacing the extension root",
    () =>
      withTempRoot((base) =>
        Effect.gen(function* () {
          const fixture = makePlatform(base);
          const release1 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-1",
          });
          const host1 = makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release1,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          });
          yield* host1.prepareRelease;
          const publishedInode = (yield* statPath(fixture.paths.extensionRoot)).ino;

          const release2 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-2",
          });
          const host2 = makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release2,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          });
          yield* host2.prepareRelease;
          expect((yield* statPath(fixture.paths.extensionRoot)).ino).toBe(publishedInode);
          expect(yield* readText(NodePath.join(fixture.paths.extensionRoot, "background.js"))).toBe(
            "provider provider-2",
          );
          expect(
            (yield* readText(NodePath.join(fixture.paths.extensionRoot, "build-stamp.txt"))).trim(),
          ).toBe(chatGptBrowserManagedExtensionBuildId(release2.identity));

          const activated = (yield* readPointer(fixture.paths.activeProviderPointer)) as {
            active: { identity: { providerReleaseVersion: string } };
            previous: { identity: { providerReleaseVersion: string } };
          };
          expect(activated.active.identity.providerReleaseVersion).toBe("provider-2");
          expect(activated.previous.identity.providerReleaseVersion).toBe("provider-1");

          expect(yield* host2.rollbackProviderRelease).toBe(true);
          expect((yield* statPath(fixture.paths.extensionRoot)).ino).toBe(publishedInode);
          expect(yield* readText(NodePath.join(fixture.paths.extensionRoot, "background.js"))).toBe(
            "provider provider-1",
          );
          expect(
            (yield* readText(NodePath.join(fixture.paths.extensionRoot, "build-stamp.txt"))).trim(),
          ).toBe(chatGptBrowserManagedExtensionBuildId(release1.identity));
          const rolledBack = (yield* readPointer(fixture.paths.activeProviderPointer)) as {
            active: { identity: { providerReleaseVersion: string } };
            previous: { identity: { providerReleaseVersion: string } };
          };
          expect(rolledBack.active.identity.providerReleaseVersion).toBe("provider-1");
          expect(rolledBack.previous.identity.providerReleaseVersion).toBe("provider-2");
        }),
      ),
  );

  it.effect(
    "refreshes the generated extension build identity when release identity changes but source bytes do not",
    () =>
      withTempRoot((base) =>
        Effect.gen(function* () {
          const fixture = makePlatform(base);
          const source = { extensionVersion: "1.0.0", background: "same provider bytes" } as const;
          const release1 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-build-1",
            ...source,
          });
          yield* makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release1,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          }).prepareRelease;
          const publishedInode = (yield* statPath(fixture.paths.extensionRoot)).ino;
          const firstBuild = chatGptBrowserManagedExtensionBuildId(release1.identity);
          expect(
            (yield* readText(NodePath.join(fixture.paths.extensionRoot, "build-stamp.txt"))).trim(),
          ).toBe(firstBuild);

          const release2 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-build-2",
            ...source,
          });
          yield* makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release2,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          }).prepareRelease;

          const secondBuild = chatGptBrowserManagedExtensionBuildId(release2.identity);
          expect(secondBuild).not.toBe(firstBuild);
          expect((yield* statPath(fixture.paths.extensionRoot)).ino).toBe(publishedInode);
          expect(
            (yield* readText(NodePath.join(fixture.paths.extensionRoot, "build-stamp.txt"))).trim(),
          ).toBe(secondBuild);
          expect(
            yield* readText(NodePath.join(fixture.paths.extensionRoot, "managed-build.js")),
          ).toContain(JSON.stringify(secondBuild));
        }),
      ),
  );

  it.effect(
    "repairs the stable extension from the active immutable release without revalidating",
    () =>
      withTempRoot((base) =>
        Effect.gen(function* () {
          const fixture = makePlatform(base);
          const release = yield* writeReleaseSource({ base, providerReleaseVersion: "provider-1" });
          let validations = 0;
          const host = makeChatGptBrowserHost({
            platform: fixture.platform,
            release,
            validateCandidate: () =>
              Effect.sync(() => {
                validations += 1;
              }),
            connectTransport: () => Effect.succeed(unusedTransport),
          });
          yield* host.prepareRelease;
          const publishedInode = (yield* statPath(fixture.paths.extensionRoot)).ino;
          yield* fsEffect("test-damage-extension", () =>
            NodeFs.writeFile(
              NodePath.join(fixture.paths.extensionRoot, "background.js"),
              "damaged",
            ),
          );

          yield* host.prepareRelease;
          expect(validations).toBe(1);
          expect((yield* statPath(fixture.paths.extensionRoot)).ino).toBe(publishedInode);
          expect(yield* readText(NodePath.join(fixture.paths.extensionRoot, "background.js"))).toBe(
            "provider provider-1",
          );
        }),
      ),
  );

  it.effect("leaves the active release untouched when disposable candidate validation fails", () =>
    withTempRoot((base) =>
      Effect.gen(function* () {
        const fixture = makePlatform(base);
        const release1 = yield* writeReleaseSource({ base, providerReleaseVersion: "provider-1" });
        yield* makeChatGptBrowserHost({
          platform: fixture.platform,
          release: release1,
          validateCandidate: () => Effect.void,
          connectTransport: () => Effect.succeed(unusedTransport),
        }).prepareRelease;

        const release2 = yield* writeReleaseSource({ base, providerReleaseVersion: "provider-2" });
        const failed = makeChatGptBrowserHost({
          platform: fixture.platform,
          release: release2,
          validateCandidate: () => Effect.fail(hostError("candidate-health-check")),
          connectTransport: () => Effect.succeed(unusedTransport),
        });
        const error = yield* failed.prepareRelease.pipe(Effect.flip);
        expect(error.operation).toBe("candidate-health-check");
        const pointer = (yield* readPointer(fixture.paths.activeProviderPointer)) as {
          active: { identity: { providerReleaseVersion: string } };
        };
        expect(pointer.active.identity.providerReleaseVersion).toBe("provider-1");
        expect(yield* readText(NodePath.join(fixture.paths.extensionRoot, "background.js"))).toBe(
          "provider provider-1",
        );
      }),
    ),
  );

  it.effect(
    "requires an explicit browser revision gate and never rolls the profile back across revisions",
    () =>
      withTempRoot((base) =>
        Effect.gen(function* () {
          const fixture = makePlatform(base);
          const release1 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-1",
          });
          yield* makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release1,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          }).prepareRelease;

          const release2 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-2",
            browserRevision: "chromium-2",
          });
          const blocked = makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release2,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          });
          expect((yield* blocked.prepareRelease.pipe(Effect.flip)).operation).toBe(
            "changing-browser-revision",
          );

          const allowed = makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release2,
            allowBrowserRevisionChange: () => Effect.succeed(true),
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          });
          yield* allowed.prepareRelease;
          expect((yield* allowed.rollbackProviderRelease.pipe(Effect.flip)).operation).toBe(
            "rolling-back-browser-revision",
          );
          const pointer = (yield* readPointer(fixture.paths.activeProviderPointer)) as {
            active: { identity: { browserRevision: string } };
          };
          expect(pointer.active.identity.browserRevision).toBe("chromium-2");
        }),
      ),
  );

  it.effect("refuses to mutate lifecycle state while the managed browser session is open", () =>
    withTempRoot((base) =>
      Effect.gen(function* () {
        const fixture = makePlatform(base);
        const release = yield* writeReleaseSource({ base, providerReleaseVersion: "provider-1" });
        const host = makeChatGptBrowserHost({
          platform: fixture.platform,
          release,
          validateCandidate: () => Effect.void,
          connectTransport: () => Effect.succeed(unusedTransport),
        });
        const session = yield* host.open;
        expect((yield* host.prepareRelease.pipe(Effect.flip)).operation).toBe(
          "preparing-release-while-browser-open",
        );
        expect((yield* host.rollbackProviderRelease.pipe(Effect.flip)).operation).toBe(
          "rolling-back-provider-while-browser-open",
        );
        expect((yield* host.open.pipe(Effect.flip)).operation).toBe(
          "opening-browser-while-browser-open",
        );
        yield* session.close;
        expect(yield* host.activeRelease).toEqual({
          identity: release.identity,
          browserExecutableRelativePath: "chromium.exe",
          extensionRelativePath: "extension",
          browserArgs: ["--provider-runtime"],
        });
      }),
    ),
  );

  it.effect(
    "treats a reused immutable provider version with different contents as a conflict",
    () =>
      withTempRoot((base) =>
        Effect.gen(function* () {
          const fixture = makePlatform(base);
          const release1 = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-1",
          });
          yield* makeChatGptBrowserHost({
            platform: fixture.platform,
            release: release1,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          }).prepareRelease;

          const conflicting = yield* writeReleaseSource({
            base,
            providerReleaseVersion: "provider-1",
            extensionVersion: "different-extension",
            background: "different provider bits",
          });
          const host = makeChatGptBrowserHost({
            platform: fixture.platform,
            release: conflicting,
            validateCandidate: () => Effect.void,
            connectTransport: () => Effect.succeed(unusedTransport),
          });
          expect((yield* host.prepareRelease.pipe(Effect.flip)).operation).toBe(
            "installing-provider-immutable-version-conflict",
          );
          expect(yield* readText(NodePath.join(fixture.paths.extensionRoot, "background.js"))).toBe(
            "provider provider-1",
          );
        }),
      ),
  );
});
