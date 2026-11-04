import { expect, it } from "@effect/vitest";
import type { Project } from "@t3tools/contracts";

import { matchRepositoryKey } from "./RemoteProjectResolver.ts";

const project = (id: string, key: string | null, deleted = false): Project =>
  ({
    id,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity:
      key === null ? null : { canonicalKey: key, remoteUrl: `https://${key}`, root: `/work/${id}` },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: deleted ? "2026-01-02T00:00:00.000Z" : null,
  }) as unknown as Project;

it("matches exactly one live project by canonical repository key", () => {
  expect(
    matchRepositoryKey([project("one", "github.com/acme/app")], "github.com/acme/app"),
  ).toMatchObject({
    kind: "one",
    project: { id: "one" },
  });
});

it("reports none when no live project matches", () => {
  expect(
    matchRepositoryKey(
      [project("other", "github.com/acme/other"), project("deleted", "github.com/acme/app", true)],
      "github.com/acme/app",
    ),
  ).toEqual({ kind: "none" });
});

it("reports every candidate when several projects match", () => {
  const match = matchRepositoryKey(
    [project("one", "github.com/acme/app"), project("two", "github.com/acme/app")],
    "github.com/acme/app",
  );
  expect(match.kind).toBe("many");
  if (match.kind === "many")
    expect(match.candidates.map((candidate) => candidate.id)).toEqual(["one", "two"]);
});
