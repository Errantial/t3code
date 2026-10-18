import {
  type CivilizationAchievementAward,
  type CivilizationAchievementCursor,
  type CivilizationAchievementId,
  type CivilizationChronicleCursor,
  type CivilizationChronicleEntry,
  type CivilizationChronicleKind,
  type EnvironmentId,
  type ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import {
  useCivilizationAchievementPage,
  useCivilizationChroniclePage,
} from "../../state/civilization";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface CivilizationChronicleProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly pageSize: number;
  readonly onViewLineage?: ((threadId: ThreadId) => void) | undefined;
}

const KINDS: ReadonlyArray<CivilizationChronicleKind> = [
  "citizen_joined",
  "citizen_adopted",
  "child_joined",
  "citizen_settled",
  "citizen_returned",
  "citizen_archived",
  "citizen_deleted",
  "identity_reassigned",
  "note_created",
  "note_resolved",
  "mail_sent",
  "mail_acknowledged",
  "mail_terminal",
];

const label = (kind: CivilizationChronicleKind): string =>
  ({
    citizen_joined: "Citizen joined",
    citizen_adopted: "Citizen adopted",
    child_joined: "Child joined",
    citizen_settled: "Citizen settled",
    citizen_returned: "Citizen returned",
    citizen_archived: "Citizen archived",
    citizen_deleted: "Citizen deleted",
    identity_reassigned: "Identity reassigned",
    note_created: "Note created",
    note_resolved: "Note resolved",
    mail_sent: "Mail sent",
    mail_acknowledged: "Mail acknowledged",
    mail_terminal: "Mail became terminal",
  })[kind];

const achievementLabel = (achievementId: CivilizationAchievementId): string =>
  ({
    project_founder: "Project founder",
    first_descendant: "First descendant",
    first_acknowledged_correspondence: "First acknowledged correspondence",
    lineage_generation_3: "Third generation reached",
  })[achievementId];

function ChronicleThreadLink({
  threadId,
  onViewLineage,
}: {
  readonly threadId: ThreadId;
  readonly onViewLineage?: ((threadId: ThreadId) => void) | undefined;
}) {
  return onViewLineage === undefined ? (
    <span className="wrap-anywhere">{threadId}</span>
  ) : (
    <Button size="xs" variant="ghost" onClick={() => onViewLineage(threadId)}>
      {threadId}
    </Button>
  );
}

function ChronicleEntry({
  entry,
  onViewLineage,
}: {
  readonly entry: CivilizationChronicleEntry;
  readonly onViewLineage?: ((threadId: ThreadId) => void) | undefined;
}) {
  return (
    <li className="rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-sm">{label(entry.kind)}</div>
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {entry.primaryThreadId === null ? (
              "project"
            ) : (
              <ChronicleThreadLink threadId={entry.primaryThreadId} onViewLineage={onViewLineage} />
            )}
            {entry.secondaryThreadId === null ? null : (
              <>
                {" · related "}
                <ChronicleThreadLink
                  threadId={entry.secondaryThreadId}
                  onViewLineage={onViewLineage}
                />
              </>
            )}
          </div>
          {"relationship" in entry.metadata ? (
            <div className="text-xs text-muted-foreground">
              relationship {entry.metadata.relationship}
            </div>
          ) : null}
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>{new Date(entry.occurredAt).toLocaleString()}</div>
          <div>
            {entry.sourceKind} ·{" "}
            {entry.sourceSequence === null ? "no sequence" : `seq ${entry.sourceSequence}`}
          </div>
        </div>
      </div>
    </li>
  );
}

function AchievementAward({
  award,
  onViewLineage,
}: {
  readonly award: CivilizationAchievementAward;
  readonly onViewLineage?: ((threadId: ThreadId) => void) | undefined;
}) {
  return (
    <li className="rounded-lg border border-border/70 p-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="font-medium text-sm">{achievementLabel(award.achievementId)}</div>
          <div className="wrap-anywhere text-xs text-muted-foreground">
            {award.subjectThreadId === null ? (
              "project"
            ) : (
              <ChronicleThreadLink threadId={award.subjectThreadId} onViewLineage={onViewLineage} />
            )}
            {` · definition v${award.definitionVersion}`}
          </div>
        </div>
        <div className="text-right text-xs text-muted-foreground">
          <div>{new Date(award.awardedAt).toLocaleString()}</div>
          <div className="wrap-anywhere">trigger {award.triggerEntryId}</div>
        </div>
      </div>
    </li>
  );
}

