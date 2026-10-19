# Civilization v1.5 — Coordination & Onboarding

- Release date: October 19, 2026 (America/Denver)
- Release tag: `civilization-v1.5`
- Product baseline: Civilization v1.4 (`civilization-v1.4`, `2eb0e95553`)
- Implementation tip before final upstream reconciliation: `a28f725a8e15a5c3de7c5b250d16deba100336ae`
- Reconciled upstream baseline: `1451e7cb23034d29774338608368a15d8845df36`
- Upstream merge: `568d3e35a9`

## Shipped scope

Civilization v1.5 keeps the existing five-task Settings information architecture and adds five
coordination capabilities without introducing a second execution authority:

- **Project Brief** — one bounded, revisioned operator-owned brief with body-free metadata reads,
  explicit body access, monotonic conflict-safe revisions, packet provenance, export/purge/recovery,
  and all-or-nothing packet inclusion.
- **Guided onboarding** — server-described presets and provider capability review, a body-free
  redacted preview under read permission, an explicit sensitive packet **Reveal** under
  `settings:write`, and a single Apply bound to both reviewed project and environment revisions.
- **Citizen search** — bounded metadata-only exact-project lookup integrated into the global command
  palette and read-only Civilization MCP without census crawling or cross-project fanout.
- **Structured passive handoffs** — immutable typed `handoff_v1` messages on the existing mail
  lifecycle. Handoffs do not wake, steer, poll, resume, queue, auto-reply, broadcast, or create
  provider work for the recipient.
- **Needs attention** — bounded, body-free, read-only operational attention on web and mobile for an
  exact physical project target. It reuses existing Overview / Configuration / Context destinations
  rather than adding a sixth Civilization task.

Remote Civilization push/notification capability (**V15-5b**) is deliberately **deferred**. Core
v1.5 does not change the hosted relay capability, remote notification registration, or push channel,
and accepting passive mail or a handoff is not a notification trigger.

## Persistence and compatibility

The release keeps the released Civilization migration ledger 64–77 intact, retains upstream
`CanonicalizeThreadPullRequestLinks` as migration 78, and adds:

- **079 — CivilizationProjectBrief**
- **080 — CivilizationMailContentKind**

Recovery acceptance upgrades the released ledger through 078/079/080 and verifies that the released
ledger is unchanged. Operational rollback remains snapshot-based: do not point an older binary at a
migrated home and assume disabling Civilization is a schema downgrade.

## Release qualification

The final release candidate was reconciled against current `upstream/main` before tagging. The
upstream three-way audit found no changes to Civilization migrations, ContextService,
RunExecutionService, runtime wiring, Civilization Environment HTTP/contracts/client state,
CommandPalette, mobile Civilization state/screens, relay contracts, or AgentAwarenessRelay. The
eight files changed by both sides merged without conflict; the coupled OpenCode 2, Orchestrator,
web timeline, settings search, CLI, lockfile, and passive-mail paths received dedicated post-merge
tests.

Post-reconciliation evidence:

- immutable dependency install from the merged lockfile completed successfully;
- contracts, client-runtime, server, web, and mobile typechecks pass;
- the focused v1.5 matrix passes **199/199 tests across 19 files**, including migrations/recovery,
  onboarding privacy/authority, Project Brief, passive handoffs, exact search, attention, and the
  stats-free performance gates;
- upstream-overlap non-browser coverage passes **532 tests with 1 intentional skip** across the
  relevant OpenCode 2, orchestration, CLI, mail, web-logic, and settings-search suites;
- the browser-only overlap/focus matrix passes **70/70 in Chromium**;
- mobile static checking completes successfully on the release machine; SwiftLint/ktlint/detekt are
  not installed on Windows and are explicitly reported as skipped by the repository's checker;
- third-party license notices reproduce with no tracked diff;
- the Android Expo native fingerprint can be generated from the merged release tree;
- the Civilization delta against current upstream is whitespace-clean.

The v1.5 mobile delta relative to current upstream contains React Native TypeScript only and **no
Swift, Kotlin, Java, Objective-C/C++, or native-module platform changes**. Therefore the release
plan's conditional native-device gate ("where native code changed") is not triggered by the
Civilization v1.5 delta. Mobile triage itself is covered by exact-scope/permission/no-query logic
tests, mobile typecheck/static checks, and the shared client/server attention acceptance. No device
or simulator pass is claimed by this record.

The previously authorized real-client web/desktop walkthrough remains part of the qualification:
it exercised a stable isolated server/client, exact checkout selection, the five-task Civilization
shell, Project Brief metadata behavior, onboarding target/provider/preset stages, Escape/URL cleanup,
and an error-free browser console without applying configuration.

## Privacy and authority closure

The final privacy review confirmed:

- Project Brief bodies are absent from metadata-only reads;
- redacted onboarding preview does not compose or prefetch Brief/note/mail bodies;
- revealed packet text is destroyed when `settings:write` is lost and cannot reappear without a new
  Reveal;
- preview cannot reserve identity, widen provider/runtime/interaction authority, or create side
  effects;
- search and attention remain body-free and exact-project scoped;
- handoff sender authority is server-derived from the authenticated current citizen and typed corrupt
  handoffs fail closed;
- no new daemon, autonomous model job, remote push path, or second execution authority was added.

## Publication boundary

`civilization-v1.5` is the source-release tag for this milestone. It intentionally does **not** use
the repository-wide `vX.Y.Z` tag namespace, whose workflow publishes the T3 npm/GitHub/hosted stable
channel.

The Civilization release publishes the dedicated branch/tag only. It does **not** advance fork
`main` as part of this release, because a `main` push can trigger production relay deployment and
mobile production workflows. Any later integration to `main` is a separate deployment decision and
must re-check current remote fast-forward safety first.
