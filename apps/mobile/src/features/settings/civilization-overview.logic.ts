import type { EnvironmentId, ProjectId } from "@t3tools/contracts";

export interface MobileCivilizationEnvironmentTarget {
  readonly environmentId: EnvironmentId;
  readonly label: string;
}

export interface MobileCivilizationProjectMember {
  readonly environmentId: EnvironmentId;
  readonly id: ProjectId;
}

export interface MobileCivilizationTarget extends MobileCivilizationEnvironmentTarget {
  readonly projectId: ProjectId | null;
}

export interface MobileCivilizationProjectTarget extends MobileCivilizationEnvironmentTarget {
  readonly projectId: ProjectId;
}

export interface MobileCivilizationAttentionViewState {
  readonly permissionMessage: string | null;
  readonly isPending: boolean;
  readonly error: string | null;
  readonly hasData: boolean;
  readonly itemCount: number;
}

export function mobileCivilizationPermissionMessage(input: {
  readonly canRead: boolean;
  readonly sessionAvailable: boolean;
  readonly sessionFailed: boolean;
}): string | null {
  if (input.canRead) return null;
  if (input.sessionFailed) return "Could not verify your permissions. Reconnect to try again.";
  if (!input.sessionAvailable) return "Checking permissions…";
  return "Unavailable · orchestration:read required";
}

export function resolveMobileCivilizationTargets(input: {
  readonly environments: readonly MobileCivilizationEnvironmentTarget[];
  readonly projectSelected: boolean;
  readonly projectMembers: readonly MobileCivilizationProjectMember[];
}): readonly MobileCivilizationTarget[] {
  if (!input.projectSelected) {
    return input.environments.map((environment) => ({ ...environment, projectId: null }));
  }
  const environments = new Map(
    input.environments.map((environment) => [environment.environmentId, environment]),
  );
  return input.projectMembers.flatMap((member) => {
    const environment = environments.get(member.environmentId);
    return environment === undefined
      ? []
      : [{ ...environment, projectId: member.id } satisfies MobileCivilizationTarget];
  });
}

export function resolveMobileCivilizationAttentionTarget(
  targets: readonly MobileCivilizationTarget[],
): MobileCivilizationProjectTarget | null {
  if (targets.length !== 1) return null;
  const target = targets[0];
  if (target === undefined || target.projectId === null) return null;
  return { ...target, projectId: target.projectId };
}

export function mobileCivilizationAttentionMessage(
  input: MobileCivilizationAttentionViewState,
): string | null {
  if (input.permissionMessage !== null) return input.permissionMessage;
  if (input.isPending) return "Checking attention…";
  if (input.error !== null) return `Unavailable · ${input.error}`;
  if (!input.hasData) return "Unavailable · This environment did not return attention data.";
  if (input.itemCount === 0) return "Nothing needs attention.";
  return null;
}
