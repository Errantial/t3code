import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { CivilizationTaskSelector } from "./CivilizationSettings";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});

it.each([
  ["overview", "chronicle", "analytics", "Civilization view", "Overview"],
  ["activity", "messages", "analytics", "Civilization activity view", "Correspondence"],
  ["context", "chronicle", "inspector", "Civilization context view", "Inspector"],
] as const)(
  "renders the selected %s task with its readable label",
  async (view, activityMode, contextMode, label, text) => {
    await act(async () => {
      root.render(
        <CivilizationTaskSelector
          view={view}
          activityMode={activityMode}
          contextMode={contextMode}
          navigate={vi.fn()}
        />,
      );
    });
    expect(
      container.querySelector(`button[role="combobox"][aria-label="${label}"]`)?.textContent,
    ).toBe(text);
  },
);
