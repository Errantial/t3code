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
