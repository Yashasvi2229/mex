import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

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
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
  });

  it("marks both flat and read-scoped unavailable capabilities in navigation", async () => {
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

    expect(within(screen.getByRole("link", { name: /Jobs/u })).getByLabelText("Unavailable")).toBeVisible();
    expect(within(screen.getByRole("link", { name: /Relays/u })).getByLabelText("Unavailable")).toBeVisible();
    expect(within(screen.getByRole("link", { name: "Inbox" })).queryByLabelText("Unavailable")).not.toBeInTheDocument();
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
    expect(screen.getByRole("link", { name: "Members" })).toBeVisible();
    expect(screen.getByRole("link", { name: /Open member identity for Ada Lovelace/ })).toHaveAttribute("href", "/members");
    expect(screen.getByRole("link", { name: "Inbox" })).toHaveAttribute("href", "/inbox");
    expect(screen.getByRole("link", { name: "Relays" })).toHaveAttribute("href", "/relays");
    const relaySection = within(screen.getByRole("region", { name: "Project sections" })).getByText("Relays").closest('[role="listitem"]');
    expect(relaySection).toHaveTextContent("Relays1");
    expect(screen.queryByText("Wiki unavailable")).not.toBeInTheDocument();
  });

  it("loads the lazy Relay workbench when the private Relay service is connected", async () => {
    renderRoute("/relays");
    expect(await screen.findByRole("heading", { level: 2, name: "Relay desk" })).toBeVisible();
    expect(document.querySelector('[data-relay-workbench="ready"]')).toBeInTheDocument();
    await waitFor(() => {
      expect(document.querySelector("[data-relay-draft-id]")).toBeInTheDocument();
      expect(document.querySelector("[data-relay-id]")).toBeInTheDocument();
    });
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
