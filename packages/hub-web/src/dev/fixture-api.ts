import type { HubApi, JobSubscription } from "../api/client";
import type {
  ActivityItem,
  ActivityRequest,
  ActivityResponse,
  CapabilitiesResponse,
  CodeKnowledgeRequest,
  CodeKnowledgeResponse,
  CodeWorkspaceRequest,
  CodeWorkspaceResponse,
  GraphSourceProjection,
  GraphSymbol,
  HealthResponse,
  HomeResponse,
  JobsResponse,
  JobSummary,
  SearchRequest,
  SearchResponse,
  SessionResponse,
  StartJobRequest,
  WikiBacklinksRequest,
  WikiBacklinksResponse,
  WikiEntityDetailResponse,
  WikiEntityListRequest,
  WikiEntityListResponse,
  WikiEntitySummary,
  WikiRelationsRequest,
  WikiRelationsResponse,
} from "../api/types";

const now = new Date("2026-08-23T08:45:00.000Z");
const timestamp = (minutesAgo: number) => new Date(now.getTime() - minutesAgo * 60_000).toISOString();
const revision = (character: string) => character.repeat(64);

const jobs: JobSummary[] = [
  {
    id: "job_01K36WVM6H7JK8M9NPQRSTVVWX",
    scaffoldId: "scf_mex",
    kind: "graph_refresh",
    generation: 14,
    phase: "parse",
    progress: { completed: 124, total: 183 },
    state: "running",
    cancelRequested: false,
    createdAt: timestamp(9),
    startedAt: timestamp(8),
    revision: revision("a"),
  },
  {
    id: "job_01K36R3X4A5BC6DE7FGHJKMNPQ",
    scaffoldId: "scf_mex",
    kind: "wiki_refresh",
    generation: 8,
    phase: "complete",
    progress: { completed: 42, total: 42 },
    state: "succeeded",
    cancelRequested: false,
    createdAt: timestamp(145),
    startedAt: timestamp(144),
    finishedAt: timestamp(141),
    summary: "Indexed 42 durable knowledge entities.",
    revision: revision("b"),
  },
  {
    id: "job_01K35Z2A3B4C5D6E7FGHJKMNPQ",
    scaffoldId: "scf_mex",
    kind: "graph_rebuild",
    generation: 13,
    phase: "validate",
    progress: { completed: 390 },
    state: "interrupted",
    cancelRequested: false,
    createdAt: timestamp(930),
    startedAt: timestamp(929),
    finishedAt: timestamp(900),
    interruptedReason: "process_restart",
    revision: revision("c"),
  },
  {
    id: "job_01K34P2A3B4C5D6E7FGHJKMNPQ",
    scaffoldId: "scf_mex",
    kind: "wiki_rebuild",
    generation: 7,
    phase: "validate",
    progress: { completed: 91, total: 100 },
    state: "failed",
    cancelRequested: false,
    createdAt: timestamp(1880),
    startedAt: timestamp(1879),
    finishedAt: timestamp(1872),
    problem: { type: "about:blank", code: "JOB_FAILED", status: 500, title: "Replacement index did not validate", detail: "The previous trustworthy index was preserved." },
    revision: revision("d"),
  },
];

