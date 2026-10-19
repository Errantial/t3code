import * as Schema from "effect/Schema";
import * as HttpApiSchema from "effect/http-api/HttpApiSchema";

import {
  IsoDateTime,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ProviderDriverKind, ProviderInstanceId } from "./providerInstance.ts";
import { ProviderInteractionMode, RuntimeMode } from "./providerPolicy.ts";

export const CIVILIZATION_CONFIG_VERSION = 2 as const;
export const CIVILIZATION_NAME_GENERATOR_VERSION = 1 as const;
export const CIVILIZATION_MAX_IMPORT_BYTES = 2 * 1024 * 1024;
export const CIVILIZATION_MAX_ENTRY_WEIGHT = 1_000_000;
export const CIVILIZATION_MAX_NAME_ENTRIES = 10_000;
export const CIVILIZATION_MAX_PROFILE_ENTRIES = 100;
export const CIVILIZATION_MAX_POOLS_PER_KIND = 16;
export const CIVILIZATION_MAX_PACKET_BYTES = 16 * 1024;
export const CIVILIZATION_MAX_MESSAGE_BYTES = 16 * 1024;
export const CIVILIZATION_MAX_NOTE_BYTES = 8 * 1024;
export const CIVILIZATION_MAX_RETAINED_BODY_BYTES = 128 * 1024 * 1024;
export const CIVILIZATION_MAX_PROJECT_BRIEF_BYTES = 4 * 1024;
export const CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES = 2 * 1024;
export const CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS = 12;
export const CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES = 512;
export const CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES = 16;
export const CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES = 128;
export const CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES = 1024;
export const CIVILIZATION_CITIZEN_SEARCH_DEFAULT_LIMIT = 10;
export const CIVILIZATION_CITIZEN_SEARCH_MAX_LIMIT = 20;
export const CIVILIZATION_CITIZEN_SEARCH_MIN_QUERY_CHARACTERS = 2;
export const CIVILIZATION_CITIZEN_SEARCH_MAX_QUERY_CHARACTERS = 200;
export const CIVILIZATION_CITIZEN_SEARCH_MAX_QUERY_BYTES = 512;
export const CIVILIZATION_ATTENTION_MAX_ITEMS = 8;
export const CIVILIZATION_MAX_HANDOFF_ITEMS = 8;
export const CIVILIZATION_MAX_HANDOFF_ITEM_BYTES = 512;
export const CIVILIZATION_MAX_HANDOFF_REFERENCES = 16;
export const CIVILIZATION_MAX_HANDOFF_REFERENCE_KIND_BYTES = 128;
export const CIVILIZATION_MAX_HANDOFF_REFERENCE_BYTES = 1024;

const projectBriefUnsafeText = (value: string) =>
  [...value].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return (
      codePoint === 0 ||
      codePoint === 0x7f ||
      (codePoint >= 0x202a && codePoint <= 0x202e) ||
      (codePoint >= 0x2066 && codePoint <= 0x2069)
    );
  });
const projectBriefText = (maxBytes: number, expected: string) =>
  Schema.String.check(
    Schema.makeFilter(
      (value: string) =>
        value.trim().length > 0 &&
        !projectBriefUnsafeText(value) &&
        new TextEncoder().encode(value).byteLength <= maxBytes,
      { expected },
    ),
  );

export const CivilizationWeightedNameEntry = Schema.Struct({
  id: Schema.String,
  displayName: Schema.String,
  weight: Schema.Number,
});
export type CivilizationWeightedNameEntry = typeof CivilizationWeightedNameEntry.Type;

export const CivilizationWeightedProfileEntry = Schema.Struct({
  id: Schema.String,
  label: Schema.String,
  traits: Schema.Array(Schema.String),
  styleText: Schema.String,
  rich: Schema.Struct({
    label: Schema.String,
    traits: Schema.Array(Schema.String),
    axiom: Schema.String,
    voice: Schema.String,
    styleText: Schema.String,
  }),
  weight: Schema.Number,
});
export type CivilizationWeightedProfileEntry = typeof CivilizationWeightedProfileEntry.Type;

export const CivilizationNamePool = Schema.Struct({
  id: Schema.String,
  entries: Schema.Array(CivilizationWeightedNameEntry),
});
export type CivilizationNamePool = typeof CivilizationNamePool.Type;

export const CivilizationProfilePool = Schema.Struct({
  id: Schema.String,
  entries: Schema.Array(CivilizationWeightedProfileEntry),
});
export type CivilizationProfilePool = typeof CivilizationProfilePool.Type;

export const CivilizationParticipationConfig = Schema.Struct({
  enabled: Schema.Boolean,
  emergencyOff: Schema.Boolean,
  adoption: Schema.Literals(["all_existing", "future_only"]),
  includeControllableChildren: Schema.Boolean,
  showObservedAgents: Schema.Boolean,
});

export const CivilizationNamesConfig = Schema.Struct({
  pools: Schema.Array(CivilizationNamePool),
  selectedPoolId: Schema.String,
  titleTemplate: Schema.String,
  automaticTitles: Schema.Boolean,
  adoptionTitlePolicy: Schema.Literals(["preserve", "managed"]),
});

export const CivilizationPersonalitiesConfig = Schema.Struct({
  pools: Schema.Array(CivilizationProfilePool),
  selectedPoolId: Schema.String,
  rendering: Schema.Literals(["off", "mild", "rich"]),
});

export const CivilizationKnowledgeConfig = Schema.Struct({
  noteCategories: Schema.Array(Schema.String),
  noteBytes: Schema.Number,
  activeNotes: Schema.Number,
  retentionDays: Schema.Number,
  packetInclusion: Schema.Boolean,
  ancestorReads: Schema.Boolean,
  showGeneration: Schema.Boolean,
  showParent: Schema.Boolean,
});

export const CivilizationContextConfig = Schema.Struct({
  packetBytes: Schema.Number,
  rosterCount: Schema.Number,
  noteCount: Schema.Number,
  inboxExcerptCount: Schema.Number,
  selection: Schema.Literals(["recent", "stable_id"]),
});

export const CivilizationMessagingConfig = Schema.Struct({
  enabled: Schema.Boolean,
  eligibleThreadKinds: Schema.Array(Schema.Literals(["root", "fork", "subagent"])),
  allowControllableChildren: Schema.Boolean,
  messageBytes: Schema.Number,
  pendingPerRecipient: Schema.Number,
  senderPerMinute: Schema.Number,
  projectPerMinute: Schema.Number,
  retainedMessageCount: Schema.Number,
  retainedBodyBytes: Schema.Number,
  unreadTtlDays: Schema.Number,
  repliesEnabled: Schema.Boolean,
});

export const CivilizationOperationsConfig = Schema.Struct({
  terminalRetentionDays: Schema.Number,
  operationReceiptRetentionDays: Schema.Number,
  diagnosticRetentionDays: Schema.Number,
  tombstoneRetentionDays: Schema.Number,
  cleanupCadenceMinutes: Schema.Number,
  cleanupBatch: Schema.Number,
  censusPageSize: Schema.Number,
  inboxPageSize: Schema.Number,
  responseBodyBytes: Schema.Number,
  diagnostics: Schema.Literals(["off", "errors", "normal"]),
});

export const CivilizationConfig = Schema.Struct({
  version: Schema.Literal(CIVILIZATION_CONFIG_VERSION),
  participation: CivilizationParticipationConfig,
  names: CivilizationNamesConfig,
  personalities: CivilizationPersonalitiesConfig,
  knowledge: CivilizationKnowledgeConfig,
  context: CivilizationContextConfig,
  messaging: CivilizationMessagingConfig,
  operations: CivilizationOperationsConfig,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationConfig = typeof CivilizationConfig.Type;

const CivilizationParticipationOverride = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  emergencyOff: Schema.optional(Schema.Boolean),
  adoption: Schema.optional(Schema.Literals(["all_existing", "future_only"])),
  includeControllableChildren: Schema.optional(Schema.Boolean),
  showObservedAgents: Schema.optional(Schema.Boolean),
});

const CivilizationNamesOverride = Schema.Struct({
  pools: Schema.optional(Schema.Array(CivilizationNamePool)),
  selectedPoolId: Schema.optional(Schema.String),
  titleTemplate: Schema.optional(Schema.String),
  automaticTitles: Schema.optional(Schema.Boolean),
  adoptionTitlePolicy: Schema.optional(Schema.Literals(["preserve", "managed"])),
});

const CivilizationPersonalitiesOverride = Schema.Struct({
  pools: Schema.optional(Schema.Array(CivilizationProfilePool)),
  selectedPoolId: Schema.optional(Schema.String),
  rendering: Schema.optional(Schema.Literals(["off", "mild", "rich"])),
});

const CivilizationKnowledgeOverride = Schema.Struct({
  noteCategories: Schema.optional(Schema.Array(Schema.String)),
  noteBytes: Schema.optional(Schema.Number),
  activeNotes: Schema.optional(Schema.Number),
  retentionDays: Schema.optional(Schema.Number),
  packetInclusion: Schema.optional(Schema.Boolean),
  ancestorReads: Schema.optional(Schema.Boolean),
  showGeneration: Schema.optional(Schema.Boolean),
  showParent: Schema.optional(Schema.Boolean),
});

const CivilizationContextOverride = Schema.Struct({
  packetBytes: Schema.optional(Schema.Number),
  rosterCount: Schema.optional(Schema.Number),
  noteCount: Schema.optional(Schema.Number),
  inboxExcerptCount: Schema.optional(Schema.Number),
  selection: Schema.optional(Schema.Literals(["recent", "stable_id"])),
});

