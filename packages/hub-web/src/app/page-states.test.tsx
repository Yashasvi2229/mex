import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import { HubApiError, type HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  ActivityResponse,
  CapabilitiesResponse,
  HealthResponse,
  HomeResponse,
  JobSummary,
  JobsResponse,
  SearchResponse,
} from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function apiWith(overrides: Partial<HubApi>): HubApi {
  const fixture = createFixtureApi();
  return {
    bootstrap: (token) => fixture.bootstrap(token),
    getSession: () => fixture.getSession(),
    getCapabilities: () => fixture.getCapabilities(),
    getHome: () => fixture.getHome(),
    getActivity: (request) => fixture.getActivity(request),
    search: (request) => fixture.search(request),
    getCodeSymbol: (id, request) => fixture.getCodeSymbol(id, request),
    listWikiEntities: (request) => fixture.listWikiEntities(request),
    getWikiEntity: (id) => fixture.getWikiEntity(id),
    getWikiRelations: (id, request) => fixture.getWikiRelations(id, request),
    getWikiBacklinks: (id, request) => fixture.getWikiBacklinks(id, request),
    getCodeKnowledge: (id, request) => fixture.getCodeKnowledge(id, request),
    getHealth: () => fixture.getHealth(),
    getJobs: (cursor) => fixture.getJobs(cursor),
    getJob: (id) => fixture.getJob(id),
    startJob: (request) => fixture.startJob(request),
    cancelJob: (id) => fixture.cancelJob(id),
    subscribeToJob: (id, onSnapshot) => fixture.subscribeToJob(id, onSnapshot),
    ...overrides,
  };
}

