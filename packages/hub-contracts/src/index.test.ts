import { describe, expect, it } from "vitest";
import {
  ActivityRequestSchema,
  ActivityResponseSchema,
  BootstrapRequestSchema,
  CodeWorkspaceRequestSchema,
  CodeWorkspaceResponseSchema,
  CodeKnowledgeResponseSchema,
  HealthResponseSchema,
  HUB_LIMITS,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobIdSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberListRequestSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewRequestSchema,
  TeamOperationPreviewResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityListRequestSchema,
  WikiEntityListResponseSchema,
  WikiRelationsRequestSchema,
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

  it("locks the Checkpoint C member and capability contract golden", () => {
    const available = { availability: "available" } as const;
    const unavailable = {
      availability: "unavailable",
      reason: "The adapter is not connected.",
    } as const;
    const capabilities = {
      apiVersion: "v1",
      git: available,
      activity: available,
      activityRecord: available,
      members: {
        read: available,
        canonicalMutation: available,
        localSelection: available,
      },
      jobs: available,
      graph: { read: unavailable, refresh: unavailable, rebuild: unavailable },
      wiki: { read: unavailable, refresh: unavailable, rebuild: unavailable },
    } as const;
    expect(HubCapabilitiesSchema.parse(capabilities)).toEqual(capabilities);
    expect(HubCapabilitiesSchema.safeParse({
      ...capabilities,
      workstreams: { read: available },
    }).success).toBe(false);

    const member = teamMemberGolden();
    expect(TeamMemberSchema.parse(member)).toEqual(member);
    expect(TeamMemberListRequestSchema.parse({ active: "false" })).toEqual({
      active: false,
      limit: HUB_LIMITS.defaultPageSize,
    });
    expect(TeamMemberListResponseSchema.parse({
      items: [member],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "b".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    })).toEqual({
      items: [member],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "b".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    expect(TeamCurrentActorResponseSchema.safeParse({
      actor: { kind: "member", memberId: member.id, displayName: member.displayName },
      source: "configured-member",
      selection: {
        memberId: member.id,
        updatedAt: "2026-08-27T04:05:06.000Z",
        revision: "c".repeat(64),
      },
      diagnostics: [],
      diagnosticsTruncated: false,
    }).success).toBe(true);
  });

  it("accepts only C operations and never caller-owned authority or metadata", () => {
    const request = teamPreviewGolden().request;
    expect(TeamOperationPreviewRequestSchema.parse(request)).toEqual(request);
    for (const injected of [
      { ...request, actor: { kind: "unknown" } },
      { ...request, occurredAt: "2026-08-27T04:05:06.000Z" },
      { ...request, repoState: { branch: null, head: null, dirty: false } },
      { ...request, unexpected: true },
    ]) {
      expect(TeamOperationPreviewRequestSchema.safeParse(injected).success).toBe(false);
    }
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_activity_metadata",
      action: {
        kind: "activity.record",
        activity: {
          action: "review.completed",
          subjects: [],
          metadata: { prompt: "must not cross" },
        },
      },
      expectedRevisions: [],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_member_active_patch",
      action: {
        kind: "member.update",
        memberId: teamMemberGolden().id,
        patch: { active: false },
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: teamMemberGolden().sourcePath },
        revision: teamMemberGolden().revision,
      }],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_member_inactive_create",
      action: {
        kind: "member.add",
        member: { displayName: "Ada", gitAliases: [], active: false },
      },
      expectedRevisions: [],
    }).success).toBe(false);
    expect(TeamOperationPreviewRequestSchema.safeParse({
      operationId: "contract_future_action",
      action: { kind: "workstream.create", workstream: {} },
      expectedRevisions: [],
    }).success).toBe(false);
  });

  it("locks the portable preview/apply golden and its byte bounds", () => {
    const envelope = teamPreviewGolden();
    expect(TeamOperationPreviewResponseSchema.parse(envelope)).toEqual(envelope);
    expect(TeamOperationPreviewResponseSchema.safeParse({
      ...envelope,
      receipt: { ...envelope.receipt, extra: true },
    }).success).toBe(false);
    expect(TeamOperationPreviewResponseSchema.safeParse({
      ...envelope,
      receipt: {
        ...envelope.receipt,
        purposeIds: [...envelope.receipt.purposeIds].reverse(),
      },
    }).success).toBe(false);
    expect(TeamOperationPreviewResponseSchema.safeParse({
      ...envelope,
      preview: {
        ...envelope.preview,
        changes: [{ ...envelope.preview.changes[0], diff: "x".repeat(64 * 1024) }],
      },
    }).success).toBe(false);

    const apply = {
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: [],
      members: [teamMemberGolden()],
      events: [{
        schemaVersion: 1,
        id: envelope.receipt.purposeIds[0]!.id,
        timestamp: envelope.receipt.authority.occurredAt,
        actor: envelope.receipt.authority.actor,
        action: "member.added",
        subjects: [{ kind: "entity", entity: { id: teamMemberGolden().id, kind: "member" } }],
        workstream: null,
        repoState: envelope.receipt.authority.repoState,
      }],
    } as const;
    expect(TeamOperationApplyResponseSchema.parse(apply)).toEqual(apply);
    expect(TeamOperationApplyResponseSchema.safeParse({
      ...apply,
      events: [{ ...apply.events[0], metadata: { secret: "must not cross" } }],
    }).success).toBe(false);
  });

  it("keeps Wiki filters singular, strict, and capped at 50", () => {
    const entity = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    expect(WikiEntityListRequestSchema.parse({ topic: entity })).toEqual({
      topic: entity,
      limit: 25,
    });
    expect(WikiEntityListRequestSchema.safeParse({ kind: ["architecture"] }).success).toBe(false);
    expect(WikiEntityListRequestSchema.safeParse({ limit: 51 }).success).toBe(false);
    expect(WikiEntityListRequestSchema.safeParse({ unknown: true }).success).toBe(false);
    expect(WikiRelationsRequestSchema.safeParse({ direction: "both", depth: 2 }).success).toBe(false);
  });

  it("bounds Wiki summaries, body bytes, and Code links without extension fields", () => {
    const id = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    const summary = {
      id,
      kind: "architecture",
      title: "Durable queue",
      summary: null,
      lifecycleState: "promoted",
      groundingHealth: "unverified",
      topics: [],
      topicsTruncated: false,
      sourceTypes: ["manual"],
      sourceTypesTruncated: false,
      location: { path: ".mex/context/queue.md", startLine: 1, endLine: 12 },
      version: { semanticRevision: 1, contentHash: "a".repeat(64) },
      diagnostics: [],
      diagnosticsTruncated: false,
      route: `/knowledge/${id}`,
    } as const;
    const page = {
      indexedRevision: "b".repeat(64),
      observedAt: "2026-08-26T00:00:00.000Z",
      items: [summary],
      nextCursor: null,
      truncated: false,
    };
    expect(WikiEntityListResponseSchema.safeParse(page).success).toBe(true);
    expect(CodeKnowledgeResponseSchema.safeParse({
      ...page,
      items: [{ entity: summary, matchedNodes: ["function:queue"] }],
    }).success).toBe(true);
    const detail = {
      indexedRevision: page.indexedRevision,
      observedAt: page.observedAt,
      entity: summary,
      body: { content: "Queue body\n", totalBytes: 11, truncated: false },
      provenance: null,
      sources: { items: [], total: 0, truncated: false },
      groundings: { items: [], total: 0, truncated: false },
      relationCount: 0,
      backlinkCount: 0,
    };
    expect(WikiEntityDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(WikiEntityDetailResponseSchema.safeParse({
      ...detail,
      body: { content: "x".repeat(128 * 1_024 + 1), totalBytes: 128 * 1_024 + 1, truncated: false },
    }).success).toBe(false);
    expect(WikiEntityDetailResponseSchema.safeParse({
      ...detail,
      extension: { sessionId: "secret" },
    }).success).toBe(false);
    expect(SearchResponseSchema.safeParse({
      query: "queue",
      observedAt: page.observedAt,
      groups: {
        wiki: {
          status: "available",
          items: [{
            id,
            kind: "wiki",
            entityKind: "architecture",
            title: "Durable queue",
            summary: null,
            lifecycleState: "promoted",
            groundingHealth: "unverified",
            topics: [],
            // Deliberately omit topicsTruncated/sourceTypesTruncated.
            sourceTypes: [],
            path: ".mex/context/queue.md",
            matchedFields: ["title"],
            route: `/knowledge/${id}`,
          }],
          nextCursor: null,
          truncated: false,
          revision: page.indexedRevision,
        },
        symbols: {
          status: "unavailable", items: [], nextCursor: null, truncated: false,
          revision: null, code: "CAPABILITY_UNAVAILABLE", detail: "Unavailable.",
        },
        sources: {
          status: "unavailable", items: [], nextCursor: null, truncated: false,
          revision: null, code: "CAPABILITY_UNAVAILABLE", detail: "Unavailable.",
        },
      },
    }).success).toBe(false);
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
      revision: null,
      code: "CAPABILITY_UNAVAILABLE",
      detail: "The adapter is not installed.",
    } as const;
    const response = {
      query: "router",
      observedAt: "2026-08-23T00:00:00.000Z",
      groups: {
        wiki: unavailable,
        symbols: {
          status: "available",
          items: [{
            id: "symbol:router",
            kind: "code_symbol",
            symbolKind: "function",
            name: "Router",
            qualifiedName: "Router",
            language: "typescript",
            path: "src/router.ts",
            startLine: 1,
            endLine: 4,
            route: "/code/symbols/symbol%3Arouter",
          }],
          nextCursor: null,
          truncated: false,
          revision: "b".repeat(64),
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

  it("binds Code workspace queries to one strict traversal shape", () => {
    expect(CodeWorkspaceRequestSchema.parse({})).toEqual({ view: "overview" });
    expect(CodeWorkspaceRequestSchema.safeParse({ view: "overview", cursor: "x" }).success).toBe(false);
    expect(CodeWorkspaceRequestSchema.safeParse({ view: "callers", depth: 2 }).success).toBe(false);
    expect(CodeWorkspaceRequestSchema.safeParse({ view: "impact", depth: 5 }).success).toBe(false);

    const symbol = {
      id: "function:router",
      symbolKind: "function",
      name: "router",
      qualifiedName: "router",
      language: "typescript",
      path: "src/router.ts",
      startLine: 1,
      endLine: 3,
      route: "/code/symbols/function%3Arouter",
    };
    const response = {
      revision: "a".repeat(64),
      symbol,
      source: { items: [], nextCursor: null, truncated: false },
      view: "callers",
      traversal: { view: "callers", items: [], nextCursor: null, truncated: false },
    };
    expect(CodeWorkspaceResponseSchema.safeParse(response).success).toBe(true);
    expect(CodeWorkspaceResponseSchema.safeParse({
      ...response,
      traversal: { view: "overview" },
    }).success).toBe(false);
  });

  it("keeps structured graph health operations internally consistent", () => {
    const graph = {
      indexStatus: "stale",
      observedAt: "2026-08-23T00:00:00.000Z",
      lastSuccessfulIndexAt: null,
      indexedAt: null,
      indexedBranch: null,
      indexedHead: null,
      currentBranch: "main",
      currentHead: "a".repeat(40),
      schemaVersion: 2,
      extractorVersion: "extractor-1",
      grammarVersion: "grammar-1",
      parseHealth: {
        total: 1,
        ok: 1,
        partial: 0,
        failed: 0,
        failedPaths: [],
        failedPathsTruncated: false,
      },
      changes: {
        total: 1,
        added: ["src/new.ts"],
        modified: [],
        deleted: [],
        truncated: false,
        branchChanged: false,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      allowedJobKinds: ["graph_refresh"],
      recommendedJobKind: "graph_refresh",
      activeJobId: null,
    } as const;
    const response = {
      status: "degraded",
      observedAt: "2026-08-23T00:00:00.000Z",
      components: [{
        id: "graph",
        label: "Code graph",
        status: "degraded",
        summary: "Refresh required.",
        diagnostics: [],
        repairJobKind: "graph_refresh",
        graph,
      }],
    };
    expect(HealthResponseSchema.safeParse(response).success).toBe(true);
    expect(HealthResponseSchema.safeParse({
      ...response,
      components: [{ ...response.components[0], repairJobKind: "graph_rebuild" }],
    }).success).toBe(false);
    expect(HealthResponseSchema.safeParse({
      ...response,
      components: [{ ...response.components[0], graph: { ...graph, parseHealth: { ...graph.parseHealth, failed: 1 } } }],
    }).success).toBe(false);
  });
});

function teamMemberGolden() {
  const id = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
  return {
    schemaVersion: 1 as const,
    id,
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${id}.md`,
    revision: "a".repeat(64),
  };
}

function teamPreviewGolden() {
  const member = teamMemberGolden();
  const activityId = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
  const occurredAt = "2026-08-27T04:05:06.000Z";
  return {
    schemaVersion: 1 as const,
    request: {
      operationId: "contract_member_add",
      action: {
        kind: "member.add" as const,
        member: {
          displayName: member.displayName,
          gitAliases: member.gitAliases,
        },
      },
      expectedRevisions: [],
    },
    preview: {
      valid: true,
      scope: "canonical" as const,
      changes: [{
        kind: "create" as const,
        path: member.sourcePath,
        diff: "--- /dev/null\n+++ member\n",
        beforeRevision: null,
        afterRevision: member.revision,
      }],
      localChanges: [],
      diagnostics: [],
    },
    receipt: {
      schemaVersion: 1 as const,
      authority: {
        actor: { kind: "unknown" as const },
        occurredAt,
        repoState: {
          branch: "feature/team-identity",
          head: "b".repeat(40),
          dirty: false,
          observedAt: occurredAt,
        },
      },
      purposeIds: [
        { purpose: "activity" as const, id: activityId },
        { purpose: "member" as const, id: member.id },
      ],
      requestRevision: "c".repeat(64),
      presentationRevision: "d".repeat(64),
      previewRevision: "e".repeat(64),
    },
  };
}
