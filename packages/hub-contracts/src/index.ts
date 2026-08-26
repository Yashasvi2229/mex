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
  jobs: CapabilityStatusSchema,
  graph: z.object({
    read: CapabilityStatusSchema,
    refresh: CapabilityStatusSchema,
    rebuild: CapabilityStatusSchema,
  }).strict(),
  wiki: z.object({
    read: CapabilityStatusSchema,
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

export const WikiSearchResultSchema = z.object({
  id: identifier,
  kind: z.literal("wiki"),
  title: z.string().min(1).max(512),
  description: z.string().max(2_048).optional(),
  path: repositoryDisplayPath.optional(),
  route: z.string().startsWith("/").max(2_048).optional(),
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

export const HealthComponentSchema = z.object({
  id: z.enum(["git", "graph", "wiki", "migration", "local_state"]),
  label: z.string().min(1).max(128),
  status: HubHealthStatusSchema,
  summary: z.string().min(1).max(1_024),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  repairJobKind: z.enum(HUB_JOB_KINDS).optional(),
  graph: GraphHealthDetailsSchema.optional(),
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
export type GraphSymbolId = z.infer<typeof GraphSymbolIdSchema>;
export type GraphSymbol = z.infer<typeof GraphSymbolSchema>;
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