const CivilizationMessagingOverride = Schema.Struct({
  enabled: Schema.optional(Schema.Boolean),
  eligibleThreadKinds: Schema.optional(Schema.Array(Schema.Literals(["root", "fork", "subagent"]))),
  allowControllableChildren: Schema.optional(Schema.Boolean),
  messageBytes: Schema.optional(Schema.Number),
  pendingPerRecipient: Schema.optional(Schema.Number),
  senderPerMinute: Schema.optional(Schema.Number),
  projectPerMinute: Schema.optional(Schema.Number),
  retainedMessageCount: Schema.optional(Schema.Number),
  retainedBodyBytes: Schema.optional(Schema.Number),
  unreadTtlDays: Schema.optional(Schema.Number),
  repliesEnabled: Schema.optional(Schema.Boolean),
});

const CivilizationOperationsOverride = Schema.Struct({
  terminalRetentionDays: Schema.optional(Schema.Number),
  operationReceiptRetentionDays: Schema.optional(Schema.Number),
  diagnosticRetentionDays: Schema.optional(Schema.Number),
  tombstoneRetentionDays: Schema.optional(Schema.Number),
  cleanupCadenceMinutes: Schema.optional(Schema.Number),
  cleanupBatch: Schema.optional(Schema.Number),
  censusPageSize: Schema.optional(Schema.Number),
  inboxPageSize: Schema.optional(Schema.Number),
  responseBodyBytes: Schema.optional(Schema.Number),
  diagnostics: Schema.optional(Schema.Literals(["off", "errors", "normal"])),
});

export const CivilizationConfigOverride = Schema.Struct({
  version: Schema.Literal(CIVILIZATION_CONFIG_VERSION),
  participation: Schema.optional(CivilizationParticipationOverride),
  names: Schema.optional(CivilizationNamesOverride),
  personalities: Schema.optional(CivilizationPersonalitiesOverride),
  knowledge: Schema.optional(CivilizationKnowledgeOverride),
  context: Schema.optional(CivilizationContextOverride),
  messaging: Schema.optional(CivilizationMessagingOverride),
  operations: Schema.optional(CivilizationOperationsOverride),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationConfigOverride = typeof CivilizationConfigOverride.Type;

export const CivilizationDefaultConfig: CivilizationConfig = {
  version: CIVILIZATION_CONFIG_VERSION,
  participation: {
    enabled: false,
    emergencyOff: false,
    adoption: "future_only",
    includeControllableChildren: true,
    showObservedAgents: true,
  },
  names: {
    pools: [
      {
        id: "default-names",
        entries: [
          { id: "ada", displayName: "Ada", weight: 6 },
          { id: "grace", displayName: "Grace", weight: 3 },
          { id: "linus", displayName: "Linus", weight: 1 },
        ],
      },
    ],
    selectedPoolId: "default-names",
    titleTemplate: "[{name}] {topic}",
    automaticTitles: true,
    adoptionTitlePolicy: "preserve",
  },
  personalities: {
    pools: [
      {
        id: "default-profiles",
        entries: [
          {
            id: "calm",
            label: "Calm",
            traits: ["calm", "concise"],
            styleText: "Prefer a calm, concise style without changing task priorities.",
            rich: {
              label: "Stoic Architect",
              traits: ["deliberate", "composed", "structural"],
              axiom: "Build carefully; clarity and sound structure outlast urgency.",
              voice: "Measured, composed, and architectural without becoming ceremonial.",
              styleText:
                "Use a distinctly stoic, architectural voice while staying concise, task-focused, and fully subordinate to the user's instructions.",
            },
            weight: 1,
          },
          {
            id: "explanatory",
            label: "Explanatory",
            traits: ["explanatory", "structured"],
            styleText: "Prefer mildly explanatory, structured phrasing while staying task-focused.",
            rich: {
              label: "Inquisitive Explorer",
              traits: ["curious", "explanatory", "structured"],
              axiom: "Understand the terrain before choosing the path.",
              voice:
                "Curious and lucid, surfacing useful reasoning without wandering beyond scope.",
              styleText:
                "Use an inquisitive, explanatory voice that makes relevant structure visible while remaining disciplined about the requested task.",
            },
            weight: 1,
          },
          {
            id: "reserved",
            label: "Reserved",
            traits: ["reserved", "precise"],
            styleText: "Prefer a reserved, precise presentation without changing task priorities.",
            rich: {
              label: "Skeptical Auditor",
              traits: ["skeptical", "precise", "evidence-minded"],
              axiom: "Claims earn confidence through evidence, not posture.",
              voice: "Reserved and exacting, distinguishing facts, assumptions, and uncertainty.",
              styleText:
                "Use a skeptical-auditor voice that is precise about evidence and uncertainty without becoming obstructive or changing the requested scope.",
            },
            weight: 1,
          },
          {
            id: "conversational",
            label: "Conversational",
            traits: ["conversational", "restrained"],
            styleText:
              "Prefer mildly conversational wording while remaining restrained and task-focused.",
            rich: {
              label: "Pragmatic Craftsman",
              traits: ["pragmatic", "grounded", "craft-focused"],
              axiom: "Prefer the smallest durable solution that does the job well.",
              voice: "Grounded and practical, favoring concrete tradeoffs over flourish.",
              styleText:
                "Use a pragmatic craftsman voice focused on concrete, maintainable outcomes while respecting the exact requested scope and constraints.",
            },
            weight: 1,
          },
          {
            id: "optimizer",
            label: "Focused",
            traits: ["efficient", "focused"],
            styleText: "Prefer efficient, focused presentation without expanding task scope.",
            rich: {
              label: "Obsessive Optimizer",
              traits: ["efficient", "systematic", "focused"],
              axiom: "Remove waste only after correctness and scope are secure.",
              voice:
                "Systematic and efficiency-minded without turning every task into an optimization project.",
              styleText:
                "Use a distinctly optimization-minded voice while preserving correctness, tests, authorization, and the user's requested boundaries above efficiency gains.",
            },
            weight: 1,
          },
        ],
      },
    ],
    selectedPoolId: "default-profiles",
    rendering: "off",
  },
  knowledge: {
    noteCategories: ["fact", "preference"],
    noteBytes: 2 * 1024,
    activeNotes: 200,
    retentionDays: 30,
    packetInclusion: true,
    ancestorReads: true,
    showGeneration: true,
    showParent: true,
  },
  context: {
    packetBytes: 6 * 1024,
    rosterCount: 10,
    noteCount: 3,
    inboxExcerptCount: 5,
    selection: "recent",
  },
  messaging: {
    enabled: true,
    eligibleThreadKinds: ["root", "fork", "subagent"],
    allowControllableChildren: true,
    messageBytes: 4 * 1024,
    pendingPerRecipient: 100,
    senderPerMinute: 10,
    projectPerMinute: 100,
    retainedMessageCount: 10_000,
    retainedBodyBytes: 32 * 1024 * 1024,
    unreadTtlDays: 30,
    repliesEnabled: true,
  },
  operations: {
    terminalRetentionDays: 30,
    operationReceiptRetentionDays: 30,
    diagnosticRetentionDays: 7,
    tombstoneRetentionDays: 30,
    cleanupCadenceMinutes: 60,
    cleanupBatch: 100,
    censusPageSize: 50,
    inboxPageSize: 50,
    responseBodyBytes: 64 * 1024,
    diagnostics: "normal",
  },
};

export const CivilizationConfigScope = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type CivilizationConfigScope = typeof CivilizationConfigScope.Type;

export const CivilizationConfigSource = Schema.Literals(["builtin", "environment", "project"]);
export const CivilizationConfigProvenanceEntry = Schema.Struct({
  path: Schema.String,
  source: CivilizationConfigSource,
});
export const CivilizationWeightedProbability = Schema.Struct({
  id: Schema.String,
  weight: Schema.Number,
  totalWeight: Schema.Number,
  probability: Schema.Number,
});

export const CivilizationEffectiveConfig = Schema.Struct({
  config: CivilizationConfig,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  provenance: Schema.Array(CivilizationConfigProvenanceEntry),
  selectedNameProbabilities: Schema.Array(CivilizationWeightedProbability),
  selectedProfileProbabilities: Schema.Array(CivilizationWeightedProbability),
});
export type CivilizationEffectiveConfig = typeof CivilizationEffectiveConfig.Type;

export const CivilizationProviderSupport = Schema.Literals([
  "full",
  "metadata_only",
  "unsupported",
]);
export type CivilizationProviderSupport = typeof CivilizationProviderSupport.Type;

export const CivilizationProviderCapability = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  support: CivilizationProviderSupport,
  contextInjection: Schema.Boolean,
  keyedContextReplacement: Schema.Boolean,
  actionablePromptRefresh: Schema.Boolean,
  providerContinuationRefresh: Schema.Boolean,
  messaging: Schema.Boolean,
  detail: Schema.optional(Schema.String),
});
export type CivilizationProviderCapability = typeof CivilizationProviderCapability.Type;

export const CivilizationCapabilitiesResult = Schema.Struct({
  providers: Schema.Array(CivilizationProviderCapability),
});
export type CivilizationCapabilitiesResult = typeof CivilizationCapabilitiesResult.Type;

export const CivilizationStatus = Schema.Struct({
  status: Schema.Literals(["disabled", "adopting", "active", "degraded", "unavailable"]),
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  citizenCount: Schema.Number,
  openCitizenCount: Schema.Number,
  providerCapabilities: Schema.optional(Schema.Array(CivilizationProviderCapability)),
  detail: Schema.optional(Schema.String),
});
export type CivilizationStatus = typeof CivilizationStatus.Type;

export const CivilizationAttentionKind = Schema.Literals([
  "adoption_in_progress",
  "civilization_degraded",
  "provider_support_limited",
  "context_provider_start_failures",
  "packet_budget_pressure",
]);
export type CivilizationAttentionKind = typeof CivilizationAttentionKind.Type;

export const CivilizationAttentionSeverity = Schema.Literals(["info", "warning", "error"]);
export type CivilizationAttentionSeverity = typeof CivilizationAttentionSeverity.Type;

