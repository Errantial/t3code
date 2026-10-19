import {
  CIVILIZATION_CONFIG_VERSION,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CivilizationOnboardingContentPreviewResult,
  type CivilizationOnboardingPreviewResult,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { CivilizationNavigationSearch } from "./civilizationNavigation";

const state = vi.hoisted(() => ({
  onboardingActionToken: Symbol("onboarding-action"),
  configActionToken: Symbol("config-action"),
  writable: true,
  presetHookCalls: [] as unknown[][],
  censusHookCalls: [] as unknown[][],
  onboardingCalls: [] as unknown[],
  configCalls: [] as unknown[],
  onboardingResults: [] as Array<
    | { readonly kind: "resolve"; readonly value: unknown }
    | { readonly kind: "reject"; readonly error: unknown }
  >,
  configResults: [] as Array<
    | { readonly kind: "resolve"; readonly value: unknown }
    | { readonly kind: "reject"; readonly error: unknown }
  >,
  refreshPresets: 0,
  popupProps: null as Record<string, unknown> | null,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomSet: (token: symbol) => async (input: unknown) => {
    const queue =
      token === state.onboardingActionToken ? state.onboardingResults : state.configResults;
    (token === state.onboardingActionToken ? state.onboardingCalls : state.configCalls).push(input);
    const result = queue.shift();
    if (!result) throw new Error("Unexpected action.");
    if (result.kind === "reject") throw result.error;
    return result.value;
  },
}));

const environmentId = EnvironmentId.make("environment:onboarding-ui");
const projectId = ProjectId.make("project:onboarding-ui");
const citizenThreadId = ThreadId.make("thread:onboarding-ui:citizen");
const provider = {
  providerInstanceId: ProviderInstanceId.make("codex"),
  support: "full" as const,
  contextInjection: true,
  keyedContextReplacement: true,
  actionablePromptRefresh: true,
  providerContinuationRefresh: true,
  messaging: true,
};
const presetData = {
  projectId,
  environmentRevision: 12,
  projectRevision: 34,
  presets: [
    {
      id: "minimal" as const,
      label: "Minimal",
      description: "Server minimal",
      candidateOverride: {
        version: CIVILIZATION_CONFIG_VERSION,
        personalities: { rendering: "off" as const },
      },
      changes: [{ path: "personalities.rendering", before: "mild", after: "off" }],
    },
  ],
};
const preview = {
  projectId,
  previewKind: "configuration_only",
  effectiveConfig: {},
  environmentRevision: 12,
  projectRevision: 34,
  changes: presetData.presets[0]!.changes,
  capabilities: [provider],
  selectedCapability: null,
  budget: {
    limitBytes: 4096,
    packetBytes: 0,
    requiredBytes: 0,
    briefBytes: 0,
    rosterBytes: 0,
    noteBytes: 0,
    inboxBytes: 0,
    unusedBytes: 4096,
  },
  composition: {
    brief: { candidates: 0, included: 0, omitted: 0 },
    roster: { candidates: 0, included: 0, omitted: 0 },
    notes: { candidates: 0, included: 0, omitted: 0 },
    inbox: { candidates: 0, included: 0, omitted: 0 },
  },
  eligibility: { brief: true, roster: true, notes: false, inbox: false, exactContent: false },
  warnings: [],
} as unknown as CivilizationOnboardingPreviewResult;
const exactPreview = {
  ...preview,
  previewKind: "exact_existing_citizen",
  selectedCapability: provider,
  eligibility: { ...preview.eligibility, exactContent: true },
} as CivilizationOnboardingPreviewResult;
const contentPreview = {
  projectId,
  threadId: citizenThreadId,
  effectiveConfig: {},
  environmentRevision: 12,
  projectRevision: 34,
  capability: provider,
  authority: {
    runId: "run:onboarding-ui",
    providerInstanceId: provider.providerInstanceId,
    runtimeMode: "full-access",
    interactionMode: "default",
  },
  budget: preview.budget,
  composition: preview.composition,
  packet: {
    revisionKind: "preview_only",
    previewRevision: "preview:1",
    text: "sensitive packet body",
    bytes: 21,
    selectedCitizenIds: [citizenThreadId],
    selectedNoteIds: [],
    selectedInboxIds: [],
  },
  warnings: [],
} as unknown as CivilizationOnboardingContentPreviewResult;

vi.mock("../../state/civilization", () => ({
  civilizationOnboardingAction: state.onboardingActionToken,
  civilizationConfigAction: state.configActionToken,
  refreshCivilizationOnboardingPresets: () => {
    state.refreshPresets += 1;
  },
  useCivilizationOnboardingPresets: (...args: unknown[]) => {
    state.presetHookCalls.push(args);
    return { data: presetData, error: null, isPending: false, refresh: vi.fn() };
  },
  useCivilizationCensusPage: (...args: unknown[]) => {
    state.censusHookCalls.push(args);
    return {
      data: {
        projectId,
        revision: 5,
        citizens: [
          {
            threadId: citizenThreadId,
            projectId,
            name: "Ada",
            profileId: "profile-ada",
            profileLabel: "Builder",
            generation: 0,
            lineageStatus: "resolved",
            parentThreadId: null,
            relationshipToParent: null,
            observedOnly: false,
            epoch: 0,
            closed: false,
            deleted: false,
            titleManaged: true,
            revision: 1,
          },
        ],
        nextCursor: null,
        partial: false,
      },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
}));
vi.mock("../../state/session", () => ({ readEnvironmentScope: () => state.writable }));
vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));
vi.mock("../ui/dialog", () => ({
  Dialog: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div data-dialog {...props}>
      {children}
    </div>
  ),
  DialogPopup: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => {
    state.popupProps = props;
    return <div data-dialog-popup>{children}</div>;
  },
  DialogHeader: ({ children }: { children: ReactNode }) => <header>{children}</header>,
  DialogTitle: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
  DialogDescription: ({ children }: { children: ReactNode }) => <p>{children}</p>,
  DialogPanel: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  DialogFooter: ({ children }: { children: ReactNode }) => <footer>{children}</footer>,
}));
vi.mock("../ui/select", () => ({
  Select: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div data-select {...props}>
      {children}
    </div>
  ),
  SelectTrigger: ({ children, ...props }: { children?: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
  SelectValue: () => <span />,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <span data-select-item={value}>{children}</span>
  ),
}));

