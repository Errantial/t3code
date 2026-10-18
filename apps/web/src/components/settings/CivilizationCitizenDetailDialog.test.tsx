import {
  CivilizationDefaultConfig,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CivilizationCitizenDetail,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  writable: true,
  calls: [] as unknown[],
}));

const citizenAction = vi.hoisted(() => Symbol("citizen-action"));
const environmentId = EnvironmentId.make("environment-citizen-detail");
const projectId = ProjectId.make("project-citizen-detail");
const threadId = ThreadId.make("thread-citizen-detail");

const effective = {
  config: {
    ...CivilizationDefaultConfig,
    personalities: { ...CivilizationDefaultConfig.personalities, rendering: "rich" as const },
  },
  environmentRevision: 4,
  projectRevision: 2,
  provenance: [],
  selectedNameProbabilities: [],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

const detail: CivilizationCitizenDetail = {
  threadId,
  projectId,
  identity: {
    nameEntryId: "custom-name",
    namePoolId: "default-names",
    baseName: "Ada",
    displayName: "Ada",
  },
  personality: {
    profileEntryId: "conversational",
    profilePoolId: "default-profiles",
    base: {
      label: "Conversational",
      traits: ["conversational", "restrained"],
      styleText: "Prefer mildly conversational wording.",
    },
    rich: {
      label: "Pragmatic Craftsman",
      traits: ["pragmatic", "grounded", "craft-focused"],
      axiom: "Prefer the smallest durable solution that does the job well.",
      voice: "Grounded and practical.",
      styleText: "Use a pragmatic craftsman voice.",
    },
  },
  presentation: { rendering: "rich", label: "Pragmatic Craftsman" },
  host: {
    threadTitle: "[Ada] Desktop provider test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  lineage: {
    generation: 0,
    status: "resolved",
    parentThreadId: null,
    relationshipToParent: null,
  },
  lifecycle: { state: "open", epoch: 0, closed: false, deleted: false },
  observedOnly: false,
  title: {
    managed: true,
    topic: "Desktop provider test",
    preservedTitle: "Desktop provider test",
    lastManagedTitle: "[Ada] Desktop provider test",
    managedTitlePreview: "[Ada] Desktop provider test",
  },
  revision: 7,
};

vi.mock("@effect/atom-react", () => ({
  useAtomSet: () => async (input: unknown) => {
    state.calls.push(input);
    const typed = input as { type: string; request?: Record<string, unknown> };
    if (typed.type === "reassignmentPreview") {
      return {
        threadId,
        citizenRevision: 7,
        environmentRevision: 4,
        projectRevision: 2,
        current: {
          nameEntryId: "ada",
          name: "Ada",
          profileEntryId: "conversational",
          profileLabel: "Conversational",
        },
        proposed: {
          nameEntryId: "ada",
          name: String(typed.request?.displayName ?? "Ada"),
          profileEntryId: String(typed.request?.profileEntryId ?? "conversational"),
          profileLabel: "Focused",
        },
      };
    }
    return detail;
  },
}));

vi.mock("../../state/civilization", () => ({ civilizationCitizenAction: citizenAction }));
vi.mock("../../state/session", () => ({
  readEnvironmentScope: () => state.writable,
}));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/input", () => ({ Input: (props: Record<string, unknown>) => <input {...props} /> }));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children }: { children: ReactNode }) => <>{children}</>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogPanel: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h3>{children}</h3>,
}));
vi.mock("../ui/select", () => ({
  Select: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <div data-value={value}>{children}</div>
  ),
  SelectTrigger: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  SelectValue: () => <span />,
}));

import { CivilizationCitizenDetailDialog } from "./CivilizationCitizenDetailDialog";

let renderer: ReactTestRenderer | undefined;

const render = async (
  canAdminister = true,
  citizenDetail: CivilizationCitizenDetail = detail,
  effectiveConfig: CivilizationEffectiveConfig = effective,
  navigation: {
    readonly onViewLineage?: (threadId: ThreadId) => void;
    readonly onViewChronicle?: (threadId: ThreadId) => void;
    readonly onViewContext?: (threadId: ThreadId) => void;
    readonly onViewMessages?: (threadId: ThreadId) => void;
  } = {},
) => {
  await act(() => {
    renderer = create(
      <CivilizationCitizenDetailDialog
        open
        onOpenChange={vi.fn()}
        detail={citizenDetail}
        loading={false}
        error={null}
        environmentId={environmentId}
        effective={effectiveConfig}
        canAdminister={canAdminister}
        refresh={vi.fn()}
        {...navigation}
      />,
    );
  });
};

