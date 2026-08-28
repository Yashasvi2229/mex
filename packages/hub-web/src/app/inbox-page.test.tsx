import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type { InboxDraftDetail, InboxOperationPreviewRequest, InboxOperationPreviewResponse } from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

const DRAFT_ID = "inbox_00000000000000000000000000000001";
const PROPOSAL_ID = "proposal_01000000000000000000001720";
const TOPIC_ID = "mx_02000000000000000000000001";
const RELATION_ID = "mx_03000000000000000000000001";

function renderRoute(api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return {
    ...render(
      <QueryClientProvider client={queryClient}>
        <HubApiProvider api={api}>
          <MemoryRouter initialEntries={["/inbox"]}>
            <AppRoutes />
          </MemoryRouter>
        </HubApiProvider>
      </QueryClientProvider>,
    ),
    queryClient,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

describe("Inbox Spec-authoring workbench", () => {
  it("loads at most 25 body-free summaries and fetches detail only after selection", async () => {
    const api = createFixtureApi();
    const drafts = vi.spyOn(api, "getInboxDrafts");
    const proposals = vi.spyOn(api, "getInboxProposals");
    const draftDetail = vi.spyOn(api, "getInboxDraft");
    renderRoute(api);

    expect(await screen.findByRole("heading", { level: 1, name: "Inbox" })).toBeVisible();
    const draftRow = (await screen.findByText("Release benchmark local draft Requirement")).closest("button");
    const proposalRow = (await screen.findByText("Release benchmark pending Spec update")).closest("button");
    expect(draftRow).toHaveAttribute("data-inbox-draft-id", DRAFT_ID);
    expect(proposalRow).toHaveAttribute("data-inbox-proposal-id", PROPOSAL_ID);
    expect(proposalRow).toHaveAttribute("aria-current", "true");
    expect(proposalRow).toHaveAttribute("data-selected", "true");
    expect(drafts).toHaveBeenCalledWith({ limit: 25 });
    expect(proposals).toHaveBeenCalledWith({ states: ["pending", "stale"], limit: 25 });
    expect(draftDetail).not.toHaveBeenCalled();
    expect(screen.queryByText(/The release benchmark must retain exact local evidence/)).not.toBeInTheDocument();

    await userEvent.setup().click(draftRow!);
    expect(await screen.findByText(/The release benchmark must retain exact local evidence/)).toBeVisible();
    expect(draftDetail).toHaveBeenCalledWith(DRAFT_ID);
    expect(draftRow).toHaveAttribute("aria-current", "true");
  });

  it("renders every exact approval diff, including the Wiki ledger and immutable Activity", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api);
    await screen.findByRole("heading", { name: "Release benchmark pending Spec update" });
    await user.click(screen.getByRole("button", { name: "Review & approve" }));
    const dialog = await screen.findByRole("dialog", { name: "Review proposal for approval" });
    const proposalSnapshot = within(dialog).getByRole("region", { name: "Immutable proposal snapshot" });
    expect(within(proposalSnapshot).getByText("Require exact evidence review before release approval.")).toBeVisible();
    expect(within(proposalSnapshot).getByText("Clarify the exact evidence boundary for the release gate.")).toBeVisible();
    expect(within(proposalSnapshot).getByText("scripts/release-benchmark/run.mjs")).toBeVisible();
    expect(within(proposalSnapshot).getAllByText("mx_01000000000000000000000001")).toHaveLength(2);
    await user.click(within(dialog).getByRole("button", { name: "Preview Spec approval" }));
    expect(await within(dialog).findByRole("heading", { name: "Evidence docket" })).toBeVisible();
    expect(within(dialog).getByText(".mex/specs/mx_01000000000000000000000001.md")).toBeVisible();
    expect(within(dialog).getByText(".mex/events/operations.jsonl")).toBeVisible();
    expect(within(dialog).getByText(`.mex/inbox/${PROPOSAL_ID}.md`)).toBeVisible();
    expect(within(dialog).getByText(/^\.mex\/events\/activity\/2026-08\/event_/u)).toBeVisible();
    expect(within(dialog).getByText("feat/project-hub-foundation", { exact: true })).toBeVisible();
    expect(within(dialog).getByText("6484dd00022ac5d704404585d981b4da5f2c1cbf", { exact: true })).toBeVisible();
    expect(within(dialog).getByText("Dirty · local changes", { exact: true })).toBeVisible();
    expect(within(dialog).getAllByText("23 Aug, 08:45 UTC", { exact: true })).toHaveLength(2);
    expect(preview.mock.calls[0]![0].action).toEqual({
      kind: "inbox.approve",
      proposalId: PROPOSAL_ID,
    });
  });

  it("authors a fresh stale repair, hides withdrawal, then approves the repaired proposal", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const pending = await api.getInboxProposal(PROPOSAL_ID);
    const stalePreview = await api.previewInboxOperation({
      operationId: "ui_prepare_stale_proposal",
      action: {
        kind: "inbox.mark-stale",
        proposalId: pending.ref.id,
        rationale: "The exact target attestation changed.",
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: pending.sourcePath },
        revision: pending.revision,
      }],
    });
    await api.applyInboxOperation(stalePreview);
    const preview = vi.spyOn(api, "previewInboxOperation");
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api);

    await screen.findByRole("heading", { name: pending.title });
    expect(screen.queryByRole("button", { name: "Withdraw proposal" })).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Repair proposal" }));
    const repairDialog = await screen.findByRole("dialog", { name: "Repair stale proposal" });
    const exactRevision = within(repairDialog).getByRole("textbox", { name: "Exact file revision" });
    const semanticRevision = within(repairDialog).getByRole("spinbutton", { name: "Semantic revision" });
    const rationale = within(repairDialog).getByRole("textbox", { name: "Rationale" });
    const evidence = within(repairDialog).getByRole("textbox", { name: /Additional manual evidence/ });
    fireEvent.change(exactRevision, { target: { value: "a".repeat(64) } });
    fireEvent.change(semanticRevision, { target: { value: "5" } });
    fireEvent.change(rationale, { target: { value: "Fresh target revision reviewed.\n\tRepair is exact." } });
    fireEvent.change(evidence, { target: { value: "Fresh repair evidence.\n\tObserved locally." } });

    await user.click(within(repairDialog).getByRole("button", { name: "Preview proposal repair" }));
    await within(repairDialog).findByRole("heading", { name: "Evidence docket" });
    fireEvent.change(exactRevision, { target: { value: "b".repeat(64) } });
    expect(within(repairDialog).queryByRole("heading", { name: "Evidence docket" })).not.toBeInTheDocument();
    await user.click(within(repairDialog).getByRole("button", { name: "Preview proposal repair" }));
    await within(repairDialog).findByRole("heading", { name: "Evidence docket" });
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[0]![0].operationId).not.toBe(preview.mock.calls[1]![0].operationId);
    const repairRequest = preview.mock.calls[1]![0];
    if (repairRequest.action.kind !== "inbox.repair") throw new Error("Expected repair request.");
    expect(repairRequest.action.replacement).toMatchObject({
      rationale: "Fresh target revision reviewed.\n\tRepair is exact.",
      evidence: expect.arrayContaining([{
        kind: "manual",
        note: "Fresh repair evidence.\n\tObserved locally.",
      }]),
      targetRevisions: [{
        target: { kind: "entity", id: "mx_01000000000000000000000001" },
        revision: "b".repeat(64),
        semanticRevision: 5,
      }],
    });

    await user.click(within(repairDialog).getByRole("button", { name: "Review repaired proposal" }));
    const repairConfirmation = await screen.findByRole("alertdialog", { name: "Repair this stale proposal?" });
    await user.click(within(repairConfirmation).getByRole("button", { name: "Repair proposal" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Repair stale proposal" })).not.toBeInTheDocument());

    const approveTrigger = await screen.findByRole("button", { name: "Review & approve" });
    await user.click(approveTrigger);
    const approvalDialog = await screen.findByRole("dialog", { name: "Review proposal for approval" });
    await user.click(within(approvalDialog).getByRole("button", { name: "Preview Spec approval" }));
    await within(approvalDialog).findByRole("heading", { name: "Evidence docket" });
    await user.click(within(approvalDialog).getByRole("button", { name: "Review exact preview" }));
    const approvalConfirmation = await screen.findByRole("alertdialog", { name: "Approve this exact Spec change?" });
    await user.click(within(approvalConfirmation).getByRole("button", { name: "Approve proposal and write Spec" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    expect(apply.mock.calls.map(([envelope]) => envelope.request.action.kind))
      .toEqual(["inbox.repair", "inbox.approve"]);
  });

  it("accepts canonical multiline tabs, rejects NFD and lone surrogates, invalidates previews, and focuses live success", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewInboxOperation");
    const apply = vi.spyOn(api, "applyInboxOperation");
    renderRoute(api);

    const trigger = await screen.findByRole("button", { name: "New local draft" });
    await user.click(trigger);
    const dialog = await screen.findByRole("dialog", { name: "Create local Spec draft" });
    await waitFor(() => expect(within(dialog).getByRole("combobox", { name: "Change type" })).toHaveFocus());
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    const body = within(dialog).getByRole("textbox", { name: "Spec body" });
    const rationale = within(dialog).getByRole("textbox", { name: "Rationale" });
    fireEvent.change(title, { target: { value: "Canonical multiline requirement" } });
    fireEvent.change(body, { target: { value: "First line\n\tTabbed second line" } });
    fireEvent.change(rationale, { target: { value: "Review line one\nReview line two" } });
    const previewButton = within(dialog).getByRole("button", { name: "Preview local draft" });
    expect(previewButton).toBeEnabled();

    fireEvent.change(title, { target: { value: "Cafe\u0301" } });
    expect(previewButton).toBeDisabled();
    fireEvent.change(title, { target: { value: "Café" } });
    expect(previewButton).toBeEnabled();
    fireEvent.change(body, { target: { value: "Broken \ud800 body" } });
    expect(previewButton).toBeDisabled();
    fireEvent.change(body, { target: { value: "First line\n\tTabbed second line" } });

    await user.click(previewButton);
    expect(await within(dialog).findByRole("heading", { name: "Evidence docket" })).toBeVisible();
    fireEvent.change(title, { target: { value: "Café requirement" } });
    expect(within(dialog).queryByRole("heading", { name: "Evidence docket" })).not.toBeInTheDocument();
    await user.click(within(dialog).getByRole("button", { name: "Preview local draft" }));
    expect(await within(dialog).findByRole("heading", { name: "Evidence docket" })).toBeVisible();
    expect(preview).toHaveBeenCalledTimes(2);
    expect(preview.mock.calls[0]![0].operationId).not.toBe(preview.mock.calls[1]![0].operationId);
    expect(preview.mock.calls[1]![0]).toMatchObject({
      action: {
        kind: "inbox.draft.save",
        draft: {
          change: { body: "First line\n\tTabbed second line" },
          rationale: "Review line one\nReview line two",
        },
      },
    });

    await user.click(within(dialog).getByRole("button", { name: "Review draft save" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Save this private draft?" });
    await user.click(within(confirmation).getByRole("button", { name: "Save local draft" }));
    const success = await screen.findByText("Checkout-local draft state updated from the exact preview.");
    expect(apply).toHaveBeenCalledOnce();
    await waitFor(() => expect(success).toHaveFocus());
  });

  it("closes the draft dialog on Escape and restores its live trigger", async () => {
    const user = userEvent.setup();
    renderRoute();
    const trigger = await screen.findByRole("button", { name: "New local draft" });
    await user.click(trigger);
    expect(await screen.findByRole("dialog", { name: "Create local Spec draft" })).toBeVisible();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Create local Spec draft" })).not.toBeInTheDocument());
    expect(trigger).toHaveFocus();
  });

  it("never restores an in-flight draft preview after the edited request invalidates it", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    const delayed = deferred<InboxOperationPreviewResponse>();
    let staleRequest: InboxOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewInboxOperation").mockImplementationOnce((request) => {
      staleRequest = request;
      return delayed.promise;
    });
    renderRoute(api);

    await user.click(await screen.findByRole("button", { name: "New local draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Create local Spec draft" });
    const title = within(dialog).getByRole("textbox", { name: "Title" });
    fireEvent.change(title, { target: { value: "Original reviewed title" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Spec body" }), { target: { value: "Original body." } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Rationale" }), { target: { value: "Original rationale." } });
    await user.click(within(dialog).getByRole("button", { name: "Preview local draft" }));
    await waitFor(() => expect(staleRequest).toBeDefined());

    fireEvent.change(title, { target: { value: "Edited visible title" } });
    const staleEnvelope = await realPreview(staleRequest!);
    await act(async () => {
      delayed.resolve(staleEnvelope);
      await delayed.promise;
    });

    expect(within(dialog).queryByRole("heading", { name: "Evidence docket" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Preview local draft" })).toBeEnabled();
  });

  it("never restores an in-flight review preview after rationale changes", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewInboxOperation.bind(api);
    const delayed = deferred<InboxOperationPreviewResponse>();
    let staleRequest: InboxOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewInboxOperation").mockImplementationOnce((request) => {
      staleRequest = request;
      return delayed.promise;
    });
    renderRoute(api);

    await screen.findByRole("heading", { name: "Release benchmark pending Spec update" });
    await user.click(screen.getByRole("button", { name: "Reject proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject proposal" });
    const rationale = within(dialog).getByRole("textbox", { name: "Review rationale" });
    fireEvent.change(rationale, { target: { value: "Original rejection rationale." } });
    await user.click(within(dialog).getByRole("button", { name: "Preview rejection" }));
    await waitFor(() => expect(staleRequest).toBeDefined());

    fireEvent.change(rationale, { target: { value: "Edited rejection rationale." } });
    const staleEnvelope = await realPreview(staleRequest!);
    await act(async () => {
      delayed.resolve(staleEnvelope);
      await delayed.promise;
    });

    expect(within(dialog).queryByRole("heading", { name: "Evidence docket" })).not.toBeInTheDocument();
    expect(within(dialog).getByRole("button", { name: "Preview rejection" })).toBeEnabled();
  });

  it.each([
    ["title-only", { title: "Title-only replacement" }],
    ["clear-summary", { summary: "" }],
  ])("preserves exact %s update patch presence", async (_label, patch) => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const base = await api.getInboxDraft(DRAFT_ID);
    const update: InboxDraftDetail = {
      ...base,
      changeKind: "spec.update",
      entityKind: "spec",
      title: "Release root update",
      input: {
        change: {
          kind: "spec.update",
          target: {
            id: "mx_01000000000000000000000001",
            kind: "spec",
            title: "Release root",
          },
          patch,
        },
        rationale: "Preserve the exact selected patch fields.",
        evidence: [],
        targetRevisions: [{
          target: { kind: "entity", id: "mx_01000000000000000000000001" },
          revision: "3".repeat(64),
          semanticRevision: 4,
        }],
      },
    };
    vi.spyOn(api, "getInboxDraft").mockResolvedValue(update);
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api);
    await user.click((await screen.findByText(base.title)).closest("button")!);
    await screen.findByRole("heading", { name: "Release root update" });
    await user.click(screen.getByRole("button", { name: "Edit local draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    expect(within(dialog).getByRole("button", { name: "Title" })).toHaveAttribute(
      "aria-pressed",
      Object.hasOwn(patch, "title") ? "true" : "false",
    );
    expect(within(dialog).getByRole("button", { name: "Summary" })).toHaveAttribute(
      "aria-pressed",
      Object.hasOwn(patch, "summary") ? "true" : "false",
    );
    expect(within(dialog).getByRole("button", { name: "Body" })).toHaveAttribute("aria-pressed", "false");
    expect(within(dialog).getByRole("textbox", { name: "Replacement body" })).toBeDisabled();
    await user.click(within(dialog).getByRole("button", { name: "Preview local draft" }));
    await within(dialog).findByRole("heading", { name: "Evidence docket" });
    const request = preview.mock.calls[0]![0];
    if (request.action.kind !== "inbox.draft.save" || request.action.draft.change.kind !== "spec.update") {
      throw new Error("Expected a typed Spec update draft.");
    }
    expect(request.action.draft.change.patch).toEqual(patch);
  });

  it("preserves rich topics, relation attestations, and every typed evidence ref while editing", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const base = await api.getInboxDraft(DRAFT_ID);
    const rich: InboxDraftDetail = {
      ...base,
      input: {
        change: {
          kind: "spec.create",
          entityKind: "requirement",
          title: base.title,
          body: "Rich body\n\twith canonical layout.",
          summary: "Rich typed draft.",
          status: "in_flight",
          topics: [TOPIC_ID],
          relation: {
            type: "derived_from",
            target: { id: RELATION_ID, kind: "spec", title: "Release root" },
          },
        },
        rationale: "Keep all rich input intact.",
        evidence: [
          { kind: "entity", entity: { id: RELATION_ID, kind: "spec", title: "Release root" } },
          { kind: "code", code: { kind: "symbol", symbolId: "symbol.release" } },
          { kind: "commit", hash: "a".repeat(40) },
          { kind: "file", path: "src/release.ts" },
          { kind: "external", uri: "https://example.test/evidence", label: "Evidence" },
          { kind: "manual", note: "Manual evidence\nwith context." },
        ],
        targetRevisions: [{
          target: { kind: "entity", id: TOPIC_ID },
          revision: "2".repeat(64),
          semanticRevision: 2,
        }, {
          target: { kind: "entity", id: RELATION_ID },
          revision: "3".repeat(64),
          semanticRevision: 3,
        }],
      },
    };
    vi.spyOn(api, "getInboxDraft").mockResolvedValue(rich);
    const preview = vi.spyOn(api, "previewInboxOperation");
    renderRoute(api);
    await user.click((await screen.findByText(base.title)).closest("button")!);
    await screen.findByText("Rich body", { exact: false });
    await user.click(screen.getByRole("button", { name: "Edit local draft" }));
    const dialog = await screen.findByRole("dialog", { name: "Edit local Spec draft" });
    expect(within(dialog).getByText("Existing evidence (preserved)")).toBeVisible();
    expect(within(dialog).getByText("Evidence")).toBeVisible();
    expect(within(dialog).getByRole("textbox", { name: /Topic endpoint attestations/ })).toHaveValue(
      `${TOPIC_ID} | ${"2".repeat(64)} | 2`,
    );
    expect(within(dialog).getByRole("combobox", { name: /One hierarchy relation/ })).toHaveValue("derived_from");
    await user.click(within(dialog).getByRole("button", { name: "Preview local draft" }));
    await within(dialog).findByRole("heading", { name: "Evidence docket" });
    const request = preview.mock.calls[0]![0];
    expect(request.action.kind).toBe("inbox.draft.save");
    if (request.action.kind !== "inbox.draft.save") throw new Error("Expected draft save request.");
    expect(request.action.draft).toEqual(rich.input);
  });

  it("rotates operation identity after review edits and fails a rejected apply closed", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const preview = vi.spyOn(api, "previewInboxOperation");
    vi.spyOn(api, "applyInboxOperation").mockRejectedValue(new Error("/private/repository must not leak"));
    renderRoute(api);
    await screen.findByRole("heading", { name: "Release benchmark pending Spec update" });
    await user.click(screen.getByRole("button", { name: "Reject proposal" }));
    const dialog = await screen.findByRole("dialog", { name: "Reject proposal" });
    const rationale = within(dialog).getByRole("textbox", { name: "Review rationale" });
    await user.type(rationale, "The evidence is incomplete.");
    await user.click(within(dialog).getByRole("button", { name: "Preview rejection" }));
    await within(dialog).findByRole("heading", { name: "Evidence docket" });
    await user.type(rationale, " Rework it.");
    await user.click(within(dialog).getByRole("button", { name: "Preview rejection" }));
    await within(dialog).findByRole("heading", { name: "Evidence docket" });
    expect(preview.mock.calls[0]![0].operationId).not.toBe(preview.mock.calls[1]![0].operationId);
    await user.click(within(dialog).getByRole("button", { name: "Review exact preview" }));
    const confirmation = await screen.findByRole("alertdialog", { name: "Reject this proposal?" });
    await user.click(within(confirmation).getByRole("button", { name: "Reject proposal" }));
    expect(await within(confirmation).findByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(confirmation).not.toHaveTextContent("/private/repository");
    await user.click(within(confirmation).getByRole("button", { name: "Keep reviewing" }));
    expect(screen.getByRole("dialog", { name: "Reject proposal" })).toBeVisible();
  });

  it("keeps unavailable and list-error states explicit without issuing hidden reads", async () => {
    const unavailableApi = createFixtureApi();
    const capabilities = await unavailableApi.getCapabilities();
    const list = vi.spyOn(unavailableApi, "getInboxDrafts");
    vi.spyOn(unavailableApi, "getCapabilities").mockResolvedValue({
      ...capabilities,
      inbox: {
        ...capabilities.inbox,
        read: { availability: "unavailable", reason: "Inbox storage is not connected." },
      },
    });
    const unavailable = renderRoute(unavailableApi);
    expect(await screen.findByRole("heading", { name: "Inbox is unavailable" })).toBeVisible();
    expect(screen.getByText("Inbox storage is not connected.")).toBeVisible();
    expect(list).not.toHaveBeenCalled();
    unavailable.unmount();

    const errorApi = createFixtureApi();
    vi.spyOn(errorApi, "getInboxDrafts").mockRejectedValue(new Error("/private/repository/drafts"));
    renderRoute(errorApi);
    const alert = await screen.findByRole("alert");
    expect(within(alert).getByRole("heading", { name: "This view could not be loaded" })).toBeVisible();
    expect(alert).not.toHaveTextContent("/private/repository/drafts");
  });
});
