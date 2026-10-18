# T3 Civilization

T3 Civilization is a maintained fork of [T3 Code](https://github.com/pingdotgg/t3code) that adds a persistent, project-scoped society for coding-agent threads without replacing T3's core orchestration model.

Each participating thread can become a durable **citizen** with a stable identity, lineage, optional personality rendering, bounded shared context, notes, and passive correspondence. Civilization is designed to make long-running multi-agent work easier to understand and coordinate while keeping T3's existing permissions, provider boundaries, project ownership, and lifecycle semantics authoritative.

The fork still includes the normal T3 Code web, desktop, mobile, provider, remote-access, source-control, and agent-control functionality. Civilization is an additional feature layer, not a separate agent runtime.

> [!NOTE]
> This is the **Errantial T3 Civilization fork**, not the upstream `pingdotgg/t3code` distribution. Upstream T3 Code documentation and architecture still apply where this fork has not changed behavior.

## Civilization at a glance

- **Persistent citizens** — eligible T3 threads receive stable identities that survive provider/session changes and ordinary restarts.
- **Managed identity** — optional managed titles use the form `[Name] Topic` while preserving explicit user/agent title ownership.
- **Lineage** — forks and T3-owned child relationships are exposed as bounded, server-authoritative ancestry rather than a second graph system.
- **Personality rendering** — stable per-citizen profiles can be rendered as `off`, `mild`, or `rich`; personality changes presentation, never permissions or task authority.
- **Shared context and notes** — citizens can receive bounded current Civilization context and work with explicit shared notes without automatic transcript ingestion or background model calls.
- **Passive correspondence** — citizens can address durable messages to one another without waking, steering, polling, or automatically replying on behalf of the recipient.
- **Chronicle and inspection** — bounded history, achievements, correspondence, lineage, context analytics, and historical context inspection are available from the Civilization Settings surface.
- **Safe operations** — configuration, retention, import/export, reset, purge, adoption, and participation controls stay inside T3's existing server authority and permission model.
- **Multi-surface UX** — web and desktop expose the full task-oriented Civilization Settings experience; mobile includes a bounded read-only Civilization overview.

Civilization is **off by default**. It is scoped to one T3 environment/project, and a project's worktrees participate in that same civilization. Cross-environment federation is intentionally not part of the current product.

## Current release

The current public Civilization release is **v1.4 — UI overhaul**.

[View the Civilization v1.4 release](https://github.com/Errantial/t3code/releases/tag/civilization-v1.4)

v1.4 reorganizes Civilization around five user tasks in **Settings → Civilization**:

1. **Overview** — status, participation, identity, population, and provider-support summary.
2. **Citizens** — census, citizen details, and lineage.
3. **Activity** — Chronicle, correspondence, and notes.
4. **Context** — analytics and historical context inspection.
5. **Configuration** — identity, personality, context, messaging, provider, retention, and administrative policy.

The task selection is URL-backed, preserves browser history/deep links, integrates with Settings search, and requires an exact project/checkout for rich inspection views. The narrow layout uses the same information architecture without horizontal page overflow.

## Provider support

Civilization support is capability-based and provider-path specific. The UI reports the effective support level for the selected target rather than assuming every provider can safely support identity/context/messaging behavior.

The fork includes full Civilization integration for the validated Codex and Claude paths and for the promoted **managed/local OpenCode 2** path. Other provider paths may remain metadata-only where the provider lifecycle cannot satisfy Civilization's context or passive-messaging guarantees.

This distinction affects Civilization features only; it does not remove the underlying provider from T3 Code.

## Getting the Civilization fork

Civilization currently publishes **source releases**, not fork-specific desktop/CLI installer artifacts.

Clone this repository to run or build the fork:

```bash
git clone https://github.com/Errantial/t3code.git
cd t3code
```

The repository uses [Vite+](https://viteplus.dev/) and Node.js 24. Install dependencies with:

```bash
vp i
```

For a development server and web client:

```bash
vp run dev
```

For contributor and production-build details, see the inherited T3 development documentation in [`docs/`](./docs) and [`CONTRIBUTING.md`](./CONTRIBUTING.md).

> [!WARNING]
> The installers and package-manager commands on `t3.codes`, `npm`, Homebrew, winget, Scoop, AUR, and upstream GitHub Releases install **upstream T3 Code unless they explicitly name this fork**. They should not be used as proof that the Civilization fork is installed.

## Using Civilization

On web or desktop, open **Settings → Civilization**, select the environment/project you want to manage, and start from **Overview**. Civilization uses the same Settings scope model as the rest of T3: environment defaults can be refined by project-specific configuration where supported.

For the user-facing feature guide, see [Civilization](./docs/user/civilization.md).

## Documentation

Civilization-specific documentation:

- [Civilization user guide](./docs/user/civilization.md)
- [Civilization v1.4 release](https://github.com/Errantial/t3code/releases/tag/civilization-v1.4)

The rest of [`docs/user`](./docs/user) and [`docs/internals`](./docs/internals) document the underlying T3 Code product and architecture that this fork retains. In particular:

- [Install and first run](./docs/user/install.md) — upstream T3 installation behavior; see the fork warning above.
- [Permission modes](./docs/user/permission-modes.md)
- [Project settings and overrides](./docs/user/project-settings.md)
- [Remote access](./docs/user/remote-access.md)
- [Source control integrations](./docs/user/source-control.md)
- [Architecture overview](./docs/internals/overview.md)

## Relationship to upstream T3 Code

Civilization deliberately builds inside T3 Code instead of creating a companion daemon, second database, or competing orchestration system. The fork continues to inherit upstream T3 features and architecture while maintaining Civilization-specific server, contract, client-runtime, web/desktop, and mobile integration.

For upstream T3 Code itself, use [pingdotgg/t3code](https://github.com/pingdotgg/t3code). General T3 questions, upstream installers, and upstream feature proposals belong there. Civilization-specific behavior and fork changes belong in this repository.

## Contributing

Read [`CONTRIBUTING.md`](./CONTRIBUTING.md) before opening a change. The contribution guide is largely inherited from upstream T3 and its scope/verification rules remain useful here; the fork note at the top explains where Civilization-specific reports and upstream T3 reports belong.

Public Issues and Discussions are currently disabled on this fork; Civilization-specific code changes can still be proposed as pull requests.

Please keep Civilization changes narrow, evidence-based, and compatible with T3's existing security and lifecycle boundaries.

## License

This fork retains T3 Code's MIT license. See [`LICENSE`](./LICENSE) and the repository's third-party license notices.
