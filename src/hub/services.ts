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
  type CodeKnowledgeRequest,
  type CodeKnowledgeResponse,
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
  type TeamCurrentActorResponse,
  type TeamMember as HubTeamMember,
  type TeamMemberListRequest as HubTeamMemberListRequest,
  type TeamMemberListResponse,
  type TeamOperationApplyRequest,
  type TeamOperationApplyResponse,
  type TeamOperationPreviewRequest,
  type TeamOperationPreviewResponse,
  type WikiBacklinksRequest,
  type WikiBacklinksResponse,
  type WikiEntityDetailResponse,
  type WikiEntityListRequest,
  type WikiEntityListResponse,
  type WikiEntitySummary as HubWikiEntitySummary,
  type WikiGrounding as HubWikiGrounding,
  type WikiHealthDetails,
  type WikiRelation as HubWikiRelation,
  type WikiRelationsRequest,
  type WikiRelationsResponse,
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
import {
  isRepoRelativePath,
  type ActorRef,
  type Diagnostic,
  type EntityRef,
  type JsonValue,
} from "../team/contracts/shared.js";
import type {
  ActivityEvent,
  ActivitySubjectRef,
  StoredActivityEvent,
  TeamActivityListRequest,
  TeamCurrentActor,
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
  TeamMember,
  TeamMemberListRequest,
  TeamPage,
  TeamWorkflowResult,
} from "../team/contracts/workflow.js";
import type {
  WikiEntity,
  WikiEntitySummary,
  WikiGroundingResolution,
  WikiIndexStatus,
  WikiListRequest,
  WikiQueryRequest,
  WikiRelation,
  WikiRelationHit,
  WikiSource,
} from "../team/contracts/wiki.js";
import {
  ActivityRepository,
  TimelineReader,
  type ResolvedTimelineEntry,
} from "../team/activity/repository.js";
import { createRepositoryGitPort } from "../team/git/git-port.js";
import { ActorResolver } from "../team/identity/actor-resolver.js";
import { MemberRepository } from "../team/identity/member-repository.js";
import type { HubReadServices } from "./app.js";
import { HubHttpError } from "./http/errors.js";
import type {
  GraphSearchBundleRequest,
  GraphSearchBundleResult,
  GraphBoundedSourceMatch,
  GraphSymbolWorkspaceRequest,
  GraphSymbolWorkspaceResult,
} from "../graph/application-adapter.js";
import type {
  RepositoryCodeKnowledgeRequest,
  RepositoryCodeKnowledgeResult,
  RepositoryKnowledgeWorkspace,
  RepositoryKnowledgeWorkspaceRequest,
  RepositoryWikiListBundle,
  RepositoryWikiSearchBundle,
} from "../wiki/application-adapter.js";

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

/** Narrow private seam implemented by the repository-bound Wiki adapter. */
export interface HubWikiReadService {
  inspectIndex(): Promise<WikiIndexStatus>;
  listBundle(request: WikiListRequest): Promise<RepositoryWikiListBundle>;
  searchBundle(request: WikiQueryRequest): Promise<RepositoryWikiSearchBundle>;
  readKnowledgeWorkspace(request: RepositoryKnowledgeWorkspaceRequest): Promise<RepositoryKnowledgeWorkspace>;
  knowledgeForCode(request: RepositoryCodeKnowledgeRequest): Promise<RepositoryCodeKnowledgeResult>;
}

/** Exact internal C0 application facade used by the private Hub. */
export interface HubTeamIdentityActivityService {
  getMember(memberId: string): Promise<TeamMember | null>;
  listMembers(request?: TeamMemberListRequest): Promise<TeamPage<TeamMember>>;
  getCurrentActor(): Promise<TeamCurrentActor>;
  getActivity(id: string): Promise<StoredActivityEvent | null>;
  listActivity(request?: TeamActivityListRequest): Promise<TeamPage<StoredActivityEvent>>;
  previewIdentityActivity(
    command: TeamIdentityActivityCommand,
  ): Promise<TeamIdentityActivityPreviewEnvelope>;
  applyIdentityActivity(
    envelope: TeamIdentityActivityPreviewEnvelope,
  ): Promise<TeamWorkflowResult<JsonValue>>;
}

export interface LocalHubReadServicesOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly jobs: HubJobReader;
  readonly team: HubTeamIdentityActivityService;
  readonly git?: GitPort;
  readonly graph?: HubGraphReadService;
  readonly wiki?: HubWikiReadService;
  readonly now?: () => Date;
}

/**
 * Honest production read model for the local Hub.
 *
 * Git, Activity, durable jobs, and injected repository Graph/Wiki adapters are
 * real. Later workflow aggregates stay explicitly unavailable; populated
 * visual data is never built here.
 */
