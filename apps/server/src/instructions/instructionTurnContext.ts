import * as Effect from "effect/Effect";

import type {
  TurnContextContributor,
  TurnContextEntry,
} from "@t3tools/provider-core/server/turnContext";

import type { InstructionFile, InstructionStore } from "./InstructionStore.ts";

const ROLE_FILES_MAX_BYTES = 32 * 1024;

export interface InstructionTurn {
  readonly threadId: string;
}

function formatRoleFiles(files: ReadonlyArray<InstructionFile>): string {
  return [
    "<t3_instruction_files>",
    ...files.flatMap((file) => [
      `## ${file.title} (${file.id}, revision ${file.revision})`,
      file.content.trimEnd(),
      "",
    ]),
    "</t3_instruction_files>",
  ].join("\n");
}

/**
 * Per-thread optional role/context files are the first registered contributor.
 * The fleet prompt block can register through the same API later.
 */
export function makeInstructionTurnContextContributor(
  store: InstructionStore,
): TurnContextContributor<InstructionTurn> {
  return {
    key: "instruction_files",
    trust: "trusted",
    priority: 100,
    maxBytes: ROLE_FILES_MAX_BYTES,
    build: (turn): Effect.Effect<TurnContextEntry | undefined> =>
      Effect.sync(() => {
        const files = store.threadInstructionFiles(turn.threadId);
        if (files.length === 0) return undefined;
        return {
          key: "instruction_files",
          trust: "trusted",
          text: formatRoleFiles(files),
        };
      }),
  };
}
