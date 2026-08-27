import { z } from "zod";

export const HUB_API_VERSION = "v1" as const;

export const HUB_LIMITS = {
  maxMutationBodyBytes: 64 * 1024,
  maxQueryCharacters: 256,
  maxCursorBytes: 4 * 1024,
  maxQueryStringBytes: 16 * 1024,
  defaultPageSize: 25,
  maxPageSize: 100,
  maxSearchGroupSize: 50,
  maxJsonResponseBytes: 1024 * 1024,
  maxIdentifierCharacters: 128,
  maxDiagnosticCount: 50,
} as const;

export const HUB_PROBLEM_CODES = [
  "NOT_FOUND",
  "VALIDATION_FAILED",
  "REVISION_CONFLICT",
  "INDEX_MISSING",
  "INDEX_STALE",
  "INDEX_CORRUPT",
  "MIGRATION_REQUIRED",
  "PATH_OUTSIDE_PROJECT",
  "JOB_ALREADY_RUNNING",
  "JOB_FAILED",
  "INVALID_REQUEST",
  "UNAUTHORIZED",
  "ORIGIN_REJECTED",
  "CAPABILITY_UNAVAILABLE",
  "OPERATION_INTERRUPTED",
  "RATE_LIMITED",
  "RESPONSE_TOO_LARGE",
  "INTERNAL_ERROR",
] as const;

export const HUB_JOB_KINDS = [
  "graph_refresh",
  "graph_rebuild",
  "wiki_refresh",
  "wiki_rebuild",
] as const;

export const HUB_JOB_STATES = [
  "queued",
  "running",
  "succeeded",
  "failed",
  "interrupted",
] as const;

export const HUB_JOB_PHASES = [
  "queued",
  "running",
  "refreshing",
  "rebuilding",
  "finalizing",
  "discover",
  "stage",
  "parse",
  "resolve",
  "validate",
  "publish",
  "complete",
  "failed",
  "interrupted",
] as const;

const isoTimestamp = z.string().datetime({ offset: true });
const boundedReason = z.string().trim().min(1).max(512);
const cursor = z.string().refine(
  (value) => new TextEncoder().encode(value).byteLength <= HUB_LIMITS.maxCursorBytes,
  "Cursor exceeds the maximum encoded size.",
);
const identifier = z.string().min(1).max(HUB_LIMITS.maxIdentifierCharacters)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Identifier contains unsafe characters.");
const scaffoldId = z.string().min(1).max(512)
  .refine((value) => !/[\0-\x1f\x7f]/.test(value), "Scaffold ID contains control characters.");
const hubJobId = z.string()
  .regex(/^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Hub job ID.");
const revision = z.string().regex(/^[a-f0-9]{64}$/, "Invalid SHA-256 revision.");
const utf8Text = (maximum: number, minimum = 1) => z.string().min(minimum).max(maximum).refine(
  (value) => new TextEncoder().encode(value).byteLength <= maximum,
  `Text exceeds the ${maximum}-byte display limit.`,
);
const activityDisplayPath = utf8Text(384).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Path must be a safe repository-relative POSIX path.");
const repositoryDisplayPath = utf8Text(1_024).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) return false;
  return value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, "Path must be a safe repository-relative POSIX path.");

export const HubProblemCodeSchema = z.enum(HUB_PROBLEM_CODES);

export const HubDiagnosticSchema = z.object({
  code: z.string().min(1).max(128),
  severity: z.enum(["error", "warning", "info"]),
  message: z.string().min(1).max(2_048),
  path: z.string().min(1).max(4_096).optional(),
}).strict();

/** RFC 9457 problem details plus stable local MEX fields. */
export const HubProblemDetailsSchema = z.object({
  type: z.string().min(1).max(2_048).default("about:blank"),
  title: z.string().min(1).max(256),
  status: z.number().int().min(400).max(599),
  code: HubProblemCodeSchema,
  detail: z.string().min(1).max(4_096),
  instance: z.string().min(1).max(4_096).optional(),
  requestId: z.string().uuid(),
  activeJobId: hubJobId.optional(),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount).optional(),
}).strict();

export const CapabilityStatusSchema = z.object({
  availability: z.enum(["available", "unavailable"]),
  reason: boundedReason.optional(),
}).strict().superRefine((value, context) => {
  if (value.availability === "unavailable" && value.reason === undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "Unavailable capabilities require a reason.",
    });
  }
  if (value.availability === "available" && value.reason !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["reason"],
      message: "Available capabilities cannot carry an unavailable reason.",
    });
  }
});

export const HubCapabilitiesSchema = z.object({
  apiVersion: z.literal(HUB_API_VERSION),
  git: CapabilityStatusSchema,
  activity: CapabilityStatusSchema,
  activityRecord: CapabilityStatusSchema,
  members: z.object({
    read: CapabilityStatusSchema,
    canonicalMutation: CapabilityStatusSchema,
    localSelection: CapabilityStatusSchema,
  }).strict(),
  jobs: CapabilityStatusSchema,
  graph: z.object({
    read: CapabilityStatusSchema,
    refresh: CapabilityStatusSchema,
    rebuild: CapabilityStatusSchema,
  }).strict(),
  wiki: z.object({
    read: CapabilityStatusSchema,
    refresh: CapabilityStatusSchema,
    rebuild: CapabilityStatusSchema,
  }).strict(),
}).strict();

export const HubActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    memberId: identifier,
    displayName: z.string().min(1).max(256),
  }).strict(),
  z.object({
    kind: z.literal("git"),
    name: z.string().min(1).max(256).nullable(),
    email: z.string().min(1).max(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git actor requires a name or email.",
    });
  }
});

export const HubRepositoryContextSchema = z.object({
  scaffoldId,
  name: z.string().min(1).max(256),
  branch: z.string().min(1).max(1_024).nullable(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  dirty: z.boolean(),
}).strict();

export const HubSectionSummarySchema = z.object({
  availability: z.enum(["available", "unavailable"]),
  count: z.number().int().nonnegative().nullable(),
  reason: boundedReason.optional(),
}).strict().superRefine((value, context) => {
  if (value.availability === "unavailable") {
    if (value.count !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["count"],
        message: "Unavailable sections cannot report a count.",
      });
    }
    if (value.reason === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["reason"],
        message: "Unavailable sections require a reason.",
      });
    }
  } else if (value.count === null || value.reason !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Available sections require a count and no unavailable reason.",
    });
  }
});

