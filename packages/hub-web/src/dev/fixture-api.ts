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
  InboxDraftDetail,
  InboxDraftListRequest,
  InboxDraftListResponse,
  InboxOperationApplyRequest,
  InboxOperationApplyResponse,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalDetail,
  InboxProposalListRequest,
  InboxProposalListResponse,
  RelayDetail,
  RelayDraftDetail,
  RelayDraftListRequest,
  RelayDraftListResponse,
  RelayListRequest,
  RelayListResponse,
  RelayOperationApplyRequest,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  JobsResponse,
  JobSummary,
  SearchRequest,
  SearchResponse,
  SessionResponse,
  SpecDetailResponse,
  SpecListRequest,
  SpecListResponse,
  SpecSummaryProjection,
  StartJobRequest,
  TeamActivityEvent,
  TeamActivitySubjectInput,
  TeamCurrentActorResponse,
  TeamMember,
  TeamMemberListRequest,
  TeamMemberListResponse,
  TeamOperationApplyRequest,
  TeamOperationApplyResponse,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
  TeamWorkstream,
  TeamWorkstreamListRequest,
  TeamWorkstreamListResponse,
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
const fixtureMemberIds = [
  "member_01K36WVM6H7JK8M9NPQRSTVVWX",
  "member_01K36R3X4A5BC6DE7FGHJKMNPQ",
  "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
] as const;

const fixtureMembers: TeamMember[] = [
  {
    schemaVersion: 1,
    id: fixtureMemberIds[0],
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${fixtureMemberIds[0]}.md`,
    revision: revision("a"),
  },
  {
    schemaVersion: 1,
    id: fixtureMemberIds[1],
    displayName: "Grace Hopper",
    gitAliases: [{ name: "Grace", email: "grace@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${fixtureMemberIds[1]}.md`,
    revision: revision("b"),
  },
  {
    schemaVersion: 1,
    id: fixtureMemberIds[2],
    displayName: "Lin Chen",
    gitAliases: [],
    active: false,
    sourcePath: `.mex/team/members/${fixtureMemberIds[2]}.md`,
    revision: revision("c"),
  },
];

const fixtureWorkstreamIds = [
  "ws_01K37WVM6H7JK8M9NPQRSTVVW0",
  "ws_01K37R3X4A5BC6DE7FGHJKMNPQ",
  "ws_01K36Z2A3B4C5D6E7FGHJKMNPQ",
] as const;

const fixtureWorkstreamActor = {
  kind: "member" as const,
  memberId: fixtureMemberIds[0],
  displayName: "Ada Lovelace",
};

