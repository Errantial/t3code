import {
  type CivilizationCitizenSummary,
  type CivilizationLineageCursor,
  type EnvironmentId,
  type ProjectId,
  type ThreadId,
} from "@t3tools/contracts";
import { useState } from "react";

import { useCivilizationLineageNeighborhood } from "../../state/civilization";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";

interface CivilizationLineageExplorerProps {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  readonly initialThreadId: ThreadId;
  readonly pageSize: number;
  readonly onClose: () => void;
}

function CitizenLineageButton({
  citizen,
  relation,
  onFocus,
}: {
  readonly citizen: CivilizationCitizenSummary;
  readonly relation: string;
  readonly onFocus: (threadId: ThreadId) => void;
}) {
  return (
    <Button
      size="sm-multiline"
      variant="outline"
      className="w-full justify-start text-left"
      aria-label={`${relation}: ${citizen.name}`}
      onClick={() => onFocus(citizen.threadId)}
    >
      <span className="min-w-0">
        <span className="block font-medium">{citizen.name}</span>
        <span className="block wrap-anywhere text-xs text-muted-foreground">
          generation {citizen.generation} · {citizen.closed ? "closed" : "active"}
          {citizen.observedOnly ? " · provider-owned" : ""}
        </span>
      </span>
    </Button>
  );
}

function parentUnavailableCopy(value: string): string {
  switch (value) {
    case "cross_project":
      return "Parent belongs to another project and is not exposed here.";
    case "cycle":
      return "Lineage contains a cycle; no parent is inferred.";
    case "depth_limit":
      return "Lineage exceeded the bounded ancestry depth; no parent is inferred.";
    case "unavailable":
      return "Parent is unavailable under the current census visibility.";
    default:
      return "No parent.";
  }
}

export function CivilizationLineageExplorer({
  environmentId,
  projectId,
  initialThreadId,
  pageSize,
  onClose,
}: CivilizationLineageExplorerProps) {
  const [focusThreadId, setFocusThreadId] = useState<ThreadId>(initialThreadId);
  const [cursor, setCursor] = useState<CivilizationLineageCursor | null>(null);
  const [cursorStack, setCursorStack] = useState<Array<CivilizationLineageCursor | null>>([]);
  const lineage = useCivilizationLineageNeighborhood(
    environmentId,
    projectId,
    focusThreadId,
    cursor,
    pageSize,
  );

  const focus = (threadId: ThreadId) => {
    setFocusThreadId(threadId);
    setCursor(null);
    setCursorStack([]);
  };
  const nextCursor = lineage.data?.nextCursor ?? null;
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

  return (
    <SettingsSection title="Ancestral Hall" id="civilization-lineage">
      <SettingsRow
        title="Bounded lineage neighborhood"
        description="One citizen, one visible parent, and one page of direct children. Navigation never loads the whole civilization."
        control={
          <Button size="sm" variant="outline" onClick={onClose}>
            Close Hall
          </Button>
        }
      />
      <div className="space-y-4 px-3 sm:px-4">
        {lineage.isPending && lineage.data === null ? (
          <div className="text-sm text-muted-foreground">Loading lineage…</div>
        ) : null}
        {lineage.error === null ? null : (
          <div className="text-sm text-destructive">{String(lineage.error)}</div>
        )}
        {lineage.data === null ? null : (
          <>
            <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)]">
              <div className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Parent
                </div>
                {lineage.data.parent === null ? (
                  <div className="rounded-lg border border-border/70 p-3 text-sm text-muted-foreground">
                    {parentUnavailableCopy(lineage.data.parentAvailability)}
                  </div>
                ) : (
                  <CitizenLineageButton
                    citizen={lineage.data.parent}
                    relation="Parent"
                    onFocus={focus}
                  />
                )}
              </div>
              <div className="rounded-lg border border-border p-3">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Focus citizen
                </div>
                <div className="mt-1 text-base font-semibold">{lineage.data.focus.name}</div>
                <div className="wrap-anywhere text-xs text-muted-foreground">
                  generation {lineage.data.focus.generation} · {lineage.data.focus.lineageStatus} ·
                  rev {lineage.data.focus.revision}
                </div>
                <div className="mt-1 wrap-anywhere text-xs text-muted-foreground">
                  {lineage.data.focus.parentThreadId === null
                    ? "Root citizen"
                    : `${lineage.data.focus.relationshipToParent ?? "child"} of ${lineage.data.focus.parentThreadId}`}
                </div>
              </div>
            </div>

            <div className="space-y-2" role="tree" aria-label="Direct descendants">
              <div className="flex items-center justify-between gap-2">
                <div className="text-sm font-medium">Direct descendants</div>
                <div className="text-xs text-muted-foreground">
                  census rev {lineage.data.revision}
                </div>
              </div>
              {lineage.data.children.length === 0 ? (
                <div className="rounded-lg border border-border/70 p-3 text-sm text-muted-foreground">
                  No visible direct descendants on this page.
                </div>
              ) : (
                lineage.data.children.map((child) => (
                  <div role="treeitem" key={child.threadId}>
                    <CitizenLineageButton
                      citizen={child}
                      relation={child.relationshipToParent ?? "Child"}
                      onFocus={focus}
                    />
                  </div>
                ))
              )}
              <div className="flex flex-wrap gap-2">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={cursorStack.length === 0}
                  onClick={previousPage}
                >
                  Previous children
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={nextCursor === null}
                  onClick={nextPage}
                >
                  Next children
                </Button>
                <Button size="sm" variant="ghost" onClick={() => lineage.refresh()}>
                  Refresh
                </Button>
              </div>
            </div>
          </>
        )}
      </div>
    </SettingsSection>
  );
}