export const CivilizationAttentionTarget = Schema.Literals([
  "overview",
  "configuration",
  "context_analytics",
]);
export type CivilizationAttentionTarget = typeof CivilizationAttentionTarget.Type;

export const CivilizationAttentionItem = Schema.Struct({
  key: TrimmedNonEmptyString,
  kind: CivilizationAttentionKind,
  severity: CivilizationAttentionSeverity,
  target: CivilizationAttentionTarget,
  title: TrimmedNonEmptyString,
  detail: TrimmedNonEmptyString,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationAttentionItem = typeof CivilizationAttentionItem.Type;

export const CivilizationAttentionResult = Schema.Struct({
  projectId: ProjectId,
  generatedAt: IsoDateTime,
  items: Schema.Array(CivilizationAttentionItem).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_ATTENTION_MAX_ITEMS)),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationAttentionResult = typeof CivilizationAttentionResult.Type;

export const CivilizationConfigDescription = Schema.Struct({
  version: Schema.Number,
  inheritance: Schema.String,
  applicationTiming: Schema.Struct({
    participation: Schema.String,
    identities: Schema.String,
    personalities: Schema.String,
    messaging: Schema.String,
    retention: Schema.String,
  }),
  limits: Schema.Record(Schema.String, Schema.Number),
});

export const CivilizationConfigValidateRequest = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  override: CivilizationConfigOverride,
});
export const CivilizationConfigValidationResult = Schema.Struct({
  valid: Schema.Literal(true),
  effective: CivilizationEffectiveConfig,
});

export const CivilizationConfigSetRequest = Schema.Union([
  Schema.Struct({
    projectId: Schema.optional(Schema.Undefined),
    expectedRevision: Schema.Number,
    expectedEnvironmentRevision: Schema.optional(Schema.Undefined),
    override: CivilizationConfigOverride,
  }),
  Schema.Struct({
    projectId: ProjectId,
    expectedRevision: Schema.Number,
    expectedEnvironmentRevision: Schema.Number,
    override: CivilizationConfigOverride,
  }),
]);

export const CivilizationConfigResetRequest = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  expectedRevision: Schema.Number,
});

export const CivilizationConfigImportRequest = Schema.Struct({
  projectId: Schema.optional(ProjectId),
  expectedRevision: Schema.Number,
  json: Schema.String,
});

export const CivilizationConfigRevisionResult = Schema.Struct({
  revision: Schema.Number,
  effective: CivilizationEffectiveConfig,
});

export const CivilizationConfigExportResult = Schema.Struct({
  json: Schema.String,
  effective: CivilizationEffectiveConfig,
});

export const CivilizationConfigDiffEntry = Schema.Struct({
  path: Schema.String,
  before: Schema.Unknown,
  after: Schema.Unknown,
});
export const CivilizationConfigDiffResult = Schema.Struct({
  changes: Schema.Array(CivilizationConfigDiffEntry),
  effective: CivilizationEffectiveConfig,
});

export const CivilizationProjectBriefReference = Schema.Struct({
  kind: projectBriefText(
    CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_KIND_BYTES,
    "a safe non-blank Project Brief reference kind within the byte limit",
  ),
  reference: projectBriefText(
    CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCE_BYTES,
    "a safe non-blank Project Brief reference within the byte limit",
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationProjectBriefReference = typeof CivilizationProjectBriefReference.Type;

export const CivilizationProjectBriefContentV1 = Schema.Struct({
  version: Schema.Literal(1),
  summary: projectBriefText(
    CIVILIZATION_MAX_PROJECT_BRIEF_SUMMARY_BYTES,
    "a safe non-blank Project Brief summary within the byte limit",
  ),
  objectives: Schema.Array(
    projectBriefText(
      CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES,
      "a safe non-blank Project Brief objective within the byte limit",
    ),
  ).pipe(Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS))),
  constraints: Schema.Array(
    projectBriefText(
      CIVILIZATION_MAX_PROJECT_BRIEF_ITEM_BYTES,
      "a safe non-blank Project Brief constraint within the byte limit",
    ),
  ).pipe(Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_PROJECT_BRIEF_ITEMS))),
  references: Schema.Array(CivilizationProjectBriefReference).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_PROJECT_BRIEF_REFERENCES)),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationProjectBriefContentV1 = typeof CivilizationProjectBriefContentV1.Type;

export const CivilizationProjectBriefMetadata = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  configured: Schema.Boolean,
  bodyBytes: Schema.Number,
  updatedAt: Schema.NullOr(IsoDateTime),
});
export type CivilizationProjectBriefMetadata = typeof CivilizationProjectBriefMetadata.Type;

export const CivilizationProjectBriefDetail = Schema.Struct({
  ...CivilizationProjectBriefMetadata.fields,
  content: Schema.NullOr(CivilizationProjectBriefContentV1),
});
export type CivilizationProjectBriefDetail = typeof CivilizationProjectBriefDetail.Type;

export const CivilizationProjectBriefSetRequest = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: Schema.Number,
  content: CivilizationProjectBriefContentV1,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationProjectBriefSetRequest = typeof CivilizationProjectBriefSetRequest.Type;

export const CivilizationProjectBriefClearRequest = Schema.Struct({
  projectId: ProjectId,
  expectedRevision: Schema.Number,
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationProjectBriefClearRequest = typeof CivilizationProjectBriefClearRequest.Type;

export const CivilizationLineageStatus = Schema.Literals([
  "resolved",
  "missing",
  "cycle",
  "cross_project",
  "depth_limit",
]);
export type CivilizationLineageStatus = typeof CivilizationLineageStatus.Type;

export const CivilizationRelationshipToParent = Schema.NullOr(
  Schema.Literals(["fork", "subagent"]),
);
export type CivilizationRelationshipToParent = typeof CivilizationRelationshipToParent.Type;

export const CivilizationCitizenSummary = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  name: Schema.String,
  profileId: Schema.String,
  profileLabel: Schema.String,
  generation: Schema.Number,
  lineageStatus: CivilizationLineageStatus,
  parentThreadId: Schema.NullOr(ThreadId),
  relationshipToParent: CivilizationRelationshipToParent,
  observedOnly: Schema.Boolean,
  epoch: Schema.Number,
  closed: Schema.Boolean,
  deleted: Schema.Boolean,
  titleManaged: Schema.Boolean,
  revision: Schema.Number,
});
export type CivilizationCitizenSummary = typeof CivilizationCitizenSummary.Type;

export const CivilizationCitizenSearchQuery = Schema.String.check(
  Schema.makeFilter(
    (value: string) => {
      const trimmed = value.trim();
      const characters = [...trimmed].length;
      return (
        characters >= CIVILIZATION_CITIZEN_SEARCH_MIN_QUERY_CHARACTERS &&
        characters <= CIVILIZATION_CITIZEN_SEARCH_MAX_QUERY_CHARACTERS &&
        new TextEncoder().encode(trimmed).byteLength <= CIVILIZATION_CITIZEN_SEARCH_MAX_QUERY_BYTES
      );
    },
    {
      expected: `a trimmed ${CIVILIZATION_CITIZEN_SEARCH_MIN_QUERY_CHARACTERS}-${CIVILIZATION_CITIZEN_SEARCH_MAX_QUERY_CHARACTERS} character citizen query within ${CIVILIZATION_CITIZEN_SEARCH_MAX_QUERY_BYTES} UTF-8 bytes`,
    },
  ),
);
export type CivilizationCitizenSearchQuery = typeof CivilizationCitizenSearchQuery.Type;

export const CivilizationCitizenSearchLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: CIVILIZATION_CITIZEN_SEARCH_MAX_LIMIT }),
);
export type CivilizationCitizenSearchLimit = typeof CivilizationCitizenSearchLimit.Type;

export const CivilizationCitizenSearchRequest = Schema.Struct({
  projectId: ProjectId,
  query: CivilizationCitizenSearchQuery,
  limit: Schema.optionalKey(CivilizationCitizenSearchLimit),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationCitizenSearchRequest = typeof CivilizationCitizenSearchRequest.Type;

export const CivilizationCitizenSearchResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  displayName: Schema.String,
  profileLabel: Schema.String,
  generation: Schema.Number,
  lifecycleState: Schema.Literals(["open", "settled", "archived"]),
  observedOnly: Schema.Boolean,
  threadTitle: Schema.String,
});
export type CivilizationCitizenSearchResult = typeof CivilizationCitizenSearchResult.Type;

export const CivilizationCitizenDetail = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  identity: Schema.Struct({
    nameEntryId: Schema.String,
    namePoolId: Schema.String,
    baseName: Schema.String,
    displayName: Schema.String,
  }),
  personality: Schema.Struct({
    profileEntryId: Schema.String,
    profilePoolId: Schema.String,
    base: Schema.Struct({
      label: Schema.String,
      traits: Schema.Array(Schema.String),
      styleText: Schema.String,
    }),
    rich: Schema.Struct({
      label: Schema.String,
      traits: Schema.Array(Schema.String),
      axiom: Schema.String,
      voice: Schema.String,
      styleText: Schema.String,
    }),
  }),
  presentation: Schema.Struct({
    rendering: Schema.Literals(["off", "mild", "rich"]),
    label: Schema.NullOr(Schema.String),
  }),
  host: Schema.Struct({
    threadTitle: Schema.String,
    providerInstanceId: ProviderInstanceId,
  }),
  lineage: Schema.Struct({
    generation: Schema.Number,
    status: CivilizationLineageStatus,
    parentThreadId: Schema.NullOr(ThreadId),
    relationshipToParent: CivilizationRelationshipToParent,
  }),
  lifecycle: Schema.Struct({
    state: Schema.Literals(["open", "settled", "archived", "deleted"]),
    epoch: Schema.Number,
    closed: Schema.Boolean,
    deleted: Schema.Boolean,
  }),
  observedOnly: Schema.Boolean,
  title: Schema.Struct({
    managed: Schema.Boolean,
    topic: Schema.String,
    preservedTitle: Schema.NullOr(Schema.String),
    lastManagedTitle: Schema.NullOr(Schema.String),
    managedTitlePreview: Schema.String,
  }),
  revision: Schema.Number,
});
export type CivilizationCitizenDetail = typeof CivilizationCitizenDetail.Type;

