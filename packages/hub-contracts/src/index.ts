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

export const SearchResultSchema = z.object({
  id: identifier,
  kind: z.enum(["wiki", "code_symbol", "source_chunk"]),
  title: z.string().min(1).max(512),
  description: z.string().max(2_048).optional(),
  path: z.string().min(1).max(4_096).optional(),
  route: z.string().startsWith("/").max(2_048).optional(),
}).strict();

export const SearchGroupSchema = z.object({
  status: z.enum(["available", "unavailable", "failed"]),
  items: z.array(SearchResultSchema).max(HUB_LIMITS.maxSearchGroupSize),
  nextCursor: cursor.nullable(),
  truncated: z.boolean(),
  detail: z.string().min(1).max(2_048).optional(),
}).strict().superRefine((value, context) => {
  if (value.status !== "available") {
    if (value.items.length !== 0 || value.nextCursor !== null || value.truncated) {
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
  } else if (value.detail !== undefined) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["detail"],
      message: "Available search groups cannot carry failure detail.",
    });
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
}).strict();

export const HubHealthStatusSchema = z.enum(["healthy", "degraded", "unavailable"]);

export const HealthComponentSchema = z.object({
  id: z.enum(["git", "graph", "wiki", "migration", "local_state"]),
  label: z.string().min(1).max(128),
  status: HubHealthStatusSchema,
  summary: z.string().min(1).max(1_024),
  diagnostics: z.array(HubDiagnosticSchema).max(HUB_LIMITS.maxDiagnosticCount),
  repairJobKind: z.enum(HUB_JOB_KINDS).optional(),
}).strict();

export const HealthResponseSchema = z.object({
  status: HubHealthStatusSchema,
  observedAt: isoTimestamp,
  components: z.array(HealthComponentSchema).min(1).max(16),
}).strict();

export const HubJobKindSchema = z.enum(HUB_JOB_KINDS);
export const HubJobStateSchema = z.enum(HUB_JOB_STATES);
export const HubJobIdSchema = hubJobId;

export const HubJobProgressSchema = z.object({
  completed: z.number().int().nonnegative(),
  total: z.number().int().positive().optional(),
  message: z.string().min(1).max(1_024).optional(),
}).strict().refine(
  (value) => value.total === undefined || value.completed <= value.total,
  { message: "Completed work cannot exceed total work." },
);

export const HubJobSnapshotSchema = z.object({
  id: HubJobIdSchema,
  scaffoldId,
  kind: HubJobKindSchema,
  generation: z.number().int().nonnegative(),
  phase: z.string().min(1).max(128),
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
export type SearchRequest = z.infer<typeof SearchRequestSchema>;
export type SearchResponse = z.infer<typeof SearchResponseSchema>;
export type HealthResponse = z.infer<typeof HealthResponseSchema>;
export type HubJobKind = z.infer<typeof HubJobKindSchema>;
export type HubJobState = z.infer<typeof HubJobStateSchema>;
export type HubJobProgress = z.infer<typeof HubJobProgressSchema>;
export type HubJobSnapshot = z.infer<typeof HubJobSnapshotSchema>;
export type JobPageRequest = z.infer<typeof JobPageRequestSchema>;
export type JobPageResponse = z.infer<typeof JobPageResponseSchema>;
export type JobStartRequest = z.infer<typeof JobStartRequestSchema>;
export type BootstrapRequest = z.infer<typeof BootstrapRequestSchema>;
export type BootstrapResponse = z.infer<typeof BootstrapResponseSchema>;
export type SessionResponse = z.infer<typeof SessionResponseSchema>;
