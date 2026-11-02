import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import type * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

export type ThreadRefMode = "read" | "mutate";
export type ThreadRefResolution = {
  readonly shell: OrchestrationV2ThreadShell;
  readonly resolvedFrom: "exact" | "alias" | "prefix";
};

export type ThreadLookup = Pick<
  ThreadManagement.ThreadManagementService["Service"],
  "getThreadShell" | "getShellSnapshot"
>;

const PREFIX = /^(?:mcp:)?([0-9a-f-]{8,35})$/i;
const SHORT_PREFIX = /^(?:mcp:)?[0-9a-f-]{1,7}$/i;

type FailureCode =
  | "thread_not_found"
  | "thread_id_ambiguous"
  | "thread_id_prefix_not_allowed"
  | "invalid_request"
  | "orchestration_error";

const fail = (code: FailureCode, message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code, message }));

const exact = (threads: ThreadLookup, id: ThreadId, alias: boolean) =>
  threads.getThreadShell(id).pipe(
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The thread lookup could not be completed.",
        }),
    ),
    Effect.flatMap((shell) =>
      shell === null || shell.deletedAt !== null
        ? Effect.fail(new OrchestratorMcpFailure({ code: "thread_not_found", message: "" }))
        : Effect.succeed<ThreadRefResolution>({
            shell,
            resolvedFrom: alias ? "alias" : "exact",
          }),
    ),
  );

const aliasFor = (id: string): ThreadId | null => {
  if (id.startsWith("mcp:")) {
    const bare = id.slice(4);
    return bare.length > 0 ? (bare as ThreadId) : null;
  }
  return `mcp:${id}` as ThreadId;
};

const snapshot = (threads: ThreadLookup) =>
  Effect.all(
    [
      threads.getShellSnapshot({ location: "active" }),
      threads.getShellSnapshot({ location: "archive" }),
    ],
    { concurrency: "unbounded" },
  ).pipe(
    Effect.map(([active, archived]) => [...active.threads, ...archived.archivedThreads]),
    Effect.mapError(
      () =>
        new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The thread lookup could not be completed.",
        }),
    ),
  );

const prefixMatches = (
  threads: ReadonlyArray<OrchestrationV2ThreadShell>,
  body: string,
): ReadonlyArray<OrchestrationV2ThreadShell> => {
  const wanted = [body.toLowerCase(), `mcp:${body.toLowerCase()}`];
  const seen = new Set<string>();
  return threads.filter((thread) => {
    if (thread.deletedAt !== null || seen.has(thread.id)) return false;
    const id = thread.id.toLowerCase();
    if (!wanted.some((prefix) => id.startsWith(prefix))) return false;
    seen.add(thread.id);
    return true;
  });
};

const listIds = (matches: ReadonlyArray<OrchestrationV2ThreadShell>) =>
  matches
    .slice(0, 5)
    .map((thread) => thread.id)
    .join(", ");

export const resolveThreadShell = Effect.fn("mcp.resolveThreadShell")(function* (
  threads: ThreadLookup,
  input: ThreadId,
  mode: ThreadRefMode = "read",
) {
  const raw = input as string;
  const direct = yield* exact(threads, input, false).pipe(
    Effect.catchTags({
      OrchestratorMcpFailure: (error) =>
        error.code === "thread_not_found" ? Effect.succeed(null) : Effect.fail(error),
    }),
  );
  if (direct !== null) return direct;

  const alias = aliasFor(raw);
  if (alias !== null) {
    const aliased = yield* exact(threads, alias, true).pipe(
      Effect.catchTags({
        OrchestratorMcpFailure: (error) =>
          error.code === "thread_not_found" ? Effect.succeed(null) : Effect.fail(error),
      }),
    );
    if (aliased !== null) return aliased;
  }

  const match = PREFIX.exec(raw);
  if (match === null) {
    if (SHORT_PREFIX.test(raw)) {
      return yield* fail("invalid_request", "Use at least 8 characters of the thread id.");
    }
    return yield* fail(
      "thread_not_found",
      "The thread was not found. Use t3_thread_search to find it by text.",
    );
  }
  const body = match[1] ?? "";
  if (body.length === 0) {
    return yield* fail("invalid_request", "Use at least 8 characters of the thread id.");
  }
  const candidates = prefixMatches(yield* snapshot(threads), body);
  if (candidates.length === 0) {
    return yield* fail("thread_not_found", "No thread matches that id prefix.");
  }
  if (candidates.length > 1) {
    return yield* fail(
      "thread_id_ambiguous",
      `The id prefix matches ${candidates.length} threads: ${listIds(candidates)}. Use the full id.`,
    );
  }
  const shell = candidates[0]!;
  if (mode === "mutate") {
    return yield* fail(
      "thread_id_prefix_not_allowed",
      `Pass the full thread id for a change: ${shell.id}.`,
    );
  }
  return { shell, resolvedFrom: "prefix" } satisfies ThreadRefResolution;
});