const activityItems: ActivityItem[] = [
  {
    source: "activity",
    id: "event_01K36WVM6H7JK8M9NPQRSTVVWX",
    timestamp: timestamp(7),
    action: "hub.activity_view_connected",
    subjects: [
      { kind: "entity", entity: { id: "project_hub", entityKind: "workstream", title: "Project Hub" } },
      { kind: "file", path: "packages/hub-web/src/pages/ActivityPage.tsx" },
      { kind: "symbol", symbolId: "ActivityPage" },
      { kind: "commit", hash: "aeaf0ab" },
    ],
    subjectCount: 4,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K36WVM6H7JK8M9NPQRSTVVWX.md",
    recordedActor: { kind: "member", memberId: "member_daksh", displayName: "Daksh" },
    effectiveActor: { kind: "member", memberId: "member_daksh", displayName: "Daksh" },
    actorDiagnostics: [],
    workstream: { id: "project_hub", entityKind: "workstream", title: "Project Hub" },
    repository: {
      branch: "feat/hub-activity-timeline",
      head: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
      dirty: true,
      observedAt: timestamp(7),
    },
    revision: revision("1"),
  },
  {
    source: "activity",
    id: "event_01K36R3X4A5BC6DE7FGHJKMNPQ",
    timestamp: timestamp(38),
    action: "team.member_alias_updated",
    subjects: [
      { kind: "entity", entity: { id: "member_daksh", entityKind: "member", title: "Daksh" } },
      { kind: "file", path: ".mex/team/members/member_daksh.md" },
    ],
    subjectCount: 2,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K36R3X4A5BC6DE7FGHJKMNPQ.md",
    recordedActor: { kind: "git", name: "Daksh Jaitly", email: "daksh@example.test" },
    effectiveActor: { kind: "member", memberId: "member_daksh", displayName: "Daksh" },
    actorDiagnostics: [{
      code: "ACTOR_ALIAS_REMAPPED",
      severity: "info",
      message: "The recorded Git identity currently resolves to member Daksh.",
    }],
    workstream: null,
    repository: {
      branch: "feat/hub-activity-timeline",
      head: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
      dirty: false,
      observedAt: timestamp(38),
    },
    revision: revision("2"),
  },
  {
    source: "legacy",
    id: `legacy_${revision("3")}`,
    timestamp: timestamp(63),
    action: "decision",
    subjects: [
      { kind: "file", path: "src/team/activity/timeline.ts" },
      { kind: "file", path: "packages/hub-contracts/src/index.ts" },
    ],
    subjectCount: 2,
    subjectsTruncated: false,
    sourcePath: ".mex/events/decisions.jsonl",
    recordedActor: null,
    effectiveActor: null,
    actorDiagnostics: [],
    workstream: null,
    repository: null,
    revision: null,
    sourceLine: 18,
    message: "Keep activity immutable and preserve legacy history as a read-only projection.",
    messageTruncated: false,
  },
  {
    source: "activity",
    id: "event_01K35Z2A3B4C5D6E7FGHJKMNPQ",
    timestamp: timestamp(1_510),
    action: "graph.refresh_requested",
    subjects: [
      { kind: "symbol", symbolId: "GitCliAdapter.repositoryState" },
      { kind: "file", path: "src/team/git/adapter.ts" },
      { kind: "commit", hash: "6484dd0" },
    ],
    subjectCount: 3,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K35Z2A3B4C5D6E7FGHJKMNPQ.md",
    recordedActor: { kind: "git", name: "MEX Maintainer", email: "maintainer@example.test" },
    effectiveActor: { kind: "git", name: "MEX Maintainer", email: "maintainer@example.test" },
    actorDiagnostics: [],
    workstream: null,
    repository: {
      branch: null,
      head: "6484dd00022ac5d704404585d981b4da5f2c1cbf",
      dirty: false,
      observedAt: timestamp(1_510),
    },
    revision: revision("4"),
  },
  {
    source: "activity",
    id: "event_01K34P2A3B4C5D6E7FGHJKMNPQ",
    timestamp: timestamp(2_930),
    action: "repository.initialized",
    subjects: [],
    subjectCount: 0,
    subjectsTruncated: false,
    sourcePath: ".mex/events/activity/2026-08/event_01K34P2A3B4C5D6E7FGHJKMNPQ.md",
    recordedActor: { kind: "unknown" },
    effectiveActor: { kind: "unknown" },
    actorDiagnostics: [],
    workstream: null,
    repository: {
      branch: "feat/wiki-port-contract-lock",
      head: null,
      dirty: false,
      observedAt: timestamp(2_930),
    },
    revision: revision("5"),
  },
  {
    source: "legacy",
    id: `legacy_${revision("6")}`,
    timestamp: timestamp(4_400),
    action: "note",
    subjects: [{ kind: "file", path: "PLAN.md" }],
    subjectCount: 1,
    subjectsTruncated: false,
    sourcePath: ".mex/events/decisions.jsonl",
    recordedActor: null,
    effectiveActor: null,
    actorDiagnostics: [],
    workstream: null,
    repository: null,
    revision: null,
    sourceLine: 7,
    message: "Project Hub foundations remain independent of the Wiki engine.",
    messageTruncated: false,
  },
];

