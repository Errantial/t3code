import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { ScopedThreadRef } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useCallback, useMemo } from "react";

import { useLocalStorage } from "../../hooks/useLocalStorage";

const STORAGE_KEY = "t3code:thread-token-rate:v1";
// Off by default, so only enabled threads are stored. The cap keeps the entry
// bounded for users who toggle it across many threads over time.
const MAX_ENABLED_THREADS = 500;

const EnabledThreadsSchema = Schema.Array(Schema.String);
const NO_THREADS: ReadonlyArray<string> = [];

export function toggleThreadInList(
  enabledThreads: ReadonlyArray<string>,
  threadKey: string,
  enabled: boolean,
): ReadonlyArray<string> {
  const rest = enabledThreads.filter((key) => key !== threadKey);
  return enabled ? [...rest, threadKey].slice(-MAX_ENABLED_THREADS) : rest;
}

/** Per-thread opt-in for the tokens/sec readout, persisted on this client. */
export function useThreadTokenRatePreference(threadRef: ScopedThreadRef | null) {
  const [enabledThreads, setEnabledThreads] = useLocalStorage(
    STORAGE_KEY,
    NO_THREADS,
    EnabledThreadsSchema,
  );
  const threadKey = useMemo(() => (threadRef ? scopedThreadKey(threadRef) : null), [threadRef]);
  const enabled = threadKey !== null && enabledThreads.includes(threadKey);
  const setEnabled = useCallback(
    (next: boolean) => {
      if (threadKey === null) return;
      setEnabledThreads((current) => toggleThreadInList(current, threadKey, next));
    },
    [setEnabledThreads, threadKey],
  );
  return { enabled, setEnabled };
}