export function CivilizationChronicle({
  environmentId,
  projectId,
  pageSize,
  onViewLineage,
}: CivilizationChronicleProps) {
  const [kind, setKind] = useState<CivilizationChronicleKind | undefined>(undefined);
  const [threadDraft, setThreadDraft] = useState("");
  const [fromDraft, setFromDraft] = useState("");
  const [toDraft, setToDraft] = useState("");
  const [appliedFilters, setAppliedFilters] = useState<{
    readonly threadId?: ThreadId | undefined;
    readonly from?: string | undefined;
    readonly to?: string | undefined;
  }>({});
  const [cursor, setCursor] = useState<CivilizationChronicleCursor | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<CivilizationChronicleCursor | null>>([]);
  const [achievementCursor, setAchievementCursor] = useState<CivilizationAchievementCursor | null>(
    null,
  );
  const [achievementCursorStack, setAchievementCursorStack] = useState<
    Array<CivilizationAchievementCursor | null>
  >([]);
  const achievements = useCivilizationAchievementPage(
    environmentId,
    projectId,
    null,
    achievementCursor,
    pageSize,
  );
  const page = useCivilizationChroniclePage(
    environmentId,
    projectId,
    { kind, ...appliedFilters },
    cursor,
    pageSize,
  );
  const achievementNextCursor = achievements.data?.nextCursor ?? null;
  const nextCursor = page.data?.nextCursor ?? null;

  const resetPaging = () => {
    setCursor(null);
    setCursorStack([]);
  };
  const nextPage = () => {
    if (nextCursor === null) return;
    setCursorStack((current) => [...current, cursor]);
    setCursor(nextCursor);
  };
  const previousPage = () => {
    setCursorStack((current) => {
      if (current.length === 0) return current;
      setCursor(current.at(-1) ?? null);
      return current.slice(0, -1);
    });
  };
  const nextAchievementPage = () => {
    if (achievementNextCursor === null) return;
    setAchievementCursorStack((current) => [...current, achievementCursor]);
    setAchievementCursor(achievementNextCursor);
  };
  const previousAchievementPage = () => {
    setAchievementCursorStack((current) => {
      if (current.length === 0) return current;
      setAchievementCursor(current.at(-1) ?? null);
      return current.slice(0, -1);
    });
  };
  const applyFilters = () => {
    const thread = threadDraft.trim();
    const from = fromDraft === "" ? undefined : new Date(fromDraft).toISOString();
    const to = toDraft === "" ? undefined : new Date(toDraft).toISOString();
    setAppliedFilters({
      ...(thread === "" ? {} : { threadId: ThreadId.make(thread) }),
      ...(from === undefined ? {} : { from }),
      ...(to === undefined ? {} : { to }),
    });
    resetPaging();
  };

  return (
    <SettingsSection title="Chronicle" id="civilization-chronicle">
      <SettingsRow
        title="Achievements"
        description="Versioned awards derived from authoritative Chronicle facts only. No model inference."
        control={
          <div className="min-w-0 space-y-2">
            {achievements.isPending && achievements.data === null ? (
              <div className="text-sm text-muted-foreground">Loading achievements…</div>
            ) : null}
            {achievements.error === null ? null : (
              <div className="text-sm text-destructive">{String(achievements.error)}</div>
            )}
            {achievements.data !== null && achievements.data.awards.length === 0 ? (
              <div className="text-sm text-muted-foreground">
                No deterministic achievements have been awarded yet.
              </div>
            ) : null}
            <ol className="space-y-2" aria-label="Civilization achievements">
              {achievements.data?.awards.map((award) => (
                <AchievementAward key={award.awardId} award={award} onViewLineage={onViewLineage} />
              ))}
            </ol>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={achievementCursorStack.length === 0}
                onClick={previousAchievementPage}
              >
                Previous awards
              </Button>
              <Button
                size="sm"
                variant="outline"
                disabled={achievementNextCursor === null}
                onClick={nextAchievementPage}
              >
                Next awards
              </Button>
              <Button size="sm" variant="ghost" onClick={() => achievements.refresh()}>
                Refresh awards
              </Button>
            </div>
          </div>
        }
      />
      <SettingsRow
        title="Deterministic history"
        description="Typed, provenance-bearing Civilization facts only. No transcript summarization or model-generated lore."
        control={
          <Select
            value={kind ?? "all"}
            onValueChange={(value) => {
              setKind(value === "all" ? undefined : (value as CivilizationChronicleKind));
              resetPaging();
            }}
          >
            <SelectTrigger aria-label="Chronicle event kind" className="w-48">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All events</SelectItem>
              {KINDS.map((value) => (
                <SelectItem key={value} value={value}>
                  {label(value)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        }
      />
      <SettingsRow
        title="Filter history"
        description="Optional citizen and time bounds. Chronicle reads metadata only."
        control={
          <div className="flex max-w-xl flex-wrap items-end gap-2">
            <Input
              aria-label="Chronicle citizen thread"
              placeholder="Thread ID"
              value={threadDraft}
              onChange={(event) => setThreadDraft(event.currentTarget.value)}
            />
            <Input
              aria-label="Chronicle from time"
              type="datetime-local"
              value={fromDraft}
              onChange={(event) => setFromDraft(event.currentTarget.value)}
            />
            <Input
              aria-label="Chronicle to time"
              type="datetime-local"
              value={toDraft}
              onChange={(event) => setToDraft(event.currentTarget.value)}
            />
            <Button size="sm" variant="outline" onClick={applyFilters}>
              Apply
            </Button>
          </div>
        }
      />
      <div className="space-y-3 px-3 sm:px-4">
        {page.isPending && page.data === null ? (
          <div className="text-sm text-muted-foreground">Loading Chronicle…</div>
        ) : null}
        {page.error === null ? null : (
          <div className="text-sm text-destructive">{String(page.error)}</div>
        )}
        {page.data !== null && page.data.entries.length === 0 ? (
          <div className="rounded-lg border border-border/70 p-3 text-sm text-muted-foreground">
            No Chronicle entries match this view yet. v1.1 does not fabricate pre-migration history.
          </div>
        ) : null}
        <ol className="space-y-2" aria-label="Civilization Chronicle entries">
          {page.data?.entries.map((entry) => (
            <ChronicleEntry key={entry.entryId} entry={entry} onViewLineage={onViewLineage} />
          ))}
        </ol>
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            disabled={cursorStack.length === 0}
            onClick={previousPage}
          >
            Previous events
          </Button>
          <Button size="sm" variant="outline" disabled={nextCursor === null} onClick={nextPage}>
            Next events
          </Button>
          <Button size="sm" variant="ghost" onClick={() => page.refresh()}>
            Refresh
          </Button>
          {page.data === null ? null : (
            <span className="text-xs text-muted-foreground">
              chronicle rev {page.data.revision}
            </span>
          )}
        </div>
      </div>
    </SettingsSection>
  );
}
