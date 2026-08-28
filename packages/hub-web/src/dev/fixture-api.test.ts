import {
  ActivityResponseSchema,
  CodeWorkspaceResponseSchema,
  CodeKnowledgeResponseSchema,
  HealthResponseSchema,
  HomeResponseSchema,
  HubCapabilitiesSchema,
  HubJobSnapshotSchema,
  InboxDraftDetailSchema,
  InboxDraftListResponseSchema,
  InboxOperationApplyResponseSchema,
  InboxOperationPreviewResponseSchema,
  InboxProposalDetailSchema,
  InboxProposalListResponseSchema,
  JobPageResponseSchema,
  SearchResponseSchema,
  SessionResponseSchema,
  SpecDetailResponseSchema,
  SpecListResponseSchema,
  TeamCurrentActorResponseSchema,
  TeamMemberListResponseSchema,
  TeamMemberSchema,
  TeamOperationApplyResponseSchema,
  TeamOperationPreviewResponseSchema,
  TeamWorkstreamListResponseSchema,
  TeamWorkstreamSchema,
  WikiBacklinksResponseSchema,
  WikiEntityDetailResponseSchema,
  WikiEntityListResponseSchema,
  WikiRelationsResponseSchema,
} from "@mex/hub-contracts";
import { describe, expect, it } from "vitest";
import { createFixtureApi } from "./fixture-api";

