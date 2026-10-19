import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { Tool } from "effect/ai";

import * as CivilizationContext from "../../../civilization/ContextService.ts";
import * as CivilizationKnowledge from "../../../civilization/KnowledgeService.ts";
import * as CivilizationMail from "../../../civilization/MailService.ts";
import * as ClaudeAdapterV2 from "../../../orchestration-v2/Adapters/ClaudeAdapterV2.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as CivilizationHandlers from "./handlers.ts";
import { CivilizationToolkit } from "./tools.ts";

const reads = [
  "civilization_context",
  "civilization_census",
  "civilization_citizen_search",
  "civilization_note_list",
  "civilization_note_read",
  "civilization_inbox_list",
] as const;

const mutations = [
  "civilization_note_create",
  "civilization_note_update",
  "civilization_note_resolve",
  "civilization_mail_send",
  "civilization_handoff_send",
  "civilization_mail_receive",
  "civilization_mail_acknowledge",
] as const;

const jsonSchema = (name: keyof typeof CivilizationToolkit.tools) =>
  Tool.getJsonSchema(CivilizationToolkit.tools[name]) as {
    readonly properties?: Readonly<Record<string, unknown>>;
    readonly required?: ReadonlyArray<string>;
  };

describe("Civilization MCP toolkit", () => {
  it("marks reads readonly and mutations writable", () => {
    for (const name of reads) {
      expect(Context.get(CivilizationToolkit.tools[name].annotations, Tool.Readonly), name).toBe(
        true,
      );
    }
    for (const name of mutations) {
      expect(Context.get(CivilizationToolkit.tools[name].annotations, Tool.Readonly), name).toBe(
        false,
      );
    }
  });

  it("keeps mutation identity and mode authority off the public schemas", () => {
    const forbidden = [
      "author",
      "authorThreadId",
      "senderThreadId",
      "threadId",
      "projectId",
      "runId",
      "epoch",
      "citizenEpoch",
      "deliveryEpoch",
      "providerInstanceId",
      "runtimeMode",
      "interactionMode",
    ];

    for (const name of mutations) {
      const properties = jsonSchema(name).properties ?? {};
      for (const field of forbidden) {
        expect(properties, `${name} must not expose ${field}`).not.toHaveProperty(field);
      }
    }
  });

  it("requires clientRequestId for civilization_note_create", () => {
    const schema = jsonSchema("civilization_note_create");
    expect(schema.properties).toHaveProperty("clientRequestId");
    expect(schema.required).toContain("clientRequestId");
  });

  it("requires idempotency ids for every Civilization mail mutation", () => {
    for (const name of [
      "civilization_mail_send",
      "civilization_handoff_send",
      "civilization_mail_receive",
      "civilization_mail_acknowledge",
    ] as const) {
      const schema = jsonSchema(name);
      expect(schema.properties, name).toHaveProperty("clientRequestId");
      expect(schema.required, name).toContain("clientRequestId");
    }
    expect(jsonSchema("civilization_mail_send").required).toContain("targetThreadId");
    expect(jsonSchema("civilization_handoff_send").required).toContain("targetThreadId");
    expect(jsonSchema("civilization_handoff_send").required).toContain("handoff");
    expect(jsonSchema("civilization_mail_receive").required).toContain("messageId");
    expect(jsonSchema("civilization_mail_acknowledge").required).toContain("messageId");
  });

  it("keeps inbox metadata readonly while body offer and acknowledgement are mutations", () => {
    expect(jsonSchema("civilization_inbox_list").properties).not.toHaveProperty("messageId");
    expect(
      Context.get(CivilizationToolkit.tools.civilization_inbox_list.annotations, Tool.Readonly),
    ).toBe(true);
    expect(
      Context.get(CivilizationToolkit.tools.civilization_mail_receive.annotations, Tool.Readonly),
    ).toBe(false);
  });

  it("exposes note-list selection so context packet cursors are followable", () => {
    expect(jsonSchema("civilization_note_list").properties).toHaveProperty("selection");
  });

  it("keeps citizen search bounded in its public schema", () => {
    const schema = jsonSchema("civilization_citizen_search");
    expect(schema.required).toContain("query");
    expect(schema.required).not.toContain("projectId");
    expect(schema.properties).toHaveProperty("limit");
  });

  it("allows only Civilization read tools in Claude readonly MCP mode", () => {
    const allowed = new Set(ClaudeAdapterV2.CLAUDE_READ_ONLY_T3_MCP_ALLOWED_TOOLS);
    const prefix = "mcp__t3-code__";

    for (const name of reads) {
      expect(allowed.has(`${prefix}${name}`), name).toBe(true);
    }
    for (const name of mutations) {
      expect(allowed.has(`${prefix}${name}`), name).toBe(false);
    }

    const civilizationAllowed = [...allowed]
      .filter((name) => name.startsWith(`${prefix}civilization_`))
      .sort();
    expect(civilizationAllowed).toEqual(reads.map((name) => `${prefix}${name}`).sort());
  });
});

