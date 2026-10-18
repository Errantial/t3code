import {
  CIVILIZATION_CONFIG_VERSION,
  CivilizationDefaultConfig,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type CivilizationEffectiveConfig,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  readable: new Set<string>(),
  writable: new Set<string>(),
  targets: [] as Array<{ environmentId: string; label: string; projectId: string | null }>,
  overviewCalls: [] as Array<readonly [string | null, string | null]>,
  configActionCalls: [] as unknown[],
  configActionResults: [] as Array<
    | { readonly kind: "resolve"; readonly value: unknown }
    | { readonly kind: "reject"; readonly error: unknown }
  >,
  refreshCalls: 0,
  multiEffectiveByEnvironment: new Map<string, CivilizationEffectiveConfig>(),
  scopeKind: null as "all" | "environment" | "project" | "checkout" | "unavailable" | null,
  searchTargetId: null as string | null,
  scrollTargets: [] as string[],
  scrollResult: false,
  projectInspectionProps: [] as Array<Record<string, unknown>>,
  contextAnalyticsProps: [] as Array<Record<string, unknown>>,
  contextInspectorProps: [] as Array<Record<string, unknown>>,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomSet: () => async (input: unknown) => {
    state.configActionCalls.push(input);
    const result = state.configActionResults.shift();
    if (!result) throw new Error("Unexpected Civilization config action in test.");
    if (result.kind === "reject") throw result.error;
    return result.value;
  },
}));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: (environmentId: string | null, scope: string) =>
    environmentId !== null &&
    (scope === "orchestration:read"
      ? state.readable.has(environmentId)
      : scope === "settings:write"
        ? state.writable.has(environmentId)
        : false),
  useEnvironmentsWithScope: (targets: ReadonlyArray<{ environmentId: string }>, scope: string) =>
    new Set(
      targets
        .map((target) => target.environmentId)
        .filter((environmentId) =>
          scope === "orchestration:read"
            ? state.readable.has(environmentId)
            : state.writable.has(environmentId),
        ),
    ),
  readEnvironmentScope: (environmentId: string, scope: string) =>
    scope === "settings:write" && state.writable.has(environmentId),
}));

vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => {
    const kind =
      state.scopeKind ??
      (state.targets.length === 1 && state.targets[0]?.projectId !== null
        ? "checkout"
        : state.targets.length > 1
          ? "project"
          : "all");
    return {
      targets: state.targets,
      scope: {
        kind,
        environmentIds: state.targets.map((target) => target.environmentId),
        ...(kind === "unavailable" ? { message: "Unavailable test scope" } : {}),
      },
    };
  },
}));

vi.mock("./SettingsScopeNotice", () => ({
  SettingsScopeNotice: ({
    children,
    target,
    targetId,
  }: {
    children: ReactNode;
    target: string;
    targetId?: string;
  }) => (
    <div data-testid="settings-scope-notice" data-target={target} data-target-id={targetId}>
      {children}
    </div>
  ),
}));

vi.mock("./CivilizationContextInspector", () => ({
  CivilizationContextInspector: (props: { targetLabel: string } & Record<string, unknown>) => {
    state.contextInspectorProps.push(props);
    return (
      <div data-testid="civilization-context-inspector">
        Context inspector for {props.targetLabel}
      </div>
    );
  },
}));

vi.mock("./CivilizationContextAnalytics", () => ({
  CivilizationContextAnalytics: (props: { targetLabel: string } & Record<string, unknown>) => {
    state.contextAnalyticsProps.push(props);
    return (
      <div data-testid="civilization-context-analytics">
        Context analytics for {props.targetLabel}
      </div>
    );
  },
}));

vi.mock("./CivilizationProjectInspection", () => ({
  CivilizationProjectInspection: (
    props: { targetLabel: string; mode?: string } & Record<string, unknown>,
  ) => {
    state.projectInspectionProps.push(props);
    return (
      <div data-testid="civilization-project-inspection" data-mode={props.mode}>
        Project inspection · {props.targetLabel} · {props.mode}
      </div>
    );
  },
}));

