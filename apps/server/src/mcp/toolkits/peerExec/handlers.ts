// @effect-diagnostics effectFnOpportunity:off
import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as PeerExec from "../../../peer/PeerExec.ts";
import { PeerExecToolkit } from "./tools.ts";

const refused = (code: "capability_denied" | "remote_approval_required", message: string) =>
  Effect.fail(new OrchestratorMcpFailure({ code, message }));

/** These tools exist for a linked environment only, and only while the target turns them on. */
const requireLink = Effect.gen(function* () {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (scope.client?.linked !== true) {
    return yield* refused(
      "capability_denied",
      "This tool is for a linked environment. Link this machine from the other environment to use it.",
    );
  }
  return scope;
});

const requireEnabled = Effect.fn("PeerExecToolkit.requireEnabled")(function* (
  exec: PeerExec.PeerExec["Service"],
) {
  if (!(yield* exec.enabled)) {
    return yield* refused(
      "capability_denied",
      "Execution targets are off on this machine. Turn them on in Settings > Labs there.",
    );
  }
});

const readGrant = Effect.fn("PeerExecToolkit.readGrant")(function* (
  exec: PeerExec.PeerExec["Service"],
) {
  const grant = yield* exec.grant;
  if (grant === "off") {
    return yield* refused(
      "capability_denied",
      "This link may not read or run on this machine. Set Remote execution for it in Connections there.",
    );
  }
  return grant;
});

const requireExecGrant = Effect.gen(function* () {
  const scope = yield* requireLink;
  const exec = yield* PeerExec.PeerExec;
  yield* requireEnabled(exec);
  const grant = yield* readGrant(exec);
  if (grant !== "auto" && grant !== "full-access") {
    return yield* refused(
      "capability_denied",
      "This link may read here but not run commands. Raise Remote execution in Connections on this machine.",
    );
  }
  if (McpInvocationContext.clientModeCeiling(scope.client).runtimeMode === "approval-required") {
    return yield* refused(
      "remote_approval_required",
      "The agent that asked is below auto mode. Approve it there, or run the command on its own machine.",
    );
  }
});

const requireReadGrant = Effect.gen(function* () {
  yield* requireLink;
  const exec = yield* PeerExec.PeerExec;
  yield* requireEnabled(exec);
  yield* readGrant(exec);
});

export const layer = McpToolAccess.toLayer(PeerExecToolkit, {
  peer_exec: McpToolAccess.writes(
    (input) =>
      requireExecGrant.pipe(
        Effect.andThen(Effect.flatMap(PeerExec.PeerExec, (exec) => exec.run(input))),
      ),
    { linkedCallers: "allowed" },
  ),
  peer_exec_cancel: McpToolAccess.writes(
    (input) =>
      requireExecGrant.pipe(
        Effect.andThen(Effect.flatMap(PeerExec.PeerExec, (exec) => exec.cancel(input.execId))),
      ),
    { linkedCallers: "allowed" },
  ),
  peer_fs_read: McpToolAccess.reads((input) =>
    requireReadGrant.pipe(
      Effect.andThen(Effect.flatMap(PeerExec.PeerExec, (exec) => exec.readFile(input))),
    ),
  ),
  peer_fs_list: McpToolAccess.reads((input) =>
    requireReadGrant.pipe(
      Effect.andThen(Effect.flatMap(PeerExec.PeerExec, (exec) => exec.list(input))),
    ),
  ),
} satisfies McpToolAccess.Handlers<typeof PeerExecToolkit.tools>);
