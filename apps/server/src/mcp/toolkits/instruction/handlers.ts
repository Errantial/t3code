import {
  OrchestratorMcpFailure,
  type OrchestrationV2Command,
  type OrchestrationV2Run,
  type OrchestrationV2RuntimeRequest,
  ProjectId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";

import * as ServerConfig from "../../../config.ts";
import { InstructionStore } from "../../../instructions/InstructionStore.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import { dispatchFailure, newCommandId, readThread } from "../../threadAccess.ts";
import { InstructionToolkit } from "./tools.ts";

const makeStore = Effect.fn("instruction.makeStore")(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const path = yield* Path.Path;
  return new InstructionStore(path.join(config.baseDir, "instructions"));
});

const failure = (cause: unknown) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: cause instanceof Error ? cause.message : String(cause),
  });

// oxlint-disable-next-line t3code/prefer-effect-fn -- generic store runner; Effect.fn erases the return type parameter
const runStore = <A>(
  operation: (store: InstructionStore) => A,
): Effect.Effect<A, OrchestratorMcpFailure, ServerConfig.ServerConfig | Path.Path> =>
  Effect.gen(function* () {
    const store = yield* makeStore();
    return yield* Effect.try({ try: () => operation(store), catch: failure });
  });

const forwarding = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  return { scope, service: yield* PeerForwarding.PeerForwarding };
});

type DigestAttention =
  | "needs-approval"
  | "needs-input"
  | "plan-ready"
  | "working"
  | "error"
  | "done"
  | "idle";

function digestAttention(
  runs: ReadonlyArray<OrchestrationV2Run>,
  pending: ReadonlyArray<OrchestrationV2RuntimeRequest>,
): DigestAttention {
  if (pending.some((request) => request.kind === "permission")) return "needs-approval";
  if (pending.length > 0) return "needs-input";
  const status = runs.at(-1)?.status;
  if (status === "failed") return "error";
  if (status === "running" || status === "starting" || status === "preparing") return "working";
  if (status === "completed") return "done";
  return "idle";
}

function speakAttention(attention: DigestAttention): string {
  switch (attention) {
    case "needs-approval":
      return "waiting for approval";
    case "needs-input":
      return "waiting for your answer";
    case "plan-ready":
      return "ready with a plan";
    case "working":
      return "still working";
    case "error":
      return "in error";
    case "done":
      return "finished";
    default:
      return "idle";
  }
}

function speakStatus(status: string): string {
  switch (status) {
    case "failed":
      return "hit an error";
    case "waiting":
      return "is waiting for you";
    case "running":
    case "starting":
    case "preparing":
      return "is working";
    case "completed":
      return "finished";
    default:
      return "is idle";
  }
}

