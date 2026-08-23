import {
  ActivityRequestSchema,
  ActivityResponseSchema,
  BootstrapRequestSchema,
  BootstrapResponseSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HUB_LIMITS,
  HubJobSnapshotSchema,
  JobCancelRequestSchema,
  JobPageRequestSchema,
  JobPageResponseSchema,
  JobStartRequestSchema,
  SearchRequestSchema,
  SearchResponseSchema,
  SessionResponseSchema,
  type HealthResponse,
  type ActivityRequest,
  type ActivityResponse,
  type HomeResponse,
  type HubCapabilities,
  type HubJobKind,
  type HubJobSnapshot,
  type JobPageRequest,
  type SearchRequest,
  type SearchResponse,
} from "@mex/hub-contracts";
import { Hono, type Context } from "hono";
import { getCookie, generateCookie } from "hono/cookie";
import { streamSSE } from "hono/streaming";
import {
  createRequestId,
  HubHttpError,
  invalidRequest,
  notFound,
  parseInput,
  problemResponse,
  resourceResponse,
  unavailable,
} from "./http/errors.js";
import { readBoundedJson, readStrictQuery } from "./http/request.js";
import {
  type HubSession,
  HubSessionManager,
} from "./security/session.js";
import {
  HubAssetManifest,
  validateHubRequestPath,
} from "./static/assets.js";

const TERMINAL_JOB_STATES = new Set(["succeeded", "failed", "interrupted"]);
const SSE_HEARTBEAT_MS = 15_000;
const MAX_PENDING_SSE_EVENTS = 64;
const MAX_SSE_SUBSCRIBERS_PER_JOB = 8;
const MAX_SSE_SUBSCRIBERS_PER_PROCESS = 32;

type HubJobEventType = "snapshot" | "progress" | "terminal";

export interface HubJobEvent {
  readonly type: HubJobEventType;
  readonly job: HubJobSnapshot;
}

/** Structural seam implemented by the internal persistent Hub job manager. */
export interface HubJobService {
  list(request: JobPageRequest): Promise<{
    items: readonly HubJobSnapshot[];
    nextCursor?: string | null;
  }> | {
    items: readonly HubJobSnapshot[];
    nextCursor?: string | null;
  };
  get(id: string): Promise<HubJobSnapshot | null> | HubJobSnapshot | null;
  start(request: { kind: HubJobKind }): Promise<HubJobSnapshot> | HubJobSnapshot;
  cancel(id: string): Promise<HubJobSnapshot> | HubJobSnapshot;
  subscribe(id: string, listener: (event: HubJobEvent) => void): () => void;
}

export interface HubReadServices {
  capabilities(): Promise<HubCapabilities> | HubCapabilities;
  home(): Promise<HomeResponse> | HomeResponse;
  activity(request: ActivityRequest): Promise<ActivityResponse> | ActivityResponse;
  search(request: SearchRequest): Promise<SearchResponse> | SearchResponse;
  health(): Promise<HealthResponse> | HealthResponse;
}

interface HubEnvironment {
  Variables: {
    requestId: string;
    session: HubSession;
  };
}

export interface CreateHubAppOptions {
  readonly security: HubSessionManager;
  readonly services: HubReadServices;
  readonly jobs?: HubJobService;
  readonly assets?: HubAssetManifest;
  readonly requestId?: () => string;
  readonly now?: () => number;
}

