import {
  HUB_LIMITS,
  type ActivityActor,
  type ActivityDiagnostic,
  type ActivityEntityRef,
  type ActivityRequest,
  type ActivityResponse,
  type ActivitySubject,
  type CapabilityStatus,
  type CodeWorkspaceRequest,
  type CodeWorkspaceResponse,
  type GraphHealthDetails,
  type GraphRelation as HubGraphRelation,
  type GraphSymbol as HubGraphSymbol,
  type HealthResponse,
  type HomeResponse,
  type HubActor,
  type HubCapabilities,
  type HubJobSnapshot,
  type SearchRequest,
  type SearchResponse,
} from "@mex/hub-contracts";
import { createHash } from "node:crypto";
import { basename } from "node:path";
import type {
  GraphImpactResult,
  GraphRelation,
  GraphSource,
  GraphStatus,
  CodeSymbol,
} from "../team/contracts/graph.js";
import type { GitPort } from "../team/contracts/git.js";
import { isRepoRelativePath, type ActorRef, type Diagnostic, type EntityRef } from "../team/contracts/shared.js";
import type { ActivitySubjectRef } from "../team/contracts/workflow.js";
import type { ResolvedTimelineEntry } from "../team/activity/repository.js";
import { TeamIdentityActivityFoundation } from "../team/foundation.js";
import { createRepositoryGitPort } from "../team/git/git-port.js";
import type { HubReadServices } from "./app.js";
import { HubHttpError } from "./http/errors.js";
import type {
  GraphSearchBundleRequest,
  GraphSearchBundleResult,
  GraphBoundedSourceMatch,
  GraphSymbolWorkspaceRequest,
  GraphSymbolWorkspaceResult,
} from "../graph/application-adapter.js";

interface HubJobReader {
  list(request?: { limit?: number }): {
    items: readonly HubJobSnapshot[];
  };
}

/** Narrow structural seam so production can inject the repository adapter and tests can stay isolated. */
export interface HubGraphReadService {
  inspectStatus(): Promise<GraphStatus>;
  searchBundle(request: GraphSearchBundleRequest): Promise<GraphSearchBundleResult>;
  readSymbolWorkspace(request: GraphSymbolWorkspaceRequest): Promise<GraphSymbolWorkspaceResult>;
}

export interface LocalHubReadServicesOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly jobs: HubJobReader;
  readonly git?: GitPort;
  readonly graph?: HubGraphReadService;
  readonly now?: () => Date;
}

/**
 * Honest production read model for the local Hub.
 *
 * Git, Activity, durable jobs, and an injected repository Graph adapter are
 * real. Wiki and later workflow aggregates stay explicitly unavailable until
 * their owning lanes are integrated; populated visual data is never built here.
 */