const unavailable = (reason: string) => ({ availability: "unavailable" as const, reason });
const available = { availability: "available" as const };

const capabilities: CapabilitiesResponse = {
  apiVersion: "v1",
  git: available,
  activity: available,
  jobs: available,
  graph: { read: available, refresh: available, rebuild: available },
  wiki: {
    read: available,
    refresh: available,
    rebuild: available,
  },
};

const session: SessionResponse = {
  csrfToken: "a".repeat(43),
  expiresAt: timestamp(-650),
};

const home: HomeResponse = {
  observedAt: timestamp(0),
  repository: {
    scaffoldId: "scf_mex",
    name: "mex",
    branch: "feat/project-hub-foundation",
    head: "6484dd00022ac5d704404585d981b4da5f2c1cbf",
    dirty: true,
  },
  actor: { kind: "member", memberId: "member_daksh", displayName: "Daksh" },
  sections: {
    workstreams: { availability: "unavailable", count: null, reason: "Workstreams wait for the real Wiki integration." },
    relays: { availability: "unavailable", count: null, reason: "Relay workflows are not part of this read-only slice." },
    inbox: { availability: "unavailable", count: null, reason: "Inbox workflows are not part of this read-only slice." },
    activity: { availability: "available", count: 4 },
  },
  activeJobs: 1,
  attention: [
    { id: "attention_graph", kind: "job", title: "Graph refresh is in progress", summary: "Extraction is processing generation 14.", route: `/jobs?job=${jobs[0].id}`, tone: "neutral" },
    { id: "attention_graph_freshness", kind: "health", title: "The code graph is behind this branch", summary: "Seven repository changes are outside the last trustworthy graph snapshot.", route: "/health", tone: "warning" },
    { id: "attention_activity", kind: "activity", title: "Repository activity is available", summary: "Immutable canonical and legacy history can be reviewed without changing the project.", route: "/activity", tone: "neutral" },
  ],
};

const health: HealthResponse = {
  status: "degraded",
  observedAt: timestamp(0),
  components: [
    { id: "git", label: "Git repository", status: "healthy", summary: "Branch and working tree are readable.", diagnostics: [] },
    {
      id: "graph",
      label: "Code graph",
      status: "degraded",
      summary: "The graph is stale against the current branch; a bounded refresh is recommended.",
      diagnostics: [{ code: "GRAPH_STALE", severity: "warning", message: "The indexed HEAD differs from the current repository HEAD." }],
      repairJobKind: "graph_refresh",
      graph: {
        observedAt: timestamp(0),
        indexStatus: "stale",
        lastSuccessfulIndexAt: timestamp(190),
        indexedAt: timestamp(190),
        indexedBranch: "feat/project-hub-foundation",
        indexedHead: "6484dd00022ac5d704404585d981b4da5f2c1cbf",
        currentBranch: "feat/hub-graph-integration",
        currentHead: "aeaf0ab0022ac5d704404585d981b4da5f2c1cbf",
        schemaVersion: 3,
        extractorVersion: "0.7.2",
        grammarVersion: "tree-sitter-2026.08",
        parseHealth: {
          total: 183,
          ok: 179,
          partial: 3,
          failed: 1,
          failedPaths: ["src/legacy/parser.ts"],
          failedPathsTruncated: false,
        },
        changes: {
          total: 7,
          added: ["packages/hub-web/src/pages/SymbolPage.tsx"],
          modified: [
            "packages/hub-web/src/pages/SearchPage.tsx",
            "packages/hub-web/src/pages/HealthPage.tsx",
            "packages/hub-web/src/pages/JobsPage.tsx",
            "src/hub/services/graph.ts",
            "packages/hub-contracts/src/index.ts",
          ],
          deleted: ["packages/hub-web/src/pages/LegacyCodePlaceholder.tsx"],
          truncated: false,
          branchChanged: true,
          manifestChanged: false,
          configChanged: false,
          grammarChanged: false,
        },
        allowedJobKinds: ["graph_refresh", "graph_rebuild"],
        recommendedJobKind: "graph_refresh",
        activeJobId: jobs[0].id,
      },
    },
    {
      id: "wiki",
      label: "Project Wiki",
      status: "healthy",
      summary: "The exact-byte Wiki index is fresh and available for read-only Knowledge views.",
      diagnostics: [],
      wiki: {
        indexStatus: "fresh",
        observedAt: timestamp(0),
        indexedAt: timestamp(61),
        schemaVersion: 3,
        indexedRevision: revision("6"),
        allowedJobKinds: ["wiki_refresh", "wiki_rebuild"],
        recommendedJobKind: null,
        activeJobId: null,
      },
    },
    { id: "local_state", label: "Local Hub state", status: "healthy", summary: "Schema v3 jobs, graph phases, and team state are readable.", diagnostics: [] },
  ],
};