import { CivilizationOnboardingDialog } from "./CivilizationOnboardingDialog";

let renderer: ReactTestRenderer | undefined;
const baseSearch: CivilizationNavigationSearch = {
  view: "configuration",
  onboarding: "preview",
  onboardingPreset: "minimal",
  onboardingAdoption: "future_only",
  onboardingTitlePolicy: "preserve",
};

const renderDialog = async (search = baseSearch) => {
  const onNavigate = vi.fn();
  const onApplied = vi.fn();
  await act(() => {
    renderer = create(
      <CivilizationOnboardingDialog
        environmentId={environmentId}
        projectId={projectId}
        targetLabel="Checkout A"
        canRead
        canWrite={state.writable}
        providers={[provider]}
        search={search}
        onNavigate={onNavigate}
        onApplied={onApplied}
      />,
    );
  });
  return { onNavigate, onApplied };
};
const updateSearch = async (search: CivilizationNavigationSearch) => {
  await act(() => {
    renderer!.update(
      <CivilizationOnboardingDialog
        environmentId={environmentId}
        projectId={projectId}
        targetLabel="Checkout A"
        canRead
        canWrite={state.writable}
        providers={[provider]}
        search={search}
        onNavigate={vi.fn()}
        onApplied={vi.fn()}
      />,
    );
  });
};
const click = async (label: string) => {
  const button = renderer!.root
    .findAllByType("button")
    .find((item) => item.props.children === label);
  expect(button).toBeDefined();
  await act(async () => {
    button!.props.onClick();
    await Promise.resolve();
    await Promise.resolve();
  });
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.writable = true;
  state.presetHookCalls = [];
  state.censusHookCalls = [];
  state.onboardingCalls = [];
  state.configCalls = [];
  state.onboardingResults = [];
  state.configResults = [];
  state.refreshPresets = 0;
  state.popupProps = null;
});
afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("CivilizationOnboardingDialog", () => {
  it("uses URL-driven safe stages, replace-normalizes direct Apply, and closes through Dialog Escape semantics", async () => {
    const { onNavigate } = await renderDialog({ ...baseSearch, onboarding: "apply" });
    expect(onNavigate).toHaveBeenCalledWith(
      { ...baseSearch, onboarding: "preview" },
      { replace: true, hash: "civilization-onboarding" },
    );
    expect(state.onboardingCalls).toEqual([]);
    expect(typeof state.popupProps?.initialFocus).toBe("function");
    expect(typeof state.popupProps?.finalFocus).toBe("function");
    renderer!.root.findByProps({ "data-dialog": true }).props.onOpenChange(false);
    expect(onNavigate).toHaveBeenLastCalledWith(
      { view: "configuration" },
      { replace: true, hash: "civilization-onboarding" },
    );
  });

  it("previews body-free config under read and overlays URL adoption/title choices", async () => {
    state.writable = false;
    state.onboardingResults = [{ kind: "resolve", value: preview }];
    await renderDialog();
    await click("Preview");
    expect(state.onboardingCalls[0]).toMatchObject({
      type: "preview",
      preview: {
        previewKind: "configuration_only",
        projectId,
        candidateOverride: {
          participation: { adoption: "future_only" },
          names: { adoptionTitlePolicy: "preserve" },
        },
      },
    });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("sensitive packet body");
  });

  it("keeps citizen and packet memory-only and Reveal behind a fresh settings:write check", async () => {
    state.onboardingResults = [
      { kind: "resolve", value: exactPreview },
      { kind: "resolve", value: contentPreview },
    ];
    await renderDialog();
    const citizenSelect = renderer!.root.findByProps({ "data-select": true });
    await act(() => citizenSelect.props.onValueChange(citizenThreadId));
    await click("Preview");
    await updateSearch({ ...baseSearch, onboarding: "apply" });
    state.writable = false;
    await click("Reveal packet");
    expect(state.onboardingCalls).toHaveLength(1);
    expect(JSON.stringify(renderer!.toJSON())).toContain("settings:write is required");
    state.writable = true;
    await updateSearch({ ...baseSearch, onboarding: "apply" });
    await click("Reveal packet");
    expect(state.onboardingCalls[1]).toMatchObject({
      type: "reveal",
      preview: { projectId, threadId: citizenThreadId },
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("sensitive packet body");
    expect(JSON.stringify(renderer!.toJSON())).toContain("full-access");
  });

  it("clears revealed packet text when settings:write is revoked after Reveal", async () => {
    state.onboardingResults = [
      { kind: "resolve", value: exactPreview },
      { kind: "resolve", value: contentPreview },
    ];
    await renderDialog();
    const citizenSelect = renderer!.root.findByProps({ "data-select": true });
    await act(() => citizenSelect.props.onValueChange(citizenThreadId));
    await click("Preview");
    await updateSearch({ ...baseSearch, onboarding: "apply" });
    await click("Reveal packet");
    expect(JSON.stringify(renderer!.toJSON())).toContain("sensitive packet body");

    state.writable = false;
    await updateSearch({ ...baseSearch, onboarding: "apply" });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("sensitive packet body");

    state.writable = true;
    await updateSearch({ ...baseSearch, onboarding: "apply" });
    expect(JSON.stringify(renderer!.toJSON())).not.toContain("sensitive packet body");
    expect(state.onboardingCalls).toHaveLength(2);
  });

  it("applies exactly once with both reviewed revisions and invalidates approval on conflict without losing safe choices", async () => {
    state.onboardingResults = [{ kind: "resolve", value: preview }];
    state.configResults = [
      {
        kind: "reject",
        error: { _tag: "CivilizationConfigConflictError", scope: "environment" },
      },
    ];
    await renderDialog();
    await click("Preview");
    const onNavigate = vi.fn();
    await act(() => {
      renderer!.update(
        <CivilizationOnboardingDialog
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Checkout A"
          canRead
          canWrite
          providers={[provider]}
          search={{ ...baseSearch, onboarding: "apply" }}
          onNavigate={onNavigate}
          onApplied={vi.fn()}
        />,
      );
    });
    await click("Apply once");
    expect(state.configCalls).toHaveLength(1);
    expect(state.configCalls[0]).toMatchObject({
      environmentId,
      type: "set",
      projectId,
      expectedRevision: 34,
      expectedEnvironmentRevision: 12,
      override: {
        participation: { adoption: "future_only" },
        names: { adoptionTitlePolicy: "preserve" },
      },
    });
    expect(JSON.stringify(renderer!.toJSON())).toContain("Your choices are preserved");
    expect(onNavigate).toHaveBeenCalledWith(
      { ...baseSearch, onboarding: "preview" },
      { replace: true, hash: "civilization-onboarding" },
    );
  });

  it("removes wizard URL keys with replace after one successful Apply", async () => {
    state.onboardingResults = [{ kind: "resolve", value: preview }];
    state.configResults = [{ kind: "resolve", value: { revision: 35 } }];
    await renderDialog();
    await click("Preview");
    const onNavigate = vi.fn();
    const onApplied = vi.fn();
    await act(() => {
      renderer!.update(
        <CivilizationOnboardingDialog
          environmentId={environmentId}
          projectId={projectId}
          targetLabel="Checkout A"
          canRead
          canWrite
          providers={[provider]}
          search={{ ...baseSearch, onboarding: "apply" }}
          onNavigate={onNavigate}
          onApplied={onApplied}
        />,
      );
    });
    await click("Apply once");
    expect(state.configCalls).toHaveLength(1);
    expect(state.refreshPresets).toBe(1);
    expect(onApplied).toHaveBeenCalledTimes(1);
    expect(onNavigate).toHaveBeenCalledWith(
      { view: "configuration" },
      { replace: true, hash: "civilization-onboarding" },
    );
  });
});
