import { StrictMode } from "react";
import { EnvironmentId, ThreadId, type ScopedThreadRef } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";
import { act, render } from "../../../test/render";
import { selectThreadPanelOpen, useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsCard } from "./ThreadDetailsCard";

const threadA: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-a"),
};
const threadB: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread-b"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;

function setup() {
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

const popoverOpen = (threadRef: ScopedThreadRef) =>
  selectThreadPanelOpen(
    useRightPanelStore.getState().threadPanelVisibilityByThreadKey,
    threadRef,
    "popover",
  );

function Card({
  threadRef,
  inline,
  fixture,
  rows = 1,
}: {
  threadRef: ScopedThreadRef;
  inline: boolean;
  fixture: ReturnType<typeof setup>;
  /** Rows of 100px shown at full density. Compact always takes 50px. */
  rows?: number;
}) {
  return (
    // The web root renders in StrictMode, which re-runs ref callbacks on every mount.
    <StrictMode>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: () => {},
          measureDetailsCard: () => {},
          detailsCardTopInset: 0,
          preferredDetailsCard: placement,
          detailsCardPlacement: inline ? placement : null,
        }}
      >
        <ThreadDetailsCard
          threadRef={threadRef}
          anchor={fixture.anchor}
          handle={fixture.handle}
          contentKey={String(rows)}
        >
          {(density) => (
            <p style={{ height: density === "full" ? rows * 100 : 50 }}>
              Details for {threadRef.threadId}
            </p>
          )}
        </ThreadDetailsCard>
      </ChatCanvasContext>
    </StrictMode>
  );
}

it("stays open once opened", async () => {
  using fixture = setup();
  await using _screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  expect(popoverOpen(threadB)).toBe(true);
});

it("closes a popup left open when the card switches inline, and reopens from the flag", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  const setOpen = (open: boolean) =>
    act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", open));
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", false);
  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(false);

  await screen.rerender(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
});

it("does not reopen the popover when the card returns from inline mode", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  useRightPanelStore.getState().setThreadPanelOpen(threadB, "inline", false);
  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();

  await screen.rerender(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  expect(popoverOpen(threadB)).toBe(false);
});

it("removes the leaving thread's popup on a thread switch", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  await act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", true));
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();

  await screen.rerender(<Card threadRef={threadA} inline={false} fixture={fixture} />);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await expect.element(page.getByText("Details for thread-a")).not.toBeInTheDocument();
});

it("reopens after a normal close", async () => {
  using fixture = setup();
  await using _screen = await render(<Card threadRef={threadB} inline={false} fixture={fixture} />);
  const setOpen = (open: boolean) =>
    act(() => useRightPanelStore.getState().setThreadPanelOpen(threadB, "popover", open));
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
  await setOpen(false);
  await expect.element(page.getByText("Details for thread-b")).not.toBeInTheDocument();
  await setOpen(true);
  await expect.element(page.getByText("Details for thread-b")).toBeVisible();
});

it("returns to full density when hidden items make the content fit", async () => {
  using fixture = setup();
  await using screen = await render(<Card threadRef={threadB} inline fixture={fixture} rows={6} />);
  const card = page.getByRole("region", { name: "Thread details" });
  await expect.element(card).toHaveAttribute("data-density", "compact");

  await screen.rerender(<Card threadRef={threadB} inline fixture={fixture} rows={2} />);
  await expect.element(card).toHaveAttribute("data-density", "full");
});

// SW-A11 F-D2: a 24-member roster made the card compact, and compact hides the Swarm panel.
it("keeps full density, and the swarm panel, with a 24-member roster at 1280×800", async () => {
  await page.viewport(1280, 800);
  using fixture = setup();
  const panel = (withMarker: boolean) => (
    <ChatCanvasContext
      value={{
        container,
        lane: { padding: 48, minChatWidth: 640 },
        layout: resolveChatCanvasLayout({ container, preview: null }),
        previewKey: null,
        registerTimeline: () => {},
        measureDetailsCard: () => {},
        detailsCardTopInset: 0,
        preferredDetailsCard: placement,
        detailsCardPlacement: placement,
      }}
    >
      <ThreadDetailsCard
        threadRef={threadB}
        anchor={fixture.anchor}
        handle={fixture.handle}
        contentKey={String(withMarker)}
      >
        {(density) =>
          density === "full" ? (
            <section {...(withMarker ? { "data-thread-swarm-panel": "" } : {})}>
              <h3>Swarm: Restart 24</h3>
              <div>
                {Array.from({ length: 24 }, (_, index) => (
                  <p key={index} style={{ height: 40, flexShrink: 0 }}>
                    member {index}
                  </p>
                ))}
              </div>
            </section>
          ) : (
            <p style={{ height: 50 }}>compact</p>
          )
        }
      </ThreadDetailsCard>
    </ChatCanvasContext>
  );
  await using screen = await render(panel(false));
  const card = page.getByRole("region", { name: "Thread details" });
  // Counted toward density, the roster forces compact and the panel is gone.
  await expect.element(card).toHaveAttribute("data-density", "compact");

  await screen.rerender(panel(true));
  await expect.element(card).toHaveAttribute("data-density", "full");
  await expect.element(page.getByText("Swarm: Restart 24")).toBeVisible();
});
