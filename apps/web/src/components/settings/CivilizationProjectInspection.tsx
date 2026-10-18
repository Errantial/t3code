import { useAtomSet } from "@effect/atom-react";
import {
  AuthSettingsWriteScope,
  type CivilizationCensusCursor,
  type CivilizationCensusPage,
  type CivilizationCitizenSummary,
  type CivilizationEffectiveConfig,
  CivilizationMessageId,
  CivilizationNoteId,
  type CivilizationNoteBody,
  type CivilizationNoteSummary,
  type CivilizationNotesCursor,
  type CivilizationNotesPage,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  civilizationProjectReadAction,
  civilizationSensitiveReadAction,
  mergeCivilizationRevisionPage,
  type CivilizationRevisionPageState,
  useCivilizationCensusPage,
  useCivilizationCitizenDetail,
  useCivilizationNotesPage,
} from "../../state/civilization";
import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { CivilizationChronicle } from "./CivilizationChronicle";
import { CivilizationCitizenDetailDialog } from "./CivilizationCitizenDetailDialog";
import { CivilizationCitizenLink } from "./CivilizationCitizenLink";
import { CivilizationCorrespondenceHistory } from "./CivilizationCorrespondenceHistory";
import { CivilizationDataRetention } from "./CivilizationDataRetention";
import { CivilizationLineageExplorer } from "./CivilizationLineageExplorer";

interface CivilizationProjectInspectionProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly targetLabel: string;
  readonly effective: CivilizationEffectiveConfig;
  readonly allowSensitiveActions: boolean;
  readonly mode?: CivilizationProjectInspectionMode | undefined;
  readonly onViewContext?: ((threadId: ThreadId) => void) | undefined;
  readonly onNavigateCitizen?: ((threadId: ThreadId) => void) | undefined;
  readonly onNavigateLineage?: ((threadId: ThreadId | null) => void) | undefined;
  readonly onNavigateChronicle?:
    | ((target: { readonly threadId?: ThreadId; readonly sourceId?: string }) => void)
    | undefined;
  readonly onNavigateCorrespondence?:
    | ((target: {
        readonly threadId?: ThreadId;
        readonly messageId?: CivilizationMessageId;
      }) => void)
    | undefined;
  readonly initialCitizenThreadId?: ThreadId | undefined;
  readonly initialLineageThreadId?: ThreadId | undefined;
  readonly initialChronicleThreadId?: ThreadId | undefined;
  readonly initialChronicleSourceId?: string | undefined;
  readonly initialCorrespondenceThreadId?: ThreadId | undefined;
  readonly initialMessageId?: CivilizationMessageId | undefined;
  readonly requestedLineage?:
    | { readonly threadId: ThreadId; readonly nonce: number }
    | null
    | undefined;
  readonly requestedCitizen?:
    | { readonly threadId: ThreadId; readonly nonce: number }
    | null
    | undefined;
}

export type CivilizationProjectInspectionMode =
  | "all"
  | "citizens"
  | "chronicle"
  | "messages"
  | "notes"
  | "data";

const errorMessage = (error: unknown): string => {
  if (typeof error === "object" && error !== null) {
    const reason = "reason" in error && typeof error.reason === "string" ? error.reason : null;
    const message = "message" in error && typeof error.message === "string" ? error.message : null;
    if (reason !== null && message !== null) return `${reason}: ${message}`;
    if (message !== null) return message;
    if ("_tag" in error && error._tag === "CivilizationConfigConflictError") {
      return "Configuration changed elsewhere; review and try again.";
    }
  }
  return error instanceof Error && error.message.trim().length > 0
    ? error.message
    : "The Civilization operation could not be completed.";
};

function formatDate(value: string | null): string {
  if (value === null) return "—";
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? value : date.toLocaleString();
}

function PaginationMessage({ message }: { readonly message: string | null }) {
  return message === null ? null : (
    <div className="text-xs text-muted-foreground" role="status">
      {message}
    </div>
  );
}

