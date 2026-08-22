import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  CapabilitiesResponse,
  HealthResponse,
  HomeResponse,
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
    search: (query) => fixture.search(query),
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

describe("Search states", () => {
  it("renders the empty pre-search state without issuing a search", async () => {
    let calls = 0;
    renderRoute("/search", apiWith({ search: () => {
      calls += 1;
      return pending<SearchResponse>();
    } }));

    expect(await screen.findByRole("heading", { name: "One query, clearly separated sources" })).toBeVisible();
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
    const response = await fixture.search("identity");
    const emptyGroup = { status: "available" as const, items: [], nextCursor: null, truncated: false };
    const unavailableGroup = {
      status: "unavailable" as const,
      items: [],
      nextCursor: null,
      truncated: false,
      detail: "The Wiki reader is not connected.",
    };
    renderRoute("/search?q=identity", apiWith({
      search: () => Promise.resolve({
        ...response,
        groups: { wiki: unavailableGroup, symbols: emptyGroup, sources: emptyGroup },
      }),
    }));

    expect(await screen.findByRole("heading", { name: "Knowledge unavailable" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No code symbols matches" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "No source chunks matches" })).toBeVisible();
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
    expect(screen.getByRole("button", { name: "Graph refresh" })).toBeDisabled();
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
