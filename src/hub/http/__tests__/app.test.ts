import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  HealthResponse,
  HomeResponse,
  HubCapabilities,
  HubJobSnapshot,
  SearchRequest,
  SearchResponse,
} from "@mex/hub-contracts";
import { describe, expect, it, vi } from "vitest";
import {
  createHubApp,
  type HubJobEvent,
  type HubJobService,
  type HubReadServices,
} from "../../app.js";
import { HubSessionManager } from "../../security/session.js";
import { HubAssetManifest } from "../../static/assets.js";

const ORIGIN = "http://127.0.0.1:48123";
const HOST = "127.0.0.1:48123";
const BOOTSTRAP = Buffer.alloc(32, 7).toString("base64url");
const JOB_ID = "job_01ARZ3NDEKTSV4RRFFQ69G5FAV";

describe("Project Hub HTTP application", () => {
  it("exchanges the bootstrap once and protects every ordinary API route", async () => {
    const app = fixtureApp();
    const unauthenticated = await app.request(`${ORIGIN}/api/v1/home`, {
      headers: { host: HOST },
    });
    expect(unauthenticated.status).toBe(401);
    expect(unauthenticated.headers.get("content-type")).toContain("application/problem+json");

    const wrongBootstrapMethod = await app.request(
      `${ORIGIN}/api/v1/session/bootstrap`,
      { headers: { host: HOST } },
    );
    expect(wrongBootstrapMethod.status).toBe(401);

    const unknownVersion = await app.request(`${ORIGIN}/api/v2/unknown`, {
      headers: { host: HOST },
    });
    expect(unknownVersion.status).toBe(401);

    const bootstrap = await bootstrapSession(app);
    expect(bootstrap.response.status).toBe(201);
    expect(bootstrap.response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(bootstrap.response.headers.get("set-cookie")).toContain("SameSite=Strict");
    expect(bootstrap.response.headers.get("set-cookie")).toContain("Path=/api/v1");
    expect(await bootstrap.response.text()).not.toContain(BOOTSTRAP);

    const session = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie: bootstrap.cookie },
    });
    expect(session.status).toBe(200);
    expect((await session.json() as { csrfToken: string }).csrfToken).toMatch(/^[\w-]{43}$/);

    const authenticatedUnknownVersion = await app.request(`${ORIGIN}/api/v2/unknown`, {
      headers: { host: HOST, cookie: bootstrap.cookie },
    });
    expect(authenticatedUnknownVersion.status).toBe(404);

    const replay = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, mutation({
      token: BOOTSTRAP,
    }));
    expect(replay.status).toBe(401);
    expect((await replay.json() as { code: string }).code).toBe("UNAUTHORIZED");
  });

  it("keeps loopback sessions isolated across independent Hub processes", async () => {
    const first = fixtureApp({
      randomStart: 20,
      sessionCookieSuffix: Buffer.alloc(16, 1).toString("base64url"),
    });
    const second = fixtureApp({
      randomStart: 40,
      sessionCookieSuffix: Buffer.alloc(16, 2).toString("base64url"),
    });
    const firstSession = await bootstrapSession(first);
    const secondSession = await bootstrapSession(second);

    expect(firstSession.cookie.split("=", 1)[0]).not.toBe(
      secondSession.cookie.split("=", 1)[0],
    );
    const cookies = `${firstSession.cookie}; ${secondSession.cookie}`;
    expect((await first.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie: cookies },
    })).status).toBe(200);
    expect((await second.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie: cookies },
    })).status).toBe(200);
  });

  it("rejects Host spoofing and forwarded proxy requests", async () => {
    const app = fixtureApp();
    const spoofed = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, {
      ...mutation({ token: BOOTSTRAP }),
      headers: {
        ...mutationHeaders(),
        host: "localhost:48123",
      },
    });
    expect(spoofed.status).toBe(400);
    expect(spoofed.headers.get("x-frame-options")).toBe("DENY");

    const forwarded = await app.request(`${ORIGIN}/`, {
      headers: {
        host: HOST,
        "x-forwarded-host": "attacker.invalid",
      },
    });
    expect(forwarded.status).toBe(400);
  });

  it("requires exact Origin, CSRF, and strict JSON for mutations", async () => {
    const app = fixtureApp({ jobs: jobService() });
    const { cookie } = await bootstrapSession(app);
    const sessionResponse = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };

    const noOrigin = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { host: HOST, cookie, "content-type": "application/json", "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(noOrigin.status).toBe(403);

    const wrongCsrf = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": "wrong" },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(wrongCsrf.status).toBe(403);

    const started = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(started.status).toBe(202);

    const nonEmptyCancel = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/cancel`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ force: true }),
    });
    expect(nonEmptyCancel.status).toBe(400);

    const wrongType = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken, "content-type": "text/plain" },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(wrongType.status).toBe(400);
  });

  it("returns bounded plain resources and independently unavailable search groups", async () => {
    const app = fixtureApp();
    const { cookie } = await bootstrapSession(app);
    const search = await app.request(`${ORIGIN}/api/v1/search?q=router`, {
      headers: { host: HOST, cookie },
    });
    expect(search.status).toBe(200);
    const body = await search.json() as SearchResponse;
    expect(body.groups.wiki.status).toBe("unavailable");
    expect(body.groups.symbols.status).toBe("available");
    expect(body).not.toHaveProperty("data");

    const duplicate = await app.request(`${ORIGIN}/api/v1/search?q=a&q=b`, {
      headers: { host: HOST, cookie },
    });
    expect(duplicate.status).toBe(400);
    const unknown = await app.request(`${ORIGIN}/api/v1/search?q=a&unsafe=x`, {
      headers: { host: HOST, cookie },
    });
    expect(unknown.status).toBe(400);
  });

  it("does not expose unregistered production jobs", async () => {
    const app = fixtureApp();
    const { cookie } = await bootstrapSession(app);
    const jobs = await app.request(`${ORIGIN}/api/v1/jobs`, {
      headers: { host: HOST, cookie },
    });
    expect(jobs.status).toBe(503);
    expect((await jobs.json() as { code: string }).code).toBe("CAPABILITY_UNAVAILABLE");
  });

  it("rejects malicious identifiers and oversized streamed bodies", async () => {
    const app = fixtureApp({ jobs: jobService() });
    const { cookie } = await bootstrapSession(app);
    const invalidId = await app.request(`${ORIGIN}/api/v1/jobs/not%2Fa%2Fjob`, {
      headers: { host: HOST, cookie },
    });
    expect([400, 404]).toContain(invalidId.status);
    const overflowUlid = await app.request(
      `${ORIGIN}/api/v1/jobs/job_8${"0".repeat(25)}`,
      { headers: { host: HOST, cookie } },
    );
    expect(overflowUlid.status).toBe(400);
    expect((await overflowUlid.json() as { code: string }).code).toBe("INVALID_REQUEST");

    const sessionResponse = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
    const oversized = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh", padding: "x".repeat(70_000) }),
    });
    expect(oversized.status).toBe(400);
    expect((await oversized.json() as { detail: string }).detail).toContain("64 KiB");
  });

  it("preserves the active job ID in bounded contention problems", async () => {
    const baseJobs = jobService();
    const app = fixtureApp({
      jobs: {
        ...baseJobs,
        start: () => {
          const error = new Error("already active") as Error & { problem: Record<string, unknown> };
          error.problem = {
            status: 409,
            code: "JOB_ALREADY_RUNNING",
            title: "Job already running",
            detail: "An index-mutating job is already active.",
            activeJobId: JOB_ID,
          };
          throw error;
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const sessionResponse = await app.request(`${ORIGIN}/api/v1/session`, {
      headers: { host: HOST, cookie },
    });
    const { csrfToken } = await sessionResponse.json() as { csrfToken: string };
    const response = await app.request(`${ORIGIN}/api/v1/jobs`, {
      method: "POST",
      headers: { ...mutationHeaders(), cookie, "x-mex-csrf": csrfToken },
      body: JSON.stringify({ kind: "graph_refresh" }),
    });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "JOB_ALREADY_RUNNING",
      activeJobId: JOB_ID,
    });
  });

  it("streams one terminal event from the injected job manager", async () => {
    const app = fixtureApp({ jobs: jobService("succeeded") });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
      headers: { host: HOST, cookie },
    });
    expect(response.status).toBe(200);
    const stream = await response.text();
    expect(stream).toContain("event: terminal");
    expect(stream.match(/event: terminal/g)).toHaveLength(1);
  });

  it("ends an open event stream at the absolute session deadline", async () => {
    vi.useFakeTimers();
    try {
      let now = Date.parse("2026-08-23T00:00:00.000Z");
      let subscriptions = 0;
      const baseJobs = jobService("running");
      const jobs: HubJobService = {
        ...baseJobs,
        subscribe: (id, listener) => {
          subscriptions += 1;
          const unsubscribe = baseJobs.subscribe(id, listener);
          return () => {
            unsubscribe();
            subscriptions -= 1;
          };
        },
      };
      const app = fixtureApp({
        jobs,
        now: () => now,
        sessionTtlMs: 1_000,
      });
      const { cookie } = await bootstrapSession(app);
      const response = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
        headers: { host: HOST, cookie },
      });
      const body = response.text();
      expect(response.status).toBe(200);
      expect(subscriptions).toBe(1);

      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);

      expect(await body).toContain("event: snapshot");
      expect(subscriptions).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects HEAD event streams before reserving a subscriber", async () => {
    let subscriptions = 0;
    const baseJobs = jobService("running");
    const app = fixtureApp({
      jobs: {
        ...baseJobs,
        subscribe: (id, listener) => {
          subscriptions += 1;
          return baseJobs.subscribe(id, listener);
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
      method: "HEAD",
      headers: { host: HOST, cookie },
    });

    expect(response.status).toBe(405);
    expect(response.body).toBeNull();
    expect(subscriptions).toBe(0);
  });

  it("caps concurrent event-stream subscribers per job", async () => {
    const app = fixtureApp({ jobs: jobService("running") });
    const { cookie } = await bootstrapSession(app);
    const controllers: AbortController[] = [];
    const responses: Response[] = [];
    try {
      for (let index = 0; index < 8; index += 1) {
        const controller = new AbortController();
        controllers.push(controller);
        responses.push(await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
          headers: { host: HOST, cookie },
          signal: controller.signal,
        }));
      }
      expect(responses.every((response) => response.status === 200)).toBe(true);
      const limited = await app.request(`${ORIGIN}/api/v1/jobs/${JOB_ID}/events`, {
        headers: { host: HOST, cookie },
      });
      expect(limited.status).toBe(429);
      expect((await limited.json() as { code: string }).code).toBe("RATE_LIMITED");
    } finally {
      for (const controller of controllers) controller.abort();
      for (const response of responses) await response.body?.cancel().catch(() => undefined);
    }
  });

  it.each([
    {
      status: 400,
      code: "PATH_OUTSIDE_PROJECT",
      expectedDetail: "The local operation refused a path outside the project boundary.",
    },
    {
      status: 500,
      code: "INTERNAL_ERROR",
      expectedDetail: "The local Hub could not complete the request.",
    },
  ] as const)("projects $code adapter failures without raw details", async ({
    status,
    code,
    expectedDetail,
  }) => {
    const baseServices = readServices();
    const app = fixtureApp({
      services: {
        ...baseServices,
        home: () => {
          const error = new Error("unsafe adapter detail") as Error & {
            problem: Record<string, unknown>;
          };
          error.problem = {
            status,
            code,
            title: "fatal: raw Git failure",
            detail: "fatal: bad config in /Users/alice/private-project/.git/config",
            activeJobId: JOB_ID,
          };
          throw error;
        },
      },
    });
    const { cookie } = await bootstrapSession(app);
    const response = await app.request(`${ORIGIN}/api/v1/home`, {
      headers: { host: HOST, cookie },
    });
    const body = await response.json() as Record<string, unknown>;

    expect(response.status).toBe(status);
    expect(body).toMatchObject({ code, status, detail: expectedDetail });
    expect(body).not.toHaveProperty("activeJobId");
    expect(JSON.stringify(body)).not.toContain("/Users/");
    expect(JSON.stringify(body)).not.toContain("raw Git");
    expect(JSON.stringify(body)).not.toContain("bad config");
  });

  it("serves only fixed assets and uses the shell for HTML navigation", async () => {
    const assets = assetManifest();
    const app = fixtureApp({ assets });
    const shell = await app.request(`${ORIGIN}/search`, {
      headers: { host: HOST, accept: "text/html" },
    });
    expect(shell.status).toBe(200);
    expect(shell.headers.get("cache-control")).toBe("no-store");
    expect(await shell.text()).toContain("Project Hub");

    const missing = await app.request(`${ORIGIN}/assets/not-declared.js`, {
      headers: { host: HOST, accept: "*/*" },
    });
    expect(missing.status).toBe(404);
  });
});

function fixtureApp(overrides: {
  jobs?: HubJobService;
  assets?: HubAssetManifest;
  services?: HubReadServices;
  now?: () => number;
  sessionTtlMs?: number;
  sessionCookieSuffix?: string;
  randomStart?: number;
} = {}) {
  let random = overrides.randomStart ?? 20;
  return createHubApp({
    security: new HubSessionManager({
      bootstrapToken: BOOTSTRAP,
      expectedOrigin: ORIGIN,
      random: (size) => new Uint8Array(size).fill(random++),
      ...(overrides.now === undefined ? {} : { now: overrides.now }),
      ...(overrides.sessionTtlMs === undefined
        ? {}
        : { sessionTtlMs: overrides.sessionTtlMs }),
      ...(overrides.sessionCookieSuffix === undefined
        ? {}
        : { sessionCookieSuffix: overrides.sessionCookieSuffix }),
    }),
    services: overrides.services ?? readServices(),
    jobs: overrides.jobs,
    assets: overrides.assets,
    requestId: () => "00000000-0000-4000-8000-000000000001",
    ...(overrides.now === undefined ? {} : { now: overrides.now }),
  });
}

async function bootstrapSession(app: ReturnType<typeof fixtureApp>) {
  const response = await app.request(`${ORIGIN}/api/v1/session/bootstrap`, mutation({
    token: BOOTSTRAP,
  }));
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("bootstrap did not set a cookie");
  return { response, cookie };
}

function mutation(body: unknown): RequestInit {
  return {
    method: "POST",
    headers: mutationHeaders(),
    body: JSON.stringify(body),
  };
}

function mutationHeaders(): Record<string, string> {
  return { host: HOST, origin: ORIGIN, "content-type": "application/json" };
}

function readServices(): HubReadServices {
  const unavailable = { availability: "unavailable", reason: "The adapter is not connected." } as const;
  const capabilities: HubCapabilities = {
    apiVersion: "v1",
    git: { availability: "available" },
    activity: { availability: "available" },
    jobs: { availability: "available" },
    graph: { read: unavailable, refresh: unavailable, rebuild: unavailable },
    wiki: { read: unavailable, rebuild: unavailable },
  };
  const home: HomeResponse = {
    observedAt: "2026-08-23T00:00:00.000Z",
    repository: {
      scaffoldId: "mex",
      name: "mex",
      branch: "feat/project-hub-foundation",
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
  const health: HealthResponse = {
    status: "degraded",
    observedAt: "2026-08-23T00:00:00.000Z",
    components: [{
      id: "git",
      label: "Git repository",
      status: "healthy",
      summary: "Repository state is available.",
      diagnostics: [],
    }, {
      id: "graph",
      label: "Code graph",
      status: "unavailable",
      summary: "Graph status is not connected in Lane B.",
      diagnostics: [],
    }],
  };
  return {
    capabilities: () => capabilities,
    home: () => home,
    search: (request: SearchRequest) => ({
      query: request.q,
      observedAt: "2026-08-23T00:00:00.000Z",
      groups: {
        wiki: unavailableSearch(),
        symbols: {
          status: "available",
          items: [{ id: "symbol:router", kind: "code_symbol", title: "Router" }],
          nextCursor: null,
          truncated: false,
        },
        sources: unavailableSearch(),
      },
    }),
    health: () => health,
  };
}

function unavailableSearch() {
  return {
    status: "unavailable" as const,
    items: [],
    nextCursor: null,
    truncated: false,
    detail: "The adapter is not connected.",
  };
}

function jobSnapshot(state: HubJobSnapshot["state"] = "running"): HubJobSnapshot {
  return {
    id: JOB_ID,
    scaffoldId: "mex",
    kind: "graph_refresh",
    generation: 1,
    phase: state === "succeeded" ? "complete" : "indexing",
    progress: state === "succeeded" ? { completed: 1, total: 1 } : null,
    state,
    cancelRequested: false,
    createdAt: "2026-08-23T00:00:00.000Z",
    ...(state === "succeeded" ? { finishedAt: "2026-08-23T00:00:01.000Z" } : {}),
    revision: "a".repeat(64),
  };
}

function jobService(state: HubJobSnapshot["state"] = "running"): HubJobService {
  const snapshot = jobSnapshot(state);
  return {
    list: () => ({ items: [snapshot], nextCursor: null }),
    get: () => snapshot,
    start: () => snapshot,
    cancel: () => ({
      ...snapshot,
      state: "interrupted",
      phase: "interrupted",
      cancelRequested: true,
      interruptedReason: "user_cancelled",
      finishedAt: "2026-08-23T00:00:02.000Z",
    }),
    subscribe: (_id: string, listener: (event: HubJobEvent) => void) => {
      listener({
        type: state === "succeeded" ? "terminal" : "snapshot",
        job: snapshot,
      });
      return () => undefined;
    },
  };
}

function assetManifest(): HubAssetManifest {
  const root = mkdtempSync(join(tmpdir(), "mex-hub-app-assets-"));
  mkdirSync(join(root, ".vite"));
  mkdirSync(join(root, "assets"));
  writeFileSync(join(root, "index.html"), "<!doctype html><title>Project Hub</title>");
  writeFileSync(join(root, "assets", "app-a1b2c3.js"), "export {};\n");
  writeFileSync(join(root, "assets", "not-declared.js"), "secret\n");
  writeFileSync(join(root, ".vite", "manifest.json"), JSON.stringify({
    index: { file: "assets/app-a1b2c3.js", isEntry: true },
  }));
  return new HubAssetManifest(root);
}
