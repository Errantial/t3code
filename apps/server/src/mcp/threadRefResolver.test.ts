import { expect, it } from "@effect/vitest";
import { ThreadId, type OrchestrationV2ThreadShell } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { resolveThreadShell, type ThreadLookup } from "./threadRefResolver.ts";

const shell = (id: string, deleted = false): OrchestrationV2ThreadShell =>
  ({
    id: ThreadId.make(id),
    projectId: "project",
    deletedAt: deleted ? "2026-10-05T00:00:00Z" : null,
  }) as unknown as OrchestrationV2ThreadShell;

const lookup = (
  active: ReadonlyArray<OrchestrationV2ThreadShell>,
  archived: ReadonlyArray<OrchestrationV2ThreadShell> = [],
): ThreadLookup => ({
  getThreadShell: (id) =>
    Effect.succeed([...active, ...archived].find((thread) => thread.id === id) ?? null),
  getShellSnapshot: (options) =>
    Effect.succeed({
      schemaVersion: 1,
      snapshotSequence: 0,
      threads: options?.location === "archive" ? [] : [...active],
      archivedThreads: options?.location === "archive" ? [...archived] : [],
    } as never),
});

it.effect("resolves an exact id", () =>
  Effect.gen(function* () {
    const result = yield* resolveThreadShell(
      lookup([shell("thread-1")]),
      ThreadId.make("thread-1"),
    );
    expect(result.resolvedFrom).toBe("exact");
    expect(result.shell.id).toBe("thread-1");
  }),
);

it.effect("resolves a bare uuid to its mcp: thread", () =>
  Effect.gen(function* () {
    const result = yield* resolveThreadShell(
      lookup([shell("mcp:5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04")]),
      ThreadId.make("5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04"),
    );
    expect(result.resolvedFrom).toBe("alias");
    expect(result.shell.id).toBe("mcp:5d0b4a3e-8c1f-4a52-9d37-2f6c7e1b9a04");
  }),
);

it.effect("resolves a unique 8-character prefix, including archived threads", () =>
  Effect.gen(function* () {
    const result = yield* resolveThreadShell(
      lookup([], [shell("abcdef12-1111-2222-3333-444455556666")]),
      ThreadId.make("abcdef12"),
    );
    expect(result.resolvedFrom).toBe("prefix");
    expect(result.shell.id).toBe("abcdef12-1111-2222-3333-444455556666");
  }),
);

it.effect("refuses an ambiguous prefix without picking one", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveThreadShell(
        lookup([
          shell("abcdef12-1111-2222-3333-444455556666"),
          shell("abcdef12-aaaa-bbbb-cccc-ddddeeeeffff"),
        ]),
        ThreadId.make("abcdef12"),
      ),
    );
    expect(error.code).toBe("thread_id_ambiguous");
    expect(error.message).toContain("abcdef12-1111");
    expect(error.message).toContain("abcdef12-aaaa");
  }),
);

it.effect("refuses a prefix on a mutating call", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveThreadShell(
        lookup([shell("abcdef12-1111-2222-3333-444455556666")]),
        ThreadId.make("abcdef12"),
        "mutate",
      ),
    );
    expect(error.code).toBe("thread_id_prefix_not_allowed");
    expect(error.message).toContain("abcdef12-1111-2222-3333-444455556666");
  }),
);

it.effect("rejects a prefix shorter than 8 characters", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveThreadShell(lookup([shell("abcdef1-1111")]), ThreadId.make("abcdef1")),
    );
    expect(error.code).toBe("invalid_request");
  }),
);

it.effect("does not resolve a deleted thread", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      resolveThreadShell(lookup([shell("thread-1", true)]), ThreadId.make("thread-1")),
    );
    expect(error.code).toBe("thread_not_found");
  }),
);
