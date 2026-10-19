import {
  AuthSessionId,
  CIVILIZATION_CONFIG_VERSION,
  CivilizationAchievementCursor,
  CivilizationCensusCursor,
  CivilizationChronicleCursor,
  CivilizationCorrespondenceCursor,
  CivilizationDefaultConfig,
  CivilizationLineageCursor,
  CivilizationInboxCursor,
  CivilizationMessageId,
  CivilizationNoteId,
  CivilizationNotesCursor,
  type CivilizationOnboardingPreviewRequest,
  EnvironmentAuthenticatedAuth,
  EnvironmentAuthenticatedPrincipal,
  EnvironmentHttpApi,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Etag from "effect/http/Etag";
import * as HttpPlatform from "effect/http/HttpPlatform";
import * as HttpApi from "effect/http-api/HttpApi";
import * as HttpApiBuilder from "effect/http-api/HttpApiBuilder";
import * as HttpRouter from "effect/http/HttpRouter";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as AdministrationService from "./AdministrationService.ts";
import * as AttentionService from "./AttentionService.ts";
import * as CitizenService from "./CitizenService.ts";
import * as ChronicleService from "./ChronicleService.ts";
import * as ConfigService from "./ConfigService.ts";
import * as ContextService from "./ContextService.ts";
import * as CivilizationHttp from "./http.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import * as MailService from "./MailService.ts";
import * as OnboardingService from "./OnboardingService.ts";
import * as OperationsService from "./OperationsService.ts";
import * as ProjectBriefService from "./ProjectBriefService.ts";

class CivilizationTestApi extends HttpApi.make("environment").add(
  EnvironmentHttpApi.groups.civilization,
) {}

const database = SqlitePersistence.layerMemory;
const fakeAdministration = AdministrationService.CivilizationAdministrationService.of({
  previewReassignment: () => Effect.die("unused administration preview"),
  applyReassignment: () => Effect.die("unused administration apply"),
  reclaimTitle: () => Effect.die("unused administration reclaim"),
  restoreTitle: () => Effect.die("unused administration restore"),
});
const fakeAttention = AttentionService.CivilizationAttentionService.of({
  snapshot: (projectId) =>
    Effect.succeed({
      projectId,
      generatedAt: "2026-10-18T12:00:00.000Z",
      items: [],
    }),
});
const fakeKnowledge = KnowledgeService.CivilizationKnowledgeService.of({
  searchCitizens: () => Effect.succeed([]),
  listCensus: ({ projectId }) =>
    Effect.succeed({ projectId, revision: 0, citizens: [], nextCursor: null, partial: false }),
  getLineageNeighborhood: ({ projectId, threadId }) =>
    Effect.succeed({
      projectId,
      revision: 0,
      focus: {
        threadId,
        projectId,
        name: "Lineage focus",
        profileId: "calm",
        profileLabel: "Calm",
        generation: 0,
        lineageStatus: "resolved",
        parentThreadId: null,
        relationshipToParent: null,
        observedOnly: false,
        epoch: 0,
        closed: false,
        deleted: false,
        titleManaged: true,
        revision: 1,
      },
      parent: null,
      parentAvailability: "none",
      children: [],
      nextCursor: null,
      partial: false,
    }),
  listNotes: ({ projectId }) =>
    Effect.succeed({ projectId, revision: 0, notes: [], nextCursor: null, partial: false }),
  readNoteMetadata: () => Effect.die("unused note metadata read"),
  readNoteBody: () => Effect.die("unused note body read"),
  createNote: () => Effect.die("unused note create"),
  updateNote: () => Effect.die("unused note update"),
  resolveNote: () => Effect.die("unused note resolve"),
  selectNotesForContext: () => Effect.die("unused context note selection"),
  getProjectRevisions: () => Effect.die("unused project revisions read"),
  authoritativeCaller: () => Effect.die("unused authoritative caller lookup"),
});
const fakeMail = MailService.CivilizationMailService.of({
  authoritativeCaller: () => Effect.die("unused mail caller lookup"),
  authoritativeCallerAgainstEffective: () => Effect.die("unused effective mail caller lookup"),
  send: () => Effect.die("unused mail send"),
  sendHandoff: () => Effect.die("unused handoff send"),
  listInbox: () => Effect.die("unused agent inbox list"),
  receive: () => Effect.die("unused mail receive"),
  acknowledge: () => Effect.die("unused mail acknowledge"),
  selectInboxForContext: () => Effect.die("unused context inbox selection"),
  selectInboxForContextAfterAuthority: () =>
    Effect.die("unused post-authority context inbox selection"),
  wouldOfferInboxForContext: () => Effect.die("unused context inbox offer preview"),
  wouldOfferInboxForContextAgainstEffective: () =>
    Effect.die("unused effective context inbox offer preview"),
  offerInboxForContext: () => Effect.die("unused context inbox offer"),
  listAdminMail: () => Effect.die("unused admin mail list"),
  readAdminMessage: () => Effect.die("unused admin mail read"),
  listCorrespondenceHistory: () => Effect.die("unused correspondence history list"),
  readCorrespondenceThread: () => Effect.die("unused correspondence thread read"),
  cleanupProject: () => Effect.die("unused mail cleanup"),
});
const fakeChronicle = ChronicleService.CivilizationChronicleService.of({
  list: ({ projectId }) =>
    Effect.succeed({ projectId, revision: 0, entries: [], nextCursor: null, partial: false }),
  listAchievements: ({ projectId }) =>
    Effect.succeed({ projectId, revision: 0, awards: [], nextCursor: null, partial: false }),
  record: () => Effect.die("unused chronicle record"),
});
const fakeContext = ContextService.CivilizationContextService.of({
  listCapabilities: () => Effect.succeed([]),
  forTurn: () => Effect.die("unused Civilization context turn"),
  forExplicitRead: () => Effect.die("unused explicit Civilization context read"),
  previewExistingCitizen: () => Effect.die("unused Civilization context preview"),
  analytics: ({ projectId, bucketSize }) =>
    Effect.succeed({
      projectId,
      from: "1970-01-01T00:00:00.000Z",
      to: "1970-01-01T00:00:00.000Z",
      bucketSize,
      appliedDiagnosticRetentionDays: 0,
      buckets: [],
    }),
  listInspections: ({ projectId }) =>
    Effect.succeed({ projectId, inspections: [], nextCursor: null, partial: false }),
  readInspection: () => Effect.succeed(null),
  markProviderStartAccepted: () => Effect.void,
  markProviderStartFailed: () => Effect.void,
});
const fakeOperations = OperationsService.CivilizationOperationsService.of({
  exportProjectData: () => Effect.die("unused project data export"),
  previewPurge: () => Effect.die("unused purge preview"),
  applyPurge: () => Effect.die("unused purge apply"),
  cleanupDeletedProject: () => Effect.die("unused deleted-project cleanup"),
  getAppliedRetentionPolicy: () => Effect.die("unused retention policy read"),
  previewRetentionReduction: () => Effect.die("unused retention preview"),
  applyRetentionReduction: () => Effect.die("unused retention apply"),
});
const fakeProjectBrief = ProjectBriefService.CivilizationProjectBriefService.of({
  readMetadata: (projectId) =>
    Effect.succeed({
      projectId,
      revision: 0,
      configured: false,
      bodyBytes: 0,
      updatedAt: null,
    }),
  readDetail: (projectId) =>
    Effect.succeed({
      projectId,
      revision: 0,
      configured: false,
      bodyBytes: 0,
      updatedAt: null,
      content: null,
    }),
  set: (input) =>
    Effect.succeed({
      projectId: input.projectId,
      revision: input.expectedRevision + 1,
      configured: true,
      bodyBytes: Buffer.byteLength(JSON.stringify(input.content), "utf8"),
      updatedAt: "2026-10-18T00:00:00.000Z",
      content: {
        version: input.content.version,
        summary: input.content.summary,
        objectives: [...input.content.objectives],
        constraints: [...input.content.constraints],
        references: input.content.references.map((reference) => ({ ...reference })),
      },
    }),
  clear: (input) =>
    Effect.succeed({
      projectId: input.projectId,
      revision: input.expectedRevision + 1,
      configured: false,
      bodyBytes: 0,
      updatedAt: "2026-10-18T00:00:01.000Z",
      content: null,
    }),
});
const fakeOnboarding = OnboardingService.CivilizationOnboardingService.of({
  listPresets: () => Effect.die("unused onboarding presets"),
  preview: () => Effect.die("unused onboarding preview"),
  previewContent: () => Effect.die("unused onboarding content preview"),
});

const makeRoutes = (
  adoptionCalls: Ref.Ref<number>,
  scopes: ReadonlyArray<AuthEnvironmentScope>,
  knowledge: KnowledgeService.CivilizationKnowledgeServiceShape = fakeKnowledge,
  mail: MailService.CivilizationMailServiceShape = fakeMail,
  operations: OperationsService.CivilizationOperationsServiceShape = fakeOperations,
  chronicle: ChronicleService.CivilizationChronicleServiceShape = fakeChronicle,
  context: typeof fakeContext = fakeContext,
  projectBrief: ProjectBriefService.CivilizationProjectBriefServiceShape = fakeProjectBrief,
  onboarding: OnboardingService.CivilizationOnboardingServiceShape = fakeOnboarding,
  attention: AttentionService.CivilizationAttentionService["Service"] = fakeAttention,
) => {
  const fakeCitizens = CitizenService.CivilizationCitizenService.of({
    adoptExisting: () =>
      Ref.update(adoptionCalls, (count) => count + 1).pipe(
        Effect.as({ candidates: 0, adopted: 0, skipped: 0 }),
      ),
    reconcileExisting: () =>
      Effect.succeed({ citizenCount: 0, caughtUpCitizenCount: 0, appliedEventCount: 0 }),
    getCitizen: () => Effect.succeed(null),
    getCitizenDetail: ({ projectId, threadId }) =>
      Effect.succeed({
        threadId,
        projectId,
        identity: {
          nameEntryId: "ada",
          namePoolId: "default-names",
          baseName: "Ada",
          displayName: "Ada",
        },
        personality: {
          profileEntryId: "calm",
          profilePoolId: "default-profiles",
          base: { label: "Calm", traits: ["calm"], styleText: "Calm style." },
          rich: {
            label: "Stoic Architect",
            traits: ["deliberate"],
            axiom: "Build carefully.",
            voice: "Measured.",
            styleText: "Architectural style.",
          },
        },
        presentation: { rendering: "rich" as const, label: "Stoic Architect" },
        host: {
          threadTitle: "[Ada] Read only",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        lineage: {
          generation: 0,
          status: "resolved" as const,
          parentThreadId: null,
          relationshipToParent: null,
        },
        lifecycle: {
          state: "open" as const,
          epoch: 0,
          closed: false,
          deleted: false,
        },
        observedOnly: false,
        title: {
          managed: true,
          topic: "Read only",
          preservedTitle: null,
          lastManagedTitle: "[Ada] Read only",
          managedTitlePreview: "[Ada] Read only",
        },
        revision: 1,
      }),
  });
  const auth = Layer.succeed(EnvironmentAuthenticatedAuth, (effect) =>
    effect.pipe(
      Effect.provideService(EnvironmentAuthenticatedPrincipal, {
        sessionId: AuthSessionId.make("civilization-http-test"),
        subject: "civilization-http-test",
        method: "browser-session-cookie",
        scopes: new Set(scopes),
      }),
    ),
  );
  return HttpApiBuilder.layer(CivilizationTestApi).pipe(
    Layer.provide(CivilizationHttp.layer),
    Layer.provide(auth),
    Layer.provide(ConfigService.layer.pipe(Layer.provide(database))),
    Layer.provide(Layer.succeed(CitizenService.CivilizationCitizenService, fakeCitizens)),
    Layer.provide(
      Layer.succeed(AdministrationService.CivilizationAdministrationService, fakeAdministration),
    ),
    Layer.provide(Layer.succeed(AttentionService.CivilizationAttentionService, attention)),
    Layer.provide(Layer.succeed(KnowledgeService.CivilizationKnowledgeService, knowledge)),
    Layer.provide(Layer.succeed(ChronicleService.CivilizationChronicleService, chronicle)),
    Layer.provide(Layer.succeed(ContextService.CivilizationContextService, context)),
    Layer.provide(Layer.succeed(MailService.CivilizationMailService, mail)),
    Layer.provide(Layer.succeed(OperationsService.CivilizationOperationsService, operations)),
    Layer.provide(Layer.succeed(ProjectBriefService.CivilizationProjectBriefService, projectBrief)),
    Layer.provide(Layer.succeed(OnboardingService.CivilizationOnboardingService, onboarding)),
    Layer.provide(HttpPlatform.layer),
    Layer.provide(Etag.layerWeak),
    Layer.provide(NodeServices.layer),
    Layer.provide(database),
  );
};

const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
// `toWebHandler` retains the route layer's SqlClient requirement in its request-context
// type even though the database is already provided above; runtime needs no request service.
const requestContext = Context.empty() as Context.Context<SqlClient.SqlClient>;
const postJson = (path: string, body: unknown) =>
  new Request(`http://127.0.0.1${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: encodeJson(body),
  });

it("reports unexpected provider unavailability as degraded without penalizing metadata-only support", () => {
  const base = {
    status: "active" as const,
    environmentRevision: 1,
    projectRevision: 2,
    citizenCount: 3,
    openCitizenCount: 2,
  };
  const metadataOnly = {
    providerInstanceId: ProviderInstanceId.make("cursor-main"),
    support: "metadata_only" as const,
    contextInjection: false,
    keyedContextReplacement: false,
    actionablePromptRefresh: false,
    providerContinuationRefresh: false,
    messaging: false,
  };
  const unavailable = {
    ...metadataOnly,
    providerInstanceId: ProviderInstanceId.make("codex-unavailable"),
    support: "unsupported" as const,
  };
  expect(CivilizationHttp.civilizationStatusWithCapabilities(base, [metadataOnly])).toMatchObject({
    status: "active",
    providerCapabilities: [{ support: "metadata_only" }],
  });
  expect(
    CivilizationHttp.civilizationStatusWithCapabilities(base, [metadataOnly, unavailable]),
  ).toMatchObject({
    status: "degraded",
    detail: "One or more registered provider adapters are unavailable.",
    providerCapabilities: [{ support: "metadata_only" }, { support: "unsupported" }],
  });
  expect(
    CivilizationHttp.civilizationStatusWithCapabilities({ ...base, status: "disabled" }, [
      unavailable,
    ]),
  ).toMatchObject({ status: "disabled" });
});

it.effect(
  "allows orchestration reads while keeping Civilization mutations behind settings:write",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(makeRoutes(adoptionCalls, ["orchestration:read"]), {
            disableLogger: true,
          }),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const readResponse = await server.handler(
              new Request("http://127.0.0.1/api/civilization/status"),
              requestContext,
            );
            expect(readResponse.status).toBe(200);

            const capabilityResponse = await server.handler(
              new Request("http://127.0.0.1/api/civilization/capabilities"),
              requestContext,
            );
            expect(capabilityResponse.status).toBe(200);
            expect(await capabilityResponse.json()).toEqual({ providers: [] });

            const projectBriefMetadataResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/project-brief/metadata?projectId=project%3Aread-only",
              ),
              requestContext,
            );
            expect(projectBriefMetadataResponse.status).toBe(200);
            const projectBriefMetadata = await projectBriefMetadataResponse.json();
            expect(projectBriefMetadata).toEqual({
              projectId: "project:read-only",
              revision: 0,
              configured: false,
              bodyBytes: 0,
              updatedAt: null,
            });
            expect(projectBriefMetadata).not.toHaveProperty("content");

            const citizenDetailResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/citizens/detail?projectId=project%3Aread-only&threadId=thread%3Aread-only",
              ),
              requestContext,
            );
            expect(citizenDetailResponse.status).toBe(200);

            const citizenSearchResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/citizens/search?projectId=project%3Aread-only&query=Ada&limit=10",
              ),
              requestContext,
            );
            expect(citizenSearchResponse.status).toBe(200);
            expect(await citizenDetailResponse.json()).toMatchObject({
              projectId: "project:read-only",
              threadId: "thread:read-only",
              identity: { displayName: "Ada" },
              presentation: { rendering: "rich", label: "Stoic Architect" },
              host: { threadTitle: "[Ada] Read only", providerInstanceId: "codex" },
              title: { managedTitlePreview: "[Ada] Read only" },
            });

            const lineageResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/lineage?projectId=project%3Aread-only&threadId=thread%3Aread-only",
              ),
              requestContext,
            );
            expect(lineageResponse.status).toBe(200);
            expect(await lineageResponse.json()).toMatchObject({
              projectId: "project:read-only",
              focus: { threadId: "thread:read-only" },
              parentAvailability: "none",
            });

            const chronicleResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/chronicle?projectId=project%3Aread-only",
              ),
              requestContext,
            );
            expect(chronicleResponse.status).toBe(200);
            expect(await chronicleResponse.json()).toMatchObject({
              projectId: "project:read-only",
              entries: [],
            });

            const analyticsResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/context-analytics?projectId=project%3Aread-only&bucket=day",
              ),
              requestContext,
            );
            expect(analyticsResponse.status).toBe(200);
            expect(await analyticsResponse.json()).toEqual({
              projectId: "project:read-only",
              from: "1970-01-01T00:00:00.000Z",
              to: "1970-01-01T00:00:00.000Z",
              bucketSize: "day",
              appliedDiagnosticRetentionDays: 0,
              buckets: [],
            });

            const inspectionListResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/context-inspections?projectId=project%3Aread-only&limit=25",
              ),
              requestContext,
            );
            expect(inspectionListResponse.status).toBe(200);
            expect(await inspectionListResponse.json()).toEqual({
              projectId: "project:read-only",
              inspections: [],
              nextCursor: null,
              partial: false,
            });

            const noteBodyResponse = await server.handler(
              new Request(
                "http://127.0.0.1/api/civilization/notes/note%3Aread-only?projectId=project%3Aread-only",
              ),
              requestContext,
            );
            expect(noteBodyResponse.status).toBe(403);
            expect(await noteBodyResponse.json()).toMatchObject({
              code: "insufficient_scope",
              requiredPermission: "settings:write",
            });

            for (const path of [
              "/api/civilization/context-inspections/context%3Aread-only?projectId=project%3Aread-only",
              "/api/civilization/inbox?projectId=project%3Aread-only",
              "/api/civilization/inbox/mail%3Aread-only?projectId=project%3Aread-only",
              "/api/civilization/correspondence?projectId=project%3Aread-only",
              "/api/civilization/correspondence/mail%3Aread-only/thread?projectId=project%3Aread-only",
              "/api/civilization/export?projectId=project%3Aread-only",
              "/api/civilization/purge/preview?projectId=project%3Aread-only",
              "/api/civilization/retention?projectId=project%3Aread-only",
              "/api/civilization/retention/preview?projectId=project%3Aread-only",
              "/api/civilization/project-brief/detail?projectId=project%3Aread-only",
            ]) {
              const mailResponse = await server.handler(
                new Request(`http://127.0.0.1${path}`),
                requestContext,
              );
              expect(mailResponse.status).toBe(403);
              expect(await mailResponse.json()).toMatchObject({
                code: "insufficient_scope",
                requiredPermission: "settings:write",
              });
            }

            const purgeApply = await server.handler(
              postJson("/api/civilization/purge/apply", {
                projectId: "project:read-only",
                expectedPreviewToken: "sha256:test",
                batchSize: 10,
              }),
              requestContext,
            );
            expect(purgeApply.status).toBe(403);

            const retentionApply = await server.handler(
              postJson("/api/civilization/retention/apply", {
                projectId: "project:read-only",
                expectedPreviewToken: "sha256:test",
              }),
              requestContext,
            );
            expect(retentionApply.status).toBe(403);

            const projectBriefSet = await server.handler(
              postJson("/api/civilization/project-brief/set", {
                projectId: "project:read-only",
                expectedRevision: 0,
                content: {
                  version: 1,
                  summary: "Read-only clients must not set this.",
                  objectives: [],
                  constraints: [],
                  references: [],
                },
              }),
              requestContext,
            );
            expect(projectBriefSet.status).toBe(403);

            const projectBriefClear = await server.handler(
              postJson("/api/civilization/project-brief/clear", {
                projectId: "project:read-only",
                expectedRevision: 1,
              }),
              requestContext,
            );
            expect(projectBriefClear.status).toBe(403);

            const mutationResponse = await server.handler(
              postJson("/api/civilization/config/set", {
                expectedRevision: 0,
                override: {
                  version: CIVILIZATION_CONFIG_VERSION,
                  participation: { enabled: true },
                },
              }),
              requestContext,
            );
            expect(mutationResponse.status).toBe(403);
            expect(await mutationResponse.json()).toMatchObject({
              code: "insufficient_scope",
              requiredScope: "orchestration:operate",
              requiredPermission: "settings:write",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      );
    }),
);

