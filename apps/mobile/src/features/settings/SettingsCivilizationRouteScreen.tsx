import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { AppText as Text } from "../../components/ui/AppText";
import { useAtomValue } from "@effect/atom-react";
import { AuthOrchestrationReadScope, type ProjectId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { environmentSession, useEnvironmentScope } from "../../state/session";
import {
  useMobileCivilizationAttention,
  useMobileCivilizationOverview,
} from "../../state/civilization";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import {
  AndroidSettingsEnvironmentFilter,
  SettingsEnvironmentFilterHeader,
} from "./components/SettingsEnvironmentFilterHeader";
import { useSettingsEnvironmentFilter } from "./settings-environment-filter";
import {
  mobileCivilizationAttentionMessage,
  mobileCivilizationPermissionMessage,
  resolveMobileCivilizationAttentionTarget,
  resolveMobileCivilizationTargets,
  type MobileCivilizationProjectTarget,
  type MobileCivilizationTarget,
} from "./civilization-overview.logic";

function ReadOnlyRow(props: { readonly label: string; readonly value: string }) {
  return (
    <View className="gap-1 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <Text className="text-sm text-foreground-muted">{props.label}</Text>
      <Text className="text-base text-foreground" selectable>
        {props.value}
      </Text>
    </View>
  );
}

function AttentionItemRow(props: {
  readonly severity: "info" | "warning" | "error";
  readonly title: string;
  readonly detail: string;
}) {
  const severityLabel =
    props.severity === "error" ? "Needs action" : props.severity === "warning" ? "Review" : "Info";
  return (
    <View className="gap-1 border-b border-border-subtle px-4 py-3 last:border-b-0">
      <View className="flex-row items-start justify-between gap-3">
        <Text className="min-w-0 flex-1 text-base text-foreground">{props.title}</Text>
        <Text className="shrink-0 text-xs text-foreground-muted">{severityLabel}</Text>
      </View>
      <Text className="text-sm leading-normal text-foreground-muted">{props.detail}</Text>
    </View>
  );
}

function TargetOverview(props: { readonly target: MobileCivilizationTarget }) {
  const canRead = useEnvironmentScope(props.target.environmentId, AuthOrchestrationReadScope);
  const session = useAtomValue(
    environmentSession.sessionStateValueAtom(props.target.environmentId),
  );
  const sessionResult = useAtomValue(
    environmentSession.sessionStateAtom(props.target.environmentId),
  );
  const overview = useMobileCivilizationOverview(
    canRead ? props.target.environmentId : null,
    canRead ? props.target.projectId : null,
  );
  const permissionMessage = mobileCivilizationPermissionMessage({
    canRead,
    sessionAvailable: session !== null,
    sessionFailed: AsyncResult.isFailure(sessionResult),
  });
  const title =
    props.target.projectId === null
      ? props.target.label
      : `${props.target.label} · selected checkout`;

  if (permissionMessage !== null) {
    return (
      <SettingsSection title={title}>
        <ReadOnlyRow label="Civilization" value={permissionMessage} />
      </SettingsSection>
    );
  }
  if (overview.data === null) {
    return (
      <SettingsSection title={title}>
        <ReadOnlyRow
          label="Civilization"
          value={
            overview.isPending
              ? "Loading…"
              : (overview.error ?? "This environment did not return Civilization data.")
          }
        />
      </SettingsSection>
    );
  }

  const { status, capabilities, effective } = overview.data;
  const config = effective.config;
  const fullProviders = capabilities.providers.filter(
    (provider) => provider.support === "full",
  ).length;
  const limitedProviders = capabilities.providers.length - fullProviders;

  return (
    <SettingsSection title={title}>
      <ReadOnlyRow label="Status" value={status.status} />
      <ReadOnlyRow
        label="Participation"
        value={`${config.participation.enabled ? "Enabled" : "Disabled"} · ${config.participation.adoption}${config.participation.emergencyOff ? " · emergency off" : ""}`}
      />
      <ReadOnlyRow label="Name pool" value={config.names.selectedPoolId} />
      <ReadOnlyRow
        label="Personality"
        value={`${config.personalities.selectedPoolId} · ${config.personalities.rendering}`}
      />
      <ReadOnlyRow
        label="Provider support"
        value={`${fullProviders} full · ${limitedProviders} limited or unsupported`}
      />
      {props.target.projectId === null ? null : (
        <>
          <ReadOnlyRow label="Citizens" value={String(status.citizenCount)} />
          <ReadOnlyRow label="Open citizens" value={String(status.openCitizenCount)} />
        </>
      )}
    </SettingsSection>
  );
}

function NeedsAttention(props: { readonly target: MobileCivilizationProjectTarget }) {
  const canRead = useEnvironmentScope(props.target.environmentId, AuthOrchestrationReadScope);
  const session = useAtomValue(
    environmentSession.sessionStateValueAtom(props.target.environmentId),
  );
  const sessionResult = useAtomValue(
    environmentSession.sessionStateAtom(props.target.environmentId),
  );
  const attention = useMobileCivilizationAttention(
    canRead ? props.target.environmentId : null,
    canRead ? props.target.projectId : null,
  );
  const permissionMessage = mobileCivilizationPermissionMessage({
    canRead,
    sessionAvailable: session !== null,
    sessionFailed: AsyncResult.isFailure(sessionResult),
  });
  const message = mobileCivilizationAttentionMessage({
    permissionMessage,
    isPending: attention.isPending,
    error: attention.error,
    hasData: attention.data !== null,
    itemCount: attention.data?.items.length ?? 0,
  });

  return (
    <SettingsSection title="Needs attention">
      {message !== null ? (
        <ReadOnlyRow label="Attention" value={message} />
      ) : (
        attention.data?.items.map((item) => (
          <AttentionItemRow
            key={item.key}
            severity={item.severity}
            title={item.title}
            detail={item.detail}
          />
        ))
      )}
    </SettingsSection>
  );
}

export function SettingsCivilizationRouteScreen() {
  const insets = useSafeAreaInsets();
  const { selectedTargets, projectGroups, selectedProjectKey } = useSettingsEnvironmentFilter();
  const group = projectGroups.find((entry) => entry.key === selectedProjectKey);
  const selectedEnvironmentIds = new Set(selectedTargets.map((target) => target.environmentId));
  const projectMembers =
    group?.members
      .map((member) => member.project)
      .filter((project) => selectedEnvironmentIds.has(project.environmentId)) ?? [];
  const targets = resolveMobileCivilizationTargets({
    environments: selectedTargets.map((target) => ({
      environmentId: target.environmentId,
      label: target.label,
    })),
    projectSelected: selectedProjectKey !== null,
    projectMembers: projectMembers.map((project) => ({
      environmentId: project.environmentId,
      id: project.id as ProjectId,
    })),
  });
  const attentionTarget = resolveMobileCivilizationAttentionTarget(targets);

  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Civilization" trailing={<AndroidSettingsEnvironmentFilter />}>
        <ScrollView
          contentInsetAdjustmentBehavior="automatic"
          showsVerticalScrollIndicator={false}
          className="flex-1"
          contentContainerClassName="gap-6 px-5 pt-4"
          contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
        >
          <Text className="px-2 text-sm leading-normal text-foreground-muted">
            Read-only Civilization status for the selected environments and project. Configuration
            and historical bodies remain in desktop/web Settings.
          </Text>
          {targets.length === 0 ? (
            <Text className="px-2 text-base text-foreground-muted">
              No connected checkout matches the current Settings filter.
            </Text>
          ) : (
            <>
              {targets.map((target) => (
                <TargetOverview
                  key={`${target.environmentId}:${target.projectId ?? "environment"}`}
                  target={target}
                />
              ))}
              {attentionTarget === null ? null : <NeedsAttention target={attentionTarget} />}
            </>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}
