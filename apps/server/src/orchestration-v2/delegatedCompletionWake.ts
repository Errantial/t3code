import type { OrchestrationV2Subagent } from "@t3tools/contracts";

/** The whole wake's budget for labels and details; tasks past it arrive as pointers. */
export const DELEGATED_RESULT_INLINE_BYTES = 16_000;

/** Titles in a released task's label are cut to this many characters (rev 3.1). */
const RELEASED_TITLE_MAX_CHARACTERS = 64;

type WakeTask = Pick<OrchestrationV2Subagent, "title" | "status" | "result" | "completionDetail">;

const wakeLabel = (taskId: string, task: WakeTask | undefined): string => {
  const title =
    task?.title == null
      ? null
      : task.completionDetail === undefined
        ? task.title
        : task.title.slice(0, RELEASED_TITLE_MAX_CHARACTERS);
  return `Delegated task ${taskId}${title === null ? "" : ` (${title})`}${task === undefined ? " reached a terminal state" : ` [${task.status}]`}`;
};

/** A released task's detail replaces its raw result in the wake. */
const wakeDetail = (task: WakeTask | undefined): string | null =>
  task?.completionDetail ?? task?.result ?? null;

/** The inline entry for one task, exactly as a wake renders it when it fits. */
export const delegatedCompletionWakeEntry = (
  taskId: string,
  task: WakeTask | undefined,
): string | undefined => {
  const detail = wakeDetail(task);
  return detail === null ? undefined : `${wakeLabel(taskId, task)}:\n${detail}`;
};

/** The bytes one task's inline entry takes from the wake budget; swarm release measures with it. */
export const delegatedCompletionWakeEntryBytes = (taskId: string, task: WakeTask): number =>
  Buffer.byteLength(delegatedCompletionWakeEntry(taskId, task) ?? "");

/** One wake's text: entries that fit the shared budget inline, the rest as pointers. */
export function delegatedCompletionWakeDetail(
  taskIds: ReadonlyArray<string>,
  tasks: ReadonlyArray<OrchestrationV2Subagent>,
): string {
  let remainingBytes = DELEGATED_RESULT_INLINE_BYTES;
  return taskIds
    .map((taskId) => {
      const task = tasks.find((candidate) => candidate.id === taskId);
      const entry = delegatedCompletionWakeEntry(taskId, task);
      if (entry !== undefined) {
        const bytes = Buffer.byteLength(entry);
        if (bytes <= remainingBytes) {
          remainingBytes -= bytes;
          return entry;
        }
      }
      return `${wakeLabel(taskId, task)}. Use task_status with taskId ${taskId} to read the result.`;
    })
    .join("\n\n");
}