const graphRevision = revision("7");
const wikiRevision = revision("6");
const wikiIds = {
  hub: "mx_01K36WVM6H7JK8M9NPQRSTVVWX",
  graph: "mx_01K36R3X4A5BC6DE7FGHJKMNPQ",
  activity: "mx_01K35Z2A3B4C5D6E7FGHJKMNPQ",
} as const;

const wikiEntities: WikiEntitySummary[] = [
  {
    id: wikiIds.hub,
    kind: "architecture",
    title: "Project Hub read boundaries",
    summary: "The Hub reads canonical project state through revision-bound internal ports and never mutates during ordinary browsing.",
    lifecycleState: "promoted",
    groundingHealth: "fresh",
    topics: [wikiIds.graph],
    topicsTruncated: false,
    sourceTypes: ["file", "symbol"],
    sourceTypesTruncated: false,
    location: { path: ".mex/wiki/architecture/project-hub.md", startLine: 1, endLine: 48 },
    version: { semanticRevision: 4, contentHash: revision("1") },
    diagnostics: [],
    diagnosticsTruncated: false,
    route: `/knowledge/${wikiIds.hub}`,
  },
  {
    id: wikiIds.graph,
    kind: "decision",
    title: "One snapshot per graph request",
    summary: "Search and symbol reads revalidate the database, repository snapshot, and exact source bytes before returning data.",
    lifecycleState: "promoted",
    groundingHealth: "changed",
    topics: [],
    topicsTruncated: false,
    sourceTypes: ["file", "commit"],
    sourceTypesTruncated: false,
    location: { path: ".mex/wiki/decisions/graph-snapshot.md", startLine: 1, endLine: 35 },
    version: { semanticRevision: 2, contentHash: revision("2") },
    diagnostics: [{ code: "WIKI_GROUNDING_CHANGED", severity: "warning", message: "The grounded symbol changed after this entry was indexed." }],
    diagnosticsTruncated: false,
    route: `/knowledge/${wikiIds.graph}`,
  },
  {
    id: wikiIds.activity,
    kind: "runbook",
    title: "Review immutable activity",
    summary: "Use the Activity workbench to inspect canonical and legacy history without advancing cursors or creating events.",
    lifecycleState: "in_flight",
    groundingHealth: "unverified",
    topics: [wikiIds.hub],
    topicsTruncated: false,
    sourceTypes: ["manual"],
    sourceTypesTruncated: false,
    location: { path: ".mex/wiki/runbooks/activity-review.md", startLine: 1, endLine: 24 },
    version: { semanticRevision: 1, contentHash: revision("3") },
    diagnostics: [],
    diagnosticsTruncated: false,
    route: `/knowledge/${wikiIds.activity}`,
  },
];

