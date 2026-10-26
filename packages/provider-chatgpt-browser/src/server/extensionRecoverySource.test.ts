import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "@effect/vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const contentSourcePath = path.resolve(here, "../../assets/extension/content.js");
const backgroundSourcePath = path.resolve(here, "../../assets/extension/background.js");
const fiberSourcePath = path.resolve(here, "../../assets/extension/fiber.js");

async function contentSource() {
  return fs.readFile(contentSourcePath, "utf8");
}

async function backgroundSource() {
  return fs.readFile(backgroundSourcePath, "utf8");
}

async function fiberSource() {
  return fs.readFile(fiberSourcePath, "utf8");
}

function sourceBetween(source: string, start: string, end: string) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  expect(from).toBeGreaterThanOrEqual(0);
  expect(to).toBeGreaterThan(from);
  return source.slice(from, to);
}

describe("managed extension native restart recovery source", () => {
  it("does not require the document-local send witness to reuse an exact broker-owned Fiber terminal", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "const exactNativeRecoveryTerminal = Boolean(",
      "if (\n      generating &&",
    );

    expect(block).not.toContain("openedUserMessageId");
    expect(block).toContain("nativeProviderRecoveryQuestionId");
    expect(block).toContain("nativeProviderRecoveryTurnId");
    expect(block).toContain("turnId === nativeProviderRecoveryTurnId");
    expect(block).toContain("newestUser?.id === nativeProviderRecoveryQuestionId");
    expect(block).toContain("activeNativeTurn?.question === nativeProviderRecoveryQuestionId");
  });

  it("closes an exact native restart candidate from broker user/final identity rather than openedUserMessageId", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "const recoveryCandidate = providerDrainRecoveryCandidate;",
      "maybeArmRestartProviderDrainRecovery();",
    );

    expect(block).not.toContain("openedUserMessageId");
    expect(block).toContain("recoveryCandidate?.nativeProvider === true");
    expect(block).toContain("recoveryCandidate.conversationId === conversationId");
    expect(block).toContain("CLF_DOM.conversationId() === recoveryCandidate.conversationId");
    expect(block).toContain("recoveryNativeTurn?.question === recoveryCandidate.userMessageId");
    expect(block).toContain(
      "recoveryNativeTurn.endMessageId === recoveryCandidate.terminalMessageId",
    );
    expect(block).toContain(
      "nativeProviderRecoveryFinalMessageId = recoveryCandidate.terminalMessageId",
    );
  });

  it("preserves exact native restart provenance when finishGeneration installs the drain barrier", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      'const nativeEnd = result.outcome === "completed" ? fiberTurnFor(ended) : null;',
      "noteGoalTurn(ended, result.outcome, endedTurnId);",
    );

    expect(block).toContain("const exactNativeRestartRecovery = Boolean(");
    expect(block).toContain("nativeProviderRecoveryTurnId === endedTurnId");
    expect(block).toContain("newestUserMessageId === nativeProviderRecoveryQuestionId");
    expect(block).toContain("nativeEnd?.question === nativeProviderRecoveryQuestionId");
    expect(block).toContain("nativeEnd?.endMessageId === nativeProviderRecoveryFinalMessageId");
    expect(block).toContain('recovery: "restart_unsealed"');
  });

  it("can arm two-phase drain directly from an exact broker terminal refresh after restart", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      'if (message.type === "clf-native-provider-refresh")',
      'if (message.type === "clf-repair-check")',
    );

    expect(block).toContain('message.state === "terminal"');
    expect(block).toContain('message.terminalStatus === "completed"');
    expect(block).toContain("message.finalObserved === true");
    expect(block).toContain("exactTurn?.question === userMessageId");
    expect(block).toContain("exactTurn.endMessageId === brokerFinalMessageId");
    expect(block).toContain('error: "native_drain_turn_conflict"');
    expect(block).toContain('recovery: "restart_unsealed"');
    expect(block).toContain("await maybePublishProviderDrainReady()");
  });

  it("does not make exact native provider drain depend on legacy request-owner correlation", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "const nativeProviderDrain = probeData.nativeProvider === true;",
      "const terminalMessageId = nativeTurn.endMessageId || null;",
    );

    expect(block).toContain("const nativeRecovery = recovery && nativeProviderDrain;");
    expect(block).toContain("if (!nativeProviderDrain) {");
    expect(block).toContain(
      "await confirmLiveRequestOwners(calls, pending.conversationId, current);",
    );
    expect(block).toContain("calls.some(");
    expect(block).toContain(
      "requestOwnersConfirmed.get(call.requestId) !== pending.conversationId",
    );
    expect(block).toContain(
      "if (!nativeProviderDrain && calls.some((call) => !call?.requestId)) {",
    );
    expect(source).toContain(
      "const nativeProviderDrainRefresh = settled?.nativeProviderDrain === true;",
    );
    expect(source).toContain("!nativeProviderDrainRefresh &&");
    expect(source).toContain("nativeProviderDrain,");
  });

  it("keeps fallback terminal proof presentation-only so legacy correlation cannot wedge drain", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "async function providerDrainTerminalProof(recordedFinal, expectedTerminal) {",
      "/** Fresh exact terminal proof, shared by stuck-composer recovery and idle-tab retirement. */",
    );

    expect(block).toContain("const recovered = await refreshFiber(");
    expect(block).toContain("terminalProbe: terminal");
    expect(block).toContain("true,");
  });

  it("refreshes native observer views immediately when a replacement document registers", async () => {
    const source = await backgroundSource();
    const block = sourceBetween(
      source,
      "async register_document(_message, sender) {",
      "async cos_sign_in_transfer(message, sender) {",
    );

    expect(block).toContain("offerReadyNativeInputsForTab(result.tab);");
    expect(block).toContain("await maintainNativeProviderViews();");
    expect(block.indexOf("await maintainNativeProviderViews();")).toBeGreaterThan(
      block.indexOf("offerReadyNativeInputsForTab(result.tab);"),
    );
  });

  it("restores native observer views from the nonblocking prime before generation long-poll", async () => {
    const source = await backgroundSource();
    const prime = sourceBetween(
      source,
      "function primeNativeProvider() {",
      "async function maintainNativeProvider() {",
    );

    expect(prime).toContain("wait: false");
    expect(prime).toContain("await maintainNativeProviderViews();");
    expect(prime.indexOf("await maintainNativeProviderViews();")).toBeGreaterThan(
      prime.indexOf("nativeProviderGeneration = reply.data.generation;"),
    );
  });

  it("reloads only an exact retained native observer tab that Chrome restored unloaded", async () => {
    const source = await backgroundSource();
    const block = sourceBetween(
      source,
      "const documentId = Number.isInteger(tab.id) ? tabDocuments[String(tab.id)] : null;",
      "if (documentId)\n        void tabReply(",
    );

    expect(block).toContain("!documentId");
    expect(block).toContain('tab.status === "unloaded"');
    expect(block).toContain("tab.discarded === true");
    expect(block).toContain("await chrome.tabs.reload(tab.id);");
  });

  it("keeps native drain final evidence refresh bounded away from repair and continuation control waits", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "async function refreshFiber(settled = null, presentationOnly = false) {",
      "/** What the page says about this block, or null. */",
    );

    expect(block).toContain("if (nativeProviderDrainRefresh) return false;");
    expect(block).toContain("presentationOnly || nativeProviderDrainRefresh");
    expect(block).toContain(
      "const continuationReconciliation = nativeProviderDrainRefresh\n      ? null\n      : reconcileContinuationMarkers(markedTurns);",
    );
  });

  it("publishes connector tool evidence under the exact resolved provider-local owner", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "const providerLocalOwner =",
      "// What the settle window is waiting for",
    );

    expect(block).toContain("settledOwners.get(turn) || null");
    expect(block).toContain("providerDrainFenceFor(turn, providerLocalOwner)");
    expect(block).toContain("...(providerLocalOwner ? { turnId: providerLocalOwner } : {}),");
    expect(block).not.toContain(
      "...(index === activeTurnIndex ? { turnId: activeLocalTurnId } : {}),",
    );
  });

  it("maps qualified typed built-ins without using web query text or DOM order as identity", async () => {
    const source = await fiberSource();
    const block = sourceBetween(
      source,
      'step?.type === "web-search"',
      'if (step?.type === "assistant-message" && item !== step)',
    );

    expect(block).toContain('step.action.type === "search"');
    expect(block).toContain('structuralKind: "web-search"');
    expect(block).toContain("structuralOrdinal: webSearchOrdinal");
    expect(block).toContain("structuralKey: `web-search:${webSearchOrdinal++}`");
    expect(block).not.toContain("step.query");
    expect(block).toContain("const id = str(step.id);");
    expect(block).toContain('step.status === "running" ? true');
    expect(block).toContain('step.status === "completed" ? false');
    expect(block).not.toContain("order:");
  });

  it("binds an unresolved fresh shell turn only from the exact locally witnessed user-message id", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      'const newestUser = [...CLF_DOM.messages()].reverse().find((message) => message.role === "user");',
      "const currentContinuationMarker = markedAs(newestUser?.text);",
    );

    expect(block).toContain("!ownedPageTurn &&");
    expect(block).toContain("exactOwner?.localTurnId &&");
    expect(block).toContain("openedUserMessageId === newestUser.id");
    expect(block).toContain("turn?.question !== newestUser.id");
    expect(block).toContain("exactQuestionTurns.length === 1");
    expect(block).not.toContain("index === answer.turns.length - 1");
  });

  it("materializes structural page-tool identities only with an exact local owner and preserves explicit live status", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      'if (item.type === "activity") {',
      "const message = item.value;",
    );

    expect(block).toContain('owner && typeof activity.structuralKey === "string"');
    expect(block).toContain("? `${owner}:${activity.structuralKey}`");
    expect(block).toContain("if (!messageId) continue;");
    expect(block).toContain('typeof activity.activeNow === "boolean"');
    expect(block).toContain("explicitActiveNow && generating && owner === turnId");
  });

  it("fails closed instead of remapping a regressed typed web-search prefix", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "const structuralWeb = (turn.activities || []).filter(",
      "const items = [];",
    );

    expect(block).toContain('activity?.structuralKind === "web-search"');
    expect(block).toContain("activity.structuralOrdinal === at");
    expect(block).toContain("current.length >= prior.length");
    expect(block).toContain('status === "completed" && current[at] === "running"');
    expect(block).toContain("if (ordinalsStable && prefixStable)");
    expect(source).toContain(
      'if (activity.structuralKind === "web-search" && !structuralWebAllowed) continue;',
    );
  });

  it("rebuilds only the exact typed structural web activity across the MAIN-world trust boundary", async () => {
    const source = await contentSource();
    const block = sourceBetween(
      source,
      "const structuralWeb =",
      "const keptActivities = activities.filter(",
    );

    expect(block).toContain('entry.structuralKind === "web-search"');
    expect(block).toContain("entry.structuralKey === `web-search:${entry.structuralOrdinal}`");
    expect(block).toContain('entry.label === "Web search"');
    expect(block).toContain('typeof entry.activeNow === "boolean"');
    expect(block).toContain("const identity = structuralWeb");
    expect(block).toContain("`structural:web-search:${entry.structuralOrdinal}`");
    expect(block).toContain(": messageId;");
    expect(block).toContain(
      '...(typeof entry.activeNow === "boolean" ? { activeNow: entry.activeNow } : {})',
    );
    expect(block).not.toContain("step.query");
  });
});
