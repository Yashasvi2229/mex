import {
  ActivityResponseSchema,
  BootstrapResponseSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  HubProblemDetailsSchema,
  JobPageResponseSchema,
  SearchResponseSchema,
  SessionResponseSchema,
} from "@mex/hub-contracts";
import { createFixtureApi } from "virtual:mex-hub-fixture-api";
import type {
  ActivityRequest,
  ActivityResponse,
  BootstrapResponse,
  CapabilitiesResponse,
  HealthResponse,
  HomeResponse,
  JobsResponse,
  JobSummary,
  ProblemDetails,
  SearchResponse,
  SessionResponse,
  StartJobRequest,
} from "./types";

const API_ROOT = "/api/v1";

interface Parser<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false };
}

export class HubApiError extends Error {
  readonly problem: ProblemDetails;

  constructor(problem: ProblemDetails) {
    super(problem.detail);
    this.name = "HubApiError";
    this.problem = problem;
  }
}

export interface JobSubscription {
  close(): void;
}

export interface HubApi {
  bootstrap(token: string): Promise<BootstrapResponse>;
  getSession(): Promise<SessionResponse>;
  getCapabilities(): Promise<CapabilitiesResponse>;
  getHome(): Promise<HomeResponse>;
  getActivity(request: ActivityRequest): Promise<ActivityResponse>;
  search(query: string): Promise<SearchResponse>;
  getHealth(): Promise<HealthResponse>;
  getJobs(cursor?: string): Promise<JobsResponse>;
  getJob(id: string): Promise<JobSummary>;
  startJob(request: StartJobRequest): Promise<JobSummary>;
  cancelJob(id: string): Promise<JobSummary>;
  subscribeToJob(id: string, onSnapshot: (job: JobSummary) => void): JobSubscription;
}

function fallbackProblem(status: number, detail?: string): ProblemDetails {
  return {
    type: "about:blank",
    title: status === 401 ? "Hub session required" : "Hub request failed",
    status: status >= 400 && status <= 599 ? status : 500,
    code: status === 401 ? "UNAUTHORIZED" : "INTERNAL_ERROR",
    detail: detail ?? (status === 401
      ? "Open a fresh Hub link from the local CLI."
      : "The response did not match the local Hub contract."),
    requestId: crypto.randomUUID(),
  };
}

async function parseBody<T>(response: Response, schema: Parser<T>): Promise<T> {
  const contentType = response.headers.get("content-type") ?? "";
  let body: unknown;
  try {
    body = contentType.includes("json") ? await response.json() : undefined;
  } catch {
    body = undefined;
  }

  if (!response.ok) {
    const problem = HubProblemDetailsSchema.safeParse(body);
    throw new HubApiError(problem.success ? problem.data : fallbackProblem(response.status));
  }

  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(500));
  }
  return parsed.data;
}

function assertSafeIdentifier(value: string): string {
  const parsed = HubJobSnapshotSchema.shape.id.safeParse(value);
  if (!parsed.success) {
    throw new HubApiError(fallbackProblem(400, "The job identifier is invalid."));
  }
  return parsed.data;
}

export function readBootstrapToken(hash = window.location.hash): string | null {
  if (!hash || hash === "#") return null;
  const fragment = hash.slice(1);
  const params = new URLSearchParams(fragment);
  const named = params.get("token") ?? params.get("bootstrap");
  if (named) return named;
  return fragment.includes("=") ? null : decodeURIComponent(fragment);
}

export function clearBootstrapFragment(): void {
  const clean = `${window.location.pathname}${window.location.search}`;
  window.history.replaceState(window.history.state, "", clean);
}

export class HttpHubApi implements HubApi {
  #csrfToken: string | null = null;

