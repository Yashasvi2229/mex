import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { describe, expect, it, vi } from "vitest";
import type { HubApi } from "../api/client";
import { HubApiProvider } from "../api/context";
import type {
  RelayDetail,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  RelaySummary,
  TeamMemberListResponse,
  TeamWorkstreamListResponse,
} from "../api/types";
import { createFixtureApi } from "../dev/fixture-api";
import { AppRoutes } from "./App";

const DRAFT_ID = "relay-draft-01";
const RELAY_ID = "relay_01000000000000000000000001";
const ADA_ID = "member_01K36WVM6H7JK8M9NPQRSTVVWX";
const GRACE_ID = "member_01K36R3X4A5BC6DE7FGHJKMNPQ";
const WORKSTREAM_ID = "ws_01K37WVM6H7JK8M9NPQRSTVVW0";
const LEGACY_WARNING = "One or more legacy schema-v1 Relays have no canonical publication timestamp.";

function renderRoute(api: HubApi = createFixtureApi()) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HubApiProvider api={api}>
        <MemoryRouter initialEntries={["/relays"]}>
          <AppRoutes />
        </MemoryRouter>
      </HubApiProvider>
    </QueryClientProvider>,
  );
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function summaryOf(detail: RelayDetail): RelaySummary {
  const {
    completed: _completed,
    inProgress: _inProgress,
    decisions: _decisions,
    blockers: _blockers,
    unresolvedQuestions: _questions,
    changedFiles: _files,
    code: _code,
    evidence: _evidence,
    nextActions: _actions,
    diagnostics: _diagnostics,
    diagnosticsTruncated: _diagnosticsTruncated,
    ...summary
  } = detail;
  return summary;
}

