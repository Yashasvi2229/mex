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
  RelayDetailSchema,
  RelayDraftDetailSchema,
  RelayDraftListResponseSchema,
  RelayListResponseSchema,
  RelayOperationApplyResponseSchema,
  RelayOperationPreviewResponseSchema,
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
    expect(home.sections.activity).toEqual({ availability: "available", count: 5 });
    expect(home.sections.inbox).toEqual({ availability: "available", count: 3 });
    expect(home.sections.relays).toEqual({ availability: "available", count: 2 });
    expect(activity.items.some((item) => item.source === "activity")).toBe(true);
    expect(activity.items.some((item) => item.source === "legacy")).toBe(true);
    const activityTail = await api.getActivity({
      limit: 25,
      ...(activity.nextCursor === null ? {} : { cursor: activity.nextCursor }),
    });
    expect([...activity.items, ...activityTail.items]).toEqual(expect.arrayContaining([
      expect.objectContaining({
        source: "activity",
        action: "inbox.published",
        recordOrigin: { kind: "workflow", operation: "inbox.publish" },
        label: "Keep approval consequences explicit",
        subjects: [expect.objectContaining({
          kind: "entity",
          entity: expect.objectContaining({
            id: "proposal_01000000000000000000001721",
            entityKind: "proposal",
          }),
        })],
        subjectCount: 1,
      }),
      expect.objectContaining({
        source: "activity",
        action: "relay.acknowledged",
        recordOrigin: { kind: "workflow", operation: "relay.acknowledge" },
        label: "Carry the release evidence through the final cross-platform gate.",
        subjects: [expect.objectContaining({
          kind: "entity",
          entity: expect.objectContaining({
            id: "relay_01000000000000000000000001",
            entityKind: "relay",
          }),
        })],
        subjectCount: 1,
      }),
      expect.objectContaining({
        source: "activity",
        action: "member.updated",
        recordOrigin: { kind: "workflow", operation: "member.update" },
        label: "Daksh Jaitly",
        subjects: [expect.objectContaining({
          kind: "entity",
          entity: expect.objectContaining({
            id: "member_01K35Z2A3B4C5D6E7FGHJKMNPQ",
            entityKind: "member",
          }),
        })],
        subjectCount: 1,
      }),
      expect.objectContaining({
        source: "activity",
        action: "relay.closed",
        recordOrigin: { kind: "custom" },
        label: "Imported closure note",
      }),
      expect.objectContaining({
        source: "activity",
        action: "repository.initialized",
        recordOrigin: { kind: "unknown" },
        label: null,
      }),
    ]));
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

    const [relayDrafts, relays] = await Promise.all([
      api.getRelayDrafts({ limit: 25 }),
      api.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
    ]);
    expect(RelayDraftListResponseSchema.safeParse(relayDrafts).success).toBe(true);
    expect(RelayListResponseSchema.safeParse(relays).success).toBe(true);
    expect(RelayDraftDetailSchema.safeParse(await api.getRelayDraft(relayDrafts.items[0]!.id)).success).toBe(true);
    expect(RelayDetailSchema.safeParse(await api.getRelay(relays.items[0]!.ref.id)).success).toBe(true);

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
    expect(workstreamApplied.events).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        action: "workstream.created",
        origin: { kind: "workflow", operation: "workstream.create" },
        label: "Spec review",
      }),
    ]);
  });

  it("models the human Relay inbox across personal, sent, team, closed, and draft views", async () => {
    const api = createFixtureApi();
    const mineFirst = await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 1,
    });
    const mineSecond = await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 1,
      cursor: mineFirst.nextCursor ?? undefined,
    });
    const [sentOpen, sentClosed, teamOpen, drafts] = await Promise.all([
      api.getRelays({ perspective: "sent", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelays({ perspective: "sent", states: ["closed"], limit: 25 }),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelayDrafts({ limit: 25 }),
    ]);
    const mine = [...mineFirst.items, ...mineSecond.items];

    for (const page of [mineFirst, mineSecond, sentOpen, sentClosed, teamOpen]) {
      expect(RelayListResponseSchema.safeParse(page).success).toBe(true);
    }
    expect(mine.map((relay) => [relay.ref.id, relay.state])).toEqual([
      ["relay_01000000000000000000000002", "acknowledged"],
      ["relay_01000000000000000000000001", "published"],
    ]);
    expect(mineFirst).toMatchObject({ nextCursor: "fixture_relays_1", truncated: true });
    expect(mineSecond).toMatchObject({ nextCursor: null, truncated: false });
    expect(sentOpen.items.map((relay) => [relay.ref.id, relay.state])).toEqual([
      ["relay_01000000000000000000000003", "published"],
      ["relay_01000000000000000000000004", "acknowledged"],
    ]);
    expect(sentClosed.items.map((relay) => [relay.ref.id, relay.state])).toEqual([
      ["relay_01000000000000000000000005", "closed"],
    ]);
    expect(teamOpen.items.map((relay) => relay.ref.id)).toEqual([
      "relay_01000000000000000000000002",
      "relay_01000000000000000000000001",
      "relay_01000000000000000000000003",
      "relay_01000000000000000000000004",
    ]);
    expect([...teamOpen.items, ...sentClosed.items].every((relay) => relay.ref.title === undefined)).toBe(true);

    const details = await Promise.all(
      [...teamOpen.items, ...sentClosed.items].map((relay) => api.getRelay(relay.ref.id)),
    );
    expect(details.every((relay) => RelayDetailSchema.safeParse(relay).success)).toBe(true);
    expect(details.every((relay) => (
      relay.schemaVersion === 3
      && relay.workstream === null
      && relay.publishedRepoState !== null
    ))).toBe(true);
    expect(details.map((relay) => relay.publishedRepoState)).toEqual(expect.arrayContaining([
      expect.objectContaining({ branch: "codex/hub-ux", dirty: false }),
      expect.objectContaining({ branch: "feature/relay-accessibility", dirty: true }),
      expect.objectContaining({ branch: null, head: expect.any(String) }),
      expect.objectContaining({ branch: "feature/unborn-relay", head: null }),
    ]));
    expect(details.find((relay) => (
      relay.state === "acknowledged"
      && relay.acknowledgedBy?.kind === "member"
      && relay.acknowledgedBy.memberId === "member_01K36WVM6H7JK8M9NPQRSTVVWX"
    )))
      .toMatchObject({ summary: "Finish the keyboard and screen-reader pass for the Hub review surfaces." });

    expect(RelayDraftListResponseSchema.safeParse(drafts).success).toBe(true);
    expect(drafts.items).toHaveLength(2);
    expect(drafts.items.every((draft) => !Object.hasOwn(draft, "input"))).toBe(true);
    const richSummary = drafts.items.find((draft) => (
      draft.summary === "Carry the release evidence through the final cross-platform gate."
    ));
    if (richSummary === undefined) throw new Error("Expected the translated legacy Relay draft fixture.");
    const draft = await api.getRelayDraft(richSummary.id);
    expect(RelayDraftDetailSchema.safeParse(draft).success).toBe(true);
    expect(draft).not.toHaveProperty("workstream");
    expect(draft.input).not.toHaveProperty("workstream");
    expect(draft.input).toMatchObject({
      completed: ["The deterministic benchmark fixture is stable."],
      inProgress: ["Collect the final pinned runner evidence."],
      blockers: ["Windows packed-install evidence is not yet recorded."],
      unresolvedQuestions: ["Does the Windows packed-install run retain the same digest?"],
      nextActions: ["Run the cross-platform storage matrix."],
    });
    expect(draft.input.decisions).toHaveLength(1);
    expect(draft.input.code.map((item) => item.kind)).toEqual(["symbol", "file"]);
    expect(draft.input.evidence.map((item) => item.kind)).toEqual([
      "entity",
      "entity",
      "code",
      "file",
      "commit",
      "external",
      "manual",
    ]);
    expect(draft.input.evidence[0]).toMatchObject({
      kind: "entity",
      entity: { kind: "workstream", id: "ws_01K37WVM6H7JK8M9NPQRSTVVW0" },
    });

    const sparseSummary = drafts.items.find((item) => item.id === "relay-draft-02");
    if (sparseSummary === undefined) throw new Error("Expected the sparse standalone Relay draft fixture.");
    const sparse = await api.getRelayDraft(sparseSummary.id);
    expect(RelayDraftDetailSchema.safeParse(sparse).success).toBe(true);
    expect(sparse.input).toEqual({
      recipients: sparse.recipients,
      summary: sparse.summary,
      completed: [],
      inProgress: [],
      decisions: [],
      blockers: [],
      unresolvedQuestions: [],
      changedFiles: [],
      code: [],
      evidence: [],
      nextActions: [],
    });
  });

  it("publishes a standalone schema-v3 Relay with exact repository provenance", async () => {
    const api = createFixtureApi();
    const draft = await api.getRelayDraft("relay-draft-01");
    const recipient = draft.recipients[0];
    if (recipient?.kind !== "member") throw new Error("Expected the Relay fixture recipient to be a Member.");
    const member = await api.getMember(recipient.memberId);
    const preview = await api.previewRelayOperation({
      operationId: "fixture_standalone_relay_publish",
      action: { kind: "relay.publish", draftId: draft.id },
      expectedRevisions: [
        {
          target: { kind: "local", namespace: "relay-draft", id: draft.id },
          revision: draft.revision,
        },
        {
          target: { kind: "artifact", path: member.sourcePath },
          revision: member.revision,
        },
      ],
    });
    expect(RelayOperationPreviewResponseSchema.safeParse(preview).success).toBe(true);
    expect(preview.receipt.authority.repoState.dirty).toBe(true);
    expect(preview.preview.diagnostics).toEqual([{
      code: "RELAY_DIRTY_PUBLICATION_STATE",
      severity: "warning",
      message: "MEX recorded that local changes existed when this Relay was published; it did not record their paths, diff, or contents.",
    }]);

    const applied = await api.applyRelayOperation(preview);
    expect(RelayOperationApplyResponseSchema.safeParse(applied).success).toBe(true);
    expect(applied.relays).toHaveLength(1);
    expect(applied.relays[0]).toMatchObject({
      schemaVersion: 3,
      workstream: null,
      publishedAt: preview.receipt.authority.occurredAt,
      publishedRepoState: preview.receipt.authority.repoState,
      evidence: draft.input.evidence,
    });
    expect(applied.events).toEqual([
      expect.objectContaining({
        schemaVersion: 2,
        action: "relay.published",
        origin: { kind: "workflow", operation: "relay.publish" },
        label: draft.summary,
        workstream: null,
        repoState: preview.receipt.authority.repoState,
      }),
    ]);
    await expect(api.getRelayDraft(draft.id)).rejects.toThrow("Fixture Relay draft not found.");
  });

  it("models the complete Inbox review desk in stable server order", async () => {
    const api = createFixtureApi();
    const firstPage = await api.getInboxProposals({ states: ["pending", "stale"], limit: 2 });
    const secondPage = await api.getInboxProposals({
      states: ["pending", "stale"],
      limit: 2,
      cursor: firstPage.nextCursor ?? undefined,
    });
    const proposals = [...firstPage.items, ...secondPage.items];

    expect(proposals.map((proposal) => proposal.ref.id)).toEqual([
      "proposal_01000000000000000000001720",
      "proposal_01000000000000000000001721",
      "proposal_01000000000000000000001722",
    ]);
    expect(proposals.map((proposal) => proposal.state)).toEqual(["pending", "pending", "stale"]);
    expect(proposals.map((proposal) => proposal.author)).toEqual([
      {
        kind: "member",
        memberId: "member_01K36R3X4A5BC6DE7FGHJKMNPQ",
        displayName: "Grace Hopper",
      },
      {
        kind: "member",
        memberId: "member_01K36WVM6H7JK8M9NPQRSTVVWX",
        displayName: "Ada Lovelace",
      },
      {
        kind: "member",
        memberId: "member_01K36R3X4A5BC6DE7FGHJKMNPQ",
        displayName: "Grace Hopper",
      },
    ]);
    expect(firstPage.nextCursor).toBe("fixture_inbox_proposals_2");
    expect(firstPage.truncated).toBe(true);
    expect(secondPage.nextCursor).toBeNull();
    expect(secondPage.truncated).toBe(false);

    const details = await Promise.all(proposals.map((proposal) => api.getInboxProposal(proposal.ref.id)));
    expect(details.every((proposal) => InboxProposalDetailSchema.safeParse(proposal).success)).toBe(true);

    const teammateUpdate = details[0]!;
    if (teammateUpdate.change.kind !== "spec.update") throw new Error("Expected the teammate fixture to update a Spec.");
    const target = await api.getWikiEntity(teammateUpdate.change.target.id);
    expect(target.entity).toMatchObject({
      id: teammateUpdate.change.target.id,
      kind: teammateUpdate.change.target.kind,
      title: teammateUpdate.change.target.title,
      version: {
        semanticRevision: teammateUpdate.targetRevisions[0]!.semanticRevision,
        contentHash: teammateUpdate.targetRevisions[0]!.revision,
      },
    });
    expect(target.body.content).toContain("The release gate records bounded evidence");

    const knowledgeFirstPage = await api.listWikiEntities({ limit: 25 });
    const knowledgeSecondPage = await api.listWikiEntities({
      limit: 25,
      cursor: knowledgeFirstPage.nextCursor ?? undefined,
    });
    const browsableKnowledge = [...knowledgeFirstPage.items, ...knowledgeSecondPage.items];
    expect(browsableKnowledge).toHaveLength(3);
    expect(browsableKnowledge.map((entity) => entity.id)).not.toContain(teammateUpdate.change.target.id);
    expect(knowledgeSecondPage.nextCursor).toBeNull();

    await expect(api.getWikiEntity("mx_07000000000000000000000000"))
      .rejects.toThrow("Fixture Wiki entity not found.");
  });

  it("provides one rich checkout-local draft without leaking detail through its summary", async () => {
    const api = createFixtureApi();
    const page = await api.getInboxDrafts({ limit: 25 });
    expect(page.items).toHaveLength(1);
    expect(Object.hasOwn(page.items[0]!, "input")).toBe(false);

    const draft = await api.getInboxDraft(page.items[0]!.id);
    expect(InboxDraftDetailSchema.safeParse(draft).success).toBe(true);
    expect(draft.input.change).toMatchObject({
      kind: "spec.create",
      entityKind: "requirement",
      topics: ["mx_01000000000000000000000001"],
      relation: {
        type: "derived_from",
        target: {
          id: "mx_01000000000000000000000001",
          kind: "spec",
          title: "Human-team memory release",
        },
      },
    });
    expect(draft.input.evidence.map((evidence) => evidence.kind)).toEqual([
      "entity",
      "code",
      "file",
      "commit",
      "external",
      "manual",
    ]);
    expect(draft.input.targetRevisions).toEqual([{
      target: { kind: "entity", id: "mx_01000000000000000000000001" },
      revision: "3".repeat(64),
      semanticRevision: 4,
    }]);
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
      schemaVersion: 2,
      id: preview.receipt.purposeIds[0]!.id,
      action: "inbox.approved",
      origin: { kind: "workflow", operation: "inbox.approve" },
      label: proposal.title,
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

  it("projects an exact empty Inbox without changing its read capability", async () => {
    const api = createFixtureApi({ inboxFixture: "empty" });
    const [capability, homeResult, drafts, proposals, actor] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getInboxDrafts({ limit: 25 }),
      api.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
      api.getCurrentActor(),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
    expect(InboxDraftListResponseSchema.safeParse(drafts).success).toBe(true);
    expect(InboxProposalListResponseSchema.safeParse(proposals).success).toBe(true);
    expect(TeamCurrentActorResponseSchema.safeParse(actor).success).toBe(true);
    expect(capability.inbox).toEqual({
      read: { availability: "available" },
      draftMutation: { availability: "available" },
      proposalMutation: { availability: "available" },
      specApproval: { availability: "available" },
    });
    expect(homeResult.sections.inbox).toEqual({ availability: "available", count: 0 });
    expect(drafts).toMatchObject({ items: [], nextCursor: null, truncated: false });
    expect(proposals).toMatchObject({ items: [], nextCursor: null, truncated: false });
    expect(actor.actor).toMatchObject({ kind: "member", displayName: "Ada Lovelace" });
    await expect(api.getInboxDraft("inbox_00000000000000000000000000000001"))
      .rejects.toThrow("Fixture Inbox draft not found.");
    await expect(api.getInboxProposal("proposal_01000000000000000000001720"))
      .rejects.toThrow("Fixture Inbox proposal not found.");
  });

  it("projects an unknown current actor while retaining the populated review queue", async () => {
    const api = createFixtureApi({ inboxFixture: "unknown" });
    const [actor, homeResult, drafts, proposals] = await Promise.all([
      api.getCurrentActor(),
      api.getHome(),
      api.getInboxDrafts({ limit: 25 }),
      api.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
    ]);

    expect(TeamCurrentActorResponseSchema.safeParse(actor).success).toBe(true);
    expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
    expect(actor).toEqual({
      actor: { kind: "unknown" },
      source: "unknown",
      selection: null,
      diagnostics: [{
        code: "ACTOR_UNKNOWN",
        severity: "warning",
        message: "MEX could not resolve a current Team or Git identity.",
      }],
      diagnosticsTruncated: false,
    });
    expect(homeResult.actor).toEqual({ kind: "unknown" });
    expect(homeResult.sections.inbox).toEqual({ availability: "available", count: 3 });
    expect(drafts.items).toHaveLength(1);
    expect(proposals.items).toHaveLength(3);
  });

  it("projects partial Inbox mutation capability without suppressing reads or local drafts", async () => {
    const api = createFixtureApi({ inboxFixture: "partial" });
    const [capability, homeResult, drafts, proposals, wiki] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getInboxDrafts({ limit: 25 }),
      api.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
      api.listWikiEntities({ limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(capability.inbox).toEqual({
      read: { availability: "available" },
      draftMutation: { availability: "available" },
      proposalMutation: {
        availability: "unavailable",
        reason: "Inbox proposal writes are not connected in this Hub process.",
      },
      specApproval: {
        availability: "unavailable",
        reason: "Inbox Spec approval requires exact Wiki planning and apply.",
      },
    });
    expect(capability.wiki.read).toEqual({ availability: "available" });
    expect(homeResult.sections.inbox).toEqual({ availability: "available", count: 3 });
    expect(drafts.items).toHaveLength(1);
    expect(proposals.items).toHaveLength(3);
    expect(WikiEntityListResponseSchema.safeParse(wiki).success).toBe(true);
  });

  it("projects an exact empty Activity timeline without suppressing read or record capability", async () => {
    const api = createFixtureApi({ activityFixture: "empty" });
    const [capability, homeResult, page] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getActivity({ limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(page).success).toBe(true);
    expect(capability.activity).toEqual({ availability: "available" });
    expect(capability.activityRecord).toEqual({ availability: "available" });
    expect(homeResult.sections.activity).toEqual({ availability: "available", count: 0 });
    expect(page).toEqual({
      items: [],
      nextCursor: null,
      hasMore: false,
      sourceTruncated: false,
      deterministicRevision: "7".repeat(64),
      diagnostics: [],
      diagnosticsTruncated: false,
    });
  });

  it("isolates valid legacy Activity without inventing canonical history or diagnostics", async () => {
    const api = createFixtureApi({ activityFixture: "legacy" });
    const [homeResult, all, canonical] = await Promise.all([
      api.getHome(),
      api.getActivity({ limit: 25 }),
      api.getActivity({ source: "activity", limit: 25 }),
    ]);

    expect(ActivityResponseSchema.safeParse(all).success).toBe(true);
    expect(ActivityResponseSchema.safeParse(canonical).success).toBe(true);
    expect(homeResult.sections.activity).toEqual({ availability: "available", count: 0 });
    expect(all.items).toHaveLength(2);
    expect(all.items.every((item) => item.source === "legacy")).toBe(true);
    expect(all.diagnostics).toEqual([]);
    expect(canonical.items).toEqual([]);
    expect(canonical.diagnostics).toEqual([]);
  });

  it("keeps trusted Activity visible beside bounded partial-source diagnostics", async () => {
    const api = createFixtureApi({ activityFixture: "partial" });
    const [homeResult, page] = await Promise.all([
      api.getHome(),
      api.getActivity({ limit: 25 }),
    ]);

    expect(ActivityResponseSchema.safeParse(page).success).toBe(true);
    expect(homeResult.sections.activity).toEqual({ availability: "available", count: 5 });
    expect(page.items).toHaveLength(4);
    expect(page.nextCursor).not.toBeNull();
    expect(page.sourceTruncated).toBe(true);
    expect(page.diagnosticsTruncated).toBe(true);
    expect(page.diagnostics).toEqual([{
      code: "LEGACY_ACTIVITY_MALFORMED",
      severity: "warning",
      message: "One malformed legacy row was excluded while valid history was retained.",
      path: ".mex/events/decisions.jsonl",
    }]);
  });

  it("projects exact empty Relay queues and drafts without suppressing Relay reads", async () => {
    const api = createFixtureApi({ relayFixture: "empty" });
    const [capability, homeResult, drafts, open, closed] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getRelayDrafts({ limit: 25 }),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelays({ perspective: "all", states: ["closed"], limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(HomeResponseSchema.safeParse(homeResult).success).toBe(true);
    expect(RelayDraftListResponseSchema.safeParse(drafts).success).toBe(true);
    expect(RelayListResponseSchema.safeParse(open).success).toBe(true);
    expect(RelayListResponseSchema.safeParse(closed).success).toBe(true);
    expect(capability.relays).toEqual({
      read: { availability: "available" },
      draftMutation: { availability: "available" },
      publish: { availability: "available" },
      lifecycleMutation: { availability: "available" },
    });
    expect(homeResult.sections.relays).toEqual({ availability: "available", count: 0 });
    expect(drafts).toMatchObject({ items: [], nextCursor: null, truncated: false });
    expect(open).toMatchObject({ items: [], nextCursor: null, truncated: false });
    expect(closed).toMatchObject({ items: [], nextCursor: null, truncated: false });
    await expect(api.getRelayDraft("relay-draft-01")).rejects.toThrow("Fixture Relay draft not found.");
    await expect(api.getRelay("relay_01000000000000000000000001")).rejects.toThrow("Fixture Relay not found.");
  });

  it("isolates a contract-valid closed handoff for closed-state visual review", async () => {
    const api = createFixtureApi({ relayFixture: "closed" });
    const [homeResult, open, closed] = await Promise.all([
      api.getHome(),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelays({ perspective: "all", states: ["closed"], limit: 25 }),
    ]);

    expect(homeResult.sections.relays).toEqual({ availability: "available", count: 0 });
    expect(open.items).toEqual([]);
    expect(closed.items.map((relay) => relay.ref.id)).toEqual([
      "relay_01000000000000000000000005",
    ]);
    const detail = await api.getRelay(closed.items[0]!.ref.id);
    expect(RelayDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      state: "closed",
      acknowledgedBy: { kind: "member", displayName: "Grace Hopper" },
      closedBy: { kind: "member", displayName: "Ada Lovelace" },
    });
  });

  it("projects a stale configured Member while retaining Team and local-draft reads", async () => {
    const api = createFixtureApi({ relayFixture: "missing" });
    const [actor, homeResult, team, drafts] = await Promise.all([
      api.getCurrentActor(),
      api.getHome(),
      api.getRelays({ perspective: "all", states: ["published", "acknowledged"], limit: 25 }),
      api.getRelayDrafts({ limit: 25 }),
    ]);

    expect(TeamCurrentActorResponseSchema.safeParse(actor).success).toBe(true);
    expect(actor).toMatchObject({
      actor: { kind: "git", name: "Ada", email: "ada@example.test" },
      source: "git-fallback",
      selection: { memberId: "member_01K39WVM6H7JK8M9NPQRSTVVWX" },
      diagnostics: [{
        code: "ACTOR_MEMBER_MISSING",
        severity: "warning",
        message: "The referenced member no longer exists.",
      }],
    });
    expect(homeResult.sections.relays).toEqual({
      availability: "unavailable",
      count: null,
      reason: "Select an active Member to see your open Relay handoffs.",
    });
    expect(team.items).toHaveLength(4);
    expect(drafts.items).toHaveLength(2);
    await expect(api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 25,
    })).rejects.toThrow("Select an active Member to use this Relay perspective.");
  });

  it("projects partial Relay mutation capability without suppressing reads or local drafts", async () => {
    const api = createFixtureApi({ relayFixture: "partial" });
    const [capability, homeResult, drafts, relays] = await Promise.all([
      api.getCapabilities(),
      api.getHome(),
      api.getRelayDrafts({ limit: 25 }),
      api.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
    ]);

    expect(HubCapabilitiesSchema.safeParse(capability).success).toBe(true);
    expect(capability.relays).toEqual({
      read: { availability: "available" },
      draftMutation: { availability: "available" },
      publish: {
        availability: "unavailable",
        reason: "Relay publication is not connected in this Hub process.",
      },
      lifecycleMutation: {
        availability: "unavailable",
        reason: "Relay lifecycle writes are not connected in this Hub process.",
      },
    });
    expect(homeResult.sections.relays).toEqual({ availability: "available", count: 2 });
    expect(drafts.items).toHaveLength(2);
    expect(relays.items).toHaveLength(2);
  });

  it("isolates schema-v1/v2 Relays with their recorded Workstreams and v1 warning", async () => {
    const api = createFixtureApi({ relayFixture: "legacy" });
    const page = await api.getRelays({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 25,
    });

    expect(RelayListResponseSchema.safeParse(page).success).toBe(true);
    expect(page.items.map((relay) => relay.ref.id)).toEqual([
      "relay_01000000000000000000000007",
      "relay_01000000000000000000000006",
    ]);
    expect(page.diagnostics).toEqual([{
      code: "RELAY_LEGACY_PUBLICATION_TIME",
      severity: "warning",
      message: "One or more legacy schema-v1 Relays have no canonical publication timestamp.",
    }]);
    const details = await Promise.all(page.items.map((relay) => api.getRelay(relay.ref.id)));
    expect(details.every((detail) => RelayDetailSchema.safeParse(detail).success)).toBe(true);
    expect(details[0]).toMatchObject({
      schemaVersion: 2,
      workstream: {
        kind: "workstream",
        id: "ws_01K37WVM6H7JK8M9NPQRSTVVW0",
      },
      publishedAt: expect.any(String),
      publishedRepoState: null,
      diagnostics: [],
    });
    expect(details[1]).toMatchObject({
      schemaVersion: 1,
      state: "published",
      sender: { kind: "git", name: "Grace", email: "grace@example.test" },
      publishedAt: null,
      publishedRepoState: null,
      diagnostics: page.diagnostics,
    });
  });

  it.each(["empty", "closed", "missing", "partial", "legacy"] as const)(
    "keeps Knowledge, Inbox, Activity, and Workstreams stable for the %s Relay variant",
    async (relayFixture) => {
      const baseline = createFixtureApi();
      const variant = createFixtureApi({ relayFixture });
      const request = { limit: 25 } as const;
      const [
        baselineKnowledge,
        variantKnowledge,
        baselineInboxDrafts,
        variantInboxDrafts,
        baselineInboxProposals,
        variantInboxProposals,
        baselineActivity,
        variantActivity,
        baselineWorkstreams,
        variantWorkstreams,
      ] = await Promise.all([
        baseline.listWikiEntities(request),
        variant.listWikiEntities(request),
        baseline.getInboxDrafts(request),
        variant.getInboxDrafts(request),
        baseline.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
        variant.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
        baseline.getActivity(request),
        variant.getActivity(request),
        baseline.getWorkstreams(request),
        variant.getWorkstreams(request),
      ]);

      expect(variantKnowledge).toEqual(baselineKnowledge);
      const [baselineKnowledgeNext, variantKnowledgeNext] = await Promise.all([
        baseline.listWikiEntities({
          limit: 25,
          cursor: baselineKnowledge.nextCursor ?? undefined,
        }),
        variant.listWikiEntities({
          limit: 25,
          cursor: variantKnowledge.nextCursor ?? undefined,
        }),
      ]);
      expect(variantKnowledgeNext).toEqual(baselineKnowledgeNext);
      expect([...variantKnowledge.items, ...variantKnowledgeNext.items]).toHaveLength(3);
      expect(variantInboxDrafts).toEqual(baselineInboxDrafts);
      expect(variantInboxProposals).toEqual(baselineInboxProposals);
      expect(variantActivity).toEqual(baselineActivity);
      expect(variantWorkstreams).toEqual(baselineWorkstreams);
    },
  );

  it.each(["empty", "unknown", "partial"] as const)(
    "keeps unrelated fixture routes stable for the %s Inbox variant",
    async (inboxFixture) => {
      const baseline = createFixtureApi();
      const variant = createFixtureApi({ inboxFixture });
      const request = { limit: 25 } as const;
      const [baselineActivity, variantActivity, baselineRelays, variantRelays, baselineWorkstreams, variantWorkstreams] = await Promise.all([
        baseline.getActivity(request),
        variant.getActivity(request),
        baseline.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
        variant.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
        baseline.getWorkstreams(request),
        variant.getWorkstreams(request),
      ]);

      expect(variantActivity).toEqual(baselineActivity);
      expect(variantRelays).toEqual(baselineRelays);
      expect(variantWorkstreams).toEqual(baselineWorkstreams);
    },
  );

  it.each(["empty", "legacy", "partial"] as const)(
    "keeps Knowledge, Inbox, Relay, and Workstreams stable for the %s Activity variant",
    async (activityFixture) => {
      const baseline = createFixtureApi();
      const variant = createFixtureApi({ activityFixture });
      const request = { limit: 25 } as const;
      const [
        baselineKnowledge,
        variantKnowledge,
        baselineInboxDrafts,
        variantInboxDrafts,
        baselineInboxProposals,
        variantInboxProposals,
        baselineRelays,
        variantRelays,
        baselineWorkstreams,
        variantWorkstreams,
      ] = await Promise.all([
        baseline.listWikiEntities(request),
        variant.listWikiEntities(request),
        baseline.getInboxDrafts(request),
        variant.getInboxDrafts(request),
        baseline.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
        variant.getInboxProposals({ states: ["pending", "stale"], limit: 25 }),
        baseline.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
        variant.getRelays({ perspective: "mine", states: ["published", "acknowledged"], limit: 25 }),
        baseline.getWorkstreams(request),
        variant.getWorkstreams(request),
      ]);

      expect(variantKnowledge).toEqual(baselineKnowledge);
      expect(variantInboxDrafts).toEqual(baselineInboxDrafts);
      expect(variantInboxProposals).toEqual(baselineInboxProposals);
      expect(variantRelays).toEqual(baselineRelays);
      expect(variantWorkstreams).toEqual(baselineWorkstreams);
    },
  );
});
