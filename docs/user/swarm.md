# Swarms

A swarm is a group of agents an agent starts in one call. Members beyond the concurrency limits
wait in a queue and start as slots free up, even after the agent that started them has ended its
turn.

Swarm v2 is a beta. Turn on **Settings → Labs → Swarm v2** for the machine that runs the threads.
While it is off, agents get the original swarm tool, and nothing new is admitted.

## Spreading members across accounts

A member's target can list several provider instances of one provider (`anyOf`), for example two
or three accounts with the same model. Each member then starts on the account with the fewest
running members. Accounts that are paused, signed out, or reporting an error are skipped. Once
started, a member stays on its account.

You are responsible for following each provider's terms when you spread work across accounts you
hold with it.