function stripForVoice(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`]*`/g, " ")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/[#>*_~]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const handlers = {
  list_instruction_files: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.list_instruction_files,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        files: store
          .snapshot()
          .files.filter(
            (file) =>
              (input.kind === undefined || file.kind === input.kind) &&
              (input.scope === undefined || file.scope === input.scope) &&
              (input.projectId === undefined || file.projectId === input.projectId),
          ),
      }));
    }),
  ),
  get_instruction_file: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.get_instruction_file,
          remote,
          input,
        );
      }
      return yield* runStore((store) => {
        const file = store.snapshot().files.find((candidate) => candidate.id === input.id);
        if (file === undefined) throw new Error(`Instruction file ${input.id} does not exist.`);
        return { file };
      });
    }),
  ),
  put_instruction_file: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.put_instruction_file,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        file: store.putFile({
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.kind === undefined ? {} : { kind: input.kind }),
          ...(input.scope === undefined ? {} : { scope: input.scope }),
          ...(input.projectId === undefined ? {} : { projectId: input.projectId }),
          title: input.title,
          ...(input.filename === undefined ? {} : { filename: input.filename }),
          content: input.content,
          ...(input.expectedRevision === undefined
            ? {}
            : { expectedRevision: input.expectedRevision }),
        }),
      }));
    }),
  ),
  list_instruction_syncs: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.list_instruction_syncs,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        syncs: store
          .snapshot()
          .syncs.filter((sync) => input.fileId === undefined || sync.fileId === input.fileId),
      }));
    }),
  ),
  set_instruction_sync: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.set_instruction_sync,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        sync: store.setSync({
          ...(input.id === undefined ? {} : { id: input.id }),
          fileId: input.fileId,
          targets: input.targets.map((target) => ({
            provider: target.provider,
            scope: target.scope,
            ...(target.projectId === undefined ? {} : { projectId: target.projectId }),
            ...(target.environmentId === undefined ? {} : { environmentId: target.environmentId }),
            ...(target.workspaceRoot === undefined ? {} : { workspaceRoot: target.workspaceRoot }),
            ...(target.path === undefined ? {} : { path: target.path }),
            ...(target.filename === undefined ? {} : { filename: target.filename }),
          })),
        }),
      }));
    }),
  ),
  remove_instruction_sync: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.remove_instruction_sync,
          remote,
          input,
        );
      }
      return yield* runStore((store) => {
        store.removeSync(input.id);
        return { removed: true };
      });
    }),
  ),
  list_optional_instruction_files: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.list_optional_instruction_files,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        files: store
          .snapshot()
          .files.filter(
            (file) =>
              file.kind === "optional" &&
              (input.projectId === undefined || file.projectId === input.projectId),
          ),
      }));
    }),
  ),
  attach_optional_instructions: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.attach_optional_instructions,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        threadId: input.threadId,
        fileIds: store.setThreadAttachments(input.threadId, input.fileIds),
      }));
    }),
  ),
  detach_optional_instructions: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.detach_optional_instructions,
          remote,
          input,
        );
      }
      return yield* runStore((store) => {
        const remaining = store
          .threadAttachments(input.threadId)
          .filter((id) => !input.fileIds.includes(id));
        return {
          threadId: input.threadId,
          fileIds: store.setThreadAttachments(input.threadId, remaining),
        };
      });
    }),
  ),
  get_project_instruction_profile: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.get_project_instruction_profile,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({ profile: store.profile(input.projectId) }));
    }),
  ),
  set_project_instruction_profile: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.set_project_instruction_profile,
          remote,
          input,
        );
      }
      return yield* runStore((store) => ({
        profile: store.setProfile({
          projectId: input.projectId,
          mode: input.mode,
          ...(input.shared === undefined ? {} : { shared: input.shared }),
          ...(input.environments === undefined ? {} : { environments: input.environments }),
        }),
      }));
    }),
  ),
  save_thread: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(scope, InstructionToolkit.tools.save_thread, remote, input);
      }
      const { threads, projection } = yield* readThread(input.threadId, [], "mutate");
      const command = {
        type: "thread.save",
        commandId: yield* newCommandId(),
        threadId: projection.thread.id,
      } satisfies OrchestrationV2Command;
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  unsave_thread: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(scope, InstructionToolkit.tools.unsave_thread, remote, input);
      }
      const { threads, projection } = yield* readThread(input.threadId, [], "mutate");
      const command = {
        type: "thread.unsave",
        commandId: yield* newCommandId(),
        threadId: projection.thread.id,
      } satisfies OrchestrationV2Command;
      const result = yield* threads.dispatch(command).pipe(Effect.mapError(dispatchFailure));
      return { sequence: result.sequence };
    }),
  ),
  list_saved_threads: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(
          scope,
          InstructionToolkit.tools.list_saved_threads,
          remote,
          input,
        );
      }
      const threadManagement = yield* ThreadManagement.ThreadManagementService;
      const all = yield* threadManagement
        .listProjectThreads({
          ...(input.projectId === undefined ? {} : { projectId: ProjectId.make(input.projectId) }),
          includeSubagents: false,
        })
        .pipe(Effect.mapError(failure));
      const saved = all
        .filter((thread) => thread.savedAt != null)
        .sort((left, right) =>
          String(right.savedAt ?? "").localeCompare(String(left.savedAt ?? "")),
        );
      const offset = input.cursor ?? 0;
      const limit = input.limit ?? 20;
      const page = saved.slice(offset, offset + limit);
      return {
        threads: page.map((thread) => ({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          savedAt: thread.savedAt == null ? null : String(thread.savedAt),
        })),
        nextCursor: offset + limit < saved.length ? offset + limit : null,
      };
    }),
  ),
  workspace_digest: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(scope, InstructionToolkit.tools.workspace_digest, remote, input);
      }
      const threadManagement = yield* ThreadManagement.ThreadManagementService;
      const shells = yield* threadManagement
        .listProjectThreads({
          ...(input.projectId === undefined ? {} : { projectId: ProjectId.make(input.projectId) }),
          includeSubagents: false,
        })
        .pipe(Effect.mapError(failure));
      const rank = (status: string): number =>
        status === "failed" || status === "waiting"
          ? 0
          : status === "running" || status === "starting" || status === "preparing"
            ? 1
            : status === "completed"
              ? 2
              : 3;
      const active = shells
        .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
        .sort((left, right) => rank(left.status) - rank(right.status))
        .map((thread) => ({
          threadId: thread.id,
          projectId: thread.projectId,
          title: thread.title,
          status: thread.status,
        }));
      const offset = input.cursor ?? 0;
      const limit = input.limit ?? 20;
      const page = active.slice(offset, offset + limit);
      const spoken = page
        .map((thread) => `${thread.title}: ${speakStatus(thread.status)}.`)
        .join(" ");
      return {
        spoken: spoken.length === 0 ? "No active threads." : spoken,
        threads: page.map((thread) => ({
          ...thread,
          link: McpInvocationContext.threadLinkFor(scope, thread.threadId),
        })),
        nextCursor: offset + limit < active.length ? offset + limit : null,
      };
    }),
  ),
  thread_digest: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const { scope, service } = yield* forwarding;
      const remote = PeerForwarding.remoteTarget(scope, input.environmentId);
      if (remote !== undefined) {
        return yield* service.call(scope, InstructionToolkit.tools.thread_digest, remote, input);
      }
      const { projection } = yield* readThread(input.threadId, [
        "runs",
        "messages",
        "runtimeRequests",
      ]);
      const pending = projection.runtimeRequests.filter((request) => request.status === "pending");
      const attention = digestAttention(projection.runs, pending);
      const lastAssistant = [...projection.messages]
        .reverse()
        .find((message) => message.role === "assistant");
      const parts = [`Thread "${projection.thread.title}" is ${speakAttention(attention)}.`];
      if (lastAssistant !== undefined) {
        const text = stripForVoice(lastAssistant.text);
        parts.push(
          `Latest reply: ${text.slice(0, input.maxReplyChars ?? 800)}${text.length > (input.maxReplyChars ?? 800) ? "…" : ""}`,
        );
      }
      for (const request of pending) {
        parts.push(
          request.kind === "permission"
            ? "It is asking for permission."
            : "It has a question for you.",
        );
      }
      return {
        spoken: parts.join(" "),
        attention,
        pendingRequests: pending.map((request) => ({
          requestId: String(request.id),
          kind: request.kind,
        })),
        threadId: projection.thread.id,
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof InstructionToolkit.tools>;

export const layer = McpToolAccess.toLayer(InstructionToolkit, handlers);