export function createLocalHubReadServices(
  options: LocalHubReadServicesOptions,
): HubReadServices {
  const now = options.now ?? (() => new Date());
  const git = options.git ?? createRepositoryGitPort(options.projectRoot, { now });
  const graph = options.graph;
  const team = new TeamIdentityActivityFoundation({
    projectRoot: options.projectRoot,
    scaffoldId: options.scaffoldId,
    git,
    now,
  });

  return {
    async capabilities(): Promise<HubCapabilities> {
      const gitStatus = await gitCapability(git);
      return {
        apiVersion: "v1",
        git: gitStatus,
        activity: available(),
        jobs: available(),
        graph: {
          read: graph ? available() : unavailable("The GraphPort is not connected in this build."),
          refresh: graph ? available() : unavailable("Graph refresh requires the Lane A adapter."),
          rebuild: graph ? available() : unavailable("Graph rebuild requires the Lane A recovery adapter."),
        },
        wiki: {
          read: unavailable("The WikiPort is not connected in this foundation build."),
          rebuild: unavailable("Wiki rebuild requires the teammate adapter."),
        },
      };
    },

    async home(): Promise<HomeResponse> {
      const [repository, actorResolution] = await Promise.all([
        git.getRepoState(),
        team.resolveCurrentActor(),
      ]);
      const jobs = options.jobs.list({ limit: 100 }).items;
      const active = jobs.filter((job) => job.state === "queued" || job.state === "running");
      const attention = jobs
        .filter((job) => job.state === "failed" || job.state === "interrupted")
        .slice(0, 5)
        .map((job) => jobAttention(job));
      let activity: HomeResponse["sections"]["activity"];
      try {
        activity = { availability: "available", count: team.getActivitySummary().count };
      } catch {
        activity = unavailableSection("Canonical activity could not be read safely.");
      }

      return {
        observedAt: now().toISOString(),
        repository: {
          scaffoldId: options.scaffoldId,
          name: basename(options.projectRoot),
          branch: repository.branch,
          head: repository.head,
          dirty: repository.dirty,
        },
        actor: actorResolution.actor as HubActor,
        sections: {
          workstreams: unavailableSection("Workstreams are not connected in this foundation build."),
          relays: unavailableSection("Relays are not connected in this foundation build."),
          inbox: unavailableSection("Inbox workflows are not connected in this foundation build."),
          activity,
        },
        activeJobs: active.length,
        attention,
      };
    },

    async activity(request: ActivityRequest): Promise<ActivityResponse> {
      let pageLimit = request.limit;
      while (true) {
        const page = await team.timeline.listResolved({ ...request, limit: pageLimit });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: ActivityResponse = {
          items: page.items.map(projectTimelineEntry),
          nextCursor: page.nextCursor,
          hasMore: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, 50),
          diagnosticsTruncated: diagnostics.length > 50,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        // `limit` is a maximum. Retry from the same revision-bound cursor with
        // a smaller coherent page rather than returning an oversized response
        // or trimming rows after their cursor was calculated.
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async search(request: SearchRequest): Promise<SearchResponse> {
      if (graph) return graphSearch(graph, request, now);
      return {
        query: request.q,
        observedAt: now().toISOString(),
        groups: {
          wiki: unavailableSearch("Wiki search requires the teammate adapter."),
          symbols: unavailableSearch("Code-symbol search requires the GraphPort adapter."),
          sources: unavailableSearch("Source-chunk search requires the GraphPort adapter."),
        },
      };
    },

    async health(): Promise<HealthResponse> {
      let gitStatus: "healthy" | "degraded" = "healthy";
      let gitSummary = "Repository state is readable without mutation.";
      try {
        await git.getRepoState();
      } catch {
        gitStatus = "degraded";
        gitSummary = "Repository state could not be observed safely.";
      }

      const graphComponent = graph
        ? await projectGraphHealth(graph, options.jobs)
        : {
            id: "graph" as const,
            label: "Code graph",
            status: "unavailable" as const,
            summary: "Graph health requires the Lane A adapter.",
            diagnostics: [],
          };
      return {
        status: "degraded",
        observedAt: now().toISOString(),
        components: [
          {
            id: "git",
            label: "Git repository",
            status: gitStatus,
            summary: gitSummary,
            diagnostics: [],
          },
          {
            id: "local_state",
            label: "Local Hub state",
            status: "healthy",
            summary: "Schema v3 job summaries are available locally.",
            diagnostics: [],
          },
          {
            id: "migration",
            label: "Local migration",
            status: "healthy",
            summary: "Local Hub state passed startup migration and validation.",
            diagnostics: [],
          },
          graphComponent,
          {
            id: "wiki",
            label: "Wiki index",
            status: "unavailable",
            summary: "Wiki health joins after the teammate adapter is integrated.",
            diagnostics: [],
          },
        ],
      };
    },

    async codeSymbol(
      symbolId: string,
      request: CodeWorkspaceRequest,
    ): Promise<CodeWorkspaceResponse> {
      if (!graph) {
        throw new HubHttpError(
          503,
          "CAPABILITY_UNAVAILABLE",
          "Capability unavailable",
          "Code graph reads are not connected in this build.",
        );
      }
      return readCodeWorkspace(graph, symbolId, request);
    },

    async assertJobStartAllowed(kind): Promise<void> {
      if (kind !== "graph_refresh" && kind !== "graph_rebuild") return;
      // Preserve the job manager's authoritative 409 contention response (and
      // active job ID). A running writer can make graph status deliberately
      // non-actionable, but it must not mask JOB_ALREADY_RUNNING as a 503.
      const active = options.jobs.list({ limit: 100 }).items.find((job) => (
        job.state === "queued" || job.state === "running"
      ));
      if (active) return;
      if (!graph) {
        throw new HubHttpError(
          503,
          "CAPABILITY_UNAVAILABLE",
          "Capability unavailable",
          "Graph maintenance is not connected in this build.",
        );
      }
      const status = await graph.inspectStatus();
      const operations = allowedGraphOperations(status);
      if (!operations.includes(kind)) {
        throw new HubHttpError(
          503,
          "CAPABILITY_UNAVAILABLE",
          "Capability unavailable",
          "The requested graph operation is not safe for the current index state.",
        );
      }
    },
  };
}

async function graphSearch(
  graph: HubGraphReadService,
  request: SearchRequest,
  now: () => Date,
): Promise<SearchResponse> {
  const bundle = await graph.searchBundle({
    nodes: {
      query: request.q,
      limit: request.limit,
      ...(request.symbolCursor === undefined ? {} : { cursor: request.symbolCursor }),
    },
    sources: {
      query: request.q,
      limit: request.limit,
      maxLinesPerMatch: 40,
      maxBytesPerMatch: 2_048,
      ...(request.sourceCursor === undefined ? {} : { cursor: request.sourceCursor }),
    },
  });
  return {
    query: request.q,
    observedAt: now().toISOString(),
    groups: {
      wiki: unavailableSearch("Wiki search requires the teammate adapter."),
      symbols: bundle.nodes.ok
        ? {
            status: "available",
            items: bundle.nodes.value.items.map(projectSearchSymbol),
            nextCursor: bundle.nodes.value.nextCursor,
            truncated: bundle.nodes.value.truncated,
            revision: bundle.revision,
          }
        : failedSearch(bundle.nodes.problem),
      sources: bundle.sources.ok
        ? {
            status: "available",
            items: bundle.sources.value.items.map((item) => projectSearchSource(item, bundle.revision)),
            nextCursor: bundle.sources.value.nextCursor,
            truncated: bundle.sources.value.truncated,
            revision: bundle.revision,
          }
        : failedSearch(bundle.sources.problem),
    },
  };
}

async function readCodeWorkspace(
  graph: HubGraphReadService,
  symbolId: string,
  request: CodeWorkspaceRequest,
): Promise<CodeWorkspaceResponse> {
  const relationRequest = request.view === "callers" || request.view === "callees"
    ? {
        limit: request.limit ?? 25,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      }
    : undefined;
  const workspace = await graph.readSymbolWorkspace({
    symbolId,
    workspaceView: request.view,
    source: {
      maxLines: 200,
      maxBytes: 128 * 1_024,
      limit: 25,
      ...(request.sourceCursor === undefined ? {} : { cursor: request.sourceCursor }),
    },
    ...(request.view === "callers" ? { callers: relationRequest } : {}),
    ...(request.view === "callees" ? { callees: relationRequest } : {}),
    ...(request.view === "impact"
      ? { impact: { depth: request.depth ?? 2, maxNodes: 100 } }
      : {}),
  });
  return {
    revision: workspace.revision,
    symbol: projectGraphSymbol(workspace.symbol),
    source: {
      items: workspace.source.items.map(projectGraphSource),
      nextCursor: workspace.source.nextCursor,
      truncated: workspace.source.truncated,
    },
    view: request.view,
    traversal: projectWorkspaceTraversal(workspace, request.view),
  };
}

function projectWorkspaceTraversal(
  workspace: GraphSymbolWorkspaceResult,
  view: CodeWorkspaceRequest["view"],
): CodeWorkspaceResponse["traversal"] {
  if (view === "overview") return { view };
  if (view === "callers" || view === "callees") {
    const page = view === "callers" ? workspace.callers : workspace.callees;
    if (page === null) throw invalidGraphProjection();
    return {
      view,
      items: page.items.map(projectGraphRelation),
      nextCursor: page.nextCursor,
      truncated: page.truncated,
    };
  }
  if (workspace.impact === null) throw invalidGraphProjection();
  return projectGraphImpact(workspace.impact);
}

function projectSearchSymbol(symbol: CodeSymbol): SearchResponse["groups"]["symbols"]["items"][number] {
  return { kind: "code_symbol", ...projectGraphSymbol(symbol) };
}

function projectSearchSource(
  source: GraphBoundedSourceMatch,
  graphRevision: string,
): SearchResponse["groups"]["sources"]["items"][number] {
  const preview = truncateUtf8(source.content, 2_048);
  const symbolIds = source.symbolRefs.map((ref) => ref.symbolId).slice(0, 8);
  return {
    id: createHash("sha256")
      .update(`${graphRevision}\0${source.path}\0${source.startLine}\0${source.endLine}\0${source.contentHash}`)
      .digest("hex"),
    kind: "source_chunk",
    path: source.path,
    startLine: source.startLine,
    endLine: source.endLine,
    preview,
    previewTruncated: source.bytesTruncated
      || source.linesTruncated
      || Buffer.byteLength(source.content, "utf8") > 2_048,
    matchedTerms: source.matchedTerms
      .map((term) => truncateUtf8(safeDisplayText(term), 128))
      .filter((term) => term.length > 0)
      .slice(0, 32),
    symbolIds,
    ...(symbolIds[0] === undefined
      ? {}
      : { route: graphSymbolRoute(symbolIds[0]) }),
  };
}

function projectGraphSymbol(symbol: CodeSymbol): HubGraphSymbol {
  return {
    id: symbol.ref.symbolId,
    symbolKind: truncateUtf8(safeDisplayText(symbol.symbolKind), 128),
    name: truncateUtf8(safeDisplayText(symbol.name), 512),
    qualifiedName: truncateUtf8(safeDisplayText(symbol.qualifiedName), 1_024),
    language: truncateUtf8(safeDisplayText(symbol.language), 128),
    path: symbol.path,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
    ...(symbol.signature === undefined
      ? {}
      : { signature: truncateUtf8(safeDisplayText(symbol.signature), 2_048) }),
    route: graphSymbolRoute(symbol.ref.symbolId),
  };
}

function projectGraphSource(source: GraphSource): CodeWorkspaceResponse["source"]["items"][number] {
  return {
    path: source.path,
    startLine: source.startLine,
    endLine: source.endLine,
    content: truncateUtf8(source.content, 128 * 1_024),
    contentHash: source.contentHash,
    symbolIds: source.symbolRefs.map((ref) => ref.symbolId).slice(0, 100),
  };
}

function projectGraphRelation(relation: GraphRelation): HubGraphRelation {
  return {
    kind: truncateUtf8(safeDisplayText(relation.kind), 128),
    sourceId: relation.source.symbolId,
    targetId: relation.target.symbolId,
    ...(relation.path === undefined || !isCanonicalRepoPath(relation.path)
      ? {}
      : { path: relation.path }),
    ...(relation.line === undefined ? {} : { line: relation.line }),
    ...(relation.column === undefined ? {} : { column: relation.column }),
    ...(relation.confidence === undefined ? {} : { confidence: relation.confidence }),
    ...(relation.provenance === undefined
      ? {}
      : { provenance: truncateUtf8(safeDisplayText(relation.provenance), 128) }),
  };
}

function projectGraphImpact(impact: GraphImpactResult): CodeWorkspaceResponse["traversal"] {
  if (impact.target.kind !== "symbol") throw invalidGraphProjection();
  return {
    view: "impact",
    targetId: impact.target.symbolId,
    roots: impact.roots.slice(0, 100).map(projectGraphSymbol),
    impacted: impact.impacted.slice(0, 100).map((item) => ({
      symbol: projectGraphSymbol(item.symbol),
      depth: item.depth,
      rootId: item.root.symbolId,
    })),
    relations: impact.relations.slice(0, 500).map(projectGraphRelation),
    truncated: impact.truncated
      || impact.roots.length > 100
      || impact.impacted.length > 100
      || impact.relations.length > 500,
  };
}

async function projectGraphHealth(
  graph: HubGraphReadService,
  jobs: HubJobReader,
): Promise<HealthResponse["components"][number]> {
  try {
    const status = await graph.inspectStatus();
    const allowedJobKinds = allowedGraphOperations(status);
    const recommendedJobKind = recommendedGraphOperation(status, allowedJobKinds);
    const active = jobs.list({ limit: 100 }).items.find((job) => (
      (job.kind === "graph_refresh" || job.kind === "graph_rebuild")
      && (job.state === "queued" || job.state === "running")
    ));
    const failedPaths = status.parseHealth.failedPaths
      .filter(isCanonicalRepoPath)
      .slice(0, 25);
    const added = status.changes.added.filter(isCanonicalRepoPath).slice(0, 25);
    const modified = status.changes.modified.filter(isCanonicalRepoPath).slice(0, 25);
    const deleted = status.changes.deleted.filter(isCanonicalRepoPath).slice(0, 25);
    const graphDetails: GraphHealthDetails = {
      indexStatus: status.status,
      observedAt: status.observedAt,
      lastSuccessfulIndexAt: status.lastSuccessfulIndexAt,
      indexedAt: status.indexedAt,
      indexedBranch: status.indexedBranch,
      indexedHead: status.indexedHead,
      currentBranch: status.currentRepo.branch,
      currentHead: status.currentRepo.head,
      schemaVersion: status.schemaVersion,
      extractorVersion: status.extractorVersion,
      grammarVersion: status.grammarVersion,
      parseHealth: {
        total: status.parseHealth.total,
        ok: status.parseHealth.ok,
        partial: status.parseHealth.partial,
        failed: status.parseHealth.failed,
        failedPaths,
        failedPathsTruncated: status.parseHealth.failedPathsTruncated
          || failedPaths.length !== status.parseHealth.failedPaths.length,
      },
      changes: {
        total: status.changes.total,
        added,
        modified,
        deleted,
        truncated: status.changes.truncated
          || added.length !== status.changes.added.length
          || modified.length !== status.changes.modified.length
          || deleted.length !== status.changes.deleted.length,
        branchChanged: status.changes.branchChanged,
        manifestChanged: status.changes.manifestChanged,
        configChanged: status.changes.configChanged,
        grammarChanged: status.changes.grammarChanged,
      },
      allowedJobKinds,
      recommendedJobKind,
      activeJobId: active?.id ?? null,
    };
    return {
      id: "graph",
      label: "Code graph",
      status: status.status === "fresh" && status.parseHealth.failed === 0
        ? "healthy"
        : "degraded",
      summary: graphHealthSummary(status),
      diagnostics: status.diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount).map(projectGraphDiagnostic),
      ...(recommendedJobKind === null ? {} : { repairJobKind: recommendedJobKind }),
      graph: graphDetails,
    };
  } catch {
    return {
      id: "graph",
      label: "Code graph",
      status: "unavailable",
      summary: "Graph status could not be observed against a stable local snapshot.",
      diagnostics: [],
    };
  }
}

function allowedGraphOperations(status: GraphStatus): Array<"graph_refresh" | "graph_rebuild"> {
  if (status.status === "fresh") return ["graph_refresh", "graph_rebuild"];
  const commands = new Set(status.diagnostics.flatMap((diagnostic) => (
    diagnostic.remediation?.map((action) => action.command).filter(Boolean) ?? []
  )));
  const operations: Array<"graph_refresh" | "graph_rebuild"> = [];
  if (commands.has("mex graph refresh")) operations.push("graph_refresh");
  if (commands.has("mex graph rebuild") || commands.has("mex graph")) {
    operations.push("graph_rebuild");
  }
  return operations;
}

function recommendedGraphOperation(
  status: GraphStatus,
  allowed: readonly ("graph_refresh" | "graph_rebuild")[],
): "graph_refresh" | "graph_rebuild" | null {
  if (status.status === "fresh") return null;
  if (allowed.includes("graph_refresh")) return "graph_refresh";
  if (allowed.includes("graph_rebuild")) return "graph_rebuild";
  return null;
}

function graphHealthSummary(status: GraphStatus): string {
  switch (status.status) {
    case "fresh":
      return status.parseHealth.failed === 0
        ? "The code graph matches the current repository snapshot."
        : "The graph is current, but some source files could not be parsed completely.";
    case "missing": return "No code graph has been built for this repository.";
    case "stale": return `${status.changes.total} repository change${status.changes.total === 1 ? "" : "s"} require an explicit graph refresh.`;
    case "degraded": return "Graph health could not be established completely; retry after resolving the reported condition.";
    case "rebuild_required": return "The code graph requires an explicit compatible rebuild.";
    case "corrupt": return "The code graph failed integrity checks and cannot be read safely.";
  }
}

function projectGraphDiagnostic(diagnostic: Diagnostic): HealthResponse["components"][number]["diagnostics"][number] {
  return {
    code: /^[A-Z0-9_]{1,128}$/.test(diagnostic.code) ? diagnostic.code : "GRAPH_DIAGNOSTIC",
    severity: diagnostic.severity,
    message: graphDiagnosticMessage(diagnostic.code),
    ...(diagnostic.path !== undefined && isCanonicalRepoPath(diagnostic.path)
      ? { path: diagnostic.path }
      : {}),
  };
}

function graphDiagnosticMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    GRAPH_INDEX_MISSING: "The graph index is missing.",
    GRAPH_INDEX_BRANCH_CHANGED: "The indexed branch differs from the current branch.",
    GRAPH_INDEX_HEAD_CHANGED: "The repository HEAD changed since the last successful index.",
    GRAPH_BUILD_MANIFEST_CHANGED: "Graph extraction inputs changed since the last index.",
    GRAPH_SEMANTIC_INPUTS_CHANGED: "Graph semantic inputs changed since the last index.",
    GRAPH_SOURCE_CORPUS_MISMATCH: "The source corpus differs from the indexed snapshot.",
    GRAPH_PARSE_DEGRADED: "One or more source files could not be parsed completely.",
    GRAPH_INDEX_REBUILD_REQUIRED: "The graph requires an explicit rebuild.",
    GRAPH_INDEX_CORRUPT: "The graph failed an integrity check.",
    GRAPH_INDEX_SIDECAR_ACTIVE: "Graph maintenance is currently publishing local changes.",
    GRAPH_STATUS_OBSERVATION_RACE: "Repository state changed during graph inspection.",
  };
  return messages[code] ?? "The graph reported a bounded local health diagnostic.";
}

