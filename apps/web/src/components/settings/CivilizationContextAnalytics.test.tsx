import {
  type CivilizationContextAnalyticsResult,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment-context-analytics");
const projectId = ProjectId.make("project-context-analytics");
const providerInstanceId = ProviderInstanceId.make("codex-main");
const threadId = ThreadId.make("thread-context-analytics");

const analyticsResult = {
  projectId,
  from: "2026-10-17T08:00:00.000Z",
  to: "2026-10-17T10:00:00.000Z",
  bucketSize: "hour",
  appliedDiagnosticRetentionDays: 7,
  buckets: [
    {
      bucketStart: "2026-10-17T08:00:00.000Z",
      bucketEnd: "2026-10-17T09:00:00.000Z",
      totalInspections: 6,
      outcomes: {
        skipped: 2,
        built: 1,
        providerStartAccepted: 2,
        providerStartFailed: 1,
      },
      suppressions: [
        { reason: "provider_unsupported", count: 1 },
        { reason: "provider_continuation", count: 1 },
      ],
      packetSize: { zero: 2, low: 1, medium: 1, high: 2, over: 0 },
      budgetUtilization: { zero: 2, low: 1, medium: 2, high: 1, over: 0 },
      roster: { candidates: 10, included: 7, omitted: 3 },
      notes: { candidates: 5, included: 3, omitted: 2 },
      inbox: { candidates: 4, included: 2, omitted: 2 },
    },
    {
      bucketStart: "2026-10-17T09:00:00.000Z",
      bucketEnd: "2026-10-17T10:00:00.000Z",
      totalInspections: 4,
      outcomes: {
        skipped: 1,
        built: 1,
        providerStartAccepted: 2,
        providerStartFailed: 0,
      },
      suppressions: [{ reason: "provider_unsupported", count: 1 }],
      packetSize: { zero: 1, low: 0, medium: 2, high: 1, over: 0 },
      budgetUtilization: { zero: 1, low: 0, medium: 1, high: 2, over: 0 },
      roster: { candidates: 8, included: 6, omitted: 2 },
      notes: { candidates: 3, included: 2, omitted: 1 },
      inbox: { candidates: 2, included: 2, omitted: 0 },
    },
  ],
} satisfies CivilizationContextAnalyticsResult;

const testState = vi.hoisted(() => ({
  hookCalls: [] as unknown[][],
  selectHandlers: [] as Array<(value: string) => void>,
  refresh: vi.fn(),
}));

vi.mock("../../state/civilization", () => ({
  useCivilizationContextAnalytics: (...args: unknown[]) => {
    testState.hookCalls.push(args);
    return {
      data: analyticsResult,
      error: null,
      isPending: false,
      refresh: testState.refresh,
    };
  },
}));

vi.mock("../ui/button", () => ({
  Button: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <button {...props}>{children}</button>
  ),
}));

vi.mock("../ui/input", () => ({
  Input: (props: Record<string, unknown>) => <input {...props} />,
}));

vi.mock("../ui/select", () => ({
  Select: ({
    children,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => {
    testState.selectHandlers.push(onValueChange);
    return <div>{children}</div>;
  },
  SelectItem: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  SelectTrigger: ({ children, ...props }: { children: ReactNode } & Record<string, unknown>) => (
    <div {...props}>{children}</div>
  ),
  SelectValue: () => <span />,
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
}));

import { CivilizationContextAnalytics } from "./CivilizationContextAnalytics";

let renderer: ReactTestRenderer | undefined;
const onInspect = vi.fn();

const renderedText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "object" && value !== null && "children" in value) {
    return renderedText((value as { readonly children?: unknown }).children);
  }
  return "";
};

const render = async () => {
  await act(() => {
    renderer = create(
      <CivilizationContextAnalytics
        environmentId={environmentId}
        projectId={projectId}
        targetLabel="Analytics machine"
        onInspect={onInspect}
      />,
    );
  });
};

const buttonNamed = (name: string) =>
  renderer?.root
    .findAllByType("button")
    .find((button) => renderedText(button.props.children) === name);

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.hookCalls = [];
  testState.selectHandlers = [];
  testState.refresh.mockReset();
  onInspect.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("Civilization context analytics", () => {
  it("renders aggregate summaries, coarse views, and an accessible bucket table without body actions", async () => {
    await render();

    const text = renderedText(renderer?.toJSON());
    expect(text).toContain("Context analytics");
    expect(text).toContain("Analytics machine");
    expect(text).toContain("Inspections10");
    expect(text).toContain("Skipped3");
    expect(text).toContain("Built2");
    expect(text).toContain("Adapter handoff accepted4");
    expect(text).toContain("Adapter handoff failed1");
    expect(text).toContain("Provider unsupported2");
    expect(text).toContain("Packet size bands");
    expect(text).toContain("Packet budget utilization");
    expect(text).toContain("Roster13 included of 18 candidates");

    const table = renderer?.root
      .findAllByType("table")
      .find((node) => node.props["aria-label"] === "Context analytics bucket table");
    expect(table).toBeDefined();
    expect(text).not.toContain("Packet text");
    expect(text).not.toContain("Open body");
    expect(text).not.toContain("Download");
    expect(text.toLowerCase()).not.toContain("consum");
  });

  it("maps the applied metadata filters and server-normalized window exactly into Inspector drill-down", async () => {
    await render();
    const inputs = renderer!.root.findAllByType("input");
    const provider = inputs.find(
      (input) => input.props["aria-label"] === "Context analytics provider",
    );
    const thread = inputs.find((input) => input.props["aria-label"] === "Context analytics thread");

    await act(() => {
      provider!.props.onChange({ currentTarget: { value: providerInstanceId } });
      thread!.props.onChange({ currentTarget: { value: threadId } });
      testState.selectHandlers[0]!("provider_start_accepted");
      testState.selectHandlers[1]!("provider_unsupported");
    });
    await act(() => buttonNamed("Apply filters")!.props.onClick());

    expect(testState.hookCalls.at(-1)?.[2]).toMatchObject({
      providerInstanceId,
      threadId,
      outcome: "provider_start_accepted",
      suppressionReason: "provider_unsupported",
    });

    await act(() => buttonNamed("Inspect matching records")!.props.onClick());
    expect(onInspect).toHaveBeenCalledWith({
      from: analyticsResult.from,
      to: analyticsResult.to,
      providerInstanceId,
      threadId,
      outcome: "provider_start_accepted",
      suppressionReason: "provider_unsupported",
    });
  });

  it("keeps the longest hourly preset within 49 wall-clock buckets at an unaligned time", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-17T12:30:00.000Z"));
    await render();

    expect(buttonNamed("24 hours · hour")).toBeDefined();
    expect(buttonNamed("2 days · hour")).toBeDefined();
    expect(buttonNamed("7 days · day")).toBeDefined();
    expect(buttonNamed("30 days · day")).toBeDefined();

    await act(() => buttonNamed("2 days · hour")!.props.onClick());
    expect(testState.hookCalls.at(-1)?.[2]).toMatchObject({
      bucket: "hour",
      from: "2026-10-15T12:30:00.000Z",
      to: "2026-10-17T12:30:00.000Z",
    });
  });
});
