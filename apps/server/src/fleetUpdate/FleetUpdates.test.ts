import type { ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { fleetMachineStatus, releaseVersionFromAssets } from "./FleetUpdates.ts";

const version = "0.1.5-v1.1.7.20261102.abcdef123456.connect1";

function descriptor(
  overrides: Partial<ExecutionEnvironmentDescriptor> & {
    readonly platform?: ExecutionEnvironmentDescriptor["platform"];
  } = {},
): ExecutionEnvironmentDescriptor {
  return {
    environmentId: EnvironmentId.make("environment-one"),
    label: "server-1",
    platform: { os: "linux", arch: "arm64" },
    serverVersion: version,
    capabilities: { repositoryIdentity: false, serverSelfUpdate: "boot-service" },
    ...overrides,
  };
}

describe("releaseVersionFromAssets", () => {
  it("reads one full version from the desktop and Linux asset names", () => {
    expect(
      releaseVersionFromAssets([
        `T3-Code-${version}-x64.exe`,
        `T3-Code-${version}-x64.exe.blockmap`,
        `t3-${version}-linux-arm64.tar.gz`,
        "latest.yml",
        "SHA256SUMS.txt",
        "t3onsteroids-1.1.7-source.zip",
      ]),
    ).toBe(version);
  });

  it("refuses releases whose assets disagree or name no version", () => {
    expect(
      releaseVersionFromAssets([
        `T3-Code-${version}-x64.exe`,
        "t3-0.1.5-v1.1.7.20261102.ffffffffffff.connect1-linux-arm64.tar.gz",
      ]),
    ).toBeNull();
    expect(releaseVersionFromAssets(["latest.yml", "SHA256SUMS.txt"])).toBeNull();
  });
});

describe("fleetMachineStatus", () => {
  it("marks a launcher-managed Linux server as a Linux service", () => {
    const status = fleetMachineStatus(descriptor());
    expect(status.platform).toBe("linux-arm64");
    expect(status.variant).toBe("linux-service");
    expect(status.updateSupported).toBe(true);
    expect(status.reason).toBeUndefined();
  });

  it("marks a Windows desktop app as updateable only when its updater is available", () => {
    const base = {
      platform: { os: "windows", arch: "x64" } as const,
      capabilities: { repositoryIdentity: false, serverSelfUpdate: "desktop-managed" as const },
    };
    expect(fleetMachineStatus(descriptor(base)).variant).toBe("windows-desktop");
    expect(fleetMachineStatus(descriptor(base)).updateSupported).toBe(false);
    expect(
      fleetMachineStatus(
        descriptor({ ...base, capabilities: { ...base.capabilities, desktopAppUpdate: true } }),
      ).updateSupported,
    ).toBe(true);
  });

  it("keeps an install without a background service on the manual path", () => {
    const status = fleetMachineStatus(
      descriptor({
        platform: { os: "linux", arch: "x64" },
        capabilities: { repositoryIdentity: false },
      }),
    );
    expect(status.variant).toBe("manual");
    expect(status.updateSupported).toBe(false);
    expect(status.reason).toContain("t3 service install");
  });
});
