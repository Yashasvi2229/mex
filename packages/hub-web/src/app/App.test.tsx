import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate, useOutletContext } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";
import { HubLayout, type HubOutletContext } from "./HubLayout";

function renderRoute(route: string, api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
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

describe("Project Hub routes", () => {
  it.each([
    ["/", "Overview"],
    ["/search", "Search"],
    ["/knowledge", "Knowledge"],
    ["/code", "Code"],
    ["/workstreams", "Workstreams"],
    ["/specs", "Specs"],
    ["/playbooks", "Playbooks"],
    ["/catch-up", "Catch Up"],
    ["/inbox", "Inbox"],
    ["/relays", "Relays"],
    ["/members", "Members"],
    ["/activity", "Activity"],
    ["/jobs", "Jobs"],
    ["/health", "Health"],
    ["/not-a-route", "Page not found"],
  ])("renders %s as an intentional view", async (route, heading) => {
    renderRoute(route);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeVisible();
  });

  it("exposes keyboard navigation and a skip link", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    skip.focus();
    expect(skip).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Search project" })).toHaveFocus();
  });

  it("renders the sidebar information architecture in its exact semantic order", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    const sidebar = screen.getByRole("complementary", { name: "Project Hub navigation" });
    expect(within(sidebar).getByRole("link", { name: "Search project" })).toHaveAttribute("href", "/search");

    const primary = within(sidebar).getByRole("navigation", { name: "Primary" });
    expect(within(primary).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual([
      "Overview",
      "Knowledge",
      "Specs",
      "Code",
      "Workstreams",
      "Inbox",
      "Relays",
      "Activity",
    ]);
    expect(within(primary).getByRole("region", { name: "Project Memory" })).toHaveTextContent(
      "KnowledgeSpecsCode",
    );
    expect(within(within(primary).getByRole("region", { name: "Teamwork" }))
      .getAllByRole("link")
      .map((link) => link.querySelector("span")?.textContent))
      .toEqual(["Workstreams", "Inbox", "Relays", "Activity"]);
    const comingSoon = within(primary).getByRole("region", { name: "Coming Soon" });
    expect(within(comingSoon).queryByRole("link", { name: /Playbooks/u })).not.toBeInTheDocument();
    await user.click(within(comingSoon).getByRole("button", { name: "Coming Soon" }));
    expect(within(comingSoon).getAllByRole("link").map((link) => link.querySelector("span")?.textContent))
      .toEqual(["Playbooks", "Catch Up"]);
    expect(within(comingSoon).getByRole("link", { name: "Playbooks Soon" })).toHaveAttribute("href", "/playbooks");
    expect(within(comingSoon).getByRole("link", { name: "Catch Up Soon" })).toHaveAttribute("href", "/catch-up");

    const utilities = within(sidebar).getByRole("navigation", { name: "Project utilities" });
    expect(within(utilities).getAllByRole("link").map((link) => link.textContent)).toEqual([
      "Team",
    ]);
    await user.click(within(utilities).getByRole("button", { name: /^System/u }));
    expect(within(utilities).getAllByRole("link").map((link) => link.querySelector("span")?.textContent)).toEqual([
      "Team",
      "Health",
      "Jobs",
    ]);
  });

  it("keeps disclosure state independent and resets it after remount", async () => {
    const user = userEvent.setup();
    const first = renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    const projectMemory = screen.getByRole("button", { name: "Project Memory" });
    const teamwork = screen.getByRole("button", { name: "Teamwork" });
    const comingSoon = screen.getByRole("button", { name: "Coming Soon" });
    const system = screen.getByRole("button", { name: /^System/u });
    expect(projectMemory).toHaveAttribute("aria-expanded", "true");
    expect(teamwork).toHaveAttribute("aria-expanded", "true");
    expect(comingSoon).toHaveAttribute("aria-expanded", "false");
    expect(system).toHaveAttribute("aria-expanded", "false");

    await user.click(projectMemory);
    await user.click(comingSoon);
    await user.click(system);
    expect(projectMemory).toHaveAttribute("aria-expanded", "false");
    expect(teamwork).toHaveAttribute("aria-expanded", "true");
    expect(comingSoon).toHaveAttribute("aria-expanded", "true");
    expect(system).toHaveAttribute("aria-expanded", "true");

    first.unmount();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.getByRole("button", { name: "Project Memory" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Teamwork" })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("button", { name: "Coming Soon" })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "false");
  });

  it.each([
    ["/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX", "Project Memory", "Knowledge"],
    ["/specs/mx_01K36WVM6H7JK8M9NPQRSTVVWX", "Project Memory", "Specs"],
    ["/code/symbols/sym.createHubServer", "Project Memory", "Code"],
    ["/playbooks", "Coming Soon", "Playbooks"],
    ["/catch-up", "Coming Soon", "Catch Up"],
    ["/jobs", "System", "Jobs"],
  ])("opens the active group and marks its nested route for %s", async (route, group, link) => {
    renderRoute(route);
    const disclosure = await screen.findByRole("button", { name: group });
    expect(disclosure).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: new RegExp(`^${link}(?: Soon| Unavailable)?$`, "u") }))
      .toHaveAttribute("aria-current", "page");
  });

  it("keeps a manually collapsed active group visibly active", async () => {
    const user = userEvent.setup();
    renderRoute("/knowledge/mx_01K36WVM6H7JK8M9NPQRSTVVWX");
    const disclosure = await screen.findByRole("button", { name: "Project Memory" });
    await user.click(disclosure);
    expect(disclosure).toHaveAttribute("aria-expanded", "false");
    expect(disclosure).toHaveAttribute("data-active", "true");
    expect(screen.queryByRole("link", { name: "Knowledge" })).not.toBeInTheDocument();
  });

  it("reopens a group when navigation enters one of its routes", async () => {
    const user = userEvent.setup();
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function RouteDriver() {
      const navigate = useNavigate();
      return <button onClick={() => navigate("/jobs")} type="button">Open jobs route</button>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={createFixtureApi()}>
          <MemoryRouter initialEntries={["/"]}>
            <RouteDriver />
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "false");
    await user.click(screen.getByRole("button", { name: "Open jobs route" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Jobs" })).toBeVisible();
    expect(screen.getByRole("button", { name: /^System/u })).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("link", { name: "Jobs" })).toHaveAttribute("aria-current", "page");
    expect(document.querySelector("#main-content")).toHaveFocus();
  });

  it("uses slash to open Search and focus its existing project input", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });
    expect(screen.getByRole("link", { name: "Search project" })).toHaveAttribute("aria-keyshortcuts", "/");

    fireEvent.keyDown(document, { key: "/", shiftKey: true });
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("");
  });

  it("refocuses Search without clearing its query", async () => {
    renderRoute("/search?q=alpha");
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    expect(input).toHaveValue("alpha");
    screen.getByRole("link", { name: "Search project" }).focus();

    fireEvent.keyDown(document, { key: "/" });
    expect(input).toHaveFocus();
    expect(input).toHaveValue("alpha");
  });

  it("consumes shortcut focus so a later ordinary Search navigation focuses main content", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    fireEvent.keyDown(document, { key: "/" });
    expect(await screen.findByRole("searchbox", { name: "Search project memory and code" })).toHaveFocus();

    await user.click(screen.getByRole("link", { name: "Overview" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Overview" })).toBeVisible();
    expect(document.querySelector("#main-content")).toHaveFocus();

    await user.click(screen.getByRole("link", { name: "Search project" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Search" })).toBeVisible();
    expect(document.querySelector("#main-content")).toHaveFocus();
  });

  it("ignores slash in editable controls, dialogs, and modified shortcuts", async () => {
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    for (const control of [
      document.createElement("input"),
      document.createElement("textarea"),
      document.createElement("select"),
    ]) {
      document.body.append(control);
      control.focus();
      fireEvent.keyDown(control, { key: "/" });
      expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
      control.remove();
    }

    const editable = document.createElement("div");
    editable.setAttribute("contenteditable", "true");
    editable.tabIndex = 0;
    document.body.append(editable);
    editable.focus();
    fireEvent.keyDown(editable, { key: "/" });
    expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
    editable.remove();

    for (const role of ["dialog", "alertdialog"] as const) {
      const dialog = document.createElement("div");
      const trigger = document.createElement("button");
      dialog.setAttribute("role", role);
      dialog.append(trigger);
      document.body.append(dialog);
      trigger.focus();
      fireEvent.keyDown(trigger, { key: "/" });
      expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
      dialog.remove();
    }

    for (const modifier of ["ctrlKey", "metaKey", "altKey"] as const) {
      fireEvent.keyDown(document, { key: "/", [modifier]: true });
      expect(screen.queryByRole("heading", { level: 1, name: "Search" })).not.toBeInTheDocument();
    }
  });

  it("marks both flat and read-scoped unavailable capabilities in navigation", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      jobs: { availability: "unavailable", reason: "Job execution is disconnected." },
      relays: {
        ...capabilities.relays,
        read: { availability: "unavailable", reason: "Relay reads are disconnected." },
      },
    });

    renderRoute("/", api);
    await screen.findByRole("heading", { level: 1, name: "Overview" });

    expect(within(screen.getByRole("link", { name: /Relays/u })).getByText("Unavailable")).toBeVisible();
    expect(within(screen.getByRole("link", { name: /^Inbox/u })).queryByText("Unavailable")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: /^System/u }));
    expect(within(screen.getByRole("link", { name: /Jobs/u })).getByText("Unavailable")).toBeVisible();
  });

  it("fails closed when a Home refetch cannot refresh sidebar truth", async () => {
    const api = createFixtureApi();
    const initialHome = await api.getHome();
    const getHome = vi.spyOn(api, "getHome")
      .mockResolvedValueOnce(initialHome)
      .mockRejectedValueOnce(new Error("Home projection is unavailable."));
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={["/search"]}>
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    expect(await screen.findByText("Ada Lovelace")).toBeVisible();
    const repositoryBar = screen.getByRole("banner", { name: "Repository context" });
    expect(within(repositoryBar).getByText(initialHome.repository.name)).toBeVisible();
    expect(screen.getByLabelText("3 proposals awaiting team review.")).toBeVisible();

    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: ["home"] });
    });

    expect(await screen.findByText("Set team identity")).toBeVisible();
    expect(within(repositoryBar).getByText("Current project")).toBeVisible();
    expect(screen.queryByLabelText("3 proposals awaiting team review.")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("2 open Relays for you.")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("1 active system operations.")).not.toBeInTheDocument();
    expect(getHome).toHaveBeenCalledTimes(2);
  });

  it("shares the trusted shell Home projection with route outlets without another request", async () => {
    const api = createFixtureApi();
    const session = await api.getSession();
    const capabilities = await api.getCapabilities();
    const getHome = vi.spyOn(api, "getHome");
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
    });

    function HomeOutletProbe() {
      const { home } = useOutletContext<HubOutletContext>();
      return <output aria-label="Outlet Home repository">{home?.repository.name ?? "Home unavailable"}</output>;
    }

    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter>
            <Routes>
              <Route element={<HubLayout capabilities={capabilities} session={session} />}>
                <Route index element={<HomeOutletProbe />} />
              </Route>
            </Routes>
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );

    await waitFor(() => expect(screen.getByLabelText("Outlet Home repository")).toHaveTextContent("mex"));
    expect(getHome).toHaveBeenCalledTimes(1);
  });

  it("keeps routes behind a safe, retryable capabilities error", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const getCapabilities = api.getCapabilities.bind(api);
    const capabilities = vi
      .spyOn(api, "getCapabilities")
      .mockRejectedValueOnce(new Error("sensitive filesystem detail: /private/repository"))
      .mockImplementation(getCapabilities);

    renderRoute("/code", api);

    expect(await screen.findByRole("heading", { name: "Project capabilities could not be loaded" })).toBeVisible();
    expect(screen.queryByText(/sensitive filesystem detail/i)).not.toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Code" })).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(await screen.findByRole("heading", { name: "Code" })).toBeVisible();
    expect(capabilities).toHaveBeenCalledTimes(2);
  });

  it("renders real Wiki results beside independent graph groups", async () => {
    const user = userEvent.setup();
    renderRoute("/search");
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    await user.type(input, "hub");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("createHubServer")).toBeVisible();
    expect(screen.getByText("Project Hub read boundaries")).toBeVisible();
    expect(screen.getByText("Source matches", { selector: "h2" })).toBeVisible();
  });

  it("links Home to canonical Workstreams, Inbox, Relay, and Activity surfaces", async () => {
    renderRoute("/");
    const workstreamMetric = await screen.findByRole("link", { name: /Canonical delivery threads/ });
    expect(workstreamMetric).toHaveAttribute("href", "/workstreams");
    const activityMetric = screen.getByRole("link", { name: /Canonical events/ });
    expect(activityMetric).toHaveAttribute("href", "/activity");
    expect(screen.getByRole("link", { name: "All jobs" })).toHaveAttribute("href", "/jobs");
    expect(screen.getByRole("link", { name: "Open Graph refresh" })).toHaveAttribute(
      "href",
      "/jobs?job=job_01K36WVM6H7JK8M9NPQRSTVVWX",
    );
    expect(screen.getByRole("link", { name: "Activity" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Team" })).toHaveAttribute("href", "/members");
    expect(screen.getByRole("link", { name: /Open member identity for Ada Lovelace/ })).toHaveAttribute("href", "/members");
    expect(screen.getByRole("link", { name: /^Inbox/u })).toHaveAttribute("href", "/inbox");
    expect(screen.getByRole("link", { name: /^Relays/u })).toHaveAttribute("href", "/relays");
    const relaySection = within(screen.getByRole("region", { name: "Project sections" })).getByText("Relays").closest('[role="listitem"]');
    expect(relaySection).toHaveTextContent("Relays2");
    expect(screen.queryByText("Wiki unavailable")).not.toBeInTheDocument();
  });

  it("loads the lazy Relay workbench when the private Relay service is connected", async () => {
    const user = userEvent.setup();
    renderRoute("/relays");
    expect(await screen.findByRole("heading", { level: 1, name: "Relays" })).toBeVisible();
    expect(document.querySelector('[data-relay-workbench="ready"]')).toBeInTheDocument();
    await waitFor(() => expect(document.querySelector("[data-relay-id]")).toBeInTheDocument());
    expect(document.querySelector("[data-relay-draft-id]")).not.toBeInTheDocument();

    await user.click(screen.getByRole("tab", { name: "Drafts on this device" }));
    await waitFor(() => expect(document.querySelector("[data-relay-draft-id]")).toBeInTheDocument());
  });

  it("keeps the Search input synchronized with browser history", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
    function BackButton() {
      const navigate = useNavigate();
      return <button onClick={() => navigate(-1)} type="button">Test browser back</button>;
    }
    render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={createFixtureApi()}>
          <MemoryRouter initialEntries={["/search?q=alpha"]}>
            <BackButton />
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    );
    const user = userEvent.setup();
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    expect(input).toHaveValue("alpha");
    await user.clear(input);
    await user.type(input, "beta");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(input).toHaveValue("beta");
    await user.click(screen.getByRole("button", { name: "Test browser back" }));
    expect(input).toHaveValue("alpha");
  });

  it("renders cancellation as requested until the executor settles", async () => {
    const user = userEvent.setup();
    renderRoute("/jobs?job=job_01K36WVM6H7JK8M9NPQRSTVVWX");
    const cancel = await screen.findByRole("button", { name: "Cancel job" });
    await user.click(cancel);
    expect(await screen.findByRole("button", { name: "Cancelling…" })).toBeDisabled();
    expect(screen.getByText("Cancellation requested")).toBeVisible();
  });
});
