import type { EnvironmentId } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";

import { environmentPresentations } from "~/state/presentation";

/** Whether an environment's Swarm v2 Labs setting is on; off, nothing of Swarm v2 shows. */
export const swarmV2EnabledAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make(
    (get) =>
      get(environmentPresentations.serverConfigsAtom).get(environmentId)?.settings
        .swarmV2Enabled === true,
  ).pipe(Atom.withLabel(`swarm-v2:enabled:${environmentId}`)),
);

/** Whether any environment has Swarm v2 on: the thread details menu offers "Swarm" only then. */
export const anySwarmV2EnabledAtom = Atom.make((get) =>
  [...get(environmentPresentations.serverConfigsAtom).values()].some(
    (config) => config.settings.swarmV2Enabled === true,
  ),
).pipe(Atom.withLabel("swarm-v2:enabled:any"));
