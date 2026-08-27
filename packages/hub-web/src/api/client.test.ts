import { afterEach, describe, expect, it, vi } from "vitest";
import { HttpHubApi, HubApiError, fixturesEnabled, readBootstrapToken } from "./client";
import type { ActivityResponse, JobSummary } from "./types";
import { createFixtureApi } from "../dev/fixture-api";

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
  phase: "queued",
  progress: null,
  state: "queued",
  cancelRequested: false,
  createdAt: "2026-08-23T08:00:00.000Z",
  revision: "a".repeat(64),
};

const activity: ActivityResponse = {
  items: [],
  nextCursor: null,
  hasMore: false,
  sourceTruncated: false,
  deterministicRevision: "f".repeat(64),
  diagnostics: [],
  diagnosticsTruncated: false,
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
  it("sends independent search cursors through the strict shared contract", async () => {
    const response = await createFixtureApi().search({ q: "graph", limit: 25 });
    const fetchMock = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal("fetch", fetchMock);

    await new HttpHubApi().search({ q: "graph", limit: 25, symbolCursor: "symbol-page-2" });

    const [rawUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl, "http://127.0.0.1");
    expect(url.pathname).toBe("/api/v1/search");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "graph", limit: "25", symbolCursor: "symbol-page-2" });
  });

  it("reads a bounded symbol workspace without allowing path-like IDs", async () => {
    const response = await createFixtureApi().getCodeSymbol("sym.createHubServer", { view: "impact", depth: 3 });
    const fetchMock = vi.fn().mockResolvedValue(json(response));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await expect(api.getCodeSymbol("sym.createHubServer", { view: "impact", depth: 3, sourceCursor: "source-page-2" })).resolves.toEqual(response);
    const [rawUrl] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl, "http://127.0.0.1");
    expect(url.pathname).toBe("/api/v1/code/symbols/sym.createHubServer");
    expect(Object.fromEntries(url.searchParams)).toEqual({ view: "impact", depth: "3", sourceCursor: "source-page-2" });

    await expect(api.getCodeSymbol("../../secrets", { view: "overview" })).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("uses strict Wiki routes, singular filters, and safe entity IDs", async () => {
    const fixture = createFixtureApi();
    const entityId = "mx_01K36WVM6H7JK8M9NPQRSTVVWX";
    const responses = await Promise.all([
      fixture.listWikiEntities({ kind: "architecture", lifecycle: "promoted", grounding: "fresh", sourceType: "file", limit: 25 }),
      fixture.getWikiEntity(entityId),
      fixture.getWikiRelations(entityId, { direction: "both", type: "depends_on", limit: 25 }),
      fixture.getWikiBacklinks(entityId, { type: "related_to", limit: 25 }),
      fixture.getCodeKnowledge("sym.createHubServer", { limit: 25 }),
    ]);
    const fetchMock = vi.fn();
    for (const response of responses) fetchMock.mockResolvedValueOnce(json(response));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.listWikiEntities({ kind: "architecture", lifecycle: "promoted", grounding: "fresh", sourceType: "file", limit: 25 });
    await api.getWikiEntity(entityId);
    await api.getWikiRelations(entityId, { direction: "both", type: "depends_on", limit: 25 });
    await api.getWikiBacklinks(entityId, { type: "related_to", limit: 25 });
    await api.getCodeKnowledge("sym.createHubServer", { limit: 25 });

    const urls = fetchMock.mock.calls.map(([rawUrl]) => new URL(rawUrl as string, "http://127.0.0.1"));
    expect(urls[0].pathname).toBe("/api/v1/wiki/entities");
    expect(Object.fromEntries(urls[0].searchParams)).toEqual({ limit: "25", kind: "architecture", lifecycle: "promoted", grounding: "fresh", sourceType: "file" });
    expect(urls[1].pathname).toBe(`/api/v1/wiki/entities/${entityId}`);
    expect(urls[2].pathname).toBe(`/api/v1/wiki/entities/${entityId}/relations`);
    expect(Object.fromEntries(urls[2].searchParams)).toEqual({ direction: "both", limit: "25", type: "depends_on" });
    expect(urls[3].pathname).toBe(`/api/v1/wiki/entities/${entityId}/backlinks`);
    expect(urls[4].pathname).toBe("/api/v1/code/symbols/sym.createHubServer/knowledge");

    await expect(api.getWikiEntity("../../private/wiki")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("sends bounded Activity filters and parses the shared response contract", async () => {
    const fetchMock = vi.fn().mockResolvedValue(json(activity));
    vi.stubGlobal("fetch", fetchMock);

    await expect(new HttpHubApi().getActivity({
      source: "legacy",
      since: "2026-08-23T00:00:00.000Z",
      cursor: "opaque-cursor",
      limit: 25,
    })).resolves.toEqual(activity);

    const [rawUrl, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const url = new URL(rawUrl, "http://127.0.0.1");
    expect(url.pathname).toBe("/api/v1/activity");
    expect(Object.fromEntries(url.searchParams)).toEqual({
      limit: "25",
      source: "legacy",
      since: "2026-08-23T00:00:00.000Z",
      cursor: "opaque-cursor",
    });
    expect(init.method).toBeUndefined();
  });

  it("uses strict member reads and applies the exact reviewed team envelope", async () => {
    const fixture = createFixtureApi();
    const memberPage = await fixture.getMembers({ active: true, limit: 25 });
    const member = memberPage.items[0]!;
    const actor = await fixture.getCurrentActor();
    const request = {
      operationId: "hub_member_update_client_contract",
      action: {
        kind: "member.update" as const,
        memberId: member.id,
        patch: { displayName: "Ada Byron", gitAliases: member.gitAliases },
      },
      expectedRevisions: [{
        target: { kind: "artifact" as const, path: member.sourcePath },
        revision: member.revision,
      }],
    };
    const preview = await fixture.previewTeamOperation(request);
    const applied = await fixture.applyTeamOperation(preview);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(session))
      .mockResolvedValueOnce(json(memberPage))
      .mockResolvedValueOnce(json(member))
      .mockResolvedValueOnce(json(actor))
      .mockResolvedValueOnce(json(preview))
      .mockResolvedValueOnce(json(applied));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getSession();
    await api.getMembers({ active: true, cursor: "member-page-2", limit: 25 });
    await api.getMember(member.id);
    await api.getCurrentActor();
    await api.previewTeamOperation(request);
    await api.applyTeamOperation(preview);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    expect(new URL(calls[1]![0], "http://127.0.0.1").pathname).toBe("/api/v1/members");
    expect(Object.fromEntries(new URL(calls[1]![0], "http://127.0.0.1").searchParams)).toEqual({
      limit: "25",
      active: "true",
      cursor: "member-page-2",
    });
    expect(new URL(calls[2]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/members/${member.id}`);
    expect(new URL(calls[3]![0], "http://127.0.0.1").pathname).toBe("/api/v1/actor/current");
    expect(new URL(calls[4]![0], "http://127.0.0.1").pathname).toBe("/api/v1/team/operations/preview");
    expect(JSON.parse(calls[4]![1].body as string)).toEqual(request);
    expect(new URL(calls[5]![0], "http://127.0.0.1").pathname).toBe("/api/v1/team/operations/apply");
    expect(JSON.parse(calls[5]![1].body as string)).toEqual(preview);
    expect((calls[4]![1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);
    expect((calls[5]![1].headers as Headers).get("X-MEX-CSRF")).toBe(session.csrfToken);

    await expect(api.getMember("../../private/member")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("uses dedicated bounded Workstream and Spec routes", async () => {
    const fixture = createFixtureApi();
    const workstreams = await fixture.getWorkstreams({ state: "active", limit: 25 });
    const workstream = workstreams.items[0]!;
    const specs = await fixture.listSpecs({
      lifecycleStates: ["in_flight", "promoted"],
      groundingHealth: ["fresh", "unverified"],
      includeArchived: false,
      limit: 25,
    });
    if (specs.availability !== "ready") throw new Error("Fixture Spec list must be ready.");
    const spec = await fixture.getSpec(specs.page.items[0]!.id);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(json(workstreams))
      .mockResolvedValueOnce(json(workstream))
      .mockResolvedValueOnce(json(specs))
      .mockResolvedValueOnce(json(spec));
    vi.stubGlobal("fetch", fetchMock);
    const api = new HttpHubApi();

    await api.getWorkstreams({ state: "active", includeArchived: false, cursor: "workstream-page-2", limit: 25 });
    await api.getWorkstream(workstream.id);
    await api.listSpecs({
      lifecycleStates: ["in_flight", "promoted"],
      groundingHealth: ["fresh", "unverified"],
      includeArchived: false,
      topics: [specs.page.items[0]!.id],
      cursor: "spec-page-2",
      limit: 25,
    });
    await api.getSpec(specs.page.items[0]!.id);

    const calls = fetchMock.mock.calls as [string, RequestInit][];
    const workstreamListUrl = new URL(calls[0]![0], "http://127.0.0.1");
    expect(workstreamListUrl.pathname).toBe("/api/v1/workstreams");
    expect(Object.fromEntries(workstreamListUrl.searchParams)).toEqual({
      limit: "25",
      state: "active",
      includeArchived: "false",
      cursor: "workstream-page-2",
    });
    expect(new URL(calls[1]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/workstreams/${workstream.id}`);
    const specListUrl = new URL(calls[2]![0], "http://127.0.0.1");
    expect(specListUrl.pathname).toBe("/api/v1/specs");
    expect(specListUrl.searchParams.get("lifecycleStates")).toBe("in_flight,promoted");
    expect(specListUrl.searchParams.get("groundingHealth")).toBe("fresh,unverified");
    expect(specListUrl.searchParams.get("topics")).toBe(specs.page.items[0]!.id);
    expect(new URL(calls[3]![0], "http://127.0.0.1").pathname).toBe(`/api/v1/specs/${specs.page.items[0]!.id}`);

    await expect(api.getWorkstream("../../private/workstream")).rejects.toBeInstanceOf(HubApiError);
    await expect(api.getSpec("../../private/spec")).rejects.toBeInstanceOf(HubApiError);
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

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