export const HubAttentionItemSchema = z.object({
  id: identifier,
  kind: z.enum(["health", "job", "activity"]),
  title: z.string().min(1).max(256),
  summary: z.string().min(1).max(1_024),
  tone: z.enum(["neutral", "warning", "critical"]),
  route: z.string().startsWith("/").max(2_048),
}).strict();

export const HomeResponseSchema = z.object({
  observedAt: isoTimestamp,
  repository: HubRepositoryContextSchema,
  actor: HubActorSchema,
  sections: z.object({
    workstreams: HubSectionSummarySchema,
    relays: HubSectionSummarySchema,
    inbox: HubSectionSummarySchema,
    activity: HubSectionSummarySchema,
  }).strict(),
  activeJobs: z.number().int().nonnegative(),
  attention: z.array(HubAttentionItemSchema).max(100),
}).strict();

const teamMemberId = z.string()
  .regex(/^member_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid member ID.");
const teamEventId = z.string()
  .regex(/^event_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Activity event ID.");
const teamWorkstreamId = z.string()
  .regex(/^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Workstream ID.");
const teamOperationId = z.string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/, "Invalid team operation ID.");
const gitObjectId = z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/);
const teamText = (maximum: number) => utf8Text(maximum).refine(
  (value) => value.trim() === value
    && value.normalize("NFC") === value
    && !/[\u0000-\u001f\u007f]/.test(value),
  "Text must be trimmed canonical Unicode without control characters.",
);
const jsonByteLength = (value: unknown) => new TextEncoder()
  .encode(JSON.stringify(value)).byteLength;
const teamActivityAction = teamText(128).refine(
  (value) => /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(value),
  "Activity action must be a lower-case namespaced identifier.",
);
const teamRepositoryPath = utf8Text(4_096).refine((value) => {
  if (value.includes("\0") || value.includes("\\") || value.startsWith("/")) return false;
  if (/^[A-Za-z]:\//.test(value)) return false;
  if (value.normalize("NFC") !== value || /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value)) {
    return false;
  }
  return value.split("/").every(
    (segment) => segment !== "" && segment !== "." && segment !== "..",
  );
}, "Path must be a safe repository-relative POSIX path.");

export const TeamMemberIdSchema = teamMemberId;

export const TeamGitAliasSchema = z.object({
  name: teamText(200).nullable(),
  email: teamText(320).nullable(),
}).strict().superRefine((value, context) => {
  if (value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git alias requires a name or email.",
    });
  }
  if (value.email !== null && (!value.email.includes("@") || /\s/.test(value.email))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["email"],
      message: "The Git alias email is invalid.",
    });
  }
});

export const TeamMemberSchema = z.object({
  schemaVersion: z.literal(1),
  id: teamMemberId,
  displayName: teamText(200),
  gitAliases: z.array(TeamGitAliasSchema).max(32),
  active: z.boolean(),
  sourcePath: teamRepositoryPath,
  revision,
}).strict().superRefine((value, context) => {
  if (value.sourcePath !== `.mex/team/members/${value.id}.md`) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sourcePath"],
      message: "Member source path must match its ID.",
    });
  }
});

const teamActiveFilter = z.union([
  z.boolean(),
  z.enum(["true", "false"]).transform((value) => value === "true"),
]);

export const TeamMemberListRequestSchema = z.object({
  active: teamActiveFilter.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const TeamMemberListResponseSchema = z.object({
  items: z.array(TeamMemberSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.truncated !== (value.nextCursor !== null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["truncated"],
      message: "Member page truncation must match cursor presence.",
    });
  }
});

export const TeamActorRefSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    memberId: teamMemberId,
    displayName: teamText(200).optional(),
  }).strict(),
  z.object({
    kind: z.literal("git"),
    name: teamText(200).nullable(),
    email: teamText(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git actor requires a name or email.",
    });
  }
});

export const TeamCurrentActorResponseSchema = z.object({
  actor: TeamActorRefSchema,
  source: z.enum(["configured-member", "git-alias", "git-fallback", "unknown"]),
  selection: z.object({
    memberId: teamMemberId,
    updatedAt: isoTimestamp,
    revision,
  }).strict().nullable(),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict();

const teamEntityRef = z.object({
  id: teamText(256),
  kind: teamText(64),
  title: teamText(256).optional(),
}).strict();

const teamWorkstreamRef = z.object({
  id: teamWorkstreamId,
  kind: z.literal("workstream"),
  title: teamText(256).optional(),
}).strict();

const teamCodeRef = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("symbol"),
    symbolId: teamText(512),
    fingerprint: teamText(512).optional(),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: teamRepositoryPath,
    fingerprint: teamText(512).optional(),
  }).strict(),
]);

export const TeamActivitySubjectInputSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("entity"), entity: teamEntityRef }).strict(),
  z.object({ kind: z.literal("code"), code: teamCodeRef }).strict(),
  z.object({ kind: z.literal("file"), path: teamRepositoryPath }).strict(),
  z.object({ kind: z.literal("commit"), hash: gitObjectId }).strict(),
]);

const teamMemberAddAction = z.object({
  kind: z.literal("member.add"),
  member: z.object({
    displayName: teamText(200),
    gitAliases: z.array(TeamGitAliasSchema).max(32),
    active: z.boolean().optional(),
  }).strict(),
}).strict();

const teamMemberUpdateAction = z.object({
  kind: z.literal("member.update"),
  memberId: teamMemberId,
  patch: z.object({
    displayName: teamText(200).optional(),
    gitAliases: z.array(TeamGitAliasSchema).max(32).optional(),
  }).strict().refine(
    (value) => value.displayName !== undefined || value.gitAliases !== undefined,
    "A member update requires at least one supported field.",
  ),
}).strict();

const teamIdentityActivityAction = z.discriminatedUnion("kind", [
  teamMemberAddAction,
  teamMemberUpdateAction,
  z.object({ kind: z.literal("member.deactivate"), memberId: teamMemberId }).strict(),
  z.object({ kind: z.literal("member.select"), memberId: teamMemberId }).strict(),
  z.object({ kind: z.literal("member.clear") }).strict(),
  z.object({
    kind: z.literal("activity.record"),
    activity: z.object({
      action: teamActivityAction,
      subjects: z.array(TeamActivitySubjectInputSchema).max(64),
      workstream: teamWorkstreamRef.optional(),
    }).strict(),
  }).strict(),
]);

const teamRevisionExpectation = z.union([
  z.object({
    target: z.object({ kind: z.literal("artifact"), path: teamRepositoryPath }).strict(),
    revision: revision.nullable(),
  }).strict(),
  z.object({
    target: z.object({
      kind: z.literal("local"),
      namespace: z.literal("member-selection"),
      id: z.literal("current"),
    }).strict(),
    revision: revision.nullable(),
  }).strict(),
]);

