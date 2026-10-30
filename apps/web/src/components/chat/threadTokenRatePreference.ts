import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { useLocalStorage } from "../../hooks/useLocalStorage";

// On by default, so the stored list is the threads that turned the readout off.
// v2 is deliberate: the v1 key held the opposite set, and reading it under the new
// meaning would hide the readout for exactly the people who had enabled it.
const STORAGE_KEY = "t3code:thread-token-rate:v2";
const MAX_DISABLED_THREADS = 500;

const DisabledThreadsSchema = Schema.Array(Schema.String);
const NO_THREADS: ReadonlyArray<string> = [];

export function toggleThreadInList(
  threads: ReadonlyArray<string>,
  threadKey: string,
  listed: boolean,
): ReadonlyArray<string> {
  const rest = threads.filter((key) => key !== threadKey);
  return listed ? [...rest, threadKey].slice(-MAX_DISABLED_THREADS) : rest;
}

/** The readout is on unless this thread is in the stored off-list. */
export function isThreadTokenRateEnabled(
  disabledThreads: ReadonlyArray<string>,
  threadKey: string | null,
): boolean {
  return threadKey !== null && !disabledThreads.includes(threadKey);
}

/** Per-thread opt-out for the tokens/sec readout, persisted on this client. */
export function useThreadTokenRatePreference(threadRef: ScopedThreadRef | null) {
  const [disabledThreads, setDisabledThreads] = useLocalStorage(
    STORAGE_KEY,
    NO_THREADS,
    DisabledThreadsSchema,
  );
  const threadKey = threadRef ? scopedThreadKey(threadRef) : null;
  const enabled = isThreadTokenRateEnabled(disabledThreads, threadKey);
  const setEnabled = (next: boolean) => {
    if (threadKey === null) return;
    setDisabledThreads((current) => toggleThreadInList(current, threadKey, !next));
  };
  return { enabled, setEnabled };
}
