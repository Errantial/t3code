import { expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveThreadProjectionId } from "./ws.ts";

const canonical = ThreadId.make("abcdef12-1111-2222-3333-444455556666");
const shell = {
  id: canonical,
  deletedAt: null,
} as unknown as OrchestrationV2ThreadShell;

const threads = {
  getThreadShell: (id: ThreadId) => Effect.succeed(id === canonical ? shell : null),
  getShellSnapshot: (options?: { readonly location?: "active" | "archive" }) =>
    Effect.succeed({
      schemaVersion: 1,
      snapshotSequence: 0,
      threads: options?.location === "archive" ? [] : [shell],
      archivedThreads: [],
    } as never),
};

it.effect("resolves a WS projection prefix to the canonical thread id", () =>
  Effect.gen(function* () {
    expect(yield* resolveThreadProjectionId(threads, ThreadId.make("abcdef12"))).toBe(canonical);
  }),
);

it.effect("keeps an exact WS thread id unchanged", () =>
  Effect.gen(function* () {
    expect(yield* resolveThreadProjectionId(threads, canonical)).toBe(canonical);
  }),
);