export const CivilizationCitizenNameReference = Schema.Struct({
  threadId: ThreadId,
  name: Schema.String,
});
export type CivilizationCitizenNameReference = typeof CivilizationCitizenNameReference.Type;

export const CivilizationCensusCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationCensusCursor"),
);
export type CivilizationCensusCursor = typeof CivilizationCensusCursor.Type;

export const CivilizationCensusPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  citizens: Schema.Array(CivilizationCitizenSummary),
  nextCursor: Schema.NullOr(CivilizationCensusCursor),
  partial: Schema.Boolean,
});
export type CivilizationCensusPage = typeof CivilizationCensusPage.Type;
export const CivilizationLineageCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationLineageCursor"),
);
export type CivilizationLineageCursor = typeof CivilizationLineageCursor.Type;

export const CivilizationLineageParentAvailability = Schema.Literals([
  "none",
  "visible",
  "unavailable",
  "cross_project",
  "cycle",
  "depth_limit",
]);
export type CivilizationLineageParentAvailability =
  typeof CivilizationLineageParentAvailability.Type;

export const CivilizationLineageNeighborhood = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  focus: CivilizationCitizenSummary,
  parent: Schema.NullOr(CivilizationCitizenSummary),
  parentAvailability: CivilizationLineageParentAvailability,
  children: Schema.Array(CivilizationCitizenSummary),
  nextCursor: Schema.NullOr(CivilizationLineageCursor),
  partial: Schema.Boolean,
});
export type CivilizationLineageNeighborhood = typeof CivilizationLineageNeighborhood.Type;

export const CivilizationChronicleEntryId = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationChronicleEntryId"),
);
export type CivilizationChronicleEntryId = typeof CivilizationChronicleEntryId.Type;

export const CivilizationChronicleCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationChronicleCursor"),
);
export type CivilizationChronicleCursor = typeof CivilizationChronicleCursor.Type;

export const CivilizationChronicleKind = Schema.Literals([
  "citizen_joined",
  "citizen_adopted",
  "child_joined",
  "citizen_settled",
  "citizen_returned",
  "citizen_archived",
  "citizen_deleted",
  "identity_reassigned",
  "note_created",
  "note_resolved",
  "mail_sent",
  "mail_acknowledged",
  "mail_terminal",
]);
export type CivilizationChronicleKind = typeof CivilizationChronicleKind.Type;

export const CivilizationChronicleSourceKind = Schema.Literals([
  "host_event",
  "civilization_mutation",
]);
export type CivilizationChronicleSourceKind = typeof CivilizationChronicleSourceKind.Type;

const CivilizationChronicleEntryBase = {
  entryId: CivilizationChronicleEntryId,
  projectId: ProjectId,
  primaryThreadId: Schema.NullOr(ThreadId),
  secondaryThreadId: Schema.NullOr(ThreadId),
  citizenEpoch: Schema.NullOr(Schema.Number),
  citizenRevision: Schema.NullOr(Schema.Number),
  sourceKind: CivilizationChronicleSourceKind,
  sourceId: TrimmedNonEmptyString,
  sourceSequence: Schema.NullOr(Schema.Number),
  occurredAt: IsoDateTime,
} as const;
const CivilizationChronicleEmptyMetadata = Schema.Struct({});
const CivilizationChronicleRelationshipMetadata = Schema.Struct({
  relationship: TrimmedNonEmptyString,
});
const CivilizationChronicleIdentityMetadata = Schema.Struct({
  nameEntryId: TrimmedNonEmptyString,
  profileEntryId: TrimmedNonEmptyString,
});
const CivilizationChronicleNoteCreatedMetadata = Schema.Struct({
  noteId: TrimmedNonEmptyString,
  category: TrimmedNonEmptyString,
});
const CivilizationChronicleNoteMetadata = Schema.Struct({ noteId: TrimmedNonEmptyString });
const CivilizationChronicleMailMetadata = Schema.Struct({ messageId: TrimmedNonEmptyString });
const CivilizationChronicleMailTerminalMetadata = Schema.Struct({
  messageId: TrimmedNonEmptyString,
  terminalReason: TrimmedNonEmptyString,
});

export const CivilizationChronicleEntry = Schema.Union([
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literals([
      "citizen_joined",
      "citizen_adopted",
      "citizen_settled",
      "citizen_returned",
      "citizen_archived",
      "citizen_deleted",
    ]),
    metadata: CivilizationChronicleEmptyMetadata,
  }),
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literal("child_joined"),
    metadata: CivilizationChronicleRelationshipMetadata,
  }),
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literal("identity_reassigned"),
    metadata: CivilizationChronicleIdentityMetadata,
  }),
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literal("note_created"),
    metadata: CivilizationChronicleNoteCreatedMetadata,
  }),
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literal("note_resolved"),
    metadata: CivilizationChronicleNoteMetadata,
  }),
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literals(["mail_sent", "mail_acknowledged"]),
    metadata: CivilizationChronicleMailMetadata,
  }),
  Schema.Struct({
    ...CivilizationChronicleEntryBase,
    kind: Schema.Literal("mail_terminal"),
    metadata: CivilizationChronicleMailTerminalMetadata,
  }),
]);
export type CivilizationChronicleEntry = typeof CivilizationChronicleEntry.Type;

export const CivilizationChroniclePage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  entries: Schema.Array(CivilizationChronicleEntry),
  citizenReferences: Schema.optional(Schema.Array(CivilizationCitizenNameReference)),
  nextCursor: Schema.NullOr(CivilizationChronicleCursor),
  partial: Schema.Boolean,
});
export type CivilizationChroniclePage = typeof CivilizationChroniclePage.Type;

export const CivilizationAchievementAwardId = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationAchievementAwardId"),
);
export type CivilizationAchievementAwardId = typeof CivilizationAchievementAwardId.Type;

export const CivilizationAchievementCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationAchievementCursor"),
);
export type CivilizationAchievementCursor = typeof CivilizationAchievementCursor.Type;

export const CivilizationAchievementId = Schema.Literals([
  "project_founder",
  "first_descendant",
  "first_acknowledged_correspondence",
  "lineage_generation_3",
]);
export type CivilizationAchievementId = typeof CivilizationAchievementId.Type;

export const CivilizationAchievementAward = Schema.Struct({
  awardId: CivilizationAchievementAwardId,
  projectId: ProjectId,
  achievementId: CivilizationAchievementId,
  definitionVersion: Schema.Number,
  subjectThreadId: Schema.NullOr(ThreadId),
  triggerEntryId: CivilizationChronicleEntryId,
  awardedAt: IsoDateTime,
});
export type CivilizationAchievementAward = typeof CivilizationAchievementAward.Type;

export const CivilizationAchievementPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  awards: Schema.Array(CivilizationAchievementAward),
  citizenReferences: Schema.optional(Schema.Array(CivilizationCitizenNameReference)),
  nextCursor: Schema.NullOr(CivilizationAchievementCursor),
  partial: Schema.Boolean,
});
export type CivilizationAchievementPage = typeof CivilizationAchievementPage.Type;

export const CivilizationNoteId = TrimmedNonEmptyString.pipe(Schema.brand("CivilizationNoteId"));
export type CivilizationNoteId = typeof CivilizationNoteId.Type;

export const CivilizationNoteSourceReference = Schema.Struct({
  kind: TrimmedNonEmptyString,
  reference: TrimmedNonEmptyString,
});
export type CivilizationNoteSourceReference = typeof CivilizationNoteSourceReference.Type;

export const CivilizationNoteSummary = Schema.Struct({
  noteId: CivilizationNoteId,
  projectId: ProjectId,
  category: TrimmedNonEmptyString,
  bodyBytes: Schema.Number,
  authorThreadId: ThreadId,
  authorEpoch: Schema.Number,
  acceptedRuntimeMode: RuntimeMode,
  acceptedInteractionMode: ProviderInteractionMode,
  revision: Schema.Number,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  resolvedAt: Schema.NullOr(IsoDateTime),
});
export type CivilizationNoteSummary = typeof CivilizationNoteSummary.Type;

export const CivilizationNoteBody = Schema.Struct({
  ...CivilizationNoteSummary.fields,
  body: Schema.String,
  sourceReferences: Schema.Array(CivilizationNoteSourceReference),
});
export type CivilizationNoteBody = typeof CivilizationNoteBody.Type;

export const CivilizationNoteCreateRequest = Schema.Struct({
  projectId: ProjectId,
  category: TrimmedNonEmptyString,
  body: Schema.String,
  sourceReferences: Schema.optional(Schema.Array(CivilizationNoteSourceReference)),
});
export type CivilizationNoteCreateRequest = typeof CivilizationNoteCreateRequest.Type;

export const CivilizationNoteUpdateRequest = Schema.Struct({
  noteId: CivilizationNoteId,
  projectId: ProjectId,
  expectedRevision: Schema.Number,
  category: Schema.optional(TrimmedNonEmptyString),
  body: Schema.optional(Schema.String),
  sourceReferences: Schema.optional(Schema.Array(CivilizationNoteSourceReference)),
});
export type CivilizationNoteUpdateRequest = typeof CivilizationNoteUpdateRequest.Type;

export const CivilizationNoteResolveRequest = Schema.Struct({
  noteId: CivilizationNoteId,
  projectId: ProjectId,
  expectedRevision: Schema.Number,
  resolved: Schema.Boolean,
});
export type CivilizationNoteResolveRequest = typeof CivilizationNoteResolveRequest.Type;

export const CivilizationNotesCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationNotesCursor"),
);
export type CivilizationNotesCursor = typeof CivilizationNotesCursor.Type;

