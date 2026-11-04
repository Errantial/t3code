import { expect, it } from "@effect/vitest";
import { OrchestratorMcpFailure, ProjectId, type Project } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { resolveRepositoryProject } from "../mcp/toolkits/project/handlers.ts";
import * as ProjectService from "./ProjectService.ts";

const project = (id: string, key: string | null, deleted = false): Project =>
  ({
    id,
    title: id,
    workspaceRoot: `/work/${id}`,
    repositoryIdentity:
      key === null
        ? null
        : {
            canonicalKey: key,
            locator: {
              source: "git-remote",
              remoteName: "origin",
              remoteUrl: `https://${key}`,
            },
          },
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    deletedAt: deleted ? "2026-01-02T00:00:00.000Z" : null,
  }) as unknown as Project;

const layer = (projects: ReadonlyArray<Project>) =>
  Layer.mock(ProjectService.ProjectService)({
    listPage: () => Effect.succeed({ projects, nextCursor: null }),
  });

it.effect("resolves one matching peer project", () =>
  Effect.gen(function* () {
    const id = yield* resolveRepositoryProject("peer", "github.com/acme/app");
    expect(id).toBe(ProjectId.make("one"));
  }).pipe(Effect.provide(layer([project("one", "github.com/acme/app")]))),
);

it.effect("reports a missing peer project with the environment and key", () =>
  Effect.gen(function* () {
    const error = yield* resolveRepositoryProject("peer", "github.com/acme/app").pipe(Effect.flip);
    expect(error).toBeInstanceOf(OrchestratorMcpFailure);
    expect(error.code).toBe("project_not_found_in_environment");
    expect(error.message).toContain("peer");
    expect(error.message).toContain("github.com/acme/app");
  }).pipe(Effect.provide(layer([project("other", "github.com/acme/other")]))),
);

it.effect("reports every candidate when the peer has several matches", () =>
  Effect.gen(function* () {
    const error = yield* resolveRepositoryProject("peer", "github.com/acme/app").pipe(Effect.flip);
    expect(error.code).toBe("project_ambiguous_in_environment");
    expect(error.message).toContain("one");
    expect(error.message).toContain("two");
  }).pipe(
    Effect.provide(
      layer([project("one", "github.com/acme/app"), project("two", "github.com/acme/app")]),
    ),
  ),
);

it.effect("ignores deleted projects", () =>
  Effect.gen(function* () {
    const error = yield* resolveRepositoryProject("peer", "github.com/acme/app").pipe(Effect.flip);
    expect(error.code).toBe("project_not_found_in_environment");
  }).pipe(Effect.provide(layer([project("gone", "github.com/acme/app", true)]))),
);
