import {
  OrchestratorMcpFailure,
  type OrchestratorMcpEnvironmentLink,
  type OrchestratorMcpSwarmMemberFailure,
  type OrchestratorMcpSwarmMemberResult,
  type OrchestratorMcpThreadListResult,
} from "@t3tools/contracts";
import { OrchestratorToolkit } from "./tools.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import { readCaller } from "../../threadAccess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as SwarmService from "../../../swarm/SwarmService.ts";

type PeerListReport = {
  readonly link: OrchestratorMcpEnvironmentLink;
  readonly status: "ok" | "unreachable" | "access_denied" | "capability_missing";
  readonly result: OrchestratorMcpThreadListResult | null;
};

const handlers = {
  orchestrator_capabilities: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const result = yield* service.capabilities(scope, input);
      // Swarm v2 (SW-A8): caps and per-instance counters, only while its Labs setting is on.
      const settings = yield* ServerSettings.ServerSettingsService;
      const swarmOn = yield* settings.getSettings.pipe(
        Effect.map((current) => current.swarmV2Enabled),
        Effect.orElseSucceed(() => false),
      );
      if (!swarmOn) return result;
      const swarms = yield* Effect.serviceOption(SwarmService.SwarmService);
      if (Option.isNone(swarms)) return result;
      const swarm = yield* swarms.value.capacity.pipe(Effect.option);
      return Option.isNone(swarm) ? result : { ...result, swarm: swarm.value };
    }),
  ),
  delegate_task: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.delegateTask(scope, input);
    }),
  ),
  create_swarm: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const keys = new Set<string>();
      for (const member of input.members) {
        if (keys.has(member.key)) {
          return yield* new OrchestratorMcpFailure({
            code: "invalid_request",
            message: `Swarm member key '${member.key}' is repeated. Give every member a unique key.`,
          });
        }
        keys.add(member.key);
      }
      const requestId = input.clientRequestId ?? `${scope.requestNamespace}:swarm`;
      const outcomes = yield* Effect.forEach(
        input.members,
        (member, index) =>
          service
            .delegateTask(scope, {
              task: member.task,
              title: member.title,
              ...(member.role === undefined ? {} : { role: member.role }),
              ...(member.target === undefined ? {} : { target: member.target }),
              ...(member.isolation === undefined ? {} : { isolation: member.isolation }),
              mode: "async",
              clientRequestId: `${requestId}:${index}:${member.key}`,
            })
            .pipe(
              Effect.map((value) => ({ member, outcome: "launched" as const, value })),
              Effect.catch((failure) =>
                Effect.succeed({ member, outcome: "failed" as const, failure }),
              ),
            ),
        { concurrency: 1 },
      );
      const launched: ReadonlyArray<OrchestratorMcpSwarmMemberResult> = outcomes.flatMap(
        (entry) => {
          if (entry.outcome !== "launched") return [];
          const { member, value } = entry;
          return [
            {
              key: member.key,
              title: member.title,
              taskId: value.taskId,
              childThreadId: value.childThreadId,
              ...(value.link === undefined ? {} : { link: value.link }),
              status: value.status,
              providerInstanceId: value.providerInstanceId,
              model: value.model,
              ...(value.options === undefined ? {} : { options: value.options }),
            },
          ];
        },
      );
      const failed: ReadonlyArray<OrchestratorMcpSwarmMemberFailure> = outcomes.flatMap((entry) => {
        if (entry.outcome !== "failed") return [];
        const { member, failure } = entry;
        return [{ key: member.key, title: member.title, message: failure.message }];
      });
      return { title: input.title, launched, failed };
    }),
  ),
  task_status: McpToolAccess.actsAsCaller(({ taskId }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.taskStatus(scope, taskId);
    }),
  ),
  task_cancel: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.cancelTask(scope, input);
    }),
  ),
  t3_workflow_stop: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const { threads } = yield* readCaller();
        return yield* threads.stopWorkflow(input).pipe(
          Effect.as({}),
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code:
                  cause.reason === "unavailable" || cause.reason === "stop-failed"
                    ? "orchestration_error"
                    : "invalid_request",
                message: cause.message,
              }),
          ),
        );
      }),
  ),
  t3_background_wait: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, threads } = yield* readCaller();
      const caller = yield* McpInvocationContext.requireThreadScope(scope, "t3_background_wait");
      return yield* threads
        .awaitBackgroundTasks({
          threadId: caller.thread.threadId,
          taskIds: input.taskIds,
          awaited: input.waiting ?? true,
        })
        .pipe(
          Effect.mapError(
            (cause) =>
              new OrchestratorMcpFailure({
                code: cause.reason === "unsupported" ? "invalid_request" : "orchestration_error",
                message: cause.message,
              }),
          ),
        );
    }),
  ),
  schedule_task: McpToolAccess.either(
    (input) => input.scheduledTaskId === undefined,
    McpToolAccess.startsThreads(
      () => ({}),
      ({ prompt, schedule, ...input }) =>
        Effect.gen(function* () {
          if (prompt === undefined || schedule === undefined) {
            return yield* new OrchestratorMcpFailure({
              code: "invalid_request",
              message: "A new scheduled task needs `prompt` and `schedule`.",
            });
          }
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.scheduleTask(scope, { ...input, prompt, schedule });
        }),
      // A scheduled run starts long after its caller, with nothing to carry the link.
      { refused: "schedule tasks in this environment" },
    ),
    McpToolAccess.writes(
      ({ scheduledTaskId, prompt, title, schedule, enabled, bindToCurrentThread }) =>
        Effect.gen(function* () {
          if (scheduledTaskId === undefined) return yield* Effect.die("unreachable");
          const scope = yield* McpInvocationContext.McpInvocationContext;
          const service = yield* OrchestratorMcpService.OrchestratorMcpService;
          return yield* service.updateScheduledTask(scope, {
            scheduledTaskId,
            prompt,
            title,
            schedule,
            enabled,
            bindToCurrentThread,
          });
        }),
    ),
  ),
  list_scheduled_tasks: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.listScheduledTasks(scope, input);
    }),
  ),
  delete_scheduled_task: McpToolAccess.writes((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.deleteScheduledTask(scope, input);
    }),
  ),
  request_secret: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.requestSecret(scope, input);
    }),
  ),
  create_threads: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.createThreads(scope, input);
    }),
  ),
  t3_thread_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      const local = yield* service.listThreads(
        scope,
        input.environments === "all"
          ? { ...input, environments: "local", allProjects: true, projectId: undefined }
          : input,
      );
      if (input.environments !== "all") return local;

      const forwarding = yield* Effect.serviceOption(PeerForwarding.PeerForwarding);
      if (Option.isNone(forwarding))
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "This environment cannot reach linked environments.",
        });
      const { links } = yield* forwarding.value.links(scope);
      const reachable = links.filter((link) => link.status === "reachable");
      const { environmentId: _environment, environments: _environments, ...base } = input;
      void _environment;
      void _environments;
      const reports = yield* Effect.forEach(
        reachable,
        (link): Effect.Effect<PeerListReport> =>
          forwarding.value
            .call(scope, OrchestratorToolkit.tools.t3_thread_list, link.environmentId, {
              ...base,
              allProjects: true,
              projectId: undefined,
            })
            .pipe(
              Effect.map((result) => ({ link, status: "ok" as const, result })),
              Effect.catch((error) =>
                Effect.succeed({
                  link,
                  status:
                    error.code === "capability_denied"
                      ? ("access_denied" as const)
                      : ("unreachable" as const),
                  result: null,
                }),
              ),
            ),
        { concurrency: 4 },
      );

      const threads = [
        ...local.threads,
        ...reports.flatMap((report) => report.result?.threads ?? []),
      ]
        .toSorted((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt))
        .slice(0, input.limit ?? 50);
      const total = reports.reduce(
        (count, report) => count + (report.result?.total ?? 0),
        local.total,
      );
      return {
        ...local,
        projectId: null,
        threads,
        total,
        nextCursor: null,
        scope: {
          ...(local.scope ?? { includeSubagents: true, filtersApplied: [] }),
          projectId: null,
          environments: "all" as const,
        },
        environments: [
          {
            environmentId: scope.environmentId,
            label: "This environment",
            status: "ok" as const,
            capabilities: "v1" as const,
          },
          ...reports.map((report) => ({
            environmentId: report.link.environmentId,
            label: report.link.label,
            status: report.status,
            capabilities: "v1" as const,
          })),
        ],
      };
    }),
  ),
  t3_thread_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.readThread(scope, input);
    }),
  ),
  t3_thread_update: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* ThreadMetadataMcpService.ThreadMetadataMcpService;
        return yield* service.update(scope, input);
      }),
  ),
  t3_thread_send: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.sendToThread(scope, input);
      }),
  ),
  t3_thread_wait: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const service = yield* OrchestratorMcpService.OrchestratorMcpService;
      return yield* service.waitForThread(scope, input);
    }),
  ),
  t3_environment_links: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const forwarding = yield* PeerForwarding.PeerForwarding;
      return yield* forwarding.links(scope);
    }),
  ),
  // A link lets every agent here reach the other environment, so it is an
  // environment setting: full access, and never for linked work.
  t3_environment_link: McpToolAccess.writesEnvironment((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const requests = yield* PeerLinkRequests.PeerLinkRequests;
      return yield* requests.request(scope, input);
    }),
  ),
  t3_environment_unlink: McpToolAccess.writesEnvironment(({ environmentId }) =>
    Effect.gen(function* () {
      const links = yield* PeerLinks.PeerLinks;
      const removed = yield* links
        .unlink(environmentId)
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
          ),
        );
      return { environmentId, removed };
    }),
  ),
  t3_thread_interrupt: McpToolAccess.writesThreads(
    (input) => [input.threadId],
    (input) =>
      Effect.gen(function* () {
        const scope = yield* McpInvocationContext.McpInvocationContext;
        const service = yield* OrchestratorMcpService.OrchestratorMcpService;
        return yield* service.interruptThread(scope, input);
      }),
  ),
} satisfies McpToolAccess.Handlers<typeof OrchestratorToolkit.tools>;

export const layer = McpToolAccess.toLayer(OrchestratorToolkit, handlers);
