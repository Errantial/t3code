import {
  EnvironmentId,
  FleetMachineStatus,
  FleetStatusResult,
  FleetUpdateInput,
  FleetUpdateReport,
  FleetUpdateResult,
  OrchestratorMcpFailure,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import { HttpClient } from "effect/http";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ServerSelfUpdate from "../../../cloud/selfUpdate.ts";
import * as ServerEnvironment from "../../../environment/ServerEnvironment.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";

const base = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    PeerLinks.PeerLinks,
    PeerMcpClient.PeerMcpClient,
    ServerEnvironment.ServerEnvironment,
    ServerSelfUpdate.ServerSelfUpdate,
    HttpClient.HttpClient,
    ThreadManagement.ThreadManagementService,
  ],
};

const tagField = {
  tag: Schema.optional(
    TrimmedNonEmptyString.annotate({
      description: "Release tag to inspect; defaults to the latest published release.",
    }),
  ),
};

const FleetUpdateStatusTool = Tool.make("fleet_update_status", {
  ...base,
  description:
    "List the T3 fleet: every machine this environment links to plus this one, each with its platform, install variant, current version, and whether it can update itself. Resolves the latest t3onsteroids release, or `tag`. Changes nothing.",
  parameters: Schema.Struct({ ...tagField }),
  success: Schema.Struct({
    release: FleetStatusResult.fields.release,
    machines: Schema.Array(FleetMachineStatus),
    errors: Schema.Array(Schema.Struct({ environmentId: Schema.String, message: Schema.String })),
  }),
}).annotate(Tool.Readonly, true);

const FleetUpdateTool = Tool.make("fleet_update", {
  ...base,
  description:
    "Plan or run T3 release updates on this machine and linked environments. Defaults to a dry run; a real update requires confirm:true. Reports every machine's result; a failure does not hide the others, and the run stops at the first failure unless continueOnFailure:true. Never updates machines the user did not name.",
  parameters: Schema.Struct({
    targets: Schema.optional(
      Schema.Union([Schema.Literal("all"), Schema.Array(EnvironmentId)]).annotate({
        description:
          "Environment ids, or 'all' (default) for this machine and every linked environment.",
      }),
    ),
    ...tagField,
    dryRun: Schema.optional(
      Schema.Boolean.annotate({ description: "Plan only. Defaults to true." }),
    ),
    confirm: Schema.optional(
      Schema.Boolean.annotate({
        description: "Must be true for a real update, after the user confirms.",
      }),
    ),
    continueOnFailure: Schema.optional(
      Schema.Boolean.annotate({
        description: "Keep updating other machines after one fails. Defaults to false.",
      }),
    ),
  }),
  success: FleetUpdateReport,
}).annotate(Tool.Destructive, true);

const ServerFleetStatusTool = Tool.make("t3_server_fleet_status", {
  ...base,
  description:
    "This machine's T3 release readiness: current version, platform, install variant, and whether it can update itself. A linked fleet hub uses it to inventory machines.",
  parameters: Schema.Struct({ ...tagField }),
  success: FleetStatusResult,
}).annotate(Tool.Readonly, true);

const ServerFleetUpdateTool = Tool.make("t3_server_fleet_update", {
  ...base,
  description:
    "Update this machine to a t3onsteroids release. Defaults to a dry run; a real update requires confirm:true. A linked fleet hub uses it to update this machine; the call may drop while the server restarts.",
  parameters: FleetUpdateInput,
  success: FleetUpdateResult,
}).annotate(Tool.Destructive, true);

export const FleetToolkit = Toolkit.make(
  FleetUpdateStatusTool,
  FleetUpdateTool,
  ServerFleetStatusTool,
  ServerFleetUpdateTool,
);