describe("development-only populated fixture", () => {
  it("stays inside every shared wire contract", async () => {
    const api = createFixtureApi();
    const [session, capabilities, home, activity, search, code, health, jobs, entities, detail, relations, backlinks, codeKnowledge, workstreams, specs, drafts, proposals] = await Promise.all([
      api.getSession(),
      api.getCapabilities(),
      api.getHome(),
      api.getActivity({ limit: 25 }),
      api.search({ q: "bootstrap", limit: 25 }),
      api.getCodeSymbol("sym.createHubServer", { view: "impact", depth: 2 }),
      api.getHealth(),
      api.getJobs(),
      api.listWikiEntities({ limit: 25 }),
      api.getWikiEntity("mx_01K36WVM6H7JK8M9NPQRSTVVWX"),
      api.getWikiRelations("mx_01K36WVM6H7JK8M9NPQRSTVVWX", { direction: "both", limit: 25 }),
      api.getWikiBacklinks("mx_01K36WVM6H7JK8M9NPQRSTVVWX", { limit: 25 }),
      api.getCodeKnowledge("sym.createHubServer", { limit: 25 }),
      api.getWorkstreams({ limit: 25 }),
      api.listSpecs({ limit: 25 }),
      api.getInboxDrafts({ limit: 25 }),
      api.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
    ]);

    expect(SessionResponseSchema.safeParse(session).success).toBe(true);
    expect(HubCapabilitiesSchema.safeParse(capabilities).success).toBe(true);
    expect(HomeResponseSchema.safeParse(home).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(activity).success).toBe(true);
    expect(home.sections.activity).toEqual({ availability: "available", count: 4 });
    expect(home.sections.inbox).toEqual({ availability: "available", count: 1 });
    expect(home.sections.relays.availability).toBe("unavailable");
    expect(activity.items.some((item) => item.source === "activity")).toBe(true);
    expect(activity.items.some((item) => item.source === "legacy")).toBe(true);
    expect(SearchResponseSchema.safeParse(search).success).toBe(true);
    expect(CodeWorkspaceResponseSchema.safeParse(code).success).toBe(true);
    expect(HealthResponseSchema.safeParse(health).success).toBe(true);
    expect(JobPageResponseSchema.safeParse(jobs).success).toBe(true);
    expect(jobs.items.every((job) => HubJobSnapshotSchema.safeParse(job).success)).toBe(true);
    const entityPage = WikiEntityListResponseSchema.safeParse(entities);
    expect(entityPage.success, entityPage.success ? undefined : entityPage.error.message).toBe(true);
    expect(WikiEntityDetailResponseSchema.safeParse(detail).success).toBe(true);
    expect(WikiRelationsResponseSchema.safeParse(relations).success).toBe(true);
    expect(WikiBacklinksResponseSchema.safeParse(backlinks).success).toBe(true);
    expect(CodeKnowledgeResponseSchema.safeParse(codeKnowledge).success).toBe(true);
    expect(TeamWorkstreamListResponseSchema.safeParse(workstreams).success).toBe(true);
    expect(TeamWorkstreamSchema.safeParse(workstreams.items[0]).success).toBe(true);
    expect(SpecListResponseSchema.safeParse(specs).success).toBe(true);
    expect(specs.availability).toBe("ready");
    if (specs.availability !== "ready") throw new Error("Fixture Spec list must be ready.");
    const specDetail = await api.getSpec(specs.page.items[0]!.id);
    expect(SpecDetailResponseSchema.safeParse(specDetail).success).toBe(true);
    expect(specDetail.availability).toBe("ready");
    expect(InboxDraftListResponseSchema.safeParse(drafts).success).toBe(true);
    expect(InboxProposalListResponseSchema.safeParse(proposals).success).toBe(true);
    expect(Object.hasOwn(drafts.items[0]!, "input")).toBe(false);
    expect(Object.hasOwn(proposals.items[0]!, "change")).toBe(false);
    expect(InboxDraftDetailSchema.safeParse(await api.getInboxDraft(drafts.items[0]!.id)).success).toBe(true);
    expect(InboxProposalDetailSchema.safeParse(await api.getInboxProposal(proposals.items[0]!.ref.id)).success).toBe(true);

    const members = await api.getMembers({ limit: 25 });
    const member = await api.getMember(members.items[0]!.id);
    const currentActor = await api.getCurrentActor();
    expect(TeamMemberListResponseSchema.safeParse(members).success).toBe(true);
    expect(TeamMemberSchema.safeParse(member).success).toBe(true);
    expect(TeamCurrentActorResponseSchema.safeParse(currentActor).success).toBe(true);

    const preview = await api.previewTeamOperation({
      operationId: "fixture_member_select_contract",
      action: { kind: "member.select", memberId: members.items[1]!.id },
      expectedRevisions: [
        {
          target: { kind: "artifact", path: members.items[1]!.sourcePath },
          revision: members.items[1]!.revision,
        },
        {
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: currentActor.selection?.revision ?? null,
        },
      ],
    });
    const applied = await api.applyTeamOperation(preview);
    expect(TeamOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(TeamOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.events).toEqual([]);
    expect(applied.workstreams).toEqual([]);
    expect((await api.getCurrentActor()).selection?.memberId).toBe(members.items[1]!.id);

    const workstreamPreview = await api.previewTeamOperation({
      operationId: "fixture_workstream_create_contract",
      action: {
        kind: "workstream.create",
        workstream: {
          title: "Spec review",
          goal: "Keep hierarchy explicit.",
          summary: "Use the dedicated fresh-index reader.",
          owners: [currentActor.actor],
          nextMilestone: "Review the Hub surface.",
        },
      },
      expectedRevisions: [],
    });
    const workstreamApplied = await api.applyTeamOperation(workstreamPreview);
    expect(TeamOperationPreviewResponseSchema.safeParse(workstreamPreview).success).toBe(true);
    expect(TeamOperationApplyResponseSchema.safeParse(workstreamApplied).success).toBe(true);
    expect(workstreamApplied.workstreams).toHaveLength(1);
    expect(workstreamApplied.events).toHaveLength(1);
  });

  it("mirrors canonical purpose IDs, exact approval files, and Activity results", async () => {
    const api = createFixtureApi();
    const proposal = await api.getInboxProposal("proposal_01000000000000000000001720");
    const preview = await api.previewInboxOperation({
      operationId: "fixture_inbox_approve_contract",
      action: { kind: "inbox.approve", proposalId: proposal.ref.id },
      expectedRevisions: [{
        target: { kind: "artifact", path: proposal.sourcePath },
        revision: proposal.revision,
      }],
    });
    expect(InboxOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(preview.receipt.purposeIds.map((item) => item.purpose)).toEqual(["activity"]);
    expect(preview.preview.changes.map((change) => change.path)).toEqual([
      ".mex/specs/mx_01000000000000000000000001.md",
      ".mex/events/operations.jsonl",
      proposal.sourcePath,
      expect.stringMatching(/^\.mex\/events\/activity\/2026-08\/event_/u),
    ]);
    const applied = await api.applyInboxOperation(preview);
    expect(InboxOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.events).toHaveLength(1);
    expect(applied.events[0]).toMatchObject({
      id: preview.receipt.purposeIds[0]!.id,
      action: "inbox.approved",
      actor: preview.receipt.authority.actor,
      repoState: preview.receipt.authority.repoState,
    });
    expect(applied.events[0]!.subjects).toEqual([
      { kind: "entity", entity: { id: proposal.ref.id, kind: "proposal" } },
      { kind: "entity", entity: proposal.change.kind === "spec.update" ? proposal.change.target : undefined },
    ]);
  });

  it("keeps local purpose sets empty after creation and publishes with one matching Activity", async () => {
    const api = createFixtureApi();
    const draft = await api.getInboxDraft("inbox_00000000000000000000000000000001");
    const save = await api.previewInboxOperation({
      operationId: "fixture_inbox_existing_save_contract",
      action: { kind: "inbox.draft.save", draftId: draft.id, draft: draft.input },
      expectedRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: draft.id },
        revision: draft.revision,
      }],
    });
    expect(save.receipt.purposeIds).toEqual([]);
    expect((await api.applyInboxOperation(save)).events).toEqual([]);

    const refreshed = await api.getInboxDraft(draft.id);
    const publish = await api.previewInboxOperation({
      operationId: "fixture_inbox_publish_contract",
      action: { kind: "inbox.publish", draftId: refreshed.id },
      expectedRevisions: [{
        target: { kind: "local", namespace: "inbox-draft", id: refreshed.id },
        revision: refreshed.revision,
      }],
    });
    expect(InboxOperationPreviewResponseSchema.safeParse(publish).success).toBe(true);
    expect(publish.receipt.purposeIds.map((item) => item.purpose)).toEqual(["activity", "proposal"]);
    expect(publish.preview.changes.map((change) => change.path)).toEqual([
      expect.stringMatching(/^\.mex\/inbox\/proposal_/u),
      expect.stringMatching(/^\.mex\/events\/activity\/2026-08\/event_/u),
    ]);
    const applied = await api.applyInboxOperation(publish);
    expect(InboxOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.events).toHaveLength(1);
    expect(applied.events[0]!.action).toBe("inbox.published");
  });

  it("rejects stale withdrawal and supports fresh repair followed by approval", async () => {
    const api = createFixtureApi();
    const proposal = await api.getInboxProposal("proposal_01000000000000000000001720");
    const stalePreview = await api.previewInboxOperation({
      operationId: "fixture_inbox_stale_contract",
      action: {
        kind: "inbox.mark-stale",
        proposalId: proposal.ref.id,
        rationale: "The attested Spec revision changed.",
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: proposal.sourcePath },
        revision: proposal.revision,
      }],
    });
    expect(stalePreview.receipt.purposeIds.map((item) => item.purpose)).toEqual(["activity"]);
    const staleResult = await api.applyInboxOperation(stalePreview);
    expect(staleResult.events[0]!.action).toBe("inbox.marked-stale");
    expect(staleResult.proposals[0]).toMatchObject({ state: "stale" });
    expect(staleResult.proposals[0]).not.toHaveProperty("reviewer");
    expect(staleResult.proposals[0]).not.toHaveProperty("reviewedAt");
    expect(staleResult.proposals[0]).not.toHaveProperty("reviewRationale");

    const stale = staleResult.proposals[0]!;
    await expect(api.previewInboxOperation({
      operationId: "fixture_inbox_stale_withdraw_refused",
      action: { kind: "inbox.withdraw", proposalId: stale.ref.id },
      expectedRevisions: [{
        target: { kind: "artifact", path: stale.sourcePath },
        revision: stale.revision,
      }],
    })).rejects.toThrow("requires a pending proposal");
    const freshTargetRevisions = stale.targetRevisions.map((expectation) => ({
      ...expectation,
      revision: "a".repeat(64),
      semanticRevision: expectation.semanticRevision + 1,
    }));
    const repair = await api.previewInboxOperation({
      operationId: "fixture_inbox_repair_contract",
      action: {
        kind: "inbox.repair",
        proposalId: stale.ref.id,
        replacement: {
          change: stale.change,
          rationale: "Re-attested after the exact dependency change.",
          evidence: stale.evidence,
          targetRevisions: freshTargetRevisions,
        },
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: stale.sourcePath },
        revision: stale.revision,
      }],
    });
    const repaired = await api.applyInboxOperation(repair);
    expect(InboxOperationApplyResponseSchema.safeParse(repaired).success).toBe(true);
    expect(repaired.events[0]!.action).toBe("inbox.repaired");
    expect(repaired.proposals[0]).toMatchObject({ state: "pending" });
    expect(repaired.proposals[0]).not.toHaveProperty("reviewer");
    expect(repaired.proposals[0]).not.toHaveProperty("reviewedAt");
    expect(repaired.proposals[0]).not.toHaveProperty("reviewRationale");
    expect(repaired.proposals[0]!.targetRevisions).toEqual(freshTargetRevisions);

    const pending = repaired.proposals[0]!;
    const approval = await api.previewInboxOperation({
      operationId: "fixture_inbox_repaired_approval",
      action: { kind: "inbox.approve", proposalId: pending.ref.id },
      expectedRevisions: [{
        target: { kind: "artifact", path: pending.sourcePath },
        revision: pending.revision,
      }],
    });
    const approved = await api.applyInboxOperation(approval);
    expect(approved.proposals[0]).toMatchObject({ state: "approved" });
    expect(approved.events[0]!.action).toBe("inbox.approved");
  });
});