export const TeamOperationPreviewRequestSchema = z.object({
  operationId: teamOperationId,
  action: teamIdentityActivityAction,
  expectedRevisions: z.array(teamRevisionExpectation).max(64),
}).strict().superRefine((value, context) => {
  if (
    value.action.kind !== "member.add"
    && value.action.kind !== "activity.record"
    && value.expectedRevisions.length === 0
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["expectedRevisions"],
      message: "Existing-target operations require a revision expectation.",
    });
  }
});

const teamFileChangeBase = {
  path: teamRepositoryPath,
  diff: utf8Text(64 * 1024, 0),
} as const;

export const TeamFileChangeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("create"),
    ...teamFileChangeBase,
    beforeRevision: z.null(),
    afterRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("update"),
    ...teamFileChangeBase,
    beforeRevision: revision,
    afterRevision: revision,
  }).strict(),
  z.object({
    kind: z.literal("delete"),
    ...teamFileChangeBase,
    beforeRevision: revision,
    afterRevision: z.null(),
  }).strict(),
  z.object({
    kind: z.literal("move"),
    ...teamFileChangeBase,
    previousPath: teamRepositoryPath,
    beforeRevision: revision,
    afterRevision: revision,
  }).strict(),
]);

export const TeamLocalChangeSchema = z.object({
  namespace: z.literal("member-selection"),
  id: z.literal("current"),
  beforeRevision: revision.nullable(),
  afterRevision: revision.nullable(),
  summary: teamText(2_048),
}).strict();

const teamPublicPreview = z.object({
  valid: z.boolean(),
  scope: z.enum(["canonical", "local", "mixed"]),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(TeamLocalChangeSchema).max(16),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
}).strict();

const teamRepositoryState = z.object({
  branch: teamText(1_024).nullable(),
  head: gitObjectId.nullable(),
  dirty: z.boolean(),
  observedAt: isoTimestamp,
}).strict();

const teamPurposeId = z.discriminatedUnion("purpose", [
  z.object({ purpose: z.literal("activity"), id: teamEventId }).strict(),
  z.object({ purpose: z.literal("member"), id: teamMemberId }).strict(),
]);

export const TeamOperationReceiptSchema = z.object({
  schemaVersion: z.literal(1),
  authority: z.object({
    actor: TeamActorRefSchema,
    occurredAt: isoTimestamp,
    repoState: teamRepositoryState,
  }).strict(),
  purposeIds: z.array(teamPurposeId).max(2),
  requestRevision: revision,
  presentationRevision: revision,
  previewRevision: revision,
}).strict().superRefine((value, context) => {
  const keys = value.purposeIds.map(({ purpose, id }) => `${purpose}\0${id}`);
  if (new Set(keys).size !== keys.length || keys.some((key, index) => (
    index > 0 && key <= keys[index - 1]!
  ))) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["purposeIds"],
      message: "Purpose IDs must be unique and sorted.",
    });
  }
  if (jsonByteLength(value) > 8 * 1024) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The team operation receipt exceeds 8 KiB.",
    });
  }
});

export const TeamOperationPreviewResponseSchema = z.object({
  schemaVersion: z.literal(1),
  request: TeamOperationPreviewRequestSchema,
  preview: teamPublicPreview,
  receipt: TeamOperationReceiptSchema,
}).strict().superRefine((value, context) => {
  if (jsonByteLength(value) > HUB_LIMITS.maxMutationBodyBytes) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "The team operation preview exceeds 64 KiB.",
    });
  }
});

export const TeamOperationApplyRequestSchema = TeamOperationPreviewResponseSchema;

export const TeamActivityEventSchema = z.object({
  schemaVersion: z.literal(1),
  id: teamEventId,
  timestamp: isoTimestamp,
  actor: TeamActorRefSchema,
  action: teamActivityAction,
  subjects: z.array(TeamActivitySubjectInputSchema).max(64),
  workstream: teamWorkstreamRef.nullable(),
  repoState: teamRepositoryState,
}).strict();

export const TeamOperationApplyResponseSchema = z.object({
  operationId: teamOperationId,
  previewRevision: revision,
  applied: z.literal(true),
  idempotentReplay: z.boolean(),
  changes: z.array(TeamFileChangeSchema).max(16),
  localChanges: z.array(TeamLocalChangeSchema).max(16),
  members: z.array(TeamMemberSchema).max(1),
  events: z.array(TeamActivityEventSchema).max(1),
}).strict();

export const GraphSymbolIdSchema = z.string().min(1).max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/, "Graph symbol ID contains unsafe characters.");

export const GraphSymbolSchema = z.object({
  id: GraphSymbolIdSchema,
  symbolKind: utf8Text(128),
  name: utf8Text(512),
  qualifiedName: utf8Text(1_024),
  language: utf8Text(128),
  path: repositoryDisplayPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  signature: utf8Text(2_048).optional(),
  route: z.string().startsWith("/code/symbols/").max(2_048),
}).strict();

export const WikiEntityIdSchema = z.string()
  .regex(/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/, "Invalid Wiki entity ID.");

export const WikiLifecycleStateSchema = z.enum([
  "in_flight",
  "promoted",
  "deprecated",
  "archived",
]);

export const WikiGroundingHealthSchema = z.enum([
  "fresh",
  "changed",
  "missing",
  "ambiguous",
  "unverified",
]);

const wikiDisplayText = (maximum: number, minimum = 1) => utf8Text(maximum, minimum)
  .refine(
    (value) => value.normalize("NFC") === value
      && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value),
    "Wiki display text contains unsafe characters.",
  );
const wikiKind = wikiDisplayText(128)
  .refine((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value), "Invalid Wiki entity kind.");
const wikiSourceType = wikiDisplayText(128)
  .refine((value) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value), "Invalid Wiki source type.");

export const WikiEntityRefSchema = z.object({
  id: WikiEntityIdSchema,
  kind: wikiKind,
  title: wikiDisplayText(512).nullable(),
}).strict();