function wikiDetail(id: string): WikiEntityDetailResponse {
  const entity = wikiEntities.find((item) => item.id === id) ?? wikiEntities[0];
  const grounded = entity.id === wikiIds.hub;
  const body = entity.id === wikiIds.hub
    ? "# Project Hub read boundaries\n\nThe Hub is a local, read-only projection of canonical project state.\n\nEvery indexed response belongs to one stable revision. Pagination never combines revisions, and maintenance runs only after an explicit user action."
    : `# ${entity.title}\n\n${entity.summary ?? "No additional narrative is recorded."}`;
  return {
    indexedRevision: wikiRevision,
    observedAt: timestamp(0),
    entity,
    body: {
      content: body,
      totalBytes: new TextEncoder().encode(body).byteLength,
      truncated: false,
    },
    provenance: { kind: "human", id: "daksh", capturedAt: timestamp(2_880) },
    sources: {
      items: [{ type: "file", ref: entity.location.path, note: "Canonical Wiki source", repository: "mex", commit: "4f52336", capturedAt: timestamp(61) }],
      total: 1,
      truncated: false,
    },
    groundings: {
      items: grounded ? [{ state: "fresh", health: "fresh", requestedNode: "sym.createHubServer", resolvedNode: "sym.createHubServer", fingerprint: revision("4"), file: "src/hub/server.ts", commit: "4f52336", verifiedAt: timestamp(61), reason: null, candidates: [], candidatesTruncated: false }] : [{ state: "ungrounded", health: "unverified", requestedNode: null, resolvedNode: null, fingerprint: null, file: null, commit: null, verifiedAt: null, reason: "No explicit code grounding is recorded.", candidates: [], candidatesTruncated: false }],
      total: 1,
      truncated: false,
    },
    relationCount: entity.id === wikiIds.hub ? 1 : 0,
    backlinkCount: entity.id === wikiIds.hub ? 1 : 0,
  };
}

function wikiRelations(id: string): WikiRelationsResponse {
  const target = wikiEntities.find((item) => item.id !== id) ?? wikiEntities[1];
  const root = wikiEntities.find((item) => item.id === id) ?? wikiEntities[0];
  return {
    indexedRevision: wikiRevision,
    observedAt: timestamp(0),
    items: id === wikiIds.hub ? [{ direction: "outgoing", relation: { type: "depends_on", source: { id: root.id, kind: root.kind, title: root.title }, target: { id: target.id, kind: target.kind, title: target.title }, note: "Graph reads provide explicit code context." }, entity: target }] : [],
    nextCursor: null,
    truncated: false,
  };
}

function wikiBacklinks(id: string): WikiBacklinksResponse {
  const source = wikiEntities[2];
  const target = wikiEntities.find((item) => item.id === id) ?? wikiEntities[0];
  return {
    indexedRevision: wikiRevision,
    observedAt: timestamp(0),
    items: id === wikiIds.hub ? [{ type: "related_to", source: { id: source.id, kind: source.kind, title: source.title }, target: { id: target.id, kind: target.kind, title: target.title }, note: "The activity runbook is reviewed from the Hub." }] : [],
    nextCursor: null,
    truncated: false,
  };
}

const graphSymbols: GraphSymbol[] = [
  {
    id: "sym.createHubServer",
    symbolKind: "function",
    name: "createHubServer",
    qualifiedName: "hub.server.createHubServer",
    language: "TypeScript",
    path: "src/hub/server.ts",
    startLine: 74,
    endLine: 126,
    signature: "createHubServer(options: HubServerOptions): Promise<RunningHub>",
    route: "/code/symbols/sym.createHubServer",
  },
  {
    id: "sym.GraphPort.searchNodes",
    symbolKind: "method",
    name: "searchNodes",
    qualifiedName: "GraphPort.searchNodes",
    language: "TypeScript",
    path: "src/team/contracts/graph.ts",
    startLine: 249,
    endLine: 252,
    signature: "searchNodes(query: string, options?: GraphSearchOptions): Promise<GraphPage<CodeSymbol>>",
    route: "/code/symbols/sym.GraphPort.searchNodes",
  },
] as GraphSymbol[];

const sourcePages: GraphSourceProjection[] = [
  {
    path: "src/hub/server.ts",
    startLine: 74,
    endLine: 84,
    content: "export async function createHubServer(options: HubServerOptions) {\n  const app = createHubApp(options);\n  const server = await listenOnLoopback(app, options.port);\n  return { server, address: server.address() };\n}",
    contentHash: revision("8"),
    symbolIds: ["sym.createHubServer"],
  },
  {
    path: "src/hub/server.ts",
    startLine: 85,
    endLine: 92,
    content: "\nfunction listenOnLoopback(app: Hono, port: number) {\n  return serve({ fetch: app.fetch, hostname: \"127.0.0.1\", port });\n}",
    contentHash: revision("9"),
    symbolIds: ["sym.createHubServer"],
  },
];