function failedSearch(problem: { code: string }): SearchResponse["groups"]["symbols"] {
  const code = isSearchFailureCode(problem.code) ? problem.code : "INTERNAL_ERROR";
  return {
    status: "failed",
    items: [],
    nextCursor: null,
    truncated: false,
    revision: null,
    code,
    detail: searchFailureDetail(code),
  };
}

function isSearchFailureCode(code: string): code is "VALIDATION_FAILED" | "REVISION_CONFLICT" {
  return code === "VALIDATION_FAILED" || code === "REVISION_CONFLICT";
}

function searchFailureDetail(code: string): string {
  return code === "REVISION_CONFLICT"
    ? "The graph changed since this result page was loaded. Reload the newest results."
    : "This search page cursor is invalid for the current request.";
}

function graphSymbolRoute(symbolId: string): string {
  return `/code/symbols/${encodeURIComponent(symbolId)}`;
}

function safeDisplayText(value: string): string {
  return value.normalize("NFC").replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
}

function invalidGraphProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid graph projection",
    "The graph adapter returned an invalid bounded workspace result.",
  );
}

function projectTimelineEntry(item: ResolvedTimelineEntry): ActivityResponse["items"][number] {
  const entry = item.entry;
  if (entry.source === "legacy") {
    const safeFiles = entry.files.filter(isCanonicalRepoPath);
    const subjects = safeFiles
      .filter((path) => Buffer.byteLength(path, "utf8") <= 384)
      .map((path): ActivitySubject => ({ kind: "file", path }));
    const preview = subjects.slice(0, 8);
    const message = boundedLegacyMessage(entry.message);
    return {
      source: "legacy",
      id: entry.id,
      timestamp: entry.timestamp,
      action: entry.kind,
      subjects: preview,
      subjectCount: safeFiles.length,
      subjectsTruncated: safeFiles.length > preview.length,
      sourcePath: entry.sourcePath,
      recordedActor: null,
      effectiveActor: null,
      actorDiagnostics: [],
      workstream: null,
      repository: null,
      revision: null,
      sourceLine: entry.sourceLine,
      message: message.value,
      messageTruncated: message.truncated,
    };
  }

  const subjects = entry.event.subjects.flatMap((subject) => {
    const projected = projectSubject(subject);
    return projected === null ? [] : [projected];
  });
  const preview = subjects.slice(0, 8);
  return {
    source: "activity",
    id: entry.id,
    timestamp: entry.timestamp,
    action: entry.event.action,
    subjects: preview,
    subjectCount: entry.event.subjects.length,
    subjectsTruncated: entry.event.subjects.length > preview.length,
    sourcePath: entry.sourcePath,
    recordedActor: projectActor(item.recordedActor ?? entry.actor),
    effectiveActor: projectActor(item.effectiveActor ?? entry.actor),
    actorDiagnostics: item.diagnostics.slice(0, 2).map(projectDiagnostic),
    workstream: entry.event.workstream === undefined
      ? null
      : projectEntity(entry.event.workstream),
    repository: {
      branch: entry.repoState.branch,
      head: entry.repoState.head,
      dirty: entry.repoState.dirty,
      observedAt: entry.repoState.observedAt,
    },
    revision: entry.event.revision,
  };
}