export function createLocalHubReadServices(
  options: LocalHubReadServicesOptions,
): HubReadServices {
  const now = options.now ?? (() => new Date());
  const git = options.git ?? createRepositoryGitPort(options.projectRoot, { now });
  const graph = options.graph;
  const wiki = options.wiki;
  const team = options.team;
  // Activity's existing workbench includes bounded legacy JSONL alongside
  // canonical events and resolves today's effective member separately from the
  // immutable recorded actor. Keep that read model independent from C0 writes.
  const members = new MemberRepository(options.projectRoot);
  const actors = new ActorResolver(members, git);
  const canonicalActivity = new ActivityRepository({
    projectRoot: options.projectRoot,
    git,
    now,
  });
  const timeline = new TimelineReader(options.projectRoot, canonicalActivity, actors);

  return {
    async capabilities(): Promise<HubCapabilities> {
      const gitStatus = await gitCapability(git);
      return {
        apiVersion: "v1",
        git: gitStatus,
        activity: available(),
        activityRecord: available(),
        members: {
          read: available(),
          canonicalMutation: available(),
          localSelection: available(),
        },
        jobs: available(),
        graph: {
          read: graph ? available() : unavailable("The GraphPort is not connected in this build."),
          refresh: graph ? available() : unavailable("Graph refresh requires the Lane A adapter."),
          rebuild: graph ? available() : unavailable("Graph rebuild requires the Lane A recovery adapter."),
        },
        wiki: {
          read: wiki ? available() : unavailable("The WikiPort is not connected in this build."),
          refresh: wiki ? available() : unavailable("Wiki refresh requires the repository adapter."),
          rebuild: wiki ? available() : unavailable("Wiki rebuild requires the repository adapter."),
        },
      };
    },

    async home(): Promise<HomeResponse> {
      const [repository, actorResolution] = await Promise.all([
        git.getRepoState(),
        team.getCurrentActor(),
      ]);
      const jobs = options.jobs.list({ limit: 100 }).items;
      const active = jobs.filter((job) => job.state === "queued" || job.state === "running");
      const attention = jobs
        .filter((job) => job.state === "failed" || job.state === "interrupted")
        .slice(0, 5)
        .map((job) => jobAttention(job));
      let activity: HomeResponse["sections"]["activity"];
      try {
        const read = canonicalActivity.readAll();
        if (read.sourceTruncated) throw new Error("Canonical Activity source was truncated.");
        activity = { availability: "available", count: read.events.length };
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

    async members(request: HubTeamMemberListRequest): Promise<TeamMemberListResponse> {
      let pageLimit = request.limit;
      while (true) {
        const page = await team.listMembers({
          active: request.active,
          limit: pageLimit,
          ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        });
        const diagnostics = page.diagnostics.map(projectDiagnostic);
        const response: TeamMemberListResponse = {
          items: page.items.map(projectTeamMember),
          nextCursor: page.nextCursor,
          truncated: page.truncated,
          sourceTruncated: page.sourceTruncated,
          deterministicRevision: page.deterministicRevision,
          diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
          diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
        };
        if (Buffer.byteLength(JSON.stringify(response), "utf8") <= HUB_LIMITS.maxJsonResponseBytes) {
          return response;
        }
        // Recompute the cursor and rows together at a smaller maximum. Trimming
        // an already-built page would make its continuation cursor skip data.
        if (pageLimit <= 1) return response;
        pageLimit = Math.max(1, Math.floor(pageLimit / 2));
      }
    },

    async member(memberId: string): Promise<HubTeamMember | null> {
      const member = await team.getMember(memberId);
      return member === null ? null : projectTeamMember(member);
    },

    async currentActor(): Promise<TeamCurrentActorResponse> {
      const current = await team.getCurrentActor();
      const diagnostics = current.diagnostics.map(projectDiagnostic);
      return {
        actor: cloneActor(current.actor),
        source: current.source,
        selection: current.selection === null ? null : { ...current.selection },
        diagnostics: diagnostics.slice(0, HUB_LIMITS.maxDiagnosticCount),
        diagnosticsTruncated: diagnostics.length > HUB_LIMITS.maxDiagnosticCount,
      };
    },

    async previewTeamOperation(
      request: TeamOperationPreviewRequest,
    ): Promise<TeamOperationPreviewResponse> {
      return projectTeamOperationEnvelope(
        await team.previewIdentityActivity(toIdentityActivityCommand(request)),
      );
    },

    async applyTeamOperation(
      request: TeamOperationApplyRequest,
    ): Promise<TeamOperationApplyResponse> {
      const result = await team.applyIdentityActivity(
        toIdentityActivityEnvelope(request),
      );
      if (result.artifacts.some((artifact) => artifact.kind !== "member")) {
        throw invalidTeamProjection();
      }
      return {
        operationId: result.operationId,
        previewRevision: result.previewRevision,
        applied: true,
        idempotentReplay: result.idempotentReplay,
        changes: result.changes.map((change) => ({ ...change })),
        localChanges: projectIdentityLocalChanges(result.localChanges),
        members: result.artifacts
          .filter((artifact): artifact is TeamMember => artifact.kind === "member")
          .map(projectTeamMember),
        events: result.events.map(projectTeamActivityEvent),
      };
    },

    async activity(request: ActivityRequest): Promise<ActivityResponse> {
      let pageLimit = request.limit;
      while (true) {
        const page = await timeline.listResolved({ ...request, limit: pageLimit });
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
      return unifiedSearch(graph, wiki, request, now);
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
      const wikiComponent = wiki
        ? await projectWikiHealth(wiki, options.jobs)
        : {
            id: "wiki" as const,
            label: "Wiki index",
            status: "unavailable" as const,
            summary: "Wiki health requires the repository adapter.",
            diagnostics: [],
          };
      const components: HealthResponse["components"] = [
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
        wikiComponent,
      ];
      return {
        status: components.every((component) => component.status === "healthy")
          ? "healthy"
          : "degraded",
        observedAt: now().toISOString(),
        components,
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

    async wikiEntities(request: WikiEntityListRequest): Promise<WikiEntityListResponse> {
      const connected = requireWiki(wiki);
      const bundle = await connected.listBundle({
        limit: request.limit,
        includeArchived: request.lifecycle === "archived",
        ...(request.kind === undefined ? {} : { kinds: [request.kind] }),
        ...(request.topic === undefined ? {} : { topics: [request.topic] }),
        ...(request.lifecycle === undefined ? {} : { lifecycleStates: [request.lifecycle] }),
        ...(request.grounding === undefined ? {} : { groundingHealth: [request.grounding] }),
        ...(request.sourceType === undefined ? {} : { sourceTypes: [request.sourceType] }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      return {
        indexedRevision: bundle.indexedRevision,
        observedAt: bundle.observedAt,
        items: bundle.results.items.map(projectWikiSummary),
        nextCursor: bundle.results.nextCursor,
        truncated: bundle.results.truncated,
      };
    },

    async wikiEntity(entityId: string): Promise<WikiEntityDetailResponse> {
      const workspace = await requireWiki(wiki).readKnowledgeWorkspace({ entityId });
      return projectWikiDetail(workspace);
    },

    async wikiRelations(
      entityId: string,
      request: WikiRelationsRequest,
    ): Promise<WikiRelationsResponse> {
      const workspace = await requireWiki(wiki).readKnowledgeWorkspace({
        entityId,
        view: "relations",
        direction: request.direction,
        includeArchived: true,
        limit: request.limit,
        ...(request.type === undefined ? {} : { relationTypes: [request.type] }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      if (workspace.selection.kind !== "relations") throw invalidWikiProjection();
      return {
        indexedRevision: workspace.indexedRevision,
        observedAt: workspace.observedAt,
        items: workspace.selection.results.items.map(projectWikiRelationHit),
        nextCursor: workspace.selection.results.nextCursor,
        truncated: workspace.selection.results.truncated,
      };
    },

    async wikiBacklinks(
      entityId: string,
      request: WikiBacklinksRequest,
    ): Promise<WikiBacklinksResponse> {
      const workspace = await requireWiki(wiki).readKnowledgeWorkspace({
        entityId,
        view: "backlinks",
        includeArchived: true,
        limit: request.limit,
        ...(request.type === undefined ? {} : { relationTypes: [request.type] }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      if (workspace.selection.kind !== "backlinks") throw invalidWikiProjection();
      return {
        indexedRevision: workspace.indexedRevision,
        observedAt: workspace.observedAt,
        items: workspace.selection.results.items.map(projectWikiRelation),
        nextCursor: workspace.selection.results.nextCursor,
        truncated: workspace.selection.results.truncated,
      };
    },

    async codeKnowledge(
      symbolId: string,
      request: CodeKnowledgeRequest,
    ): Promise<CodeKnowledgeResponse> {
      const result = await requireWiki(wiki).knowledgeForCode({
        nodeIds: [symbolId],
        limit: request.limit,
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      });
      return {
        indexedRevision: result.indexedRevision,
        observedAt: result.observedAt,
        items: result.items.map((item) => ({
          entity: projectWikiSummary(item.entity),
          matchedNodes: item.matchedNodes.slice(0, 50),
        })),
        nextCursor: result.nextCursor,
        truncated: result.truncated,
      };
    },

    async assertJobStartAllowed(kind): Promise<void> {
      if (!["graph_refresh", "graph_rebuild", "wiki_refresh", "wiki_rebuild"].includes(kind)) return;
      // Preserve the job manager's authoritative 409 contention response (and
      // active job ID). A running writer can make graph status deliberately
      // non-actionable, but it must not mask JOB_ALREADY_RUNNING as a 503.
      const active = options.jobs.list({ limit: 100 }).items.find((job) => (
        job.state === "queued" || job.state === "running"
      ));
      if (active) return;
      if (kind === "wiki_refresh" || kind === "wiki_rebuild") {
        if (!wiki) {
          throw new HubHttpError(
            503,
            "CAPABILITY_UNAVAILABLE",
            "Capability unavailable",
            "Wiki maintenance is not connected in this build.",
          );
        }
        const status = await wiki.inspectIndex();
        if (!allowedWikiOperations(status).includes(kind)) {
          throw new HubHttpError(
            503,
            "CAPABILITY_UNAVAILABLE",
            "Capability unavailable",
            "The requested Wiki operation is not safe for the current index state.",
          );
        }
        return;
      }
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

async function unifiedSearch(
  graph: HubGraphReadService | undefined,
  wiki: HubWikiReadService | undefined,
  request: SearchRequest,
  now: () => Date,
): Promise<SearchResponse> {
  const wikiGroupPromise: Promise<SearchResponse["groups"]["wiki"]> = wiki === undefined
    ? Promise.resolve(unavailableSearch("Wiki search requires the repository adapter."))
    : wiki.searchBundle({
        query: request.q,
        limit: request.limit,
        ...(request.wikiCursor === undefined ? {} : { cursor: request.wikiCursor }),
      }).then((bundle): SearchResponse["groups"]["wiki"] => ({
        status: "available",
        items: bundle.results.items.map((hit) => projectWikiSearchHit(hit.entity, hit.matchedFields)),
        nextCursor: bundle.results.nextCursor,
        truncated: bundle.results.truncated,
        revision: bundle.indexedRevision,
      })).catch((error: unknown) => failedSearch(error));

  const graphGroupsPromise: Promise<Pick<SearchResponse["groups"], "symbols" | "sources">> = graph === undefined
    ? Promise.resolve({
        symbols: unavailableSearch("Code-symbol search requires the GraphPort adapter."),
        sources: unavailableSearch("Source-chunk search requires the GraphPort adapter."),
      })
    : graph.searchBundle({
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
      }).then((bundle) => ({
        symbols: bundle.nodes.ok
          ? {
              status: "available" as const,
              items: bundle.nodes.value.items.map(projectSearchSymbol),
              nextCursor: bundle.nodes.value.nextCursor,
              truncated: bundle.nodes.value.truncated,
              revision: bundle.revision,
            }
          : failedSearch(bundle.nodes.problem),
        sources: bundle.sources.ok
          ? {
              status: "available" as const,
              items: bundle.sources.value.items.map((item) => projectSearchSource(item, bundle.revision)),
              nextCursor: bundle.sources.value.nextCursor,
              truncated: bundle.sources.value.truncated,
              revision: bundle.revision,
            }
          : failedSearch(bundle.sources.problem),
      })).catch((error: unknown) => ({
        // A final graph freshness invalidation makes both graph groups
        // untrustworthy, but it must not erase an independently fresh Wiki
        // group assembled by the sibling repository adapter.
        symbols: failedSearch(error),
        sources: failedSearch(error),
      }));
  const [wikiGroup, graphGroups] = await Promise.all([wikiGroupPromise, graphGroupsPromise]);
  return {
    query: request.q,
    observedAt: now().toISOString(),
    groups: {
      wiki: wikiGroup,
      symbols: graphGroups.symbols,
      sources: graphGroups.sources,
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

function projectWikiSummary(entity: WikiEntitySummary): HubWikiEntitySummary {
  if (!isCanonicalRepoPath(entity.location.path)) throw invalidWikiProjection();
  const topics = entity.topics.slice(0, 50);
  const safeSourceTypes = entity.sourceTypes
    .map((value) => safeWikiTaxonomy(value, "unknown"))
    .slice(0, 50);
  const diagnostics = entity.diagnostics.map(projectWikiDiagnostic);
  return {
    id: entity.ref.id,
    kind: safeWikiTaxonomy(entity.ref.kind, "unknown"),
    title: boundedWikiText(entity.title, 512, "Untitled Wiki entry"),
    summary: entity.summary === undefined ? null : boundedWikiText(entity.summary, 2_048, ""),
    lifecycleState: entity.lifecycleState,
    groundingHealth: entity.groundingHealth,
    topics,
    topicsTruncated: entity.topics.length > topics.length,
    sourceTypes: safeSourceTypes,
    sourceTypesTruncated: entity.sourceTypes.length > safeSourceTypes.length,
    location: {
      path: entity.location.path,
      startLine: entity.location.startLine ?? 1,
      endLine: Math.max(entity.location.startLine ?? 1, entity.location.endLine ?? entity.location.startLine ?? 1),
    },
    version: {
      semanticRevision: entity.version.semanticRevision,
      contentHash: entity.version.contentHash,
    },
    diagnostics: diagnostics.slice(0, 10),
    diagnosticsTruncated: diagnostics.length > 10,
    route: wikiEntityRoute(entity.ref.id),
  };
}

function projectWikiSearchHit(
  entity: WikiEntitySummary,
  matchedFields: readonly ("id" | "title" | "summary" | "body")[],
): SearchResponse["groups"]["wiki"]["items"][number] {
  const summary = projectWikiSummary(entity);
  return {
    id: summary.id,
    kind: "wiki",
    entityKind: summary.kind,
    title: summary.title,
    summary: summary.summary,
    lifecycleState: summary.lifecycleState,
    groundingHealth: summary.groundingHealth,
    topics: summary.topics,
    topicsTruncated: summary.topicsTruncated,
    sourceTypes: summary.sourceTypes,
    sourceTypesTruncated: summary.sourceTypesTruncated,
    path: summary.location.path,
    matchedFields: [...new Set(matchedFields)].slice(0, 4),
    route: summary.route,
  };
}

function projectWikiDetail(workspace: RepositoryKnowledgeWorkspace): WikiEntityDetailResponse {
  const entity: WikiEntity<never> = workspace.entity;
  const bodyBytes = Buffer.byteLength(entity.body, "utf8");
  const sources = entity.sources.slice(0, 50).map(projectWikiSource);
  const groundings = entity.groundings.slice(0, 50).map(projectWikiGrounding);
  return {
    indexedRevision: workspace.indexedRevision,
    observedAt: workspace.observedAt,
    entity: projectWikiSummary(entity),
    body: {
      content: truncateUtf8(entity.body, 128 * 1_024),
      totalBytes: bodyBytes,
      truncated: bodyBytes > 128 * 1_024,
    },
    provenance: entity.provenance === undefined
      ? null
      : {
          kind: entity.provenance.kind,
          id: safeEvidenceValue(entity.provenance.id, 256),
          capturedAt: isIsoTimestamp(entity.provenance.capturedAt)
            ? entity.provenance.capturedAt!
            : null,
        },
    sources: {
      items: sources,
      total: entity.sources.length,
      truncated: entity.sources.length > sources.length,
    },
    groundings: {
      items: groundings,
      total: entity.groundings.length,
      truncated: entity.groundings.length > groundings.length,
    },
    // The repository adapter rejects entities whose canonical relation arrays
    // exceed its safety bound, so these are exact for every successful detail.
    relationCount: entity.relations.length,
    backlinkCount: entity.backlinks.length,
  };
}

function projectWikiSource(source: WikiSource): WikiEntityDetailResponse["sources"]["items"][number] {
  const ref = source.type === "agent_session" ? null : safeEvidenceValue(source.ref, 2_048);
  return {
    type: safeWikiTaxonomy(source.type, "unknown"),
    ref,
    note: safeEvidenceValue(source.note, 2_048),
    repository: safeEvidenceValue(source.repository, 512),
    commit: safeEvidenceValue(source.commit, 128),
    capturedAt: isIsoTimestamp(source.capturedAt) ? source.capturedAt! : null,
  };
}

function projectWikiGrounding(value: WikiGroundingResolution): HubWikiGrounding {
  const candidates = value.state === "unresolved"
    ? (value.candidates ?? []).slice(0, 8).map((candidate) => ({
        node: boundedWikiText(candidate.node, 512, "unavailable"),
        fingerprint: candidate.fingerprint === undefined
          ? null
          : boundedWikiText(candidate.fingerprint, 256, ""),
        file: candidate.file !== undefined && isCanonicalRepoPath(candidate.file)
          ? candidate.file
          : null,
        score: typeof candidate.score === "number" && Number.isFinite(candidate.score)
          ? candidate.score
          : null,
      }))
    : [];
  if (value.state === "ungrounded") {
    return {
      state: "ungrounded",
      health: "unverified",
      requestedNode: null,
      resolvedNode: null,
      fingerprint: null,
      file: null,
      commit: null,
      verifiedAt: null,
      reason: safeEvidenceValue(value.reason, 1_024),
      candidates,
      candidatesTruncated: false,
    };
  }
  const grounding = value.grounding;
  return {
    state: value.state,
    health: value.health,
    requestedNode: boundedWikiText(value.requestedNode, 512, "unavailable"),
    resolvedNode: "resolvedNode" in value && value.resolvedNode !== undefined
      ? boundedWikiText(value.resolvedNode, 512, "")
      : null,
    fingerprint: boundedWikiText(grounding.fingerprint, 256, ""),
    file: grounding.file !== undefined && isCanonicalRepoPath(grounding.file)
      ? grounding.file
      : null,
    commit: safeEvidenceValue(grounding.commit, 128),
    verifiedAt: isIsoTimestamp(grounding.verifiedAt) ? grounding.verifiedAt! : null,
    reason: safeEvidenceValue(value.reason ?? grounding.reason, 1_024),
    candidates,
    candidatesTruncated: value.state === "unresolved"
      && (value.candidates?.length ?? 0) > candidates.length,
  };
}

function projectWikiRelationHit(hit: WikiRelationHit): WikiRelationsResponse["items"][number] {
  return {
    direction: hit.direction,
    relation: projectWikiRelation(hit.relation),
    entity: projectWikiSummary(hit.entity),
  };
}

function projectWikiRelation(relation: WikiRelation): HubWikiRelation {
  return {
    type: boundedWikiText(relation.type, 128, "related_to"),
    source: projectWikiRef(relation.source),
    target: projectWikiRef(relation.target),
    note: relation.note === undefined ? null : boundedWikiText(relation.note, 2_048, ""),
  };
}

function projectWikiRef(ref: EntityRef): HubWikiRelation["source"] {
  return {
    id: ref.id,
    kind: safeWikiTaxonomy(ref.kind, "unknown"),
    title: ref.title === undefined ? null : boundedWikiText(ref.title, 512, ""),
  };
}

async function projectWikiHealth(
  wiki: HubWikiReadService,
  jobs: HubJobReader,
): Promise<HealthResponse["components"][number]> {
  try {
    const status = await wiki.inspectIndex();
    const allowedJobKinds = allowedWikiOperations(status);
    const recommendedJobKind = recommendedWikiOperation(status, allowedJobKinds);
    const active = jobs.list({ limit: 100 }).items.find((job) => (
      (job.kind === "wiki_refresh" || job.kind === "wiki_rebuild")
      && (job.state === "queued" || job.state === "running")
    ));
    const wikiDetails: WikiHealthDetails = {
      indexStatus: status.state,
      observedAt: status.observedAt,
      indexedAt: status.indexedAt,
      schemaVersion: status.schemaVersion,
      indexedRevision: status.indexedRevision,
      allowedJobKinds,
      recommendedJobKind,
      activeJobId: active?.id ?? null,
    };
    return {
      id: "wiki",
      label: "Wiki index",
      status: status.state === "fresh" ? "healthy" : "degraded",
      summary: wikiHealthSummary(status),
      diagnostics: status.diagnostics
        .slice(0, HUB_LIMITS.maxDiagnosticCount)
        .map(projectWikiDiagnostic),
      ...(recommendedJobKind === null ? {} : { repairJobKind: recommendedJobKind }),
      wiki: wikiDetails,
    };
  } catch {
    return {
      id: "wiki",
      label: "Wiki index",
      status: "unavailable",
      summary: "Wiki status could not be observed against a stable local snapshot.",
      diagnostics: [],
    };
  }
}

function allowedWikiOperations(
  status: WikiIndexStatus,
): Array<"wiki_refresh" | "wiki_rebuild"> {
  if (status.diagnostics.some((diagnostic) => (
    diagnostic.code === "PATH_OUTSIDE_SCAFFOLD"
    || diagnostic.code === "WRITE_SCOPE_VIOLATION"
  ))) return [];
  switch (status.state) {
    case "stale": return ["wiki_refresh", "wiki_rebuild"];
    case "missing":
    case "corrupt":
    case "rebuild_required": return ["wiki_rebuild"];
    case "fresh": return ["wiki_refresh", "wiki_rebuild"];
    case "degraded":
    case "migration_required": return [];
  }
}

function recommendedWikiOperation(
  status: WikiIndexStatus,
  allowed: readonly ("wiki_refresh" | "wiki_rebuild")[],
): "wiki_refresh" | "wiki_rebuild" | null {
  if (status.state === "stale" && allowed.includes("wiki_refresh")) return "wiki_refresh";
  if (["missing", "corrupt", "rebuild_required"].includes(status.state)
    && allowed.includes("wiki_rebuild")) return "wiki_rebuild";
  return null;
}

function wikiHealthSummary(status: WikiIndexStatus): string {
  switch (status.state) {
    case "fresh": return "The Wiki index matches the current canonical Knowledge corpus.";
    case "missing": return "No Wiki index has been built for this repository.";
    case "stale": return "Canonical Knowledge changed and requires an explicit Wiki refresh.";
    case "degraded": return "Wiki health could not be established safely; retry after the local writer or observation race settles.";
    case "rebuild_required": return "The Wiki index requires an explicit compatible rebuild.";
    case "corrupt": return "The Wiki index failed integrity checks and cannot be read safely.";
    case "migration_required": return "Legacy Knowledge requires an explicit migration before Hub reads can continue.";
  }
}

function projectWikiDiagnostic(diagnostic: Diagnostic): HealthResponse["components"][number]["diagnostics"][number] {
  return {
    code: /^[A-Z0-9_]{1,128}$/.test(diagnostic.code) ? diagnostic.code : "WIKI_DIAGNOSTIC",
    severity: diagnostic.severity,
    message: wikiDiagnosticMessage(diagnostic.code),
    ...(diagnostic.path !== undefined && isCanonicalRepoPath(diagnostic.path)
      ? { path: diagnostic.path }
      : {}),
  };
}

function wikiDiagnosticMessage(code: string): string {
  const messages: Readonly<Record<string, string>> = {
    WIKI_INDEX_MISSING: "The Wiki index is missing.",
    WIKI_INDEX_REBUILD_REQUIRED: "The Wiki index requires explicit maintenance.",
    INDEX_REFRESH_REQUIRED: "Canonical Knowledge changed but its disposable index was not refreshed.",
    WIKI_PARSE_ERROR: "A canonical Knowledge file could not be read safely.",
    PATH_OUTSIDE_SCAFFOLD: "A Wiki path was rejected at the repository boundary.",
  };
  return messages[code] ?? "The Wiki reported a bounded local health diagnostic.";
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

function failedSearch(problem: unknown): SearchResponse["groups"]["symbols"] {
  const rawCode = readProblemCode(problem);
  const code = isSearchFailureCode(rawCode) ? rawCode : "INTERNAL_ERROR";
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

function readProblemCode(problem: unknown): string {
  if (typeof problem !== "object" || problem === null) return "INTERNAL_ERROR";
  if ("code" in problem && typeof problem.code === "string") return problem.code;
  if ("problem" in problem) return readProblemCode(problem.problem);
  return "INTERNAL_ERROR";
}

function isSearchFailureCode(code: string): code is SearchResponse["groups"]["symbols"]["code"] & string {
  return [
    "NOT_FOUND",
    "INVALID_REQUEST",
    "VALIDATION_FAILED",
    "REVISION_CONFLICT",
    "INDEX_MISSING",
    "INDEX_STALE",
    "INDEX_CORRUPT",
    "MIGRATION_REQUIRED",
    "PATH_OUTSIDE_PROJECT",
    "OPERATION_INTERRUPTED",
  ].includes(code);
}

function searchFailureDetail(code: string): string {
  switch (code) {
    case "REVISION_CONFLICT": return "The local index changed since this result page was loaded. Reload the newest results.";
    case "INVALID_REQUEST": return "This search page cursor is invalid for the current request.";
    case "VALIDATION_FAILED": return "This search page cursor is invalid for the current request.";
    case "INDEX_MISSING": return "The required local index has not been built.";
    case "INDEX_STALE": return "The required local index is stale and needs explicit maintenance.";
    case "INDEX_CORRUPT": return "The required local index could not be read safely.";
    case "MIGRATION_REQUIRED": return "The local Knowledge corpus requires an explicit migration.";
    case "PATH_OUTSIDE_PROJECT": return "The local search refused an unsafe project path.";
    case "OPERATION_INTERRUPTED": return "The local index changed while search results were being assembled.";
    default: return "The local search group could not be read safely.";
  }
}

function graphSymbolRoute(symbolId: string): string {
  return `/code/symbols/${encodeURIComponent(symbolId)}`;
}

function wikiEntityRoute(entityId: string): string {
  return `/knowledge/${encodeURIComponent(entityId)}`;
}

function requireWiki(wiki: HubWikiReadService | undefined): HubWikiReadService {
  if (wiki !== undefined) return wiki;
  throw new HubHttpError(
    503,
    "CAPABILITY_UNAVAILABLE",
    "Capability unavailable",
    "Wiki reads are not connected in this build.",
  );
}

function invalidWikiProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid Wiki projection",
    "The Wiki adapter returned an invalid bounded Knowledge result.",
  );
}

function boundedWikiText(value: string, maximumBytes: number, fallback: string): string {
  const safe = safeDisplayText(value);
  const bounded = truncateUtf8(safe, maximumBytes);
  return bounded.length === 0 ? fallback : bounded;
}

function safeWikiTaxonomy(value: string, fallback: string): string {
  const bounded = boundedWikiText(value, 128, fallback);
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(bounded) ? bounded : fallback;
}

function safeEvidenceValue(value: string | undefined, maximumBytes: number): string | null {
  if (value === undefined || value.length === 0) return null;
  const normalized = safeDisplayText(value);
  if (normalized.length === 0 || containsLocalAbsolutePath(normalized)) return null;
  if (/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s/@:]+:[^\s/@]+@/u.test(normalized)) return null;
  try {
    const url = new URL(normalized);
    if ((url.protocol === "http:" || url.protocol === "https:")
      && (url.username !== "" || url.password !== "")) return null;
  } catch {
    // Ordinary non-URL evidence is allowed after local-path screening.
  }
  return truncateUtf8(normalized, maximumBytes);
}

function containsLocalAbsolutePath(value: string): boolean {
  if (/\bfile:(?:\/|\\)+/iu.test(value)) return true;
  if (/(?:^|[^A-Za-z0-9])[A-Za-z]:[\\/]/u.test(value)) return true;
  if (/(?:^|[^\\])\\\\(?:[^\\]|$)/u.test(value)) return true;

  // Ignore ordinary absolute URL paths, then reject a POSIX absolute path at
  // the start or after any delimiter. This catches punctuation-delimited
  // evidence such as `trace(/Users/...)` and `cwd=/var/...` without treating
  // `https://example.test/path` as a local filesystem disclosure.
  const withoutUrls = value.replace(/\b[A-Za-z][A-Za-z0-9+.-]*:\/\/[^\s<>{}\[\]"']+/gu, "");
  return /(?:^|[^A-Za-z0-9_/])\/(?!\/)/u.test(withoutUrls);
}

function isIsoTimestamp(value: string | undefined): value is string {
  return value !== undefined
    && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    && Number.isFinite(Date.parse(value));
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

function projectTeamMember(member: TeamMember): HubTeamMember {
  return {
    schemaVersion: 1,
    id: member.ref.id,
    displayName: member.displayName,
    gitAliases: member.gitAliases.map((alias) => ({ ...alias })),
    active: member.active,
    sourcePath: member.sourcePath,
    revision: member.revision,
  };
}

function projectTeamActivityEvent(event: ActivityEvent): TeamOperationApplyResponse["events"][number] {
  if (
    event.metadata !== undefined
    || (event.workstream !== undefined && event.workstream.kind !== "workstream")
  ) {
    throw invalidTeamProjection();
  }
  return {
    schemaVersion: 1,
    id: event.id,
    timestamp: event.timestamp,
    actor: cloneActor(event.actor),
    action: event.action,
    subjects: event.subjects.map(cloneActivitySubject),
    workstream: event.workstream === undefined
      ? null
      : { ...event.workstream, kind: "workstream" },
    repoState: { ...event.repoState },
  };
}

function cloneActor(actor: ActorRef): ActorRef {
  if (actor.kind === "unknown") return { kind: "unknown" };
  if (actor.kind === "git") return { kind: "git", name: actor.name, email: actor.email };
  return {
    kind: "member",
    memberId: actor.memberId,
    ...(actor.displayName === undefined ? {} : { displayName: actor.displayName }),
  };
}

function cloneActivitySubject(subject: ActivitySubjectRef): ActivitySubjectRef {
  if (subject.kind === "entity") return { kind: "entity", entity: { ...subject.entity } };
  if (subject.kind === "commit") return { kind: "commit", hash: subject.hash };
  if (subject.kind === "file") return { kind: "file", path: subject.path };
  if (subject.code.kind === "file") {
    return { kind: "code", code: { ...subject.code } };
  }
  return { kind: "code", code: { ...subject.code } };
}

function toIdentityActivityCommand(
  request: TeamOperationPreviewRequest,
): TeamIdentityActivityCommand {
  return {
    operationId: request.operationId,
    action: cloneIdentityActivityAction(request.action),
    expectedRevisions: request.expectedRevisions.map((expectation) => (
      expectation.target.kind === "artifact"
        ? {
            target: { kind: "artifact" as const, path: expectation.target.path },
            revision: expectation.revision,
          }
        : {
            target: {
              kind: "local" as const,
              namespace: "member-selection" as const,
              id: "current" as const,
            },
            revision: expectation.revision,
          }
    )),
  } as TeamIdentityActivityCommand;
}

function cloneIdentityActivityAction(
  action: TeamOperationPreviewRequest["action"] | TeamIdentityActivityCommand["action"],
): TeamOperationPreviewRequest["action"] {
  switch (action.kind) {
    case "member.add":
      return {
        kind: "member.add",
        member: {
          displayName: action.member.displayName,
          gitAliases: action.member.gitAliases.map((alias) => ({ ...alias })),
        },
      };
    case "member.update":
      return {
        kind: "member.update",
        memberId: action.memberId,
        patch: {
          ...(action.patch.displayName === undefined
            ? {}
            : { displayName: action.patch.displayName }),
          ...(action.patch.gitAliases === undefined
            ? {}
            : { gitAliases: action.patch.gitAliases.map((alias) => ({ ...alias })) }),
        },
      };
    case "member.deactivate":
      return { kind: "member.deactivate", memberId: action.memberId };
    case "member.select":
      return { kind: "member.select", memberId: action.memberId };
    case "member.clear":
      return { kind: "member.clear" };
    case "activity.record": {
      if (action.activity.workstream !== undefined
        && action.activity.workstream.kind !== "workstream") {
        throw invalidTeamProjection();
      }
      return {
        kind: "activity.record",
        activity: {
          action: action.activity.action,
          subjects: action.activity.subjects.map(cloneActivitySubject),
          ...(action.activity.workstream === undefined
            ? {}
            : { workstream: { ...action.activity.workstream, kind: "workstream" as const } }),
        },
      };
    }
  }
}

function projectTeamOperationEnvelope(
  envelope: TeamIdentityActivityPreviewEnvelope,
): TeamOperationPreviewResponse {
  return {
    schemaVersion: 1,
    request: {
      operationId: envelope.request.operationId,
      action: cloneIdentityActivityAction(envelope.request.action),
      expectedRevisions: envelope.request.expectedRevisions.map((expectation) => (
        expectation.target.kind === "artifact"
          ? {
              target: { kind: "artifact" as const, path: expectation.target.path },
              revision: expectation.revision,
            }
          : {
              target: {
                kind: "local" as const,
                namespace: "member-selection" as const,
                id: "current" as const,
              },
              revision: expectation.revision,
            }
      )),
    },
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map((change) => ({ ...change })),
      localChanges: projectIdentityLocalChanges(envelope.preview.localChanges),
      diagnostics: envelope.preview.diagnostics.map(projectPortableTeamDiagnostic),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds: envelope.receipt.purposeIds.map((purpose) => ({ ...purpose })),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
}

function projectIdentityLocalChanges(
  changes: readonly TeamWorkflowResult<JsonValue>["localChanges"][number][],
): TeamOperationApplyResponse["localChanges"] {
  return changes.map((change) => {
    if (change.namespace !== "member-selection" || change.id !== "current") {
      throw invalidTeamProjection();
    }
    return {
      namespace: "member-selection",
      id: "current",
      beforeRevision: change.beforeRevision,
      afterRevision: change.afterRevision,
      summary: change.summary,
    };
  });
}

function invalidTeamProjection(): HubHttpError {
  return new HubHttpError(
    500,
    "INTERNAL_ERROR",
    "Invalid Team projection",
    "The Team workflow returned an invalid bounded identity result.",
  );
}

function projectPortableTeamDiagnostic(diagnostic: Diagnostic): ActivityDiagnostic {
  const projected = projectDiagnostic(diagnostic);
  if (
    diagnostic.code !== projected.code
    || diagnostic.severity !== projected.severity
    || diagnostic.message !== projected.message
    || diagnostic.path !== projected.path
    || diagnostic.location !== undefined
    || diagnostic.entity !== undefined
    || diagnostic.remediation !== undefined
    || diagnostic.detail !== undefined
  ) {
    throw invalidTeamProjection();
  }
  return projected;
}

function toIdentityActivityEnvelope(
  envelope: TeamOperationApplyRequest,
): TeamIdentityActivityPreviewEnvelope {
  return {
    schemaVersion: 1,
    request: toIdentityActivityCommand(envelope.request),
    preview: {
      valid: envelope.preview.valid,
      scope: envelope.preview.scope,
      changes: envelope.preview.changes.map((change) => ({ ...change })),
      localChanges: envelope.preview.localChanges.map((change) => ({ ...change })),
      diagnostics: envelope.preview.diagnostics.map((diagnostic) => ({ ...diagnostic })),
    },
    receipt: {
      schemaVersion: 1,
      authority: {
        actor: cloneActor(envelope.receipt.authority.actor),
        occurredAt: envelope.receipt.authority.occurredAt,
        repoState: { ...envelope.receipt.authority.repoState },
      },
      purposeIds: envelope.receipt.purposeIds.map((purpose) => ({ ...purpose })),
      requestRevision: envelope.receipt.requestRevision,
      presentationRevision: envelope.receipt.presentationRevision,
      previewRevision: envelope.receipt.previewRevision,
    },
  };
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
      return "The referenced member no longer exists.";
    case "ACTOR_MEMBER_INACTIVE":
      return "The referenced member is currently inactive.";
    case "ACTOR_ALIAS_AMBIGUOUS":
      return "The recorded Git identity matches multiple active members and was not remapped.";
    case "GIT_IDENTITY_UNAVAILABLE":
      return "Git identity could not be inspected safely.";
    case "GIT_IDENTITY_INVALID":
      return "Git identity exceeded the bounded actor contract and was ignored.";
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