const EFFECTIVE = {
  config: CivilizationDefaultConfig,
  environmentRevision: 7,
  projectRevision: 4,
  provenance: [
    { path: "participation.enabled", source: "project" },
    { path: "personalities.rendering", source: "environment" },
  ],
  selectedNameProbabilities: [],
  selectedProfileProbabilities: [],
} satisfies CivilizationEffectiveConfig;

const OVERVIEW = {
  status: {
    status: "active" as const,
    environmentRevision: 7,
    projectRevision: 4,
    citizenCount: 3,
    openCitizenCount: 2,
  },
  capabilities: {
    providers: [
      {
        providerInstanceId: ProviderInstanceId.make("codex"),
        support: "full" as const,
        contextInjection: true,
        keyedContextReplacement: true,
        actionablePromptRefresh: true,
        providerContinuationRefresh: true,
        messaging: true,
      },
    ],
  },
  description: {
    version: CIVILIZATION_CONFIG_VERSION,
    inheritance: "built-in -> environment -> project",
    applicationTiming: {
      participation: "now",
      identities: "enrollment",
      personalities: "next input",
      messaging: "future checks",
      retention: "explicit cleanup",
    },
    limits: { packetBytes: 16_384 },
  },
  effective: EFFECTIVE,
};

vi.mock("../../state/civilization", () => ({
  useCivilizationOverview: (environmentId: string | null, projectId: string | null) => {
    state.overviewCalls.push([environmentId, projectId]);
    if (environmentId === null) {
      return {
        data: null,
        error: null,
        isPending: false,
        refresh: vi.fn(),
      };
    }
    return {
      data: OVERVIEW,
      error: null,
      isPending: false,
      refresh: () => {
        state.refreshCalls += 1;
      },
    };
  },
  useCivilizationConfigTargets: (
    targets: ReadonlyArray<{ environmentId: string; projectId: string | null }>,
  ) => ({
    data: targets.map((target) => ({
      ...target,
      overview: {
        ...OVERVIEW,
        effective: state.multiEffectiveByEnvironment.get(target.environmentId) ?? EFFECTIVE,
      },
    })),
    error: null,
    isPending: false,
    refresh: () => {
      state.refreshCalls += 1;
    },
  }),
  applyCivilizationConfigFanout: async (
    targets: ReadonlyArray<{ environmentId: string; label: string; value: unknown }>,
    commit: (target: { environmentId: string; label: string; value: unknown }) => Promise<unknown>,
  ) => {
    const applied: Array<{ target: (typeof targets)[number]; result: unknown }> = [];
    for (const target of targets) {
      try {
        applied.push({ target, result: await commit(target) });
      } catch (error) {
        return { applied, failed: { target, error } };
      }
    }
    return { applied, failed: null };
  },
  refreshCivilizationOverview: vi.fn(),
  civilizationConfigAction: Symbol("civilization-config-action"),
  civilizationConfigExpectedRevision: (
    effective: CivilizationEffectiveConfig,
    projectId: string | null,
  ) => (projectId === null ? effective.environmentRevision : effective.projectRevision),
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/switch", () => ({
  Switch: ({
    checked,
    disabled,
    onCheckedChange,
    ...props
  }: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
  } & Record<string, unknown>) => (
    <input
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onCheckedChange?.(event.currentTarget.checked)}
      {...props}
    />
  ),
}));

vi.mock("../ui/toggle-group", () => ({
  ToggleGroup: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  Toggle: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/number-field", () => ({
  NumberField: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  NumberFieldGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  NumberFieldDecrement: (props: Record<string, unknown>) => <button {...props}>−</button>,
  NumberFieldIncrement: (props: Record<string, unknown>) => <button {...props}>+</button>,
  NumberFieldInput: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    disabled,
    onValueChange,
  }: {
    children: ReactNode;
    value?: string | null;
    disabled?: boolean;
    onValueChange?: (value: string) => void;
  }) => (
    <select
      value={value ?? ""}
      disabled={disabled}
      onChange={(event) => onValueChange?.(event.currentTarget.value)}
    >
      {children}
    </select>
  ),
  SelectTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectValue: () => null,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));

vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  useSettingsSearchTargetId: () => state.searchTargetId,
  scrollToSettingsTarget: (targetId: string) => {
    state.scrollTargets.push(targetId);
    return state.scrollResult;
  },
  SettingsSection: ({
    children,
    title,
    id,
    headerAction,
  }: {
    children: ReactNode;
    title: string;
    id?: string;
    headerAction?: ReactNode;
  }) => (
    <section id={id}>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
  SettingsRow: ({
    title,
    description,
    control,
    id,
  }: {
    title: ReactNode;
    description?: ReactNode;
    control?: ReactNode;
    id?: string;
  }) => (
    <div id={id}>
      <span>{title}</span>
      <span>{description}</span>
      {control}
    </div>
  ),
}));

import { CivilizationSettingsPanel } from "./CivilizationSettings";

let renderer: ReactTestRenderer | undefined;

function text() {
  return JSON.stringify(renderer?.toJSON());
}

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.readable.clear();
  state.writable.clear();
  state.targets = [];
  state.overviewCalls = [];
  state.configActionCalls = [];
  state.configActionResults = [];
  state.refreshCalls = 0;
  state.multiEffectiveByEnvironment.clear();
  state.scopeKind = null;
  state.searchTargetId = null;
  state.scrollTargets = [];
  state.scrollResult = false;
  state.projectInspectionProps = [];
  state.contextAnalyticsProps = [];
  state.contextInspectorProps = [];
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization settings read-only shell", () => {
  it("shows server status and effective provenance to a read-only client", async () => {
    const environmentId = EnvironmentId.make("environment-read-only");
    const projectId = ProjectId.make("project-read-only");
    state.readable.add(environmentId);
    state.targets = [{ environmentId, label: "Read-only machine", projectId }];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });

    expect(state.overviewCalls).toEqual([[environmentId, projectId]]);
    expect(text()).toContain("Read-only machine");
    expect(text()).toContain("active");
    expect(text()).toContain("Project override");
    expect(text()).toContain("1 full");
  });

  it("does not issue a Civilization read when orchestration:read is absent", async () => {
    const environmentId = EnvironmentId.make("environment-no-read");
    state.targets = [{ environmentId, label: "Restricted machine", projectId: null }];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });

    expect(state.overviewCalls).toEqual([[null, null]]);
    expect(text()).toContain("orchestration:read");
    expect(text()).toContain("Unavailable");
  });

  it("keeps multi-environment project reads isolated by physical project id", async () => {
    const firstEnvironment = EnvironmentId.make("environment-a");
    const secondEnvironment = EnvironmentId.make("environment-b");
    const firstProject = ProjectId.make("project-a");
    const secondProject = ProjectId.make("project-b");
    state.readable.add(firstEnvironment);
    state.readable.add(secondEnvironment);
    state.targets = [
      { environmentId: firstEnvironment, label: "Machine A", projectId: firstProject },
      { environmentId: secondEnvironment, label: "Machine B", projectId: secondProject },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });

    expect(state.overviewCalls).toEqual([
      [firstEnvironment, firstProject],
      [secondEnvironment, secondProject],
    ]);
    expect(text()).toContain("Machine A");
    expect(text()).toContain("Machine B");
  });
});

