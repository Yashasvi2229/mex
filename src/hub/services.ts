import type {
  CapabilityStatus,
  HealthResponse,
  HomeResponse,
  HubActor,
  HubCapabilities,
  HubJobSnapshot,
  SearchRequest,
  SearchResponse,
} from "@mex/hub-contracts";
import { basename } from "node:path";
import type { GitPort } from "../team/contracts/git.js";
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
        activity: unavailable("Activity and Catch Me Up arrive with the read-only Project Hub."),
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
          activity: unavailableSection("Activity aggregation arrives in the read-only Project Hub."),
        },
        activeJobs: active.length,
        attention,
      };
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