function CitizenCard({
  citizen,
  onViewCitizen,
  onViewLineage,
  onViewChronicle,
  onViewContext,
}: {
  readonly citizen: CivilizationCitizenSummary;
  readonly onViewCitizen: (threadId: ThreadId) => void;
  readonly onViewLineage: (threadId: ThreadId) => void;
  readonly onViewChronicle: (threadId: ThreadId) => void;
  readonly onViewContext?: ((threadId: ThreadId) => void) | undefined;
}) {
  const state = citizen.deleted ? "Deleted" : citizen.closed ? "Closed" : "Open";
  return (
    <div className="space-y-2 rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <CivilizationCitizenLink
            threadId={citizen.threadId}
            name={citizen.name}
            onViewCitizen={onViewCitizen}
          />
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {citizen.profileLabel} · generation {citizen.generation} · {state} ·{" "}
            {citizen.titleManaged ? "managed title" : "manual title"}
          </div>
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {citizen.parentThreadId === null
              ? "No parent"
              : `${citizen.relationshipToParent ?? "child"} of ${citizen.parentThreadId}`}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => onViewLineage(citizen.threadId)}>
            View lineage
          </Button>
          <Button size="xs" variant="outline" onClick={() => onViewChronicle(citizen.threadId)}>
            Chronicle
          </Button>
          {onViewContext === undefined ? null : (
            <Button size="xs" variant="outline" onClick={() => onViewContext(citizen.threadId)}>
              Context
            </Button>
          )}
          {citizen.observedOnly ? (
            <span className="text-xs text-muted-foreground">Provider-owned · read only</span>
          ) : null}
        </div>
      </div>
    </div>
  );
}

