import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationCitizenDetail,
  type CivilizationCitizenReassignmentPreview,
  type CivilizationCitizenReassignmentRequest,
  type CivilizationEffectiveConfig,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { civilizationCitizenAction } from "../../state/civilization";
import { readEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";

const CUSTOM_NAME = "__custom_name__";

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : null;
    const message = "message" in error && typeof error.message === "string" ? error.message : null;
    if (reason !== null && message !== null) return `${reason}: ${message}`;
    if (message !== null) return message;
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The citizen operation could not be completed.";
};

function DetailValue({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-2xs font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="wrap-anywhere text-sm">{children}</div>
    </div>
  );
}

interface CivilizationCitizenDetailDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly detail: CivilizationCitizenDetail | null;
  readonly loading: boolean;
  readonly error: string | null;
  readonly environmentId: EnvironmentId;
  readonly effective: CivilizationEffectiveConfig;
  readonly canAdminister: boolean;
  readonly refresh: () => void;
  readonly onViewLineage?: ((threadId: ThreadId) => void) | undefined;
  readonly onViewChronicle?: ((threadId: ThreadId) => void) | undefined;
  readonly onViewContext?: ((threadId: ThreadId) => void) | undefined;
  readonly onViewMessages?: ((threadId: ThreadId) => void) | undefined;
}

