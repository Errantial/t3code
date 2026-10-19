# Civilization

Civilization is an optional project-scoped layer that gives participating T3 threads durable identities and bounded ways to share project context without turning them into a background swarm.

It is off by default. When enabled for a project, eligible threads can become **citizens**. Their Civilization identity, lineage, notes, correspondence, and retained history are stored by the same T3 server that owns the project.

## Open Civilization

On web or desktop, open **Settings → Civilization**. Use the normal Settings scope control to select the environment and project you want to inspect or configure.

The page is organized into five tasks:

- **Overview** shows participation, effective status, population counts, provider support, and body-free **Needs attention** items. It is the only Civilization view designed to summarize more than one selected target; project attention itself is queried only for one exact physical project.
- **Citizens** contains the census, citizen details, and lineage. Select one exact project/checkout before using the rich citizen views.
- **Activity** contains the Chronicle, correspondence history, and notes.
- **Context** contains context analytics and the historical Inspector. Drill-downs carry exact metadata filters into the Inspector instead of broadening the query.
- **Configuration** contains participation, identity, personality, context, messaging, provider, Project Brief, onboarding/review setup, retention, import/export, reset, and purge controls.

On mobile, **Settings → Civilization** provides a bounded read-only overview. When the current mobile scope resolves to exactly one physical project, it can also show body-free **Needs attention** items for that project. Administrative writes and sensitive-body operations remain on web/desktop.

## Citizens and managed titles

A citizen is keyed to a real T3 thread. Its Civilization identity survives ordinary provider/session changes and is not regenerated on each turn.

When managed titles are enabled, Civilization composes the citizen name with T3's task topic using the default shape `[Name] Topic`. A manual title edit gives title ownership back to the user or agent; Civilization does not continually overwrite explicit titles.

Forks and T3-owned child relationships retain their real lineage. Civilization displays that relationship rather than inventing a separate ancestry graph.

## Personality rendering

Each citizen can have one stable personality profile. Rendering controls whether that stored profile is exposed to a supported provider:

- `off` — no personality presentation is included;
- `mild` — short presentation traits/style are included;
- `rich` — the corresponding richer archetype presentation is included.

Changing rendering strength does not reroll the citizen's profile. Personality is presentation data only: it cannot grant tools, expand permissions, change security policy, override the user's task, or authorize extra work.

## Context and shared notes

Civilization context is deliberately bounded. A supported turn may receive current feature/provider status, the caller's identity, a small census/roster view, selected shared notes, eligible correspondence excerpts, and references for further explicit reads.

Civilization does not create an infinite shared memory, automatically ingest arbitrary transcripts, or run background model calls to summarize history.

Notes are explicit attributed records. Reads and mutations remain subject to the owning server's permissions and Civilization's transfer policy.

### Project Brief

Each project can have one bounded operator-owned **Project Brief** with a summary, objectives, constraints, and references. It is revisioned project data, not a citizen note, task authority, or system instruction. When included in a citizen packet it remains untrusted coordination data and is omitted whole if it cannot fit the packet budget.

Project Brief access is intentionally split:

- body-free metadata such as configured state, revision, byte count, and update time is available with normal `orchestration:read` access;
- reading the exact body, creating/updating it, and clearing it require a fresh `settings:write` check;
- save/clear uses the loaded Brief revision and never auto-retries a conflict;
- clearing advances the Brief revision and removes it from future packets, but does not retroactively rewrite an older packet body that was already retained under the existing diagnostic policy.

The Brief editor is under **Configuration** and never needs to prefetch the body just to show its metadata state.

## Guided onboarding and preview

Configuration includes a guided setup/review flow for one exact physical project. Presets are described by the server and remain ordinary configuration transforms; adoption and managed-title choices stay explicit rather than being hidden inside a preset.

The preview boundary is deliberate:

- the normal preview is redacted/body-free and can show the reviewed config diff, effective settings, capability/readiness, and packet budget/composition without starting a provider or mutating Civilization state;
- exact packet text is a separate explicit **Reveal** action, available only for a real existing citizen with server-resolved provider/runtime authority and a fresh `settings:write` check;
- packet text is not prefetched or put into URL/history state;
- project-scoped Apply is one ordinary config write bound to both the reviewed **project revision** and inherited **environment revision**;
- if either revision, the target, or the reviewed candidate changes, approval is invalidated and the user must preview again. Conflicts preserve the choices for review; Civilization does not auto-retry the write.

Configuration-only preview never fabricates or reserves a future citizen identity.