function renderRoute(route: string, api: HubApi) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={[route]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

function pending<T>(): Promise<T> {
  return new Promise<T>(() => undefined);
}

const unavailable = (reason: string) => ({ availability: "unavailable" as const, reason });

describe("Home states", () => {
  it("renders its loading state while local project state is pending", async () => {
    renderRoute("/", apiWith({ getHome: () => pending<HomeResponse>() }));

    expect(await screen.findByRole("heading", { name: "Reading local project state" })).toBeVisible();
  });

  it("renders empty attention and job-history states honestly", async () => {
    const fixture = createFixtureApi();
    const home = await fixture.getHome();
    renderRoute("/", apiWith({
      getHome: () => Promise.resolve({ ...home, activeJobs: 0, attention: [] }),
      getJobs: () => Promise.resolve({ items: [], nextCursor: null }),
    }));

    expect(await screen.findByRole("heading", { name: "Nothing needs attention" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No jobs recorded" })).toBeVisible();
  });

  it("renders a bounded error with a retry action", async () => {
    renderRoute("/", apiWith({ getHome: () => Promise.reject(new Error("private path must not render")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
    expect(alert).not.toHaveTextContent("private path must not render");
  });

  it("keeps unavailable graph, Wiki, and project sections explicit", async () => {
    const fixture = createFixtureApi();
    const [capabilities, home] = await Promise.all([fixture.getCapabilities(), fixture.getHome()]);
    const unavailableSection = { availability: "unavailable" as const, count: null, reason: "The source is not connected." };
    renderRoute("/", apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        graph: { ...capabilities.graph, read: unavailable("The graph reader is not connected.") },
        wiki: { ...capabilities.wiki, read: unavailable("The Wiki reader is not connected.") },
      }),
      getHome: () => Promise.resolve({
        ...home,
        sections: {
          workstreams: unavailableSection,
          relays: unavailableSection,
          inbox: unavailableSection,
          activity: unavailableSection,
        },
      }),
    }));

    expect(await screen.findByText("Knowledge and code indexes are unavailable.")).toBeVisible();
    expect(screen.getAllByText("Unavailable")).toHaveLength(4);
  });
});

describe("Activity states", () => {
  const emptyActivity = (overrides: Partial<ActivityResponse> = {}): ActivityResponse => ({
    items: [],
    nextCursor: null,
    hasMore: false,
    sourceTruncated: false,
    deterministicRevision: "f".repeat(64),
    diagnostics: [],
    diagnosticsTruncated: false,
    ...overrides,
  });

  it("does not call the timeline endpoint when Activity is unavailable", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    const getActivity = vi.fn(() => pending<ActivityResponse>());
    renderRoute("/activity", apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        activity: unavailable("The timeline reader is not connected."),
      }),
      getActivity,
    }));

    expect(await screen.findByRole("heading", { name: "Activity is unavailable" })).toBeVisible();
    expect(screen.getByText("The timeline reader is not connected.")).toBeVisible();
    expect(getActivity).not.toHaveBeenCalled();
  });

  it("renders loading and bounded initial-error states", async () => {
    const first = renderRoute("/activity", apiWith({ getActivity: () => pending<ActivityResponse>() }));
    expect(await screen.findByRole("heading", { name: "Reading immutable history" })).toBeVisible();
    first.unmount();

    renderRoute("/activity", apiWith({ getActivity: () => Promise.reject(new Error("private filesystem detail")) }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(alert).not.toHaveTextContent("private filesystem detail");
  });

  it("distinguishes a new timeline from an empty filtered result", async () => {
    const first = renderRoute("/activity", apiWith({ getActivity: () => Promise.resolve(emptyActivity()) }));
    expect(await screen.findByRole("heading", { name: "No activity recorded" })).toBeVisible();
    first.unmount();

    renderRoute("/activity?source=legacy&since=2026-08-23", apiWith({ getActivity: () => Promise.resolve(emptyActivity()) }));
    expect(await screen.findByRole("heading", { name: "No activity matches these filters" })).toBeVisible();
  });

  it("renders canonical and legacy rows, actor remapping, disclosure, and pagination", async () => {
    const user = userEvent.setup();
    renderRoute("/activity", createFixtureApi());

    expect(await screen.findByRole("heading", { name: "Hub activity view connected" })).toBeVisible();
    expect(screen.getByText("Keep activity immutable and preserve legacy history as a read-only projection.")).toBeVisible();
    expect(screen.getByText("Recorded as Daksh Jaitly")).toBeVisible();

    await user.click(screen.getAllByRole("button", { name: "Show details" })[0]);
    expect(screen.getByText("Effective actor")).toBeVisible();
    expect(screen.getByText("feat/hub-activity-timeline")).toBeVisible();
    expect(screen.getByRole("button", { name: "Hide details" })).toBeVisible();

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("Project Hub foundations remain independent of the Wiki engine.")).toBeVisible();
  });

  it("sends URL-backed source and UTC-midnight date filters to the API", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const getActivity = vi.fn((request) => fixture.getActivity(request));
    renderRoute("/activity?fixture=populated", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Hub activity view connected" });

    await user.click(screen.getByRole("button", { name: "Legacy" }));
    await waitFor(() => expect(getActivity).toHaveBeenLastCalledWith(expect.objectContaining({ source: "legacy" })));
    fireEvent.change(screen.getByLabelText("Since"), { target: { value: "2026-08-23" } });
    await waitFor(() => expect(getActivity).toHaveBeenLastCalledWith(expect.objectContaining({
      source: "legacy",
      since: "2026-08-23T00:00:00.000Z",
    })));
    await waitFor(() => expect(screen.getByText(/events? loaded/).parentElement).toHaveFocus());
  });

  it("keeps valid rows visible beside partial diagnostics and source truncation", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    renderRoute("/activity", apiWith({
      getActivity: () => Promise.resolve({ ...response, sourceTruncated: true, diagnosticsTruncated: true }),
    }));

    expect(await screen.findByRole("heading", { name: "Hub activity view connected" })).toBeVisible();
    expect(screen.getByText("Some history could not be trusted.")).toBeVisible();
    expect(screen.getByText("Valid events remain visible.")).toBeVisible();
    expect(screen.getByText("The source scan reached a safety limit.")).toBeVisible();
  });

  it("keeps diagnostics and safety truncation visible when no row is trusted", async () => {
    renderRoute("/activity", apiWith({
      getActivity: () => Promise.resolve(emptyActivity({
        sourceTruncated: true,
        diagnostics: [{ code: "ACTIVITY_CONFLICT", severity: "error", message: "Conflicting canonical rows were excluded." }],
      })),
    }));

    expect(await screen.findByRole("heading", { name: "No trusted rows available" })).toBeVisible();
    expect(screen.getByText("Some history could not be trusted.")).toBeVisible();
    expect(screen.getByText("No trusted events are available in this result.")).toBeVisible();
    expect(screen.queryByText("Valid events remain visible.")).not.toBeInTheDocument();
    expect(screen.getByText("The source scan reached a safety limit.")).toBeVisible();
    expect(screen.getByText("The source scan is incomplete, so this result cannot confirm that no matching activity exists.")).toBeVisible();
  });

  it("reports omitted subject previews in both the collapsed row and expanded details", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    const canonical = response.items.find((item) => item.source === "activity");
    if (canonical?.source !== "activity") throw new Error("Expected a canonical fixture row.");
    renderRoute("/activity", apiWith({
      getActivity: () => Promise.resolve({
        ...response,
        items: [{ ...canonical, subjects: [], subjectCount: 3, subjectsTruncated: true }],
        nextCursor: null,
        hasMore: false,
      }),
    }));

    expect(await screen.findByText("3 linked subjects; previews omitted")).toBeVisible();
    expect(screen.queryByText("No linked subjects")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Show details" }));
    expect(screen.getByText("3 subject references were recorded; previews were omitted by the response safety limits.")).toBeVisible();
  });

  it("marks a legacy message when its bounded preview was shortened", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.getActivity({ limit: 25 });
    const items = response.items.map((item) => item.source === "legacy" ? { ...item, messageTruncated: true } : item);
    renderRoute("/activity", apiWith({ getActivity: () => Promise.resolve({ ...response, items }) }));

    expect(await screen.findByText("Legacy message shortened by the response safety limit.")).toBeVisible();
  });

  it("rejects a mixed-revision page while preserving the loaded rows", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const firstPage = await fixture.getActivity({ limit: 25 });
    const getActivity = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce(emptyActivity({ deterministicRevision: "e".repeat(64) }));
    renderRoute("/activity", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Hub activity view connected" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("Activity changed while you were reading.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Hub activity view connected" })).toBeVisible();
    expect(screen.queryByText("Project Hub foundations remain independent of the Wiki engine.")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Reload newest" })).toBeEnabled();
  });

  it("surfaces a stale-cursor conflict without leaking problem internals", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const firstPage = await fixture.getActivity({ limit: 25 });
    const problem = new HubApiError({
      type: "about:blank",
      title: "Timeline changed",
      status: 409,
      code: "REVISION_CONFLICT",
      detail: "A newer revision exists.",
      requestId: "1e586537-c11b-4f73-9b5c-f4de2a8f7bad",
    });
    const getActivity = vi.fn().mockResolvedValueOnce(firstPage).mockRejectedValueOnce(problem);
    renderRoute("/activity", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Hub activity view connected" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    expect(await screen.findByText("Activity changed while you were reading.")).toBeVisible();
    expect(screen.queryByText("A newer revision exists.")).not.toBeInTheDocument();
  });

  it("preserves loaded rows and retries an ordinary older-page failure", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const firstPage = await fixture.getActivity({ limit: 25 });
    if (firstPage.nextCursor === null) throw new Error("Expected a paginated fixture response.");
    const olderPage = await fixture.getActivity({ limit: 25, cursor: firstPage.nextCursor });
    const getActivity = vi.fn()
      .mockResolvedValueOnce(firstPage)
      .mockRejectedValueOnce(new Error("private pagination failure"))
      .mockResolvedValueOnce(olderPage);
    renderRoute("/activity", apiWith({ getActivity }));
    await screen.findByRole("heading", { name: "Hub activity view connected" });

    await user.click(screen.getByRole("button", { name: "Load older activity" }));
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByText("Older activity could not be loaded.")).toBeVisible();
    expect(screen.getByRole("heading", { name: "Hub activity view connected" })).toBeVisible();
    expect(screen.queryByText("private pagination failure")).not.toBeInTheDocument();

    await user.click(within(alert).getByRole("button", { name: "Try again" }));
    expect(await screen.findByText("Project Hub foundations remain independent of the Wiki engine.")).toBeVisible();
    expect(getActivity).toHaveBeenCalledTimes(3);
  });
});

