import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  CIVILIZATION_MAX_PROJECT_BRIEF_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS,
  CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES,
  CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES,
  CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES,
  type CivilizationProjectBriefContentV1,
  type CivilizationProjectBriefDetail,
  type EnvironmentId,
  type ProjectId,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  civilizationProjectBriefAction,
  useCivilizationProjectBriefMetadata,
} from "../../state/civilization";
import { readEnvironmentScope } from "../../state/session";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
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
import { Textarea } from "../ui/textarea";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface ProjectBriefDraft {
  readonly summary: string;
  readonly objectives: ReadonlyArray<string>;
  readonly constraints: ReadonlyArray<string>;
  readonly references: ReadonlyArray<{ readonly kind: string; readonly reference: string }>;
}

const EMPTY_DRAFT: ProjectBriefDraft = {
  summary: "",
  objectives: [],
  constraints: [],
  references: [],
};

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

const unsafeText = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });

const draftFromDetail = (detail: CivilizationProjectBriefDetail): ProjectBriefDraft =>
  detail.content === null
    ? EMPTY_DRAFT
    : {
        summary: detail.content.summary,
        objectives: [...detail.content.objectives],
        constraints: [...detail.content.constraints],
        references: detail.content.references.map((reference) => ({ ...reference })),
      };

const contentFromDraft = (draft: ProjectBriefDraft): CivilizationProjectBriefContentV1 => ({
  version: 1,
  summary: draft.summary,
  objectives: [...draft.objectives],
  constraints: [...draft.constraints],
  references: draft.references.map((reference) => ({ ...reference })),
});

const validationMessage = (draft: ProjectBriefDraft): string | null => {
  const fields = [
    ["Summary", draft.summary, CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES],
    ...draft.objectives.map(
      (value, index) =>
        [`Objective ${index + 1}`, value, CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES] as const,
    ),
    ...draft.constraints.map(
      (value, index) =>
        [`Constraint ${index + 1}`, value, CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES] as const,
    ),
    ...draft.references.flatMap((value, index) => [
      [
        `Reference ${index + 1} kind`,
        value.kind,
        CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES,
      ] as const,
      [
        `Reference ${index + 1} value`,
        value.reference,
        CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES,
      ] as const,
    ]),
  ] as const;
  for (const [label, value, limit] of fields) {
    if (value.trim().length === 0) return `${label} cannot be blank.`;
    if (unsafeText(value)) return `${label} contains unsafe control text.`;
    if (utf8Bytes(value) > limit) return `${label} exceeds its ${limit}-byte UTF-8 limit.`;
  }
  const duplicateReferences = new Set<string>();
  for (const reference of draft.references) {
    const key = `${reference.kind}\u0000${reference.reference}`;
    if (duplicateReferences.has(key)) return "Duplicate Project Brief references are not allowed.";
    duplicateReferences.add(key);
  }
  const total = utf8Bytes(JSON.stringify(contentFromDraft(draft)));
  if (total > CIVILIZATION_MAX_PROJECT_BRIEF_BYTES) {
    return `Project Brief exceeds the ${CIVILIZATION_MAX_PROJECT_BRIEF_BYTES}-byte canonical payload limit.`;
  }
  return null;
};