export function CivilizationProjectInspection({
  environmentId,
  projectId,
  targetLabel,
  effective,
  allowSensitiveActions,
  mode = "all",
  onViewContext,
  onNavigateCitizen,
  onNavigateLineage,
  onNavigateChronicle,
  onNavigateCorrespondence,
  initialCitizenThreadId,
  initialLineageThreadId,
  initialChronicleThreadId,
  initialChronicleSourceId,
  initialCorrespondenceThreadId,
  initialMessageId,
  requestedLineage,
  requestedCitizen,
}: CivilizationProjectInspectionProps) {
  const canWrite = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const censusLimit = effective.config.operations.censusPageSize;
  const [includeResolved, setIncludeResolved] = useState(false);
  const [lineageFocusThreadId, setLineageFocusThreadId] = useState<ThreadId | null>(
    initialLineageThreadId ?? null,
  );
  const [citizenDetailThreadId, setCitizenDetailThreadId] = useState<ThreadId | null>(
    initialCitizenThreadId ?? null,
  );
  const [dismissedCitizenRequestNonce, setDismissedCitizenRequestNonce] = useState<number | null>(
    null,
  );
  const [dismissedLineageRequestNonce, setDismissedLineageRequestNonce] = useState<number | null>(
    null,
  );
  const [chronicleFocusThreadId, setChronicleFocusThreadId] = useState<ThreadId | null>(
    initialChronicleThreadId ?? null,
  );
  const [chronicleSourceId, setChronicleSourceId] = useState<string | null>(
    initialChronicleSourceId ?? null,
  );
  const [correspondenceFocusThreadId, setCorrespondenceFocusThreadId] = useState<ThreadId | null>(
    initialCorrespondenceThreadId ?? null,
  );
  const [correspondenceMessageId, setCorrespondenceMessageId] =
    useState<CivilizationMessageId | null>(initialMessageId ?? null);
  const censusActive = mode === "all" || mode === "citizens" || mode === "messages";
  const notesActive = mode === "all" || mode === "notes";
  const census = useCivilizationCensusPage(
    censusActive ? environmentId : null,
    censusActive ? projectId : null,
    null,
    censusLimit,
  );
  const notes = useCivilizationNotesPage(
    notesActive ? environmentId : null,
    notesActive ? projectId : null,
    null,
    censusLimit,
    includeResolved,
  );
  const loadPage = useAtomSet(civilizationProjectReadAction, { mode: "promise" });
  const readSensitive = useAtomSet(civilizationSensitiveReadAction, { mode: "promise" });

  const [censusAccumulated, setCensusAccumulated] =
    useState<CivilizationRevisionPageState<CivilizationCitizenSummary> | null>(null);
  const [censusCursor, setCensusCursor] = useState<CivilizationCensusCursor | null>(null);
  const [censusMessage, setCensusMessage] = useState<string | null>(null);
  const [notesAccumulated, setNotesAccumulated] =
    useState<CivilizationRevisionPageState<CivilizationNoteSummary> | null>(null);
  const [notesCursor, setNotesCursor] = useState<CivilizationNotesCursor | null>(null);
  const [notesMessage, setNotesMessage] = useState<string | null>(null);
  const [noteBody, setNoteBody] = useState<CivilizationNoteBody | null>(null);
  const [bodyLoading, setBodyLoading] = useState(false);
  const sensitiveAllowed = allowSensitiveActions && canWrite;
  const requestedCitizenThreadId =
    requestedCitizen !== undefined &&
    requestedCitizen !== null &&
    requestedCitizen.nonce !== dismissedCitizenRequestNonce
      ? requestedCitizen.threadId
      : null;
  const visibleCitizenDetailThreadId = requestedCitizenThreadId ?? citizenDetailThreadId;
  const citizenDetail = useCivilizationCitizenDetail(
    environmentId,
    projectId,
    visibleCitizenDetailThreadId,
  );
  const viewCitizen = (threadId: ThreadId) => {
    if (mode !== "all" && mode !== "citizens" && onNavigateCitizen !== undefined) {
      onNavigateCitizen(threadId);
      return;
    }
    if (requestedCitizen !== undefined && requestedCitizen !== null) {
      setDismissedCitizenRequestNonce(requestedCitizen.nonce);
    }
    setCitizenDetailThreadId(threadId);
  };
  const closeCitizen = () => {
    if (requestedCitizen !== undefined && requestedCitizen !== null) {
      setDismissedCitizenRequestNonce(requestedCitizen.nonce);
    }
    setCitizenDetailThreadId(null);
  };
  const requestedLineageThreadId =
    requestedLineage !== undefined &&
    requestedLineage !== null &&
    requestedLineage.nonce !== dismissedLineageRequestNonce
      ? requestedLineage.threadId
      : null;
  const visibleLineageFocusThreadId = requestedLineageThreadId ?? lineageFocusThreadId;
  const viewLineage = (threadId: ThreadId) => {
    if (mode !== "all" && onNavigateLineage !== undefined) {
      onNavigateLineage(threadId);
      return;
    }
    if (requestedLineage !== undefined && requestedLineage !== null) {
      setDismissedLineageRequestNonce(requestedLineage.nonce);
    }
    setLineageFocusThreadId(threadId);
  };
  const closeLineage = () => {
    if (mode !== "all" && onNavigateLineage !== undefined) {
      onNavigateLineage(null);
      return;
    }
    if (requestedLineage !== undefined && requestedLineage !== null) {
      setDismissedLineageRequestNonce(requestedLineage.nonce);
    }
    setLineageFocusThreadId(null);
  };
  const viewChronicle = (target: { readonly threadId?: ThreadId; readonly sourceId?: string }) => {
    if (mode !== "all" && mode !== "chronicle" && onNavigateChronicle !== undefined) {
      onNavigateChronicle(target);
      return;
    }
    setChronicleFocusThreadId(target.threadId ?? null);
    setChronicleSourceId(target.sourceId ?? null);
  };
  const viewCorrespondence = (target: {
    readonly threadId?: ThreadId;
    readonly messageId?: CivilizationMessageId;
  }) => {
    if (mode !== "all" && mode !== "messages" && onNavigateCorrespondence !== undefined) {
      onNavigateCorrespondence(target);
      return;
    }
    setCorrespondenceFocusThreadId(target.threadId ?? null);
    setCorrespondenceMessageId(target.messageId ?? null);
  };

  const baseCensus = census.data;
  const censusState =
    baseCensus !== null && censusAccumulated?.revision === baseCensus.revision
      ? censusAccumulated
      : baseCensus === null
        ? null
        : { status: "ready" as const, revision: baseCensus.revision, items: baseCensus.citizens };
  const nextCensusCursor =
    censusAccumulated !== null &&
    baseCensus !== null &&
    censusAccumulated.revision === baseCensus.revision
      ? censusCursor
      : (baseCensus?.nextCursor ?? null);

  const baseNotes = notes.data;
  const notesState =
    baseNotes !== null && notesAccumulated?.revision === baseNotes.revision
      ? notesAccumulated
      : baseNotes === null
        ? null
        : { status: "ready" as const, revision: baseNotes.revision, items: baseNotes.notes };
  const nextNotesCursor =
    notesAccumulated !== null &&
    baseNotes !== null &&
    notesAccumulated.revision === baseNotes.revision
      ? notesCursor
      : (baseNotes?.nextCursor ?? null);

  const loadMoreCensus = () => {
    if (nextCensusCursor === null || baseCensus === null) return;
    setCensusMessage(null);
    void loadPage({
      type: "censusPage",
      environmentId,
      projectId,
      cursor: nextCensusCursor,
      limit: censusLimit,
    })
      .then((result) => {
        const page = result as CivilizationCensusPage;
        const current = censusState ?? {
          status: "ready" as const,
          revision: baseCensus.revision,
          items: baseCensus.citizens,
        };
        const merged = mergeCivilizationRevisionPage(current, {
          revision: page.revision,
          items: page.citizens,
        });
        setCensusAccumulated(merged);
        setCensusCursor(page.nextCursor);
        if (merged.status === "stale") {
          setCensusMessage("Census changed while paging; restarted from the newest page.");
          census.refresh();
        }
      })
      .catch((error: unknown) => setCensusMessage(errorMessage(error)));
  };

  const loadMoreNotes = () => {
    if (nextNotesCursor === null || baseNotes === null) return;
    setNotesMessage(null);
    void loadPage({
      type: "notesPage",
      environmentId,
      projectId,
      cursor: nextNotesCursor,
      limit: censusLimit,
      includeResolved,
    })
      .then((result) => {
        const page = result as CivilizationNotesPage;
        const current = notesState ?? {
          status: "ready" as const,
          revision: baseNotes.revision,
          items: baseNotes.notes,
        };
        const merged = mergeCivilizationRevisionPage(current, {
          revision: page.revision,
          items: page.notes,
        });
        setNotesAccumulated(merged);
        setNotesCursor(page.nextCursor);
        if (merged.status === "stale") {
          setNotesMessage("Notes changed while paging; restarted from the newest page.");
          notes.refresh();
        }
      })
      .catch((error: unknown) => setNotesMessage(errorMessage(error)));
  };

  const openNoteBody = (note: CivilizationNoteSummary) => {
    if (!sensitiveAllowed || bodyLoading) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setNotesMessage("Permission changed before body inspection; settings:write is required.");
      return;
    }
    setBodyLoading(true);
    setNotesMessage(null);
    void readSensitive({ type: "noteBody", environmentId, projectId, noteId: note.noteId })
      .then((body) => {
        setBodyLoading(false);
        setNoteBody(body as CivilizationNoteBody);
      })
      .catch((error: unknown) => {
        setBodyLoading(false);
        setNotesMessage(errorMessage(error));
      });
  };

  const openChronicleNote = (noteId: string) => {
    if (!sensitiveAllowed || bodyLoading) return;
    if (!readEnvironmentScope(environmentId, AuthSettingsWriteScope)) {
      setNotesMessage("Permission changed before body inspection; settings:write is required.");
      return;
    }
    setBodyLoading(true);
    setNotesMessage(null);
    void readSensitive({
      type: "noteBody",
      environmentId,
      projectId,
      noteId: CivilizationNoteId.make(noteId),
    })
      .then((body) => {
        setBodyLoading(false);
        setNoteBody(body as CivilizationNoteBody);
      })
      .catch((error: unknown) => {
        setBodyLoading(false);
        setNotesMessage(errorMessage(error));
      });
  };

  return (
    <div className="space-y-8">
      {mode !== "all" && mode !== "citizens" ? null : (
        <SettingsSection title={`Citizens · ${targetLabel}`} id="civilization-citizens">
          <SettingsRow
            title="Census"
            description={
              allowSensitiveActions
                ? "Project census uses revision-consistent keyset pagination."
                : "Project census for this environment. Select one environment before citizen administration."
            }
            control={
              <span className="text-sm text-muted-foreground">
                {censusState?.items.length ?? 0}
              </span>
            }
          />
          <div className="space-y-2 px-3 sm:px-4">
            {censusState?.items.map((citizen) => (
              <CitizenCard
                key={citizen.threadId}
                citizen={citizen}
                onViewCitizen={viewCitizen}
                onViewLineage={viewLineage}
                onViewChronicle={(threadId) => viewChronicle({ threadId })}
                onViewContext={onViewContext}
              />
            ))}
            {census.isPending && census.data === null ? (
              <div className="text-sm text-muted-foreground" role="status">
                Loading census…
              </div>
            ) : null}
            {census.error === null ? null : (
              <div className="text-sm text-destructive" role="alert">
                {census.error}
              </div>
            )}
            {!census.isPending && census.error === null && censusState?.items.length === 0 ? (
              <div
                className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground"
                role="status"
              >
                No citizens are enrolled in this project yet.
              </div>
            ) : null}
            <PaginationMessage message={censusMessage} />
            {nextCensusCursor === null ? null : (
              <Button size="sm" variant="outline" onClick={loadMoreCensus}>
                Load more citizens
              </Button>
            )}
          </div>
        </SettingsSection>
      )}

      {(mode === "all" || mode === "citizens") && visibleLineageFocusThreadId !== null ? (
        <CivilizationLineageExplorer
          environmentId={environmentId}
          projectId={projectId}
          initialThreadId={visibleLineageFocusThreadId}
          pageSize={censusLimit}
          onClose={closeLineage}
          onViewCitizen={viewCitizen}
          onViewChronicle={(threadId) => viewChronicle({ threadId })}
          onViewCorrespondence={
            sensitiveAllowed ? (threadId) => viewCorrespondence({ threadId }) : undefined
          }
          onViewContext={onViewContext}
        />
      ) : null}

      {mode !== "all" && mode !== "chronicle" ? null : (
        <CivilizationChronicle
          key={`chronicle:${chronicleFocusThreadId ?? "all"}:${chronicleSourceId ?? "all"}`}
          environmentId={environmentId}
          projectId={projectId}
          pageSize={censusLimit}
          onViewCitizen={viewCitizen}
          onViewLineage={viewLineage}
          initialThreadId={chronicleFocusThreadId ?? undefined}
          initialSourceId={chronicleSourceId ?? undefined}
          onViewNote={sensitiveAllowed ? openChronicleNote : undefined}
          onViewCorrespondence={
            sensitiveAllowed
              ? (messageId) =>
                  viewCorrespondence({ messageId: CivilizationMessageId.make(messageId) })
              : undefined
          }
        />
      )}

      {mode !== "all" && mode !== "notes" ? null : (
        <SettingsSection title={`Notes · ${targetLabel}`} id="civilization-notes">
          <SettingsRow
            title="Include resolved"
            description="Lists metadata only. Note bodies are never prefetched and require settings:write."
            control={
              <Switch
                aria-label={`Include resolved Civilization notes on ${targetLabel}`}
                checked={includeResolved}
                onCheckedChange={(checked) => {
                  setIncludeResolved(checked);
                  setNotesAccumulated(null);
                  setNotesCursor(null);
                  setNotesMessage(null);
                }}
              />
            }
          />
          <div className="space-y-2 px-3 sm:px-4">
            {notesState?.items.map((note) => (
              <div
                key={note.noteId}
                className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border/70 p-3"
              >
                <div className="min-w-0 text-xs text-muted-foreground">
                  <div className="font-medium text-sm text-foreground">{note.category}</div>
                  <div>
                    {note.bodyBytes} bytes · rev {note.revision} · {note.acceptedRuntimeMode}/
                    {note.acceptedInteractionMode}
                  </div>
                  <div>
                    author {note.authorThreadId} · updated {formatDate(note.updatedAt)}
                  </div>
                  <div>
                    {note.resolvedAt === null
                      ? "Active"
                      : `Resolved ${formatDate(note.resolvedAt)}`}
                  </div>
                </div>
                {sensitiveAllowed ? (
                  <Button
                    size="xs"
                    variant="outline"
                    disabled={bodyLoading}
                    onClick={() => openNoteBody(note)}
                  >
                    Open body
                  </Button>
                ) : null}
              </div>
            ))}
            {notes.isPending && notes.data === null ? (
              <div className="text-sm text-muted-foreground" role="status">
                Loading notes…
              </div>
            ) : null}
            {notes.error === null ? null : (
              <div className="text-sm text-destructive" role="alert">
                {notes.error}
              </div>
            )}
            {!notes.isPending && notes.error === null && notesState?.items.length === 0 ? (
              <div
                className="rounded-md border border-border/70 p-3 text-sm text-muted-foreground"
                role="status"
              >
                No {includeResolved ? "retained" : "active"} notes match this view.
              </div>
            ) : null}
            <PaginationMessage message={notesMessage} />
            {nextNotesCursor === null ? null : (
              <Button size="sm" variant="outline" onClick={loadMoreNotes}>
                Load more notes
              </Button>
            )}
          </div>
        </SettingsSection>
      )}

      {mode !== "all" && mode !== "messages" ? null : (
        <CivilizationCorrespondenceHistory
          key={`correspondence:${correspondenceFocusThreadId ?? "all"}:${correspondenceMessageId ?? "all"}`}
          environmentId={environmentId}
          projectId={projectId}
          pageSize={effective.config.operations.inboxPageSize}
          allowSensitiveActions={allowSensitiveActions}
          citizenOptions={censusState?.items ?? []}
          hasMoreCitizenOptions={nextCensusCursor !== null}
          onLoadMoreCitizenOptions={loadMoreCensus}
          onViewCitizen={viewCitizen}
          onViewLineage={viewLineage}
          initialParticipantThreadId={correspondenceFocusThreadId ?? undefined}
          initialMessageId={correspondenceMessageId ?? undefined}
          onViewChronicleSource={(sourceId) => viewChronicle({ sourceId })}
        />
      )}

      {mode !== "all" && mode !== "data" ? null : (
        <CivilizationDataRetention
          environmentId={environmentId}
          projectId={projectId}
          environmentLabel={targetLabel}
          effective={effective}
          enabled={sensitiveAllowed}
          refreshProjectData={() => {
            census.refresh();
            notes.refresh();
          }}
        />
      )}

      {mode !== "all" && mode !== "citizens" ? null : (
        <CivilizationCitizenDetailDialog
          key={`citizen-detail:${visibleCitizenDetailThreadId ?? "none"}:${citizenDetail.data?.revision ?? "loading"}`}
          open={visibleCitizenDetailThreadId !== null}
          onOpenChange={(open) => {
            if (!open) closeCitizen();
          }}
          detail={citizenDetail.data}
          loading={citizenDetail.isPending}
          error={citizenDetail.error === null ? null : errorMessage(citizenDetail.error)}
          environmentId={environmentId}
          effective={effective}
          canAdminister={sensitiveAllowed}
          refresh={() => {
            citizenDetail.refresh();
            census.refresh();
          }}
          onViewLineage={viewLineage}
          onViewChronicle={(threadId) => viewChronicle({ threadId })}
          onViewContext={onViewContext}
          onViewMessages={(threadId) => viewCorrespondence({ threadId })}
        />
      )}

      {mode !== "all" && mode !== "notes" && mode !== "chronicle" ? null : (
        <Dialog
          open={noteBody !== null}
          onOpenChange={(open) => {
            if (!open) setNoteBody(null);
          }}
        >
          <DialogPopup>
            <DialogHeader>
              <DialogTitle>Note body</DialogTitle>
              <DialogDescription>
                Sensitive administrative inspection. Body text is not added to search or
                notifications.
              </DialogDescription>
            </DialogHeader>
            <DialogPanel>
              <pre className="max-h-96 overflow-auto whitespace-pre-wrap wrap-anywhere text-sm">
                {noteBody?.body}
              </pre>
            </DialogPanel>
          </DialogPopup>
        </Dialog>
      )}
    </div>
  );
}