describe("Search states", () => {
  it("renders the empty pre-search state without issuing a search", async () => {
    let calls = 0;
    renderRoute("/search", apiWith({ search: () => {
      calls += 1;
      return pending<SearchResponse>();
    } }));

    expect(await screen.findByRole("heading", { name: "Search project memory and code" })).toBeVisible();
    expect(calls).toBe(0);
  });

  it("renders a loading state while source queries are pending", async () => {
    renderRoute("/search?q=identity", apiWith({ search: () => pending<SearchResponse>() }));

    expect(await screen.findByRole("heading", { name: "Searching for “identity”" })).toBeVisible();
  });

  it("renders a bounded search error with retry", async () => {
    renderRoute("/search?q=identity", apiWith({ search: () => Promise.reject(new Error("raw backend error")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("distinguishes unavailable groups from successful empty groups", async () => {
    const fixture = createFixtureApi();
    const response = await fixture.search({ q: "identity", limit: 25 });
    const emptyGroup = { status: "available" as const, items: [], nextCursor: null, truncated: false, revision: "a".repeat(64) };
    const unavailableGroup = {
      status: "unavailable" as const,
      items: [],
      nextCursor: null,
      truncated: false,
      revision: null,
      detail: "The Wiki reader is not connected.",
    };
    renderRoute("/search?q=identity", apiWith({
      search: () => Promise.resolve({
        ...response,
        groups: { wiki: unavailableGroup, symbols: emptyGroup, sources: emptyGroup },
      }),
    }));

    expect(await screen.findByRole("heading", { name: "Knowledge unavailable" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No code symbols found" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No source matches found" })).toBeVisible();
  });
});

describe("Health states", () => {
  it("renders its loading state while the read-only inspection is pending", async () => {
    renderRoute("/health", apiWith({ getHealth: () => pending<HealthResponse>() }));

    expect(await screen.findByRole("heading", { name: "Inspecting system health" })).toBeVisible();
  });

  it("renders a bounded health error with retry", async () => {
    renderRoute("/health", apiWith({ getHealth: () => Promise.reject(new Error("database detail")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("renders an unavailable system assessment and disables unsupported repair", async () => {
    const fixture = createFixtureApi();
    const [capabilities, health] = await Promise.all([fixture.getCapabilities(), fixture.getHealth()]);
    renderRoute("/health", apiWith({
      getCapabilities: () => Promise.resolve({
        ...capabilities,
        graph: { ...capabilities.graph, refresh: unavailable("No graph refresh executor is registered.") },
      }),
      getHealth: () => Promise.resolve({
        ...health,
        status: "unavailable",
        components: [{
          id: "graph",
          label: "Code graph",
          status: "unavailable",
          summary: "The graph index cannot be inspected.",
          diagnostics: [],
          repairJobKind: "graph_refresh",
        }],
      }),
    }));

    expect(await screen.findByText("The graph index cannot be inspected.")).toBeVisible();
    expect(screen.getByRole("button", { name: "Refresh graph" })).toBeDisabled();
  });

  it("explains global index-job arbitration on Wiki controls", async () => {
    const fixture = createFixtureApi();
    renderRoute("/health", apiWith({ getHealth: () => fixture.getHealth() }));

    const wikiHeading = await screen.findByRole("heading", { name: "Project Wiki" });
    const wikiRow = wikiHeading.closest<HTMLElement>("[role='listitem']");
    expect(wikiRow).not.toBeNull();
    expect(within(wikiRow!).getByText("New operations wait for the active job.")).toBeVisible();
    expect(within(wikiRow!).getByRole("button", { name: "Wiki refresh" })).toBeDisabled();
    expect(within(wikiRow!).getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
  });

  it("starts Wiki refresh directly but confirms Wiki rebuild", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const health = await fixture.getHealth();
    const withoutActiveJob: HealthResponse = {
      ...health,
      components: health.components.map((component) => component.graph
        ? { ...component, graph: { ...component.graph, activeJobId: null } }
        : component),
    };
    const startJob = vi.fn((request: Parameters<HubApi["startJob"]>[0]) => fixture.startJob(request));
    const view = renderRoute("/health", apiWith({ getHealth: () => Promise.resolve(withoutActiveJob), startJob }));

    await user.click(await screen.findByRole("button", { name: "Wiki refresh" }));
    await waitFor(() => expect(startJob).toHaveBeenCalledWith({ kind: "wiki_refresh" }));

    view.unmount();
    startJob.mockClear();
    renderRoute("/health", apiWith({ getHealth: () => Promise.resolve(withoutActiveJob), startJob }));
    await user.click(await screen.findByRole("button", { name: "Wiki rebuild" }));
    expect(startJob).not.toHaveBeenCalled();
    const dialog = screen.getByRole("dialog", { name: "Rebuild the Wiki index?" });
    await user.click(within(dialog).getByRole("button", { name: "Start wiki rebuild" }));
    await waitFor(() => expect(startJob).toHaveBeenCalledWith({ kind: "wiki_rebuild" }));
  });

  it("disables every index action while a Health start request is pending", async () => {
    const user = userEvent.setup();
    const fixture = createFixtureApi();
    const health = await fixture.getHealth();
    const withoutActiveJob: HealthResponse = {
      ...health,
      components: health.components.map((component) => component.graph
        ? { ...component, graph: { ...component.graph, activeJobId: null } }
        : component.wiki
          ? { ...component, wiki: { ...component.wiki, activeJobId: null } }
          : component),
    };
    const startJob = vi.fn(() => pending<JobSummary>());
    renderRoute("/health", apiWith({ getHealth: () => Promise.resolve(withoutActiveJob), startJob }));

    await user.click(await screen.findByRole("button", { name: "Wiki refresh" }));
    expect(screen.getByRole("button", { name: "Starting…" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh graph" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Rebuild graph" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Wiki rebuild" })).toBeDisabled();
    expect(startJob).toHaveBeenCalledTimes(1);
  });
});

describe("Jobs states", () => {
  it("renders its loading state while persisted summaries are pending", async () => {
    renderRoute("/jobs", apiWith({ getJobs: () => pending<JobsResponse>() }));

    expect(await screen.findByRole("heading", { name: "Loading jobs" })).toBeVisible();
  });

  it("renders the empty persisted-history state", async () => {
    renderRoute("/jobs", apiWith({ getJobs: () => Promise.resolve({ items: [], nextCursor: null }) }));

    expect(await screen.findByRole("heading", { name: "No jobs recorded" })).toBeVisible();
  });

  it("renders a bounded jobs error with retry", async () => {
    renderRoute("/jobs", apiWith({ getJobs: () => Promise.reject(new Error("sqlite detail")) }));

    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeEnabled();
  });

  it("disables every operation when job execution is unavailable", async () => {
    const fixture = createFixtureApi();
    const capabilities = await fixture.getCapabilities();
    renderRoute("/jobs", apiWith({
      getCapabilities: () => Promise.resolve({ ...capabilities, jobs: unavailable("No executors are registered.") }),
    }));

    await screen.findByRole("heading", { name: "Operation log" });
    for (const name of ["Refresh graph", "Rebuild graph", "Refresh Wiki", "Rebuild Wiki"]) {
      expect(screen.getByRole("button", { name: new RegExp(`^${name}`) })).toBeDisabled();
    }
  });
});
