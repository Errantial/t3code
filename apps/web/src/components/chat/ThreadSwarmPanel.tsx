import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import {
  AuthOrchestrationOperateScope,
  type EnvironmentId,
  type SwarmActInput,
  type SwarmMemberView,
  type SwarmThreadView,
  type ThreadId,
} from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useEffect, useState } from "react";

import { cn } from "../../lib/utils";
import { useQuietThreadShell } from "../../state/entities";
import { readEnvironmentScope } from "../../state/session";
import { swarmActCommand, swarmListForThreadCommand } from "../../state/swarm";
import { swarmSummaryAtom, swarmSummaryKey } from "../../state/swarmSummaries";
import { useAtomCommand } from "../../state/use-atom-command";
import { buildThreadRouteParams } from "../../threadRoutes";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { swarmV2EnabledAtom } from "./swarmAvailability";
import { confirmSwarmAction } from "./swarmConfirm";
import { ThreadDetailsSection } from "./ThreadDetailsSection";
import {
  filterSwarmMembers,
  groupSwarmMembersByInstance,
  sortSwarmMembers,
  swarmBudgetLabel,
  swarmElapsedLabel,
  swarmInstanceBadge,
  swarmMemberFlags,
  swarmMemberStatusLabel,
  swarmPanelRetryDelay,
  swarmPanelShouldRetry,
  swarmPanelShouldPoll,
  swarmQueueReasonLabel,
  type SwarmStatusFilter,
  swarmStopAllMessage,
  swarmSummaryCounts,
  swarmSummaryParts,
  swarmVerifyLabel,
} from "./threadSwarmPanel.logic";

const POLL_MS = 3_000;
/** How often the panel looks for a new swarm while its architect thread has a live run. */
const ARCHITECT_RUN_POLL_MS = 10_000;

const STATUS_FILTERS: ReadonlyArray<{ readonly id: SwarmStatusFilter; readonly label: string }> = [
  { id: "all", label: "All" },
  { id: "failed", label: "Failed" },
  { id: "attention", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "queued", label: "Queued" },
  { id: "done", label: "Done" },
];

function failureMessage(value: unknown): string {
  if (typeof value === "string") return value;
  if (value instanceof Error) return value.message;
  return String(value);
}

/**
 * Swarm v2 (SW-A10): the architect thread's swarms, polled every 3 s while one is active. Shown
 * only while the environment's Swarm v2 Labs setting is on; nothing renders for a thread
 * without swarms.
 */
export function ThreadSwarmPanel(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const enabled = useAtomValue(swarmV2EnabledAtom(props.environmentId));
  // While the architect runs it may start a swarm: poll faster, and reload when the run ends.
  const architectRunning =
    useQuietThreadShell({ environmentId: props.environmentId, threadId: props.threadId })
      ?.activeRunId != null;
  // The sidebar's poll sees a swarm that starts while this panel is open; reload then.
  const hasActiveSwarm =
    useAtomValue(swarmSummaryAtom(swarmSummaryKey(props.environmentId, props.threadId))) !==
    undefined;
  const listCommand = useAtomCommand(swarmListForThreadCommand, { reportFailure: false });
  const actCommand = useAtomCommand(swarmActCommand, { reportFailure: false });
  const navigate = useNavigate();
  const [views, setViews] = useState<ReadonlyArray<SwarmThreadView>>([]);
  const [refreshToken, setRefreshToken] = useState(0);
  const [busy, setBusy] = useState(false);
  // Read with each poll, so elapsed times advance without reading the clock during render.
  const [nowMs, setNowMs] = useState(0);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- swarm state is an RPC per thread; there is no atom for it, and it is polled while a swarm is active.
  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let failures = 0;
    const load = async () => {
      // oxlint-disable-next-line react/exhaustive-effect-dependencies -- the command is stable; the thread and refresh token select what to load.
      const result = await listCommand({
        environmentId: props.environmentId,
        threadId: props.threadId,
      });
      if (cancelled) return;
      if (result._tag !== "Success") {
        // A page opened on the thread asks before its environment connects; try again, backing
        // off. A permanent refusal (Swarm v2 off, not this thread's swarm) is not retried.
        if (!swarmPanelShouldRetry(squashAtomCommandFailure(result))) return;
        failures += 1;
        timer = setTimeout(() => void load(), swarmPanelRetryDelay(failures));
        return;
      }
      failures = 0;
      const next = result.value.swarms;
      setViews(next);
      setNowMs(Date.now());
      if (swarmPanelShouldPoll(next)) timer = setTimeout(() => void load(), POLL_MS);
      else if (architectRunning) timer = setTimeout(() => void load(), ARCHITECT_RUN_POLL_MS);
    };
    void load();
    return () => {
      cancelled = true;
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [
    enabled,
    props.environmentId,
    props.threadId,
    refreshToken,
    hasActiveSwarm,
    architectRunning,
  ]);

  if (!enabled || views.length === 0) return null;
  const canOperate = readEnvironmentScope(props.environmentId, AuthOrchestrationOperateScope);

  const act = async (input: SwarmActInput, confirmMessage?: string) => {
    if (busy || !canOperate) return;
    if (confirmMessage !== undefined) {
      if (!(await confirmSwarmAction(confirmMessage))) return;
    }
    setBusy(true);
    const result = await actCommand({ environmentId: props.environmentId, input });
    setBusy(false);
    if (result._tag === "Failure") {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Swarm action failed",
          description: failureMessage(squashAtomCommandFailure(result)),
        }),
      );
    } else if (result.value.notDone.length > 0) {
      toastManager.add(
        stackedThreadToast({
          type: "warning",
          title: "Some members were not changed",
          description: result.value.notDone
            .map((entry) => `${entry.key}: ${entry.message}`)
            .join("\n"),
        }),
      );
    }
    setRefreshToken((token) => token + 1);
  };

  const openThread = (threadId: ThreadId) => {
    void navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(scopeThreadRef(props.environmentId, threadId)),
    });
  };

  return (
    <>
      {views.map((view) => (
        <SwarmSection
          key={view.swarmId}
          view={view}
          threadId={props.threadId}
          canOperate={canOperate && !busy}
          nowMs={nowMs}
          onAct={act}
          onOpenThread={openThread}
        />
      ))}
    </>
  );
}