it.effect(
  "serves bounded body-free attention for one required exact project under orchestration:read",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      const requestedProjects = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
      const projectId = ProjectId.make("project:attention:http");
      const attention = AttentionService.CivilizationAttentionService.of({
        snapshot: (requestedProjectId) =>
          Ref.update(requestedProjects, (current) => [...current, requestedProjectId]).pipe(
            Effect.as({
              projectId: requestedProjectId,
              generatedAt: "2026-10-18T12:00:00.000Z",
              items: Array.from({ length: 8 }, (_, index) => ({
                key: `${requestedProjectId}:attention:${index}`,
                kind: "provider_support_limited" as const,
                severity: "warning" as const,
                target: "configuration" as const,
                title: `Attention ${index}`,
                detail: `Metadata-only attention detail ${index}.`,
              })),
            }),
          ),
      });

      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read"],
              fakeKnowledge,
              fakeMail,
              fakeOperations,
              fakeChronicle,
              fakeContext,
              fakeProjectBrief,
              fakeOnboarding,
              attention,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const response = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/attention?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(response.status).toBe(200);
            const body = (await response.json()) as {
              readonly projectId: string;
              readonly generatedAt: string;
              readonly items: ReadonlyArray<Record<string, unknown>>;
            };
            expect(body.projectId).toBe(projectId);
            expect(body.items).toHaveLength(8);
            expect(Object.keys(body).sort()).toEqual(["generatedAt", "items", "projectId"]);
            for (const item of body.items) {
              expect(Object.keys(item).sort()).toEqual([
                "detail",
                "key",
                "kind",
                "severity",
                "target",
                "title",
              ]);
              expect(item).not.toHaveProperty("body");
              expect(item).not.toHaveProperty("content");
              expect(item).not.toHaveProperty("packet");
            }

            const missingProject = await server.handler(
              new Request("http://127.0.0.1/api/civilization/attention"),
              requestContext,
            );
            expect(missingProject.status).toBe(400);
          }),
        (server) => Effect.promise(() => server.dispose()),
      );
      expect(yield* Ref.get(requestedProjects)).toEqual([projectId]);

      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              [],
              fakeKnowledge,
              fakeMail,
              fakeOperations,
              fakeChronicle,
              fakeContext,
              fakeProjectBrief,
              fakeOnboarding,
              attention,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const denied = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/attention?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(denied.status).toBe(403);
            expect(await denied.json()).toMatchObject({
              code: "insufficient_scope",
              requiredPermission: "orchestration:read",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      );
      expect(yield* Ref.get(requestedProjects)).toEqual([projectId]);
    }),
);

