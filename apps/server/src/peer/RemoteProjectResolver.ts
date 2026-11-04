import type { Project } from "@t3tools/contracts";

/**
 * Matches a caller's canonical repository key against a target's own projects.
 * The target never trusts a project id from another environment; callers and
 * the peer share this rule so a launch and a delegated task agree.
 */
export type RepositoryMatch =
  | { readonly kind: "one"; readonly project: Project }
  | { readonly kind: "none" }
  | { readonly kind: "many"; readonly candidates: ReadonlyArray<Project> };

export const matchRepositoryKey = (
  projects: ReadonlyArray<Project>,
  repositoryKey: string,
): RepositoryMatch => {
  const matches = projects.filter(
    (project) =>
      project.deletedAt === null && project.repositoryIdentity?.canonicalKey === repositoryKey,
  );
  if (matches.length === 1) return { kind: "one", project: matches[0]! };
  if (matches.length === 0) return { kind: "none" };
  return { kind: "many", candidates: matches };
};
