import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router-dom";
import { describe, expect, it } from "vitest";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function renderRoute(route: string) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={createFixtureApi()}>
        <MemoryRouter initialEntries={[route]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

describe("Project Hub routes", () => {
  it.each([
    ["/", "Good context starts here."],
    ["/search", "Search the project"],
    ["/knowledge", "Knowledge"],
    ["/code", "Code"],
    ["/workstreams", "Workstreams"],
    ["/specs", "Specs"],
    ["/playbooks", "Playbooks"],
    ["/inbox", "Inbox"],
    ["/relays", "Relays"],
    ["/activity", "Activity"],
    ["/jobs", "Jobs"],
    ["/health", "Health"],
    ["/not-a-route", "This path is outside the workbench."],
  ])("renders %s as an intentional view", async (route, heading) => {
    renderRoute(route);
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeVisible();
  });

  it("exposes keyboard navigation and a skip link", async () => {
    const user = userEvent.setup();
    renderRoute("/");
    await screen.findByRole("heading", { level: 1, name: "Good context starts here." });
    const skip = screen.getByRole("link", { name: "Skip to main content" });
    skip.focus();
    expect(skip).toHaveFocus();
    await user.tab();
    expect(screen.getByRole("link", { name: "Home" })).toHaveFocus();
  });

  it("keeps partial search failure visible beside successful groups", async () => {
    const user = userEvent.setup();
    renderRoute("/search");
    const input = await screen.findByRole("searchbox", { name: "Search project memory and code" });
    await user.type(input, "bootstrap session");
    await user.click(screen.getByRole("button", { name: "Search" }));
    expect(await screen.findByText("Secure loopback Hub")).toBeVisible();
    expect(screen.getByText("This source failed independently.")).toBeVisible();
    expect(screen.getByText("Source chunks", { selector: "h2" })).toBeVisible();
  });

  it("links Home to canonical Activity while Inbox and Relays stay unavailable", async () => {
    renderRoute("/");
    const activityMetric = await screen.findByRole("link", { name: /Canonical events/ });
    expect(activityMetric).toHaveAttribute("href", "/activity");
    expect(screen.getByRole("link", { name: "Activity" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Inbox Unavailable" })).toBeVisible();
    expect(screen.getByRole("link", { name: "Relays Unavailable" })).toBeVisible();
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