it.effect(
  "keeps onboarding metadata/redacted preview readable and exact content behind settings:write",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      const calls = yield* Ref.make({ presets: 0, preview: 0, content: 0 });
      const contentInputs = yield* Ref.make<ReadonlyArray<unknown>>([]);
      const projectId = ProjectId.make("project:onboarding:http");
      const threadId = ThreadId.make("thread:onboarding:http");
      const effective = {
        config: CivilizationDefaultConfig,
        environmentRevision: 2,
        projectRevision: 3,
        provenance: [],
        selectedNameProbabilities: [],
        selectedProfileProbabilities: [],
      } as const;
      const budget = {
        limitBytes: 4096,
        packetBytes: 0,
        requiredBytes: 0,
        briefBytes: 0,
        rosterBytes: 0,
        noteBytes: 0,
        inboxBytes: 0,
        unusedBytes: 4096,
      } as const;
      const composition = {
        brief: { candidates: 0, included: 0, omitted: 0 },
        roster: { candidates: 0, included: 0, omitted: 0 },
        notes: { candidates: 0, included: 0, omitted: 0 },
        inbox: { candidates: 0, included: 0, omitted: 0 },
      } as const;
      const onboarding = OnboardingService.CivilizationOnboardingService.of({
        listPresets: (requestedProjectId) =>
          Ref.update(calls, (current) => ({ ...current, presets: current.presets + 1 })).pipe(
            Effect.as({
              projectId: requestedProjectId,
              environmentRevision: 2,
              projectRevision: 3,
              presets: [
                {
                  id: "custom" as const,
                  label: "Custom",
                  description: "Keep current settings.",
                  candidateOverride: { version: CIVILIZATION_CONFIG_VERSION },
                  changes: [],
                },
              ],
            }),
          ),
        preview: ((input: CivilizationOnboardingPreviewRequest) => {
          const common = {
            projectId: input.projectId,
            effectiveConfig: effective,
            environmentRevision: 2,
            projectRevision: 3,
            changes: [],
            capabilities: [],
            selectedCapability: null,
            budget,
            composition,
            eligibility: {
              brief: true,
              roster: true,
              notes: true,
              inbox: true,
              exactContent: false,
            },
            warnings: [],
          } as const;
          return Ref.update(calls, (current) => ({
            ...current,
            preview: current.preview + 1,
          })).pipe(
            Effect.as(
              input.previewKind === "configuration_only"
                ? { ...common, previewKind: "configuration_only" as const }
                : { ...common, previewKind: "exact_existing_citizen" as const },
            ),
          );
        }) as unknown as OnboardingService.CivilizationOnboardingService["Service"]["preview"],
        previewContent: (input) =>
          Ref.update(contentInputs, (current) => [...current, input]).pipe(
            Effect.andThen(
              Ref.update(calls, (current) => ({ ...current, content: current.content + 1 })),
            ),
            Effect.as({
              projectId: input.projectId,
              threadId: input.threadId,
              effectiveConfig: effective,
              environmentRevision: 2,
              projectRevision: 3,
              capability: {
                providerInstanceId: ProviderInstanceId.make("codex-main"),
                support: "full" as const,
                contextInjection: true,
                keyedContextReplacement: true,
                actionablePromptRefresh: true,
                providerContinuationRefresh: true,
                messaging: true,
              },
              authority: {
                runId: RunId.make("run:onboarding:http"),
                providerInstanceId: ProviderInstanceId.make("codex-main"),
                runtimeMode: "full-access" as const,
                interactionMode: "default" as const,
              },
              budget,
              composition,
              packet: null,
              warnings: [],
            }),
          ),
      });

      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read"],
              fakeKnowledge,
              fakeMail,
              fakeOperations,
              fakeChronicle,
              fakeContext,
              fakeProjectBrief,
              onboarding,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const presets = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/onboarding/presets?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(presets.status).toBe(200);
            expect(await presets.json()).toMatchObject({
              projectId,
              environmentRevision: 2,
              projectRevision: 3,
            });

            const redacted = await server.handler(
              postJson("/api/civilization/onboarding/preview", {
                previewKind: "configuration_only",
                projectId,
                candidateOverride: { version: CIVILIZATION_CONFIG_VERSION },
              }),
              requestContext,
            );
            expect(redacted.status).toBe(200);
            const redactedBody = await redacted.json();
            expect(redactedBody).toMatchObject({ projectId, previewKind: "configuration_only" });
            expect(redactedBody).not.toHaveProperty("packet");

            const content = await server.handler(
              postJson("/api/civilization/onboarding/preview/content", {
                projectId,
                threadId,
              }),
              requestContext,
            );
            expect(content.status).toBe(403);
            expect(await content.json()).toMatchObject({
              code: "insufficient_scope",
              requiredPermission: "settings:write",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      );
      expect(yield* Ref.get(calls)).toEqual({ presets: 1, preview: 1, content: 0 });

      yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read", "orchestration:operate", "settings:write"],
              fakeKnowledge,
              fakeMail,
              fakeOperations,
              fakeChronicle,
              fakeContext,
              fakeProjectBrief,
              onboarding,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const content = await server.handler(
              postJson("/api/civilization/onboarding/preview/content", {
                projectId,
                threadId,
                candidateOverride: { version: CIVILIZATION_CONFIG_VERSION },
              }),
              requestContext,
            );
            expect(content.status).toBe(200);
            expect(await content.json()).toMatchObject({ projectId, threadId, packet: null });

            const forged = await server.handler(
              postJson("/api/civilization/onboarding/preview/content", {
                projectId,
                threadId,
                runId: "run:forged",
                providerInstanceId: "forged-provider",
                runtimeMode: "full-access",
                interactionMode: "default",
              }),
              requestContext,
            );
            expect(forged.status).toBe(200);
          }),
        (server) => Effect.promise(() => server.dispose()),
      );
      expect(yield* Ref.get(calls)).toEqual({ presets: 1, preview: 1, content: 2 });
      expect(yield* Ref.get(contentInputs)).toEqual([
        {
          projectId,
          threadId,
          candidateOverride: { version: CIVILIZATION_CONFIG_VERSION },
        },
        { projectId, threadId },
      ]);
    }),
);