function SwarmSection(props: {
  readonly view: SwarmThreadView;
  readonly threadId: ThreadId;
  readonly canOperate: boolean;
  readonly nowMs: number;
  readonly onAct: (input: SwarmActInput, confirmMessage?: string) => Promise<void>;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const { view } = props;
  const [statusFilter, setStatusFilter] = useState<SwarmStatusFilter>("all");
  const [instanceFilter, setInstanceFilter] = useState<string | null>(null);
  const [groupByInstance, setGroupByInstance] = useState(false);
  const counts = swarmSummaryCounts(view.members);
  const budget = swarmBudgetLabel(view);
  const visible = sortSwarmMembers(
    filterSwarmMembers(view.members, { status: statusFilter, instanceId: instanceFilter }),
  );
  const groups = groupByInstance
    ? groupSwarmMembersByInstance(visible)
    : [{ instanceId: "", members: visible }];
  const live =
    view.status === "active" &&
    counts.running + counts.queued + counts.verifying + counts.limitWait > 0;

  return (
    <ThreadDetailsSection
      headingId={`thread-details-swarm-${view.swarmId}`}
      title={`Swarm: ${view.title}`}
      data-thread-swarm-panel
      actions={
        live ? (
          <Button
            size="xs"
            variant="ghost"
            disabled={!props.canOperate}
            onClick={() =>
              void props.onAct(
                { threadId: props.threadId, swarmId: view.swarmId, action: "stop_all" },
                swarmStopAllMessage(counts),
              )
            }
          >
            Stop all
          </Button>
        ) : null
      }
    >
      <div className="flex flex-col gap-2 text-xs">
        <div className="text-muted-foreground" data-swarm-summary>
          {[view.status === "active" ? null : view.status, ...swarmSummaryParts(counts), budget]
            .filter((part): part is string => part !== null)
            .join(" · ")}
        </div>
        {view.notices.length > 0 ? (
          <ul className="flex flex-col gap-1" data-swarm-notices>
            {view.notices.slice(-3).map((notice) => (
              <li key={`${notice.kind}:${notice.createdAt}`} className="text-muted-foreground">
                {notice.text}
              </li>
            ))}
          </ul>
        ) : null}
        {view.instances.length > 0 ? (
          <div className="flex flex-wrap gap-1" data-swarm-instances>
            {view.instances.map((instance) => (
              <button
                key={instance.id}
                type="button"
                className={cn(
                  "rounded border border-border/65 px-1.5 py-0.5",
                  instanceFilter === instance.id && "bg-accent",
                )}
                onClick={() =>
                  setInstanceFilter((current) => (current === instance.id ? null : instance.id))
                }
              >
                {instance.id} {swarmInstanceBadge(instance)}
              </button>
            ))}
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-1" data-swarm-filters>
          {STATUS_FILTERS.map((filter) => (
            <button
              key={filter.id}
              type="button"
              className={cn(
                "rounded px-1.5 py-0.5 text-muted-foreground",
                statusFilter === filter.id && "bg-accent text-foreground",
              )}
              onClick={() => setStatusFilter(filter.id)}
            >
              {filter.label}
            </button>
          ))}
          <label className="ml-auto flex items-center gap-1 text-muted-foreground">
            <input
              type="checkbox"
              checked={groupByInstance}
              onChange={(event) => setGroupByInstance(event.currentTarget.checked)}
            />
            By instance
          </label>
        </div>
        <div
          className="flex max-h-[min(50vh,28rem)] flex-col gap-2 overflow-y-auto"
          data-swarm-roster
        >
          {groups.map((group) => (
            <div key={group.instanceId} className="flex flex-col gap-1">
              {groupByInstance ? (
                <div className="font-medium text-muted-foreground">{group.instanceId}</div>
              ) : null}
              <ul className="flex flex-col gap-1">
                {group.members.map((member) => (
                  <SwarmMemberRow
                    key={member.key}
                    member={member}
                    nowMs={props.nowMs}
                    canOperate={props.canOperate && view.status !== "detached"}
                    onOpen={props.onOpenThread}
                    onStop={() =>
                      void props.onAct({
                        threadId: props.threadId,
                        swarmId: view.swarmId,
                        action: "stop",
                        keys: [member.key],
                      })
                    }
                    onRetry={() =>
                      void props.onAct({
                        threadId: props.threadId,
                        swarmId: view.swarmId,
                        action: "retry",
                        keys: [member.key],
                      })
                    }
                  />
                ))}
              </ul>
            </div>
          ))}
        </div>
      </div>
    </ThreadDetailsSection>
  );
}

const STOPPABLE: ReadonlySet<SwarmMemberView["status"]> = new Set([
  "queued",
  "launching",
  "running",
  "verifying",
  "limit_wait",
]);

function SwarmMemberRow(props: {
  readonly member: SwarmMemberView;
  readonly nowMs: number;
  readonly canOperate: boolean;
  readonly onOpen: (threadId: ThreadId) => void;
  readonly onStop: () => void;
  readonly onRetry: () => void;
}) {
  const { member } = props;
  const queueReason = swarmQueueReasonLabel(member.status === "queued" ? member.queueReason : null);
  const verify = swarmVerifyLabel(member);
  const elapsed = swarmElapsedLabel(member, props.nowMs);
  const flags = swarmMemberFlags(member);
  const details = [
    member.providerInstanceId === null ? "unplaced" : member.providerInstanceId,
    member.model,
    ...(elapsed === null ? [] : [elapsed]),
    ...(verify === null ? [] : [verify]),
    ...flags,
  ];
  return (
    <li
      className="flex flex-col gap-0.5 rounded border border-border/40 px-1.5 py-1"
      data-swarm-member={member.key}
    >
      <div className="flex items-center gap-1">
        <span className="min-w-0 flex-1 truncate font-medium">{member.title}</span>
        <span
          className={cn(
            "shrink-0",
            member.status === "failed" || member.waitingForApproval
              ? "text-destructive"
              : "text-muted-foreground",
          )}
        >
          {swarmMemberStatusLabel(member)}
        </span>
      </div>
      <div className="truncate text-muted-foreground">{details.join(" · ")}</div>
      {queueReason !== null ? <div className="text-muted-foreground">{queueReason}</div> : null}
      {member.summary !== undefined ? (
        <div className="line-clamp-2 text-muted-foreground">{member.summary}</div>
      ) : null}
      <div className="flex gap-1">
        {member.childThreadId !== null ? (
          <Button size="xs" variant="ghost" onClick={() => props.onOpen(member.childThreadId!)}>
            Open
          </Button>
        ) : null}
        {STOPPABLE.has(member.status) ? (
          <Button size="xs" variant="ghost" disabled={!props.canOperate} onClick={props.onStop}>
            Stop
          </Button>
        ) : null}
        {member.status === "failed" || member.status === "cancelled" ? (
          <Button size="xs" variant="ghost" disabled={!props.canOperate} onClick={props.onRetry}>
            Retry
          </Button>
        ) : null}
      </div>
    </li>
  );
}
