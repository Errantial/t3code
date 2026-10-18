import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  mobileCivilizationPermissionMessage,
  resolveMobileCivilizationTargets,
} from "./civilization-overview.logic";

describe("resolveMobileCivilizationTargets", () => {
  const firstEnvironmentId = EnvironmentId.make("environment-a");
  const secondEnvironmentId = EnvironmentId.make("environment-b");
  const firstProjectId = ProjectId.make("project-a");

  const environments = [
    { environmentId: firstEnvironmentId, label: "A" },
    { environmentId: secondEnvironmentId, label: "B" },
  ] as const;

  it("keeps environment scope exact when no project is selected", () => {
    expect(
      resolveMobileCivilizationTargets({
        environments,
        projectSelected: false,
        projectMembers: [],
      }),
    ).toEqual([
      { environmentId: firstEnvironmentId, label: "A", projectId: null },
      { environmentId: secondEnvironmentId, label: "B", projectId: null },
    ]);
  });

  it("includes only exact project checkouts on selected environments", () => {
    expect(
      resolveMobileCivilizationTargets({
        environments: [environments[0]],
        projectSelected: true,
        projectMembers: [
          { environmentId: firstEnvironmentId, id: firstProjectId },
          { environmentId: secondEnvironmentId, id: ProjectId.make("project-b") },
        ],
      }),
    ).toEqual([{ environmentId: firstEnvironmentId, label: "A", projectId: firstProjectId }]);
  });

  it("does not broaden a selected project when no checkout matches the selected environments", () => {
    expect(
      resolveMobileCivilizationTargets({
        environments: [environments[0]],
        projectSelected: true,
        projectMembers: [{ environmentId: secondEnvironmentId, id: ProjectId.make("project-b") }],
      }),
    ).toEqual([]);
  });
});

describe("mobileCivilizationPermissionMessage", () => {
  it("distinguishes permission checking, lookup failure, denial, and access", () => {
    expect(
      mobileCivilizationPermissionMessage({
        canRead: false,
        sessionAvailable: false,
        sessionFailed: false,
      }),
    ).toBe("Checking permissions…");
    expect(
      mobileCivilizationPermissionMessage({
        canRead: false,
        sessionAvailable: false,
        sessionFailed: true,
      }),
    ).toBe("Could not verify your permissions. Reconnect to try again.");
    expect(
      mobileCivilizationPermissionMessage({
        canRead: false,
        sessionAvailable: true,
        sessionFailed: false,
      }),
    ).toBe("Unavailable · orchestration:read required");
    expect(
      mobileCivilizationPermissionMessage({
        canRead: true,
        sessionAvailable: true,
        sessionFailed: false,
      }),
    ).toBeNull();
  });
});