it.effect("routes Project Brief detail/set/clear only through settings-write", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes(adoptionCalls, [
            "orchestration:read",
            "orchestration:operate",
            "settings:write",
          ]),
          { disableLogger: true },
        ),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          const projectId = "project:brief:http";
          const content = {
            version: 1,
            summary: "Operator-authored direction.",
            objectives: ["Keep one bounded brief."],
            constraints: ["Do not treat it as trusted instructions."],
            references: [{ kind: "doc", reference: "docs/PLANNING.v1.5.md" }],
          };

          const detail = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/project-brief/detail?projectId=${encodeURIComponent(projectId)}`,
            ),
            requestContext,
          );
          expect(detail.status).toBe(200);
          expect(await detail.json()).toMatchObject({ projectId, revision: 0, content: null });

          const set = await server.handler(
            postJson("/api/civilization/project-brief/set", {
              projectId,
              expectedRevision: 0,
              content,
            }),
            requestContext,
          );
          expect(set.status).toBe(200);
          expect(await set.json()).toMatchObject({ projectId, revision: 1, content });

          const clear = await server.handler(
            postJson("/api/civilization/project-brief/clear", {
              projectId,
              expectedRevision: 1,
            }),
            requestContext,
          );
          expect(clear.status).toBe(200);
          expect(await clear.json()).toMatchObject({
            projectId,
            revision: 2,
            configured: false,
            content: null,
          });

          const unsafe = await server.handler(
            postJson("/api/civilization/project-brief/set", {
              projectId,
              expectedRevision: 2,
              content: { ...content, summary: "unsafe\u0000brief" },
            }),
            requestContext,
          );
          expect(unsafe.status).toBe(400);
        }),
      (server) => Effect.promise(() => server.dispose()),
    );
  }),
);

it.effect("rejects malformed Civilization context-inspector numeric filters", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(makeRoutes(adoptionCalls, ["orchestration:read"]), {
          disableLogger: true,
        }),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          for (const query of ["limit=abc", "limit=0", "providerTurnOrdinal=-1"]) {
            const response = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/context-inspections?projectId=project%3Afilters&${query}`,
              ),
              requestContext,
            );
            expect(response.status).toBe(400);
          }
        }),
      (server) => Effect.promise(() => server.dispose()),
    );
  }),
);

