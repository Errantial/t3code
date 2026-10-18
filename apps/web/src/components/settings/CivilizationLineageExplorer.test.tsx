import {
  CivilizationLineageCursor,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CivilizationCitizenSummary,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment-lineage-ui");
const projectId = ProjectId.make("project-lineage-ui");
const rootId = ThreadId.make("thread-lineage-root");
const childId = ThreadId.make("thread-lineage-child");
const nextCursor = CivilizationLineageCursor.make("lineage-next");
const testState = vi.hoisted(() => ({ calls: [] as unknown[][] }));

const citizen = (
  threadId: ThreadId,
  name: string,
  generation: number,
  parentThreadId: ThreadId | null,
): CivilizationCitizenSummary => ({
  threadId,
  projectId,
  name,
  profileId: "calm",
  profileLabel: "Calm",
  generation,
  lineageStatus: "resolved",
  parentThreadId,
  relationshipToParent: parentThreadId === null ? null : "fork",
  observedOnly: false,
  epoch: 0,
  closed: false,
  deleted: false,
  titleManaged: true,
  revision: 1,
});

const root = citizen(rootId, "Root Ada", 0, null);
const child = citizen(childId, "Child Grace", 1, rootId);

vi.mock("../../state/civilization", () => ({
  useCivilizationLineageNeighborhood: (...args: unknown[]) => {
    testState.calls.push(args);
    const threadId = args[2] as ThreadId;
    const cursor = args[3] as CivilizationLineageCursor | null;
    if (threadId === childId) {
      return {
        data: {
          projectId,
          revision: 2,
          focus: child,
          parent: root,
          parentAvailability: "visible",
          children: [],
          nextCursor: null,
          partial: false,
        },
        error: null,
        isPending: false,
        refresh: vi.fn(),
      };
    }
    return {
      data: {
        projectId,
        revision: 2,
        focus: root,
        parent: null,
        parentAvailability: "none",
        children: cursor === null ? [child] : [],
        nextCursor: cursor === null ? nextCursor : null,
        partial: cursor === null,
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

import { CivilizationLineageExplorer } from "./CivilizationLineageExplorer";

let renderer: ReactTestRenderer | undefined;
const render = async () => {
  await act(() => {
    renderer = create(
      <CivilizationLineageExplorer
        environmentId={environmentId}
        projectId={projectId}
        initialThreadId={rootId}
        pageSize={50}
        onClose={vi.fn()}
      />,
    );
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.calls = [];
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization Ancestral Hall", () => {
  it("loads one bounded neighborhood and navigates by changing focus", async () => {
    await render();
    expect(JSON.stringify(renderer?.toJSON())).toContain("Root Ada");
    expect(JSON.stringify(renderer?.toJSON())).toContain("Child Grace");
    expect(testState.calls.at(-1)?.slice(0, 5)).toEqual([
      environmentId,
      projectId,
      rootId,
      null,
      50,
    ]);

    const childButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "fork: Child Grace");
    expect(childButton).toBeDefined();
    await act(() => childButton!.props.onClick());

    expect(testState.calls.at(-1)?.[2]).toBe(childId);
    expect(JSON.stringify(renderer?.toJSON())).toContain("Parent: Root Ada");
  });

  it("paginates direct descendants with the opaque lineage cursor", async () => {
    await render();
    const next = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Next children");
    expect(next).toBeDefined();
    await act(() => next!.props.onClick());
    expect(testState.calls.at(-1)?.[3]).toBe(nextCursor);
  });

  it("cross-links the focused citizen using metadata-only identifiers", async () => {
    const onViewChronicle = vi.fn();
    const onViewCorrespondence = vi.fn();
    const onViewContext = vi.fn();
    await act(() => {
      renderer = create(
        <CivilizationLineageExplorer
          environmentId={environmentId}
          projectId={projectId}
          initialThreadId={rootId}
          pageSize={50}
          onClose={vi.fn()}
          onViewChronicle={onViewChronicle}
          onViewCorrespondence={onViewCorrespondence}
          onViewContext={onViewContext}
        />,
      );
    });
    for (const [label, callback] of [
      ["Chronicle", onViewChronicle],
      ["Correspondence", onViewCorrespondence],
      ["Context", onViewContext],
    ] as const) {
      const button = renderer!.root
        .findAllByType("button")
        .find((candidate) => candidate.props.children === label);
      await act(() => button!.props.onClick());
      expect(callback).toHaveBeenCalledWith(rootId);
    }
  });
});