export const CivilizationNotesPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  notes: Schema.Array(CivilizationNoteSummary),
  nextCursor: Schema.NullOr(CivilizationNotesCursor),
  partial: Schema.Boolean,
});
export type CivilizationNotesPage = typeof CivilizationNotesPage.Type;
export const CivilizationMessageId = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationMessageId"),
);
export type CivilizationMessageId = typeof CivilizationMessageId.Type;

export const CivilizationInboxCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationInboxCursor"),
);
export type CivilizationInboxCursor = typeof CivilizationInboxCursor.Type;

export const CivilizationMailTerminalReason = Schema.Literals([
  "recipient_settled",
  "recipient_archived",
  "recipient_deleted",
  "project_deleted",
  "expired",
  "purged",
]);
export type CivilizationMailTerminalReason = typeof CivilizationMailTerminalReason.Type;

export const CivilizationMailContentKind = Schema.Literals(["text", "handoff_v1"]);
export type CivilizationMailContentKind = typeof CivilizationMailContentKind.Type;

const passiveHandoffText = (maxBytes: number, expected: string) =>
  projectBriefText(maxBytes, expected);

export const CivilizationPassiveHandoffReference = Schema.Struct({
  kind: passiveHandoffText(
    CIVILIZATION_MAX_HANDOFF_REFERENCE_KIND_BYTES,
    "a safe non-blank handoff reference kind within the byte limit",
  ),
  reference: passiveHandoffText(
    CIVILIZATION_MAX_HANDOFF_REFERENCE_BYTES,
    "a safe non-blank handoff reference within the byte limit",
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationPassiveHandoffReference = typeof CivilizationPassiveHandoffReference.Type;

const passiveHandoffItem = passiveHandoffText(
  CIVILIZATION_MAX_HANDOFF_ITEM_BYTES,
  "safe non-blank handoff text within the byte limit",
);

export const CivilizationPassiveHandoffPayloadV1 = Schema.Struct({
  version: Schema.Literal(1),
  summary: passiveHandoffItem,
  completed: Schema.Array(passiveHandoffItem).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_HANDOFF_ITEMS)),
  ),
  decisions: Schema.Array(passiveHandoffItem).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_HANDOFF_ITEMS)),
  ),
  nextActions: Schema.Array(passiveHandoffItem).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_HANDOFF_ITEMS)),
  ),
  blockersOrQuestions: Schema.Array(passiveHandoffItem).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_HANDOFF_ITEMS)),
  ),
  references: Schema.Array(CivilizationPassiveHandoffReference).pipe(
    Schema.check(Schema.isMaxLength(CIVILIZATION_MAX_HANDOFF_REFERENCES)),
  ),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationPassiveHandoffPayloadV1 = typeof CivilizationPassiveHandoffPayloadV1.Type;

export const CivilizationMailSummary = Schema.Struct({
  messageId: CivilizationMessageId,
  contentKind: CivilizationMailContentKind,
  senderThreadId: ThreadId,
  senderNameAtSend: Schema.String,
  senderCitizenEpoch: Schema.Number,
  senderRunId: RunId,
  recipientThreadId: ThreadId,
  recipientDeliveryEpoch: Schema.Number,
  replyToMessageId: Schema.NullOr(CivilizationMessageId),
  bodyBytes: Schema.Number,
  acceptedRuntimeMode: RuntimeMode,
  acceptedInteractionMode: ProviderInteractionMode,
  acceptedEnvironmentRevision: Schema.Number,
  acceptedProjectRevision: Schema.Number,
  acceptedAt: IsoDateTime,
  expiresAt: IsoDateTime,
  terminalRetentionDays: Schema.Number,
  firstOfferedAt: Schema.NullOr(IsoDateTime),
  lastOfferedAt: Schema.NullOr(IsoDateTime),
  offerCount: Schema.Number,
  acknowledgedAt: Schema.NullOr(IsoDateTime),
  terminalAt: Schema.NullOr(IsoDateTime),
  terminalReason: Schema.NullOr(CivilizationMailTerminalReason),
});
export type CivilizationMailSummary = typeof CivilizationMailSummary.Type;

export const CivilizationTextMailBody = Schema.Struct({
  ...CivilizationMailSummary.fields,
  contentKind: Schema.Literal("text"),
  body: Schema.String,
});
export type CivilizationTextMailBody = typeof CivilizationTextMailBody.Type;

export const CivilizationHandoffMailBody = Schema.Struct({
  ...CivilizationMailSummary.fields,
  contentKind: Schema.Literal("handoff_v1"),
  body: Schema.String,
  handoff: CivilizationPassiveHandoffPayloadV1,
});
export type CivilizationHandoffMailBody = typeof CivilizationHandoffMailBody.Type;

export const CivilizationMailBody = Schema.Union([
  CivilizationTextMailBody,
  CivilizationHandoffMailBody,
]);
export type CivilizationMailBody = typeof CivilizationMailBody.Type;

export const CivilizationMailSendRequest = Schema.Struct({
  targetThreadId: ThreadId,
  clientRequestId: TrimmedNonEmptyString,
  body: Schema.String,
  replyToMessageId: Schema.optional(CivilizationMessageId),
});
export type CivilizationMailSendRequest = typeof CivilizationMailSendRequest.Type;

export const CivilizationPassiveHandoffSendRequest = Schema.Struct({
  targetThreadId: ThreadId,
  clientRequestId: TrimmedNonEmptyString,
  handoff: CivilizationPassiveHandoffPayloadV1,
  replyToMessageId: Schema.optional(CivilizationMessageId),
});
export type CivilizationPassiveHandoffSendRequest =
  typeof CivilizationPassiveHandoffSendRequest.Type;

export const CivilizationMailSendResult = Schema.Struct({
  message: CivilizationMailSummary,
});
export type CivilizationMailSendResult = typeof CivilizationMailSendResult.Type;

export const CivilizationInboxListRequest = Schema.Struct({
  cursor: Schema.optional(CivilizationInboxCursor),
  limit: Schema.optional(Schema.Number),
  includeAcknowledged: Schema.optional(Schema.Boolean),
});
export type CivilizationInboxListRequest = typeof CivilizationInboxListRequest.Type;

export const CivilizationInboxPage = Schema.Struct({
  revision: Schema.Number,
  deliveryEpoch: Schema.Number,
  messages: Schema.Array(CivilizationMailSummary),
  nextCursor: Schema.NullOr(CivilizationInboxCursor),
  partial: Schema.Boolean,
});
export type CivilizationInboxPage = typeof CivilizationInboxPage.Type;

export const CivilizationMailReceiveRequest = Schema.Struct({
  clientRequestId: TrimmedNonEmptyString,
  messageId: CivilizationMessageId,
});
export type CivilizationMailReceiveRequest = typeof CivilizationMailReceiveRequest.Type;

export const CivilizationMailReceiveResult = Schema.Struct({
  revision: Schema.Number,
  deliveryEpoch: Schema.Number,
  offeredAt: IsoDateTime,
  message: CivilizationMailBody,
});
export type CivilizationMailReceiveResult = typeof CivilizationMailReceiveResult.Type;

export const CivilizationMailAcknowledgeRequest = Schema.Struct({
  messageId: CivilizationMessageId,
  clientRequestId: TrimmedNonEmptyString,
});
export type CivilizationMailAcknowledgeRequest = typeof CivilizationMailAcknowledgeRequest.Type;

export const CivilizationMailAcknowledgeResult = Schema.Struct({
  messageId: CivilizationMessageId,
  acknowledgedAt: IsoDateTime,
});
export type CivilizationMailAcknowledgeResult = typeof CivilizationMailAcknowledgeResult.Type;

// Administrative retained-mail inspection is deliberately separate from the
// authenticated citizen inbox contracts above. Administrative callers supply
// project scope through their own authorization boundary.
export const CivilizationAdminMailListRequest = Schema.Struct({
  projectId: ProjectId,
  cursor: Schema.optional(CivilizationInboxCursor),
  limit: Schema.optional(Schema.Number),
});
export type CivilizationAdminMailListRequest = typeof CivilizationAdminMailListRequest.Type;

export const CivilizationAdminMailRecord = Schema.Union([
  Schema.Struct({ projectId: ProjectId, ...CivilizationTextMailBody.fields }),
  Schema.Struct({ projectId: ProjectId, ...CivilizationHandoffMailBody.fields }),
]);
export type CivilizationAdminMailRecord = typeof CivilizationAdminMailRecord.Type;

export const CivilizationAdminMailPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  messages: Schema.Array(CivilizationMailSummary),
  nextCursor: Schema.NullOr(CivilizationInboxCursor),
  partial: Schema.Boolean,
});
export type CivilizationAdminMailPage = typeof CivilizationAdminMailPage.Type;

export const CivilizationCorrespondenceCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationCorrespondenceCursor"),
);
export type CivilizationCorrespondenceCursor = typeof CivilizationCorrespondenceCursor.Type;

export const CivilizationCorrespondenceReplyRelation = Schema.Literals([
  "any",
  "root",
  "replies_to",
]);
export type CivilizationCorrespondenceReplyRelation =
  typeof CivilizationCorrespondenceReplyRelation.Type;

export const CivilizationCorrespondenceHistoryPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  messages: Schema.Array(CivilizationMailSummary),
  citizenReferences: Schema.optional(Schema.Array(CivilizationCitizenNameReference)),
  nextCursor: Schema.NullOr(CivilizationCorrespondenceCursor),
  partial: Schema.Boolean,
});
export type CivilizationCorrespondenceHistoryPage =
  typeof CivilizationCorrespondenceHistoryPage.Type;

export const CivilizationCorrespondenceRelation = Schema.Literals([
  "ancestor",
  "selected",
  "descendant",
]);
export type CivilizationCorrespondenceRelation = typeof CivilizationCorrespondenceRelation.Type;