const searchResponse = (request: SearchRequest): SearchResponse => ({
  query: request.q,
  observedAt: timestamp(0),
  groups: {
    wiki: {
      status: "available",
      items: wikiEntities.filter((entity) => `${entity.title} ${entity.summary ?? ""}`.toLowerCase().includes(request.q.toLowerCase()) || request.q.toLowerCase().includes("hub")).map((entity) => ({
        id: entity.id,
        kind: "wiki" as const,
        entityKind: entity.kind,
        title: entity.title,
        summary: entity.summary,
        lifecycleState: entity.lifecycleState,
        groundingHealth: entity.groundingHealth,
        topics: entity.topics,
        topicsTruncated: entity.topicsTruncated,
        sourceTypes: entity.sourceTypes,
        sourceTypesTruncated: entity.sourceTypesTruncated,
        path: entity.location.path,
        matchedFields: ["title" as const, "summary" as const],
        route: entity.route,
      })),
      nextCursor: null,
      truncated: false,
      revision: wikiRevision,
    },
    symbols: {
      status: "available",
      items: graphSymbols.map((symbol) => ({ ...symbol, kind: "code_symbol" as const })),
      nextCursor: null,
      truncated: false,
      revision: graphRevision,
    },
    sources: {
      status: "available",
      items: [{
        id: "source_hub_server",
        kind: "source_chunk",
        path: "src/hub/server.ts",
        startLine: 74,
        endLine: 84,
        preview: `export async function createHubServer(options: HubServerOptions) {\n  const app = createHubApp(options);\n}`,
        previewTruncated: true,
        matchedTerms: request.q.split(/\s+/).filter(Boolean).slice(0, 4),
        symbolIds: ["sym.createHubServer"],
        route: "/code/symbols/sym.createHubServer",
      }],
      nextCursor: null,
      truncated: false,
      revision: graphRevision,
    },
  },
});

function codeWorkspace(id: string, request: CodeWorkspaceRequest): CodeWorkspaceResponse {
  const symbol = graphSymbols.find((item) => item.id === id) ?? graphSymbols[0];
  const sourceOffset = request.sourceCursor === "fixture_source_2" ? 1 : 0;
  const source = sourcePages[sourceOffset];
  const sourceHasMore = sourceOffset === 0;
  if (request.view === "callers" || request.view === "callees") {
    const relation = request.view === "callers"
      ? { kind: "calls", sourceId: "sym.GraphPort.searchNodes", targetId: symbol.id, path: "src/hub/services/graph.ts", line: 141, confidence: 0.96, provenance: "ast" }
      : { kind: "calls", sourceId: symbol.id, targetId: "sym.GraphPort.searchNodes", path: "src/hub/server.ts", line: 102, confidence: 0.93, provenance: "ast" };
    return {
      revision: graphRevision,
      symbol,
      source: { items: [source], nextCursor: sourceHasMore ? "fixture_source_2" : null, truncated: false },
      view: request.view,
      traversal: { view: request.view, items: [relation], nextCursor: null, truncated: false },
    };
  }
  if (request.view === "impact") {
    return {
      revision: graphRevision,
      symbol,
      source: { items: [source], nextCursor: sourceHasMore ? "fixture_source_2" : null, truncated: false },
      view: "impact",
      traversal: {
        view: "impact",
        targetId: symbol.id,
        roots: [graphSymbols[1]],
        impacted: [{ symbol: graphSymbols[1], depth: Math.min(request.depth ?? 2, 2), rootId: graphSymbols[1].id }],
        relations: [{ kind: "calls", sourceId: graphSymbols[1].id, targetId: symbol.id, confidence: 0.93, provenance: "ast" }],
        truncated: false,
      },
    };
  }
  return {
    revision: graphRevision,
    symbol,
    source: { items: [source], nextCursor: sourceHasMore ? "fixture_source_2" : null, truncated: false },
    view: "overview",
    traversal: { view: "overview" },
  };
}

class FixtureHubApi implements HubApi {
  readonly #jobs = structuredClone(jobs);

