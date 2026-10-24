// @effect-diagnostics nodeBuiltinImport:off - Tests exercise root env file precedence directly.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  DesktopConnectPublicConfigError,
  loadRepoEnv,
  resolveDesktopConnectPublicConfig,
} from "./public-config.ts";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    NodeFS.rmSync(directory, { recursive: true, force: true });
  }
});

describe("loadRepoEnv", () => {
  it("applies process, root local, and root precedence in that order", () => {
    const repoRoot = makeTemporaryDirectory();
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_root\nT3CODE_CLERK_JWT_TEMPLATE=template_root\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_root\nT3CODE_RELAY_URL=https://root.example.test\n",
    );
    NodeFS.writeFileSync(
      NodePath.join(repoRoot, ".env.local"),
      "T3CODE_CLERK_PUBLISHABLE_KEY=pk_local\nT3CODE_CLERK_JWT_TEMPLATE=template_local\nT3CODE_CLERK_CLI_OAUTH_CLIENT_ID=oauth_local\nT3CODE_RELAY_URL=https://local.example.test\n",
    );

    expect(loadRepoEnv({ baseEnv: {}, repoRoot }).T3CODE_RELAY_URL).toBe(
      "https://local.example.test",
    );
    expect(
      loadRepoEnv({
        baseEnv: {
          T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
          T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
          T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
          T3CODE_RELAY_URL: "https://ci.example.test",
        },
        repoRoot,
      }),
    ).toMatchObject({
      T3CODE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth_ci",
      VITE_CLERK_PUBLISHABLE_KEY: "pk_ci",
      EXPO_PUBLIC_CLERK_PUBLISHABLE_KEY: "pk_ci",
      T3CODE_CLERK_JWT_TEMPLATE: "template_ci",
      VITE_CLERK_JWT_TEMPLATE: "template_ci",
      EXPO_PUBLIC_CLERK_JWT_TEMPLATE: "template_ci",
      T3CODE_RELAY_URL: "https://ci.example.test",
      VITE_T3CODE_RELAY_URL: "https://ci.example.test",
    });
  });
});

describe("resolveDesktopConnectPublicConfig", () => {
  const completeConfig = {
    T3CODE_CLERK_PUBLISHABLE_KEY: `pk_live_${btoa("clerk.example.test$")}`,
    T3CODE_CLERK_JWT_TEMPLATE: "t3-relay",
    T3CODE_CLERK_CLI_OAUTH_CLIENT_ID: "oauth-client-id",
    T3CODE_RELAY_URL: "https://relay.example.test/",
  } as const;

  it("accepts complete production public config and normalizes the relay origin", () => {
    expect(resolveDesktopConnectPublicConfig(completeConfig)).toEqual({
      clerkPublishableKey: completeConfig.T3CODE_CLERK_PUBLISHABLE_KEY,
      clerkJwtTemplate: "t3-relay",
      clerkCliOAuthClientId: "oauth-client-id",
      relayUrl: "https://relay.example.test",
    });
  });

  it("rejects a missing JWT template", () => {
    const { T3CODE_CLERK_JWT_TEMPLATE: _, ...withoutJwtTemplate } = completeConfig;

    expect(() => resolveDesktopConnectPublicConfig(withoutJwtTemplate)).toThrowError(
      new DesktopConnectPublicConfigError("missing", ["T3CODE_CLERK_JWT_TEMPLATE"]),
    );
  });

  it("reports all missing relay and Clerk public values", () => {
    expect(() => resolveDesktopConnectPublicConfig({})).toThrowError(
      new DesktopConnectPublicConfigError("missing", [
        "T3CODE_RELAY_URL",
        "T3CODE_CLERK_PUBLISHABLE_KEY",
        "T3CODE_CLERK_JWT_TEMPLATE",
        "T3CODE_CLERK_CLI_OAUTH_CLIENT_ID",
      ]),
    );
  });

  it("rejects malformed relay and Clerk public values without including their contents", () => {
    const invalidRelay = "http://relay-user:relay-secret@example.test/path?token=secret";
    try {
      resolveDesktopConnectPublicConfig({ ...completeConfig, T3CODE_RELAY_URL: invalidRelay });
      expect.unreachable("Expected invalid relay config to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopConnectPublicConfigError);
      expect((error as Error).message).not.toContain(invalidRelay);
      expect((error as DesktopConnectPublicConfigError).reason).toBe("invalid-relay-url");
    }

    const invalidPublishableKey = "pk_live_%private";
    try {
      resolveDesktopConnectPublicConfig({
        ...completeConfig,
        T3CODE_CLERK_PUBLISHABLE_KEY: invalidPublishableKey,
      });
      expect.unreachable("Expected invalid Clerk config to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(DesktopConnectPublicConfigError);
      expect((error as Error).message).not.toContain(invalidPublishableKey);
      expect((error as DesktopConnectPublicConfigError).reason).toBe(
        "invalid-clerk-publishable-key",
      );
    }
  });
});

function makeTemporaryDirectory() {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3code-public-config-"));
  temporaryDirectories.push(directory);
  return directory;
}
