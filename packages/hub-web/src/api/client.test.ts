import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHubApi, HubApiError, fixturesEnabled, readBootstrapToken } from "./client";
import type { JobSummary } from "./types";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { "content-type": "application/json" },
});

const session = {
  csrfToken: "a".repeat(43),
  expiresAt: "2026-08-23T20:00:00.000Z",
};

const job: JobSummary = {
  id: "job_01K36WVM6H7JK8M9NPQRSTVVWX",
  scaffoldId: "scf_mex",
  kind: "graph_refresh",
  generation: 1,
  phase: "Queued",
  progress: null,
  state: "queued",
  cancelRequested: false,
  createdAt: "2026-08-23T08:00:00.000Z",
  revision: "a".repeat(64),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("bootstrap fragment handling", () => {
  it.each([
    ["#token=secret-token", "secret-token"],
    ["#bootstrap=secret-token", "secret-token"],
    ["#secret-token", "secret-token"],
    ["", null],
    ["#unknown=value", null],
  ])("reads %s without persisting it", (hash, expected) => {
    expect(readBootstrapToken(hash)).toBe(expected);
  });

  it("cannot enable populated fixtures in a production build", () => {
    expect(fixturesEnabled(false, "?fixture=populated")).toBe(false);
    expect(fixturesEnabled(true, "?fixture=populated")).toBe(true);
    expect(fixturesEnabled(true, "?fixture=empty")).toBe(false);
  });
});

describe("HttpHubApi shared-contract boundary", () => {
  it("retains CSRF only in memory and adds it to JSON mutations", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(job, 202));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getSession();
    await api.startJob({ kind: "graph_refresh" });

    const mutation = fetchMock.mock.calls[1] as [string, RequestInit];
    const headers = mutation[1].headers as Headers;
    expect(headers.get("X-MEX-CSRF")).toBe(session.csrfToken);
    expect(headers.get("Content-Type")).toBe("application/json");
    expect(mutation[1].credentials).toBe("same-origin");
  });

  it("rejects a successful response that diverges from the shared schema", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(json({ authenticated: true })));
    await expect(new HttpHubApi().getSession()).rejects.toMatchObject({
      name: "HubApiError",
      problem: { code: "INTERNAL_ERROR" },
    });
  });

  it("rejects malicious job IDs before issuing a request", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(new HttpHubApi().getJob("../../secrets")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("closes an event stream as soon as a terminal snapshot arrives", () => {
    class FakeEventSource {
      static latest: FakeEventSource;
      readonly listeners = new Map<string, EventListener>();
      readonly close = vi.fn();
      onmessage: EventListener | null = null;

      constructor() {
        FakeEventSource.latest = this;
      }

      addEventListener(type: string, listener: EventListener) {
        this.listeners.set(type, listener);
      }
    }
    vi.stubGlobal("EventSource", FakeEventSource);
    const api = new HttpHubApi();
    const received = vi.fn();
    api.subscribeToJob(job.id, received);
    const terminal = { ...job, state: "succeeded", phase: "complete" };
    FakeEventSource.latest.listeners.get("terminal")?.(
      new MessageEvent("terminal", { data: JSON.stringify(terminal) }),
    );
    expect(received).toHaveBeenCalledWith(terminal);
    expect(FakeEventSource.latest.close).toHaveBeenCalledOnce();
  });
});