export function CivilizationCitizenDetailDialog({
  open,
  onOpenChange,
  detail,
  loading,
  error,
  environmentId,
  effective,
  canAdminister,
  refresh,
  onViewLineage,
  onViewChronicle,
  onViewContext,
  onViewMessages,
}: CivilizationCitizenDetailDialogProps) {
  const runCitizenAction = useAtomSet(civilizationCitizenAction, { mode: "promise" });
  const selectedNamePool = effective.config.names.pools.find(
    (pool) => pool.id === effective.config.names.selectedPoolId,
  );
  const selectedProfilePool = effective.config.personalities.pools.find(
    (pool) => pool.id === effective.config.personalities.selectedPoolId,
  );
  const configuredName = selectedNamePool?.entries.find(
    (entry) => entry.id === detail?.identity.nameEntryId,
  );
  const [nameChoice, setNameChoice] = useState(
    configuredName === undefined ? CUSTOM_NAME : configuredName.id,
  );
  const [customName, setCustomName] = useState(detail?.identity.displayName ?? "");
  const [profileEntryId, setProfileEntryId] = useState(detail?.personality.profileEntryId ?? "");
  const [preview, setPreview] = useState<CivilizationCitizenReassignmentPreview | null>(null);
  const [previewRequest, setPreviewRequest] =
    useState<CivilizationCitizenReassignmentRequest | null>(null);
  const [working, setWorking] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [messageRole, setMessageRole] = useState<"status" | "alert">("status");

  const chosenNameEntry =
    nameChoice === CUSTOM_NAME
      ? undefined
      : selectedNamePool?.entries.find((entry) => entry.id === nameChoice);
  const proposedName =
    nameChoice === CUSTOM_NAME
      ? customName.trim()
      : (chosenNameEntry?.displayName ?? customName.trim());
  const proposedProfile = selectedProfilePool?.entries.find((entry) => entry.id === profileEntryId);
  const rendering = effective.config.personalities.rendering;
  const activePresentationLabel =
    detail === null
      ? null
      : rendering === "off"
        ? null
        : rendering === "mild"
          ? detail.personality.base.label
          : detail.personality.rich.label;
  const proposedPresentation =
    proposedProfile === undefined
      ? null
      : rendering === "off"
        ? null
        : rendering === "mild"
          ? proposedProfile.label
          : proposedProfile.rich.label;

  const request = (): CivilizationCitizenReassignmentRequest | null => {
    if (detail === null) return null;
    const nameChanged = proposedName !== detail.identity.displayName;
    const profileChanged = profileEntryId !== detail.personality.profileEntryId;
    if (!nameChanged && !profileChanged) return null;
    return {
      threadId: detail.threadId,
      projectId: detail.projectId,
      expectedCitizenRevision: detail.revision,
      expectedEnvironmentRevision: effective.environmentRevision,
      expectedProjectRevision: effective.projectRevision,
      ...(nameChanged
        ? nameChoice === CUSTOM_NAME
          ? { displayName: proposedName }
          : { nameEntryId: nameChoice }
        : {}),
      ...(profileChanged ? { profileEntryId } : {}),
    };
  };

  const clearPreview = () => {
    setPreview(null);
    setPreviewRequest(null);
    setMessage(null);
  };

  const previewChanges = () => {
    const nextRequest = request();
    if (working || nextRequest === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessageRole("alert");
      setMessage("Permission changed before preview; settings:write is required.");
      return;
    }
    setWorking(true);
    setMessage(null);
    setMessageRole("status");
    void runCitizenAction({ environmentId, type: "reassignmentPreview", request: nextRequest })
      .then((result) => {
        setWorking(false);
        setPreview(result as CivilizationCitizenReassignmentPreview);
        setPreviewRequest(nextRequest);
      })
      .catch((cause: unknown) => {
        setWorking(false);
        setPreview(null);
        setPreviewRequest(null);
        setMessageRole("alert");
        setMessage(errorMessage(cause));
      });
  };

  const applyChanges = () => {
    if (working || previewRequest === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessageRole("alert");
      setMessage("Permission changed before apply; settings:write is required.");
      return;
    }
    setWorking(true);
    setMessage(null);
    setMessageRole("status");
    void runCitizenAction({ environmentId, type: "reassignmentApply", request: previewRequest })
      .then(() => {
        setWorking(false);
        setPreview(null);
        setPreviewRequest(null);
        setMessageRole("status");
        setMessage("Citizen updated.");
        refresh();
      })
      .catch((cause: unknown) => {
        setWorking(false);
        setPreview(null);
        setPreviewRequest(null);
        setMessageRole("alert");
        setMessage(errorMessage(cause));
        refresh();
      });
  };

  const titleAction = (type: "titleRestore" | "titleReclaim") => {
    if (working || detail === null) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setMessageRole("alert");
      setMessage("Permission changed before title action; settings:write is required.");
      return;
    }
    setWorking(true);
    setMessage(null);
    setMessageRole("status");
    void runCitizenAction({
      environmentId,
      type,
      request: {
        threadId: detail.threadId,
        projectId: detail.projectId,
        expectedCitizenRevision: detail.revision,
      },
    })
      .then(() => {
        setWorking(false);
        setMessageRole("status");
        setMessage(type === "titleReclaim" ? "Managed title reclaimed." : "Manual title restored.");
        refresh();
      })
      .catch((cause: unknown) => {
        setWorking(false);
        setMessageRole("alert");
        setMessage(errorMessage(cause));
        refresh();
      });
  };

  const navigate = (callback: ((threadId: ThreadId) => void) | undefined) => {
    if (detail === null || callback === undefined) return;
    onOpenChange(false);
    callback(detail.threadId);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{detail?.identity.displayName ?? "Citizen details"}</DialogTitle>
          <DialogDescription>
            Citizen identity and personality are persisted snapshots. Global personality rendering
            is configured separately and does not reroll this citizen.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {loading && detail === null ? (
            <div role="status" className="text-sm text-muted-foreground">
              Loading citizen details…
            </div>
          ) : error !== null ? (
            <div role="alert" className="text-sm text-destructive">
              {error}
            </div>
          ) : detail === null ? null : (
            <div className="space-y-5">
              <section className="space-y-3 rounded-lg border border-border/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="text-lg font-semibold">{detail.identity.displayName}</div>
                    <div className="text-sm text-muted-foreground">{detail.host.threadTitle}</div>
                  </div>
                  <div className="text-xs text-muted-foreground">
                    {detail.lifecycle.state} · generation {detail.lineage.generation} ·{" "}
                    {detail.title.managed ? "managed title" : "manual title"}
                  </div>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DetailValue label="Personality presentation">
                    {activePresentationLabel ?? "Hidden (rendering off)"}
                  </DetailValue>
                  <DetailValue label="Underlying profile">
                    {detail.personality.base.label}
                  </DetailValue>
                  <DetailValue label="Traits">
                    {detail.personality.base.traits.join(", ") || "—"}
                  </DetailValue>
                  <DetailValue label="Rich traits">
                    {detail.personality.rich.traits.join(", ") || "—"}
                  </DetailValue>
                  <DetailValue label="Parent">
                    {detail.lineage.parentThreadId === null
                      ? "None"
                      : `${detail.lineage.relationshipToParent ?? "child"} parent`}
                  </DetailValue>
                  <DetailValue label="Status">
                    {detail.observedOnly ? "Provider-owned · read only" : "T3-managed"}
                  </DetailValue>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <DetailValue label="Mild style">{detail.personality.base.styleText}</DetailValue>
                  <DetailValue label="Rich axiom">{detail.personality.rich.axiom}</DetailValue>
                  <DetailValue label="Rich voice">{detail.personality.rich.voice}</DetailValue>
                  <DetailValue label="Rich style">{detail.personality.rich.styleText}</DetailValue>
                </div>
                <details className="rounded-md border border-border/70 p-3">
                  <summary className="cursor-pointer text-sm font-medium">
                    Technical details
                  </summary>
                  <div className="mt-3 grid gap-3 sm:grid-cols-2">
                    <DetailValue label="Provider instance ID">
                      {detail.host.providerInstanceId}
                    </DetailValue>
                    <DetailValue label="Thread ID">{detail.threadId}</DetailValue>
                    <DetailValue label="Project ID">{detail.projectId}</DetailValue>
                    <DetailValue label="Citizen revision">{detail.revision}</DetailValue>
                    <DetailValue label="Lifecycle epoch">{detail.lifecycle.epoch}</DetailValue>
                    <DetailValue label="Lineage status">{detail.lineage.status}</DetailValue>
                    <DetailValue label="Name pool ID">{detail.identity.namePoolId}</DetailValue>
                    <DetailValue label="Name entry ID">{detail.identity.nameEntryId}</DetailValue>
                    <DetailValue label="Profile pool ID">
                      {detail.personality.profilePoolId}
                    </DetailValue>
                    <DetailValue label="Profile entry ID">
                      {detail.personality.profileEntryId}
                    </DetailValue>
                    {detail.lineage.parentThreadId === null ? null : (
                      <DetailValue label="Parent thread ID">
                        {detail.lineage.parentThreadId}
                      </DetailValue>
                    )}
                  </div>
                </details>
                <div className="flex flex-wrap gap-2">
                  {onViewLineage === undefined ? null : (
                    <Button size="xs" variant="outline" onClick={() => navigate(onViewLineage)}>
                      Lineage
                    </Button>
                  )}
                  {onViewChronicle === undefined ? null : (
                    <Button size="xs" variant="outline" onClick={() => navigate(onViewChronicle)}>
                      Chronicle
                    </Button>
                  )}
                  {onViewContext === undefined ? null : (
                    <Button size="xs" variant="outline" onClick={() => navigate(onViewContext)}>
                      Context
                    </Button>
                  )}
                  {onViewMessages === undefined ? null : (
                    <Button size="xs" variant="outline" onClick={() => navigate(onViewMessages)}>
                      Messages
                    </Button>
                  )}
                </div>
              </section>

              {!canAdminister || detail.observedOnly ? null : (
                <section className="space-y-4 rounded-lg border border-border/70 p-3">
                  <div>
                    <div className="font-medium text-sm">Edit citizen</div>
                    <div className="text-xs text-muted-foreground">
                      Rendering is <strong>{rendering}</strong> for this project. Editing the
                      personality below changes this citizen's assigned profile; it does not change
                      the global off/mild/rich rendering mode.
                    </div>
                  </div>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <label className="space-y-1 text-sm">
                      <span>Name source</span>
                      <Select
                        items={[
                          ...(selectedNamePool?.entries.map((entry) => ({
                            value: entry.id,
                            label: entry.displayName,
                          })) ?? []),
                          { value: CUSTOM_NAME, label: "Custom name…" },
                        ]}
                        value={nameChoice}
                        onValueChange={(value) => {
                          if (value === null) return;
                          setNameChoice(value);
                          clearPreview();
                        }}
                      >
                        <SelectTrigger aria-label="Citizen name source">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedNamePool?.entries.map((entry) => (
                            <SelectItem key={entry.id} value={entry.id}>
                              {entry.displayName}
                            </SelectItem>
                          ))}
                          <SelectItem value={CUSTOM_NAME}>Custom name…</SelectItem>
                        </SelectContent>
                      </Select>
                    </label>
                    <label className="space-y-1 text-sm">
                      <span>Display name</span>
                      <Input
                        aria-label="Citizen display name"
                        value={proposedName}
                        disabled={nameChoice !== CUSTOM_NAME}
                        onChange={(event) => {
                          setCustomName(event.currentTarget.value);
                          clearPreview();
                        }}
                      />
                    </label>
                    <label className="space-y-1 text-sm sm:col-span-2">
                      <span>Personality</span>
                      <Select
                        items={selectedProfilePool?.entries.map((entry) => ({
                          value: entry.id,
                          label: rendering === "rich" ? entry.rich.label : entry.label,
                        }))}
                        value={profileEntryId}
                        onValueChange={(value) => {
                          if (value === null) return;
                          setProfileEntryId(value);
                          clearPreview();
                        }}
                      >
                        <SelectTrigger aria-label="Citizen personality">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          {selectedProfilePool?.entries.map((entry) => (
                            <SelectItem key={entry.id} value={entry.id}>
                              {rendering === "rich" ? entry.rich.label : entry.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </label>
                  </div>
                  {proposedProfile === undefined ? null : (
                    <div className="rounded-md bg-muted/30 p-3 text-xs">
                      <div className="font-medium text-sm">
                        {proposedPresentation ?? `${proposedProfile.label} (rendering off)`}
                      </div>
                      <div className="text-muted-foreground">
                        Underlying profile: {proposedProfile.label} · {proposedProfile.id}
                      </div>
                      <div className="mt-1">
                        {(rendering === "rich"
                          ? proposedProfile.rich.traits
                          : proposedProfile.traits
                        ).join(", ")}
                      </div>
                      {rendering === "rich" ? (
                        <>
                          <div className="mt-2">{proposedProfile.rich.axiom}</div>
                          <div className="text-muted-foreground">{proposedProfile.rich.voice}</div>
                          <div className="mt-1 text-muted-foreground">
                            {proposedProfile.rich.styleText}
                          </div>
                        </>
                      ) : (
                        <div className="mt-1 text-muted-foreground">
                          {proposedProfile.styleText}
                        </div>
                      )}
                    </div>
                  )}
                  <div className="rounded-md border border-border/70 p-3 text-sm">
                    <div className="font-medium">Thread naming</div>
                    <div className="text-xs text-muted-foreground">
                      {detail.title.managed
                        ? "Civilization currently owns this title."
                        : "The title is user-owned."}
                    </div>
                    <div className="mt-2 grid gap-1 text-xs">
                      <div className="wrap-anywhere">
                        <span className="text-muted-foreground">Current topic: </span>
                        {detail.title.topic}
                      </div>
                      <div className="wrap-anywhere">
                        <span className="text-muted-foreground">Preserved manual/original: </span>
                        {detail.title.preservedTitle ?? "—"}
                      </div>
                      <div className="wrap-anywhere">
                        <span className="text-muted-foreground">Last managed title: </span>
                        {detail.title.lastManagedTitle ?? "—"}
                      </div>
                    </div>
                    <div className="mt-2 wrap-anywhere text-xs">
                      <span className="text-muted-foreground">
                        Current server managed preview:{" "}
                      </span>
                      {detail.title.managedTitlePreview}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {!detail.title.managed ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={working}
                          onClick={() => titleAction("titleReclaim")}
                        >
                          Reclaim managed title
                        </Button>
                      ) : null}
                      {detail.title.preservedTitle !== null &&
                      detail.title.lastManagedTitle !== null &&
                      detail.host.threadTitle === detail.title.lastManagedTitle ? (
                        <Button
                          size="xs"
                          variant="outline"
                          disabled={working}
                          onClick={() => titleAction("titleRestore")}
                        >
                          Restore manual/original title
                        </Button>
                      ) : null}
                    </div>
                  </div>
                  {preview === null ? null : (
                    <div role="status" className="rounded-md border border-border/70 p-3 text-sm">
                      <div>
                        {preview.current.name} / {preview.current.profileLabel}
                      </div>
                      <div className="text-muted-foreground">→</div>
                      <div>
                        {preview.proposed.name} / {preview.proposed.profileLabel}
                      </div>
                    </div>
                  )}
                  {message === null ? null : (
                    <div role={messageRole} className="text-xs text-muted-foreground">
                      {message}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={working || request() === null}
                      onClick={previewChanges}
                    >
                      {working ? "Working…" : "Preview changes"}
                    </Button>
                    <Button
                      size="sm"
                      disabled={working || previewRequest === null}
                      onClick={applyChanges}
                    >
                      Apply preview
                    </Button>
                  </div>
                </section>
              )}
            </div>
          )}
        </DialogPanel>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