const text = () => JSON.stringify(renderer?.toJSON());

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.writable = true;
  state.calls = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization citizen detail dialog", () => {
  it("renders persisted identity and rich personality without performing an action", async () => {
    await render(false);
    expect(text()).toContain("Pragmatic Craftsman");
    expect(text()).toContain("Conversational");
    expect(text()).toContain("conversational, restrained");
    expect(text()).toContain("pragmatic, grounded, craft-focused");
    expect(text()).toContain("Prefer the smallest durable solution");
    expect(text()).toContain("resolved");
    expect(text()).toContain("Citizen revision");
    expect(text()).toContain("[Ada] Desktop provider test");
    expect(text()).not.toContain("Edit citizen");
    expect(state.calls).toEqual([]);
  });

  it("uses human-readable pool controls and revision-safe preview/apply", async () => {
    await render(true);
    expect(text()).toContain("Edit citizen");
    expect(text()).toContain("Stoic Architect");
    expect(text()).toContain("Pragmatic Craftsman");
    expect(text()).toContain("Obsessive Optimizer");
    expect(text()).toContain("Use a pragmatic craftsman voice.");
    expect(text()).toContain("Current topic");
    expect(text()).toContain("Desktop provider test");
    expect(text()).not.toContain("Profile entry ID");

    const nameInput = renderer!.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "Citizen display name");
    expect(nameInput).toBeDefined();
    await act(() => nameInput!.props.onChange({ currentTarget: { value: "Ada Prime" } }));
    const preview = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Preview changes");
    expect(preview).toBeDefined();
    await act(async () => {
      preview!.props.onClick();
      await Promise.resolve();
    });
    expect(state.calls[0]).toMatchObject({
      type: "reassignmentPreview",
      request: {
        threadId,
        projectId,
        expectedCitizenRevision: 7,
        expectedEnvironmentRevision: 4,
        expectedProjectRevision: 2,
        displayName: "Ada Prime",
      },
    });

    state.writable = false;
    const apply = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply preview");
    await act(() => apply!.props.onClick());
    expect(state.calls).toHaveLength(1);
    expect(text()).toContain("Permission changed before apply");
  });

  it("only offers manual/original restore while the host still has the last managed title", async () => {
    await render(true, {
      ...detail,
      host: { ...detail.host, threadTitle: "User renamed this manually" },
      title: { ...detail.title, managed: false },
    });
    expect(text()).not.toContain("Restore manual/original title");
    expect(text()).toContain("Reclaim managed title");
  });

  it("uses current global rendering for presentation while retaining the persisted rich snapshot", async () => {
    const mild = {
      ...effective,
      config: {
        ...effective.config,
        personalities: { ...effective.config.personalities, rendering: "mild" as const },
      },
      environmentRevision: 5,
    } satisfies CivilizationEffectiveConfig;
    await render(false, detail, mild);
    expect(text()).toContain("Conversational");
    expect(text()).toContain("Rich axiom");
    expect(text()).toContain("Prefer the smallest durable solution");
    expect(text()).toContain("Rich voice");
    expect(text()).toContain("Grounded and practical");
  });

  it("routes all citizen-detail destinations with the exact thread ID", async () => {
    const onViewLineage = vi.fn();
    const onViewChronicle = vi.fn();
    const onViewContext = vi.fn();
    const onViewMessages = vi.fn();
    await render(false, detail, effective, {
      onViewLineage,
      onViewChronicle,
      onViewContext,
      onViewMessages,
    });
    for (const [label, callback] of [
      ["Lineage", onViewLineage],
      ["Chronicle", onViewChronicle],
      ["Context", onViewContext],
      ["Messages", onViewMessages],
    ] as const) {
      const button = renderer!.root
        .findAllByType("button")
        .find((candidate) => candidate.props.children === label);
      expect(button).toBeDefined();
      await act(() => button!.props.onClick());
      expect(callback).toHaveBeenCalledWith(threadId);
    }
  });
});
