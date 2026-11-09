import { EnvironmentId, SwarmId, ThreadId, type SwarmThreadView } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  activeRunId: null as string | null,
  summary: undefined as object | undefined,
  swarms: [] as ReadonlyArray<unknown>,
  list: vi.fn(),
}));
vi.mock(import("./swarmAvailability"), async (importOriginal) => ({
  ...(await importOriginal()),
  swarmV2EnabledAtom: (() => "enabled") as never,
}));
vi.mock(import("../../state/swarmSummaries"), async (importOriginal) => ({
  ...(await importOriginal()),
  swarmSummaryAtom: (() => "summary") as never,
}));
vi.mock(import("@effect/atom-react"), async (importOriginal) => ({
  ...(await importOriginal()),
  useAtomValue: ((atom: unknown) => (atom === "summary" ? state.summary : true)) as never,
}));
vi.mock(import("../../state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useQuietThreadShell: (() => ({ activeRunId: state.activeRunId })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), async (importOriginal) => {
  const { swarmListForThreadCommand } = await import("../../state/swarm");
  return {
    ...(await importOriginal()),
    useAtomCommand: ((command: unknown) =>
      command === swarmListForThreadCommand ? state.list : vi.fn()) as never,
  };
});

import { act, fakeTimers, render as renderUi } from "../../../test/render";
import { ThreadSwarmPanel } from "./ThreadSwarmPanel";

const environmentId = EnvironmentId.make("local");
const threadId = ThreadId.make("thread:architect");
const view = {
  swarmId: SwarmId.make("swarm:1"),
  title: "Late swarm",
  status: "active",
  wakePolicy: "group",
  budgetExhausted: false,
  turnsUsed: 0,
  maxTotalTurns: 240,
  createdAt: "2026-11-09T00:00:00.000Z",
  members: [],
  instances: [],
  notices: [],
} as unknown as SwarmThreadView;

// SW-A11 live run: a swarm started while its architect thread was open never appeared, because
// the panel loaded once and polled only while it already showed an active swarm.
it("loads again when the sidebar's poll finds a swarm for this thread", async () => {
  state.summary = undefined;
  state.swarms = [];
  state.list.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: { swarms: state.swarms },
  }));
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  const renderPanel = () =>
    act(
      async () =>
        await screen.rerender(
          <ThreadSwarmPanel environmentId={environmentId} threadId={threadId} />,
        ),
    );

  await renderPanel();
  expect(state.list).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).not.toContain("Late swarm");

  state.swarms = [view];
  state.summary = { threadId, running: 1, queued: 0, failed: 0 };
  await renderPanel();
  await vi.waitFor(() => expect(screen.container.textContent).toContain("Late swarm"));
  expect(state.list).toHaveBeenCalledTimes(2);
});

// SW-A11 live run: a page opened on the architect thread asked before its environment connected,
// got a failure, and never asked again, so a finished swarm's panel never appeared.
it("tries again after a failed first load", async () => {
  using _timers = fakeTimers();
  state.summary = undefined;
  state.swarms = [{ ...view, status: "completed" }];
  let calls = 0;
  state.list.mockReset().mockImplementation(async () => {
    calls += 1;
    return calls === 1
      ? { _tag: "Failure", cause: Cause.fail(new Error("not connected")) }
      : { _tag: "Success", value: { swarms: state.swarms } };
  });
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  await act(
    async () =>
      await screen.rerender(<ThreadSwarmPanel environmentId={environmentId} threadId={threadId} />),
  );
  expect(state.list).toHaveBeenCalledTimes(1);
  expect(screen.container.textContent).not.toContain("Late swarm");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(3_000);
  });
  expect(state.list).toHaveBeenCalledTimes(2);
  expect(screen.container.textContent).toContain("Late swarm");
});

// The live-run follow-up: a swarm the architect's own run creates shows within one 10 s poll,
// without waiting for the sidebar's 60 s poll.
it("polls every 10 s while the architect has a live run", async () => {
  using _timers = fakeTimers();
  state.activeRunId = "run:architect";
  state.summary = undefined;
  state.swarms = [];
  state.list.mockReset().mockImplementation(async () => ({
    _tag: "Success",
    value: { swarms: state.swarms },
  }));
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  await act(
    async () =>
      await screen.rerender(<ThreadSwarmPanel environmentId={environmentId} threadId={threadId} />),
  );
  expect(state.list).toHaveBeenCalledTimes(1);
  state.swarms = [view];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(10_000);
  });
  expect(state.list).toHaveBeenCalledTimes(2);
  expect(screen.container.textContent).toContain("Late swarm");
  state.activeRunId = null;
});

it("does not retry a permanent refusal", async () => {
  using _timers = fakeTimers();
  state.activeRunId = null;
  state.summary = undefined;
  state.list.mockReset().mockImplementation(async () => ({
    _tag: "Failure",
    cause: Cause.fail({ _tag: "SwarmRpcError", reason: "disabled", message: "off" }),
  }));
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(await renderUi(null));
  await act(
    async () =>
      await screen.rerender(<ThreadSwarmPanel environmentId={environmentId} threadId={threadId} />),
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(120_000);
  });
  expect(state.list).toHaveBeenCalledTimes(1);
});