it.effect("maps bounded Civilization context analytics filters under read scope", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    const analyticsInput = yield* Ref.make<ContextService.CivilizationContextAnalyticsInput | null>(
      null,
    );
    const inspectionInput =
      yield* Ref.make<ContextService.CivilizationContextInspectionListInput | null>(null);
    const projectId = ProjectId.make("project:civilization:http-analytics");
    const providerInstanceId = ProviderInstanceId.make("codex-main");
    const threadId = ThreadId.make("thread:civilization:http-analytics");
    const context = ContextService.CivilizationContextService.of({
      ...fakeContext,
      analytics: (input) =>
        Ref.set(analyticsInput, input).pipe(
          Effect.as({
            projectId,
            from: "2026-10-17T00:00:00.000Z",
            to: "2026-10-18T00:00:00.000Z",
            bucketSize: "hour" as const,
            appliedDiagnosticRetentionDays: 7,
            buckets: [],
          }),
        ),
      listInspections: (input) =>
        Ref.set(inspectionInput, input).pipe(
          Effect.as({ projectId, inspections: [], nextCursor: null, partial: false }),
        ),
    });

    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes(
            adoptionCalls,
            ["orchestration:read"],
            fakeKnowledge,
            fakeMail,
            fakeOperations,
            fakeChronicle,
            context,
          ),
          { disableLogger: true },
        ),
      ),
      (server) =>
        Effect.gen(function* () {
          const response = yield* Effect.promise(() =>
            server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/context-analytics?projectId=${encodeURIComponent(projectId)}&bucket=hour&from=${encodeURIComponent("2026-10-17T00:00:00.000Z")}&to=${encodeURIComponent("2026-10-18T00:00:00.000Z")}&providerInstanceId=${encodeURIComponent(providerInstanceId)}&threadId=${encodeURIComponent(threadId)}&outcome=skipped&suppressionReason=provider_unsupported`,
              ),
              requestContext,
            ),
          );
          expect(response.status).toBe(200);
          expect(yield* Effect.promise(() => response.json())).toMatchObject({
            projectId,
            bucketSize: "hour",
            appliedDiagnosticRetentionDays: 7,
          });
          expect(yield* Ref.get(analyticsInput)).toEqual({
            projectId,
            bucketSize: "hour",
            from: "2026-10-17T00:00:00.000Z",
            to: "2026-10-18T00:00:00.000Z",
            providerInstanceId,
            threadId,
            outcome: "skipped",
            suppressionReason: "provider_unsupported",
          });

          const inspectionResponse = yield* Effect.promise(() =>
            server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/context-inspections?projectId=${encodeURIComponent(projectId)}&from=${encodeURIComponent("2026-10-17T00:00:00.000Z")}&to=${encodeURIComponent("2026-10-18T00:00:00.000Z")}&providerInstanceId=${encodeURIComponent(providerInstanceId)}&threadId=${encodeURIComponent(threadId)}&outcome=skipped&suppressionReason=provider_unsupported&limit=25`,
              ),
              requestContext,
            ),
          );
          expect(inspectionResponse.status).toBe(200);
          expect(yield* Ref.get(inspectionInput)).toEqual({
            projectId,
            from: "2026-10-17T00:00:00.000Z",
            to: "2026-10-18T00:00:00.000Z",
            providerInstanceId,
            threadId,
            outcome: "skipped",
            suppressionReason: "provider_unsupported",
            limit: 25,
          });
        }),
      (server) => Effect.promise(() => server.dispose()),
    );
  }),
);