export const CivilizationCorrespondenceThreadEntry = Schema.Struct({
  message: CivilizationMailSummary,
  relation: CivilizationCorrespondenceRelation,
  depth: Schema.Number,
  unresolvedParent: Schema.Boolean,
});
export type CivilizationCorrespondenceThreadEntry =
  typeof CivilizationCorrespondenceThreadEntry.Type;

export const CivilizationCorrespondenceThreadPage = Schema.Struct({
  projectId: ProjectId,
  revision: Schema.Number,
  selectedMessageId: CivilizationMessageId,
  entries: Schema.Array(CivilizationCorrespondenceThreadEntry),
  citizenReferences: Schema.optional(Schema.Array(CivilizationCitizenNameReference)),
  rootStatus: Schema.Literals(["resolved", "missing_parent", "depth_limit"]),
  ancestorTruncated: Schema.Boolean,
  descendantsTruncated: Schema.Boolean,
});
export type CivilizationCorrespondenceThreadPage = typeof CivilizationCorrespondenceThreadPage.Type;

export const CivilizationContextInspectionId = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationContextInspectionId"),
);
export type CivilizationContextInspectionId = typeof CivilizationContextInspectionId.Type;

export const CivilizationContextInspectionCursor = TrimmedNonEmptyString.pipe(
  Schema.brand("CivilizationContextInspectionCursor"),
);
export type CivilizationContextInspectionCursor = typeof CivilizationContextInspectionCursor.Type;

export const CivilizationContextInspectionOutcome = Schema.Literals([
  "skipped",
  "built",
  "provider_start_accepted",
  "provider_start_failed",
]);
export type CivilizationContextInspectionOutcome = typeof CivilizationContextInspectionOutcome.Type;

export const CivilizationContextSuppressionReason = Schema.Literals([
  "participation_disabled",
  "emergency_off",
  "citizen_not_adopted",
  "citizen_deleted",
  "citizen_closed",
  "observed_agent_read_only",
  "provider_unsupported",
  "provider_continuation",
  "provider_command",
  "claude_provider_continuation",
  "claude_slash_command",
  "packet_budget_zero",
  "packet_budget_too_small",
]);
export type CivilizationContextSuppressionReason = typeof CivilizationContextSuppressionReason.Type;

export const CivilizationContextPacketTextState = Schema.Literals([
  "pending_provider_start",
  "retained_normal",
  "retained_error",
  "diagnostics_off",
  "errors_only_accepted_cleared",
  "skipped_no_packet",
]);
export type CivilizationContextPacketTextState = typeof CivilizationContextPacketTextState.Type;

export const CivilizationContextTransport = Schema.Struct({
  kind: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  trust: Schema.Literal("untrusted"),
});
export type CivilizationContextTransport = typeof CivilizationContextTransport.Type;

export const CivilizationContextCompositionSection = Schema.Struct({
  candidates: Schema.Number,
  included: Schema.Number,
  omitted: Schema.Number,
});
export type CivilizationContextCompositionSection =
  typeof CivilizationContextCompositionSection.Type;

export const CivilizationContextComposition = Schema.Struct({
  brief: CivilizationContextCompositionSection,
  roster: CivilizationContextCompositionSection,
  notes: CivilizationContextCompositionSection,
  inbox: CivilizationContextCompositionSection,
});
export type CivilizationContextComposition = typeof CivilizationContextComposition.Type;

export const CivilizationContextBudget = Schema.Struct({
  limitBytes: Schema.Number,
  packetBytes: Schema.Number,
  requiredBytes: Schema.Number,
  briefBytes: Schema.Number,
  rosterBytes: Schema.Number,
  noteBytes: Schema.Number,
  inboxBytes: Schema.Number,
  unusedBytes: Schema.Number,
});
export type CivilizationContextBudget = typeof CivilizationContextBudget.Type;

export const CivilizationContextInspectionSummary = Schema.Struct({
  inspectionId: CivilizationContextInspectionId,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  attemptId: RunAttemptId,
  providerTurnOrdinal: Schema.Number,
  providerInstanceId: ProviderInstanceId,
  providerDriver: ProviderDriverKind,
  outcome: CivilizationContextInspectionOutcome,
  suppressionReason: Schema.NullOr(CivilizationContextSuppressionReason),
  diagnosticsMode: Schema.Literals(["off", "errors", "normal"]),
  packetTextState: CivilizationContextPacketTextState,
  transport: Schema.NullOr(CivilizationContextTransport),
  packetRevision: Schema.NullOr(TrimmedNonEmptyString),
  packetHash: Schema.NullOr(TrimmedNonEmptyString),
  packetBytes: Schema.Number,
  composition: CivilizationContextComposition,
  budget: CivilizationContextBudget,
  contextReferenceId: Schema.NullOr(TrimmedNonEmptyString),
  environmentRevision: Schema.NullOr(Schema.Number),
  projectRevision: Schema.NullOr(Schema.Number),
  citizenRevision: Schema.NullOr(Schema.Number),
  censusRevision: Schema.NullOr(Schema.Number),
  notesRevision: Schema.NullOr(Schema.Number),
  inboxRevision: Schema.NullOr(Schema.Number),
  briefRevision: Schema.NullOr(Schema.Number),
  briefBodyBytes: Schema.Number,
  briefIncluded: Schema.Boolean,
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  providerStartAt: Schema.NullOr(IsoDateTime),
});
export type CivilizationContextInspectionSummary = typeof CivilizationContextInspectionSummary.Type;

export const CivilizationContextInspectionDetail = Schema.Struct({
  ...CivilizationContextInspectionSummary.fields,
  selectedCitizenIds: Schema.Array(ThreadId),
  selectedNoteIds: Schema.Array(CivilizationNoteId),
  selectedInboxIds: Schema.Array(CivilizationMessageId),
  packetText: Schema.NullOr(Schema.String),
});
export type CivilizationContextInspectionDetail = typeof CivilizationContextInspectionDetail.Type;

export const CivilizationContextInspectionPage = Schema.Struct({
  projectId: ProjectId,
  inspections: Schema.Array(CivilizationContextInspectionSummary),
  citizenReferences: Schema.optional(Schema.Array(CivilizationCitizenNameReference)),
  nextCursor: Schema.NullOr(CivilizationContextInspectionCursor),
  partial: Schema.Boolean,
});
export type CivilizationContextInspectionPage = typeof CivilizationContextInspectionPage.Type;

export const CivilizationContextAnalyticsBucketSize = Schema.Literals(["hour", "day"]);
export type CivilizationContextAnalyticsBucketSize =
  typeof CivilizationContextAnalyticsBucketSize.Type;

export const CivilizationContextAnalyticsOutcomeCounts = Schema.Struct({
  skipped: Schema.Number,
  built: Schema.Number,
  providerStartAccepted: Schema.Number,
  providerStartFailed: Schema.Number,
});
export type CivilizationContextAnalyticsOutcomeCounts =
  typeof CivilizationContextAnalyticsOutcomeCounts.Type;

export const CivilizationContextAnalyticsSuppressionCount = Schema.Struct({
  reason: CivilizationContextSuppressionReason,
  count: Schema.Number,
});
export type CivilizationContextAnalyticsSuppressionCount =
  typeof CivilizationContextAnalyticsSuppressionCount.Type;

export const CivilizationContextAnalyticsHistogram = Schema.Struct({
  zero: Schema.Number,
  low: Schema.Number,
  medium: Schema.Number,
  high: Schema.Number,
  over: Schema.Number,
});
export type CivilizationContextAnalyticsHistogram =
  typeof CivilizationContextAnalyticsHistogram.Type;

export const CivilizationContextAnalyticsCompositionTotals = Schema.Struct({
  candidates: Schema.Number,
  included: Schema.Number,
  omitted: Schema.Number,
});
export type CivilizationContextAnalyticsCompositionTotals =
  typeof CivilizationContextAnalyticsCompositionTotals.Type;

export const CivilizationContextAnalyticsBucket = Schema.Struct({
  bucketStart: IsoDateTime,
  bucketEnd: IsoDateTime,
  totalInspections: Schema.Number,
  outcomes: CivilizationContextAnalyticsOutcomeCounts,
  suppressions: Schema.Array(CivilizationContextAnalyticsSuppressionCount),
  packetSize: CivilizationContextAnalyticsHistogram,
  budgetUtilization: CivilizationContextAnalyticsHistogram,
  roster: CivilizationContextAnalyticsCompositionTotals,
  notes: CivilizationContextAnalyticsCompositionTotals,
  inbox: CivilizationContextAnalyticsCompositionTotals,
});
export type CivilizationContextAnalyticsBucket = typeof CivilizationContextAnalyticsBucket.Type;

export const CivilizationContextAnalyticsResult = Schema.Struct({
  projectId: ProjectId,
  from: IsoDateTime,
  to: IsoDateTime,
  bucketSize: CivilizationContextAnalyticsBucketSize,
  appliedDiagnosticRetentionDays: Schema.Number,
  buckets: Schema.Array(CivilizationContextAnalyticsBucket),
});
export type CivilizationContextAnalyticsResult = typeof CivilizationContextAnalyticsResult.Type;

export const CivilizationContextReference = Schema.Struct({
  referenceId: TrimmedNonEmptyString,
  projectId: ProjectId,
  threadId: ThreadId,
  runId: RunId,
  attemptId: RunAttemptId,
  providerTurnOrdinal: Schema.Number,
  providerInstanceId: ProviderInstanceId,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  citizenRevision: Schema.Number,
  censusRevision: Schema.Number,
  notesRevision: Schema.Number,
  inboxRevision: Schema.Number,
  briefRevision: Schema.NullOr(Schema.Number),
  briefBodyBytes: Schema.Number,
  briefIncluded: Schema.Boolean,
  packetHash: TrimmedNonEmptyString,
  packetBytes: Schema.Number,
  selectedCitizenIds: Schema.Array(ThreadId),
  selectedNoteIds: Schema.Array(CivilizationNoteId),
  selectedInboxIds: Schema.Array(CivilizationMessageId),
  createdAt: IsoDateTime,
});
export type CivilizationContextReference = typeof CivilizationContextReference.Type;

