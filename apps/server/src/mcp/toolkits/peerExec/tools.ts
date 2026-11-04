import {
  OrchestratorMcpFailure,
  PeerExecCancelInput,
  PeerExecCancelResult,
  PeerExecInput,
  PeerExecResult,
  PeerFsListInput,
  PeerFsListResult,
  PeerFsReadInput,
  PeerFsReadResult,
} from "@t3tools/contracts";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as PeerExec from "../../../peer/PeerExec.ts";

const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PeerExec.PeerExec,
    ThreadManagement.ThreadManagementService,
  ],
};

export const PeerExecToolkit = Toolkit.make(
  Tool.make("peer_exec", {
    ...base,
    description:
      "Run one bounded command on this machine for a linked environment. No shell wrapper: argv is spawned directly. Retry a lost reply with the same execId; it never runs twice. Returns terminal metadata and output tails.",
    parameters: PeerExecInput,
    success: PeerExecResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("peer_exec_cancel", {
    ...base,
    description:
      "Stop a running peer_exec by its execId. Idempotent: a finished exec reports finished, an unknown id reports unknown.",
    parameters: PeerExecCancelInput,
    success: PeerExecCancelResult,
  }).annotate(Tool.Destructive, true),
  Tool.make("peer_fs_read", {
    ...base,
    description:
      "Read a file on this machine for a linked environment, inside an allowed root. Returns UTF-8 text or base64 bytes.",
    parameters: PeerFsReadInput,
    success: PeerFsReadResult,
  }).annotate(Tool.Readonly, true),
  Tool.make("peer_fs_list", {
    ...base,
    description:
      "List a directory on this machine for a linked environment, inside an allowed root. Pages with nextCursor.",
    parameters: PeerFsListInput,
    success: PeerFsListResult,
  }).annotate(Tool.Readonly, true),
);
