import {
  NonNegativeInt,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ThreadId,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as ServerConfig from "../../../config.ts";
import * as Path from "effect/Path";
import * as Crypto from "effect/Crypto";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";

const instructionTarget = Schema.Struct({
  provider: Schema.Literals(["codex", "claude", "opencode", "cursor", "custom"]),
  scope: Schema.Literals(["global", "project"]),
  projectId: Schema.optional(Schema.String),
  /** The linked machine this target belongs to. Omit for this one. */
  environmentId: Schema.optional(Schema.String),
  workspaceRoot: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  filename: Schema.optional(Schema.String),
});

const instructionFile = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(["sync", "optional"]),
  scope: Schema.Literals(["global", "project"]),
  projectId: Schema.optional(Schema.String),
  title: Schema.String,
  filename: Schema.optional(Schema.String),
  content: Schema.String,
  revision: NonNegativeInt,
  updatedAt: Schema.String,
  updatedBy: Schema.optional(Schema.String),
});

const instructionSync = Schema.Struct({
  id: Schema.String,
  fileId: Schema.String,
  targets: Schema.Array(instructionTarget),
  updatedAt: Schema.String,
});

const projectProfile = Schema.Struct({
  projectId: Schema.String,
  mode: Schema.Literals(["shared", "per-environment"]),
  shared: Schema.Array(Schema.String),
  environments: Schema.Record(Schema.String, Schema.Array(Schema.String)),
  updatedAt: Schema.String,
});

const fileChange = Schema.Struct({
  id: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.Literals(["sync", "optional"])),
  scope: Schema.optional(Schema.Literals(["global", "project"])),
  projectId: Schema.optional(Schema.String),
  title: TrimmedNonEmptyString,
  filename: Schema.optional(Schema.String),
  content: Schema.String,
  expectedRevision: Schema.optional(NonNegativeInt),
});

const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PeerForwarding.PeerForwarding,
    ServerConfig.ServerConfig,
    Path.Path,
    Crypto.Crypto,
    ThreadManagement.ThreadManagementService,
  ],
};

const environmentField = {
  environmentId: OrchestratorMcpEnvironmentTarget,
} as const;

const ListFilesTool = Tool.make("list_instruction_files", {
  ...base,
  description:
    "List managed instruction files here or on a linked environment. `kind`: sync files materialize to provider paths; optional files attach to threads.",
  parameters: Schema.Struct({
    ...environmentField,
    kind: Schema.optional(Schema.Literals(["sync", "optional"])),
    scope: Schema.optional(Schema.Literals(["global", "project"])),
    projectId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ files: Schema.Array(instructionFile) }),
}).annotate(Tool.Readonly, true);

const GetFileTool = Tool.make("get_instruction_file", {
  ...base,
  description: "Read one managed instruction file by id.",
  parameters: Schema.Struct({ ...environmentField, id: TrimmedNonEmptyString }),
  success: Schema.Struct({ file: instructionFile }),
}).annotate(Tool.Readonly, true);

const PutFileTool = Tool.make("put_instruction_file", {
  ...base,
  description:
    "Create or replace a managed instruction file. Pass `expectedRevision` from the read to fail on a concurrent edit.",
  parameters: Schema.Struct({ ...environmentField, ...fileChange.fields }),
  success: Schema.Struct({ file: instructionFile }),
}).annotate(Tool.Destructive, true);

const ListSyncsTool = Tool.make("list_instruction_syncs", {
  ...base,
  description: "List instruction sync groups and their materialized targets.",
  parameters: Schema.Struct({ ...environmentField, fileId: Schema.optional(Schema.String) }),
  success: Schema.Struct({ syncs: Schema.Array(instructionSync) }),
}).annotate(Tool.Readonly, true);

const SetSyncTool = Tool.make("set_instruction_sync", {
  ...base,
  description:
    "Set a file's sync targets. Targets name a provider, scope, optional environment, workspace root, and filename or path.",
  parameters: Schema.Struct({
    ...environmentField,
    id: Schema.optional(Schema.String),
    fileId: TrimmedNonEmptyString,
    targets: Schema.Array(instructionTarget),
  }),
  success: Schema.Struct({ sync: instructionSync }),
}).annotate(Tool.Destructive, true);