export const CivilizationContextResponse = Schema.Struct({
  capability: CivilizationProviderCapability,
  packet: Schema.NullOr(
    Schema.Struct({
      revision: TrimmedNonEmptyString,
      text: Schema.String,
      bytes: Schema.Number,
      reference: CivilizationContextReference,
    }),
  ),
});
export type CivilizationContextResponse = typeof CivilizationContextResponse.Type;

export const CivilizationOnboardingPresetId = Schema.Literals([
  "minimal",
  "standard",
  "rich",
  "custom",
]);
export type CivilizationOnboardingPresetId = typeof CivilizationOnboardingPresetId.Type;

export const CivilizationOnboardingPresetDefinition = Schema.Struct({
  id: CivilizationOnboardingPresetId,
  label: TrimmedNonEmptyString,
  description: TrimmedNonEmptyString,
  candidateOverride: CivilizationConfigOverride,
  changes: Schema.Array(CivilizationConfigDiffEntry),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationOnboardingPresetDefinition =
  typeof CivilizationOnboardingPresetDefinition.Type;

export const CivilizationOnboardingPresetsResult = Schema.Struct({
  projectId: ProjectId,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  presets: Schema.Array(CivilizationOnboardingPresetDefinition),
});
export type CivilizationOnboardingPresetsResult = typeof CivilizationOnboardingPresetsResult.Type;

const CivilizationOnboardingConfigurationOnlyPreviewRequest = Schema.Struct({
  previewKind: Schema.Literal("configuration_only"),
  projectId: ProjectId,
  candidateOverride: Schema.optional(CivilizationConfigOverride),
  providerInstanceId: Schema.optional(ProviderInstanceId),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

const CivilizationOnboardingExactExistingCitizenPreviewRequest = Schema.Struct({
  previewKind: Schema.Literal("exact_existing_citizen"),
  projectId: ProjectId,
  threadId: ThreadId,
  candidateOverride: Schema.optional(CivilizationConfigOverride),
}).annotate({ parseOptions: { onExcessProperty: "error" } });

export const CivilizationOnboardingPreviewRequest = Schema.Union([
  CivilizationOnboardingConfigurationOnlyPreviewRequest,
  CivilizationOnboardingExactExistingCitizenPreviewRequest,
]);
export type CivilizationOnboardingPreviewRequest = typeof CivilizationOnboardingPreviewRequest.Type;

export const CivilizationOnboardingPreviewEligibility = Schema.Struct({
  brief: Schema.Boolean,
  roster: Schema.Boolean,
  notes: Schema.Boolean,
  inbox: Schema.Boolean,
  exactContent: Schema.Boolean,
});
export type CivilizationOnboardingPreviewEligibility =
  typeof CivilizationOnboardingPreviewEligibility.Type;

export const CivilizationOnboardingPreviewResult = Schema.Struct({
  projectId: ProjectId,
  previewKind: Schema.Literals(["configuration_only", "exact_existing_citizen"]),
  effectiveConfig: CivilizationEffectiveConfig,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  changes: Schema.Array(CivilizationConfigDiffEntry),
  capabilities: Schema.Array(CivilizationProviderCapability),
  selectedCapability: Schema.NullOr(CivilizationProviderCapability),
  budget: CivilizationContextBudget,
  composition: CivilizationContextComposition,
  eligibility: CivilizationOnboardingPreviewEligibility,
  warnings: Schema.Array(Schema.String),
});
export type CivilizationOnboardingPreviewResult = typeof CivilizationOnboardingPreviewResult.Type;

export const CivilizationOnboardingContentPreviewRequest = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  candidateOverride: Schema.optional(CivilizationConfigOverride),
}).annotate({ parseOptions: { onExcessProperty: "error" } });
export type CivilizationOnboardingContentPreviewRequest =
  typeof CivilizationOnboardingContentPreviewRequest.Type;

export const CivilizationOnboardingPreviewAuthority = Schema.Struct({
  runId: RunId,
  providerInstanceId: ProviderInstanceId,
  runtimeMode: RuntimeMode,
  interactionMode: ProviderInteractionMode,
});
export type CivilizationOnboardingPreviewAuthority =
  typeof CivilizationOnboardingPreviewAuthority.Type;

export const CivilizationOnboardingContentPreviewResult = Schema.Struct({
  projectId: ProjectId,
  threadId: ThreadId,
  effectiveConfig: CivilizationEffectiveConfig,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  capability: CivilizationProviderCapability,
  authority: CivilizationOnboardingPreviewAuthority,
  budget: CivilizationContextBudget,
  composition: CivilizationContextComposition,
  packet: Schema.NullOr(
    Schema.Struct({
      revisionKind: Schema.Literal("preview_only"),
      previewRevision: TrimmedNonEmptyString,
      text: Schema.String,
      bytes: Schema.Number,
      selectedCitizenIds: Schema.Array(ThreadId),
      selectedNoteIds: Schema.Array(CivilizationNoteId),
      selectedInboxIds: Schema.Array(CivilizationMessageId),
    }),
  ),
  warnings: Schema.Array(Schema.String),
});
export type CivilizationOnboardingContentPreviewResult =
  typeof CivilizationOnboardingContentPreviewResult.Type;

export const CivilizationCitizenIdentityState = Schema.Struct({
  nameEntryId: Schema.String,
  name: Schema.String,
  profileEntryId: Schema.String,
  profileLabel: Schema.String,
});
export type CivilizationCitizenIdentityState = typeof CivilizationCitizenIdentityState.Type;

export const CivilizationCitizenReassignmentRequest = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  expectedCitizenRevision: Schema.Number,
  expectedEnvironmentRevision: Schema.Number,
  expectedProjectRevision: Schema.Number,
  nameEntryId: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  profileEntryId: Schema.optional(Schema.String),
});
export type CivilizationCitizenReassignmentRequest =
  typeof CivilizationCitizenReassignmentRequest.Type;

export const CivilizationCitizenReassignmentPreview = Schema.Struct({
  threadId: ThreadId,
  citizenRevision: Schema.Number,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  current: CivilizationCitizenIdentityState,
  proposed: CivilizationCitizenIdentityState,
});
export type CivilizationCitizenReassignmentPreview =
  typeof CivilizationCitizenReassignmentPreview.Type;

export const CivilizationCitizenTitleRequest = Schema.Struct({
  threadId: ThreadId,
  projectId: ProjectId,
  expectedCitizenRevision: Schema.Number,
});
export type CivilizationCitizenTitleRequest = typeof CivilizationCitizenTitleRequest.Type;

export const CivilizationCitizenTitleResult = Schema.Struct({
  citizen: CivilizationCitizenSummary,
  changed: Schema.Boolean,
  threadTitle: Schema.String,
});
export type CivilizationCitizenTitleResult = typeof CivilizationCitizenTitleResult.Type;

export const CIVILIZATION_EXPORT_SCHEMA_VERSION = 4 as const;

export const CivilizationExportLimitations = Schema.Struct({
  mode: Schema.Literal("inspection_backup_only"),
  inspectionBackupOnly: Schema.Literal(true),
  restorable: Schema.Literal(false),
  excluded: Schema.Array(Schema.String),
});
export type CivilizationExportLimitations = typeof CivilizationExportLimitations.Type;

export const CivilizationProjectDataExport = Schema.Struct({
  schemaVersion: Schema.Literal(CIVILIZATION_EXPORT_SCHEMA_VERSION),
  projectId: ProjectId,
  exportedAt: IsoDateTime,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  effectiveConfig: CivilizationConfig,
  limitations: CivilizationExportLimitations,
  citizens: Schema.Array(Schema.Unknown),
  notes: Schema.Array(Schema.Unknown),
  mail: Schema.Array(Schema.Unknown),
  chronicle: Schema.Array(Schema.Unknown),
  achievements: Schema.Array(Schema.Unknown),
  projectBrief: Schema.NullOr(CivilizationProjectBriefDetail),
});
export type CivilizationProjectDataExport = typeof CivilizationProjectDataExport.Type;

export const CivilizationPurgeCounts = Schema.Struct({
  citizens: Schema.Number,
  notes: Schema.Number,
  noteBodyBytes: Schema.Number,
  messages: Schema.Number,
  messageBodyBytes: Schema.Number,
  chronicleEntries: Schema.Number,
  achievementAwards: Schema.Number,
  contextReferences: Schema.Number,
  contextInspections: Schema.Number,
  receipts: Schema.Number,
  quotaWindows: Schema.Number,
  projectConfigRows: Schema.Number,
  projectStateRows: Schema.Number,
});
export type CivilizationPurgeCounts = typeof CivilizationPurgeCounts.Type;

export const CivilizationPurgePreview = Schema.Struct({
  projectId: ProjectId,
  previewToken: TrimmedNonEmptyString,
  environmentRevision: Schema.Number,
  projectRevision: Schema.Number,
  censusRevision: Schema.Number,
  notesRevision: Schema.Number,
  mailRevision: Schema.Number,
  chronicleRevision: Schema.Number,
  achievementRevision: Schema.Number,
  counts: CivilizationPurgeCounts,
  limitations: CivilizationExportLimitations,
  warnings: Schema.Array(Schema.String),
});
export type CivilizationPurgePreview = typeof CivilizationPurgePreview.Type;

export const CivilizationPurgeApplyRequest = Schema.Struct({
  projectId: ProjectId,
  expectedPreviewToken: TrimmedNonEmptyString,
  batchSize: Schema.optional(Schema.Number),
});
export type CivilizationPurgeApplyRequest = typeof CivilizationPurgeApplyRequest.Type;

