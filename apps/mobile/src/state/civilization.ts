import { fetchEnvironmentCivilizationOverview } from "@t3tools/client-runtime/state/civilization";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { Atom } from "effect/reactivity";

import { connectionAtomRuntime } from "../connection/runtime";
import { environmentSession } from "./session";
import { useEnvironmentQuery } from "./query";

function civilizationOverviewKey(
  environmentId: EnvironmentId,
  projectId: ProjectId | null,
): string {
  return JSON.stringify([environmentId, projectId]);
}

const civilizationOverviewAtom = Atom.family((serializedKey: string) => {
  const [environmentId, rawProjectId] = JSON.parse(serializedKey) as [string, string | null];
  return connectionAtomRuntime
    .atom((get) => {
      const prepared = Option.getOrNull(
        get(environmentSession.preparedConnectionValueAtom(environmentId as EnvironmentId)),
      );
      if (prepared === null) return Effect.never;
      return fetchEnvironmentCivilizationOverview({
        prepared,
        ...(rawProjectId === null ? {} : { projectId: rawProjectId as ProjectId }),
      });
    })
    .pipe(
      Atom.setIdleTTL(60_000),
      Atom.withLabel(
        `mobile-civilization-overview:${environmentId}:${rawProjectId ?? "environment"}`,
      ),
    );
});

export function useMobileCivilizationOverview(
  environmentId: EnvironmentId | null,
  projectId: ProjectId | null,
) {
  return useEnvironmentQuery(
    environmentId === null
      ? null
      : civilizationOverviewAtom(civilizationOverviewKey(environmentId, projectId)),
  );
}