function projectActor(actor: ActorRef): ActivityActor {
  if (actor.kind === "unknown") return actor;
  if (actor.kind === "git") return actor;
  return {
    kind: "member",
    memberId: actor.memberId,
    displayName: actor.displayName ?? null,
  };
}

function projectEntity(entity: EntityRef): ActivityEntityRef {
  return {
    id: entity.id,
    entityKind: entity.kind,
    title: entity.title ?? null,
  };
}

function projectSubject(subject: ActivitySubjectRef): ActivitySubject | null {
  if (subject.kind === "entity") {
    return { kind: "entity", entity: projectEntity(subject.entity) };
  }
  if (subject.kind === "commit") return { kind: "commit", hash: subject.hash };
  if (subject.kind === "file") {
    return isActivityDisplayPath(subject.path) ? { kind: "file", path: subject.path } : null;
  }
  if (subject.code.kind === "file") {
    return isActivityDisplayPath(subject.code.path)
      ? { kind: "file", path: subject.code.path }
      : null;
  }
  return { kind: "symbol", symbolId: subject.code.symbolId };
}

function projectDiagnostic(diagnostic: Diagnostic): ActivityDiagnostic {
  return {
    code: truncateUtf8(diagnostic.code, 128) || "ACTIVITY_DIAGNOSTIC",
    severity: diagnostic.severity,
    message: safeDiagnosticMessage(diagnostic.code),
    ...(diagnostic.path !== undefined
      && isActivityDisplayPath(diagnostic.path)
      ? { path: diagnostic.path }
      : {}),
  };
}