export const CivilizationPurgeProgress = Schema.Struct({
  projectId: ProjectId,
  complete: Schema.Boolean,
  deletedThisBatch: Schema.Number,
  remaining: Schema.Number,
  progressState: Schema.Literals(["pending", "in_progress", "complete"]),
  purgeStartedAt: IsoDateTime,
  purgeCompletedAt: Schema.NullOr(IsoDateTime),
});
export type CivilizationPurgeProgress = typeof CivilizationPurgeProgress.Type;

export class CivilizationPurgeConflictError extends Schema.TaggedError<CivilizationPurgeConflictError>()(
  "CivilizationPurgeConflictError",
  {
    code: Schema.Literal("civilization_purge_conflict"),
    projectId: ProjectId,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export const CivilizationOperationInvalidReason = Schema.Literals([
  "disabled",
  "automatic_titles_disabled",
  "invalid_name",
  "name_conflict",
  "unknown_name_entry",
  "unknown_profile_entry",
  "no_changes",
  "citizen_deleted",
  "observed_agent_read_only",
  "title_restore_unavailable",
]);
export type CivilizationOperationInvalidReason = typeof CivilizationOperationInvalidReason.Type;

export class CivilizationOperationInvalidError extends Schema.TaggedError<CivilizationOperationInvalidError>()(
  "CivilizationOperationInvalidError",
  {
    code: Schema.Literal("civilization_invalid_operation"),
    reason: CivilizationOperationInvalidReason,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class CivilizationCitizenNotFoundError extends Schema.TaggedError<CivilizationCitizenNotFoundError>()(
  "CivilizationCitizenNotFoundError",
  {
    code: Schema.Literal("civilization_citizen_not_found"),
    threadId: ThreadId,
  },
  { httpApiStatus: 404 },
) {}

export class CivilizationNoteNotFoundError extends Schema.TaggedError<CivilizationNoteNotFoundError>()(
  "CivilizationNoteNotFoundError",
  {
    code: Schema.Literal("civilization_note_not_found"),
    noteId: CivilizationNoteId,
  },
  { httpApiStatus: 404 },
) {}

export class CivilizationKnowledgeConflictError extends Schema.TaggedError<CivilizationKnowledgeConflictError>()(
  "CivilizationKnowledgeConflictError",
  {
    code: Schema.Literal("civilization_knowledge_conflict"),
    entity: Schema.Literals(["census", "note"]),
    expectedRevision: Schema.Number,
    currentRevision: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

export const CivilizationMailInvalidReason = Schema.Literals([
  "invalid_cursor",
  "invalid_message",
  "message_too_large",
  "invalid_reply",
  "self_send",
  "terminal_message",
  "expired_message",
  "too_many_messages",
  "response_too_large",
  "corrupt_message",
]);
export type CivilizationMailInvalidReason = typeof CivilizationMailInvalidReason.Type;

export class CivilizationMailInvalidError extends Schema.TaggedError<CivilizationMailInvalidError>()(
  "CivilizationMailInvalidError",
  {
    code: Schema.Literal("civilization_mail_invalid"),
    reason: CivilizationMailInvalidReason,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class CivilizationMailNotFoundError extends Schema.TaggedError<CivilizationMailNotFoundError>()(
  "CivilizationMailNotFoundError",
  {
    code: Schema.Literal("civilization_mail_not_found"),
    messageId: CivilizationMessageId,
  },
  { httpApiStatus: 404 },
) {}

export const CivilizationMailConflictReason = Schema.Literals([
  "stale_cursor",
  "idempotency_conflict",
]);
export type CivilizationMailConflictReason = typeof CivilizationMailConflictReason.Type;

export class CivilizationMailConflictError extends Schema.TaggedError<CivilizationMailConflictError>()(
  "CivilizationMailConflictError",
  {
    code: Schema.Literal("civilization_mail_conflict"),
    reason: CivilizationMailConflictReason,
    expectedRevision: Schema.optional(Schema.Number),
    currentRevision: Schema.optional(Schema.Number),
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export const CivilizationMailCapacityScope = Schema.Literals([
  "recipient_pending",
  "project_message_count",
  "project_body_bytes",
]);
export type CivilizationMailCapacityScope = typeof CivilizationMailCapacityScope.Type;

export class CivilizationMailCapacityError extends Schema.TaggedError<CivilizationMailCapacityError>()(
  "CivilizationMailCapacityError",
  {
    code: Schema.Literal("civilization_mail_capacity"),
    scope: CivilizationMailCapacityScope,
    limit: Schema.Number,
    current: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

export const CivilizationMailQuotaScope = Schema.Literals(["sender", "project"]);
export type CivilizationMailQuotaScope = typeof CivilizationMailQuotaScope.Type;

export class CivilizationMailQuotaError extends Schema.TaggedError<CivilizationMailQuotaError>()(
  "CivilizationMailQuotaError",
  {
    code: Schema.Literal("civilization_mail_quota"),
    scope: CivilizationMailQuotaScope,
    limit: Schema.Number,
    retryAt: IsoDateTime,
  },
  { httpApiStatus: 429 },
) {}
export const CivilizationAgentAccessReason = Schema.Literals([
  "disabled",
  "unadopted",
  "observed_agent_read_only",
  "unsupported_provider",
  "closed_citizen",
  "deleted_citizen",
  "stale_epoch",
  "stale_run",
  "forbidden",
]);
export type CivilizationAgentAccessReason = typeof CivilizationAgentAccessReason.Type;

export class CivilizationAgentAccessError extends Schema.TaggedError<CivilizationAgentAccessError>()(
  "CivilizationAgentAccessError",
  {
    code: Schema.Literal("civilization_agent_access_denied"),
    reason: CivilizationAgentAccessReason,
    message: Schema.String,
  },
  { httpApiStatus: 403 },
) {}

export const CivilizationConfigErrorReason = Schema.Literals([
  "invalid_config",
  "invalid_json",
  "unknown_field",
  "invalid_limit",
  "invalid_pool_reference",
  "duplicate_id",
  "duplicate_name",
  "invalid_name",
  "invalid_profile",
  "invalid_title_template",
  "unsafe_weight_total",
  "dependent_override_invalid",
  "import_too_large",
]);
export type CivilizationConfigErrorReason = typeof CivilizationConfigErrorReason.Type;

export class CivilizationConfigInvalidError extends Schema.TaggedError<CivilizationConfigInvalidError>()(
  "CivilizationConfigInvalidError",
  {
    code: Schema.Literal("civilization_invalid_config"),
    reason: CivilizationConfigErrorReason,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class CivilizationConfigConflictError extends Schema.TaggedError<CivilizationConfigConflictError>()(
  "CivilizationConfigConflictError",
  {
    code: Schema.Literal("civilization_conflict"),
    scope: Schema.Literals(["environment", "project", "citizen"]),
    expectedRevision: Schema.Number,
    currentRevision: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

export const CivilizationOnboardingPreviewUnavailableReason = Schema.Literals([
  "citizen_not_found",
  "citizen_not_live",
  "project_mismatch",
  "authority_unavailable",
  "provider_unavailable",
]);
export type CivilizationOnboardingPreviewUnavailableReason =
  typeof CivilizationOnboardingPreviewUnavailableReason.Type;

export class CivilizationOnboardingPreviewUnavailableError extends Schema.TaggedError<CivilizationOnboardingPreviewUnavailableError>()(
  "CivilizationOnboardingPreviewUnavailableError",
  {
    code: Schema.Literal("civilization_onboarding_preview_unavailable"),
    reason: CivilizationOnboardingPreviewUnavailableReason,
    message: Schema.String,
  },
  { httpApiStatus: 409 },
) {}

export const CivilizationProjectBriefInvalidReason = Schema.Literals([
  "invalid_content",
  "content_too_large",
  "project_unavailable",
  "not_configured",
]);
export type CivilizationProjectBriefInvalidReason =
  typeof CivilizationProjectBriefInvalidReason.Type;

export class CivilizationProjectBriefInvalidError extends Schema.TaggedError<CivilizationProjectBriefInvalidError>()(
  "CivilizationProjectBriefInvalidError",
  {
    code: Schema.Literal("civilization_project_brief_invalid"),
    reason: CivilizationProjectBriefInvalidReason,
    message: Schema.String,
  },
  { httpApiStatus: 400 },
) {}

export class CivilizationProjectBriefConflictError extends Schema.TaggedError<CivilizationProjectBriefConflictError>()(
  "CivilizationProjectBriefConflictError",
  {
    code: Schema.Literal("civilization_project_brief_conflict"),
    projectId: ProjectId,
    expectedRevision: Schema.Number,
    currentRevision: Schema.Number,
  },
  { httpApiStatus: 409 },
) {}

export class CivilizationUnavailableError extends Schema.TaggedError<CivilizationUnavailableError>()(
  "CivilizationUnavailableError",
  {
    code: Schema.Literal("civilization_unavailable"),
    reason: Schema.Literals(["storage", "corrupt_state", "unsupported_schema"]),
    message: Schema.String,
  },
  { httpApiStatus: 503 },
) {}

export const CivilizationHttpErrors = [
  CivilizationConfigInvalidError,
  CivilizationConfigConflictError,
  CivilizationOnboardingPreviewUnavailableError,
  CivilizationProjectBriefInvalidError,
  CivilizationProjectBriefConflictError,
  CivilizationUnavailableError,
  CivilizationOperationInvalidError,
  CivilizationCitizenNotFoundError,
  CivilizationNoteNotFoundError,
  CivilizationKnowledgeConflictError,
  CivilizationMailInvalidError,
  CivilizationMailNotFoundError,
  CivilizationMailConflictError,
  CivilizationMailCapacityError,
  CivilizationMailQuotaError,
  CivilizationAgentAccessError,
  CivilizationPurgeConflictError,
] as const;

export const CivilizationAccepted = Schema.Struct({ ok: Schema.Literal(true) }).pipe(
  HttpApiSchema.status(200),
);
