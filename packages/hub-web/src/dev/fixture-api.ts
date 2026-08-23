import type { HubApi, JobSubscription } from "../api/client";
import type {
  ActivityItem,
  ActivityRequest,
  ActivityResponse,
  CapabilitiesResponse,
  HealthResponse,
  HomeResponse,
  JobsResponse,
  JobSummary,
  SearchResponse,
  SessionResponse,
  StartJobRequest,
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
    phase: "Extracting supported files",
    progress: { completed: 124, total: 183, message: "Extracting TypeScript sources" },
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
    phase: "Completed",
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
    phase: "Terminated",
    progress: { completed: 390, message: "Previous total was not retained" },
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
    phase: "Validation",
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
  wiki: { read: available, rebuild: unavailable("The real Wiki rebuild executor is not registered.") },
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
    workstreams: { availability: "available", count: 4 },
    relays: { availability: "unavailable", count: null, reason: "Relay workflows are not part of this read-only slice." },
    inbox: { availability: "unavailable", count: null, reason: "Inbox workflows are not part of this read-only slice." },
    activity: { availability: "available", count: 4 },
  },
  activeJobs: 1,
  attention: [
    { id: "attention_graph", kind: "job", title: "Graph refresh is in progress", summary: "Extraction is processing generation 14.", route: `/jobs?job=${jobs[0].id}`, tone: "neutral" },
    { id: "attention_grounding", kind: "health", title: "Three knowledge pages lost grounding", summary: "Their source fingerprints changed on this branch.", route: "/health", tone: "warning" },
    { id: "attention_activity", kind: "activity", title: "Repository activity is available", summary: "Immutable canonical and legacy history can be reviewed without changing the project.", route: "/activity", tone: "neutral" },
  ],
};

const health: HealthResponse = {
  status: "degraded",
  observedAt: timestamp(0),
  components: [
    { id: "git", label: "Git repository", status: "healthy", summary: "Branch and working tree are readable.", diagnostics: [] },
    { id: "graph", label: "Code graph", status: "degraded", summary: "A refresh is processing changed files.", diagnostics: [{ code: "GRAPH_STALE", severity: "warning", message: "Last successful index was generation 13." }], repairJobKind: "graph_refresh" },
    { id: "wiki", label: "Project Wiki", status: "degraded", summary: "42 entities loaded; 3 grounding links need review.", diagnostics: [{ code: "GROUNDING_STALE", severity: "warning", message: "Three source fingerprints no longer match." }], repairJobKind: "wiki_rebuild" },
    { id: "local_state", label: "Local Hub state", status: "healthy", summary: "Schema v2 jobs and team state are readable.", diagnostics: [] },
  ],
};

const searchResponse = (query: string): SearchResponse => ({
  query,
  observedAt: timestamp(0),
  groups: {
    wiki: {
      status: "available",
      items: [
        { id: "knowledge_secure_hub", kind: "wiki", title: "Secure loopback Hub", description: `The local control plane related to “${query}” uses process-memory sessions and strict request boundaries.`, route: "/knowledge" },
        { id: "decision_hidden_writes", kind: "wiki", title: "No hidden index writes", description: "Read-only views report freshness without rebuilding derived state.", route: "/knowledge" },
      ],
      nextCursor: null,
      truncated: false,
    },
    symbols: {
      status: "available",
      items: [
        { id: "symbol_create_hub", kind: "code_symbol", title: "createHubServer", description: "Creates the authenticated loopback application boundary.", path: "src/hub/server.ts", route: "/code" },
        { id: "symbol_job_executor", kind: "code_symbol", title: "JobExecutor", description: "Injected executor contract with generation-bound progress.", path: "src/hub/jobs/types.ts", route: "/code" },
      ],
      nextCursor: null,
      truncated: false,
    },
    sources: {
      status: "failed",
      items: [],
      nextCursor: null,
      truncated: false,
      detail: "Source-chunk retrieval failed independently. Knowledge and symbol results remain complete.",
    },
  },
});

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
  search(query: string) { return Promise.resolve(searchResponse(query)); }
  getHealth() { return Promise.resolve(health); }
  getJobs(): Promise<JobsResponse> { return Promise.resolve({ items: [...this.#jobs], nextCursor: null }); }
  getJob(id: string) { return Promise.resolve(this.#jobs.find((job) => job.id === id) ?? this.#jobs[0]); }
  startJob(request: StartJobRequest) {
    const job: JobSummary = {
      id: "job_01K36ZZZ6H7JK8M9NPQRSTVVWX",
      scaffoldId: "scf_mex",
      kind: request.kind,
      generation: 15,
      phase: "Queued",
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
    Object.assign(job, { cancelRequested: true, phase: "Stopping safely" });
    return Promise.resolve(job);
  }
  subscribeToJob(): JobSubscription { return { close() {} }; }
}

export function createFixtureApi(): HubApi {
  return new FixtureHubApi();
}
