import { describe, expect, it } from "vitest";
import {
  ActivityRequestSchema,
  ActivityResponseSchema,
  BootstrapRequestSchema,
  HUB_LIMITS,
  HomeResponseSchema,
  HubJobIdSchema,
  SearchRequestSchema,
  SearchResponseSchema,
} from "./index.js";

describe("Hub API contracts", () => {
  it("rejects unknown request fields and oversized queries", () => {
    expect(BootstrapRequestSchema.safeParse({
      token: Buffer.alloc(32).toString("base64url"),
      unexpected: true,
    }).success).toBe(false);
    expect(SearchRequestSchema.safeParse({
      q: "x".repeat(HUB_LIMITS.maxQueryCharacters + 1),
    }).success).toBe(false);
  });

  it("applies bounded page defaults", () => {
    expect(SearchRequestSchema.parse({ q: "memory" })).toEqual({
      q: "memory",
      limit: HUB_LIMITS.defaultPageSize,
    });
  });

  it("bounds strict activity filters and cursors", () => {
    expect(ActivityRequestSchema.parse({ source: "legacy" })).toEqual({
      source: "legacy",
      limit: HUB_LIMITS.defaultPageSize,
    });
    expect(ActivityRequestSchema.safeParse({ since: "2026-08-23" }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ source: "wiki" }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ limit: HUB_LIMITS.maxPageSize + 1 }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ cursor: "x".repeat(HUB_LIMITS.maxCursorBytes + 1) }).success).toBe(false);
    expect(ActivityRequestSchema.safeParse({ extra: true }).success).toBe(false);
  });

  it("keeps activity rows discriminated, privacy-safe, and internally consistent", () => {
    const canonical = {
      source: "activity",
      id: "event_01ARZ3NDEKTSV4RRFFQ69G5FAB",
      timestamp: "2026-08-23T00:00:00.000Z",
      action: "member.updated",
      subjects: [{ kind: "file", path: "src/index.ts" }],
      subjectCount: 1,
      subjectsTruncated: false,
      sourcePath: ".mex/events/activity/2026-08/event_01ARZ3NDEKTSV4RRFFQ69G5FAB.md",
      recordedActor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      effectiveActor: {
        kind: "member",
        memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV",
        displayName: "Daksh",
      },
      actorDiagnostics: [],
      workstream: null,
      repository: {
        branch: "feat/activity",
        head: "a".repeat(40),
        dirty: false,
        observedAt: "2026-08-23T00:00:00.000Z",
      },
      revision: "b".repeat(64),
    } as const;
    const legacy = {
      source: "legacy",
      id: `legacy_${"c".repeat(64)}`,
      timestamp: "2026-08-22T00:00:00.000Z",
      action: "note",
      subjects: [],
      subjectCount: 0,
      subjectsTruncated: false,
      sourcePath: ".mex/events/decisions.jsonl",
      recordedActor: null,
      effectiveActor: null,
      actorDiagnostics: [],
      workstream: null,
      repository: null,
      revision: null,
      sourceLine: 1,
      message: "Legacy note",
      messageTruncated: false,
    } as const;
    const response = {
      items: [canonical, legacy],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "d".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    };
    expect(ActivityResponseSchema.safeParse(response).success).toBe(true);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{ ...canonical, metadata: { secret: "must-not-cross" } }],
    }).success).toBe(false);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{ ...legacy, cwd: "/Users/alice/private" }],
    }).success).toBe(false);
    expect(ActivityResponseSchema.safeParse({ ...response, hasMore: true }).success).toBe(false);
    const actorDiagnostic = {
      code: "ACTOR_WARNING",
      severity: "warning" as const,
      message: "Warning",
    };
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{ ...canonical, actorDiagnostics: [actorDiagnostic, actorDiagnostic] }],
    }).success).toBe(true);
    expect(ActivityResponseSchema.safeParse({
      ...response,
      items: [{
        ...canonical,
        actorDiagnostics: Array.from({ length: 3 }, () => actorDiagnostic),
      }],
    }).success).toBe(false);
  });

  it("rejects non-canonical and byte-oversized activity display paths", () => {
    const base = {
      source: "legacy",
      id: `legacy_${"c".repeat(64)}`,
      timestamp: "2026-08-22T00:00:00.000Z",
      action: "note",
      subjects: [] as unknown[],
      subjectCount: 1,
      subjectsTruncated: true,
      sourcePath: ".mex/events/decisions.jsonl",
      recordedActor: null,
      effectiveActor: null,
      actorDiagnostics: [],
      workstream: null,
      repository: null,
      revision: null,
      sourceLine: 1,
      message: "Legacy note",
      messageTruncated: false,
    };
    const response = (path: string) => ({
      items: [{ ...base, subjects: [{ kind: "file", path }] }],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "d".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(ActivityResponseSchema.safeParse(response("src/e\u0301.ts")).success).toBe(false);
    expect(ActivityResponseSchema.safeParse(response("src/\u0080.ts")).success).toBe(false);
    expect(ActivityResponseSchema.safeParse(response(`src/${"é".repeat(192)}x`)).success).toBe(false);
  });

  it("accepts only standard prefixed ULIDs for Hub jobs", () => {
    expect(HubJobIdSchema.safeParse("job_01ARZ3NDEKTSV4RRFFQ69G5FAV").success).toBe(true);
    expect(HubJobIdSchema.safeParse(`job_8${"0".repeat(25)}`).success).toBe(false);
    expect(HubJobIdSchema.safeParse(`job_Z${"0".repeat(25)}`).success).toBe(false);
  });

  it("requires unavailable production summaries to be honest", () => {
    const response = {
      observedAt: "2026-08-23T00:00:00.000Z",
      repository: {
        scaffoldId: "mex",
        name: "mex",
        branch: "feat/hub",
        head: "a".repeat(40),
        dirty: false,
      },
      actor: { kind: "unknown" },
      sections: {
        workstreams: { availability: "unavailable", count: null, reason: "Wiki is not connected." },
        relays: { availability: "unavailable", count: null, reason: "Wiki is not connected." },
        inbox: { availability: "unavailable", count: null, reason: "Wiki is not connected." },
        activity: { availability: "available", count: 0 },
      },
      activeJobs: 0,
      attention: [],
    };
    expect(HomeResponseSchema.safeParse(response).success).toBe(true);
    expect(HomeResponseSchema.safeParse({
      ...response,
      sections: {
        ...response.sections,
        workstreams: { availability: "unavailable", count: 12 },
      },
    }).success).toBe(false);
  });

  it("keeps grouped search failures independent and result-free", () => {
    const unavailable = {
      status: "unavailable",
      items: [],
      nextCursor: null,
      truncated: false,
      detail: "The adapter is not installed.",
    } as const;
    const response = {
      query: "router",
      observedAt: "2026-08-23T00:00:00.000Z",
      groups: {
        wiki: unavailable,
        symbols: {
          status: "available",
          items: [{ id: "symbol:router", kind: "code_symbol", title: "Router" }],
          nextCursor: null,
          truncated: false,
        },
        sources: unavailable,
      },
    };
    expect(SearchResponseSchema.safeParse(response).success).toBe(true);
    expect(SearchResponseSchema.safeParse({
      ...response,
      groups: {
        ...response.groups,
        wiki: { ...unavailable, items: [{ id: "fake", kind: "wiki", title: "Fake" }] },
      },
    }).success).toBe(false);
  });
});