it.effect("maps bounded Chronicle filters and rejects malformed limits", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    const projectId = ProjectId.make("project:civilization:http-chronicle");
    const threadId = ThreadId.make("thread:civilization:http-chronicle");
    const listInput = yield* Ref.make<ChronicleService.ChronicleListInput | null>(null);
    const chronicle = ChronicleService.CivilizationChronicleService.of({
      ...fakeChronicle,
      list: (input) =>
        Ref.set(listInput, input).pipe(
          Effect.as({
            projectId,
            revision: 9,
            entries: [],
            nextCursor: CivilizationChronicleCursor.make("chronicle-next"),
            partial: true,
          }),
        ),
    });

    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes(
            adoptionCalls,
            ["orchestration:read"],
            fakeKnowledge,
            fakeMail,
            fakeOperations,
            chronicle,
          ),
          { disableLogger: true },
        ),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          const response = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/chronicle?projectId=${encodeURIComponent(projectId)}&kind=child_joined&threadId=${encodeURIComponent(threadId)}&sourceId=${encodeURIComponent("mail:http:source")}&from=${encodeURIComponent("2026-10-17T18:00:00.000Z")}&to=${encodeURIComponent("2026-10-17T22:00:00.000Z")}&cursor=chronicle-cursor&limit=7`,
            ),
            requestContext,
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            revision: 9,
            nextCursor: "chronicle-next",
            partial: true,
          });

          for (const limit of ["0", "abc"]) {
            const invalid = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/chronicle?projectId=${encodeURIComponent(projectId)}&limit=${limit}`,
              ),
              requestContext,
            );
            expect(invalid.status).toBe(400);
          }
        }),
      (server) => Effect.promise(() => server.dispose()),
    ).pipe(
      Effect.andThen(Ref.get(listInput)),
      Effect.tap((input) =>
        Effect.sync(() => {
          expect(input).toEqual({
            projectId,
            kind: "child_joined",
            threadId,
            sourceId: "mail:http:source",
            from: "2026-10-17T18:00:00.000Z",
            to: "2026-10-17T22:00:00.000Z",
            cursor: "chronicle-cursor",
            limit: 7,
          });
        }),
      ),
    );
  }),
);