describe("Civilization MCP citizen search authority", () => {
  const environmentId = EnvironmentId.make("environment:civilization-search");
  const callerThreadId = ThreadId.make("thread:civilization-search:caller");
  const callerProjectId = ProjectId.make("project:mcp-test");
  const foreignProjectId = ProjectId.make("project:civilization-search:foreign");
  const providerInstanceId = ProviderInstanceId.make("codex");

  const threadScope: McpInvocationContext.McpInvocationScope = {
    environmentId,
    requestNamespace: "provider:civilization-search",
    thread: {
      threadId: callerThreadId,
      providerSessionId: "provider:civilization-search",
      providerInstanceId,
    },
    client: undefined,
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  };
  const clientScope: McpInvocationContext.McpInvocationScope = {
    environmentId,
    requestNamespace: "client:civilization-search",
    thread: undefined,
    client: { sessionId: "client-search", label: "Search", access: "read-only" },
    capabilities: new Set(["orchestration"]),
    issuedAt: 0,
  };

  const runSearch = (
    scope: McpInvocationContext.McpInvocationScope,
    args: { readonly projectId?: ProjectId; readonly query: string; readonly limit?: number },
    inputs: Ref.Ref<ReadonlyArray<CivilizationKnowledge.CivilizationCitizenSearchInput>>,
  ) => {
    const knowledge = Layer.mock(CivilizationKnowledge.CivilizationKnowledgeService)({
      searchCitizens: (input) =>
        Ref.update(inputs, (seen) => [...seen, input]).pipe(
          Effect.as([
            {
              projectId: input.projectId,
              threadId: ThreadId.make("thread:civilization-search:result"),
              displayName: "Ada Search",
              profileLabel: "Calm",
              generation: 1,
              lifecycleState: "open" as const,
              observedOnly: false,
              threadTitle: "Search title",
            },
          ]),
        ),
    });
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(liveThreadShell(threadId)),
      }),
      knowledge,
      Layer.mock(CivilizationContext.CivilizationContextService)({}),
      Layer.mock(CivilizationMail.CivilizationMailService)({}),
    );
    return CivilizationToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(CivilizationHandlers.layer).pipe(
          Layer.provide(dependencies),
        ),
      ),
      Effect.flatMap((toolkit) =>
        toolkit
          .handle("civilization_citizen_search", args)
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies)),
      ),
    );
  };

  it.effect("defaults thread callers to their own project", () =>
    Effect.gen(function* () {
      const inputs = yield* Ref.make<
        ReadonlyArray<CivilizationKnowledge.CivilizationCitizenSearchInput>
      >([]);
      const result = yield* runSearch(threadScope, { query: "Ada", limit: 5 }, inputs);
      expect(result.at(-1)?.result).toEqual([
        expect.objectContaining({ projectId: callerProjectId, displayName: "Ada Search" }),
      ]);
      expect(yield* Ref.get(inputs)).toEqual([
        { projectId: callerProjectId, query: "Ada", limit: 5 },
      ]);
    }),
  );

  it.effect("rejects an explicit cross-project target from a thread credential", () =>
    Effect.gen(function* () {
      const inputs = yield* Ref.make<
        ReadonlyArray<CivilizationKnowledge.CivilizationCitizenSearchInput>
      >([]);
      const result = yield* runSearch(
        threadScope,
        { projectId: foreignProjectId, query: "Ada" },
        inputs,
      );
      expect(result.at(-1)?.result).toMatchObject({ code: "invalid_request" });
      expect(yield* Ref.get(inputs)).toEqual([]);
    }),
  );

  it.effect("allows a non-thread read client to target one explicit project", () =>
    Effect.gen(function* () {
      const inputs = yield* Ref.make<
        ReadonlyArray<CivilizationKnowledge.CivilizationCitizenSearchInput>
      >([]);
      const result = yield* runSearch(
        clientScope,
        { projectId: foreignProjectId, query: "Ada", limit: 20 },
        inputs,
      );
      expect(result.at(-1)?.result).toEqual([
        expect.objectContaining({ projectId: foreignProjectId, displayName: "Ada Search" }),
      ]);
      expect(yield* Ref.get(inputs)).toEqual([
        { projectId: foreignProjectId, query: "Ada", limit: 20 },
      ]);
    }),
  );
});