function safeDiagnosticMessage(code: string): string {
  switch (code) {
    case "ACTIVITY_ARTIFACT_UNEXPECTED":
      return "An unexpected item in canonical activity storage was ignored.";
    case "ACTIVITY_ID_CONFLICT":
      return "Conflicting canonical events were excluded from trusted activity.";
    case "ACTIVITY_SOURCE_TRUNCATED":
      return "Canonical activity exceeded its safe read bound.";
    case "LEGACY_ACTIVITY_MALFORMED":
      return "A malformed legacy activity row was ignored.";
    case "LEGACY_ACTIVITY_DUPLICATE":
      return "A duplicate legacy activity row was retained with a diagnostic.";
    case "LEGACY_ACTIVITY_LIMIT_EXCEEDED":
      return "Legacy activity exceeded its safe read bound.";
    case "ACTOR_MEMBER_MISSING":
      return "The recorded member no longer exists; the recorded actor was preserved.";
    case "ACTOR_MEMBER_INACTIVE":
      return "The recorded member is currently inactive.";
    case "ACTOR_ALIAS_AMBIGUOUS":
      return "The recorded Git identity matches multiple active members and was not remapped.";
    case "GIT_IDENTITY_UNAVAILABLE":
      return "Git identity could not be inspected safely.";
    default:
      return "Activity history reported a local diagnostic.";
  }
}