const RemoveSyncTool = Tool.make("remove_instruction_sync", {
  ...base,
  description: "Remove a sync group by id.",
  parameters: Schema.Struct({ ...environmentField, id: TrimmedNonEmptyString }),
  success: Schema.Struct({ removed: Schema.Boolean }),
}).annotate(Tool.Destructive, true);

const ListOptionalTool = Tool.make("list_optional_instruction_files", {
  ...base,
  description: "List optional role/context files that can attach to a thread.",
  parameters: Schema.Struct({ ...environmentField, projectId: Schema.optional(Schema.String) }),
  success: Schema.Struct({ files: Schema.Array(instructionFile) }),
}).annotate(Tool.Readonly, true);

const AttachOptionalTool = Tool.make("attach_optional_instructions", {
  ...base,
  description: "Attach optional instruction files to a thread for its later turns.",
  parameters: Schema.Struct({
    ...environmentField,
    threadId: ThreadId,
    fileIds: Schema.Array(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ threadId: ThreadId, fileIds: Schema.Array(Schema.String) }),
}).annotate(Tool.Destructive, true);

const DetachOptionalTool = Tool.make("detach_optional_instructions", {
  ...base,
  description: "Detach optional instruction files from a thread.",
  parameters: Schema.Struct({
    ...environmentField,
    threadId: ThreadId,
    fileIds: Schema.Array(TrimmedNonEmptyString),
  }),
  success: Schema.Struct({ threadId: ThreadId, fileIds: Schema.Array(Schema.String) }),
}).annotate(Tool.Destructive, true);

const GetProfileTool = Tool.make("get_project_instruction_profile", {
  ...base,
  description:
    "Read a project's instruction profile: one shared file set, or a per-environment selection.",
  parameters: Schema.Struct({ ...environmentField, projectId: TrimmedNonEmptyString }),
  success: Schema.Struct({ profile: projectProfile }),
}).annotate(Tool.Readonly, true);

const SetProfileTool = Tool.make("set_project_instruction_profile", {
  ...base,
  description:
    "Set a project's instruction profile. `shared` applies to every environment; `environments` maps environment id to file ids.",
  parameters: Schema.Struct({
    ...environmentField,
    projectId: TrimmedNonEmptyString,
    mode: Schema.Literals(["shared", "per-environment"]),
    shared: Schema.optional(Schema.Array(Schema.String)),
    environments: Schema.optional(Schema.Record(Schema.String, Schema.Array(Schema.String))),
  }),
  success: Schema.Struct({ profile: projectProfile }),
}).annotate(Tool.Destructive, true);

const SaveThreadTool = Tool.make("save_thread", {
  ...base,
  description:
    "Save a thread independently of settling or archiving. Omit `threadId` for this thread.",
  parameters: Schema.Struct({ ...environmentField, threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ sequence: NonNegativeInt }),
}).annotate(Tool.Destructive, true);

const UnsaveThreadTool = Tool.make("unsave_thread", {
  ...base,
  description: "Unsave a thread; its prior settling/archiving state returns.",
  parameters: Schema.Struct({ ...environmentField, threadId: Schema.optional(ThreadId) }),
  success: Schema.Struct({ sequence: NonNegativeInt }),
}).annotate(Tool.Destructive, true);

const ListSavedThreadsTool = Tool.make("list_saved_threads", {
  ...base,
  description: "List saved threads, newest saved first. Pages with `cursor` and `limit`.",
  parameters: Schema.Struct({
    ...environmentField,
    projectId: Schema.optional(Schema.String),
    cursor: Schema.optional(NonNegativeInt),
    limit: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
  }),
  success: Schema.Struct({
    threads: Schema.Array(
      Schema.Struct({
        threadId: ThreadId,
        projectId: Schema.String,
        title: Schema.String,
        savedAt: Schema.optional(Schema.NullOr(Schema.String)),
      }),
    ),
    nextCursor: Schema.NullOr(NonNegativeInt),
  }),
}).annotate(Tool.Readonly, true);

export const InstructionToolkit = Toolkit.make(
  ListFilesTool,
  GetFileTool,
  PutFileTool,
  ListSyncsTool,
  SetSyncTool,
  RemoveSyncTool,
  ListOptionalTool,
  AttachOptionalTool,
  DetachOptionalTool,
  GetProfileTool,
  SetProfileTool,
  SaveThreadTool,
  UnsaveThreadTool,
  ListSavedThreadsTool,
);