  async #request<T>(
    path: string,
    schema: Parser<T>,
    init: RequestInit = {},
    mutation = false,
  ): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set("Accept", "application/json, application/problem+json");
    if (mutation) {
      headers.set("Content-Type", "application/json");
      if (this.#csrfToken) headers.set("X-MEX-CSRF", this.#csrfToken);
    }

    const response = await fetch(`${API_ROOT}${path}`, {
      ...init,
      headers,
      credentials: "same-origin",
      redirect: "error",
    });
    return parseBody(response, schema);
  }

  bootstrap(token: string): Promise<BootstrapResponse> {
    return this.#request(
      "/session/bootstrap",
      BootstrapResponseSchema,
      { method: "POST", body: JSON.stringify({ token }) },
      true,
    );
  }

  async getSession(): Promise<SessionResponse> {
    const session = await this.#request("/session", SessionResponseSchema);
    this.#csrfToken = session.csrfToken;
    return session;
  }

  getCapabilities(): Promise<CapabilitiesResponse> {
    return this.#request("/capabilities", HubCapabilitiesSchema);
  }

  getHome(): Promise<HomeResponse> {
    return this.#request("/home", HomeResponseSchema);
  }

  getActivity(request: ActivityRequest): Promise<ActivityResponse> {
    const params = new URLSearchParams({ limit: String(request.limit) });
    if (request.source) params.set("source", request.source);
    if (request.since) params.set("since", request.since);
    if (request.cursor) params.set("cursor", request.cursor.slice(0, 4_096));
    return this.#request(`/activity?${params}`, ActivityResponseSchema);
  }

  search(query: string): Promise<SearchResponse> {
    const params = new URLSearchParams({ q: query.slice(0, 256), limit: "25" });
    return this.#request(`/search?${params}`, SearchResponseSchema);
  }

  getHealth(): Promise<HealthResponse> {
    return this.#request("/health", HealthResponseSchema);
  }

  getJobs(cursor?: string): Promise<JobsResponse> {
    const params = new URLSearchParams({ limit: "25" });
    if (cursor) params.set("cursor", cursor.slice(0, 4096));
    return this.#request(`/jobs?${params}`, JobPageResponseSchema);
  }

  async getJob(id: string): Promise<JobSummary> {
    return await this.#request(
      `/jobs/${encodeURIComponent(assertSafeIdentifier(id))}`,
      HubJobSnapshotSchema,
    );
  }

  startJob(request: StartJobRequest): Promise<JobSummary> {
    return this.#request(
      "/jobs",
      HubJobSnapshotSchema,
      { method: "POST", body: JSON.stringify(request) },
      true,
    );
  }

  async cancelJob(id: string): Promise<JobSummary> {
    return await this.#request(
      `/jobs/${encodeURIComponent(assertSafeIdentifier(id))}/cancel`,
      HubJobSnapshotSchema,
      { method: "POST", body: "{}" },
      true,
    );
  }

  subscribeToJob(id: string, onSnapshot: (job: JobSummary) => void): JobSubscription {
    const source = new EventSource(
      `${API_ROOT}/jobs/${encodeURIComponent(assertSafeIdentifier(id))}/events`,
      { withCredentials: true },
    );
    const receive = (event: MessageEvent<string>) => {
      try {
        const parsed = HubJobSnapshotSchema.safeParse(JSON.parse(event.data));
        if (parsed.success) {
          onSnapshot(parsed.data);
          if (
            event.type === "terminal"
            || parsed.data.state === "succeeded"
            || parsed.data.state === "failed"
            || parsed.data.state === "interrupted"
          ) {
            source.close();
          }
        }
      } catch {
        // A malformed event cannot poison the current persisted snapshot.
      }
    };
    source.addEventListener("snapshot", receive as EventListener);
    source.addEventListener("progress", receive as EventListener);
    source.addEventListener("terminal", receive as EventListener);
    source.onmessage = receive;
    return { close: () => source.close() };
  }
}

export function fixturesEnabled(isDevelopment: boolean, search: string): boolean {
  return isDevelopment && new URLSearchParams(search).get("fixture") === "populated";
}

export async function resolveApi(): Promise<HubApi> {
  if (
    createFixtureApi !== null
    && fixturesEnabled(import.meta.env.DEV, window.location.search)
  ) {
    return createFixtureApi();
  }
  return new HttpHubApi();
}
