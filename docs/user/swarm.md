# Swarms

A swarm is a small team of T3 agents that work on one brief in parallel. You describe the
outcome; an architect agent designs the roster, picks a provider and model for each
member, writes each member's instructions, and launches them as child threads of the
architect's thread.

## Start a swarm

- Type `/swarm` in the composer, or
- open the command palette and choose **Start a swarm**.

Describe what the swarm should accomplish. The dialog also lets you cap the team size
and choose whether members share this checkout or each gets its own worktree.

**Add swarm brief** puts the composed architect message in the composer. It is ordinary
text, so you can edit the plan instructions before sending. Press Send to start the
architect turn.

## What the architect does

The architect is the agent in the new thread. It:

1. restates the outcome and names the roster;
2. calls `orchestrator_capabilities` so the providers and models it picks come from the
   live catalog;
3. writes a complete, self-contained task for each member (members do not see the
   architect's conversation);
4. launches the roster in one `create_swarm` call; and
5. reports the roster with each member's role, provider, model, and thread link.

If the brief is ambiguous, the architect asks one question before launching rather than
guessing.

## Follow the work

Every member is a real T3 thread. Open one from:

- the roster in the architect's reply;
- the **Agents** list under the thread's related threads, which shows active and previous
  agents with their status; or
- the sidebar, when a member was created as an ordinary top-level thread.

Members run asynchronously. Their completion wakes the architect's thread, so the
architect integrates results as they arrive instead of polling. **Stop** on the architect
thread stops the work it launched.

## Limits

- A swarm has at most 12 members per `create_swarm` call. Prefer three to five.
- Members inherit the architect's runtime and interaction modes, and its checkout unless
  `isolation: "worktree"` gives a member its own prepared checkout. Uncommitted edits are
  not copied into a worktree.
- A member that needs its own sub-team can call `create_swarm` or `delegate_task` itself;
  that nested work appears under the member's thread.

## Swarm v2 (beta)

Swarm v2 adds a queue to the original swarm. Members beyond the concurrency limits wait and start
as slots free up, even after the agent that started them has ended its turn.

Turn on **Settings → Labs → Swarm v2** for the machine that runs the threads. While it is off,
agents get the original `create_swarm` tool described above, and nothing new is admitted.

### Spreading members across accounts

A member's target can list several provider instances of one provider (`anyOf`), for example two
or three accounts with the same model. Each member then starts on the account with the fewest
running members. Accounts that are paused, signed out, or reporting an error are skipped. Once
started, a member stays on its account.

You are responsible for following each provider's terms when you spread work across accounts you
hold with it.

### Checking a member's work

A member can carry a `verify` command, such as `["pnpm", "test"]`. When the member finishes, the
server runs that command in the member's checkout. The command runs directly, with no shell; on
Windows, run `.cmd` scripts through `["cmd", "/c", …]`.

- If the command passes, the member is reported as verified.
- If it fails, the member gets the command, its exit code, and the end of the output, and tries
  again. A member gets 2 retries unless its `verify` sets `maxRetries` (0-3). After the last
  failed check, the member is reported as failed.
- The command stops after `timeoutMs` (10 minutes by default). It also stops if someone sends the
  member a message while the check runs; the check then runs again once that turn ends.
- Members that share one checkout are checked one at a time.
- If the command cannot start at all, for example `["npm", "test"]` on Windows, where npm is
  `npm.cmd`, the member fails at once with no retries. Use `["cmd", "/c", "npm", "test"]` there.

Because the server runs the command itself, outside the provider's sandbox and approval review,
`verify` needs the **Full access** runtime mode for both the agent that starts the swarm and the
member. **Auto** is not enough, because providers still sandbox or review commands in it. A swarm
that asks for `verify` in another mode is refused. If either thread's mode is lowered below Full
access before a check runs, or the member is switched to plan mode, the check is skipped, and the
member is reported as done but unchecked.

The command gets only part of the server's environment: what tools need to start and find their
programs (paths, system and profile folders, toolchain homes such as `CARGO_HOME` or `JAVA_HOME`,
proxies and certificates, locale), plus `CI=1`. Provider tokens and other secrets are left out. To
pass more variables, list their names in the server setting `swarmVerifyEnv`, by project id, or
under `*` for every project. The command still runs as you, with your `HOME`, so it can read files
such as `~/.npmrc` and your git credentials; that is part of what Full access means.

### Managing a running swarm

The agent that started a swarm manages it with these tools. Other threads cannot see or change
it.

- `swarm_status` shows counts by status, queue reason, and account (at most 8 accounts), or a
  page of members with `view: "members"`.
- `swarm_cancel` cancels some members by key, or the whole swarm. Queued members never start.
  Running members are stopped, along with any tasks they started, and their results so far still
  reach the agent. A member whose mode you raised above the agent's own is not stopped this way;
  stop it yourself.
- `swarm_retry` runs failed or cancelled members again, optionally on another model or account.
  The new attempt is told what the previous one reported. Retries count toward the swarm's 48
  members.
- `swarm_collect` reads full results, page by page, with `keys` and `fields` to narrow them.
- `swarm_followup` sends a finished member more work in its own thread, at most 5 times. Its new
  result reaches the agent like the first one did.

When you press Stop on the agent, the swarm is cancelled: queued members never start, and
running members are stopped.

If you cancel the agent's queued wake for a swarm, the swarm is detached. Queued members never
start, running members keep going on their own, and the swarm stops managing them. Their results
are still saved, and the agent can read them with `swarm_collect`.

Results from `swarm_collect` are other agents' output. The agent receives them marked as data,
not instructions.

### When members fail

- If a member stops on a usage limit, the swarm stops starting new members on that account until
  the limit resets (or for 15 minutes when the provider gives no reset time).
  - With **Settings → Usage limits → Resume after usage limits** on, the member waits and continues by itself
    after the reset, and its result arrives as usual.
  - With it off, the member is reported as failed, and the agent can retry it with `swarm_retry`.
- If two members on the same account fail within a minute with a connection or provider error,
  the swarm stops starting members there for 5 minutes. If it happens again soon after that pause,
  it stops for 15 minutes. Members that can run on another account move there.
- A member that fails with a connection or provider error is retried once, automatically, after
  about 30-45 seconds. The server setting `swarmAutoRetryTransient` (on by default) turns this
  off. A provider error marked as not retryable is never retried.
- If the server restarts while a member is running, the member waits for the turn's restart
  continuation and finishes with its result, as if nothing happened. Continuations do not count
  against the member's `maxTurns`, but they do count toward the swarm's `maxTotalTurns`. If no
  continuation follows, the member fails with class `restart` and is retried once, like a
  connection error.

### Limits

- Each member has a turn limit (`maxTurns`, 20 by default) and a time limit (`maxWallClockMs`,
  2 hours by default). The time restarts with each follow-up. A member past either limit is
  stopped and reported as stopped by its budget.
- A whole swarm has a turn budget (`maxTotalTurns`, 240 by default). Every turn of every member
  counts, retries and follow-ups included. Once the budget is used:
  - queued members never start;
  - running members finish their current turn, but get no verify retry, follow-up, or automatic
    retry;
  - members waiting on a usage limit are stopped and do not resume;
  - `swarm_add_members`, `swarm_followup`, and `swarm_retry` are refused.
- A turn here is one run of the member's thread (its first run, each verify retry, each
  follow-up, and any message you send it), not each request the agent makes to its provider.
