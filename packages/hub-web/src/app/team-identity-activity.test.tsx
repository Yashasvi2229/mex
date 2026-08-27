import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

function renderRoute(route: string, api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={[route]}>
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

async function approveExactPreview(user: ReturnType<typeof userEvent.setup>) {
  await user.click(await screen.findByRole("button", { name: "Review apply" }));
  expect(await screen.findByText("Apply this exact preview?")).toBeVisible();
  await user.click(screen.getByRole("button", { name: "Apply approved preview" }));
}

describe("member workflow workbench", () => {
  it("invalidates an edited preview and applies only the second reviewed envelope", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute("/members", api);

    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Add member" }));
    const dialog = await screen.findByRole("dialog", { name: "Add member" });
    const name = within(dialog).getByRole("textbox", { name: "Display name" });
    await user.type(name, "Katherine Johnson");
    await user.type(within(dialog).getByRole("textbox", { name: /Git aliases/ }), "Katherine | kj@example.test");
    await user.click(within(dialog).getByRole("button", { name: "Preview change" }));
    expect(await within(dialog).findByRole("heading", { name: "Operation preview" })).toBeVisible();

    await user.clear(name);
    await user.type(name, "Katherine G. Johnson");
    expect(within(dialog).queryByRole("heading", { name: "Operation preview" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Preview change" }));
    expect(await within(dialog).findByRole("heading", { name: "Operation preview" })).toBeVisible();
    const reviewed = await preview.mock.results[1]!.value;

    await approveExactPreview(user);
    expect(await screen.findByText("Canonical member change applied with one immutable Activity event.")).toBeVisible();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0]).toEqual(reviewed);
    expect(preview).toHaveBeenCalledTimes(2);
    expect((await screen.findAllByText("Katherine G. Johnson")).length).toBeGreaterThanOrEqual(1);
  });

  it("keeps local selection out of Activity cache invalidation", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const apply = vi.spyOn(api, "applyTeamOperation");
    const { queryClient } = renderRoute("/members", api);
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");

    expect(await screen.findByRole("heading", { level: 1, name: "Members" })).toBeVisible();
    await user.click(await screen.findByRole("button", { name: /Grace Hopper/ }));
    await user.click(await screen.findByRole("button", { name: "Select locally" }));
    const dialog = await screen.findByRole("dialog", { name: "Select Grace Hopper" });
    expect(within(dialog).getAllByText(/emits no Activity event/)).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "Preview change" }));
    expect(await within(dialog).findByText("Checkout-local change")).toBeVisible();
    await approveExactPreview(user);

    expect(await screen.findByText("Local member selection updated. No Activity event was created.")).toBeVisible();
    const result = await apply.mock.results[0]!.value;
    expect(result.events).toEqual([]);
    expect(apply.mock.calls[0]![0].request.action.kind).toBe("member.select");
    const invalidated = invalidate.mock.calls.map(([filters]) => filters?.queryKey);
    expect(invalidated).toContainEqual(["actor", "current"]);
    expect(invalidated).toContainEqual(["home"]);
    expect(invalidated).not.toContainEqual(["activity"]);
  });

  it("closes on Escape and restores focus to the operation trigger", async () => {
    const user = userEvent.setup();
    renderRoute("/members");
    const trigger = await screen.findByRole("button", { name: "Add member" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Add member" });
    expect(within(dialog).getByRole("textbox", { name: "Display name" })).toHaveFocus();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Add member" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });
});

describe("Activity append workflow", () => {
  it("loads on demand, invalidates edited previews, and applies one exact append", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewTeamOperation");
    const apply = vi.spyOn(api, "applyTeamOperation");
    renderRoute("/activity", api);

    expect(await screen.findByRole("heading", { level: 1, name: "Activity" })).toBeVisible();
    await user.click(screen.getByRole("button", { name: "Record Activity" }));
    const dialog = await screen.findByRole("dialog", { name: "Record Activity" });
    expect(within(dialog).getByText(/service captures actor, timestamp, branch, HEAD, and dirty state/i)).toBeVisible();
    expect(within(dialog).getByText("Append only", { selector: "strong" })).toBeVisible();
    const action = within(dialog).getByRole("textbox", { name: /Action/ });
    await user.type(action, "review.completed");
    await user.type(within(dialog).getByRole("textbox", { name: /Subject references/ }), "file:src/review.ts");
    await user.click(within(dialog).getByRole("button", { name: "Preview append" }));
    expect(await within(dialog).findByRole("heading", { name: "Operation preview" })).toBeVisible();

    await user.clear(action);
    await user.type(action, "review.approved");
    expect(within(dialog).queryByRole("heading", { name: "Operation preview" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Preview append" }));
    expect(await within(dialog).findByRole("heading", { name: "Operation preview" })).toBeVisible();
    const reviewed = await preview.mock.results[1]!.value;

    await approveExactPreview(user);
    expect(await screen.findByText(/was appended as an immutable canonical record/)).toBeVisible();
    expect(apply).toHaveBeenCalledOnce();
    expect(apply.mock.calls[0]![0]).toEqual(reviewed);
    expect(apply.mock.calls[0]![0].request.action).toMatchObject({
      kind: "activity.record",
      activity: { action: "review.approved", subjects: [{ kind: "file", path: "src/review.ts" }] },
    });
    expect(await screen.findByRole("heading", { name: "Review approved" })).toBeVisible();
  });
});
