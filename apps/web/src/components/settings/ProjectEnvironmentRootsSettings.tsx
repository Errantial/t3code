import { type EnvironmentId, type ProjectId, type PeerLinkSummary } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { peerLinkEnvironment } from "~/state/peerLinks";
import { projectEnvironment } from "~/state/projects";
import { useEnvironmentQuery } from "~/state/query";
import { useOrchestrationCommand } from "~/state/use-orchestration-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { SettingsRow, SettingsSection } from "./settingsLayout";

function RootRow({
  link,
  value,
  disabled,
  onSave,
}: {
  readonly link: PeerLinkSummary;
  readonly value: string;
  readonly disabled: boolean;
  readonly onSave: (value: string) => Promise<void>;
}) {
  const [draft, setDraft] = useState(value);
  const dirty = draft !== value;
  return (
    <SettingsRow
      title={link.label}
      description={
        link.status === "reachable"
          ? "Path to this project's checkout on that machine."
          : "The link is not reachable now; the path is stored but unverified."
      }
      control={
        <div className="flex items-center gap-2">
          <Input
            className="w-64"
            value={draft}
            disabled={disabled}
            placeholder="D:\\work\\project or /srv/project"
            onChange={(event) => setDraft(event.currentTarget.value)}
            aria-label={`Workspace root on ${link.label}`}
          />
          <Button
            size="sm"
            variant="outline"
            disabled={disabled || !dirty}
            onClick={() => void onSave(draft.trim())}
          >
            Save
          </Button>
        </div>
      }
    />
  );
}

/** Project settings: the project's checkout path on each linked environment. */
export function ProjectEnvironmentRootsSettings({
  environmentId,
  projectId,
  roots,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly roots: Readonly<Record<string, string>> | undefined;
}) {
  const links = useEnvironmentQuery(peerLinkEnvironment.list({ environmentId, input: {} }));
  const updateProject = useOrchestrationCommand(projectEnvironment.update, {
    reportFailure: false,
  });
  const [saving, setSaving] = useState<string | null>(null);
  if (!links.data || links.data.links.length === 0) return null;

  const save = async (targetId: EnvironmentId, value: string) => {
    setSaving(targetId);
    const next = { ...roots };
    if (value === "") delete next[targetId];
    else next[targetId] = value;
    const result = await updateProject({
      environmentId,
      input: { projectId, environmentRoots: next },
    });
    setSaving(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Could not save the environment root",
          description: String(squashAtomCommandFailure(result)),
        }),
      );
    }
  };

  return (
    <SettingsSection id="environment-roots" title="Environment roots">
      {links.data.links.map((link) => (
        <RootRow
          key={`${link.environmentId}:${roots?.[link.environmentId] ?? ""}`}
          link={link}
          value={roots?.[link.environmentId] ?? ""}
          disabled={saving !== null}
          onSave={(value) => save(link.environmentId, value)}
        />
      ))}
    </SettingsSection>
  );
}