- A swarm or member can lower these limits but not raise them. The server settings
  `swarmDefaultMaxTurns`, `swarmDefaultMaxWallClockMs`, and `swarmDefaultMaxTotalTurns` set the
  defaults.

### Starting a Swarm v2 swarm

With Swarm v2 on, the `/swarm` dialog gains a **Wake policy**: results wake the agent as each
member finishes (the default), failures at once and the rest at the end, or in batches. The brief it
inserts asks the agent to check first whether the work can run in parallel at all. It sizes waves
at three to five members (at most 12 per call) and launches them with `swarm_create`. The brief
suggests a `verify` command only when the thread is in **Full access**.

A swarm is not always faster. In a live comparison of three small coding tasks with tests, one
agent passed all three in fewer turns and less time than a verified swarm of three, which also
passed all three. The brief says so: use a swarm when the tasks are many, slow, or need their own
checkouts.

### When results arrive

Each member's result wakes the agent as a short digest, following the swarm's wake policy. The
agent reads full results with `swarm_collect`. Other events never start a turn of their own. These
include a paused or failing account, approvals waiting, a used budget, and the outcome of a Stop or
a detach. The agent sees them as notes at the start of its next turn.

### Approvals

When a member asks for permission to run a command or edit a file, the request goes to you, in the
member's thread, not to the agent. The agent only hears that members are waiting. The Swarm panel
marks such members "waiting for your approval".

### The Swarm panel and the sidebar

A thread that started swarms shows them in the thread details panel under **Swarm**:

- **Summary:** counts by status, and turns used against the swarm's budget.
- **Notes:** the latest notes, such as the outcome of a Stop or a detach.
- **Accounts:** for each one, its running members against its limit, any pause and why ("usage
  limit" or "instance down"), and whether it runs one member at a time.
- **Members:** filters by status ("Needs you" shows members waiting for your approval and members
  that could not be stopped) and by account, and a grouping by account. Failed members come first.
  Each row shows the member's status, why it waits, its model, elapsed time, its check result, its
  summary, and flags such as "retried automatically".
- **Actions:** **Open**, **Stop**, **Retry**, and **Stop all**. Stop all asks first and says how
  many members it stops.

The panel updates every few seconds while a swarm is running. In the sidebar, the agent's thread
shows "Swarm · N running · M queued · K failed". Without Swarm v2, neither appears.

### Stop, detach, and other interrupts

- **Stop** on the agent's thread cancels its swarms: queued members never start, and running
  members are stopped. Members show "stopped by your Stop".
- **Cancelling the agent's queued wake** that carries swarm results detaches the swarm. Queued
  members never start, running members keep going on their own, and no further results come to
  the thread. T3 asks before you cancel such a wake.
- **Other interrupts leave the swarm running.** This covers `/goal`, a skipped compaction, and an
  agent interrupting another thread. Only Stop cancels a swarm.

Detach happens only when you cancel a queued swarm wake. Some providers, such as OpenCode,
deliver results into the agent's running turn, so no queued wake appears; use Stop or the
panel's **Stop all** instead.