describe("Civilization settings participation editor", () => {
  const writableTarget = () => {
    const environmentId = EnvironmentId.make("environment-write");
    const projectId = ProjectId.make("project-write");
    state.readable.add(environmentId);
    state.writable.add(environmentId);
    state.targets = [{ environmentId, label: "Writable machine", projectId }];
    return { environmentId, projectId };
  };

  const effectiveWithEnabled = (enabled: boolean, projectRevision = 5) => ({
    ...EFFECTIVE,
    config: {
      ...EFFECTIVE.config,
      participation: { ...EFFECTIVE.config.participation, enabled },
    },
    projectRevision,
  });

  it("stages a scalar locally, validates, re-checks permission, and commits the captured project revision", async () => {
    const { environmentId, projectId } = writableTarget();
    const committedEffective = effectiveWithEnabled(true);
    state.configActionResults = [
      { kind: "resolve", value: { valid: true, effective: committedEffective } },
      { kind: "resolve", value: { revision: 5, effective: committedEffective } },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel search={{ view: "configuration" }} />);
    });

    const enabled = renderer!.root.findByProps({
      "aria-label": "Enable Civilization on Writable machine",
    });
    await act(() => enabled.props.onCheckedChange(true));
    expect(state.configActionCalls).toEqual([]);

    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save");
    expect(save).toBeDefined();
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toEqual([
      {
        environmentId,
        projectId,
        type: "validate",
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
        },
      },
      {
        environmentId,
        projectId,
        type: "set",
        expectedRevision: 4,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
        },
      },
    ]);
    expect(state.refreshCalls).toBe(1);
    expect(text()).toContain("Saved.");
  });

  it("blocks the write when settings:write is revoked after validation", async () => {
    const { environmentId } = writableTarget();
    state.configActionResults = [{ kind: "resolve", value: { valid: true, effective: EFFECTIVE } }];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });
    const enabled = renderer!.root.findByProps({
      "aria-label": "Enable Civilization on Writable machine",
    });
    await act(() => enabled.props.onCheckedChange(true));
    state.writable.delete(environmentId);
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save");

    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toHaveLength(1);
    expect((state.configActionCalls[0] as { type: string }).type).toBe("validate");
    expect(text()).toContain("Permission changed before save");
  });

  it("keeps the draft and refreshes latest state on a revision conflict without retrying", async () => {
    writableTarget();
    state.configActionResults = [
      { kind: "resolve", value: { valid: true, effective: EFFECTIVE } },
      {
        kind: "reject",
        error: {
          _tag: "CivilizationConfigConflictError",
          code: "civilization_conflict",
          scope: "project",
          expectedRevision: 4,
          currentRevision: 5,
        },
      },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel search={{ view: "configuration" }} />);
    });
    const enabled = renderer!.root.findByProps({
      "aria-label": "Enable Civilization on Writable machine",
    });
    await act(() => enabled.props.onCheckedChange(true));
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save");
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toHaveLength(2);
    expect(state.refreshCalls).toBe(1);
    expect(text()).toContain("Configuration changed elsewhere; review and save again.");
    expect(
      renderer!.root.findByProps({ "aria-label": "Enable Civilization on Writable machine" }).props
        .checked,
    ).toBe(true);
  });

  it("uses the captured environment revision and preserves the draft on an environment conflict", async () => {
    const environmentId = EnvironmentId.make("environment-tier-write");
    state.readable.add(environmentId);
    state.writable.add(environmentId);
    state.targets = [{ environmentId, label: "Environment tier", projectId: null }];
    state.configActionResults = [
      { kind: "resolve", value: { valid: true, effective: EFFECTIVE } },
      {
        kind: "reject",
        error: {
          _tag: "CivilizationConfigConflictError",
          code: "civilization_conflict",
          scope: "environment",
          expectedRevision: 7,
          currentRevision: 8,
        },
      },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });
    const enabled = renderer!.root.findByProps({
      "aria-label": "Enable Civilization on Environment tier",
    });
    await act(() => enabled.props.onCheckedChange(true));
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save");
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls[1]).toMatchObject({
      type: "set",
      projectId: null,
      expectedRevision: 7,
    });
    expect(text()).toContain("Configuration changed elsewhere; review and save again.");
    expect(
      renderer!.root.findByProps({ "aria-label": "Enable Civilization on Environment tier" }).props
        .checked,
    ).toBe(true);
  });

  it("stages all-existing adoption through the same bounded validate and set flow", async () => {
    const { environmentId, projectId } = writableTarget();
    const committedEffective = {
      ...EFFECTIVE,
      projectRevision: 5,
      config: {
        ...EFFECTIVE.config,
        participation: { ...EFFECTIVE.config.participation, adoption: "all_existing" as const },
      },
    };
    state.configActionResults = [
      { kind: "resolve", value: { valid: true, effective: committedEffective } },
      { kind: "resolve", value: { revision: 5, effective: committedEffective } },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });
    const adoption = renderer!.root
      .findAllByType("select")
      .find((select) => select.props.value === "future_only");
    expect(adoption).toBeDefined();
    await act(() => adoption!.props.onChange({ currentTarget: { value: "all_existing" } }));
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save");
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toEqual([
      {
        environmentId,
        projectId,
        type: "validate",
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { adoption: "all_existing" },
        },
      },
      {
        environmentId,
        projectId,
        type: "set",
        expectedRevision: 4,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { adoption: "all_existing" },
        },
      },
    ]);
    expect(state.refreshCalls).toBe(1);
  });

  it("switches one stored personality to rich rendering without changing its assignment", async () => {
    const { environmentId, projectId } = writableTarget();
    const richEffective = {
      ...EFFECTIVE,
      projectRevision: 5,
      config: {
        ...EFFECTIVE.config,
        personalities: { ...EFFECTIVE.config.personalities, rendering: "rich" as const },
      },
    };
    state.configActionResults = [
      { kind: "resolve", value: { valid: true, effective: richEffective } },
      { kind: "resolve", value: { revision: 5, effective: richEffective } },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel search={{ view: "configuration" }} />);
    });

    const rendering = renderer!.root
      .findAllByType("select")
      .find((select) =>
        select
          .findAllByType("option")
          .some(
            (option) => option.props.value === "rich" && option.props.children === "Rich archetype",
          ),
      );
    expect(rendering).toBeDefined();
    const options = rendering!.findAllByType("option").map((option) => ({
      value: option.props.value,
      label: option.props.children,
    }));
    expect(options).toContainEqual({ value: "rich", label: "Rich archetype" });
    expect(text()).toContain("never rerolls the citizen");

    await act(() => rendering!.props.onChange({ currentTarget: { value: "rich" } }));
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save" && button.props.disabled === false);
    expect(save).toBeDefined();
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toEqual([
      {
        environmentId,
        projectId,
        type: "validate",
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          names: {},
          personalities: { rendering: "rich" },
        },
      },
      {
        environmentId,
        projectId,
        type: "set",
        expectedRevision: 4,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          names: {},
          personalities: { rendering: "rich" },
        },
      },
    ]);
    expect(state.refreshCalls).toBe(1);
  });

  it("surfaces typed validation reasons without issuing a set", async () => {
    writableTarget();
    state.configActionResults = [
      {
        kind: "reject",
        error: {
          _tag: "CivilizationConfigInvalidError",
          code: "civilization_invalid_config",
          reason: "invalid_limit",
          message: "Packet byte budget exceeds the configured maximum.",
        },
      },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });
    const enabled = renderer!.root.findByProps({
      "aria-label": "Enable Civilization on Writable machine",
    });
    await act(() => enabled.props.onCheckedChange(true));
    const save = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Save");
    await act(async () => {
      save!.props.onClick();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toHaveLength(1);
    expect(text()).toContain("invalid_limit");
    expect(text()).toContain("Packet byte budget exceeds the configured maximum");
  });

  it("resets the project tier with configReset and the exact captured revision", async () => {
    const { environmentId, projectId } = writableTarget();
    state.configActionResults = [
      { kind: "resolve", value: { revision: 5, effective: { ...EFFECTIVE, projectRevision: 5 } } },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel search={{ view: "configuration" }} />);
    });
    const reset = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Reset");
    expect(reset).toBeDefined();
    await act(async () => {
      reset!.props.onClick();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toEqual([
      {
        environmentId,
        projectId,
        type: "reset",
        expectedRevision: 4,
      },
    ]);
    expect(text()).toContain("Project override reset");
  });
});

