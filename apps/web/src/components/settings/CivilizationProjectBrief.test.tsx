import { EnvironmentId, ProjectId, type CivilizationProjectBriefDetail } from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  metadata: {
    projectId: "project-brief",
    revision: 7,
    configured: true,
    bodyBytes: 120,
    updatedAt: "2026-10-18T12:00:00.000Z",
  } as Record<string, unknown> | null,
  metadataCalls: [] as Array<readonly [string | null, string | null]>,
  metadataRefreshes: 0,
  writeAllowed: true,
  actionCalls: [] as unknown[],
  actionResults: [] as Array<
    | { readonly kind: "resolve"; readonly value: unknown }
    | { readonly kind: "reject"; readonly error: unknown }
  >,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomSet: () => async (input: unknown) => {
    state.actionCalls.push(input);
    const result = state.actionResults.shift();
    if (result === undefined) throw new Error("Unexpected Project Brief action in test.");
    if (result.kind === "reject") throw result.error;
    return result.value;
  },
}));

vi.mock("../../state/civilization", () => ({
  civilizationProjectBriefAction: Symbol("civilization-project-brief-action"),
  useCivilizationProjectBriefMetadata: (environmentId: string | null, projectId: string | null) => {
    state.metadataCalls.push([environmentId, projectId]);
    return {
      data: environmentId === null || projectId === null ? null : state.metadata,
      error: null,
      isPending: false,
      refresh: () => {
        state.metadataRefreshes += 1;
      },
    };
  },
}));

vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.writeAllowed,
}));

vi.mock("../ui/button", () => ({
  Button: ({
    children,
    variant: _variant,
    size: _size,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
}));

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/textarea", () => ({
  Textarea: (props: Record<string, unknown>) => <textarea {...props} />,
}));

vi.mock("../ui/dialog", () => ({
  Dialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));

vi.mock("../ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: ReactNode }) =>
    open ? <>{children}</> : null,
  AlertDialogClose: ({
    children,
    render: _render,
    ...props
  }: { children: ReactNode } & Record<string, unknown>) => <button {...props}>{children}</button>,
  AlertDialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  AlertDialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  AlertDialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  AlertDialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  AlertDialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
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
    description: ReactNode;
    control: ReactNode;
  }) => (
    <div>
      <h3>{title}</h3>
      <div>{description}</div>
      <div>{control}</div>
    </div>
  ),
}));

import { CivilizationProjectBrief } from "./CivilizationProjectBrief";

const environmentId = EnvironmentId.make("environment-brief");
const projectId = ProjectId.make("project-brief");

const detail = (
  revision: number,
  summary: string,
  configured = true,
): CivilizationProjectBriefDetail => ({
  projectId,
  revision,
  configured,
  bodyBytes: configured ? 180 : 0,
  updatedAt: "2026-10-18T12:00:00.000Z",
  content: configured
    ? {
        version: 1,
        summary,
        objectives: ["Ship safely"],
        constraints: ["Do not broaden authority"],
        references: [{ kind: "issue", reference: "V15-1" }],
      }
    : null,
});

let renderer: ReactTestRenderer | undefined;

const text = () => JSON.stringify(renderer?.toJSON());