const fixtureWorkstreams: TeamWorkstream[] = [
  {
    schemaVersion: 1,
    id: fixtureWorkstreamIds[0],
    entityRevision: 4,
    title: "Human-team memory",
    goal: "Make repository memory reliable and useful for a collaborating engineering team.",
    summary: "Identity and Activity are live; Workstreams are the next canonical planning layer.",
    state: "active",
    owners: [fixtureWorkstreamActor],
    contributors: [{
      kind: "member",
      memberId: fixtureMemberIds[1],
      displayName: "Grace Hopper",
    }],
    paths: ["packages/hub-web", "src/team"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Checkpoint C is merged and the D workbench is under review.",
    nextMilestone: "Merge Workstreams and read-only Specs.",
    createdBy: fixtureWorkstreamActor,
    createdAt: timestamp(4_320),
    updatedBy: fixtureWorkstreamActor,
    updatedAt: timestamp(18),
    sourcePath: `.mex/workstreams/${fixtureWorkstreamIds[0]}.md`,
    revision: revision("4"),
  },
  {
    schemaVersion: 1,
    id: fixtureWorkstreamIds[1],
    entityRevision: 2,
    title: "Release evidence",
    goal: "Keep every checkpoint merge backed by reproducible evidence.",
    summary: "Performance confirmation and post-merge checks are recorded at the exact SHA.",
    state: "blocked",
    owners: [fixtureWorkstreamActor],
    contributors: [],
    paths: ["scripts/release-benchmark"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: ["Pinned cross-platform evidence is collected only at release hardening."],
    currentState: "Linux enforcement is active; the release matrix remains later scope.",
    nextMilestone: "Run the full release matrix in Checkpoint I.",
    createdBy: fixtureWorkstreamActor,
    createdAt: timestamp(2_880),
    updatedBy: fixtureWorkstreamActor,
    updatedAt: timestamp(95),
    sourcePath: `.mex/workstreams/${fixtureWorkstreamIds[1]}.md`,
    revision: revision("5"),
  },
  {
    schemaVersion: 1,
    id: fixtureWorkstreamIds[2],
    entityRevision: 3,
    title: "Hub foundations",
    goal: "Provide a bounded local operational view of the repository.",
    summary: "The authenticated local Hub and its read-only foundations are complete.",
    state: "done",
    owners: [fixtureWorkstreamActor],
    contributors: [],
    paths: ["src/hub", "packages/hub-contracts"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Complete and retained as canonical history.",
    nextMilestone: "Archive after the human-team release.",
    createdBy: fixtureWorkstreamActor,
    createdAt: timestamp(8_640),
    updatedBy: fixtureWorkstreamActor,
    updatedAt: timestamp(2_000),
    sourcePath: `.mex/workstreams/${fixtureWorkstreamIds[2]}.md`,
    revision: revision("6"),
  },
];

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
  activityRecord: available,
  members: {
    read: available,
    canonicalMutation: available,
    localSelection: available,
  },
  workstreams: { read: available, canonicalMutation: available },
  specs: { read: available },
  inbox: {
    read: available,
    draftMutation: available,
    proposalMutation: available,
    specApproval: available,
  },
  relays: {
    read: available,
    draftMutation: available,
    publish: available,
    lifecycleMutation: available,
  },
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
    workstreams: { availability: "available", count: fixtureWorkstreams.length },
    relays: { availability: "available", count: 1 },
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

const fixtureSpecIds = {
  root: "mx_01K38WVM6H7JK8M9NPQRSTVVWX",
  requirement: "mx_01K38R3X4A5BC6DE7FGHJKMNPQ",
  criterion: "mx_01K38Z2A3B4C5D6E7FGHJKMNPQ",
  constraint: "mx_01K38P2A3B4C5D6E7FGHJKMNPQ",
} as const;

const fixtureSpecSummaries: SpecSummaryProjection[] = [
  {
    schemaVersion: 1,
    id: fixtureSpecIds.root,
    kind: "spec",
    title: "Human-team memory release",
    summary: "Ship a Git-authoritative workflow for identity, Workstreams, reviewed knowledge, and release memory.",
    lifecycleState: "in_flight",
    groundingHealth: "fresh",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 5, contentHash: revision("a") },
    topics: [],
    sourceTypes: ["manual", "file"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
  {
    schemaVersion: 1,
    id: fixtureSpecIds.requirement,
    kind: "requirement",
    title: "Canonical Workstream review",
    summary: "Every Workstream mutation must preview and apply one exact revision-bound envelope.",
    lifecycleState: "promoted",
    groundingHealth: "fresh",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 2, contentHash: revision("b") },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
  {
    schemaVersion: 1,
    id: fixtureSpecIds.criterion,
    kind: "acceptance_criterion",
    title: "Stale previews never apply",
    summary: "Editing a form after preview forces a new preview before apply.",
    lifecycleState: "promoted",
    groundingHealth: "unverified",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 1, contentHash: revision("c") },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
  {
    schemaVersion: 1,
    id: fixtureSpecIds.constraint,
    kind: "constraint",
    title: "No inferred satisfaction",
    summary: "The Spec reader reports only explicit Wiki relationships and evidence.",
    lifecycleState: "promoted",
    groundingHealth: "unverified",
    sourcePath: ".mex/wiki/specs/human-team-memory.md",
    version: { semanticRevision: 1, contentHash: revision("d") },
    topics: [],
    sourceTypes: ["manual"],
    diagnostics: [],
    diagnosticsTruncated: false,
  },
];

const fixtureSpecIndex = {
  state: "fresh" as const,
  observedAt: timestamp(0),
  indexedRevision: wikiRevision,
  indexedAt: timestamp(61),
  diagnostics: [],
  diagnosticsTruncated: false,
};

function fixtureSpecDetail(id: string): SpecDetailResponse {
  const spec = fixtureSpecSummaries.find((item) => item.id === id && item.kind === "spec");
  if (spec === undefined) throw new Error("Fixture Spec not found.");
  return {
    availability: "ready",
    index: fixtureSpecIndex,
    detail: {
      schemaVersion: 1,
      spec,
      body: "# Human-team memory release\n\nThis specification binds repository-owned team workflows to exact, reviewable evidence.\n",
      bodyTruncated: false,
      provenance: { kind: "human", id: "daksh", capturedAt: timestamp(4_320) },
      sources: [{
        type: "file",
        ref: spec.sourcePath,
        note: "Canonical specification source",
        repository: "mex",
        commit: "b46209e",
        capturedAt: timestamp(61),
      }],
      sourcesTruncated: false,
      groundings: [{
        state: "fresh",
        health: "fresh",
        requestedNode: "TeamWorkflowPort",
        resolvedNode: "TeamWorkflowPort",
        fingerprint: revision("e"),
        file: "src/team/contracts/workflow.ts",
        commit: "b46209e",
        verifiedAt: timestamp(61),
        reason: null,
        candidates: [],
        candidatesTruncated: false,
      }],
      groundingsTruncated: false,
      hierarchy: {
        requirements: [fixtureSpecSummaries[1]!],
        acceptanceCriteria: [fixtureSpecSummaries[2]!],
        constraints: [fixtureSpecSummaries[3]!],
        relations: [
          {
            type: "derived_from",
            source: { id: fixtureSpecIds.requirement, kind: "requirement" },
            target: { id: fixtureSpecIds.root, kind: "spec" },
            note: null,
          },
          {
            type: "verified_by",
            source: { id: fixtureSpecIds.requirement, kind: "requirement" },
            target: { id: fixtureSpecIds.criterion, kind: "acceptance_criterion" },
            note: "The criterion records the explicit review invariant.",
          },
          {
            type: "constrained_by",
            source: { id: fixtureSpecIds.root, kind: "spec" },
            target: { id: fixtureSpecIds.constraint, kind: "constraint" },
            note: null,
          },
        ],
        estimatedTokens: 360,
      },
      deterministicRevision: revision("f"),
    },
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

function fixtureOperationId(prefix: "event" | "member" | "ws", sequence: number): string {
  const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
  return `${prefix}_01K37WVM6H7JK8M9NPQRSTVVW${alphabet[sequence % alphabet.length]}`;
}

const fixtureInboxDraftId = "inbox_00000000000000000000000000000001";
const fixtureInboxProposalId = "proposal_01000000000000000000001720";
const fixtureInboxSpecId = "mx_01000000000000000000000001";
const fixtureInboxCreatedSpecId = "mx_02000000000000000000000001";

const fixtureInboxDrafts: InboxDraftDetail[] = [{
  id: fixtureInboxDraftId,
  revision: revision("1"),
  updatedAt: timestamp(16),
  changeKind: "spec.create",
  entityKind: "requirement",
  title: "Release benchmark local draft Requirement",
  rationaleExcerpt: "Keep the release evidence reviewable before it enters canonical history.",
  input: {
    change: {
      kind: "spec.create",
      entityKind: "requirement",
      title: "Release benchmark local draft Requirement",
      summary: "A bounded release benchmark requirement ready for team review.",
      body: "The release benchmark must retain exact local evidence.\n\nReviewers can inspect the proposed bytes before publishing.",
      status: "in_flight",
    },
    rationale: "Keep the release evidence reviewable before it enters canonical history.",
    evidence: [{ kind: "manual", note: "Collected from the Checkpoint E release review." }],
    targetRevisions: [],
  },
}];

const fixtureInboxProposals: InboxProposalDetail[] = [{
  schemaVersion: 1,
  ref: {
    id: fixtureInboxProposalId,
    kind: "proposal",
    title: "Release benchmark pending Spec update",
  },
  sourcePath: `.mex/inbox/${fixtureInboxProposalId}.md`,
  revision: revision("2"),
  state: "pending",
  author: fixtureWorkstreamActor,
  changeKind: "spec.update",
  entityKind: "spec",
  title: "Release benchmark pending Spec update",
  rationaleExcerpt: "Clarify the exact evidence boundary for the release gate.",
  change: {
    kind: "spec.update",
    target: {
      id: fixtureInboxSpecId,
      kind: "spec",
      title: "Human-team memory release",
    },
    patch: {
      body: "The release gate records exact, bounded evidence before approval.\n\nPrivate proposal prose remains outside canonical Specs until approval.",
      summary: "Require exact evidence review before release approval.",
    },
  },
  rationale: "Clarify the exact evidence boundary for the release gate.",
  evidence: [{ kind: "file", path: "scripts/release-benchmark/run.mjs" }],
  targetRevisions: [{
    target: { kind: "entity", id: fixtureInboxSpecId },
    revision: revision("3"),
    semanticRevision: 4,
  }],
}];

const fixtureRelayDraftId = "relay-draft-01";
const fixtureRelayId = "relay_01000000000000000000000001";
const fixtureRelayDrafts: RelayDraftDetail[] = [{
  id: fixtureRelayDraftId,
  revision: revision("7"),
  updatedAt: timestamp(11),
  summary: "Carry the release evidence through the final cross-platform gate.",
  recipients: [{
    kind: "member",
    memberId: fixtureMemberIds[1],
    displayName: fixtureMembers[1].displayName,
  }],
  workstream: {
    kind: "workstream",
    id: fixtureWorkstreamIds[0],
    title: fixtureWorkstreams[0].title,
  },
  input: {
    recipients: [{
      kind: "member",
      memberId: fixtureMemberIds[1],
      displayName: fixtureMembers[1].displayName,
    }],
    workstream: {
      kind: "workstream",
      id: fixtureWorkstreamIds[0],
      title: fixtureWorkstreams[0].title,
    },
    summary: "Carry the release evidence through the final cross-platform gate.",
    completed: ["The deterministic benchmark fixture is stable."],
    inProgress: ["Collect the final pinned runner evidence."],
    decisions: [],
    blockers: [],
    unresolvedQuestions: ["Does the Windows packed-install run retain the same digest?"],
    changedFiles: ["scripts/release-benchmark/run.mjs"],
    code: [{ kind: "file", path: "scripts/release-benchmark/run.mjs" }],
    evidence: [{ kind: "manual", note: "Prepared in the Relay fixture workbench." }],
    nextActions: ["Run the cross-platform storage matrix."],
  },
}];

const fixtureRelays: RelayDetail[] = [{
  schemaVersion: 2,
  ref: { kind: "relay", id: fixtureRelayId, title: "Release evidence handoff" },
  sourcePath: `.mex/relays/${fixtureRelayId}.md`,
  revision: revision("8"),
  state: "published",
  sender: {
    kind: "member",
    memberId: fixtureMemberIds[1],
    displayName: fixtureMembers[1].displayName,
  },
  recipients: [{
    kind: "member",
    memberId: fixtureMemberIds[0],
    displayName: fixtureMembers[0].displayName,
  }],
  workstream: {
    kind: "workstream",
    id: fixtureWorkstreamIds[0],
    title: fixtureWorkstreams[0].title,
  },
  summary: "Release evidence is ready for the final cross-platform gate.",
  completed: ["Linux Node 22 characterization is captured."],
  inProgress: ["Cross-platform storage portability is awaiting claim."],
  decisions: [],
  blockers: [],
  unresolvedQuestions: [],
  changedFiles: ["scripts/release-benchmark/run.mjs"],
  code: [{ kind: "file", path: "scripts/release-benchmark/run.mjs" }],
  evidence: [{ kind: "manual", note: "Exact fixture evidence for Relay UI validation." }],
  nextActions: ["Claim the handoff and run the remaining matrix."],
  diagnostics: [],
  diagnosticsTruncated: false,
  publishedAt: timestamp(7),
  acknowledgedBy: null,
  acknowledgedAt: null,
  closedBy: null,
  closedAt: null,
}];

function fixtureCurrentActor(
  members: readonly TeamMember[],
  selection: TeamCurrentActorResponse["selection"],
): TeamCurrentActorResponse {
  if (selection === null) return {
    actor: { kind: "git", name: "Ada", email: "ada@example.test" },
    source: "git-fallback",
    selection: null,
    diagnostics: [],
    diagnosticsTruncated: false,
  };
  const candidate = members.find((member) => member.id === selection.memberId) ?? null;
  if (candidate?.active !== true) return {
    actor: { kind: "git", name: "Ada", email: "ada@example.test" },
    source: "git-fallback",
    selection,
    diagnostics: [{
      code: candidate === null ? "ACTOR_MEMBER_MISSING" : "ACTOR_MEMBER_INACTIVE",
      severity: "warning",
      message: candidate === null
        ? "The referenced member no longer exists."
        : "The referenced member is currently inactive.",
    }],
    diagnosticsTruncated: false,
  };
  return {
    actor: { kind: "member", memberId: candidate.id, displayName: candidate.displayName },
    source: "configured-member",
    selection,
    diagnostics: [],
    diagnosticsTruncated: false,
  };
}

function fixtureTeamSubject(
  subject: TeamActivitySubjectInput,
): ActivityItem["subjects"][number] {
  if (subject.kind === "entity") {
    return {
      kind: "entity",
      entity: {
        id: subject.entity.id,
        entityKind: subject.entity.kind,
        title: subject.entity.title ?? null,
      },
    };
  }
  if (subject.kind === "code") {
    return subject.code.kind === "symbol"
      ? { kind: "symbol", symbolId: subject.code.symbolId }
      : { kind: "file", path: subject.code.path };
  }
  return subject;
}

function fixtureTimelineEvent(event: TeamActivityEvent): ActivityItem {
  const subjects = event.subjects.map(fixtureTeamSubject);
  const recordedActor = event.actor.kind === "member"
    ? { ...event.actor, displayName: event.actor.displayName ?? event.actor.memberId }
    : event.actor;
  return {
    source: "activity",
    id: event.id,
    timestamp: event.timestamp,
    action: event.action,
    subjects,
    subjectCount: subjects.length,
    subjectsTruncated: false,
    sourcePath: `.mex/events/activity/${event.timestamp.slice(0, 7)}/${event.id}.md`,
    recordedActor,
    effectiveActor: recordedActor,
    actorDiagnostics: [],
    workstream: event.workstream === null ? null : {
      id: event.workstream.id,
      entityKind: "workstream",
      title: event.workstream.title ?? null,
    },
    repository: event.repoState,
    revision: revision("9"),
  };
}

class FixtureHubApi implements HubApi {
  readonly #jobs = structuredClone(jobs);
  readonly #members = structuredClone(fixtureMembers);
  readonly #workstreams = structuredClone(fixtureWorkstreams);
  readonly #inboxDrafts = structuredClone(fixtureInboxDrafts);
  readonly #inboxProposals = structuredClone(fixtureInboxProposals);
  readonly #relayDrafts = structuredClone(fixtureRelayDrafts);
  readonly #relays = structuredClone(fixtureRelays);
  readonly #activityItems = structuredClone(activityItems);
  #selection: TeamCurrentActorResponse["selection"] = {
    memberId: fixtureMemberIds[0],
    updatedAt: timestamp(12),
    revision: revision("d"),
  };
  #previewSequence = 0;

  bootstrap() { return Promise.resolve({ expiresAt: session.expiresAt }); }
  getSession() { return Promise.resolve(session); }
  getCapabilities() { return Promise.resolve(capabilities); }
  getHome() {
    const actor = fixtureCurrentActor(this.#members, this.#selection).actor;
    return Promise.resolve({
      ...home,
      actor: actor.kind === "member"
        ? { ...actor, displayName: actor.displayName ?? actor.memberId }
        : actor,
      sections: {
        ...home.sections,
        workstreams: {
          availability: "available" as const,
          count: this.#workstreams.filter((item) => item.state !== "archived").length,
        },
        relays: actor.kind !== "member"
          ? { availability: "unavailable" as const, count: null, reason: "Select an active Member to see your open Relay handoffs." }
          : {
              availability: "available" as const,
              count: this.#relays.filter((relay) => (
                (relay.state === "published" && relay.recipients.some((recipient) => recipient.kind === "member" && recipient.memberId === actor.memberId))
                || (relay.state === "acknowledged" && relay.acknowledgedBy?.kind === "member" && relay.acknowledgedBy.memberId === actor.memberId)
              )).length,
            },
        inbox: {
          availability: "available" as const,
          count: this.#inboxProposals.filter((item) => (
            item.state === "pending" || item.state === "stale"
          )).length,
        },
        activity: {
          availability: "available" as const,
          count: this.#activityItems.filter((item) => item.source === "activity").length,
        },
      },
    });
  }
  getMembers(request: TeamMemberListRequest): Promise<TeamMemberListResponse> {
    const filtered = this.#members.filter((member) => (
      request.active === undefined || member.active === request.active
    ));
    const offset = request.cursor === "fixture_members_2" ? 2 : 0;
    const items = filtered.slice(offset, offset + request.limit);
    const nextCursor = offset + items.length < filtered.length ? "fixture_members_2" : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("8"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getMember(id: string): Promise<TeamMember> {
    const member = this.#members.find((candidate) => candidate.id === id);
    return member === undefined
      ? Promise.reject(new Error("Fixture member not found."))
      : Promise.resolve(structuredClone(member));
  }
  getCurrentActor(): Promise<TeamCurrentActorResponse> {
    return Promise.resolve(fixtureCurrentActor(this.#members, this.#selection));
  }
  getWorkstreams(request: TeamWorkstreamListRequest): Promise<TeamWorkstreamListResponse> {
    const filtered = this.#workstreams.filter((workstream) => (
      (request.state === undefined || workstream.state === request.state)
      && (request.includeArchived === true || workstream.state !== "archived")
    ));
    const parsedOffset = request.cursor?.match(/^fixture_workstreams_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const items = filtered.slice(offset, offset + request.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_workstreams_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("3"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getWorkstream(id: string): Promise<TeamWorkstream> {
    const workstream = this.#workstreams.find((candidate) => candidate.id === id);
    return workstream === undefined
      ? Promise.reject(new Error("Fixture Workstream not found."))
      : Promise.resolve(structuredClone(workstream));
  }
  getRelayDrafts(request: RelayDraftListRequest): Promise<RelayDraftListResponse> {
    const parsedOffset = request.cursor?.match(/^fixture_relay_drafts_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = this.#relayDrafts.slice(offset, offset + request.limit);
    const items = details.map(({ input: _input, ...summary }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < this.#relayDrafts.length ? `fixture_relay_drafts_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("a"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getRelayDraft(id: string): Promise<RelayDraftDetail> {
    const draft = this.#relayDrafts.find((candidate) => candidate.id === id);
    return draft === undefined
      ? Promise.reject(new Error("Fixture Relay draft not found."))
      : Promise.resolve(structuredClone(draft));
  }
  getRelays(request: RelayListRequest): Promise<RelayListResponse> {
    const current = fixtureCurrentActor(this.#members, this.#selection).actor;
    if ((request.perspective === "mine" || request.perspective === "sent") && current.kind !== "member") {
      return Promise.reject(new Error("Select an active Member to use this Relay perspective."));
    }
    const filtered = this.#relays.filter((relay) => {
      if (request.states !== undefined && !request.states.includes(relay.state)) return false;
      if (request.workstreamId !== undefined && relay.workstream.id !== request.workstreamId) return false;
      if (request.perspective === "all") return true;
      if (current.kind !== "member") return false;
      if (request.perspective === "sent") {
        return relay.sender.kind === "member" && relay.sender.memberId === current.memberId;
      }
      return relay.state === "published"
        ? relay.recipients.some((recipient) => recipient.kind === "member" && recipient.memberId === current.memberId)
        : relay.acknowledgedBy?.kind === "member" && relay.acknowledgedBy.memberId === current.memberId;
    });
    const parsedOffset = request.cursor?.match(/^fixture_relays_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = filtered.slice(offset, offset + request.limit);
    const items = details.map(({
      completed: _completed,
      inProgress: _inProgress,
      decisions: _decisions,
      blockers: _blockers,
      unresolvedQuestions: _unresolvedQuestions,
      changedFiles: _changedFiles,
      code: _code,
      evidence: _evidence,
      nextActions: _nextActions,
      diagnostics: _diagnostics,
      diagnosticsTruncated: _diagnosticsTruncated,
      ...summary
    }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length ? `fixture_relays_${nextOffset}` : null;
    return Promise.resolve({
      items: structuredClone(items),
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("b"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getRelay(id: string): Promise<RelayDetail> {
    const relay = this.#relays.find((candidate) => candidate.ref.id === id);
    return relay === undefined
      ? Promise.reject(new Error("Fixture Relay not found."))
      : Promise.resolve(structuredClone(relay));
  }
  previewRelayOperation(
    request: RelayOperationPreviewRequest,
  ): Promise<RelayOperationPreviewResponse> {
    const action = request.action;
    const sequence = this.#previewSequence++;
    const eventId = fixtureOperationId("event", sequence);
    const draft = "draftId" in action && action.draftId !== undefined
      ? this.#relayDrafts.find((candidate) => candidate.id === action.draftId)
      : undefined;
    const relay = "relayId" in action
      ? this.#relays.find((candidate) => candidate.ref.id === action.relayId)
      : undefined;
    const createdDraftId = action.kind === "relay.draft.save"
      ? action.draftId ?? "relay-draft-02"
      : null;
    const publishedRelayId = "relay_02000000000000000000000001";
    const localChanges: RelayOperationPreviewResponse["preview"]["localChanges"] = action.kind === "relay.draft.save"
      ? [{
          namespace: "relay-draft",
          id: createdDraftId!,
          beforeRevision: draft?.revision ?? null,
          afterRevision: revision("c"),
          summary: draft === undefined ? "Create checkout-local Relay draft." : "Update checkout-local Relay draft.",
        }]
      : action.kind === "relay.draft.delete" || action.kind === "relay.publish"
        ? [{
            namespace: "relay-draft",
            id: action.draftId,
            beforeRevision: draft?.revision ?? revision("7"),
            afterRevision: null,
            summary: action.kind === "relay.publish" ? "Remove local draft after publication." : "Delete checkout-local Relay draft.",
          }]
        : [];
    const activityAction = action.kind === "relay.publish" ? "relay.published"
      : action.kind === "relay.acknowledge" ? "relay.acknowledged"
        : action.kind === "relay.close" ? "relay.closed"
          : null;
    const primaryChange: RelayOperationPreviewResponse["preview"]["changes"][number] | null = action.kind === "relay.publish"
      ? {
          kind: "create",
          path: `.mex/relays/${publishedRelayId}.md`,
          diff: `--- /dev/null\n+++ b/.mex/relays/${publishedRelayId}.md\n+state: published\n+summary: ${draft?.summary ?? "Relay handoff"}\n`,
          beforeRevision: null,
          afterRevision: revision("d"),
        }
      : action.kind === "relay.acknowledge" || action.kind === "relay.close"
        ? {
            kind: "update",
            path: relay?.sourcePath ?? `.mex/relays/${action.relayId}.md`,
            diff: `--- relay\n+++ relay\n-state: ${relay?.state ?? "published"}\n+state: ${action.kind === "relay.acknowledge" ? "acknowledged" : "closed"}\n`,
            beforeRevision: relay?.revision ?? revision("8"),
            afterRevision: revision("e"),
          }
        : null;
    const activityChange: RelayOperationPreviewResponse["preview"]["changes"][number] | null = activityAction === null ? null : {
      kind: "create",
      path: `.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md`,
      diff: `--- /dev/null\n+++ b/.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md\n+action: ${activityAction}\n`,
      beforeRevision: null,
      afterRevision: revision("f"),
    };
    const changes = [primaryChange, activityChange].filter((change): change is NonNullable<typeof change> => change !== null);
    const purposeIds: RelayOperationPreviewResponse["receipt"]["purposeIds"] = action.kind === "relay.draft.save"
      ? draft === undefined ? [{ purpose: "relay-draft", id: createdDraftId! }] : []
      : action.kind === "relay.draft.delete" ? []
        : action.kind === "relay.publish"
          ? [{ purpose: "activity", id: eventId }, { purpose: "relay", id: publishedRelayId }]
          : [{ purpose: "activity", id: eventId }];
    return Promise.resolve({
      schemaVersion: 1,
      request: structuredClone(request),
      preview: {
        valid: true,
        scope: action.kind === "relay.draft.save" || action.kind === "relay.draft.delete" ? "local" : action.kind === "relay.publish" ? "mixed" : "canonical",
        changes,
        localChanges,
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: fixtureCurrentActor(this.#members, this.#selection).actor,
          occurredAt: timestamp(0),
          repoState: { branch: home.repository.branch, head: home.repository.head, dirty: home.repository.dirty, observedAt: timestamp(0) },
        },
        purposeIds,
        requestRevision: revision("1"),
        presentationRevision: revision("2"),
        previewRevision: revision("3"),
      },
    });
  }
  applyRelayOperation(
    envelope: RelayOperationApplyRequest,
  ): Promise<RelayOperationApplyResponse> {
    const action = envelope.request.action;
    let relays: RelayDetail[] = [];
    if (action.kind === "relay.draft.save") {
      const id = action.draftId ?? envelope.receipt.purposeIds.find((item) => item.purpose === "relay-draft")?.id;
      if (id !== undefined) {
        const next: RelayDraftDetail = {
          id,
          revision: envelope.preview.localChanges[0]?.afterRevision ?? revision("c"),
          updatedAt: envelope.receipt.authority.occurredAt,
          summary: action.draft.summary,
          recipients: structuredClone(action.draft.recipients),
          workstream: structuredClone(action.draft.workstream),
          input: structuredClone(action.draft),
        };
        const index = this.#relayDrafts.findIndex((candidate) => candidate.id === id);
        if (index === -1) this.#relayDrafts.unshift(next);
        else this.#relayDrafts[index] = next;
      }
    } else if (action.kind === "relay.draft.delete") {
      const index = this.#relayDrafts.findIndex((candidate) => candidate.id === action.draftId);
      if (index !== -1) this.#relayDrafts.splice(index, 1);
    } else if (action.kind === "relay.publish") {
      const draft = this.#relayDrafts.find((candidate) => candidate.id === action.draftId);
      const id = envelope.receipt.purposeIds.find((item) => item.purpose === "relay")?.id;
      if (draft !== undefined && id !== undefined) {
        const next: RelayDetail = {
          schemaVersion: 2,
          ref: { kind: "relay", id },
          sourcePath: `.mex/relays/${id}.md`,
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("d"),
          state: "published",
          sender: structuredClone(envelope.receipt.authority.actor),
          ...structuredClone(draft.input),
          publishedAt: envelope.receipt.authority.occurredAt,
          acknowledgedBy: null,
          acknowledgedAt: null,
          closedBy: null,
          closedAt: null,
          diagnostics: [],
          diagnosticsTruncated: false,
        };
        this.#relays.unshift(next);
        this.#relayDrafts.splice(this.#relayDrafts.indexOf(draft), 1);
        relays = [next];
      }
    } else {
      const index = this.#relays.findIndex((candidate) => candidate.ref.id === action.relayId);
      const current = this.#relays[index];
      if (current !== undefined) {
        const next: RelayDetail = action.kind === "relay.acknowledge"
          ? {
              ...current,
              state: "acknowledged",
              revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
              acknowledgedBy: structuredClone(envelope.receipt.authority.actor),
              acknowledgedAt: envelope.receipt.authority.occurredAt,
            }
          : {
              ...current,
              state: "closed",
              revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
              closedBy: structuredClone(envelope.receipt.authority.actor),
              closedAt: envelope.receipt.authority.occurredAt,
            };
        this.#relays[index] = next;
        relays = [next];
      }
    }
    const eventId = envelope.receipt.purposeIds.find((item) => item.purpose === "activity")?.id;
    const events: TeamActivityEvent[] = eventId === undefined ? [] : [{
      schemaVersion: 1,
      id: eventId,
      timestamp: envelope.receipt.authority.occurredAt,
      actor: structuredClone(envelope.receipt.authority.actor),
      action: action.kind === "relay.publish" ? "relay.published" : action.kind === "relay.acknowledge" ? "relay.acknowledged" : "relay.closed",
      subjects: relays[0] ? [{ kind: "entity", entity: { ...relays[0].ref } }] : [],
      workstream: relays[0]?.workstream ?? null,
      repoState: structuredClone(envelope.receipt.authority.repoState),
    }];
    return Promise.resolve({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: structuredClone(envelope.preview.changes),
      localChanges: structuredClone(envelope.preview.localChanges),
      relays: structuredClone(relays),
      events,
    });
  }
  getInboxDrafts(request: InboxDraftListRequest): Promise<InboxDraftListResponse> {
    const parsedOffset = request.cursor?.match(/^fixture_inbox_drafts_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = this.#inboxDrafts.slice(offset, offset + request.limit);
    const items = details.map(({ input: _input, ...summary }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < this.#inboxDrafts.length
      ? `fixture_inbox_drafts_${nextOffset}`
      : null;
    return Promise.resolve({
      items,
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("4"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getInboxDraft(id: string): Promise<InboxDraftDetail> {
    const draft = this.#inboxDrafts.find((candidate) => candidate.id === id);
    return draft === undefined
      ? Promise.reject(new Error("Fixture Inbox draft not found."))
      : Promise.resolve(structuredClone(draft));
  }
  getInboxProposals(request: InboxProposalListRequest): Promise<InboxProposalListResponse> {
    const filtered = this.#inboxProposals.filter((proposal) => (
      request.states === undefined || request.states.includes(proposal.state)
    ));
    const parsedOffset = request.cursor?.match(/^fixture_inbox_proposals_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const details = filtered.slice(offset, offset + request.limit);
    const items = details.map(({
      change: _change,
      rationale: _rationale,
      evidence: _evidence,
      targetRevisions: _targetRevisions,
      reviewRationale: _reviewRationale,
      ...summary
    }) => summary);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < filtered.length
      ? `fixture_inbox_proposals_${nextOffset}`
      : null;
    return Promise.resolve({
      items,
      nextCursor,
      truncated: nextCursor !== null,
      sourceTruncated: false,
      deterministicRevision: revision("5"),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  }
  getInboxProposal(id: string): Promise<InboxProposalDetail> {
    const proposal = this.#inboxProposals.find((candidate) => candidate.ref.id === id);
    return proposal === undefined
      ? Promise.reject(new Error("Fixture Inbox proposal not found."))
      : Promise.resolve(structuredClone(proposal));
  }
  previewInboxOperation(
    request: InboxOperationPreviewRequest,
  ): Promise<InboxOperationPreviewResponse> {
    const action = request.action;
    const sequence = this.#previewSequence++;
    const eventId = fixtureOperationId("event", sequence);
    const activityAction = action.kind === "inbox.publish" ? "inbox.published"
      : action.kind === "inbox.approve" ? "inbox.approved"
        : action.kind === "inbox.reject" ? "inbox.rejected"
          : action.kind === "inbox.withdraw" ? "inbox.withdrawn"
            : action.kind === "inbox.mark-stale" ? "inbox.marked-stale"
              : action.kind === "inbox.repair" ? "inbox.repaired"
                : null;
    const draft = "draftId" in action
      ? this.#inboxDrafts.find((candidate) => candidate.id === action.draftId)
      : undefined;
    const proposal = "proposalId" in action
      ? this.#inboxProposals.find((candidate) => candidate.ref.id === action.proposalId)
      : undefined;
    if ("proposalId" in action && proposal === undefined) {
      return Promise.reject(new Error("Fixture Inbox proposal not found."));
    }
    if ((action.kind === "inbox.approve"
      || action.kind === "inbox.reject"
      || action.kind === "inbox.withdraw"
      || action.kind === "inbox.mark-stale")
      && proposal?.state !== "pending") {
      return Promise.reject(new Error(`Fixture ${action.kind} requires a pending proposal.`));
    }
    if (action.kind === "inbox.repair" && proposal?.state !== "stale") {
      return Promise.reject(new Error("Fixture inbox.repair requires a stale proposal."));
    }
    const createdDraftId = action.kind === "inbox.draft.save"
      ? action.draftId ?? "inbox_00000000000000000000000000000002"
      : null;
    const publishedProposalId = "proposal_02000000000000000000001720";
    const localChanges = action.kind === "inbox.draft.save"
      ? [{
          namespace: "inbox-draft" as const,
          id: createdDraftId!,
          beforeRevision: draft?.revision ?? null,
          afterRevision: revision("6"),
          summary: draft === undefined ? "Create checkout-local Inbox draft." : "Update checkout-local Inbox draft.",
        }]
      : action.kind === "inbox.draft.delete" || action.kind === "inbox.publish"
        ? [{
            namespace: "inbox-draft" as const,
            id: action.draftId,
            beforeRevision: draft?.revision ?? revision("1"),
            afterRevision: null,
            summary: action.kind === "inbox.publish"
              ? "Remove the checkout-local draft after publishing."
              : "Remove the checkout-local Inbox draft.",
          }]
        : [];
    const primaryChanges: InboxOperationPreviewResponse["preview"]["changes"] = action.kind === "inbox.draft.save" || action.kind === "inbox.draft.delete"
      ? []
      : action.kind === "inbox.publish"
        ? [{
            kind: "create" as const,
            path: `.mex/inbox/${publishedProposalId}.md`,
            diff: `--- /dev/null\n+++ b/.mex/inbox/${publishedProposalId}.md\n+state: pending\n+title: ${draft?.title ?? "Published Spec proposal"}\n`,
            beforeRevision: null,
            afterRevision: revision("7"),
          }]
        : action.kind === "inbox.approve"
          ? [
            ...(proposal?.change.kind === "spec.create" ? [{
              kind: "create" as const,
              path: `.mex/specs/${fixtureInboxCreatedSpecId}.md`,
              diff: `--- /dev/null\n+++ b/.mex/specs/${fixtureInboxCreatedSpecId}.md\n+title: ${proposal.title}\n`,
              beforeRevision: null,
              afterRevision: revision("8"),
            }] : [{
              kind: "update" as const,
              path: `.mex/specs/${fixtureInboxSpecId}.md`,
              diff: `--- a/.mex/specs/${fixtureInboxSpecId}.md\n+++ b/.mex/specs/${fixtureInboxSpecId}.md\n+The release gate records exact reviewed evidence.\n`,
              beforeRevision: revision("3"),
              afterRevision: revision("8"),
            }]), {
              kind: "update" as const,
              path: ".mex/events/operations.jsonl",
              diff: "--- a/.mex/events/operations.jsonl\n+++ b/.mex/events/operations.jsonl\n+{\"phase\":\"complete\",\"operation\":\"spec-authoring\"}\n",
              beforeRevision: revision("4"),
              afterRevision: revision("5"),
            }, {
              kind: "update" as const,
              path: proposal?.sourcePath ?? `.mex/inbox/${action.proposalId}.md`,
              diff: "--- proposal\n+++ proposal\n-state: pending\n+state: approved\n",
              beforeRevision: proposal?.revision ?? revision("2"),
              afterRevision: revision("9"),
            }]
          : [{
              kind: "update" as const,
              path: proposal?.sourcePath ?? `.mex/inbox/${action.proposalId}.md`,
              diff: `--- proposal\n+++ proposal\n-state: ${proposal?.state ?? "pending"}\n+state: ${action.kind === "inbox.reject" ? "rejected" : action.kind === "inbox.withdraw" ? "withdrawn" : action.kind === "inbox.mark-stale" ? "stale" : "pending"}\n`,
              beforeRevision: proposal?.revision ?? revision("2"),
              afterRevision: revision("9"),
            }];
    const activityChange: InboxOperationPreviewResponse["preview"]["changes"][number] | null = activityAction === null
      ? null
      : {
          kind: "create",
          path: `.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md`,
          diff: `--- /dev/null\n+++ b/.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md\n+action: ${activityAction}\n`,
          beforeRevision: null,
          afterRevision: revision("d"),
        };
    const changes = activityChange === null
      ? primaryChanges
      : [...primaryChanges, activityChange];
    const purposeIds: InboxOperationPreviewResponse["receipt"]["purposeIds"] = action.kind === "inbox.draft.save"
      ? draft === undefined
        ? [{ purpose: "inbox-draft", id: createdDraftId! }]
        : []
      : action.kind === "inbox.draft.delete"
        ? []
        : action.kind === "inbox.publish"
          ? [{ purpose: "activity", id: eventId }, { purpose: "proposal", id: publishedProposalId }]
          : action.kind === "inbox.approve"
            ? proposal?.change.kind === "spec.create"
              ? [{ purpose: "activity", id: eventId }, { purpose: "spec-entity", id: fixtureInboxCreatedSpecId }]
              : [{ purpose: "activity", id: eventId }]
            : [{ purpose: "activity", id: eventId }];
    return Promise.resolve({
      schemaVersion: 1,
      request: structuredClone(request),
      preview: {
        valid: true,
        scope: action.kind === "inbox.draft.save" || action.kind === "inbox.draft.delete"
          ? "local"
          : action.kind === "inbox.publish"
            ? "mixed"
            : "canonical",
        changes,
        localChanges,
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: fixtureCurrentActor(this.#members, this.#selection).actor,
          occurredAt: timestamp(0),
          repoState: {
            branch: home.repository.branch,
            head: home.repository.head,
            dirty: home.repository.dirty,
            observedAt: timestamp(0),
          },
        },
        purposeIds,
        requestRevision: revision("a"),
        presentationRevision: revision("b"),
        previewRevision: revision("c"),
      },
    });
  }
  applyInboxOperation(
    envelope: InboxOperationApplyRequest,
  ): Promise<InboxOperationApplyResponse> {
    const action = envelope.request.action;
    let proposals: InboxProposalDetail[] = [];
    const activityId = envelope.receipt.purposeIds.find((item) => item.purpose === "activity")?.id;
    let event: TeamActivityEvent | null = null;
    if (action.kind === "inbox.draft.save") {
      const id = action.draftId ?? envelope.receipt.purposeIds.find((item) => item.purpose === "inbox-draft")?.id;
      if (id !== undefined) {
        const descriptor = action.draft.change.kind === "spec.create"
          ? { entityKind: action.draft.change.entityKind, title: action.draft.change.title }
          : { entityKind: action.draft.change.target.kind, title: action.draft.change.target.title ?? action.draft.change.target.id };
        const next: InboxDraftDetail = {
          id,
          revision: envelope.preview.localChanges[0]?.afterRevision ?? revision("6"),
          updatedAt: envelope.receipt.authority.occurredAt,
          changeKind: action.draft.change.kind,
          ...descriptor,
          rationaleExcerpt: action.draft.rationale.slice(0, 240),
          input: structuredClone(action.draft),
        };
        const index = this.#inboxDrafts.findIndex((candidate) => candidate.id === id);
        if (index === -1) this.#inboxDrafts.unshift(next);
        else this.#inboxDrafts[index] = next;
      }
    } else if (action.kind === "inbox.draft.delete") {
      const index = this.#inboxDrafts.findIndex((candidate) => candidate.id === action.draftId);
      if (index !== -1) this.#inboxDrafts.splice(index, 1);
    } else if (action.kind === "inbox.publish") {
      const draft = this.#inboxDrafts.find((candidate) => candidate.id === action.draftId);
      const id = envelope.receipt.purposeIds.find((item) => item.purpose === "proposal")?.id;
      if (draft !== undefined && id !== undefined) {
        const proposal: InboxProposalDetail = {
          schemaVersion: 1,
          ref: { id, kind: "proposal", title: draft.title },
          sourcePath: `.mex/inbox/${id}.md`,
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("7"),
          state: "pending",
          author: envelope.receipt.authority.actor,
          changeKind: draft.changeKind,
          entityKind: draft.entityKind,
          title: draft.title,
          rationaleExcerpt: draft.rationaleExcerpt,
          change: structuredClone(draft.input.change),
          rationale: draft.input.rationale,
          evidence: structuredClone(draft.input.evidence),
          targetRevisions: structuredClone(draft.input.targetRevisions),
        };
        this.#inboxProposals.unshift(proposal);
        proposals = [proposal];
        this.#inboxDrafts.splice(this.#inboxDrafts.indexOf(draft), 1);
      }
    } else {
      const index = this.#inboxProposals.findIndex((candidate) => candidate.ref.id === action.proposalId);
      const current = this.#inboxProposals[index];
      if (current !== undefined) {
        const { reviewer: _reviewer, reviewedAt: _reviewedAt, reviewRationale: _reviewRationale, ...withoutReview } = current;
        const proposalRevision = envelope.preview.changes.find((change) => (
          change.path === current.sourcePath
        ))?.afterRevision ?? revision("9");
        let updated: InboxProposalDetail;
        if (action.kind === "inbox.repair") {
          const descriptor = action.replacement.change.kind === "spec.create"
            ? {
                entityKind: action.replacement.change.entityKind,
                title: action.replacement.change.title,
              }
            : {
                entityKind: action.replacement.change.target.kind,
                title: action.replacement.change.target.title ?? action.replacement.change.target.id,
              };
          updated = {
            ...withoutReview,
            state: "pending",
            revision: proposalRevision,
            changeKind: action.replacement.change.kind,
            ...descriptor,
            rationaleExcerpt: action.replacement.rationale.slice(0, 240),
            change: structuredClone(action.replacement.change),
            rationale: action.replacement.rationale,
            evidence: structuredClone(action.replacement.evidence),
            targetRevisions: structuredClone(action.replacement.targetRevisions),
          };
        } else if (action.kind === "inbox.mark-stale") {
          updated = {
            ...withoutReview,
            state: "stale",
            revision: proposalRevision,
          };
        } else {
          updated = {
            ...withoutReview,
            state: action.kind === "inbox.approve" ? "approved"
              : action.kind === "inbox.reject" ? "rejected"
                : "withdrawn",
            revision: proposalRevision,
            reviewer: envelope.receipt.authority.actor,
            reviewedAt: envelope.receipt.authority.occurredAt,
            ...((action.kind === "inbox.reject" || action.kind === "inbox.withdraw")
              && action.rationale !== undefined
              ? { reviewRationale: action.rationale }
              : {}),
          };
        }
        this.#inboxProposals[index] = updated;
        proposals = [updated];
      }
    }
    if (activityId !== undefined) {
      const actionName = action.kind === "inbox.publish" ? "inbox.published"
        : action.kind === "inbox.approve" ? "inbox.approved"
          : action.kind === "inbox.reject" ? "inbox.rejected"
            : action.kind === "inbox.withdraw" ? "inbox.withdrawn"
              : action.kind === "inbox.mark-stale" ? "inbox.marked-stale"
                : action.kind === "inbox.repair" ? "inbox.repaired"
                  : null;
      const proposalId = action.kind === "inbox.publish"
        ? envelope.receipt.purposeIds.find((item) => item.purpose === "proposal")?.id
        : "proposalId" in action ? action.proposalId : undefined;
      const subjectProposal = proposalId === undefined
        ? []
        : [{ kind: "entity" as const, entity: { id: proposalId, kind: "proposal" } }];
      const approvalTarget = action.kind !== "inbox.approve"
        ? []
        : proposals[0]?.change.kind === "spec.create"
          ? [{
              kind: "entity" as const,
              entity: {
                id: envelope.receipt.purposeIds.find((item) => item.purpose === "spec-entity")?.id
                  ?? fixtureInboxCreatedSpecId,
                kind: proposals[0].change.entityKind,
              },
            }]
          : proposals[0]?.change.kind === "spec.update"
            ? [{ kind: "entity" as const, entity: structuredClone(proposals[0].change.target) }]
            : [];
      if (actionName !== null) {
        event = {
          schemaVersion: 1,
          id: activityId,
          timestamp: envelope.receipt.authority.occurredAt,
          actor: envelope.receipt.authority.actor,
          action: actionName,
          subjects: [...subjectProposal, ...approvalTarget],
          workstream: null,
          repoState: envelope.receipt.authority.repoState,
        };
        this.#activityItems.unshift(fixtureTimelineEvent(event));
      }
    }
    return Promise.resolve({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: envelope.preview.localChanges,
      proposals,
      events: event === null ? [] : [event],
    });
  }
  previewTeamOperation(
    request: TeamOperationPreviewRequest,
  ): Promise<TeamOperationPreviewResponse> {
    const sequence = this.#previewSequence++;
    const eventId = fixtureOperationId("event", sequence);
    const memberId = request.action.kind === "member.add"
      ? fixtureOperationId("member", sequence)
      : request.action.kind === "member.update"
        || request.action.kind === "member.deactivate"
        || request.action.kind === "member.select"
        ? request.action.memberId
        : null;
    const workstreamId = request.action.kind === "workstream.create"
      ? fixtureOperationId("ws", sequence)
      : request.action.kind === "workstream.update" || request.action.kind === "workstream.archive"
        ? request.action.workstreamId
        : null;
    const currentMember = memberId === null
      ? null
      : this.#members.find((member) => member.id === memberId) ?? null;
    const currentWorkstream = workstreamId === null
      ? null
      : this.#workstreams.find((workstream) => workstream.id === workstreamId) ?? null;
    const canonical = request.action.kind === "member.add"
      || request.action.kind === "member.update"
      || request.action.kind === "member.deactivate"
      || request.action.kind === "workstream.create"
      || request.action.kind === "workstream.update"
      || request.action.kind === "workstream.archive"
      || request.action.kind === "activity.record";
    const sourcePath = request.action.kind === "activity.record"
      ? `.mex/events/activity/${timestamp(0).slice(0, 7)}/${eventId}.md`
      : workstreamId !== null ? `.mex/workstreams/${workstreamId}.md`
      : memberId === null ? null : `.mex/team/members/${memberId}.md`;
    const afterRevision = request.action.kind === "member.add" || request.action.kind === "workstream.create"
      ? revision("e")
      : request.action.kind === "member.update" || request.action.kind === "member.deactivate"
        || request.action.kind === "workstream.update" || request.action.kind === "workstream.archive"
        ? revision("f")
        : revision("9");
    const createsArtifact = request.action.kind === "member.add"
      || request.action.kind === "workstream.create"
      || request.action.kind === "activity.record";
    const diff = request.action.kind === "activity.record"
      ? `--- /dev/null\n+++ b/${sourcePath}\n+action: ${request.action.activity.action}\n`
      : workstreamId !== null
        ? `--- a/${sourcePath}\n+++ b/${sourcePath}\n+reviewed Workstream change\n`
      : `--- a/${sourcePath}\n+++ b/${sourcePath}\n+reviewed member change\n`;
    const changes: TeamOperationPreviewResponse["preview"]["changes"] = !canonical || sourcePath === null
      ? []
      : createsArtifact
        ? [{ kind: "create", path: sourcePath, beforeRevision: null, afterRevision, diff }]
        : [{
          kind: "update",
          path: sourcePath,
          beforeRevision: currentWorkstream?.revision ?? currentMember?.revision ?? revision("0"),
          afterRevision,
          diff,
        }];
    const localChanges = request.action.kind === "member.select" ? [{
      namespace: "member-selection" as const,
      id: "current" as const,
      beforeRevision: this.#selection?.revision ?? null,
      afterRevision: revision("e"),
      summary: `Select ${currentMember?.displayName ?? memberId} for this checkout`,
    }] : request.action.kind === "member.clear" ? [{
      namespace: "member-selection" as const,
      id: "current" as const,
      beforeRevision: this.#selection?.revision ?? null,
      afterRevision: null,
      summary: "Clear the configured member for this checkout",
    }] : [];
    const purposeIds = [
      ...(canonical ? [{ purpose: "activity" as const, id: eventId }] : []),
      ...(request.action.kind === "member.add" && memberId !== null
        ? [{ purpose: "member" as const, id: memberId }] : []),
      ...(request.action.kind === "workstream.create" && workstreamId !== null
        ? [{ purpose: "workstream" as const, id: workstreamId }] : []),
    ];
    return Promise.resolve({
      schemaVersion: 1,
      request: structuredClone(request),
      preview: {
        valid: true,
        scope: canonical ? "canonical" : "local",
        changes,
        localChanges,
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: fixtureCurrentActor(this.#members, this.#selection).actor,
          occurredAt: timestamp(0),
          repoState: {
            branch: home.repository.branch,
            head: home.repository.head,
            dirty: home.repository.dirty,
            observedAt: timestamp(0),
          },
        },
        purposeIds,
        requestRevision: revision("1"),
        presentationRevision: revision("2"),
        previewRevision: revision("3"),
      },
    });
  }
  applyTeamOperation(
    envelope: TeamOperationApplyRequest,
  ): Promise<TeamOperationApplyResponse> {
    const { action } = envelope.request;
    const memberPurpose = envelope.receipt.purposeIds.find((item) => item.purpose === "member");
    const workstreamPurpose = envelope.receipt.purposeIds.find((item) => item.purpose === "workstream");
    const eventPurpose = envelope.receipt.purposeIds.find((item) => item.purpose === "activity");
    let member: TeamMember | null = null;
    let workstream: TeamWorkstream | null = null;
    if (action.kind === "member.add" && memberPurpose?.purpose === "member") {
      member = {
        schemaVersion: 1,
        id: memberPurpose.id,
        displayName: action.member.displayName,
        gitAliases: action.member.gitAliases,
        active: true,
        sourcePath: `.mex/team/members/${memberPurpose.id}.md`,
        revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
      };
      this.#members.push(member);
    } else if (action.kind === "member.update" || action.kind === "member.deactivate") {
      const index = this.#members.findIndex((candidate) => candidate.id === action.memberId);
      const current = this.#members[index];
      if (current !== undefined) {
        member = {
          ...current,
          ...(action.kind === "member.update" ? action.patch : { active: false }),
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("f"),
        };
        this.#members[index] = member;
      }
    } else if (action.kind === "member.select") {
      this.#selection = {
        memberId: action.memberId,
        updatedAt: envelope.receipt.authority.occurredAt,
        revision: envelope.preview.localChanges[0]?.afterRevision ?? revision("e"),
      };
    } else if (action.kind === "member.clear") {
      this.#selection = null;
    } else if (action.kind === "workstream.create" && workstreamPurpose?.purpose === "workstream") {
      workstream = {
        schemaVersion: 1,
        id: workstreamPurpose.id,
        entityRevision: 1,
        title: action.workstream.title,
        goal: action.workstream.goal,
        summary: action.workstream.summary,
        state: "planned",
        owners: action.workstream.owners,
        contributors: action.workstream.contributors ?? [],
        paths: action.workstream.paths ?? [],
        code: action.workstream.code ?? [],
        topics: action.workstream.topics ?? [],
        components: action.workstream.components ?? [],
        related: action.workstream.related ?? [],
        blockers: [],
        currentState: "Planned",
        nextMilestone: action.workstream.nextMilestone,
        createdBy: envelope.receipt.authority.actor,
        createdAt: envelope.receipt.authority.occurredAt,
        updatedBy: envelope.receipt.authority.actor,
        updatedAt: envelope.receipt.authority.occurredAt,
        sourcePath: `.mex/workstreams/${workstreamPurpose.id}.md`,
        revision: envelope.preview.changes[0]?.afterRevision ?? revision("e"),
      };
      this.#workstreams.unshift(workstream);
    } else if (action.kind === "workstream.update" || action.kind === "workstream.archive") {
      const index = this.#workstreams.findIndex((candidate) => candidate.id === action.workstreamId);
      const current = this.#workstreams[index];
      if (current !== undefined) {
        const patch = action.kind === "workstream.update"
          ? action.patch
          : { state: "archived" as const, blockers: [] };
        workstream = {
          ...current,
          ...patch,
          entityRevision: current.entityRevision + 1,
          updatedBy: envelope.receipt.authority.actor,
          updatedAt: envelope.receipt.authority.occurredAt,
          revision: envelope.preview.changes[0]?.afterRevision ?? revision("f"),
        };
        this.#workstreams[index] = workstream;
      }
    }

    let event: TeamActivityEvent | null = null;
    if (eventPurpose?.purpose === "activity") {
      const direct = action.kind === "activity.record" ? action.activity : null;
      const eventMember = member ?? (
        action.kind === "member.update" || action.kind === "member.deactivate"
          ? this.#members.find((candidate) => candidate.id === action.memberId) ?? null
          : null
      );
      const eventAction = action.kind === "member.add" ? "member.added"
        : action.kind === "member.update" ? "member.updated"
          : action.kind === "member.deactivate" ? "member.deactivated"
            : action.kind === "workstream.create" ? "workstream.created"
              : action.kind === "workstream.update" ? "workstream.updated"
                : action.kind === "workstream.archive" ? "workstream.archived"
            : direct?.action ?? "activity.recorded";
      const eventSubjects: TeamActivitySubjectInput[] = direct?.subjects ?? (
        workstream !== null ? [{
          kind: "entity",
          entity: { id: workstream.id, kind: "workstream", title: workstream.title },
        }] : eventMember === null ? [] : [{
          kind: "entity",
          entity: { id: eventMember.id, kind: "member", title: eventMember.displayName },
        }]
      );
      event = {
        schemaVersion: 1,
        id: eventPurpose.id,
        timestamp: envelope.receipt.authority.occurredAt,
        actor: envelope.receipt.authority.actor,
        action: eventAction,
        subjects: eventSubjects,
        workstream: direct?.workstream ?? (workstream === null
          ? null
          : { id: workstream.id, kind: "workstream", title: workstream.title }),
        repoState: envelope.receipt.authority.repoState,
      };
      this.#activityItems.unshift(fixtureTimelineEvent(event));
    }
    return Promise.resolve({
      operationId: envelope.request.operationId,
      previewRevision: envelope.receipt.previewRevision,
      applied: true,
      idempotentReplay: false,
      changes: envelope.preview.changes,
      localChanges: envelope.preview.localChanges,
      members: member === null ? [] : [member],
      workstreams: workstream === null ? [] : [workstream],
      events: event === null ? [] : [event],
    });
  }
  getActivity(request: ActivityRequest): Promise<ActivityResponse> {
    const since = request.since ? Date.parse(request.since) : null;
    const filtered = this.#activityItems.filter((item) => (
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
  listSpecs(request: SpecListRequest): Promise<SpecListResponse> {
    const roots = fixtureSpecSummaries.filter((item) => (
      item.kind === "spec"
      && (request.includeArchived === true || item.lifecycleState !== "archived")
      && (request.lifecycleStates === undefined || request.lifecycleStates.includes(item.lifecycleState))
      && (request.groundingHealth === undefined || request.groundingHealth.includes(item.groundingHealth))
      && (request.topics === undefined || request.topics.every((topic) => item.topics.includes(topic)))
    ));
    const parsedOffset = request.cursor?.match(/^fixture_specs_(\d+)$/)?.[1];
    const offset = parsedOffset === undefined ? 0 : Number(parsedOffset);
    const items = roots.slice(offset, offset + request.limit);
    const nextOffset = offset + items.length;
    const nextCursor = nextOffset < roots.length ? `fixture_specs_${nextOffset}` : null;
    return Promise.resolve({
      availability: "ready",
      index: fixtureSpecIndex,
      page: {
        schemaVersion: 1,
        items: structuredClone(items),
        nextCursor,
        truncated: nextCursor !== null,
        estimatedTokens: 180 * items.length,
        deterministicRevision: revision("f"),
      },
    });
  }
  getSpec(id: string): Promise<SpecDetailResponse> {
    try {
      return Promise.resolve(fixtureSpecDetail(id));
    } catch (error) {
      return Promise.reject(error);
    }
  }
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
