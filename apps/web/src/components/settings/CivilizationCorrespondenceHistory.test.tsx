import {
  CivilizationMessageId,
  EnvironmentId,
  ProjectId,
  ThreadId,
  type CivilizationMailSummary,
} from "@t3tools/contracts";
import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const environmentId = EnvironmentId.make("environment-correspondence-ui");
const projectId = ProjectId.make("project-correspondence-ui");
const senderId = ThreadId.make("thread-correspondence-sender");
const recipientId = ThreadId.make("thread-correspondence-recipient");
const messageId = CivilizationMessageId.make("mail:correspondence-ui");

const message: CivilizationMailSummary = {
  messageId,
  senderThreadId: senderId,
  senderNameAtSend: "Ada",
  senderCitizenEpoch: 3,
  senderRunId: "run:correspondence-ui" as never,
  recipientThreadId: recipientId,
  recipientDeliveryEpoch: 7,
  replyToMessageId: null,
  bodyBytes: 42,
  acceptedRuntimeMode: "full-access",
  acceptedInteractionMode: "default",
  acceptedEnvironmentRevision: 1,
  acceptedProjectRevision: 2,
  acceptedAt: "2026-10-17T20:00:00.000Z",
  expiresAt: "2026-11-17T20:00:00.000Z",
  terminalRetentionDays: 30,
  firstOfferedAt: "2026-10-17T20:01:00.000Z",
  lastOfferedAt: "2026-10-17T20:01:00.000Z",
  offerCount: 1,
  acknowledgedAt: "2026-10-17T20:02:00.000Z",
  terminalAt: null,
  terminalReason: null,
};

const testState = vi.hoisted(() => ({
  pageCalls: [] as unknown[][],
  threadCalls: [] as unknown[][],
  sensitiveReads: [] as unknown[],
  writable: true,
}));

vi.mock("@effect/atom-react", () => ({
  useAtomSet: () => async (input: unknown) => {
    testState.sensitiveReads.push(input);
    return { projectId, ...message, body: "secret-body-text" };
  },
}));

vi.mock("../../state/session", () => ({
  useEnvironmentScope: () => testState.writable,
  readEnvironmentScope: () => testState.writable,
}));

vi.mock("../../state/civilization", () => ({
  civilizationSensitiveReadAction: Symbol("sensitive"),
  useCivilizationCorrespondencePage: (...args: unknown[]) => {
    testState.pageCalls.push(args);
    return {
      data: { projectId, revision: 4, messages: [message], nextCursor: null, partial: false },
      error: null,
      isPending: false,
      refresh: vi.fn(),
    };
  },
  useCivilizationCorrespondenceThread: (...args: unknown[]) => {
    testState.threadCalls.push(args);
    const selected = args[2];
    return {
      data:
        selected === null
          ? null
          : {
              projectId,
              revision: 4,
              selectedMessageId: messageId,
              entries: [{ message, relation: "selected", depth: 0, unresolvedParent: false }],
              rootStatus: "resolved",
              ancestorTruncated: false,
              descendantsTruncated: false,
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

import { CivilizationCorrespondenceHistory } from "./CivilizationCorrespondenceHistory";

let renderer: ReactTestRenderer | undefined;
const onViewLineage = vi.fn();
const onViewChronicleSource = vi.fn();

const renderedText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "object" && value !== null && "children" in value) {
    return renderedText((value as { readonly children?: unknown }).children);
  }
  return "";
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.pageCalls = [];
  testState.threadCalls = [];
  testState.sensitiveReads = [];
  testState.writable = true;
  onViewLineage.mockReset();
  onViewChronicleSource.mockReset();
});

afterEach(async () => {
  await act(() => renderer?.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});

describe("Civilization correspondence history", () => {
  it("renders metadata only and keeps thread/body reads explicit", async () => {
    await act(() => {
      renderer = create(
        <CivilizationCorrespondenceHistory
          environmentId={environmentId}
          projectId={projectId}
          pageSize={25}
          allowSensitiveActions
          onViewLineage={onViewLineage}
          onViewChronicleSource={onViewChronicleSource}
        />,
      );
    });

    const rendered = renderedText(renderer?.toJSON());
    expect(rendered).toContain("Correspondence history");
    expect(rendered).toContain("epoch 3");
    expect(rendered).toContain("recipient delivery epoch 7");
    expect(rendered).toContain("acknowledged");
    expect(rendered).toContain("terminal no");
    expect(rendered).toContain(
      "cannot send, reply, wake, steer, resume, acknowledge, or impersonate",
    );
    expect(rendered).not.toContain("secret-body-text");
    expect(testState.sensitiveReads).toHaveLength(0);
    expect(testState.threadCalls.at(-1)?.[2]).toBeNull();

    const chronicleButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Chronicle");
    await act(() => chronicleButton!.props.onClick());
    expect(onViewChronicleSource).toHaveBeenCalledWith(`mail:${messageId}:sent`);

    const threadButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Thread");
    await act(() => threadButton!.props.onClick());
    expect(testState.threadCalls.at(-1)?.[2]).toBe(messageId);

    const bodyButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Open body");
    await act(async () => bodyButton!.props.onClick());
    expect(testState.sensitiveReads).toEqual([
      { type: "mailBody", environmentId, projectId, messageId },
    ]);
  });

  it("opens a cross-linked message thread without offering or acknowledging it", async () => {
    await act(() => {
      renderer = create(
        <CivilizationCorrespondenceHistory
          environmentId={environmentId}
          projectId={projectId}
          pageSize={10}
          allowSensitiveActions
          initialParticipantThreadId={senderId}
          initialMessageId={messageId}
        />,
      );
    });
    expect(testState.pageCalls.at(-1)?.[2]).toMatchObject({
      participantThreadId: senderId,
      replyRelation: "any",
    });
    expect(testState.threadCalls.at(-1)?.[2]).toBe(messageId);
    expect(testState.sensitiveReads).toHaveLength(0);
  });

  it("applies a participant filter as one bounded correspondence query", async () => {
    await act(() => {
      renderer = create(
        <CivilizationCorrespondenceHistory
          environmentId={environmentId}
          projectId={projectId}
          pageSize={10}
          allowSensitiveActions
        />,
      );
    });
    const participant = renderer!.root
      .findAllByType("input")
      .find((input) => input.props["aria-label"] === "Correspondence participant thread");
    await act(() => participant!.props.onChange({ currentTarget: { value: senderId } }));
    const apply = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply filters");
    await act(() => apply!.props.onClick());

    expect(testState.pageCalls.at(-1)?.[2]).toMatchObject({
      participantThreadId: senderId,
      replyRelation: "any",
    });
    expect(testState.pageCalls.at(-1)?.[4]).toBe(10);
  });

  it("rechecks settings permission when body inspection is clicked", async () => {
    await act(() => {
      renderer = create(
        <CivilizationCorrespondenceHistory
          environmentId={environmentId}
          projectId={projectId}
          pageSize={10}
          allowSensitiveActions
        />,
      );
    });
    const bodyButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Open body");
    testState.writable = false;
    await act(() => bodyButton!.props.onClick());
    expect(testState.sensitiveReads).toHaveLength(0);
    expect(renderedText(renderer?.toJSON())).toContain("Restricted");
  });
});