const errorMessage = (error: unknown): string => {
  if (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof error.message === "string"
  ) {
    return error.message;
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Project Brief operation could not be completed.";
};

const conflictRevision = (error: unknown): number | null => {
  if (
    typeof error === "object" &&
    error !== null &&
    "_tag" in error &&
    error._tag === "CivilizationProjectBriefConflictError" &&
    "currentRevision" in error &&
    typeof error.currentRevision === "number"
  ) {
    return error.currentRevision;
  }
  return null;
};

function ByteCounter({ value, limit }: { readonly value: string; readonly limit: number }) {
  const bytes = utf8Bytes(value);
  return (
    <span className={bytes > limit ? "text-destructive" : "text-muted-foreground"}>
      {bytes} / {limit} UTF-8 bytes
    </span>
  );
}

function TextListEditor({
  label,
  items,
  disabled,
  onChange,
}: {
  readonly label: "Objective" | "Constraint";
  readonly items: ReadonlyArray<string>;
  readonly disabled: boolean;
  readonly onChange: (items: ReadonlyArray<string>) => void;
}) {
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <div className="text-sm font-medium">{label}s</div>
          <div className="text-xs text-muted-foreground">
            Up to {CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS};{" "}
            {CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES} UTF-8 bytes each.
          </div>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || items.length >= CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS}
          onClick={() => onChange([...items, ""])}
        >
          Add {label.toLowerCase()}
        </Button>
      </div>
      {items.length === 0 ? (
        <div className="text-xs text-muted-foreground">None.</div>
      ) : (
        <div className="space-y-3">
          {items.map((item, index) => (
            <div key={`${label}-${index}`} className="rounded-lg border border-border/70 p-3">
              <label className="block space-y-1.5">
                <span className="text-sm font-medium">
                  {label} {index + 1}
                </span>
                <Input
                  aria-label={`Project Brief ${label.toLowerCase()} ${index + 1}`}
                  value={item}
                  disabled={disabled}
                  onChange={(event) =>
                    onChange(
                      items.map((value, itemIndex) =>
                        itemIndex === index ? event.currentTarget.value : value,
                      ),
                    )
                  }
                />
              </label>
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-xs">
                <ByteCounter value={item} limit={CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES} />
                <Button
                  size="xs"
                  variant="ghost-destructive"
                  disabled={disabled}
                  onClick={() => onChange(items.filter((_, itemIndex) => itemIndex !== index))}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function CivilizationProjectBrief({
  environmentId,
  projectId,
  targetLabel,
  canRead,
  canWrite,
}: {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId | null;
  readonly targetLabel: string;
  readonly canRead: boolean;
  readonly canWrite: boolean;
}) {
  const metadata = useCivilizationProjectBriefMetadata(
    canRead && projectId !== null ? environmentId : null,
    canRead ? projectId : null,
  );
  const runBriefAction = useAtomSet(civilizationProjectBriefAction, { mode: "promise" });
  const [editorOpen, setEditorOpen] = useState(false);
  const [clearConfirmOpen, setClearConfirmOpen] = useState(false);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [working, setWorking] = useState(false);
  const [expectedRevision, setExpectedRevision] = useState<number | null>(null);
  const [loadedConfigured, setLoadedConfigured] = useState(false);
  const [draft, setDraft] = useState<ProjectBriefDraft>(EMPTY_DRAFT);
  const [message, setMessage] = useState<string | null>(null);
  const [messageRole, setMessageRole] = useState<"status" | "alert">("status");
  const [conflictCurrentRevision, setConflictCurrentRevision] = useState<number | null>(null);

  const requireWritePermission = (action: string): boolean => {
    if (readEnvironmentScope(environmentId, AuthSettingsWriteScope)) return true;
    setMessageRole("alert");
    setMessage(`Permission changed before ${action}; settings:write is required.`);
    return false;
  };

  const loadDetail = (openEditor: boolean) => {
    if (projectId === null || loadingDetail || working || !requireWritePermission("body read"))
      return;
    if (openEditor) setEditorOpen(true);
    setLoadingDetail(true);
    setMessage(null);
    setMessageRole("status");
    void runBriefAction({ environmentId, type: "detail", projectId })
      .then((result) => {
        const detail = result as CivilizationProjectBriefDetail;
        setLoadingDetail(false);
        setExpectedRevision(detail.revision);
        setLoadedConfigured(detail.configured);
        setDraft(draftFromDetail(detail));
        setConflictCurrentRevision(null);
        setMessage(openEditor ? null : "Latest Project Brief loaded for review.");
        metadata.refresh();
      })
      .catch((error: unknown) => {
        setLoadingDetail(false);
        setMessageRole("alert");
        setMessage(errorMessage(error));
      });
  };

  const issue = validationMessage(draft);
  const canonicalBytes = utf8Bytes(JSON.stringify(contentFromDraft(draft)));

  const save = () => {
    if (
      projectId === null ||
      expectedRevision === null ||
      working ||
      loadingDetail ||
      issue !== null ||
      !requireWritePermission("save")
    ) {
      return;
    }
    setWorking(true);
    setMessage(null);
    setMessageRole("status");
    const content = contentFromDraft(draft);
    void runBriefAction({
      environmentId,
      type: "set",
      request: { projectId, expectedRevision, content },
    })
      .then((result) => {
        const detail = result as CivilizationProjectBriefDetail;
        setWorking(false);
        setExpectedRevision(detail.revision);
        setLoadedConfigured(detail.configured);
        setDraft(draftFromDetail(detail));
        setConflictCurrentRevision(null);
        setMessageRole("status");
        setMessage(`Project Brief saved at revision ${detail.revision}.`);
        metadata.refresh();
      })
      .catch((error: unknown) => {
        setWorking(false);
        const currentRevision = conflictRevision(error);
        if (currentRevision !== null) {
          setConflictCurrentRevision(currentRevision);
          setMessageRole("alert");
          setMessage(
            `Project Brief changed elsewhere (current revision ${currentRevision}). Your draft is preserved; reload latest only when you are ready to review it.`,
          );
          metadata.refresh();
          return;
        }
        setMessageRole("alert");
        setMessage(errorMessage(error));
      });
  };

  const clear = () => {
    if (
      projectId === null ||
      expectedRevision === null ||
      working ||
      !requireWritePermission("clear")
    ) {
      return;
    }
    setWorking(true);
    setMessage(null);
    setMessageRole("status");
    void runBriefAction({
      environmentId,
      type: "clear",
      request: { projectId, expectedRevision },
    })
      .then((result) => {
        const detail = result as CivilizationProjectBriefDetail;
        setWorking(false);
        setClearConfirmOpen(false);
        setExpectedRevision(detail.revision);
        setLoadedConfigured(false);
        setDraft(EMPTY_DRAFT);
        setConflictCurrentRevision(null);
        setMessageRole("status");
        setMessage(
          `Project Brief cleared at revision ${detail.revision}. Historical retained packet copies follow normal diagnostic retention and purge policy.`,
        );
        metadata.refresh();
      })
      .catch((error: unknown) => {
        setWorking(false);
        setClearConfirmOpen(false);
        const currentRevision = conflictRevision(error);
        if (currentRevision !== null) {
          setConflictCurrentRevision(currentRevision);
          setMessageRole("alert");
          setMessage(
            `Project Brief changed elsewhere (current revision ${currentRevision}). Your draft is preserved; reload latest before clearing.`,
          );
          metadata.refresh();
          return;
        }
        setMessageRole("alert");
        setMessage(errorMessage(error));
      });
  };

  if (projectId === null) {
    return (
      <SettingsSection title="Project Brief" id="civilization-project-brief">
        <SettingsRow
          title="Exact checkout required"
          description="Project Brief is project-owned state. Choose one physical project checkout before reading metadata or editing its body."
          control={<span className="text-sm text-muted-foreground">Unavailable</span>}
        />
      </SettingsSection>
    );
  }

  const metadataValue = metadata.data;
  const metadataDescription =
    metadataValue === null
      ? metadata.isPending
        ? "Loading body-free Project Brief metadata."
        : (metadata.error ?? "Project Brief metadata is unavailable.")
      : `Revision ${metadataValue.revision} · ${metadataValue.bodyBytes} bytes · ${metadataValue.updatedAt ?? "never updated"}.`;

  return (
    <SettingsSection title="Project Brief" id="civilization-project-brief">
      <SettingsRow
        title="Shared human direction"
        description={metadataDescription}
        control={
          <span className="text-sm text-muted-foreground">
            {metadataValue === null
              ? metadata.isPending
                ? "Loading…"
                : "Unavailable"
              : metadataValue.configured
                ? "Configured"
                : "Not configured"}
          </span>
        }
      />
      <SettingsRow
        title="Packet behavior"
        description="The Brief is subordinate untrusted coordination context, not a system instruction. It is included only when the complete Brief fits the packet budget; otherwise it may be omitted whole."
        control={<span className="text-sm text-muted-foreground">Max 4 KiB</span>}
      />
      <SettingsRow
        title="Brief body"
        description={
          canWrite
            ? "The body is never prefetched. Open the editor to perform a fresh settings:write check and load the exact current revision."
            : "Body read, edit, and clear require settings:write. Metadata above remains body-free."
        }
        control={
          canWrite ? (
            <Button
              size="sm"
              variant="outline"
              disabled={metadataValue === null || loadingDetail}
              onClick={() => loadDetail(true)}
            >
              {loadingDetail
                ? "Loading…"
                : metadataValue?.configured
                  ? "Review & edit…"
                  : "Create…"}
            </Button>
          ) : (
            <span className="text-sm text-muted-foreground">Read only</span>
          )
        }
      />
      {message !== null && !editorOpen ? (
        <SettingsRow
          title="Project Brief operation"
          description={message}
          control={
            <span
              className={
                messageRole === "alert"
                  ? "text-sm text-destructive"
                  : "text-sm text-muted-foreground"
              }
            >
              {messageRole === "alert" ? "Action needed" : "Result"}
            </span>
          }
        />
      ) : null}

      <Dialog
        open={editorOpen}
        onOpenChange={(open) => {
          if (working) return;
          setEditorOpen(open);
        }}
      >
        <DialogPopup className="w-full sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Project Brief</DialogTitle>
            <DialogDescription>
              Structured operator-owned direction for {targetLabel}. Saving uses the exact revision
              loaded into this editor; conflicts never overwrite automatically.
            </DialogDescription>
          </DialogHeader>
          <DialogPanel>
            {loadingDetail || expectedRevision === null ? (
              <div role="status" className="text-sm text-muted-foreground">
                Loading Project Brief body…
              </div>
            ) : (
              <>
                <div className="grid gap-2 rounded-lg border border-border/70 p-3 text-xs text-muted-foreground sm:grid-cols-3">
                  <div>Loaded revision: {expectedRevision}</div>
                  <div>
                    Current canonical bytes: {canonicalBytes} /{" "}
                    {CIVILIZATION_MAX_PROJECT_BRIEF_BYTES}
                  </div>
                  <div>{loadedConfigured ? "Configured" : "Not configured"}</div>
                </div>
                <div className="rounded-lg border border-warning/30 bg-warning/8 p-3 text-xs text-muted-foreground">
                  This Brief remains untrusted coordination data. It cannot grant permissions or
                  override higher-priority instructions, and packet composition may omit it when it
                  does not fit in full.
                </div>
                <label className="block space-y-1.5">
                  <span className="text-sm font-medium">Summary</span>
                  <Textarea
                    aria-label="Project Brief summary"
                    value={draft.summary}
                    disabled={working}
                    onChange={(event) =>
                      setDraft((current) => ({ ...current, summary: event.currentTarget.value }))
                    }
                  />
                  <div className="text-xs">
                    <ByteCounter
                      value={draft.summary}
                      limit={CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES}
                    />
                  </div>
                </label>
                <TextListEditor
                  label="Objective"
                  items={draft.objectives}
                  disabled={working}
                  onChange={(objectives) => setDraft((current) => ({ ...current, objectives }))}
                />
                <TextListEditor
                  label="Constraint"
                  items={draft.constraints}
                  disabled={working}
                  onChange={(constraints) => setDraft((current) => ({ ...current, constraints }))}
                />
                <div className="space-y-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <div className="text-sm font-medium">References</div>
                      <div className="text-xs text-muted-foreground">
                        Up to {CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES}; kind ≤{" "}
                        {CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES} bytes, value ≤{" "}
                        {CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES} bytes.
                      </div>
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={
                        working ||
                        draft.references.length >= CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES
                      }
                      onClick={() =>
                        setDraft((current) => ({
                          ...current,
                          references: [...current.references, { kind: "", reference: "" }],
                        }))
                      }
                    >
                      Add reference
                    </Button>
                  </div>
                  {draft.references.length === 0 ? (
                    <div className="text-xs text-muted-foreground">None.</div>
                  ) : (
                    draft.references.map((reference, index) => (
                      <div
                        key={`reference-${index}`}
                        className="space-y-2 rounded-lg border border-border/70 p-3"
                      >
                        <div className="grid gap-3 sm:grid-cols-2">
                          <label className="space-y-1.5">
                            <span className="text-sm font-medium">Kind</span>
                            <Input
                              aria-label={`Project Brief reference ${index + 1} kind`}
                              value={reference.kind}
                              disabled={working}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  references: current.references.map((value, itemIndex) =>
                                    itemIndex === index
                                      ? { ...value, kind: event.currentTarget.value }
                                      : value,
                                  ),
                                }))
                              }
                            />
                            <div className="text-xs">
                              <ByteCounter
                                value={reference.kind}
                                limit={CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES}
                              />
                            </div>
                          </label>
                          <label className="space-y-1.5">
                            <span className="text-sm font-medium">Reference</span>
                            <Input
                              aria-label={`Project Brief reference ${index + 1} value`}
                              value={reference.reference}
                              disabled={working}
                              onChange={(event) =>
                                setDraft((current) => ({
                                  ...current,
                                  references: current.references.map((value, itemIndex) =>
                                    itemIndex === index
                                      ? { ...value, reference: event.currentTarget.value }
                                      : value,
                                  ),
                                }))
                              }
                            />
                            <div className="text-xs">
                              <ByteCounter
                                value={reference.reference}
                                limit={CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES}
                              />
                            </div>
                          </label>
                        </div>
                        <div className="flex justify-end">
                          <Button
                            size="xs"
                            variant="ghost-destructive"
                            disabled={working}
                            onClick={() =>
                              setDraft((current) => ({
                                ...current,
                                references: current.references.filter(
                                  (_, itemIndex) => itemIndex !== index,
                                ),
                              }))
                            }
                          >
                            Remove reference
                          </Button>
                        </div>
                      </div>
                    ))
                  )}
                </div>
                {issue === null ? null : (
                  <div role="alert" className="text-sm text-destructive">
                    {issue}
                  </div>
                )}
                {message === null ? null : (
                  <div role={messageRole} className="text-sm text-muted-foreground">
                    {message}
                  </div>
                )}
                {conflictCurrentRevision === null ? null : (
                  <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/30 p-3">
                    <div className="text-xs text-muted-foreground">
                      Server revision {conflictCurrentRevision} differs from loaded revision{" "}
                      {expectedRevision}. Your local draft remains untouched.
                    </div>
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={working || loadingDetail}
                      onClick={() => loadDetail(false)}
                    >
                      Reload latest
                    </Button>
                  </div>
                )}
              </>
            )}
          </DialogPanel>
          <DialogFooter>
            {loadedConfigured && expectedRevision !== null ? (
              <Button
                variant="destructive-outline"
                disabled={working || loadingDetail}
                onClick={() => setClearConfirmOpen(true)}
              >
                Clear…
              </Button>
            ) : null}
            <Button
              disabled={
                working || loadingDetail || expectedRevision === null || issue !== null || !canWrite
              }
              onClick={save}
            >
              {working ? "Saving…" : "Save Brief"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>

      <AlertDialog
        open={clearConfirmOpen}
        onOpenChange={(open) => {
          if (working) return;
          setClearConfirmOpen(open);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear Project Brief?</AlertDialogTitle>
            <AlertDialogDescription>
              This clears the active Brief for future packets and advances its revision. It does not
              retroactively erase Brief text already retained inside historical diagnostic packets;
              those copies follow normal diagnostic retention and project purge.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose
              disabled={working}
              render={<Button variant="outline" disabled={working} />}
            >
              Cancel
            </AlertDialogClose>
            <Button variant="destructive" disabled={working} onClick={clear}>
              Clear Brief
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