## Finding citizens

Citizen-aware search is available from normal T3 navigation as a bounded metadata-only lookup. Search always targets one exact physical project and returns citizen/thread identity plus lifecycle/host metadata; it does not search note, mail, Project Brief, prompt, personality-style, or historical packet bodies.

If there is no exact project context, choose a project/checkout first. Civilization does not fan out a citizen query across every project or silently substitute another checkout when a result becomes stale. Selecting a citizen opens the real T3 thread.

## Passive correspondence

Citizens can send durable addressed correspondence to eligible citizens in the same civilization. Delivery is intentionally passive:

- sending mail does not wake the recipient;
- Civilization does not steer or poll the recipient;
- there are no automatic replies or broadcasts;
- a recipient sees eligible mail during an ordinary supported turn or an explicit inbox read;
- settlement, archive, deletion, policy changes, and permission ceilings can make pending content unavailable.

This makes correspondence a durable coordination mechanism without silently turning a stored message into agent execution.

Alongside ordinary text mail, a citizen can send a typed **`handoff_v1`** message containing a bounded summary, completed work, decisions, next actions, blockers/questions, and references. It uses the same authenticated current-citizen authority, recipient/lifecycle guards, quotas, TTL, offer/acknowledgement, reply, cleanup, purge, and recovery semantics as passive mail.

Structured handoff delivery does **not** wake, steer, poll, resume, queue work for, or auto-reply on behalf of the recipient. Human correspondence UI remains inspection-only; it does not gain a “send as citizen” path.

Retained correspondence exposes the message content kind. Body-bearing handoff reads are schema-validated as `handoff_v1` rather than silently treated as opaque text, while simple/runtime presentation can use a deterministic bounded text rendering. Project export keeps the typed handoff representation; the export remains an inspection/data export rather than a restore/import authority.

## Needs attention

Civilization can compute a small **Needs attention** snapshot from existing project status, provider capability, and recent context analytics metadata. It is bounded, read-only, non-persisted, and body-free; it does not read Project Brief, note, mail, handoff, prompt, or historical packet bodies and does not start provider/model work.

Web Overview can route an item to the existing Overview, Configuration, or Context surfaces. Mobile shows attention only when Settings resolves to one exact physical project; broad/all/env-only/multi-checkout views do not aggregate or fan out project attention.

Remote Civilization push/notification delivery (**V15-5b**) is **deferred and not shipped in core v1.5**. Core v1.5 does not change the hosted relay deployment/capability, and accepting passive mail or a structured handoff does not generate a remote Civilization notification.

## Provider support

The selected target's Civilization Overview reports effective provider support. Support is not inferred from the fact that T3 can run a provider at all.

The fork includes validated full Civilization paths for Codex and Claude and a promoted managed/local OpenCode 2 path. Other provider paths may be metadata-only when they cannot provide the lifecycle/context guarantees required for full Civilization behavior.

If a provider is metadata-only, ordinary T3 provider functionality still works; only the Civilization behaviors that require full support are unavailable.

## Scope and lifecycle

A civilization belongs to one T3 environment/project. Worktrees for that project share the same civilization. Projects or environments are not merged merely because paths or Git remotes look related.

Persisted settlement is Civilization's life-cycle boundary for a citizen. Ordinary completion, interruption, or temporary idleness is not the same thing as settlement. A returned/unarchived thread keeps its identity, but old closed correspondence is not silently reopened.

Cross-environment civilization federation is not part of the current release.

## Privacy and administration

Civilization keeps sensitive reads explicit and bounded. Navigation and analytics use metadata identifiers; opening a Settings view does not itself imply a sensitive body fetch.

Retention, export, reset, and purge controls are in **Configuration**. Destructive operations use explicit confirmation and server-side authorization. Exported or retained Civilization data never gains authority simply because it contains instructions or agent-written text.

## Where to start

For an existing project:

1. Open **Settings → Civilization → Overview**.
2. Select the exact environment/project you intend to manage.
3. Review provider support and current participation.
4. Use guided setup/review from **Configuration** if you want presets and a server-owned preview before applying changes.
5. Add a Project Brief only if you want bounded operator-authored direction included in eligible context packets.
6. Enable/configure participation from **Configuration** when you are ready.
7. Use citizen search plus **Citizens**, **Activity**, and **Context** for day-to-day navigation/inspection rather than the administrative controls.

For general T3 Settings inheritance and project overrides, see [Settings and project overrides](./project-settings.md).
