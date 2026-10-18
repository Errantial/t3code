import {
  CivilizationDefaultConfig,
  CivilizationNoteId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const testState = vi.hoisted(() => ({
  writable: false,
  observedOnly: true,
  sensitiveCalls: [] as unknown[],
  citizenCalls: [] as unknown[],
  pageCalls: [] as unknown[],
}));

const atoms = vi.hoisted(() => ({
  sensitive: Symbol("sensitive"),
  citizen: Symbol("citizen"),
  page: Symbol("page"),
}));

const environmentId = EnvironmentId.make("environment-ui3");
const projectId = ProjectId.make("project-ui3");
const threadId = ThreadId.make("thread-ui3");
const noteId = CivilizationNoteId.make("note-ui3");

const EFFECTIVE = {
  config: CivilizationDefaultConfig,
  environmentRevision: 7,
  projectRevision: 9,
  provenance: [],
  selectedNameProbabilities: [],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

const citizen = {
  threadId,
  projectId,
  name: "Observed Ada",
  profileId: "calm",
  profileLabel: "Calm",
  generation: 1,
  lineageStatus: "resolved",
  parentThreadId: null,
  relationshipToParent: null,
  observedOnly: true,
  epoch: 2,
  closed: false,
  deleted: false,
  titleManaged: false,
  revision: 3,
} as const;

const note = {
  noteId,
  projectId,
  category: "fact",
  bodyBytes: 9,
  authorThreadId: threadId,
  authorEpoch: 2,
  acceptedRuntimeMode: "full-access",
  acceptedInteractionMode: "default",
  revision: 4,
  createdAt: "2026-10-16T18:00:00.000Z",
  updatedAt: "2026-10-16T18:01:00.000Z",
  resolvedAt: null,
} as const;

vi.mock("@effect/atom-react", () => ({
  useAtomSet: (atom: symbol) => async (input: unknown) => {
    if (atom === atoms.sensitive) {
      testState.sensitiveCalls.push(input);
      const typed = input as { type: string };
      return typed.type === "noteBody"
        ? { ...note, body: "secret note body", sourceReferences: [] }
        : (() => {
            throw new Error("unexpected sensitive read");
          })();
    }
    if (atom === atoms.citizen) {
      testState.citizenCalls.push(input);
      const typed = input as { type: string; request?: Record<string, unknown> };
      if (typed.type === "reassignmentPreview") {
        return {
          threadId,
          citizenRevision: 3,
          environmentRevision: 7,
          projectRevision: 9,
          current: {
            nameEntryId: "ada",
            name: "Observed Ada",
            profileEntryId: "calm",
            profileLabel: "Calm",
          },
          proposed: {
            nameEntryId: "ada",
            name: String(typed.request?.displayName ?? "Observed Ada"),
            profileEntryId: String(typed.request?.profileEntryId ?? "calm"),
            profileLabel: "Preview profile",
          },
        };
      }
      return { ...citizen, observedOnly: testState.observedOnly };
    }
    testState.pageCalls.push(input);
    throw new Error("Unexpected load-more action in test.");
  },
}));

vi.mock("../../state/civilization", () => ({
  civilizationCitizenAction: atoms.citizen,
  civilizationProjectReadAction: atoms.page,
  civilizationSensitiveReadAction: atoms.sensitive,
  mergeCivilizationRevisionPage: (current: unknown) => current,
  useCivilizationCensusPage: () => ({
    data: {
      projectId,
      revision: 10,
      citizens: [{ ...citizen, observedOnly: testState.observedOnly }],
      nextCursor: null,
      partial: false,
    },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
  useCivilizationCitizenDetail: (
    _environmentId: unknown,
    _projectId: unknown,
    selected: unknown,
  ) => ({
    data:
      selected === null
        ? null
        : {
            threadId,
            projectId,
            identity: {
              nameEntryId: "ada",
              namePoolId: "default-names",
              baseName: "Ada",
              displayName: "Observed Ada",
            },
            personality: {
              profileEntryId: "calm",
              profilePoolId: "default-profiles",
              base: { label: "Calm", traits: ["calm"], styleText: "Calm style" },
              rich: {
                label: "Stoic Architect",
                traits: ["deliberate"],
                axiom: "Build carefully.",
                voice: "Measured.",
                styleText: "Architectural style",
              },
            },
            presentation: { rendering: "off", label: null },
            host: { threadTitle: "Observed thread", providerInstanceId: "codex" },
            lineage: {
              generation: 1,
              status: "resolved",
              parentThreadId: null,
              relationshipToParent: null,
            },
            lifecycle: { state: "open", epoch: 2, closed: false, deleted: false },
            observedOnly: testState.observedOnly,
            title: {
              managed: false,
              topic: "Observed thread",
              preservedTitle: "Observed thread",
              lastManagedTitle: null,
              managedTitlePreview: "[Observed Ada] Observed thread",
            },
            revision: 3,
          },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
  useCivilizationNotesPage: () => ({
    data: { projectId, revision: 11, notes: [note], nextCursor: null, partial: false },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  }),
}));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => testState.writable,
  readEnvironmentScope: () => testState.writable,
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/switch", () => ({
  Switch: ({ onCheckedChange: _onCheckedChange, ...props }: Record<string, unknown>) => (
    <input type="checkbox" {...props} />
  ),
}));

vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
}));

vi.mock("./settingsLayout", () => ({
  SettingsSection: ({
    children,
    title,
    id,
  }: {
    children: ReactNode;
    title: string;
    id?: string;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
  }) => (
    <div>
      <span>{title}</span>
      <span>{description}</span>
      {control}
    </div>
  ),
}));