const button = (label: string) =>
  renderer!.root.findAllByType("button").find((candidate) => candidate.props.children === label);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.metadata = {
    projectId,
    revision: 7,
    configured: true,
    bodyBytes: 120,
    updatedAt: "2026-10-18T12:00:00.000Z",
  };
  state.metadataCalls = [];
  state.metadataRefreshes = 0;
  state.writeAllowed = true;
  state.actionCalls = [];
  state.actionResults = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("CivilizationProjectBrief", () => {
  it("renders body-free metadata without prefetching detail and refuses non-exact targets", async () => {
    await act(() => {
      renderer = create(
        <CivilizationProjectBrief
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Exact checkout"
          canRead
          canWrite={false}
        />,
      );
    });

    expect(state.metadataCalls.at(-1)).toEqual([environmentId, projectId]);
    expect(state.actionCalls).toEqual([]);
    expect(text()).toContain("Revision 7");
    expect(text()).toContain("120 bytes");
    expect(text()).toContain("Metadata above remains body-free");
    expect(text()).toContain("Read only");

    await act(() => {
      renderer!.update(
        <CivilizationProjectBrief
          environmentId={environmentId}
          projectId={null}
          targetLabel="Environment scope"
          canRead
          canWrite
        />,
      );
    });
    expect(state.metadataCalls.at(-1)).toEqual([null, null]);
    expect(text()).toContain("Exact checkout required");
    expect(state.actionCalls).toEqual([]);
  });

  it("loads detail only on explicit open and saves the exact loaded revision", async () => {
    state.actionResults = [
      { kind: "resolve", value: detail(7, "Original summary") },
      { kind: "resolve", value: detail(8, "Locally edited summary") },
    ];
    await act(() => {
      renderer = create(
        <CivilizationProjectBrief
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Exact checkout"
          canRead
          canWrite
        />,
      );
    });
    expect(state.actionCalls).toEqual([]);

    await act(async () => {
      button("Review & edit…")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.actionCalls[0]).toEqual({ environmentId, type: "detail", projectId });
    expect(text()).toContain("4096");
    expect(text()).toContain("subordinate untrusted");

    const summary = renderer!.root.findByProps({ "aria-label": "Project Brief summary" });
    await act(() => summary.props.onChange({ currentTarget: { value: "Locally edited summary" } }));
    await act(async () => {
      button("Save Brief")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.actionCalls[1]).toMatchObject({
      environmentId,
      type: "set",
      request: {
        projectId,
        expectedRevision: 7,
        content: { summary: "Locally edited summary" },
      },
    });
    expect(text()).toContain("saved at revision 8");
    expect(state.metadataRefreshes).toBeGreaterThan(0);
  });

  it("preserves a local draft on conflict and reloads only after explicit review", async () => {
    state.actionResults = [
      { kind: "resolve", value: detail(7, "Original summary") },
      {
        kind: "reject",
        error: {
          _tag: "CivilizationProjectBriefConflictError",
          code: "civilization_project_brief_conflict",
          projectId,
          expectedRevision: 7,
          currentRevision: 8,
        },
      },
      { kind: "resolve", value: detail(8, "Server latest summary") },
    ];
    await act(() => {
      renderer = create(
        <CivilizationProjectBrief
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Exact checkout"
          canRead
          canWrite
        />,
      );
    });
    await act(async () => {
      button("Review & edit…")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    let summary = renderer!.root.findByProps({ "aria-label": "Project Brief summary" });
    await act(() => summary.props.onChange({ currentTarget: { value: "My preserved draft" } }));
    await act(async () => {
      button("Save Brief")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    summary = renderer!.root.findByProps({ "aria-label": "Project Brief summary" });
    expect(summary.props.value).toBe("My preserved draft");
    expect(state.actionCalls).toHaveLength(2);
    expect(text()).toContain("Your draft is preserved");
    expect(text()).toContain("Reload latest");

    await act(async () => {
      button("Reload latest")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    summary = renderer!.root.findByProps({ "aria-label": "Project Brief summary" });
    expect(summary.props.value).toBe("Server latest summary");
    expect(state.actionCalls).toHaveLength(3);
  });

  it("requires clear confirmation and sends the exact loaded revision", async () => {
    state.actionResults = [
      { kind: "resolve", value: detail(7, "Original summary") },
      { kind: "resolve", value: detail(8, "", false) },
    ];
    await act(() => {
      renderer = create(
        <CivilizationProjectBrief
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Exact checkout"
          canRead
          canWrite
        />,
      );
    });
    await act(async () => {
      button("Review & edit…")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    await act(() => button("Clear…")!.props.onClick());
    expect(text()).toContain("Clear Project Brief?");
    expect(text()).toContain("historical diagnostic packets");
    expect(state.actionCalls).toHaveLength(1);

    await act(async () => {
      button("Clear Brief")!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(state.actionCalls[1]).toEqual({
      environmentId,
      type: "clear",
      request: { projectId, expectedRevision: 7 },
    });
    expect(text()).toContain("cleared at revision 8");
  });

  it("rechecks settings:write before body reads and does not call the detail action after revocation", async () => {
    await act(() => {
      renderer = create(
        <CivilizationProjectBrief
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Exact checkout"
          canRead
          canWrite
        />,
      );
    });
    state.writeAllowed = false;
    await act(() => button("Review & edit…")!.props.onClick());

    expect(state.actionCalls).toEqual([]);
    expect(text()).toContain("Permission changed before body read");
  });
});