it.effect("maps bounded achievement reads through orchestration:read", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    const projectId = ProjectId.make("project:civilization:http-achievements");
    const threadId = ThreadId.make("thread:civilization:http-achievements");
    const listInput = yield* Ref.make<ChronicleService.AchievementListInput | null>(null);
    const chronicle = ChronicleService.CivilizationChronicleService.of({
      ...fakeChronicle,
      listAchievements: (input) =>
        Ref.set(listInput, input).pipe(
          Effect.as({
            projectId,
            revision: 5,
            awards: [],
            nextCursor: CivilizationAchievementCursor.make("achievement-next"),
            partial: true,
          }),
        ),
    });

    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes(
            adoptionCalls,
            ["orchestration:read"],
            fakeKnowledge,
            fakeMail,
            fakeOperations,
            chronicle,
          ),
          { disableLogger: true },
        ),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          const response = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/achievements?projectId=${encodeURIComponent(projectId)}&threadId=${encodeURIComponent(threadId)}&cursor=achievement-cursor&limit=4`,
            ),
            requestContext,
          );
          expect(response.status).toBe(200);
          expect(await response.json()).toMatchObject({
            revision: 5,
            nextCursor: "achievement-next",
            partial: true,
          });
        }),
      (server) => Effect.promise(() => server.dispose()),
    ).pipe(
      Effect.andThen(Ref.get(listInput)),
      Effect.tap((input) =>
        Effect.sync(() => {
          expect(input).toEqual({
            projectId,
            threadId,
            cursor: "achievement-cursor",
            limit: 4,
          });
        }),
      ),
    );
  }),
);

it.effect(
  "routes retention inspection and apply through the administrative operations service",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      const projectId = ProjectId.make("project:civilization:http-retention");
      const getInput = yield* Ref.make<ProjectId | null>(null);
      const previewInput = yield* Ref.make<ProjectId | null>(null);
      const applyInput = yield* Ref.make<{
        readonly projectId: ProjectId;
        readonly expectedPreviewToken: string;
      } | null>(null);
      const operations = OperationsService.CivilizationOperationsService.of({
        ...fakeOperations,
        getAppliedRetentionPolicy: (input) =>
          Ref.set(getInput, input).pipe(
            Effect.as({
              noteRetentionDays: 30,
              diagnosticRetentionDays: 7,
              tombstoneRetentionDays: 30,
            }),
          ),
        previewRetentionReduction: (input) =>
          Ref.set(previewInput, input).pipe(
            Effect.as({
              projectId,
              previewToken: "sha256:retention-preview",
              environmentRevision: 2,
              projectRevision: 3,
              current: {
                noteRetentionDays: 30,
                diagnosticRetentionDays: 7,
                tombstoneRetentionDays: 30,
              },
              configured: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
              proposed: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
              newlyEligible: {
                resolvedNotes: 2,
                resolvedNoteBodyBytes: 99,
                diagnosticReferences: 4,
                diagnosticInspections: 2,
                tombstones: 1,
              },
              samples: {
                noteIds: ["note:one"],
                contextReferenceIds: ["context:one"],
                contextInspectionIds: ["inspection:one"],
                tombstoneThreadIds: ["thread:one"],
                partial: true,
              },
              warnings: [
                "Applying this preview changes only approved retention horizons. Scheduled bounded cleanup performs physical deletion afterward.",
                "Active notes and citizen identity are not retention-cleanup candidates.",
              ],
            }),
          ),
        applyRetentionReduction: (input) =>
          Ref.set(applyInput, input).pipe(
            Effect.as({
              projectId,
              applied: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
              newlyEligible: {
                resolvedNotes: 2,
                resolvedNoteBodyBytes: 99,
                diagnosticReferences: 4,
                diagnosticInspections: 2,
                tombstones: 1,
              },
            }),
          ),
      });

      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read", "orchestration:operate", "settings:write"],
              fakeKnowledge,
              fakeMail,
              operations,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const get = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/retention?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(get.status).toBe(200);
            expect(await get.json()).toEqual({
              noteRetentionDays: 30,
              diagnosticRetentionDays: 7,
              tombstoneRetentionDays: 30,
            });

            const preview = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/retention/preview?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(preview.status).toBe(200);
            expect(await preview.json()).toMatchObject({
              projectId,
              previewToken: "sha256:retention-preview",
              newlyEligible: { resolvedNotes: 2, diagnosticReferences: 4 },
            });

            const apply = await server.handler(
              postJson("/api/civilization/retention/apply", {
                projectId,
                expectedPreviewToken: "sha256:retention-preview",
              }),
              requestContext,
            );
            expect(apply.status).toBe(200);
            expect(await apply.json()).toMatchObject({
              projectId,
              applied: {
                noteRetentionDays: 14,
                diagnosticRetentionDays: 3,
                tombstoneRetentionDays: 15,
              },
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      ).pipe(
        Effect.andThen(
          Effect.all({
            get: Ref.get(getInput),
            preview: Ref.get(previewInput),
            apply: Ref.get(applyInput),
          }),
        ),
        Effect.tap((inputs) =>
          Effect.sync(() => {
            expect(inputs.get).toEqual(projectId);
            expect(inputs.preview).toEqual(projectId);
            expect(inputs.apply).toEqual({
              projectId,
              expectedPreviewToken: "sha256:retention-preview",
            });
          }),
        ),
      );
    }),
);

it.effect("serves bounded census and note inspection through the knowledge service", () =>
  Effect.gen(function* () {
    const adoptionCalls = yield* Ref.make(0);
    const searchInput = yield* Ref.make<KnowledgeService.CivilizationCitizenSearchInput | null>(
      null,
    );
    const censusInput = yield* Ref.make<KnowledgeService.CivilizationCensusPageInput | null>(null);
    const lineageInput =
      yield* Ref.make<KnowledgeService.CivilizationLineageNeighborhoodInput | null>(null);
    const notesInput = yield* Ref.make<KnowledgeService.CivilizationNotesPageInput | null>(null);
    const noteReadInput = yield* Ref.make<{
      readonly projectId: ProjectId;
      readonly noteId: CivilizationNoteId;
    } | null>(null);
    const projectId = ProjectId.make("project:civilization:http-knowledge");
    const noteId = CivilizationNoteId.make("note:http-knowledge");
    const lineageThreadId = ThreadId.make("thread:civilization:http-lineage");
    const lineageFocus = {
      threadId: lineageThreadId,
      projectId,
      name: "Lineage Focus",
      profileId: "calm",
      profileLabel: "Calm",
      generation: 0,
      lineageStatus: "resolved" as const,
      parentThreadId: null,
      relationshipToParent: null,
      observedOnly: false,
      epoch: 0,
      closed: false,
      deleted: false,
      titleManaged: true,
      revision: 1,
    };
    const knowledge = KnowledgeService.CivilizationKnowledgeService.of({
      ...fakeKnowledge,
      searchCitizens: (input) =>
        Ref.set(searchInput, input).pipe(
          Effect.as([
            {
              projectId,
              threadId: ThreadId.make("thread:civilization:http-search"),
              displayName: "Ada Search",
              profileLabel: "Calm",
              generation: 1,
              lifecycleState: "open" as const,
              observedOnly: false,
              threadTitle: "Search host title",
            },
          ]),
        ),
      listCensus: (input) =>
        Ref.set(censusInput, input).pipe(
          Effect.as({
            projectId,
            revision: 3,
            citizens: [],
            nextCursor: CivilizationCensusCursor.make("census-next"),
            partial: true,
          }),
        ),
      getLineageNeighborhood: (input) =>
        Ref.set(lineageInput, input).pipe(
          Effect.as({
            projectId,
            revision: 4,
            focus: lineageFocus,
            parent: null,
            parentAvailability: "none" as const,
            children: [],
            nextCursor: CivilizationLineageCursor.make("lineage-next"),
            partial: true,
          }),
        ),
      listNotes: (input) =>
        Ref.set(notesInput, input).pipe(
          Effect.as({
            projectId,
            revision: 5,
            notes: [],
            nextCursor: CivilizationNotesCursor.make("notes-next"),
            partial: true,
          }),
        ),
      readNoteBody: (input) =>
        Ref.set(noteReadInput, input).pipe(
          Effect.as({
            noteId,
            projectId,
            category: "fact",
            bodyBytes: 5,
            authorThreadId: ThreadId.make("thread:civilization:http-knowledge"),
            authorEpoch: 1,
            acceptedRuntimeMode: "approval-required" as const,
            acceptedInteractionMode: "default" as const,
            revision: 1,
            createdAt: "2026-10-16T09:00:00.000Z",
            updatedAt: "2026-10-16T09:00:00.000Z",
            resolvedAt: null,
            body: "hello",
            sourceReferences: [],
          }),
        ),
    });

    return yield* Effect.acquireUseRelease(
      Effect.sync(() =>
        HttpRouter.toWebHandler(
          makeRoutes(
            adoptionCalls,
            ["orchestration:read", "orchestration:operate", "settings:write"],
            knowledge,
          ),
          { disableLogger: true },
        ),
      ),
      (server) =>
        Effect.tryPromise(async () => {
          const search = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/citizens/search?projectId=${encodeURIComponent(projectId)}&query=Ada&limit=20`,
            ),
            requestContext,
          );
          expect(search.status).toBe(200);
          expect(await search.json()).toEqual([
            {
              projectId,
              threadId: "thread:civilization:http-search",
              displayName: "Ada Search",
              profileLabel: "Calm",
              generation: 1,
              lifecycleState: "open",
              observedOnly: false,
              threadTitle: "Search host title",
            },
          ]);

          const census = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/census?projectId=${encodeURIComponent(projectId)}&limit=2`,
            ),
            requestContext,
          );
          expect(census.status).toBe(200);
          expect(await census.json()).toMatchObject({ revision: 3, nextCursor: "census-next" });

          const lineage = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/lineage?projectId=${encodeURIComponent(projectId)}&threadId=${encodeURIComponent(lineageThreadId)}&limit=3`,
            ),
            requestContext,
          );
          expect(lineage.status).toBe(200);
          expect(await lineage.json()).toMatchObject({
            revision: 4,
            focus: { threadId: lineageThreadId },
            nextCursor: "lineage-next",
          });

          const notes = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/notes?projectId=${encodeURIComponent(projectId)}&limit=4&includeResolved=true`,
            ),
            requestContext,
          );
          expect(notes.status).toBe(200);
          expect(await notes.json()).toMatchObject({ revision: 5, nextCursor: "notes-next" });

          const note = await server.handler(
            new Request(
              `http://127.0.0.1/api/civilization/notes/${encodeURIComponent(noteId)}?projectId=${encodeURIComponent(projectId)}`,
            ),
            requestContext,
          );
          expect(note.status).toBe(200);
          expect(await note.json()).toMatchObject({ noteId, body: "hello" });
        }),
      (server) => Effect.promise(() => server.dispose()),
    ).pipe(
      Effect.andThen(
        Effect.all({
          search: Ref.get(searchInput),
          census: Ref.get(censusInput),
          lineage: Ref.get(lineageInput),
          notes: Ref.get(notesInput),
          note: Ref.get(noteReadInput),
        }),
      ),
      Effect.tap((inputs) =>
        Effect.sync(() => {
          expect(inputs.search).toEqual({ projectId, query: "Ada", limit: 20 });
          expect(inputs.census).toEqual({ projectId, cursor: undefined, limit: 2 });
          expect(inputs.lineage).toEqual({
            projectId,
            threadId: lineageThreadId,
            cursor: undefined,
            limit: 3,
          });
          expect(inputs.notes).toEqual({
            projectId,
            cursor: undefined,
            limit: 4,
            includeResolved: true,
          });
          expect(inputs.note).toEqual({ projectId, noteId });
        }),
      ),
    );
  }),
);