vi.mock("./CivilizationDataRetention", () => ({
  CivilizationDataRetention: () => <div data-testid="civilization-data-retention" />,
}));

vi.mock("./CivilizationCitizenDetailDialog", () => ({
  CivilizationCitizenDetailDialog: ({
    open,
    canAdminister,
  }: {
    open: boolean;
    canAdminister: boolean;
  }) =>
    open ? <div>Citizen detail editor · {canAdminister ? "editable" : "read only"}</div> : null,
}));

vi.mock("./CivilizationChronicle", () => ({
  CivilizationChronicle: () => <div data-testid="civilization-chronicle" />,
}));

vi.mock("./CivilizationCorrespondenceHistory", () => ({
  CivilizationCorrespondenceHistory: ({
    allowSensitiveActions,
  }: {
    allowSensitiveActions: boolean;
  }) => (
    <div>
      Correspondence history ·{" "}
      {!testState.writable
        ? "Restricted"
        : allowSensitiveActions
          ? "Administrative inspection"
          : "Select one environment"}
    </div>
  ),
}));

import { CivilizationProjectInspection } from "./CivilizationProjectInspection";

let renderer: ReactTestRenderer | undefined;

const render = async (
  allowSensitiveActions = true,
  mode?: "citizens" | "chronicle" | "messages" | "notes" | "data",
) => {
  await act(() => {
    renderer = create(
      <CivilizationProjectInspection
        environmentId={environmentId}
        projectId={projectId}
        targetLabel="UI-3 machine"
        effective={EFFECTIVE}
        allowSensitiveActions={allowSensitiveActions}
        mode={mode}
      />,
    );
  });
};

const text = () => JSON.stringify(renderer?.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.writable = false;
  testState.observedOnly = true;
  testState.sensitiveCalls = [];
  testState.citizenCalls = [];
  testState.pageCalls = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization project inspection", () => {
  it("shows census and note metadata to read-only users while correspondence remains restricted", async () => {
    await render();

    expect(text()).toContain("Observed Ada");
    expect(text()).toContain("fact");
    expect(text()).toContain("Provider-owned · read only");
    expect(text()).toContain("Correspondence history");
    expect(text()).toContain("Restricted");
    expect(testState.sensitiveCalls).toEqual([]);
    expect(testState.citizenCalls).toEqual([]);
    expect(text()).not.toContain("Reassign identity");
    expect(text()).not.toContain("Restore title");
    expect(text()).not.toContain("Reclaim title");
  });

  it("fetches note bodies only after explicit settings-write clicks", async () => {
    testState.writable = true;
    await render();
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const infoSpy = vi.spyOn(console, "info").mockImplementation(() => undefined);
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(testState.sensitiveCalls).toEqual([]);
    const openButtons = renderer!.root
      .findAllByType("button")
      .filter((button) => button.props.children === "Open body");
    expect(openButtons).toHaveLength(1);

    await act(async () => {
      openButtons[0]!.props.onClick();
      await Promise.resolve();
    });
    expect(testState.sensitiveCalls).toHaveLength(1);
    expect(testState.sensitiveCalls[0]).toMatchObject({ type: "noteBody", noteId });
    expect(text()).toContain("secret note body");

    const logged = [logSpy, infoSpy, warnSpy, errorSpy]
      .flatMap((spy) => spy.mock.calls)
      .flat()
      .map(String)
      .join("\n");
    expect(logged).not.toContain("secret note body");
  });

  it("keeps sensitive project actions disabled when multiple environments are selected", async () => {
    testState.writable = true;
    await render(false);

    expect(text()).toContain("Select one environment");
    expect(text()).not.toContain("Open body");
    expect(testState.sensitiveCalls).toEqual([]);
  });

  it("opens the shared citizen detail target from the census with write gating", async () => {
    testState.writable = true;
    testState.observedOnly = false;
    await render();

    expect(text()).not.toContain("Citizen detail editor");
    const citizenButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "View citizen Observed Ada");
    expect(citizenButton).toBeDefined();
    await act(() => citizenButton!.props.onClick());
    expect(text()).toContain("Citizen detail editor · ");
    expect(text()).toContain("editable");
    expect(testState.citizenCalls).toEqual([]);
  });

  it("mounts only the selected heavy project surface", async () => {
    await render(true, "chronicle");

    expect(text()).toContain("civilization-chronicle");
    expect(text()).not.toContain("Observed Ada");
    expect(text()).not.toContain("Correspondence history");
    expect(text()).not.toContain("civilization-data-retention");
    expect(text()).not.toContain("fact");

    await act(() => renderer?.unmount());
    renderer = undefined;
    await render(true, "notes");

    expect(text()).toContain("fact");
    expect(text()).not.toContain("Observed Ada");
    expect(text()).not.toContain("civilization-chronicle");
    expect(text()).not.toContain("Correspondence history");
    expect(text()).not.toContain("civilization-data-retention");
  });

  it("routes lineage selection from Citizens instead of opening transient local state", async () => {
    const onNavigateLineage = vi.fn();
    await act(() => {
      renderer = create(
        <CivilizationProjectInspection
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="UI-3 machine"
          effective={EFFECTIVE}
          allowSensitiveActions
          mode="citizens"
          onNavigateLineage={onNavigateLineage}
        />,
      );
    });
    const lineage = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "View lineage")!;
    await act(() => lineage.props.onClick());
    expect(onNavigateLineage).toHaveBeenCalledWith(threadId);
    expect(text()).not.toContain("Bounded lineage neighborhood");
  });
});
