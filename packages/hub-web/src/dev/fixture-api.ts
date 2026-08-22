import type { HubApi, JobSubscription } from "../api/client";
import type {
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
    relays: { availability: "available", count: 2 },
    inbox: { availability: "available", count: 3 },
    activity: { availability: "available", count: 28 },
  },
  activeJobs: 1,
  attention: [
    { id: "attention_graph", kind: "job", title: "Graph refresh is in progress", summary: "Extraction is processing generation 14.", route: `/jobs?job=${jobs[0].id}`, tone: "neutral" },
    { id: "attention_grounding", kind: "health", title: "Three knowledge pages lost grounding", summary: "Their source fingerprints changed on this branch.", route: "/health", tone: "warning" },
    { id: "attention_relay", kind: "activity", title: "Relay acknowledgement pending", summary: "The Project Hub handoff is waiting for one teammate.", route: "/relays", tone: "neutral" },
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