describe("Relay handoff workbench", () => {
  it("uses the benchmark query shape, readiness markers, and keeps every lifecycle state in Sent", async () => {
    const api = createFixtureApi();
    const base = await api.getRelay(RELAY_ID);
    const acknowledged: RelayDetail = {
      ...base,
      ref: { kind: "relay", id: "relay_02000000000000000000000001", title: "Acknowledged sent relay" },
      sourcePath: ".mex/relays/relay_02000000000000000000000001.md",
      summary: "Acknowledged sent relay",
      state: "acknowledged",
      sender: { kind: "member", memberId: ADA_ID, displayName: "Ada Lovelace" },
      acknowledgedBy: { kind: "member", memberId: GRACE_ID, displayName: "Grace Hopper" },
      acknowledgedAt: "2026-08-23T08:40:00.000Z",
    };
    const closed: RelayDetail = {
      ...acknowledged,
      ref: { kind: "relay", id: "relay_03000000000000000000000001", title: "Closed sent relay" },
      sourcePath: ".mex/relays/relay_03000000000000000000000001.md",
      summary: "Closed sent relay",
      state: "closed",
      closedBy: { kind: "member", memberId: ADA_ID, displayName: "Ada Lovelace" },
      closedAt: "2026-08-23T08:42:00.000Z",
    };
    const originalRelays = api.getRelays.bind(api);
    const relays = vi.spyOn(api, "getRelays").mockImplementation(async (request) => {
      if (request.perspective !== "sent") return originalRelays(request);
      return {
        items: [summaryOf(acknowledged), summaryOf(closed)],
        nextCursor: null,
        truncated: false,
        sourceTruncated: false,
        deterministicRevision: "1".repeat(64),
        diagnostics: [],
        diagnosticsTruncated: false,
      };
    });
    vi.spyOn(api, "getRelay").mockImplementation(async (id) => {
      if (id === acknowledged.ref.id) return structuredClone(acknowledged);
      if (id === closed.ref.id) return structuredClone(closed);
      return structuredClone(base);
    });
    const drafts = vi.spyOn(api, "getRelayDrafts");
    renderRoute(api);

    await screen.findByRole("heading", { level: 1, name: "Relays" });
    const page = document.querySelector('[data-relay-workbench="ready"]');
    expect(page).toHaveAttribute("data-relay-workbench", "ready");
    expect((await screen.findByText("Carry the release evidence through the final cross-platform gate.")).closest("button")).toHaveAttribute("data-relay-draft-id", DRAFT_ID);
    await waitFor(() => expect(document.querySelector(`[data-relay-id="${RELAY_ID}"]`)).toBeInTheDocument());
    expect(drafts).toHaveBeenCalledWith({ limit: 25 });
    expect(relays).toHaveBeenCalledWith({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 });

    await userEvent.setup().click(screen.getByRole("tab", { name: "Sent" }));
    expect((await screen.findAllByText("Acknowledged sent relay")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Closed sent relay")).toBeVisible();
    expect(relays).toHaveBeenCalledWith({ perspective: "sent", limit: 25 });
  });

  it("renders the full immutable handoff and exact signed docket inside confirmation", async () => {
    const api = createFixtureApi();
    const current = await api.getRelay(RELAY_ID);
    vi.spyOn(api, "getRelay").mockResolvedValue({
      ...current,
      schemaVersion: 1,
      publishedAt: null,
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME", severity: "warning", message: LEGACY_WARNING }],
    });
    const preview = vi.spyOn(api, "previewRelayOperation");
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(screen.getByText("Not acknowledged")).toBeVisible();
    expect(screen.getAllByText("Open", { selector: "dd" })).toHaveLength(2);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Claim handoff" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Review the exact Relay operation" });
    expect(await within(dialog).findByRole("heading", { name: "Exact handoff docket" })).toBeVisible();
    expect(within(dialog).getByText("relay.acknowledge")).toBeVisible();
    expect(within(dialog).getByText("Release evidence is ready for the final cross-platform gate.")).toBeVisible();
    expect(within(dialog).getByText("Linux Node 22 characterization is captured.")).toBeVisible();
    expect(within(dialog).getByText("Cross-platform storage portability is awaiting claim.")).toBeVisible();
    expect(within(dialog).getByText("scripts/release-benchmark/run.mjs")).toBeVisible();
    expect(within(dialog).getByText("Exact fixture evidence for Relay UI validation.", { exact: false })).toBeVisible();
    expect(within(dialog).getByText("Not acknowledged")).toBeVisible();
    expect(within(dialog).getByText("Open")).toBeVisible();
    expect(within(dialog).getByText(LEGACY_WARNING)).toBeVisible();
    expect(within(dialog).getByLabelText(/Exact diff for \.mex\/relays\//u)).toBeVisible();
    expect(within(dialog).getByText("feat/project-hub-foundation", { exact: true })).toBeVisible();
    expect(within(dialog).getByText("Dirty", { exact: true })).toBeVisible();

    const exactEnvelope = await preview.mock.results[0]!.value;
    await userEvent.setup().click(within(dialog).getByRole("button", { name: "Apply exact preview" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(JSON.stringify(apply.mock.calls[0]![0])).toBe(JSON.stringify(exactEnvelope));
  });

  it("preserves entity and code evidence when an existing valid draft is edited", async () => {
    const api = createFixtureApi();
    const original = await api.getRelayDraft(DRAFT_ID);
    const allEvidence = [
      { kind: "entity" as const, entity: { id: "decision-1", kind: "decision", title: "Pinned gate" } },
      { kind: "code" as const, code: { kind: "symbol" as const, symbolId: "relay.apply", fingerprint: "f".repeat(64) } },
      { kind: "file" as const, path: "src/relay.ts" },
      { kind: "commit" as const, hash: "a".repeat(40) },
      { kind: "external" as const, uri: "https://example.test/run", label: "Run" },
      { kind: "manual" as const, note: "Observed locally." },
    ];
    const prepared = await api.previewRelayOperation({
      operationId: "relay_prepare_all_evidence",
      action: { kind: "relay.draft.save", draftId: original.id, draft: { ...original.input, evidence: allEvidence } },
      expectedRevisions: [{ target: { kind: "local", namespace: "relay-draft", id: original.id }, revision: original.revision }],
    });
    await api.applyRelayOperation(prepared);
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api);

    await userEvent.setup().click((await screen.findByText(original.summary)).closest("button")!);
    await userEvent.setup().click(await screen.findByRole("button", { name: "Edit" }));
    const composer = await screen.findByRole("dialog", { name: "Edit local Relay draft" });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "Edited without evidence loss." } });
    await userEvent.setup().click(within(composer).getByRole("button", { name: "Review local change" }));
    await screen.findByRole("alertdialog", { name: "Apply this exact local draft preview?" });
    const request = preview.mock.calls.at(-1)![0];
    expect(request.action.kind).toBe("relay.draft.save");
    if (request.action.kind !== "relay.draft.save") throw new Error("Expected Relay draft save.");
    expect(request.action.draft.evidence).toEqual(allEvidence);
  });

  it("never restores an in-flight composer preview after an edit invalidates its request", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    const delayed = deferred<RelayOperationPreviewResponse>();
    let staleRequest: RelayOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce((request) => {
      staleRequest = request;
      return delayed.promise;
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api);

    await user.click((await screen.findByText("Carry the release evidence through the final cross-platform gate.")).closest("button")!);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const composer = await screen.findByRole("dialog", { name: "Edit local Relay draft" });
    const summary = within(composer).getByRole("textbox", { name: "Summary" });
    await user.click(within(composer).getByRole("button", { name: "Review local change" }));
    await waitFor(() => expect(staleRequest).toBeDefined());

    fireEvent.change(summary, { target: { value: "The visible draft changed after preview began." } });
    const staleEnvelope = await realPreview(staleRequest!);
    await act(async () => {
      delayed.resolve(staleEnvelope);
      await delayed.promise;
    });

    expect(screen.queryByRole("alertdialog", { name: "Apply this exact local draft preview?" })).not.toBeInTheDocument();
    await waitFor(() => expect(within(composer).getByRole("button", { name: "Review local change" })).toBeEnabled());
    expect(apply).not.toHaveBeenCalled();
  });

  it("accepts a signed draft preview when the service canonically reorders set-like handoff fields", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const original = await api.getRelayDraft(DRAFT_ID);
    const setRichInput = {
      ...original.input,
      recipients: [
        { kind: "member" as const, memberId: GRACE_ID, displayName: "Grace Hopper" },
        { kind: "member" as const, memberId: ADA_ID, displayName: "Ada Lovelace" },
      ],
      decisions: [
        { id: "release-order", kind: "decision", title: "Keep the release evidence together" },
        { id: "relay-boundary", kind: "constraint", title: "Keep delivery repository-native" },
      ],
      changedFiles: ["src/team/relay/handoff.ts", "packages/hub-web/src/pages/RelayPage.tsx"],
      code: [
        { kind: "symbol" as const, symbolId: "relay.preview.accept", fingerprint: "preview-v1" },
        { kind: "file" as const, path: "packages/hub-web/src/pages/RelayPage.tsx", fingerprint: "page-v1" },
      ],
    };
    const prepared = await api.previewRelayOperation({
      operationId: "relay_prepare_set_order",
      action: { kind: "relay.draft.save", draftId: original.id, draft: setRichInput },
      expectedRevisions: [{ target: { kind: "local", namespace: "relay-draft", id: original.id }, revision: original.revision }],
    });
    await api.applyRelayOperation(prepared);

    const realPreview = api.previewRelayOperation.bind(api);
    let reorderedEnvelope: RelayOperationPreviewResponse | undefined;
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce(async (request) => {
      const result = await realPreview(request);
      if (result.request.action.kind !== "relay.draft.save") throw new Error("Expected a Relay draft save preview.");
      const draft = result.request.action.draft;
      reorderedEnvelope = {
        ...result,
        request: {
          ...result.request,
          action: {
            ...result.request.action,
            draft: {
              ...draft,
              recipients: [...draft.recipients].reverse(),
              decisions: [...draft.decisions].reverse(),
              changedFiles: [...draft.changedFiles].reverse(),
              code: [...draft.code].reverse(),
            },
          },
        },
      };
      return reorderedEnvelope;
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api);

    await user.click((await screen.findByText(original.summary)).closest("button")!);
    await user.click(await screen.findByRole("button", { name: "Edit" }));
    const composer = await screen.findByRole("dialog", { name: "Edit local Relay draft" });
    await user.click(within(composer).getByRole("button", { name: "Review local change" }));
    const review = await screen.findByRole("alertdialog", { name: "Apply this exact local draft preview?" });

    expect(within(review).getByRole("heading", { name: "Exact handoff docket" })).toBeVisible();
    await user.click(within(review).getByRole("button", { name: "Save exact draft" }));
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(1));
    expect(apply.mock.calls[0]![0]).toBe(reorderedEnvelope);
  });

  it("rejects a crossed preview whose echoed request differs from the exact submitted request", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    const delayed = deferred<RelayOperationPreviewResponse>();
    let submitted: RelayOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewRelayOperation").mockImplementationOnce((request) => {
      submitted = request;
      return delayed.promise;
    });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api);

    await user.click(await screen.findByRole("button", { name: "Claim handoff" }));
    const review = await screen.findByRole("alertdialog", { name: "Review the exact Relay operation" });
    await waitFor(() => expect(submitted).toBeDefined());
    const exact = await realPreview(submitted!);
    if (exact.request.action.kind !== "relay.acknowledge") throw new Error("Expected an acknowledge preview.");
    const crossed: RelayOperationPreviewResponse = {
      ...exact,
      request: {
        ...exact.request,
        action: { ...exact.request.action, relayId: "relay_02000000000000000000000001" },
      },
    };
    await act(async () => {
      delayed.resolve(crossed);
      await delayed.promise;
    });

    expect(await within(review).findByText("The signed Relay preview did not exactly match the submitted request. Prepare a fresh preview before applying.")).toBeVisible();
    expect(within(review).queryByRole("heading", { name: "Exact handoff docket" })).not.toBeInTheDocument();
    expect(within(review).getByRole("button", { name: "Apply exact preview" })).toBeDisabled();
    expect(apply).not.toHaveBeenCalled();
  });

  it("does not let a review retry response resurrect after the dialog invalidates its attempt", async () => {
    const user = userEvent.setup();
    const api = createFixtureApi();
    const realPreview = api.previewRelayOperation.bind(api);
    const delayedRetry = deferred<RelayOperationPreviewResponse>();
    let retryRequest: RelayOperationPreviewRequest | undefined;
    vi.spyOn(api, "previewRelayOperation")
      .mockImplementationOnce(async (request) => {
        const result = await realPreview(request);
        return {
          ...result,
          request: { ...result.request, operationId: "hub_relay_crossed_operation" },
        };
      })
      .mockImplementationOnce((request) => {
        retryRequest = request;
        return delayedRetry.promise;
      });
    const apply = vi.spyOn(api, "applyRelayOperation");
    renderRoute(api);

    const claim = await screen.findByRole("button", { name: "Claim handoff" });
    await user.click(claim);
    const review = await screen.findByRole("alertdialog", { name: "Review the exact Relay operation" });
    await user.click(await within(review).findByRole("button", { name: "Try again" }));
    await waitFor(() => expect(retryRequest).toBeDefined());
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("alertdialog", { name: "Review the exact Relay operation" })).not.toBeInTheDocument());

    const exactRetry = await realPreview(retryRequest!);
    await act(async () => {
      delayedRetry.resolve(exactRetry);
      await delayedRetry.promise;
    });

    expect(screen.queryByRole("alertdialog", { name: "Review the exact Relay operation" })).not.toBeInTheDocument();
    expect(claim).toHaveFocus();
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps local composition available with no eligible Workstream lookup", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "getWorkstreams").mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "2".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    } satisfies TeamWorkstreamListResponse);
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api);

    const trigger = await screen.findByRole("button", { name: "New local draft" });
    await waitFor(() => expect(trigger).toBeEnabled());
    await userEvent.setup().click(trigger);
    const composer = await screen.findByRole("dialog", { name: "Compose a local Relay draft" });
    await userEvent.setup().selectOptions(within(composer).getByLabelText("Recipients"), [GRACE_ID]);
    fireEvent.change(within(composer).getByRole("textbox", { name: "Workstream ID" }), { target: { value: WORKSTREAM_ID } });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Workstream title" }), { target: { value: "Offline Relay" } });
    fireEvent.change(within(composer).getByRole("textbox", { name: "Summary" }), { target: { value: "Local draft without repository Workstream lookup." } });
    await userEvent.setup().click(within(composer).getByRole("button", { name: "Review local change" }));
    await screen.findByRole("alertdialog", { name: "Apply this exact local draft preview?" });
    expect(preview).toHaveBeenCalledWith(expect.objectContaining({
      action: expect.objectContaining({
        kind: "relay.draft.save",
        draft: expect.objectContaining({ workstream: { kind: "workstream", id: WORKSTREAM_ID, title: "Offline Relay" } }),
      }),
      expectedRevisions: [],
    }));
  });

  it("uses exact Member and Workstream detail reads outside bounded composer pages", async () => {
    const api = createFixtureApi();
    const grace = await api.getMember(GRACE_ID);
    const exactMember = api.getMember.bind(api);
    const exactWorkstream = api.getWorkstream.bind(api);
    vi.spyOn(api, "getMembers").mockImplementation(async (request) => ({
      items: request.cursor === "members-page-2" ? [grace] : [],
      nextCursor: request.cursor === "members-page-2" ? null : "members-page-2",
      truncated: request.cursor !== "members-page-2",
      sourceTruncated: false,
      deterministicRevision: "3".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    } satisfies TeamMemberListResponse));
    vi.spyOn(api, "getWorkstreams").mockResolvedValue({
      items: [],
      nextCursor: "more-workstreams",
      truncated: true,
      sourceTruncated: false,
      deterministicRevision: "4".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    } satisfies TeamWorkstreamListResponse);
    const member = vi.spyOn(api, "getMember").mockImplementation(exactMember);
    const workstream = vi.spyOn(api, "getWorkstream").mockImplementation(exactWorkstream);
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(screen.getByRole("tab", { name: "My open" })).toBeEnabled();
    expect(member).toHaveBeenCalledWith(ADA_ID);
    const compose = await screen.findByRole("button", { name: "New local draft" });
    await waitFor(() => expect(compose).toBeEnabled());
    await userEvent.setup().click(compose);
    const composer = await screen.findByRole("dialog", { name: "Compose a local Relay draft" });
    expect(within(composer).getByRole("option", { name: "Grace Hopper" })).toHaveValue(GRACE_ID);
    await userEvent.setup().keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Compose a local Relay draft" })).not.toBeInTheDocument());
    await userEvent.setup().click((await screen.findByText("Carry the release evidence through the final cross-platform gate.")).closest("button")!);
    const publish = await screen.findByRole("button", { name: "Review & publish" });
    await waitFor(() => expect(publish).toBeEnabled());
    expect(member).toHaveBeenCalledWith(GRACE_ID);
    expect(workstream).toHaveBeenCalledWith(WORKSTREAM_ID);
    await userEvent.setup().click(publish);
    const dialog = await screen.findByRole("alertdialog", { name: "Review the exact Relay operation" });
    expect(within(dialog).getByText("Sender").closest("div")).toHaveTextContent("Ada Lovelace");
    expect(preview.mock.calls.at(-1)![0].expectedRevisions).toEqual(expect.arrayContaining([
      expect.objectContaining({ target: { kind: "artifact", path: `.mex/team/members/${GRACE_ID}.md` } }),
      expect.objectContaining({ target: { kind: "artifact", path: `.mex/workstreams/${WORKSTREAM_ID}.md` } }),
    ]));
  });

  it("keeps publication disabled with visible recovery when an exact dependency is ineligible", async () => {
    const api = createFixtureApi();
    const workstream = await api.getWorkstream(WORKSTREAM_ID);
    vi.spyOn(api, "getWorkstream").mockResolvedValue({ ...workstream, state: "done" });
    const preview = vi.spyOn(api, "previewRelayOperation");
    renderRoute(api);

    await userEvent.setup().click((await screen.findByText("Carry the release evidence through the final cross-platform gate.")).closest("button")!);
    const publish = await screen.findByRole("button", { name: "Review & publish" });
    await waitFor(() => expect(screen.getByText("Choose a Workstream in Planned, Active, or Blocked before publishing.")).toBeVisible());
    expect(publish).toBeDisabled();
    expect(preview).not.toHaveBeenCalled();
  });

  it("keeps All and Drafts reachable without Member authority and surfaces legacy warnings", async () => {
    const api = createFixtureApi();
    vi.spyOn(api, "getCurrentActor").mockResolvedValue({
      actor: { kind: "git", name: "Unmatched", email: "unmatched@example.test" },
      source: "git-fallback",
      selection: null,
      diagnostics: [],
      diagnosticsTruncated: false,
    });
    const base = await api.getRelay(RELAY_ID);
    const legacy: RelayDetail = {
      ...base,
      schemaVersion: 1,
      publishedAt: null,
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME", severity: "warning", message: LEGACY_WARNING }],
    };
    vi.spyOn(api, "getRelays").mockResolvedValue({
      items: [summaryOf(legacy)],
      nextCursor: null,
      truncated: false,
      sourceTruncated: true,
      deterministicRevision: "5".repeat(64),
      diagnostics: [...legacy.diagnostics, ...legacy.diagnostics],
      diagnosticsTruncated: false,
    });
    vi.spyOn(api, "getRelay").mockResolvedValue(legacy);
    renderRoute(api);

    expect(await screen.findByText("Select an active Member")).toBeVisible();
    expect(await screen.findByText("Carry the release evidence through the final cross-platform gate.")).toBeVisible();
    await userEvent.setup().click(screen.getByRole("tab", { name: "All open" }));
    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(await screen.findAllByText(LEGACY_WARNING)).toHaveLength(2);
    expect(screen.getByText("Legacy timestamp unavailable")).toBeVisible();
    expect(screen.getByText("Relay results were bounded because the canonical source exceeded its safe read limit.")).toBeVisible();
    expect(screen.getByText("Select an active current Member to claim or close this Relay.")).toBeVisible();
  });

  it("does not offer lifecycle actions when that capability is unavailable", async () => {
    const api = createFixtureApi();
    const capabilities = await api.getCapabilities();
    vi.spyOn(api, "getCapabilities").mockResolvedValue({
      ...capabilities,
      relays: {
        ...capabilities.relays,
        lifecycleMutation: { availability: "unavailable", reason: "Lifecycle mutation is intentionally disconnected." },
      },
    });
    renderRoute(api);

    expect(await screen.findByRole("heading", { name: "Release evidence is ready for the final cross-platform gate." })).toBeVisible();
    expect(screen.queryByRole("button", { name: "Claim handoff" })).not.toBeInTheDocument();
    expect(screen.getByText("Lifecycle mutation is intentionally disconnected.")).toBeVisible();
  });
});
