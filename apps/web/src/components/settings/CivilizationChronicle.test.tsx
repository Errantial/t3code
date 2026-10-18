import {
  CivilizationAchievementAwardId,
  CivilizationChronicleEntryId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CivilizationChronicleEntry,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment-chronicle-ui");
const projectId = ProjectId.make("project-chronicle-ui");
const parentId = ThreadId.make("thread-chronicle-parent");
const childId = ThreadId.make("thread-chronicle-child");
const testState = vi.hoisted(() => ({ calls: [] as unknown[][] }));

const award = {
  awardId: CivilizationAchievementAwardId.make("award:first-child"),
  projectId,
  achievementId: "first_descendant" as const,
  definitionVersion: 1,
  subjectThreadId: childId,
  triggerEntryId: CivilizationChronicleEntryId.make("chronicle:child"),
  awardedAt: "2026-10-17T20:00:00.000Z",
};

const entry: CivilizationChronicleEntry = {
  entryId: CivilizationChronicleEntryId.make("chronicle:child"),
  projectId,
  kind: "child_joined",
  primaryThreadId: childId,
  secondaryThreadId: parentId,
  citizenEpoch: 0,
  citizenRevision: 1,
  sourceKind: "host_event",
  sourceId: "event:child",
  sourceSequence: 42,
  occurredAt: "2026-10-17T20:00:00.000Z",
  metadata: { relationship: "fork" },
};

vi.mock("../../state/civilization", () => ({
  useCivilizationAchievementPage: (...args: unknown[]) => {
    testState.calls.push(["achievements", ...args]);
    return {
      data: {
        projectId,
        revision: 2,
        awards: [award],
        nextCursor: null,
        partial: false,
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
  useCivilizationChroniclePage: (...args: unknown[]) => {
    testState.calls.push(["chronicle", ...args]);
    return {
      data: {
        projectId,
        revision: 3,
        entries: [entry],
        nextCursor: null,
        partial: false,
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));

vi.mock("./settingsLayout", () => ({
  SettingsSection: ({ title, children }: { title: string; children: ReactNode }) => (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: string;
    description: string;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <p>{description}</p>
      {control}
    </div>
  ),
}));

import { CivilizationChronicle } from "./CivilizationChronicle";

let renderer: ReactTestRenderer | undefined;
const onViewLineage = vi.fn();

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.calls = [];
  onViewLineage.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization Chronicle", () => {
  it("renders structured provenance and links citizens without fetching bodies", async () => {
    await act(() => {
      renderer = create(
        <CivilizationChronicle
          environmentId={environmentId}
          projectId={projectId}
          pageSize={50}
          onViewLineage={onViewLineage}
        />,
      );
    });

    const rendered = JSON.stringify(renderer?.toJSON());
    expect(rendered).toContain("Child joined");
    expect(rendered).toContain("First descendant");
    expect(rendered).toContain("relationship ");
    expect(rendered).toContain("fork");
    expect(rendered).not.toContain("body");
    const chronicleCall = testState.calls.find((call) => call[0] === "chronicle");
    expect(chronicleCall?.slice(1, 6)).toEqual([
      environmentId,
      projectId,
      { kind: undefined },
      null,
      50,
    ]);

    const child = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === childId);
    expect(child).toBeDefined();
    await act(() => child!.props.onClick());
    expect(onViewLineage).toHaveBeenCalledWith(childId);
  });

  it("applies a citizen filter as one bounded Chronicle query", async () => {
    await act(() => {
      renderer = create(
        <CivilizationChronicle environmentId={environmentId} projectId={projectId} pageSize={25} />,
      );
    });
    const threadInput = renderer!.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "Chronicle citizen thread");
    expect(threadInput).toBeDefined();
    await act(() => threadInput!.props.onChange({ currentTarget: { value: childId } }));
    const apply = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply");
    await act(() => apply!.props.onClick());

    const chronicleCall = testState.calls.toReversed().find((call) => call[0] === "chronicle");
    expect(chronicleCall?.[3]).toEqual({ kind: undefined, threadId: childId });
    expect(chronicleCall?.[5]).toBe(25);
  });
});