export function createHubApp(options: CreateHubAppOptions): Hono<HubEnvironment> {
  const app = new Hono<HubEnvironment>();
  const requestId = options.requestId ?? createRequestId;
  const now = options.now ?? Date.now;
  const subscribers = new SseSubscriberTracker();

  app.onError((error, context) => {
    const response = problemResponse(context, error);
    applySecurityHeaders(
      response,
      context.get("requestId") as string | undefined ?? requestId(),
      context.req.path.startsWith("/api/"),
    );
    return response;
  });

  app.use("*", async (context, next) => {
    context.set("requestId", requestId());
    options.security.assertHost(context.req.raw.headers);
    await next();
    applySecurityHeaders(
      context.res,
      context.get("requestId"),
      context.req.path.startsWith("/api/"),
    );
  });

  app.use("/api/*", async (context, next) => {
    const isBootstrap = context.req.method === "POST"
      && context.req.path === "/api/v1/session/bootstrap";
    if (isBootstrap) {
      options.security.assertOrigin(context.req.raw.headers);
      await next();
      return;
    }

    const session = options.security.authenticate(
      getCookie(context, options.security.sessionCookieName),
    );
    context.set("session", session);

    if (!isReadMethod(context.req.method)) {
      options.security.assertOrigin(context.req.raw.headers);
      options.security.assertCsrf(session, context.req.header("x-mex-csrf"));
    }
    await next();
  });

  app.post("/api/v1/session/bootstrap", async (context) => {
    const body = parseInput(
      BootstrapRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    const session = options.security.exchangeBootstrap(body.token);
    const response = resourceResponse(
      BootstrapResponseSchema,
      { expiresAt: session.expiresAt },
      201,
    );
    const maxAge = options.security.remainingSessionSeconds(session);
    response.headers.append("set-cookie", generateCookie(
      options.security.sessionCookieName,
      session.id,
      {
        httpOnly: true,
        sameSite: "Strict",
        path: "/api/v1",
        maxAge,
      },
    ));
    return response;
  });

  app.get("/api/v1/session", (context) => resourceResponse(
    SessionResponseSchema,
    {
      csrfToken: context.get("session").csrfToken,
      expiresAt: context.get("session").expiresAt,
    },
  ));

  app.get("/api/v1/capabilities", async () => resourceResponse(
    HubCapabilitiesSchema,
    await options.services.capabilities(),
  ));

  app.get("/api/v1/home", async () => resourceResponse(
    HomeResponseSchema,
    await options.services.home(),
  ));

  app.get("/api/v1/activity", async (context) => {
    const request = parseInput(
      ActivityRequestSchema,
      readStrictQuery(context.req.raw, ["source", "since", "cursor", "limit"]),
    );
    return resourceResponse(ActivityResponseSchema, await options.services.activity(request));
  });

  app.get("/api/v1/search", async (context) => {
    const request = parseInput(
      SearchRequestSchema,
      readStrictQuery(context.req.raw, [
        "q",
        "limit",
        "wikiCursor",
        "symbolCursor",
        "sourceCursor",
      ]),
    );
    return resourceResponse(SearchResponseSchema, await options.services.search(request));
  });

  app.get("/api/v1/health", async () => resourceResponse(
    HealthResponseSchema,
    await options.services.health(),
  ));

  app.get("/api/v1/jobs", async (context) => {
    const jobs = requireJobs(options.jobs);
    const request = parseInput(
      JobPageRequestSchema,
      readStrictQuery(context.req.raw, ["cursor", "limit"]),
    );
    const page = await jobs.list(request);
    return resourceResponse(JobPageResponseSchema, {
      items: page.items,
      nextCursor: page.nextCursor ?? null,
    });
  });

  app.post("/api/v1/jobs", async (context) => {
    const jobs = requireJobs(options.jobs);
    const request = parseInput(
      JobStartRequestSchema,
      await readBoundedJson(context.req.raw),
    );
    return resourceResponse(HubJobSnapshotSchema, await jobs.start(request), 202);
  });

  app.get("/api/v1/jobs/:id", async (context) => {
    const jobs = requireJobs(options.jobs);
    const id = parseJobId(context.req.param("id"));
    const job = await jobs.get(id);
    if (job === null) throw notFound("The requested Hub job does not exist.");
    return resourceResponse(HubJobSnapshotSchema, job);
  });

  app.post("/api/v1/jobs/:id/cancel", async (context) => {
    const jobs = requireJobs(options.jobs);
    const id = parseJobId(context.req.param("id"));
    parseInput(JobCancelRequestSchema, await readBoundedJson(context.req.raw));
    return resourceResponse(HubJobSnapshotSchema, await jobs.cancel(id));
  });

  app.get("/api/v1/jobs/:id/events", async (context) => {
    // Hono implements HEAD by dispatching the matching GET handler and then
    // discarding its body. Starting a stream in that path would reserve a
    // subscriber whose callback has no reader and therefore never settles.
    if (context.req.method === "HEAD") {
      throw new HubHttpError(
        405,
        "INVALID_REQUEST",
        "Method not allowed",
        "Hub job event streams require GET.",
      );
    }
    const jobs = requireJobs(options.jobs);
    const id = parseJobId(context.req.param("id"));
    const current = await jobs.get(id);
    if (current === null) throw notFound("The requested Hub job does not exist.");
    const release = subscribers.reserve(id);
    try {
      return createJobEventStream(
        context,
        jobs,
        id,
        context.get("session").expiresAt,
        now,
        release,
      );
    } catch (error) {
      release();
      throw error;
    }
  });

  app.all("/api/*", () => {
    throw notFound("The requested Hub API resource does not exist.");
  });

  app.get("*", (context) => serveAsset(context, options.assets));
  app.all("*", () => {
    throw notFound("The requested Hub resource does not exist.");
  });

  return app;
}

function requireJobs(jobs: HubJobService | undefined): HubJobService {
  if (jobs === undefined) {
    throw unavailable("No executable graph or Wiki job capability is registered.");
  }
  return jobs;
}

function parseJobId(value: string): string {
  const parsed = HubJobSnapshotSchema.shape.id.safeParse(value);
  if (!parsed.success) throw invalidRequest("The Hub job ID is invalid.");
  return parsed.data;
}

function createJobEventStream(
  context: Context<HubEnvironment>,
  jobs: HubJobService,
  id: string,
  sessionExpiresAt: string,
  now: () => number,
  releaseSubscriber: () => void,
): Response {
  const sessionDeadline = Date.parse(sessionExpiresAt);
  return streamSSE(context, async (stream) => {
    const queue: HubJobEvent[] = [];
    let notify: (() => void) | null = null;
    const enqueue = (event: HubJobEvent) => {
      if (queue.length >= MAX_PENDING_SSE_EVENTS) queue.shift();
      queue.push(event);
      notify?.();
      notify = null;
    };
    let unsubscribe: () => void = () => undefined;
    try {
      if (now() >= sessionDeadline) return;
      unsubscribe = jobs.subscribe(id, enqueue);
      while (!context.req.raw.signal.aborted && now() < sessionDeadline) {
        const event = queue.shift();
        if (event !== undefined) {
          if (now() >= sessionDeadline) break;
          const parsedJob = HubJobSnapshotSchema.safeParse(event.job);
          if (!parsedJob.success) {
            throw new Error("The Hub job manager emitted an invalid event.");
          }
          const terminal = event.type === "terminal"
            || TERMINAL_JOB_STATES.has(parsedJob.data.state);
          const eventType = terminal ? "terminal" : event.type;
          const eventData = JSON.stringify(parsedJob.data);
          if (Buffer.byteLength(eventData, "utf8") > HUB_LIMITS.maxJsonResponseBytes) {
            throw new Error("The Hub job event exceeded its safe serialized size.");
          }
          await stream.writeSSE({
            event: eventType,
            id: parsedJob.data.revision,
            data: eventData,
          });
          if (terminal) break;
          continue;
        }

        const outcome = await waitForEventOrHeartbeat(
          context.req.raw.signal,
          sessionDeadline,
          now,
          () => new Promise<void>((resolve) => {
            notify = resolve;
            if (queue.length > 0) {
              notify();
              notify = null;
            }
          }),
        );
        if (outcome === "expired" || outcome === "aborted") break;
        if (outcome === "heartbeat") await stream.write(": heartbeat\n\n");
      }
    } finally {
      notify = null;
      unsubscribe();
      releaseSubscriber();
    }
  });
}

class SseSubscriberTracker {
  #total = 0;
  readonly #byJob = new Map<string, number>();

  reserve(jobId: string): () => void {
    const forJob = this.#byJob.get(jobId) ?? 0;
    if (
      forJob >= MAX_SSE_SUBSCRIBERS_PER_JOB
      || this.#total >= MAX_SSE_SUBSCRIBERS_PER_PROCESS
    ) {
      throw new HubHttpError(
        429,
        "RATE_LIMITED",
        "Too many event streams",
        "The local Hub event-stream subscriber limit has been reached.",
      );
    }
    this.#byJob.set(jobId, forJob + 1);
    this.#total += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const current = this.#byJob.get(jobId) ?? 1;
      if (current <= 1) this.#byJob.delete(jobId);
      else this.#byJob.set(jobId, current - 1);
      this.#total = Math.max(0, this.#total - 1);
    };
  }
}

