# Civilization

Civilization is an optional project-scoped layer that gives participating T3 threads durable identities and bounded ways to share project context without turning them into a background swarm.

It is off by default. When enabled for a project, eligible threads can become **citizens**. Their Civilization identity, lineage, notes, correspondence, and retained history are stored by the same T3 server that owns the project.

## Open Civilization

On web or desktop, open **Settings → Civilization**. Use the normal Settings scope control to select the environment and project you want to inspect or configure.

The page is organized into five tasks:

- **Overview** shows participation, effective status, population counts, and provider support. It is the only Civilization view designed to summarize more than one selected target.
- **Citizens** contains the census, citizen details, and lineage. Select one exact project/checkout before using the rich citizen views.
- **Activity** contains the Chronicle, correspondence history, and notes.
- **Context** contains context analytics and the historical Inspector. Drill-downs carry exact metadata filters into the Inspector instead of broadening the query.
- **Configuration** contains participation, identity, personality, context, messaging, provider, retention, import/export, reset, and purge controls.

On mobile, **Settings → Civilization** provides a bounded read-only overview for the selected environment/project. Administrative and sensitive-body operations remain on web/desktop.

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

## Passive correspondence

Citizens can send durable addressed correspondence to eligible citizens in the same civilization. Delivery is intentionally passive:

- sending mail does not wake the recipient;
- Civilization does not steer or poll the recipient;
- there are no automatic replies or broadcasts;
- a recipient sees eligible mail during an ordinary supported turn or an explicit inbox read;
- settlement, archive, deletion, policy changes, and permission ceilings can make pending content unavailable.

This makes correspondence a durable coordination mechanism without silently turning a stored message into agent execution.

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
4. Enable/configure participation from **Configuration** when you are ready.
5. Use **Citizens**, **Activity**, and **Context** for day-to-day inspection rather than the administrative controls.

For general T3 Settings inheritance and project overrides, see [Settings and project overrides](./project-settings.md).
