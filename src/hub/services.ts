import {
  HUB_LIMITS,
  type ActivityActor,
  type ActivityDiagnostic,
  type ActivityEntityRef,
  type ActivityRequest,
  type ActivityResponse,
  type ActivitySubject,
  type CapabilityStatus,
  type HealthResponse,
  type HomeResponse,
  type HubActor,
  type HubCapabilities,
  type HubJobSnapshot,
  type SearchRequest,
  type SearchResponse,
} from "@mex/hub-contracts";
import { basename } from "node:path";
import type { GitPort } from "../team/contracts/git.js";
import { isRepoRelativePath, type ActorRef, type Diagnostic, type EntityRef } from "../team/contracts/shared.js";
import type { ActivitySubjectRef } from "../team/contracts/workflow.js";
import type { ResolvedTimelineEntry } from "../team/activity/repository.js";
import { TeamIdentityActivityFoundation } from "../team/foundation.js";
import { createRepositoryGitPort } from "../team/git/git-port.js";
import type { HubReadServices } from "./app.js";

interface HubJobReader {
  list(request?: { limit?: number }): {
    items: readonly HubJobSnapshot[];
  };
}

export interface LocalHubReadServicesOptions {
  readonly projectRoot: string;
  readonly scaffoldId: string;
  readonly jobs: HubJobReader;
  readonly git?: GitPort;
  readonly now?: () => Date;
}

/**
 * Honest production read model for the Lane B foundation.
 *
 * Git identity and durable local job summaries are real. Graph, Wiki, and
 * workflow aggregates stay explicitly unavailable until their owning lanes are
 * integrated; populated visual data is never constructed here.
 */
export function createLocalHubReadServices(
  options: LocalHubReadServicesOptions,
): HubReadServices {
  const now = options.now ?? (() => new Date());
  const git = options.git ?? createRepositoryGitPort(options.projectRoot, { now });
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
          read: unavailable("The GraphPort is not connected in this foundation build."),
          refresh: unavailable("Graph refresh requires the Lane A adapter."),
          rebuild: unavailable("Graph rebuild requires the Lane A recovery adapter."),
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
            summary: "Schema v2 job summaries are available locally.",
            diagnostics: [],
          },
          {
            id: "migration",
            label: "Local migration",
            status: "healthy",
            summary: "Local Hub state passed startup migration and validation.",
            diagnostics: [],
          },
          {
            id: "graph",
            label: "Code graph",
            status: "unavailable",
            summary: "Graph health joins after the Lane A adapter is integrated.",
            diagnostics: [],
          },
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