describe("Civilization settings mixed selection", () => {
  it("shows Mixed and stops fan-out after a partial revision conflict without rollback", async () => {
    const environmentA = EnvironmentId.make("environment-mixed-a");
    const environmentB = EnvironmentId.make("environment-mixed-b");
    const environmentC = EnvironmentId.make("environment-mixed-c");
    const projectA = ProjectId.make("project-mixed-a");
    const projectB = ProjectId.make("project-mixed-b");
    const projectC = ProjectId.make("project-mixed-c");
    for (const environmentId of [environmentA, environmentB, environmentC]) {
      state.readable.add(environmentId);
      state.writable.add(environmentId);
    }
    state.targets = [
      { environmentId: environmentA, label: "Machine A", projectId: projectA },
      { environmentId: environmentB, label: "Machine B", projectId: projectB },
      { environmentId: environmentC, label: "Machine C", projectId: projectC },
    ];
    const effectiveA = {
      ...EFFECTIVE,
      projectRevision: 4,
      config: {
        ...EFFECTIVE.config,
        participation: { ...EFFECTIVE.config.participation, enabled: false },
      },
    };
    const effectiveB = {
      ...EFFECTIVE,
      projectRevision: 9,
      config: {
        ...EFFECTIVE.config,
        participation: { ...EFFECTIVE.config.participation, enabled: true },
      },
    };
    const effectiveC = { ...effectiveA, projectRevision: 12 };
    state.multiEffectiveByEnvironment.set(environmentA, effectiveA);
    state.multiEffectiveByEnvironment.set(environmentB, effectiveB);
    state.multiEffectiveByEnvironment.set(environmentC, effectiveC);
    state.configActionResults = [
      { kind: "resolve", value: { valid: true, effective: effectiveA } },
      { kind: "resolve", value: { revision: 5, effective: { ...effectiveA, projectRevision: 5 } } },
      { kind: "resolve", value: { valid: true, effective: effectiveB } },
      {
        kind: "reject",
        error: {
          _tag: "CivilizationConfigConflictError",
          code: "civilization_conflict",
          scope: "project",
          expectedRevision: 9,
          currentRevision: 10,
        },
      },
    ];

    await act(() => {
      renderer = create(<CivilizationSettingsPanel />);
    });
    const mixed = renderer!.root.findByProps({
      "aria-label": "Civilization enabled across selected environments",
    });
    expect(mixed.props.mixed).toBe(true);
    expect(text()).toContain("Mixed");
    await act(() => mixed.props.onCheckedChange(true));
    const apply = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply");
    expect(apply).toBeDefined();
    await act(async () => {
      apply!.props.onClick();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(state.configActionCalls).toHaveLength(4);
    expect(state.configActionCalls[1]).toMatchObject({
      environmentId: environmentA,
      projectId: projectA,
      type: "set",
      expectedRevision: 4,
    });
    expect(state.configActionCalls[3]).toMatchObject({
      environmentId: environmentB,
      projectId: projectB,
      type: "set",
      expectedRevision: 9,
    });
    expect(JSON.stringify(state.configActionCalls)).not.toContain(environmentC);
    expect(text()).toContain("Saved on Machine A");
    expect(text()).toContain("Failed on Machine B");
    expect(text()).toContain("later environments were not changed");
  });
});

describe("Civilization v1.4 task shell", () => {
  const exactTarget = () => {
    const environmentId = EnvironmentId.make("environment-shell");
    const projectId = ProjectId.make("project-shell");
    state.readable.add(environmentId);
    state.writable.add(environmentId);
    state.targets = [{ environmentId, label: "Shell machine", projectId }];
    state.scopeKind = "checkout";
    return { environmentId, projectId };
  };

  it("writes top-level and local mode choices back to navigation search", async () => {
    exactTarget();
    const onNavigate = vi.fn();
    await act(() => {
      renderer = create(
        <CivilizationSettingsPanel search={{ view: "overview" }} onNavigate={onNavigate} />,
      );
    });

    const viewSelector = renderer!.root
      .findAllByType("div")
      .find((node) => node.props["aria-label"] === "Civilization view")!;
    await act(() => viewSelector.props.onValueChange(["activity"]));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: "activity", activity: "chronicle" });

    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel
          search={{ view: "activity", activity: "chronicle" }}
          onNavigate={onNavigate}
        />,
      );
    });
    const activitySelector = renderer!.root
      .findAllByType("div")
      .find((node) => node.props["aria-label"] === "Civilization activity view")!;
    await act(() => activitySelector.props.onValueChange(["messages"]));
    expect(onNavigate).toHaveBeenLastCalledWith({ view: "activity", activity: "messages" });
  });

  it("mounts only the selected heavy task surface", async () => {
    exactTarget();

    await act(() => {
      renderer = create(<CivilizationSettingsPanel search={{ view: "citizens" }} />);
    });
    expect(
      renderer!.root.findByProps({ "data-testid": "civilization-project-inspection" }).props[
        "data-mode"
      ],
    ).toBe("citizens");
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-analytics" }),
    ).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-inspector" }),
    ).toHaveLength(0);

    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel search={{ view: "activity", activity: "notes" }} />,
      );
    });
    expect(
      renderer!.root.findByProps({ "data-testid": "civilization-project-inspection" }).props[
        "data-mode"
      ],
    ).toBe("notes");

    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel search={{ view: "context", contextMode: "analytics" }} />,
      );
    });
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-project-inspection" }),
    ).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-analytics" }),
    ).toHaveLength(1);
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-inspector" }),
    ).toHaveLength(0);

    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel search={{ view: "context", contextMode: "inspector" }} />,
      );
    });
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-analytics" }),
    ).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-inspector" }),
    ).toHaveLength(1);

    await act(() => {
      renderer!.update(<CivilizationSettingsPanel search={{ view: "configuration" }} />);
    });
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-analytics" }),
    ).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-inspector" }),
    ).toHaveLength(0);
    expect(
      renderer!.root.findByProps({ "data-testid": "civilization-project-inspection" }).props[
        "data-mode"
      ],
    ).toBe("data");
  });

  it("keeps Overview multi-target safe with one canonical status id and gates rich views to one checkout", async () => {
    const firstEnvironment = EnvironmentId.make("environment-shell-a");
    const secondEnvironment = EnvironmentId.make("environment-shell-b");
    state.readable.add(firstEnvironment);
    state.readable.add(secondEnvironment);
    state.targets = [
      {
        environmentId: firstEnvironment,
        label: "Shell A",
        projectId: ProjectId.make("project-shell-a"),
      },
      {
        environmentId: secondEnvironment,
        label: "Shell B",
        projectId: ProjectId.make("project-shell-b"),
      },
    ];
    state.scopeKind = "project";

    await act(() => {
      renderer = create(<CivilizationSettingsPanel search={{ view: "overview" }} />);
    });
    expect(
      renderer!.root
        .findAllByType("section")
        .filter((section) => section.props.id === "civilization-status"),
    ).toHaveLength(1);
    expect(text()).toContain("Shell A");
    expect(text()).toContain("Shell B");
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-project-inspection" }),
    ).toHaveLength(0);

    await act(() => {
      renderer!.update(<CivilizationSettingsPanel search={{ view: "citizens" }} />);
    });
    const notice = renderer!.root.findByProps({ "data-testid": "settings-scope-notice" });
    expect(notice.props["data-target"]).toBe("checkout");
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-project-inspection" }),
    ).toHaveLength(0);
  });

  it("asks for a project before mounting a project-required task from environment scope", async () => {
    const environmentId = EnvironmentId.make("environment-shell-environment-only");
    state.readable.add(environmentId);
    state.targets = [{ environmentId, label: "Environment only", projectId: null }];
    state.scopeKind = "environment";

    await act(() => {
      renderer = create(
        <CivilizationSettingsPanel search={{ view: "context", contextMode: "analytics" }} />,
      );
    });
    const notice = renderer!.root.findByProps({ "data-testid": "settings-scope-notice" });
    expect(notice.props["data-target"]).toBe("project");
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-analytics" }),
    ).toHaveLength(0);
  });

  it("uses a Settings search hash to reveal the owning view and mode", async () => {
    exactTarget();
    state.searchTargetId = "civilization-context-inspector";
    const onNavigate = vi.fn();

    await act(() => {
      renderer = create(
        <CivilizationSettingsPanel search={{ view: "overview" }} onNavigate={onNavigate} />,
      );
    });

    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-inspector" }),
    ).toHaveLength(0);
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-analytics" }),
    ).toHaveLength(0);
    expect(onNavigate).toHaveBeenCalledWith(
      { view: "context", contextMode: "inspector" },
      { replace: true, hash: "civilization-context-inspector" },
    );
    state.searchTargetId = null;
    state.scrollResult = true;
    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel
          search={{ view: "context", contextMode: "inspector" }}
          onNavigate={onNavigate}
        />,
      );
    });
    expect(
      renderer!.root.findAllByProps({ "data-testid": "civilization-context-inspector" }),
    ).toHaveLength(1);
    expect(state.scrollTargets).toContain("civilization-context-inspector");
  });

  it("preserves the full Analytics filter set when drilling into Inspector", async () => {
    exactTarget();
    const onNavigate = vi.fn();
    const threadId = ThreadId.make("thread-shell-analytics");
    const providerInstanceId = ProviderInstanceId.make("provider-shell-analytics");
    const filters = {
      from: "2026-10-18T10:00:00.000Z",
      to: "2026-10-18T11:00:00.000Z",
      providerInstanceId,
      threadId,
      outcome: "provider_start_accepted" as const,
      suppressionReason: "provider_unsupported" as const,
    };

    await act(() => {
      renderer = create(
        <CivilizationSettingsPanel
          search={{ view: "context", contextMode: "analytics" }}
          onNavigate={onNavigate}
        />,
      );
    });
    const analyticsProps = state.contextAnalyticsProps.at(-1)!;
    await act(() => {
      (analyticsProps.onInspect as (nextFilters: typeof filters) => void)(filters);
    });
    expect(onNavigate).toHaveBeenLastCalledWith({
      view: "context",
      contextMode: "inspector",
      contextFilterThread: threadId,
      contextFilterProvider: providerInstanceId,
      contextFilterOutcome: "provider_start_accepted",
      contextFilterSuppression: "provider_unsupported",
      contextFilterFrom: filters.from,
      contextFilterTo: filters.to,
    });

    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel
          search={{
            view: "context",
            contextMode: "inspector",
            contextFilterThread: threadId,
            contextFilterProvider: providerInstanceId,
            contextFilterOutcome: "provider_start_accepted",
            contextFilterSuppression: "provider_unsupported",
            contextFilterFrom: filters.from,
            contextFilterTo: filters.to,
          }}
          onNavigate={onNavigate}
        />,
      );
    });
    expect(state.contextInspectorProps.at(-1)?.initialFilters).toEqual(filters);
  });

  it("routes citizen context links with contextFilterThread and focuses the canonical target after mount", async () => {
    exactTarget();
    const onNavigate = vi.fn();
    const threadId = ThreadId.make("thread-shell-context");

    await act(() => {
      renderer = create(
        <CivilizationSettingsPanel search={{ view: "citizens" }} onNavigate={onNavigate} />,
      );
    });
    const projectProps = state.projectInspectionProps.at(-1)!;
    await act(() => {
      (projectProps.onViewContext as (threadId: ThreadId) => void)(threadId);
    });
    expect(onNavigate).toHaveBeenLastCalledWith({
      view: "context",
      contextMode: "inspector",
      contextFilterThread: threadId,
    });

    state.scrollResult = true;
    await act(() => {
      renderer!.update(
        <CivilizationSettingsPanel
          search={{ view: "context", contextMode: "inspector", contextFilterThread: threadId }}
          onNavigate={onNavigate}
        />,
      );
    });
    expect(state.scrollTargets).toContain("civilization-context-inspector");
    expect(state.contextInspectorProps.at(-1)?.initialFilters).toEqual({ threadId });
  });
});