async function waitForEventOrHeartbeat(
  signal: AbortSignal,
  sessionDeadline: number,
  now: () => number,
  event: () => Promise<void>,
): Promise<"event" | "heartbeat" | "aborted" | "expired"> {
  const remainingSessionMs = sessionDeadline - now();
  if (remainingSessionMs <= 0) return "expired";
  const timeoutMs = Math.min(SSE_HEARTBEAT_MS, remainingSessionMs);
  const timeoutOutcome = remainingSessionMs <= SSE_HEARTBEAT_MS
    ? "expired" as const
    : "heartbeat" as const;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  const result = await Promise.race([
    event().then(() => "event" as const),
    new Promise<"heartbeat" | "expired">((resolve) => {
      timer = setTimeout(() => resolve(timeoutOutcome), timeoutMs);
      timer.unref?.();
    }),
    new Promise<"aborted">((resolve) => {
      abort = () => resolve("aborted");
      signal.addEventListener("abort", abort, { once: true });
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (abort !== undefined) signal.removeEventListener("abort", abort);
  return result;
}

function serveAsset(context: Context, assets: HubAssetManifest | undefined): Response {
  if (assets === undefined) {
    throw unavailable("The built Project Hub frontend assets are unavailable.");
  }
  const path = validateHubRequestPath(context.req.raw.url);
  const requestedAsset = path === "/" ? "/index.html" : path;
  const fallbackToShell = !assets.has(requestedAsset)
    && context.req.header("accept")?.includes("text/html") === true
    && !requestedAsset.slice(requestedAsset.lastIndexOf("/") + 1).includes(".");
  const asset = assets.read(fallbackToShell ? "/index.html" : requestedAsset);
  return new Response(asset.bytes as BodyInit, {
    headers: {
      "content-type": asset.contentType,
      "cache-control": asset.cacheControl,
    },
  });
}

function applySecurityHeaders(response: Response, requestId: string, apiResponse: boolean): void {
  response.headers.set(
    "content-security-policy",
    "default-src 'self'; base-uri 'none'; connect-src 'self'; font-src 'self'; "
      + "form-action 'self'; frame-ancestors 'none'; img-src 'self' data:; "
      + "object-src 'none'; script-src 'self'; style-src 'self'",
  );
  response.headers.set("cross-origin-resource-policy", "same-origin");
  response.headers.set("cross-origin-opener-policy", "same-origin");
  response.headers.set(
    "permissions-policy",
    "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  );
  response.headers.set("referrer-policy", "no-referrer");
  response.headers.set("x-content-type-options", "nosniff");
  response.headers.set("x-frame-options", "DENY");
  response.headers.set("x-request-id", requestId);
  if (apiResponse || response.headers.get("content-type")?.includes("application/") === true) {
    response.headers.set("cache-control", "no-store");
  }
}

function isReadMethod(method: string): boolean {
  return method === "GET" || method === "HEAD";
}