it.effect(
  "serves retained admin mail list and raw body only through the administrative boundary",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      const projectId = ProjectId.make("project:civilization:http-mail");
      const messageId = CivilizationMessageId.make("mail:http-admin");
      const listInput = yield* Ref.make<{
        readonly projectId: ProjectId;
        readonly cursor?: string;
        readonly limit?: number;
      } | null>(null);
      const readInput = yield* Ref.make<{
        readonly projectId: ProjectId;
        readonly messageId: CivilizationMessageId;
      } | null>(null);
      const correspondenceInput = yield* Ref.make<MailService.CorrespondenceHistoryInput | null>(
        null,
      );
      const correspondenceThreadInput =
        yield* Ref.make<MailService.CorrespondenceThreadInput | null>(null);
      const summary = {
        messageId,
        contentKind: "text" as const,
        senderThreadId: ThreadId.make("thread:sender"),
        senderNameAtSend: "Ada",
        senderCitizenEpoch: 2,
        senderRunId: RunId.make("run:sender"),
        recipientThreadId: ThreadId.make("thread:recipient"),
        recipientDeliveryEpoch: 4,
        replyToMessageId: null,
        bodyBytes: 5,
        acceptedRuntimeMode: "approval-required" as const,
        acceptedInteractionMode: "default" as const,
        acceptedEnvironmentRevision: 3,
        acceptedProjectRevision: 5,
        acceptedAt: "2026-10-16T10:00:00.000Z",
        expiresAt: "2026-11-15T10:00:00.000Z",
        terminalRetentionDays: 30,
        firstOfferedAt: "2026-10-16T10:01:00.000Z",
        lastOfferedAt: "2026-10-16T10:01:00.000Z",
        offerCount: 1,
        acknowledgedAt: null,
        terminalAt: "2026-10-16T10:02:00.000Z",
        terminalReason: "recipient_archived" as const,
      };
      const mail = MailService.CivilizationMailService.of({
        ...fakeMail,
        listAdminMail: (input) =>
          Ref.set(listInput, input).pipe(
            Effect.as({
              projectId,
              revision: 7,
              messages: [summary],
              nextCursor: CivilizationInboxCursor.make("mail-next"),
              partial: true,
            }),
          ),
        readAdminMessage: (input) =>
          Ref.set(readInput, input).pipe(Effect.as({ projectId, ...summary, body: "hello" })),
        listCorrespondenceHistory: (input) =>
          Ref.set(correspondenceInput, input).pipe(
            Effect.as({
              projectId,
              revision: 8,
              messages: [summary],
              nextCursor: CivilizationCorrespondenceCursor.make("correspondence-next"),
              partial: true,
            }),
          ),
        readCorrespondenceThread: (input) =>
          Ref.set(correspondenceThreadInput, input).pipe(
            Effect.as({
              projectId,
              revision: 8,
              selectedMessageId: messageId,
              entries: [
                {
                  message: summary,
                  relation: "selected" as const,
                  depth: 0,
                  unresolvedParent: false,
                },
              ],
              rootStatus: "resolved" as const,
              ancestorTruncated: false,
              descendantsTruncated: false,
            }),
          ),
      });

      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(
              adoptionCalls,
              ["orchestration:read", "orchestration:operate", "settings:write"],
              fakeKnowledge,
              mail,
            ),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const list = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/inbox?projectId=${encodeURIComponent(projectId)}&limit=2&cursor=mail-cursor`,
              ),
              requestContext,
            );
            expect(list.status).toBe(200);
            expect(await list.json()).toMatchObject({
              projectId,
              revision: 7,
              nextCursor: "mail-next",
              partial: true,
              messages: [{ messageId, terminalReason: "recipient_archived" }],
            });

            const read = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/inbox/${encodeURIComponent(messageId)}?projectId=${encodeURIComponent(projectId)}`,
              ),
              requestContext,
            );
            expect(read.status).toBe(200);
            expect(await read.json()).toMatchObject({ projectId, messageId, body: "hello" });

            const correspondence = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/correspondence?projectId=${encodeURIComponent(projectId)}&participantThreadId=thread%3Asender&counterpartyThreadId=thread%3Arecipient&contentKind=handoff_v1&replyRelation=root&acknowledged=false&terminal=true&deliveryEpoch=4&from=${encodeURIComponent("2026-10-16T09:00:00.000Z")}&to=${encodeURIComponent("2026-10-16T11:00:00.000Z")}&cursor=correspondence-cursor&limit=2`,
              ),
              requestContext,
            );
            expect(correspondence.status).toBe(200);
            expect(await correspondence.json()).toMatchObject({
              projectId,
              revision: 8,
              nextCursor: "correspondence-next",
              partial: true,
              messages: [{ messageId }],
            });

            const thread = await server.handler(
              new Request(
                `http://127.0.0.1/api/civilization/correspondence/${encodeURIComponent(messageId)}/thread?projectId=${encodeURIComponent(projectId)}&ancestorLimit=3&descendantLimit=4`,
              ),
              requestContext,
            );
            expect(thread.status).toBe(200);
            expect(await thread.json()).toMatchObject({
              projectId,
              revision: 8,
              selectedMessageId: messageId,
              rootStatus: "resolved",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      ).pipe(
        Effect.andThen(
          Effect.all({
            list: Ref.get(listInput),
            read: Ref.get(readInput),
            correspondence: Ref.get(correspondenceInput),
            correspondenceThread: Ref.get(correspondenceThreadInput),
          }),
        ),
        Effect.tap((inputs) =>
          Effect.sync(() => {
            expect(inputs.list).toEqual({ projectId, cursor: "mail-cursor", limit: 2 });
            expect(inputs.read).toEqual({ projectId, messageId });
            expect(inputs.correspondence).toEqual({
              projectId,
              participantThreadId: ThreadId.make("thread:sender"),
              counterpartyThreadId: ThreadId.make("thread:recipient"),
              contentKind: "handoff_v1",
              replyRelation: "root",
              acknowledged: false,
              terminal: true,
              deliveryEpoch: 4,
              from: "2026-10-16T09:00:00.000Z",
              to: "2026-10-16T11:00:00.000Z",
              cursor: "correspondence-cursor",
              limit: 2,
            });
            expect(inputs.correspondenceThread).toEqual({
              projectId,
              messageId,
              ancestorLimit: 3,
              descendantLimit: 4,
            });
          }),
        ),
      );
    }),
);

it.effect(
  "commits config and triggers all-existing adoption only after the authoritative commit",
  () =>
    Effect.gen(function* () {
      const adoptionCalls = yield* Ref.make(0);
      return yield* Effect.acquireUseRelease(
        Effect.sync(() =>
          HttpRouter.toWebHandler(
            makeRoutes(adoptionCalls, [
              "orchestration:read",
              "orchestration:operate",
              "settings:write",
            ]),
            { disableLogger: true },
          ),
        ),
        (server) =>
          Effect.tryPromise(async () => {
            const status = await server.handler(
              new Request("http://127.0.0.1/api/civilization/status"),
              requestContext,
            );
            expect(status.status).toBe(200);
            expect(await status.json()).toMatchObject({
              status: "disabled",
              environmentRevision: 0,
            });

            const committed = await server.handler(
              postJson("/api/civilization/config/set", {
                expectedRevision: 0,
                override: {
                  version: CIVILIZATION_CONFIG_VERSION,
                  participation: { enabled: true, adoption: "all_existing" },
                },
              }),
              requestContext,
            );
            expect(committed.status).toBe(200);

            const stale = await server.handler(
              postJson("/api/civilization/config/set", {
                expectedRevision: 0,
                override: {
                  version: CIVILIZATION_CONFIG_VERSION,
                  participation: { enabled: false },
                },
              }),
              requestContext,
            );
            expect(stale.status).toBe(409);
            expect(await stale.json()).toMatchObject({
              code: "civilization_conflict",
              scope: "environment",
            });
          }),
        (server) => Effect.promise(() => server.dispose()),
      ).pipe(
        Effect.andThen(Ref.get(adoptionCalls)),
        Effect.tap((count) => Effect.sync(() => expect(count).toBe(1))),
      );
    }),
);