  bootstrap() { return Promise.resolve({ expiresAt: session.expiresAt }); }
  getSession() { return Promise.resolve(session); }
  getCapabilities() { return Promise.resolve(capabilities); }
  getHome() { return Promise.resolve(home); }
  getActivity(request: ActivityRequest): Promise<ActivityResponse> {
    const since = request.since ? Date.parse(request.since) : null;
    const filtered = activityItems.filter((item) => (
      (request.source === undefined || item.source === request.source)
      && (since === null || Date.parse(item.timestamp) >= since)
    ));
    const parsedOffset = request.cursor?.match(/^fixture_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const pageSize = Math.min(request.limit, 4);
    const items = filtered.slice(offset, offset + pageSize);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_${nextOffset}` : null;
    return Promise.resolve({
      items,
      nextCursor,
      hasMore: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision(request.source === "legacy" ? "8" : request.source === "activity" ? "9" : "7"),
      diagnostics: [{
        code: "LEGACY_ACTIVITY_MALFORMED",
        severity: "warning",
        message: "One malformed legacy row was excluded while valid history was retained.",
        path: ".mex/events/decisions.jsonl",
      }],
      diagnosticsTruncated: false,
    });
  }
  search(request: SearchRequest) { return Promise.resolve(searchResponse(request)); }
  getCodeSymbol(id: string, request: CodeWorkspaceRequest) { return Promise.resolve(codeWorkspace(id, request)); }
  listWikiEntities(request: WikiEntityListRequest): Promise<WikiEntityListResponse> {
    const filtered = wikiEntities.filter((entity) => (
      (!request.kind || entity.kind === request.kind)
      && (!request.topic || entity.topics.includes(request.topic))
      && (!request.lifecycle || entity.lifecycleState === request.lifecycle)
      && (!request.grounding || entity.groundingHealth === request.grounding)
      && (!request.sourceType || entity.sourceTypes.includes(request.sourceType))
    ));
    const offset = request.cursor === "fixture_wiki_2" ? 2 : 0;
    const pageSize = Math.min(request.limit, 2);
    const items = filtered.slice(offset, offset + pageSize);
    const hasMore = offset + items.length < filtered.length;
    return Promise.resolve({
      indexedRevision: wikiRevision,
      observedAt: timestamp(0),
      items,
      nextCursor: hasMore ? "fixture_wiki_2" : null,
      truncated: hasMore,
    });
  }
  getWikiEntity(id: string) { return Promise.resolve(wikiDetail(id)); }
  getWikiRelations(id: string, _request: WikiRelationsRequest) { return Promise.resolve(wikiRelations(id)); }
  getWikiBacklinks(id: string, _request: WikiBacklinksRequest) { return Promise.resolve(wikiBacklinks(id)); }
  getCodeKnowledge(id: string, _request: CodeKnowledgeRequest): Promise<CodeKnowledgeResponse> {
    return Promise.resolve({
      indexedRevision: wikiRevision,
      observedAt: timestamp(0),
      items: id === "sym.createHubServer" ? [{ entity: wikiEntities[0], matchedNodes: [id] }] : [],
      nextCursor: null,
      truncated: false,
    });
  }
  getHealth() { return Promise.resolve(health); }
  getJobs(): Promise<JobsResponse> { return Promise.resolve({ items: [...this.#jobs], nextCursor: null }); }
  getJob(id: string) { return Promise.resolve(this.#jobs.find((job) => job.id === id) ?? this.#jobs[0]); }
  startJob(request: StartJobRequest) {
    const job: JobSummary = {
      id: "job_01K36ZZZ6H7JK8M9NPQRSTVVWX",
      scaffoldId: "scf_mex",
      kind: request.kind,
      generation: 15,
      phase: "queued",
      progress: null,
      state: "queued",
      cancelRequested: false,
      createdAt: new Date().toISOString(),
      revision: revision("e"),
    };
    this.#jobs.unshift(job);
    return Promise.resolve(job);
  }
  cancelJob(id: string) {
    const job = this.#jobs.find((candidate) => candidate.id === id) ?? this.#jobs[0];
    Object.assign(job, { cancelRequested: true, phase: "running" });
    return Promise.resolve(job);
  }
  subscribeToJob(): JobSubscription { return { close() {} }; }
}

export function createFixtureApi(): HubApi {
  return new FixtureHubApi();
}
