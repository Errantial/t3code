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
  emptyPage: false,
  emptyThread: false,
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
      data: {
        projectId,
        revision: 4,
        messages: testState.emptyPage ? [] : [message],
        citizenReferences: [
          { threadId: senderId, name: "Ada Current" },
          { threadId: recipientId, name: "Grace" },
        ],
        nextCursor: null,
        partial: false,
      },
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
              entries: testState.emptyThread
                ? []
                : [{ message, relation: "selected", depth: 0, unresolvedParent: false }],
              citizenReferences: [
                { threadId: senderId, name: "Ada Current" },
                { threadId: recipientId, name: "Grace" },
              ],
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
const onViewCitizen = vi.fn();

const renderedText = (value: unknown): string => {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(renderedText).join("");
  if (typeof value === "object" && value !== null && "children" in value) {
    return renderedText((value as { readonly children?: unknown }).children);
  }
  if (typeof value === "object" && value !== null && "props" in value) {
    return renderedText(
      (value as { readonly props?: { readonly children?: unknown } }).props?.children,
    );
  }
  return "";
};

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  testState.pageCalls = [];
  testState.threadCalls = [];
  testState.sensitiveReads = [];
  testState.writable = true;
  testState.emptyPage = false;
  testState.emptyThread = false;
  onViewLineage.mockReset();
  onViewChronicleSource.mockReset();
  onViewCitizen.mockReset();
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
          onViewCitizen={onViewCitizen}
          onViewChronicleSource={onViewChronicleSource}
        />,
      );
    });

    const rendered = renderedText(renderer?.toJSON());
    expect(rendered).toContain("Correspondence history");
    expect(rendered).toContain("Sender epoch 3");
    expect(rendered).toContain("Delivery epoch 7");
    expect(rendered).toContain("Grace");
    expect(rendered).toContain("Acknowledged");
    expect(rendered).toContain("Active");
    expect(rendered).toContain("Advanced filters");
    expect(rendered).toContain("View message");
    expect(rendered).toContain(
      "cannot send, reply, wake, steer, resume, acknowledge, or impersonate",
    );
    expect(rendered).not.toContain("secret-body-text");
    expect(testState.sensitiveReads).toHaveLength(0);
    expect(testState.threadCalls.at(-1)?.[2]).toBeNull();

    const citizenButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "View citizen Ada");
    expect(citizenButton).toBeDefined();
    await act(() => citizenButton!.props.onClick());
    expect(onViewCitizen).toHaveBeenCalledWith(senderId);
    expect(testState.sensitiveReads).toHaveLength(0);

    const chronicleButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Chronicle");
    await act(() => chronicleButton!.props.onClick());
    expect(onViewChronicleSource).toHaveBeenCalledWith(`mail:${messageId}:sent`);

    const threadButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Reply chain");
    await act(() => threadButton!.props.onClick());
    expect(testState.threadCalls.at(-1)?.[2]).toBe(messageId);

    const bodyButton = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "View message");
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
          citizenOptions={[
            {
              threadId: senderId,
              projectId,
              name: "Ada",
              profileId: "calm",
              profileLabel: "Calm",
              generation: 0,
              lineageStatus: "resolved",
              parentThreadId: null,
              relationshipToParent: null,
              observedOnly: false,
              epoch: 3,
              closed: false,
              deleted: false,
              titleManaged: true,
              revision: 1,
            },
          ]}
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
    const citizenATrigger = renderer!.root
      .findAllByType("button")
      .find((button) => button.props["aria-label"] === "Conversation citizen A");
    expect(renderedText(citizenATrigger?.props.children)).toContain("Ada");
    expect(renderedText(citizenATrigger?.props.children)).not.toContain(String(senderId));
  });

  it("keeps citizen selectors primary while advanced metadata issues one bounded query", async () => {
    await act(() => {
      renderer = create(
        <CivilizationCorrespondenceHistory
          environmentId={environmentId}
          projectId={projectId}
          pageSize={10}
          allowSensitiveActions
          initialParticipantThreadId={senderId}
        />,
      );
    });
    const inputs = renderer!.root.findAllByType("input");
    expect(
      inputs.some((input) => input.props["aria-label"] === "Correspondence participant thread"),
    ).toBe(false);
    expect(
      inputs.some((input) => input.props["aria-label"] === "Correspondence counterparty thread"),
    ).toBe(false);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Conversation citizen A"),
    ).toBe(true);
    expect(
      renderer!.root
        .findAllByType("button")
        .some((button) => button.props["aria-label"] === "Conversation citizen B"),
    ).toBe(true);
    const sender = inputs.find(
      (input) => input.props["aria-label"] === "Correspondence sender thread",
    );
    const recipient = inputs.find(
      (input) => input.props["aria-label"] === "Correspondence recipient thread",
    );
    await act(() => sender!.props.onChange({ currentTarget: { value: senderId } }));
    await act(() => recipient!.props.onChange({ currentTarget: { value: recipientId } }));
    const apply = renderer!.root
      .findAllByType("button")
      .find((button) => button.props.children === "Apply advanced filters");
    await act(() => apply!.props.onClick());

    expect(testState.pageCalls.at(-1)?.[2]).toMatchObject({
      participantThreadId: senderId,
      senderThreadId: senderId,
      recipientThreadId: recipientId,
      replyRelation: "any",
    });
    expect(testState.pageCalls.at(-1)?.[4]).toBe(10);
    expect(testState.sensitiveReads).toHaveLength(0);
  });

  it("shows explicit loaded-empty states for conversations and reply chains", async () => {
    testState.emptyPage = true;
    testState.emptyThread = true;
    await act(() => {
      renderer = create(
        <CivilizationCorrespondenceHistory
          environmentId={environmentId}
          projectId={projectId}
          pageSize={10}
          allowSensitiveActions
          initialMessageId={messageId}
        />,
      );
    });

    const rendered = renderedText(renderer?.toJSON());
    expect(rendered).toContain(
      "No retained correspondence matches this conversation and filter set.",
    );
    expect(rendered).toContain("No retained messages are available for this reply chain.");
    expect(renderer!.root.findAll((node) => node.props.role === "status")).toHaveLength(2);
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
      .find((button) => button.props.children === "View message");
    testState.writable = false;
    await act(() => bodyButton!.props.onClick());
    expect(testState.sensitiveReads).toHaveLength(0);
    expect(renderedText(renderer?.toJSON())).toContain("Restricted");
  });
});