export const WikiEntitySummarySchema = z.object({
  id: WikiEntityIdSchema,
  kind: wikiKind,
  title: wikiDisplayText(512),
  summary: wikiDisplayText(2_048, 0).nullable(),
  lifecycleState: WikiLifecycleStateSchema,
  groundingHealth: WikiGroundingHealthSchema,
  topics: z.array(WikiEntityIdSchema).max(50),
  topicsTruncated: z.boolean(),
  sourceTypes: z.array(wikiSourceType).max(50),
  sourceTypesTruncated: z.boolean(),
  location: z.object({
    path: repositoryDisplayPath,
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  }).strict(),
  version: z.object({
    semanticRevision: z.number().int().nonnegative(),
    contentHash: revision,
  }).strict(),
  diagnostics: z.array(HubDiagnosticSchema).max(10),
  diagnosticsTruncated: z.boolean(),
  route: z.string().startsWith("/knowledge/").max(2_048),
}).strict().superRefine((value, context) => {
  if (value.location.endLine < value.location.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["location"], message: "A Wiki source range cannot end before it starts." });
  }
  if (value.route !== `/knowledge/${encodeURIComponent(value.id)}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["route"], message: "A Knowledge route must identify its entity." });
  }
});

export const WikiSearchResultSchema = z.object({
  id: WikiEntityIdSchema,
  kind: z.literal("wiki"),
  entityKind: wikiKind,
  title: wikiDisplayText(512),
  summary: wikiDisplayText(2_048, 0).nullable(),
  lifecycleState: WikiLifecycleStateSchema,
  groundingHealth: WikiGroundingHealthSchema,
  topics: z.array(WikiEntityIdSchema).max(50),
  topicsTruncated: z.boolean(),
  sourceTypes: z.array(wikiSourceType).max(50),
  sourceTypesTruncated: z.boolean(),
  path: repositoryDisplayPath,
  matchedFields: z.array(z.enum(["id", "title", "summary", "body"])).max(4),
  route: z.string().startsWith("/knowledge/").max(2_048),
}).strict();

export const SymbolSearchResultSchema = GraphSymbolSchema.extend({
  kind: z.literal("code_symbol"),
}).strict();

export const SourceSearchResultSchema = z.object({
  id: identifier,
  kind: z.literal("source_chunk"),
  path: repositoryDisplayPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  preview: utf8Text(2_048, 0),
  previewTruncated: z.boolean(),
  matchedTerms: z.array(utf8Text(128)).max(32),
  symbolIds: z.array(GraphSymbolIdSchema).max(8),
  route: z.string().startsWith("/code").max(2_048).optional(),
}).strict();

export const SearchResultSchema = z.discriminatedUnion("kind", [
  WikiSearchResultSchema,
  SymbolSearchResultSchema,
  SourceSearchResultSchema,
]);

export const SearchGroupSchema = z.object({
  status: z.enum(["available", "unavailable", "failed"]),
  items: z.array(SearchResultSchema).max(HUB_LIMITS.maxSearchGroupSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  revision: revision.nullable(),
  code: HubProblemCodeSchema.optional(),
  detail: z.string().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (value.status !== "available") {
    if (
      value.items.length !== 0
      || value.nextCursor !== null
      || value.truncated
      || value.revision !== null
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Unavailable or failed search groups cannot contain results.",
      });
    }
    if (value.detail === undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["detail"],
        message: "Unavailable or failed search groups require detail.",
      });
    }
    if (value.status === "failed" && value.code === undefined) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["code"], message: "Failed search groups require a stable problem code." });
    }
  } else {
    if (value.revision === null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["revision"], message: "Available search groups require a snapshot revision." });
    }
    if (value.detail !== undefined || value.code !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Available search groups cannot carry failure details.",
      });
    }
  }
});

export const SearchRequestSchema = z.object({
  q: z.string().trim().min(1).max(HUB_LIMITS.maxQueryCharacters),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
  wikiCursor: cursor.optional(),
  symbolCursor: cursor.optional(),
  sourceCursor: cursor.optional(),
}).strict();

export const SearchResponseSchema = z.object({
  query: z.string().min(1).max(HUB_LIMITS.maxQueryCharacters),
  observedAt: isoTimestamp,
  groups: z.object({
    wiki: SearchGroupSchema,
    symbols: SearchGroupSchema,
    sources: SearchGroupSchema,
  }).strict(),
}).strict().superRefine((value, context) => {
  const expectedKinds = { wiki: "wiki", symbols: "code_symbol", sources: "source_chunk" } as const;
  for (const group of Object.keys(expectedKinds) as Array<keyof typeof expectedKinds>) {
    if (value.groups[group].items.some((item) => item.kind !== expectedKinds[group])) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["groups", group, "items"],
        message: `The ${group} group contains a result from another search domain.`,
      });
    }
    for (const [index, item] of value.groups[group].items.entries()) {
      if (item.kind !== "wiki" && item.endLine < item.startLine) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", group, "items", index],
          message: "A graph search range cannot end before it starts.",
        });
      }
      if (
        item.kind === "code_symbol"
        && item.route !== `/code/symbols/${encodeURIComponent(item.id)}`
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["groups", group, "items", index, "route"],
          message: "A graph symbol route must identify the projected symbol.",
        });
      }
    }
  }
});

export const CodeWorkspaceViewSchema = z.enum(["overview", "callers", "callees", "impact"]);

export const CodeWorkspaceRequestSchema = z.object({
  view: CodeWorkspaceViewSchema.default("overview"),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(50).optional(),
  depth: z.coerce.number().int().min(1).max(4).optional(),
  sourceCursor: cursor.optional(),
}).strict().superRefine((value, context) => {
  const relationView = value.view === "callers" || value.view === "callees";
  if (!relationView && (value.cursor !== undefined || value.limit !== undefined)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Traversal cursors and limits are valid only for callers or callees." });
  }
  if (value.view !== "impact" && value.depth !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["depth"], message: "Impact depth is valid only for the impact view." });
  }
});

export const GraphSourceProjectionSchema = z.object({
  path: repositoryDisplayPath,
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  content: utf8Text(128 * 1_024, 0),
  contentHash: revision,
  symbolIds: z.array(GraphSymbolIdSchema).max(100),
}).strict().refine((value) => value.endLine >= value.startLine, {
  message: "A source range cannot end before it starts.",
});

export const GraphSourcePageSchema = z.object({
  items: z.array(GraphSourceProjectionSchema).max(100),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict();

export const GraphRelationSchema = z.object({
  kind: utf8Text(128),
  sourceId: GraphSymbolIdSchema,
  targetId: GraphSymbolIdSchema,
  path: repositoryDisplayPath.optional(),
  line: z.number().int().positive().optional(),
  column: z.number().int().nonnegative().optional(),
  confidence: z.number().min(0).max(1).optional(),
  provenance: utf8Text(128).optional(),
}).strict();

export const GraphOverviewTraversalSchema = z.object({
  view: z.literal("overview"),
}).strict();

export const GraphRelationTraversalSchema = z.object({
  view: z.enum(["callers", "callees"]),
  items: z.array(GraphRelationSchema).max(50),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict();

export const GraphImpactTraversalSchema = z.object({
  view: z.literal("impact"),
  targetId: GraphSymbolIdSchema,
  roots: z.array(GraphSymbolSchema).max(100),
  impacted: z.array(z.object({
    symbol: GraphSymbolSchema,
    depth: z.number().int().nonnegative().max(4),
    rootId: GraphSymbolIdSchema,
  }).strict()).max(100),
  relations: z.array(GraphRelationSchema).max(500),
  truncated: z.boolean(),
}).strict();

export const CodeWorkspaceTraversalSchema = z.discriminatedUnion("view", [
  GraphOverviewTraversalSchema,
  GraphRelationTraversalSchema,
  GraphImpactTraversalSchema,
]);

export const CodeWorkspaceResponseSchema = z.object({
  revision,
  symbol: GraphSymbolSchema,
  source: GraphSourcePageSchema,
  view: CodeWorkspaceViewSchema,
  traversal: CodeWorkspaceTraversalSchema,
}).strict().superRefine((value, context) => {
  if (value.view !== value.traversal.view) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["traversal"], message: "The traversal payload must match the requested view." });
  }
  if (value.symbol.endLine < value.symbol.startLine) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol"], message: "A graph symbol range cannot end before it starts." });
  }
  if (value.symbol.route !== `/code/symbols/${encodeURIComponent(value.symbol.id)}`) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["symbol", "route"], message: "The symbol route must identify the projected symbol." });
  }
  for (const [index, source] of value.source.items.entries()) {
    if (source.endLine < source.startLine) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["source", "items", index], message: "A source range cannot end before it starts." });
    }
  }
});

export const WikiEntityListRequestSchema = z.object({
  kind: wikiKind.optional(),
  topic: WikiEntityIdSchema.optional(),
  lifecycle: WikiLifecycleStateSchema.optional(),
  grounding: WikiGroundingHealthSchema.optional(),
  sourceType: wikiSourceType.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const WikiEntityListResponseSchema = z.object({
  indexedRevision: revision,
  observedAt: isoTimestamp,
  items: z.array(WikiEntitySummarySchema).max(HUB_LIMITS.maxSearchGroupSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.nextCursor !== null && !value.truncated) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["truncated"], message: "A paginated Wiki response must report truncation." });
  }
});

export const WikiProvenanceSchema = z.object({
  kind: z.enum(["human", "agent", "system", "migration", "unknown"]),
  id: wikiDisplayText(256).nullable(),
  capturedAt: isoTimestamp.nullable(),
}).strict();

export const WikiSourceSchema = z.object({
  type: wikiSourceType,
  ref: wikiDisplayText(2_048, 0).nullable(),
  note: wikiDisplayText(2_048, 0).nullable(),
  repository: wikiDisplayText(512, 0).nullable(),
  commit: wikiDisplayText(128, 0).nullable(),
  capturedAt: isoTimestamp.nullable(),
}).strict();

export const WikiGroundingCandidateSchema = z.object({
  node: wikiDisplayText(512),
  fingerprint: wikiDisplayText(256, 0).nullable(),
  file: repositoryDisplayPath.nullable(),
  score: z.number().finite().nullable(),
}).strict();

export const WikiGroundingSchema = z.object({
  state: z.enum(["fresh", "stale", "missing", "unresolved", "ungrounded"]),
  health: WikiGroundingHealthSchema,
  requestedNode: wikiDisplayText(512, 0).nullable(),
  resolvedNode: wikiDisplayText(512, 0).nullable(),
  fingerprint: wikiDisplayText(256, 0).nullable(),
  file: repositoryDisplayPath.nullable(),
  commit: wikiDisplayText(128, 0).nullable(),
  verifiedAt: isoTimestamp.nullable(),
  reason: wikiDisplayText(1_024, 0).nullable(),
  candidates: z.array(WikiGroundingCandidateSchema).max(8),
  candidatesTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  const validHealth = value.state === "fresh" ? value.health === "fresh"
    : value.state === "stale" ? value.health === "changed"
      : value.state === "missing" ? value.health === "missing"
        : value.state === "unresolved" ? ["ambiguous", "unverified"].includes(value.health)
          : value.health === "unverified";
  if (!validHealth) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["health"], message: "Wiki grounding state and health contradict one another." });
  }
  if (value.state === "ungrounded") {
    if (value.requestedNode !== null || value.fingerprint !== null) {
      context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedNode"], message: "Ungrounded Wiki entries cannot identify a requested code node." });
    }
  } else if (value.requestedNode === null || value.fingerprint === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["requestedNode"], message: "A grounded Wiki entry requires its canonical node and fingerprint." });
  }
  if (value.state === "fresh" && value.resolvedNode === null) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["resolvedNode"], message: "A fresh Wiki grounding requires its resolved code node." });
  }
});

export const WikiEntityDetailResponseSchema = z.object({
  indexedRevision: revision,
  observedAt: isoTimestamp,
  entity: WikiEntitySummarySchema,
  body: z.object({
    content: utf8Text(128 * 1_024, 0),
    totalBytes: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  provenance: WikiProvenanceSchema.nullable(),
  sources: z.object({
    items: z.array(WikiSourceSchema).max(50),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  groundings: z.object({
    items: z.array(WikiGroundingSchema).max(50),
    total: z.number().int().nonnegative(),
    truncated: z.boolean(),
  }).strict(),
  relationCount: z.number().int().nonnegative(),
  backlinkCount: z.number().int().nonnegative(),
}).strict().superRefine((value, context) => {
  if (value.sources.total < value.sources.items.length || value.groundings.total < value.groundings.items.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Wiki detail totals cannot be smaller than their bounded previews." });
  }
  if (value.sources.truncated !== (value.sources.total > value.sources.items.length)
    || value.groundings.truncated !== (value.groundings.total > value.groundings.items.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: "Wiki detail preview truncation must match its exact totals." });
  }
  if (value.body.truncated !== (value.body.totalBytes > new TextEncoder().encode(value.body.content).byteLength)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["body", "truncated"], message: "Wiki body truncation must match its exact byte count." });
  }
});

export const WikiRelationSchema = z.object({
  type: wikiDisplayText(128),
  source: WikiEntityRefSchema,
  target: WikiEntityRefSchema,
  note: wikiDisplayText(2_048, 0).nullable(),
}).strict();

export const WikiRelationHitSchema = z.object({
  direction: z.enum(["outgoing", "incoming"]),
  relation: WikiRelationSchema,
  entity: WikiEntitySummarySchema,
}).strict();

export const WikiRelationsRequestSchema = z.object({
  direction: z.enum(["outgoing", "incoming", "both"]).default("both"),
  type: wikiDisplayText(128).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const WikiBacklinksRequestSchema = z.object({
  type: wikiDisplayText(128).optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

const wikiPageEnvelope = {
  indexedRevision: revision,
  observedAt: isoTimestamp,
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
} as const;

export const WikiRelationsResponseSchema = z.object({
  ...wikiPageEnvelope,
  items: z.array(WikiRelationHitSchema).max(HUB_LIMITS.maxSearchGroupSize),
}).strict();

export const WikiBacklinksResponseSchema = z.object({
  ...wikiPageEnvelope,
  items: z.array(WikiRelationSchema).max(HUB_LIMITS.maxSearchGroupSize),
}).strict();

export const CodeKnowledgeRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxSearchGroupSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const CodeKnowledgeHitSchema = z.object({
  entity: WikiEntitySummarySchema,
  matchedNodes: z.array(GraphSymbolIdSchema).min(1).max(50),
}).strict();

export const CodeKnowledgeResponseSchema = z.object({
  ...wikiPageEnvelope,
  items: z.array(CodeKnowledgeHitSchema).max(HUB_LIMITS.maxSearchGroupSize),
}).strict();

export const ActivitySourceSchema = z.enum(["activity", "legacy"]);

export const ActivityRequestSchema = z.object({
  source: ActivitySourceSchema.optional(),
  since: isoTimestamp.optional(),
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

/** Actor as immutably recorded or currently resolved for an activity row. */
export const ActivityActorSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("member"),
    memberId: identifier,
    displayName: utf8Text(256).nullable(),
  }).strict(),
  z.object({
    kind: z.literal("git"),
    name: utf8Text(256).nullable(),
    email: utf8Text(320).nullable(),
  }).strict(),
  z.object({ kind: z.literal("unknown") }).strict(),
]).superRefine((value, context) => {
  if (value.kind === "git" && value.name === null && value.email === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "A Git actor requires a name or email.",
    });
  }
});

export const ActivityEntityRefSchema = z.object({
  id: utf8Text(256),
  entityKind: utf8Text(64),
  title: utf8Text(256).nullable(),
}).strict();

export const ActivitySubjectSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("entity"),
    entity: ActivityEntityRefSchema,
  }).strict(),
  z.object({
    kind: z.literal("symbol"),
    symbolId: utf8Text(512),
  }).strict(),
  z.object({
    kind: z.literal("file"),
    path: activityDisplayPath,
  }).strict(),
  z.object({
    kind: z.literal("commit"),
    hash: z.string().regex(/^[a-fA-F0-9]{7,64}$/),
  }).strict(),
]);

export const ActivityRepositorySnapshotSchema = z.object({
  branch: utf8Text(1_024).nullable(),
  head: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  dirty: z.boolean(),
  observedAt: isoTimestamp,
}).strict();

export const ActivityDiagnosticSchema = z.object({
  code: utf8Text(128),
  severity: z.enum(["error", "warning", "info"]),
  message: utf8Text(256),
  path: activityDisplayPath.optional(),
}).strict();

const activityItemBase = {
  timestamp: isoTimestamp,
  action: utf8Text(128),
  subjects: z.array(ActivitySubjectSchema).max(8),
  subjectCount: z.number().int().nonnegative(),
  subjectsTruncated: z.boolean(),
  sourcePath: activityDisplayPath,
} as const;

export const CanonicalActivityItemSchema = z.object({
  source: z.literal("activity"),
  id: z.string().regex(/^event_[0-7][0-9A-HJKMNP-TV-Z]{25}$/),
  ...activityItemBase,
  recordedActor: ActivityActorSchema,
  effectiveActor: ActivityActorSchema,
  actorDiagnostics: z.array(ActivityDiagnosticSchema).max(2),
  workstream: ActivityEntityRefSchema.nullable(),
  repository: ActivityRepositorySnapshotSchema,
  revision,
}).strict().superRefine((value, context) => {
  if (value.subjectCount < value.subjects.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectCount"], message: "Subject count cannot be smaller than its preview." });
  }
  if (value.subjectsTruncated !== (value.subjectCount > value.subjects.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectsTruncated"], message: "Subject truncation must match the preview size." });
  }
});

export const LegacyActivityItemSchema = z.object({
  source: z.literal("legacy"),
  id: z.string().regex(/^legacy_[a-f0-9]{64}$/),
  ...activityItemBase,
  recordedActor: z.null(),
  effectiveActor: z.null(),
  actorDiagnostics: z.array(ActivityDiagnosticSchema).length(0),
  workstream: z.null(),
  repository: z.null(),
  revision: z.null(),
  sourceLine: z.number().int().positive(),
  message: utf8Text(2_048, 0),
  messageTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.subjectCount < value.subjects.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectCount"], message: "Subject count cannot be smaller than its preview." });
  }
  if (value.subjectsTruncated !== (value.subjectCount > value.subjects.length)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["subjectsTruncated"], message: "Subject truncation must match the preview size." });
  }
});

export const ActivityItemSchema = z.union([
  CanonicalActivityItemSchema,
  LegacyActivityItemSchema,
]);

export const ActivityResponseSchema = z.object({
  items: z.array(ActivityItemSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
  hasMore: z.boolean(),
  sourceTruncated: z.boolean(),
  deterministicRevision: revision,
  diagnostics: z.array(ActivityDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  diagnosticsTruncated: z.boolean(),
}).strict().superRefine((value, context) => {
  if (value.hasMore !== (value.nextCursor !== null)) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["hasMore"], message: "hasMore must match nextCursor presence." });
  }
});

export const HubHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);

export const GraphIndexStatusSchema = z.enum([
  "missing",
  "fresh",
  "stale",
  "degraded",
  "rebuild_required",
  "corrupt",
]);

export const GraphHealthDetailsSchema = z.object({
  indexStatus: GraphIndexStatusSchema,
  observedAt: isoTimestamp,
  lastSuccessfulIndexAt: isoTimestamp.nullable(),
  indexedAt: isoTimestamp.nullable(),
  indexedBranch: utf8Text(1_024).nullable(),
  indexedHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  currentBranch: utf8Text(1_024).nullable(),
  currentHead: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/).nullable(),
  schemaVersion: z.number().int().nonnegative().nullable(),
  extractorVersion: utf8Text(128).nullable(),
  grammarVersion: utf8Text(128).nullable(),
  parseHealth: z.object({
    total: z.number().int().nonnegative(),
    ok: z.number().int().nonnegative(),
    partial: z.number().int().nonnegative(),
    failed: z.number().int().nonnegative(),
    failedPaths: z.array(repositoryDisplayPath).max(25),
    failedPathsTruncated: z.boolean(),
  }).strict(),
  changes: z.object({
    total: z.number().int().nonnegative(),
    added: z.array(repositoryDisplayPath).max(25),
    modified: z.array(repositoryDisplayPath).max(25),
    deleted: z.array(repositoryDisplayPath).max(25),
    truncated: z.boolean(),
    branchChanged: z.boolean(),
    manifestChanged: z.boolean(),
    configChanged: z.boolean(),
    grammarChanged: z.boolean(),
  }).strict(),
  allowedJobKinds: z.array(z.enum(["graph_refresh", "graph_rebuild"])).max(2),
  recommendedJobKind: z.enum(["graph_refresh", "graph_rebuild"]).nullable(),
  activeJobId: hubJobId.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.recommendedJobKind !== null
    && !value.allowedJobKinds.includes(value.recommendedJobKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedJobKind"],
      message: "A recommended graph operation must also be allowed.",
    });
  }
  const parseTotal = value.parseHealth.ok + value.parseHealth.partial + value.parseHealth.failed;
  if (parseTotal !== value.parseHealth.total) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["parseHealth"], message: "Graph parse-health counts must sum to the total." });
  }
});

export const WikiIndexStatusSchema = z.enum([
  "missing",
  "fresh",
  "stale",
  "degraded",
  "rebuild_required",
  "corrupt",
  "migration_required",
]);

export const WikiHealthDetailsSchema = z.object({
  indexStatus: WikiIndexStatusSchema,
  observedAt: isoTimestamp,
  indexedAt: isoTimestamp.nullable(),
  schemaVersion: z.number().int().nonnegative().nullable(),
  indexedRevision: revision.nullable(),
  allowedJobKinds: z.array(z.enum(["wiki_refresh", "wiki_rebuild"])).max(2),
  recommendedJobKind: z.enum(["wiki_refresh", "wiki_rebuild"]).nullable(),
  activeJobId: hubJobId.nullable(),
}).strict().superRefine((value, context) => {
  if (
    value.recommendedJobKind !== null
    && !value.allowedJobKinds.includes(value.recommendedJobKind)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["recommendedJobKind"],
      message: "A recommended Wiki operation must also be allowed.",
    });
  }
});

export const HealthComponentSchema = z.object({
  id: z.enum(["git", "graph", "wiki", "migration", "local_state"]),
  label: z.string().min(1).max(128),
  status: HubHealthStatusSchema,
  summary: z.string().min(1).max(1_024),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  repairJobKind: z.enum(HUB_JOB_KINDS).optional(),
  graph: GraphHealthDetailsSchema.optional(),
  wiki: WikiHealthDetailsSchema.optional(),
}).strict().superRefine((value, context) => {
  if (value.id !== "graph" && value.graph !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["graph"], message: "Only the graph health component can carry graph details." });
  }
  if (
    value.id === "graph"
    && value.graph !== undefined
    && value.repairJobKind !== undefined
    && value.repairJobKind !== value.graph.recommendedJobKind
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["repairJobKind"], message: "The graph repair action must match its recommended operation." });
  }
  if (value.id !== "wiki" && value.wiki !== undefined) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["wiki"], message: "Only the Wiki health component can carry Wiki details." });
  }
  if (
    value.id === "wiki"
    && value.wiki !== undefined
    && value.repairJobKind !== undefined
    && value.repairJobKind !== value.wiki.recommendedJobKind
  ) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ["repairJobKind"], message: "The Wiki repair action must match its recommended operation." });
  }
});

export const HealthResponseSchema = z.object({
  status: HubHealthStatusSchema,
  observedAt: isoTimestamp,
  components: z.array(HealthComponentSchema).min(1).max(16),
}).strict();

export const HubJobKindSchema = z.enum(HUB_JOB_KINDS);
export const HubJobStateSchema = z.enum(HUB_JOB_STATES);
export const HubJobPhaseSchema = z.enum(HUB_JOB_PHASES);
export const HubJobIdSchema = hubJobId;

export const HubJobProgressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive().optional(),
}).strict().refine(
  (value) => value.total === undefined || value.completed <= value.total,
  { message: "Completed work cannot exceed total work." },
);

export const HubJobSnapshotSchema = z.object({
  id: HubJobIdSchema,
  scaffoldId,
  kind: HubJobKindSchema,
  generation: z.number().int().positive(),
  phase: HubJobPhaseSchema,
  progress: HubJobProgressSchema.nullable(),
  state: HubJobStateSchema,
  cancelRequested: z.boolean(),
  createdAt: isoTimestamp,
  startedAt: isoTimestamp.optional(),
  finishedAt: isoTimestamp.optional(),
  interruptedReason: z.enum(["user_cancelled", "process_restart", "process_shutdown"])
    .optional(),
  problem: HubProblemDetailsSchema.omit({ requestId: true }).optional(),
  summary: z.string().min(1).max(2_048).optional(),
  revision: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const JobPageRequestSchema = z.object({
  cursor: cursor.optional(),
  limit: z.coerce.number().int().min(1).max(HUB_LIMITS.maxPageSize)
    .default(HUB_LIMITS.defaultPageSize),
}).strict();

export const JobPageResponseSchema = z.object({
  items: z.array(HubJobSnapshotSchema).max(HUB_LIMITS.maxPageSize),
  nextCursor: cursor.nullable(),
}).strict();

export const JobStartRequestSchema = z.object({
  kind: HubJobKindSchema,
}).strict();

export const JobCancelRequestSchema = z.object({}).strict();

export const BootstrapRequestSchema = z.object({
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, "Invalid bootstrap token."),
}).strict();

export const BootstrapResponseSchema = z.object({
  expiresAt: isoTimestamp,
}).strict();

export const SessionResponseSchema = z.object({
  csrfToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  expiresAt: isoTimestamp,
}).strict();

export type HubProblemCode = z.infer<typeof HubProblemCodeSchema>;
export type HubProblemDetails = z.infer<typeof HubProblemDetailsSchema>;
export type CapabilityStatus = z.infer<typeof CapabilityStatusSchema>;
export type HubCapabilities = z.infer<typeof HubCapabilitiesSchema>;
export type HubActor = z.infer<typeof HubActorSchema>;
export type HomeResponse = z.infer<typeof HomeResponseSchema>;
export type TeamMemberId = z.infer<typeof TeamMemberIdSchema>;
export type TeamGitAlias = z.infer<typeof TeamGitAliasSchema>;
export type TeamMember = z.infer<typeof TeamMemberSchema>;
export type TeamMemberListRequest = z.infer<typeof TeamMemberListRequestSchema>;
export type TeamMemberListResponse = z.infer<typeof TeamMemberListResponseSchema>;
export type TeamActorRef = z.infer<typeof TeamActorRefSchema>;
export type TeamCurrentActorResponse = z.infer<typeof TeamCurrentActorResponseSchema>;
export type TeamActivitySubjectInput = z.infer<typeof TeamActivitySubjectInputSchema>;
export type TeamOperationPreviewRequest = z.infer<typeof TeamOperationPreviewRequestSchema>;
export type TeamFileChange = z.infer<typeof TeamFileChangeSchema>;
export type TeamLocalChange = z.infer<typeof TeamLocalChangeSchema>;
export type TeamOperationReceipt = z.infer<typeof TeamOperationReceiptSchema>;
export type TeamOperationPreviewResponse = z.infer<typeof TeamOperationPreviewResponseSchema>;
export type TeamOperationApplyRequest = z.infer<typeof TeamOperationApplyRequestSchema>;
export type TeamActivityEvent = z.infer<typeof TeamActivityEventSchema>;
export type TeamOperationApplyResponse = z.infer<typeof TeamOperationApplyResponseSchema>;
export type GraphSymbolId = z.infer<typeof GraphSymbolIdSchema>;
export type GraphSymbol = z.infer<typeof GraphSymbolSchema>;
export type WikiEntityId = z.infer<typeof WikiEntityIdSchema>;
export type WikiLifecycleState = z.infer<typeof WikiLifecycleStateSchema>;
export type WikiGroundingHealth = z.infer<typeof WikiGroundingHealthSchema>;
export type WikiEntityRef = z.infer<typeof WikiEntityRefSchema>;
export type WikiEntitySummary = z.infer<typeof WikiEntitySummarySchema>;
export type WikiSearchResult = z.infer<typeof WikiSearchResultSchema>;
export type SymbolSearchResult = z.infer<typeof SymbolSearchResultSchema>;
export type SourceSearchResult = z.infer<typeof SourceSearchResultSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type CodeWorkspaceView = z.infer<typeof CodeWorkspaceViewSchema>;
export type CodeWorkspaceRequest = z.infer<typeof CodeWorkspaceRequestSchema>;
export type GraphSourceProjection = z.infer<typeof GraphSourceProjectionSchema>;
export type GraphSourcePage = z.infer<typeof GraphSourcePageSchema>;
export type GraphRelation = z.infer<typeof GraphRelationSchema>;
export type CodeWorkspaceTraversal = z.infer<typeof CodeWorkspaceTraversalSchema>;
export type CodeWorkspaceResponse = z.infer<typeof CodeWorkspaceResponseSchema>;
export type WikiEntityListRequest = z.infer<typeof WikiEntityListRequestSchema>;
export type WikiEntityListResponse = z.infer<typeof WikiEntityListResponseSchema>;
export type WikiProvenance = z.infer<typeof WikiProvenanceSchema>;
export type WikiSource = z.infer<typeof WikiSourceSchema>;
export type WikiGroundingCandidate = z.infer<typeof WikiGroundingCandidateSchema>;
export type WikiGrounding = z.infer<typeof WikiGroundingSchema>;
export type WikiEntityDetailResponse = z.infer<typeof WikiEntityDetailResponseSchema>;
export type WikiRelation = z.infer<typeof WikiRelationSchema>;
export type WikiRelationHit = z.infer<typeof WikiRelationHitSchema>;
export type WikiRelationsRequest = z.infer<typeof WikiRelationsRequestSchema>;
export type WikiBacklinksRequest = z.infer<typeof WikiBacklinksRequestSchema>;
export type WikiRelationsResponse = z.infer<typeof WikiRelationsResponseSchema>;
export type WikiBacklinksResponse = z.infer<typeof WikiBacklinksResponseSchema>;
export type CodeKnowledgeRequest = z.infer<typeof CodeKnowledgeRequestSchema>;
export type CodeKnowledgeHit = z.infer<typeof CodeKnowledgeHitSchema>;
export type CodeKnowledgeResponse = z.infer<typeof CodeKnowledgeResponseSchema>;
export type ActivitySource = z.infer<typeof ActivitySourceSchema>;
export type ActivityRequest = z.infer<typeof ActivityRequestSchema>;
export type ActivityActor = z.infer<typeof ActivityActorSchema>;
export type ActivityEntityRef = z.infer<typeof ActivityEntityRefSchema>;
export type ActivitySubject = z.infer<typeof ActivitySubjectSchema>;
export type ActivityRepositorySnapshot = z.infer<typeof ActivityRepositorySnapshotSchema>;
export type ActivityDiagnostic = z.infer<typeof ActivityDiagnosticSchema>;
export type CanonicalActivityItem = z.infer<typeof CanonicalActivityItemSchema>;
export type LegacyActivityItem = z.infer<typeof LegacyActivityItemSchema>;
export type ActivityItem = z.infer<typeof ActivityItemSchema>;
export type ActivityResponse = z.infer<typeof ActivityResponseSchema>;
export type GraphIndexStatus = z.infer<typeof GraphIndexStatusSchema>;
export type GraphHealthDetails = z.infer<typeof GraphHealthDetailsSchema>;
export type WikiIndexStatus = z.infer<typeof WikiIndexStatusSchema>;
export type WikiHealthDetails = z.infer<typeof WikiHealthDetailsSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type HubJobKind = z.infer<typeof HubJobKindSchema>;
export type HubJobState = z.infer<typeof HubJobStateSchema>;
export type HubJobPhase = z.infer<typeof HubJobPhaseSchema>;
export type HubJobProgress = z.infer<typeof HubJobProgressSchema>;
export type HubJobSnapshot = z.infer<typeof HubJobSnapshotSchema>;
export type JobPageRequest = z.infer<typeof JobPageRequestSchema>;
export type JobPageResponse = z.infer<typeof JobPageResponseSchema>;
export type JobStartRequest = z.infer<typeof JobStartRequestSchema>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