function boundedLegacyMessage(message: string): { value: string; truncated: boolean } {
  const normalized = message
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/g, " ");
  return {
    value: truncateUtf8(normalized, 2_048),
    truncated: Buffer.byteLength(normalized, "utf8") > 2_048,
  };
}

function isCanonicalRepoPath(path: string): boolean {
  return isRepoRelativePath(path)
    && path.normalize("NFC") === path
    && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(path);
}

function isActivityDisplayPath(path: string): boolean {
  return isCanonicalRepoPath(path) && Buffer.byteLength(path, "utf8") <= 384;
}

function truncateUtf8(value: string, maximumBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maximumBytes) return value;
  let result = "";
  let bytes = 0;
  for (const character of value) {
    const width = Buffer.byteLength(character, "utf8");
    if (bytes + width > maximumBytes) break;
    result += character;
    bytes += width;
  }
  return result;
}

function available(): CapabilityStatus {
  return { availability: "available" };
}

function unavailable(reason: string): CapabilityStatus {
  return { availability: "unavailable", reason };
}

async function gitCapability(git: GitPort): Promise<CapabilityStatus> {
  try {
    await git.getRepoState();
    return available();
  } catch {
    return unavailable("Git repository state is not safely readable.");
  }
}

function unavailableSection(reason: string): HomeResponse["sections"]["activity"] {
  return { availability: "unavailable", count: null, reason };
}

function unavailableSearch(reason: string): SearchResponse["groups"]["wiki"] {
  return {
    status: "unavailable",
    items: [],
    nextCursor: null,
    truncated: false,
    revision: null,
    code: "CAPABILITY_UNAVAILABLE",
    detail: reason,
  };
}

function jobAttention(job: HubJobSnapshot): HomeResponse["attention"][number] {
  const failed = job.state === "failed";
  return {
    id: job.id,
    kind: "job",
    title: failed ? "A local operation failed" : "A local operation was interrupted",
    summary: failed
      ? job.problem?.detail ?? "Open Jobs to review the failure."
      : "Open Jobs to review the interrupted operation.",
    tone: failed ? "critical" : "warning",
    route: "/jobs",
  };
}
