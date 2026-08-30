import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import {
  defineTeamRelayHandoffContract,
  type TeamRelayContractFactory,
  type TeamRelayContractHarness,
  type TeamRelayRecoveryPhase,
  type TeamRelayScenario,
  type TeamRelaySnapshot,
} from "./contracts/team-relay-handoff.contract.js";
import { generateArtifactId } from "../src/team/artifacts/ulid.js";
import {
  ActivityRepository,
} from "../src/team/activity/repository.js";
import {
  RelayRepository,
  WorkstreamRepository,
} from "../src/team/artifacts/workflow-repositories.js";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitPort,
} from "../src/team/contracts/git.js";
import type {
  ActorRef,
  JsonValue,
  RepoState,
  Revision,
  RevisionExpectation,
} from "../src/team/contracts/shared.js";
import type {
  Relay,
  RelayDraftInput,
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayDraftDetail,
  TeamRelayHandoffPort,
  TeamRelayPreviewEnvelope,
} from "../src/team/contracts/workflow.js";
import { MemberRepository } from "../src/team/identity/member-repository.js";
import { createRepositoryGitPort } from "../src/team/git/git-port.js";
import {
  TeamLocalState,
  normalizeTeamWorkflowJournalEffects,
} from "../src/team/local-state/index.js";
import {
  TEAM_RECEIPT_SIGNER_RELATIVE_PATH,
  TeamReceiptSigner,
} from "../src/team/local-state/receipt-signer.js";
import {
  boundedRelayJson,
  normalizeRelayProductDraftInput,
  relaySigningPayload,
} from "../src/team/relay/handoff.js";
import { readRelayCommandFile } from "../src/team/relay/cli/request-file.js";
import { MockWikiPort } from "../src/team/testing/wiki/mock-wiki-port.js";
import type { WikiPort } from "../src/team/contracts/wiki.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  type RepositoryTeamWorkflowPort,
  type TeamWorkflowPhaseBoundary,
} from "../src/team/workflow/repository-team-workflow-port.js";

const NOW = "2026-08-29T06:30:00.000Z";
const LEGACY_DRAFT_UPDATED_AT = "2026-08-28T06:30:00.000Z";
const HEAD = "9".repeat(40);
const SCAFFOLD_ID = "relay_handoff_contract_v1";
const SENDER_ID = id("member", 1);
const RECIPIENT_ID = id("member", 2);
const ALTERNATE_RECIPIENT_ID = id("member", 11);
const MISSING_RECIPIENT_ID = id("member", 12);
const WORKSTREAM_ID = id("ws", 3);
const DRAFT_ID = "relay_contract_draft_1";
const DRAFT_IDS = [
  DRAFT_ID,
  "relay_contract_draft_reminted_2",
  "relay_contract_draft_reminted_3",
] as const;
const RELAY_IDS = [id("relay", 4), id("relay", 5), id("relay", 6)] as const;
const EVENT_IDS = [
  id("event", 7), id("event", 8), id("event", 9), id("event", 10),
] as const;
const SENDER: ActorRef = {
  kind: "member",
  memberId: SENDER_ID,
  displayName: "Ada Lovelace",
};
const RECIPIENT: ActorRef = {
  kind: "member",
  memberId: RECIPIENT_ID,
  displayName: "Grace Hopper",
};
const ALTERNATE_RECIPIENT: ActorRef = {
  kind: "member",
  memberId: ALTERNATE_RECIPIENT_ID,
  displayName: "Margaret Hamilton",
};

const factory: TeamRelayContractFactory = {
  open: (scenario) => RepositoryRelayHarness.open(scenario),
};

defineTeamRelayHandoffContract("repository adapter", factory);

describe("repository adapter Relay clone portability", () => {
  it("publishes, claims, and closes across two real Git clones without synchronizing local state", async () => {
    const clones = await createRelayGitClones();
    const left = await RepositoryRelayHarness.attach(clones.left, "populated");
    const right = await RepositoryRelayHarness.attach(clones.right, "empty");
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      throw new Error("Relay workflow attempted an outbound fetch.");
    });
    try {
      left.setNow("2026-08-29T06:31:00.000Z");
      const draft = left.oracle.populatedDraft;
      if (draft === null) throw new Error("Expected left Relay draft.");
      const publicationRepoState = await left.repositoryState();
      expect(publicationRepoState).toMatchObject({
        branch: "main",
        dirty: false,
        observedAt: "2026-08-29T06:31:00.000Z",
      });
      expect(publicationRepoState.head).toMatch(/^[a-f0-9]{40}$/);
      const publishPreview = await left.port.previewRelay(
        await left.commandFor("relay.publish", draft, "relay_two_clone_publish"),
      );
      expect(publishPreview.receipt.authority.repoState).toEqual(publicationRepoState);
      const published = await left.port.applyRelay(publishPreview);
      const relayId = published.relays[0]?.ref.id;
      if (relayId === undefined) throw new Error("Expected published Relay.");
      expect(published.relays).toEqual([
        expect.objectContaining({
          schemaVersion: 3,
          workstream: null,
          publishedRepoState: publicationRepoState,
        }),
      ]);
      expect(published.events).toEqual([
        expect.objectContaining({
          action: "relay.published",
          repoState: publicationRepoState,
        }),
      ]);
      expect(published.events[0]).not.toHaveProperty("workstream");
      expect(readFileSync(join(left.root, `.mex/relays/${relayId}.md`), "utf8"))
        .not.toContain("\nworkstream:");
      const leftAfterPublish = await left.snapshot();
      const rightBeforeSync = await right.snapshot();
      commitAndPushRelayCanonical(left.root, "Publish Relay");
      pullRelayCanonical(right.root);
      expect(runGit(left.root, ["rev-parse", "HEAD"]).trim())
        .toBe(runGit(right.root, ["rev-parse", "HEAD"]).trim());
      const rightAfterSync = await right.snapshot();
      expect(rightAfterSync.localStateDigest).toBe(rightBeforeSync.localStateDigest);
      expect(rightAfterSync.signerDigest).toBe(rightBeforeSync.signerDigest);

      right.reserveGeneratedIds(0, 1);
      right.setNow("2026-08-29T06:32:00.000Z");
      const recipient = await right.selectActor("recipient");
      const rightRelay = await recipient.getRelay(relayId);
      if (rightRelay === null) throw new Error("Expected synchronized Relay.");
      expect(rightRelay).toMatchObject({
        schemaVersion: 3,
        workstream: null,
        publishedRepoState: publicationRepoState,
      });
      const takeRepoState = await right.repositoryState();
      expect(takeRepoState).toMatchObject({
        branch: "main",
        dirty: false,
        observedAt: "2026-08-29T06:32:00.000Z",
      });
      expect(takeRepoState.head).not.toBe(publicationRepoState.head);
      const takePreview = await recipient.previewRelay(
        await right.commandFor(
          "relay.acknowledge",
          rightRelay,
          "relay_two_clone_acknowledge",
        ),
      );
      expect(takePreview.receipt.authority.repoState).toEqual(takeRepoState);
      const taken = await recipient.applyRelay(takePreview);
      expect(taken.relays).toEqual([
        expect.objectContaining({
          schemaVersion: 3,
          state: "acknowledged",
          workstream: null,
          publishedRepoState: publicationRepoState,
        }),
      ]);
      expect(taken.events).toEqual([
        expect.objectContaining({
          action: "relay.acknowledged",
          repoState: takeRepoState,
        }),
      ]);
      expect(taken.events[0]).not.toHaveProperty("workstream");
      const rightAfterAcknowledge = await right.snapshot();
      commitAndPushRelayCanonical(right.root, "Acknowledge Relay");
      pullRelayCanonical(left.root);
      expect(runGit(left.root, ["rev-parse", "HEAD"]).trim())
        .toBe(runGit(right.root, ["rev-parse", "HEAD"]).trim());
      const leftAfterAcknowledgeSync = await left.snapshot();
      expect(leftAfterAcknowledgeSync.localStateDigest).toBe(leftAfterPublish.localStateDigest);
      expect(leftAfterAcknowledgeSync.signerDigest).toBe(leftAfterPublish.signerDigest);

      left.reserveGeneratedIds(0, 1);
      left.setNow("2026-08-29T06:33:00.000Z");
      const acknowledged = await left.port.getRelay(relayId);
      if (acknowledged === null) throw new Error("Expected acknowledged Relay.");
      expect(acknowledged.publishedRepoState).toEqual(publicationRepoState);
      const closeRepoState = await left.repositoryState();
      expect(closeRepoState).toMatchObject({
        branch: "main",
        dirty: false,
        observedAt: "2026-08-29T06:33:00.000Z",
      });
      expect(closeRepoState.head).not.toBe(takeRepoState.head);
      const closePreview = await left.port.previewRelay(
        await left.commandFor(
          "relay.close",
          acknowledged,
          "relay_two_clone_close",
        ),
      );
      expect(closePreview.receipt.authority.repoState).toEqual(closeRepoState);
      const closed = await left.port.applyRelay(closePreview);
      expect(closed.relays).toEqual([
        expect.objectContaining({
          schemaVersion: 3,
          state: "closed",
          workstream: null,
          publishedRepoState: publicationRepoState,
        }),
      ]);
      expect(closed.events).toEqual([
        expect.objectContaining({
          action: "relay.closed",
          repoState: closeRepoState,
        }),
      ]);
      expect(closed.events[0]).not.toHaveProperty("workstream");
      const leftAfterClose = await left.snapshot();
      commitAndPushRelayCanonical(left.root, "Close Relay");
      pullRelayCanonical(right.root);
      expect(runGit(left.root, ["rev-parse", "HEAD"]).trim())
        .toBe(runGit(right.root, ["rev-parse", "HEAD"]).trim());
      await expect(recipient.getRelay(relayId)).resolves.toMatchObject({
        schemaVersion: 3,
        state: "closed",
        workstream: null,
        publishedRepoState: publicationRepoState,
      });
      const rightAfterCloseSync = await right.snapshot();
      expect(rightAfterCloseSync.localStateDigest)
        .toBe(rightAfterAcknowledge.localStateDigest);
      expect(rightAfterCloseSync.signerDigest).toBe(rightAfterAcknowledge.signerDigest);
      expect(rightAfterCloseSync.canonicalDigest).toBe(leftAfterClose.canonicalDigest);
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(left.wikiAgentLaunches() + right.wikiAgentLaunches()).toBe(0);
    } finally {
      fetchSpy.mockRestore();
      await left.close();
      await right.close();
      clones.close();
    }
  });

  it("publishes a standalone draft without reading the Workstream repository", async () => {
    const harness = await RepositoryRelayHarness.open("populated");
    const workstreamRead = vi.spyOn(WorkstreamRepository.prototype, "get");
    try {
      const draft = harness.oracle.populatedDraft;
      if (draft === null) throw new Error("Expected standalone Relay draft.");
      const command = await harness.commandFor(
        "relay.publish",
        draft,
        "relay_no_workstream_repository_read",
      );
      expect(command.expectedRevisions.map((expectation) =>
        expectation.target.kind === "local"
          ? `local:${expectation.target.id}`
          : `artifact:${expectation.target.path}`)).toEqual([
        `local:${draft.id}`,
        ...draft.recipients.map((recipient) =>
          `artifact:.mex/team/members/${recipient.memberId}.md`),
      ]);
      const preview = await harness.port.previewRelay(command);
      const applied = await harness.port.applyRelay(preview);
      expect(applied.relays).toEqual([
        expect.objectContaining({ schemaVersion: 3, workstream: null }),
      ]);
      expect(workstreamRead).not.toHaveBeenCalled();
    } finally {
      workstreamRead.mockRestore();
      await harness.close();
    }
  });

  it("migrates a full raw legacy CLI draft on its first save without admitting a modern 65-entry preview", async () => {
    const harness = await RepositoryRelayHarness.open("empty");
    try {
      const originalEvidence = Array.from({ length: 64 }, (_, index) => ({
        kind: "manual" as const,
        note: `Legacy CLI evidence ${index}`,
      }));
      const requestPath = join(harness.root, "legacy-relay-request.json");
      writeFileSync(requestPath, JSON.stringify({
        operationId: "relay_raw_legacy_first_save",
        action: {
          kind: "relay.draft.save",
          draft: legacyDraftInput(originalEvidence),
        },
        expectedRevisions: [],
      }));
      const command = readRelayCommandFile(requestPath, "relay.draft.save");
      if (command.action.kind !== "relay.draft.save") {
        throw new Error("Expected Relay draft save command.");
      }
      expect(command.action.draft.evidence).toHaveLength(65);
      expect(command.action.draft).not.toHaveProperty("workstream");

      const plainCommand = JSON.parse(JSON.stringify(command)) as TeamRelayCommand;
      await expect(harness.port.previewRelay(plainCommand))
        .rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

      const preview = await harness.port.previewRelay(command);
      const serializedPreview = JSON.stringify(preview);
      const roundTrippedPreview = JSON.parse(serializedPreview) as TeamRelayPreviewEnvelope;
      expect(roundTrippedPreview.request).toEqual(command);
      if (roundTrippedPreview.request.action.kind !== "relay.draft.save") {
        throw new Error("Expected signed Relay draft save request.");
      }
      expect(roundTrippedPreview.request.action.draft).not.toHaveProperty("workstream");

      const applied = await harness.port.applyRelay(roundTrippedPreview);
      expect(applied.localChanges).toHaveLength(1);
      const draftId = applied.localChanges[0]?.id;
      if (draftId === undefined) throw new Error("Expected saved Relay draft ID.");
      const saved = await harness.port.getRelayDraft(draftId);
      expect(saved?.input.evidence).toEqual(command.action.draft.evidence);
      expect((await harness.inspectStoredDraft(draftId))?.payload)
        .not.toHaveProperty("workstream");
    } finally {
      await harness.close();
    }
  });

  it("reserves the 65th evidence entry for exact stored migration updates", async () => {
    const harness = await RepositoryRelayHarness.open("populated");
    try {
      const current = harness.oracle.populatedDraft;
      if (current === null) throw new Error("Expected Relay draft.");
      const originalEvidence = Array.from({ length: 64 }, (_, index) => ({
        kind: "manual" as const,
        note: `Legacy evidence ${index}`,
      }));
      const forgedOrdinaryEvidence = [
        {
          kind: "entity" as const,
          entity: {
            id: WORKSTREAM_ID,
            kind: "workstream" as const,
            title: "Relay lane",
          },
        },
        ...originalEvidence,
      ];
      await expect(harness.port.previewRelay({
        operationId: "relay_reserved_ordinary_update_forgery",
        action: {
          kind: "relay.draft.save",
          draftId: current.id,
          draft: { ...current.input, evidence: forgedOrdinaryEvidence },
        },
        expectedRevisions: [{
          target: { kind: "local", namespace: "relay-draft", id: current.id },
          revision: current.revision,
        }],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      const local = new TeamLocalState({
        projectRoot: harness.root,
        scaffoldId: SCAFFOLD_ID,
        now: () => NOW,
      });
      const legacy = local.saveLocalDraft({
        id: current.id,
        kind: "relay",
        payload: legacyDraftInput(originalEvidence),
        expectedRevision: current.revision,
        updatedAt: current.updatedAt,
      });
      const projected = await harness.port.getRelayDraft(current.id);
      if (projected === null) throw new Error("Expected translated Relay draft.");
      expect(projected.input.evidence).toHaveLength(65);
      expect(projected.input.evidence[0]).toMatchObject({
        kind: "entity",
        entity: { id: WORKSTREAM_ID, kind: "workstream" },
      });

      await expect(harness.port.previewRelay({
        operationId: "relay_reserved_new_forgery",
        action: { kind: "relay.draft.save", draft: projected.input },
        expectedRevisions: [],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      await expect((harness.port as RepositoryTeamWorkflowPort<JsonValue, unknown>).preview({
        operationId: "relay_reserved_generic_preview_forgery",
        action: { kind: "relay.draft.save", draft: projected.input },
        expectedRevisions: [],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
      const forgedEvidence = [...projected.input.evidence];
      forgedEvidence[0] = {
        kind: "entity",
        entity: { id: id("ws", 13), kind: "workstream", title: "Forged lane" },
      };
      await expect(harness.port.previewRelay({
        operationId: "relay_reserved_update_forgery",
        action: {
          kind: "relay.draft.save",
          draftId: projected.id,
          draft: { ...projected.input, evidence: forgedEvidence },
        },
        expectedRevisions: [{
          target: { kind: "local", namespace: "relay-draft", id: projected.id },
          revision: legacy.revision,
        }],
      })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

      const editedEvidence = [...projected.input.evidence];
      editedEvidence[1] = { kind: "manual", note: "Reviewed replacement" };
      const saved = await harness.port.applyRelay(await harness.port.previewRelay({
        operationId: "relay_reserved_exact_migration",
        action: {
          kind: "relay.draft.save",
          draftId: projected.id,
          draft: {
            ...projected.input,
            summary: "Migrated standalone wording",
            evidence: editedEvidence,
          },
        },
        expectedRevisions: [{
          target: { kind: "local", namespace: "relay-draft", id: projected.id },
          revision: legacy.revision,
        }],
      }));
      expect(saved.localChanges).toHaveLength(1);
      const migrated = await harness.port.getRelayDraft(projected.id);
      if (migrated === null) throw new Error("Expected migrated Relay draft.");
      expect(migrated.input.evidence).toEqual(editedEvidence);
      expect((await harness.inspectStoredDraft(projected.id))?.payload)
        .not.toHaveProperty("workstream");

      const resaved = await harness.port.applyRelay(await harness.port.previewRelay({
        operationId: "relay_reserved_followup_edit",
        action: {
          kind: "relay.draft.save",
          draftId: migrated.id,
          draft: { ...migrated.input, summary: "Migrated wording, refined" },
        },
        expectedRevisions: [{
          target: { kind: "local", namespace: "relay-draft", id: migrated.id },
          revision: migrated.revision,
        }],
      }));
      expect(resaved.localChanges).toHaveLength(1);
      const ready = await harness.port.getRelayDraft(migrated.id);
      if (ready === null) throw new Error("Expected re-saved Relay draft.");
      const published = await harness.port.applyRelay(await harness.port.previewRelay(
        await harness.commandFor("relay.publish", ready, "relay_reserved_publish"),
      ));
      expect(published.relays).toEqual([
        expect.objectContaining({
          schemaVersion: 3,
          workstream: null,
          evidence: editedEvidence,
        }),
      ]);
      expect(published.events).toEqual([
        expect.objectContaining({ action: "relay.published" }),
      ]);
      expect(published.events[0]).not.toHaveProperty("workstream");
    } finally {
      await harness.close();
    }
  });
});

class RepositoryRelayHarness implements TeamRelayContractHarness {
  readonly root: string;
  readonly scenario: TeamRelayScenario;
  readonly oracle: TeamRelayContractHarness["oracle"];
  readonly port: TeamRelayHandoffPort;
  #activeIdentity: "sender" | "recipient" | "alternate-recipient" | "none";
  #eventOffset = 0;
  #relayOffset = 0;
  #draftOffset = 0;
  #crashBoundary: TeamWorkflowPhaseBoundary | null = null;
  #now = NOW;
  #repoState = repoState();
  #outsideRoots: string[] = [];
  #livePids = new Set<number>();
  #competingLeaseToken: string | null = null;
  #beforeCanonicalMutation: (() => Promise<void>) | null = null;
  #wikiPorts: MockWikiPort[] = [];

  private constructor(
    root: string,
    scenario: TeamRelayScenario,
    actor: "sender" | "recipient" | "alternate-recipient" | "none",
    populatedDraft: TeamRelayDraftDetail | null,
    populatedRelay: TeamRelayDetail | null,
  ) {
    this.root = root;
    this.scenario = scenario;
    this.#activeIdentity = actor;
    this.port = this.#makePort(actor);
    this.oracle = {
      now: NOW,
      actor: actor === "recipient"
        ? RECIPIENT
        : actor === "alternate-recipient"
          ? ALTERNATE_RECIPIENT
          : actor === "sender"
            ? SENDER
            : { kind: "git", name: "Unmatched", email: "unmatched@example.test" },
      sender: SENDER,
      recipient: RECIPIENT,
      alternateRecipient: ALTERNATE_RECIPIENT,
      repoState: repoState(),
      populatedDraft,
      populatedRelay,
    };
  }

  static async open(scenario: TeamRelayScenario): Promise<RepositoryRelayHarness> {
    const root = mkdtempSync(join(tmpdir(), "mex-team-relay-contract-"));
    await seedMembers(root);
    if (scenario === "legacy-v1" || scenario === "legacy-v2" || scenario === "query") {
      await seedLegacyWorkstream(root);
    }
    return this.attach(root, scenario);
  }

  static async attach(
    root: string,
    scenario: TeamRelayScenario,
  ): Promise<RepositoryRelayHarness> {
    const actor = scenario === "no-current-member" ? "none" : "sender";
    let populatedDraft: TeamRelayDraftDetail | null = null;
    let populatedRelay: TeamRelayDetail | null = null;
    if (scenario === "populated" || scenario === "legacy-local-draft") {
      new TeamLocalState({ projectRoot: root, scaffoldId: SCAFFOLD_ID, now: () => NOW })
        .saveLocalDraft({
          id: DRAFT_ID,
          kind: "relay",
          payload: scenario === "legacy-local-draft"
            ? legacyDraftInput()
            : draftInput(),
          expectedRevision: null,
          updatedAt: scenario === "legacy-local-draft"
            ? LEGACY_DRAFT_UPDATED_AT
            : NOW,
        });
    }
    if (scenario === "legacy-v1") {
      const repository = new RelayRepository(root);
      const plan = await repository.previewCreate({
        id: RELAY_IDS[2],
        sender: {
          kind: "git",
          name: "Legacy Sender",
          email: "legacy@example.test",
        },
        recipients: [RECIPIENT],
        workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Relay lane" },
        summary: "Legacy handoff",
        completed: ["Historical work"],
        inProgress: [],
        decisions: [],
        blockers: [],
        unresolvedQuestions: [],
        changedFiles: [],
        code: [],
        evidence: [],
        nextActions: ["Review legacy context"],
      });
      const created = (await repository.apply(plan, plan.previewRevision)).artifact;
      if (created.schemaVersion !== 1) throw new Error("Expected schema-v1 legacy Relay fixture.");
      const acknowledged = await repository.previewUpdate(created.ref.id, {
        schemaVersion: created.schemaVersion,
        state: "acknowledged",
        sender: created.sender,
        recipients: created.recipients,
        workstream: created.workstream,
        summary: created.summary,
        completed: created.completed,
        inProgress: created.inProgress,
        decisions: created.decisions,
        blockers: created.blockers,
        unresolvedQuestions: created.unresolvedQuestions,
        changedFiles: created.changedFiles,
        code: created.code,
        evidence: created.evidence,
        nextActions: created.nextActions,
        acknowledgedBy: RECIPIENT,
        acknowledgedAt: NOW,
      }, created.revision);
      await repository.apply(acknowledged, acknowledged.previewRevision);
    }
    if (scenario === "legacy-v2") {
      const repository = new RelayRepository(root);
      const plan = await repository.previewCreate({
        id: RELAY_IDS[2],
        sender: SENDER,
        recipients: [RECIPIENT],
        workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Relay lane" },
        summary: "Timestamped legacy handoff",
        completed: ["Historical work"],
        inProgress: [],
        decisions: [],
        blockers: [],
        unresolvedQuestions: [],
        changedFiles: [],
        code: [],
        evidence: [],
        nextActions: ["Review legacy context"],
        publishedAt: NOW,
      });
      await repository.apply(plan, plan.previewRevision);
    }
    if (scenario === "query") {
      await seedQueryRelays(root);
    }
    const harness = new RepositoryRelayHarness(
      root,
      scenario,
      actor,
      null,
      null,
    );
    populatedDraft = scenario === "populated" || scenario === "legacy-local-draft"
      ? await harness.port.getRelayDraft(DRAFT_ID)
      : null;
    populatedRelay = scenario === "legacy-v1" || scenario === "legacy-v2"
      ? await harness.port.getRelay(RELAY_IDS[2])
      : null;
    (harness.oracle as { populatedDraft: TeamRelayDraftDetail | null }).populatedDraft = populatedDraft;
    (harness.oracle as { populatedRelay: TeamRelayDetail | null }).populatedRelay = populatedRelay;
    return harness;
  }

  async makeDraftCommand(operationId: string): Promise<TeamRelayCommand> {
    return {
      operationId,
      action: { kind: "relay.draft.save", draft: draftInput() },
      expectedRevisions: [],
    };
  }

  async preparePreV3PublishEnvelope(
    operationId: string,
    journalIntent: boolean,
  ): Promise<TeamRelayPreviewEnvelope> {
    if (await new WorkstreamRepository(this.root).get(WORKSTREAM_ID) === null) {
      await seedLegacyWorkstream(this.root);
    }
    const local = new TeamLocalState({
      projectRoot: this.root,
      scaffoldId: SCAFFOLD_ID,
      now: () => this.#now,
      processStatus: (pid) => this.#livePids.has(pid) ? "alive" : "dead",
    });
    const current = local.getLocalDraft(DRAFT_ID);
    if (current === null || current.kind !== "relay") {
      throw new Error("Expected Relay draft for pre-v3 preview fixture.");
    }
    const legacyDraft = local.saveLocalDraft({
      id: DRAFT_ID,
      kind: "relay",
      payload: legacyDraftInput(),
      expectedRevision: current.revision,
      updatedAt: current.updatedAt,
    });
    const workstream = await new WorkstreamRepository(this.root).get(WORKSTREAM_ID);
    if (workstream === null) throw new Error("Expected legacy Workstream fixture.");
    const members = new MemberRepository(this.root);
    const recipients = await Promise.all(
      draftInput().recipients.map(async (recipient) => {
        if (recipient.kind !== "member") throw new Error("Expected Member recipient.");
        const member = await members.get(recipient.memberId);
        if (member === null) throw new Error("Expected recipient fixture.");
        return member;
      }),
    );
    const request: TeamRelayCommand = {
      operationId,
      action: { kind: "relay.publish", draftId: DRAFT_ID },
      expectedRevisions: [
        {
          target: {
            kind: "local",
            namespace: "relay-draft",
            id: DRAFT_ID,
          },
          revision: legacyDraft.revision,
        },
        artifactExpectation(workstream.sourcePath, workstream.revision),
        ...recipients.map((member) =>
          artifactExpectation(member.sourcePath, member.revision)),
      ],
    };
    const authority = {
      actor: SENDER,
      occurredAt: this.#now,
      repoState: structuredClone(this.#repoState),
    };
    const relayId = RELAY_IDS[this.#relayOffset++] ?? failId("relay");
    const eventId = EVENT_IDS[this.#eventOffset++] ?? failId("event");
    const content = draftInput();
    const relayPlan = await new RelayRepository(this.root).previewCreate({
      id: relayId,
      schemaVersion: 2,
      sender: SENDER,
      recipients: recipients.map((member) => ({
        kind: "member" as const,
        memberId: member.ref.id,
        displayName: member.displayName,
      })),
      workstream: workstream.ref,
      summary: content.summary,
      completed: content.completed,
      inProgress: content.inProgress,
      decisions: content.decisions,
      blockers: content.blockers,
      unresolvedQuestions: content.unresolvedQuestions,
      changedFiles: content.changedFiles,
      code: content.code,
      evidence: content.evidence,
      nextActions: content.nextActions,
      publishedAt: authority.occurredAt,
    });
    const activity = await new ActivityRepository({
      projectRoot: this.root,
      git: fakeGit(
        { name: "Ada Lovelace", email: "ada@example.test" },
        () => this.#repoState,
      ),
      now: () => new Date(this.#now),
      generateId: () => eventId,
    }).previewCreateWithAuthority({
      actor: SENDER,
      action: "relay.published",
      subjects: [{ kind: "entity", entity: relayPlan.artifact.ref }],
      workstream: workstream.ref,
    }, {
      timestamp: authority.occurredAt,
      repoState: authority.repoState,
    }, eventId);
    const preview = {
      valid: true,
      scope: "mixed" as const,
      changes: [relayPlan.change, ...activity.changes],
      localChanges: [{
        namespace: "relay-draft" as const,
        id: DRAFT_ID,
        beforeRevision: legacyDraft.revision,
        afterRevision: null,
        summary: "Publish local draft",
      }],
      diagnostics: [],
    };
    const receiptBase = {
      schemaVersion: 1 as const,
      authority,
      purposeIds: [
        { purpose: "activity" as const, id: eventId },
        { purpose: "relay" as const, id: relayId },
      ],
      requestRevision: relayHash(request),
      presentationRevision: relayHash(preview),
    };
    const signer = new TeamReceiptSigner(this.root, SCAFFOLD_ID);
    signer.initialize();
    const envelope: TeamRelayPreviewEnvelope = {
      schemaVersion: 1,
      request,
      preview,
      receipt: {
        ...receiptBase,
        previewRevision: signer.sign(relaySigningPayload(receiptBase)),
      },
    };
    if (journalIntent) {
      const effects = normalizeTeamWorkflowJournalEffects([
        {
          kind: "canonical",
          namespace: "relay",
          id: relayId,
          path: relayPlan.change.path,
          beforeRevision: relayPlan.change.beforeRevision,
          afterRevision: relayPlan.change.afterRevision,
        },
        {
          kind: "activity",
          id: activity.event.id,
          path: activity.sourcePath,
          revision: activity.revision,
          action: activity.event.action,
          actor: activity.event.actor,
          occurredAt: activity.event.timestamp,
          repoState: activity.event.repoState,
          subjects: activity.event.subjects,
          workstream: activity.event.workstream,
        },
        {
          kind: "local_cleanup",
          draftKind: "relay",
          draftId: DRAFT_ID,
          expectedRevision: legacyDraft.revision,
        },
        {
          kind: "identity_activity_receipt",
          envelopeRevision: relayHash(envelope),
        },
      ]);
      const token = "c".repeat(64);
      local.acquireTeamWorkflowLease({
        pid: 9_002,
        token,
        acquiredAt: this.#now,
      });
      local.beginWorkflowOperation({
        leaseToken: token,
        operationId,
        commandRevision: stableHash({ ...request, authority }),
        previewRevision: envelope.receipt.previewRevision,
        effects,
      });
    }
    return envelope;
  }

  async commandFor(
    kind: "relay.publish" | "relay.acknowledge" | "relay.close",
    target: TeamRelayDraftDetail | TeamRelayDetail,
    operationId: string,
  ): Promise<TeamRelayCommand> {
    if (kind !== "relay.publish") {
      const relay = target as TeamRelayDetail;
      return {
        operationId,
        action: { kind, relayId: relay.ref.id },
        expectedRevisions: [artifactExpectation(relay.sourcePath, relay.revision)],
      };
    }
    const draft = target as TeamRelayDraftDetail;
    const members = new MemberRepository(this.root);
    const recipients = await Promise.all(draft.input.recipients.map(async (recipient) =>
      recipient.kind === "member" ? members.get(recipient.memberId) : null));
    return {
      operationId,
      action: { kind, draftId: draft.id },
      expectedRevisions: [
        {
          target: { kind: "local", namespace: "relay-draft", id: draft.id },
          revision: draft.revision,
        },
        ...recipients.flatMap((recipient) => recipient === null
          ? []
          : [artifactExpectation(recipient.sourcePath, recipient.revision)]),
      ],
    };
  }

  async selectActor(
    actor: "sender" | "recipient" | "alternate-recipient" | "none",
  ): Promise<TeamRelayHandoffPort> {
    this.#activeIdentity = actor;
    return this.#makePort(actor);
  }

  async restart(): Promise<TeamRelayHandoffPort> {
    return this.#makePort(this.#activeIdentity);
  }

  async removeSigner(): Promise<void> {
    const path = join(this.root, TEAM_RECEIPT_SIGNER_RELATIVE_PATH);
    if (existsSync(path)) unlinkSync(path);
  }

  async armCrash(phase: TeamRelayRecoveryPhase): Promise<void> {
    this.#crashBoundary = phase.includes("after-relay")
      ? "after-canonical-publication"
      : phase.includes("after-activity")
        ? "after-activity-publication"
        : "after-local-cleanup";
  }

  async armBeforeCanonicalCrash(): Promise<void> {
    this.#crashBoundary = "before-canonical-publication";
  }

  async armBeforeCanonicalRecipientDeactivation(): Promise<void> {
    this.#beforeCanonicalMutation = async () => {
      await this.setMemberActive("recipient", false);
    };
  }

  setNow(now: string): void {
    this.#now = now;
  }

  setRepositoryState(state: RepoState): void {
    this.#repoState = structuredClone(state);
  }

  mutateRepositoryAuthority(): void {
    this.#repoState = {
      ...this.#repoState,
      head: "8".repeat(40),
      observedAt: this.#now,
    };
  }

  async mutateDraftToMissingRecipient(draftId: string): Promise<void> {
    const local = new TeamLocalState({
      projectRoot: this.root,
      scaffoldId: SCAFFOLD_ID,
      now: () => this.#now,
    });
    const current = local.getLocalDraft(draftId);
    if (current === null || current.kind !== "relay") {
      throw new Error(`Relay draft ${draftId} is missing.`);
    }
    const payload = normalizeRelayProductDraftInput(current.payload);
    if (RECIPIENT.kind !== "member") {
      throw new Error("Relay recipient fixture is not a Member.");
    }
    local.saveLocalDraft({
      id: draftId,
      kind: "relay",
      payload: {
        ...payload,
        recipients: [{
          ...RECIPIENT,
          memberId: MISSING_RECIPIENT_ID,
        }],
      },
      expectedRevision: current.revision,
      updatedAt: this.#now,
    });
  }

  async deleteMember(
    member: "sender" | "recipient" | "alternate-recipient",
  ): Promise<void> {
    const memberId = member === "sender"
      ? SENDER_ID
      : member === "recipient"
        ? RECIPIENT_ID
        : ALTERNATE_RECIPIENT_ID;
    const current = await new MemberRepository(this.root).get(memberId);
    if (current === null) throw new Error(`Member ${memberId} is missing.`);
    unlinkSync(join(this.root, current.sourcePath));
  }

  async setMemberActive(
    member: "sender" | "recipient" | "alternate-recipient",
    active: boolean,
  ): Promise<void> {
    const memberId = member === "sender"
      ? SENDER_ID
      : member === "recipient"
        ? RECIPIENT_ID
        : ALTERNATE_RECIPIENT_ID;
    const repository = new MemberRepository(this.root);
    const current = await repository.get(memberId);
    if (current === null) throw new Error(`Member ${memberId} is missing.`);
    await repository.update(memberId, { active }, current.revision);
  }

  async renameMember(
    member: "sender" | "recipient" | "alternate-recipient",
    displayName: string,
  ): Promise<void> {
    const memberId = member === "sender"
      ? SENDER_ID
      : member === "recipient"
        ? RECIPIENT_ID
        : ALTERNATE_RECIPIENT_ID;
    const repository = new MemberRepository(this.root);
    const current = await repository.get(memberId);
    if (current === null) throw new Error(`Member ${memberId} is missing.`);
    await repository.update(memberId, { displayName }, current.revision);
  }

  async holdCompetingWorkflowLease(): Promise<void> {
    if (this.#competingLeaseToken !== null) {
      throw new Error("A competing Relay workflow lease is already held.");
    }
    const pid = 9_001;
    const token = "b".repeat(64);
    this.#livePids.add(pid);
    new TeamLocalState({
      projectRoot: this.root,
      scaffoldId: SCAFFOLD_ID,
      now: () => this.#now,
      processStatus: (candidate) => this.#livePids.has(candidate) ? "alive" : "dead",
    }).acquireTeamWorkflowLease({ pid, token, acquiredAt: this.#now });
    this.#competingLeaseToken = token;
  }

  async releaseCompetingWorkflowLease(): Promise<void> {
    const token = this.#competingLeaseToken;
    if (token === null) throw new Error("No competing Relay workflow lease is held.");
    new TeamLocalState({
      projectRoot: this.root,
      scaffoldId: SCAFFOLD_ID,
      now: () => this.#now,
      processStatus: (candidate) => this.#livePids.has(candidate) ? "alive" : "dead",
    }).releaseTeamWorkflowLease(token);
    this.#competingLeaseToken = null;
    this.#livePids.delete(9_001);
  }

  async installEscapingAncestor(
    target: "local" | "relay" | "activity",
  ): Promise<void> {
    const relativeTarget = target === "local"
      ? ".mex/local"
      : target === "relay"
        ? ".mex/relays"
        : ".mex/events/activity";
    const absoluteTarget = join(this.root, relativeTarget);
    const outside = mkdtempSync(join(tmpdir(), `mex-relay-${target}-outside-`));
    const escaped = join(outside, "escaped");
    mkdirSync(dirname(absoluteTarget), { recursive: true });
    if (existsSync(absoluteTarget)) {
      renameSync(absoluteTarget, escaped);
    } else {
      mkdirSync(escaped, { recursive: true });
    }
    symlinkSync(escaped, absoluteTarget, "dir");
    this.#outsideRoots.push(outside);
  }

  async swapProjectRoot(): Promise<void> {
    const moved = `${this.root}-swapped`;
    renameSync(this.root, moved);
    mkdirSync(this.root, { recursive: true });
    this.#outsideRoots.push(moved);
  }

  async inspectJournalRows(): Promise<readonly string[]> {
    const database = new DatabaseSync(join(this.root, ".mex/local/team.db"), {
      readOnly: true,
    });
    try {
      return (database.prepare(`
        SELECT operation_id, command_revision, preview_revision, phase,
               effects_json, created_at, updated_at, revision
        FROM team_workflow_operations
        ORDER BY operation_id
      `).all() as Record<string, unknown>[]).map((row) => JSON.stringify(row));
    } finally {
      database.close();
    }
  }

  async inspectStoredDraft(id: string): Promise<{
    payload: unknown;
    revision: Revision;
    updatedAt: string;
  } | null> {
    const stored = new TeamLocalState({
      projectRoot: this.root,
      scaffoldId: SCAFFOLD_ID,
      now: () => this.#now,
    }).getLocalDraft(id);
    return stored === null
      ? null
      : {
          payload: stored.payload,
          revision: stored.revision,
          updatedAt: stored.updatedAt,
        };
  }

  reserveGeneratedIds(relays: number, events: number): void {
    this.#relayOffset += relays;
    this.#eventOffset += events;
  }

  async snapshot(): Promise<TeamRelaySnapshot> {
    const gitHead = existsSync(join(this.root, ".git"))
      ? (await createRepositoryGitPort(this.root, {
          now: () => new Date(this.#now),
        }).getRepoState()).head
      : this.#repoState.head;
    return {
      canonicalDigest: digestTree(this.root, (path) =>
        path.startsWith(".mex/") && !path.startsWith(".mex/local/")),
      localStateDigest: digestFile(join(this.root, ".mex/local/team.db")),
      signerDigest: digestFile(join(this.root, TEAM_RECEIPT_SIGNER_RELATIVE_PATH)),
      gitHead,
      relayIds: fileIds(join(this.root, ".mex/relays")),
      draftIds: localDraftIds(this.root),
      activityIds: activityIds(this.root),
      outsideDigest: digestOutside(this.#outsideRoots),
      outboundRequests: 0,
      modelInvocations: 0,
    };
  }

  async close(): Promise<void> {
    rmSync(this.root, { recursive: true, force: true });
    for (const outside of this.#outsideRoots) {
      rmSync(outside, { recursive: true, force: true });
    }
  }

  async repositoryState(): Promise<RepoState> {
    return existsSync(join(this.root, ".git"))
      ? createRepositoryGitPort(this.root, {
          now: () => new Date(this.#now),
        }).getRepoState()
      : structuredClone(this.#repoState);
  }

  wikiAgentLaunches(): number {
    return this.#wikiPorts.reduce(
      (total, wiki) => total + wiki.snapshot().effects.agentLaunches,
      0,
    );
  }

  #makePort(
    actor: "sender" | "recipient" | "alternate-recipient" | "none",
  ): RepositoryTeamWorkflowPort<JsonValue, unknown> {
    const identity = actor === "sender"
      ? { name: "Ada Lovelace", email: "ada@example.test" }
      : actor === "recipient"
        ? { name: "Grace Hopper", email: "grace@example.test" }
        : actor === "alternate-recipient"
          ? { name: "Margaret Hamilton", email: "margaret@example.test" }
        : { name: "Unmatched", email: "unmatched@example.test" };
    const wiki = new MockWikiPort({ now: () => this.#now });
    this.#wikiPorts.push(wiki);
    const git = existsSync(join(this.root, ".git"))
      ? withGitIdentity(
          createRepositoryGitPort(this.root, {
            now: () => new Date(this.#now),
          }),
          identity,
        )
      : fakeGit(identity, () => this.#repoState);
    return createRepositoryTeamWorkflowPortWithDependencies(this.root, {
      scaffoldId: SCAFFOLD_ID,
      wiki: wiki as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
      git,
      now: () => new Date(this.#now),
      pid: 700 + this.#eventOffset,
      processStatus: (pid) => this.#livePids.has(pid) ? "alive" : "dead",
      phaseHook: async (boundary) => {
        if (
          boundary === "before-canonical-publication"
          && this.#beforeCanonicalMutation !== null
        ) {
          const mutation = this.#beforeCanonicalMutation;
          this.#beforeCanonicalMutation = null;
          await mutation();
        }
        if (boundary !== this.#crashBoundary) return;
        this.#crashBoundary = null;
        throw new Error(`relay-contract-crash:${boundary}`);
      },
      idFactories: {
        relay: () => RELAY_IDS[this.#relayOffset++] ?? failId("relay"),
        activity: () => EVENT_IDS[this.#eventOffset++] ?? failId("event"),
        localDraft: () => DRAFT_IDS[this.#draftOffset++] ?? "relay_contract_draft_exhausted",
        leaseToken: () => "a".repeat(64),
      },
    });
  }
}

async function seedMembers(root: string): Promise<void> {
  const members = new MemberRepository(root);
  await members.create({
    id: SENDER_ID,
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada Lovelace", email: "ada@example.test" }],
    active: true,
  });
  await members.create({
    id: ALTERNATE_RECIPIENT_ID,
    displayName: "Margaret Hamilton",
    gitAliases: [{ name: "Margaret Hamilton", email: "margaret@example.test" }],
    active: true,
  });
  await members.create({
    id: RECIPIENT_ID,
    displayName: "Grace Hopper",
    gitAliases: [{ name: "Grace Hopper", email: "grace@example.test" }],
    active: true,
  });
}

async function seedLegacyWorkstream(root: string): Promise<void> {
  const workstreams = new WorkstreamRepository(root);
  const plan = await workstreams.previewCreate({
    id: WORKSTREAM_ID,
    title: "Relay lane",
    goal: "Transfer exact repository context.",
    summary: "Team handoff fixture.",
    owners: [SENDER],
    contributors: [RECIPIENT],
    paths: ["src/team"],
    code: [],
    topics: [],
    components: [],
    related: [],
    blockers: [],
    currentState: "Planned",
    nextMilestone: "Claim the handoff",
    createdBy: SENDER,
    createdAt: NOW,
    updatedBy: SENDER,
    updatedAt: NOW,
  });
  await workstreams.apply(plan, plan.previewRevision);
}

async function seedQueryRelays(root: string): Promise<void> {
  const repository = new RelayRepository(root);
  const first = await repository.previewCreate({
    ...standaloneRelaySeedInput(
      SENDER,
      [RECIPIENT],
      "2026-08-29T06:10:00.000Z",
    ),
    id: RELAY_IDS[0],
    summary: "Published to recipient",
  });
  await repository.apply(first, first.previewRevision);
  const second = await repository.previewCreate({
    ...standaloneRelaySeedInput(
      RECIPIENT,
      [SENDER],
      "2026-08-29T06:20:00.000Z",
    ),
    id: RELAY_IDS[1],
    summary: "Claimed by sender",
  });
  const secondArtifact = (await repository.apply(second, second.previewRevision)).artifact;
  const acknowledge = await repository.previewUpdate(secondArtifact.ref.id, {
    ...relayStoredInput(secondArtifact),
    state: "acknowledged",
    acknowledgedBy: SENDER,
    acknowledgedAt: "2026-08-29T06:21:00.000Z",
  }, secondArtifact.revision);
  await repository.apply(acknowledge, acknowledge.previewRevision);
  const legacy = await repository.previewCreate({
    ...legacyRelaySeedInput(SENDER, [SENDER]),
    id: RELAY_IDS[2],
    summary: "Legacy self handoff",
  });
  await repository.apply(legacy, legacy.previewRevision);
}

function standaloneRelaySeedInput(
  sender: ActorRef,
  recipients: readonly ActorRef[],
  publishedAt: string,
) {
  return {
    schemaVersion: 3 as const,
    sender,
    recipients,
    publishedAt,
    publishedRepoState: {
      branch: "codex/team-relay-handoffs",
      head: HEAD,
      dirty: false,
      observedAt: publishedAt,
    },
    summary: "Relay query fixture",
    completed: ["Seeded"],
    inProgress: [],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: [],
    code: [],
    evidence: [],
    nextActions: ["Inspect"],
  };
}

function legacyRelaySeedInput(sender: ActorRef, recipients: readonly ActorRef[]) {
  const {
    schemaVersion: _schemaVersion,
    publishedAt: _publishedAt,
    publishedRepoState: _publishedRepoState,
    ...content
  } = standaloneRelaySeedInput(sender, recipients, NOW);
  return {
    ...content,
    schemaVersion: 1 as const,
    workstream: { id: WORKSTREAM_ID, kind: "workstream" as const, title: "Relay lane" },
  };
}

function relayStoredInput(relay: Relay) {
  const content = {
    sender: relay.sender,
    recipients: relay.recipients,
    summary: relay.summary,
    completed: relay.completed,
    inProgress: relay.inProgress,
    decisions: relay.decisions,
    blockers: relay.blockers,
    unresolvedQuestions: relay.unresolvedQuestions,
    changedFiles: relay.changedFiles,
    code: relay.code,
    evidence: relay.evidence,
    nextActions: relay.nextActions,
  };
  if (relay.schemaVersion === 3) {
    return {
      ...content,
      schemaVersion: 3 as const,
      publishedAt: relay.publishedAt,
      publishedRepoState: relay.publishedRepoState,
    };
  }
  return {
    ...content,
    schemaVersion: relay.schemaVersion,
    workstream: relay.workstream,
    ...(relay.publishedAt === undefined ? {} : { publishedAt: relay.publishedAt }),
  };
}

function draftInput(): RelayDraftInput {
  return normalizeRelayProductDraftInput({
    recipients: [RECIPIENT, ALTERNATE_RECIPIENT],
    summary: "Transfer Relay implementation context",
    completed: ["Core contract locked"],
    inProgress: ["Repository facade"],
    decisions: [],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["src/team/contracts/workflow.ts"],
    code: [{ kind: "file", path: "src/team/relay/handoff.ts" }],
    evidence: [{ kind: "manual", note: "Consumer contract fixture" }],
    nextActions: ["Acknowledge ownership"],
  });
}

function legacyDraftInput(
  evidence: RelayDraftInput["evidence"] = draftInput().evidence,
) {
  return {
    ...draftInput(),
    evidence,
    workstream: {
      id: WORKSTREAM_ID,
      kind: "workstream" as const,
      title: "Relay lane",
    },
  };
}

interface FakeGit extends GitPort {}

function withGitIdentity(
  git: GitPort,
  identity: { name: string; email: string },
): GitPort {
  return {
    getRepoState: () => git.getRepoState(),
    getIdentity: async () => identity,
    getWorkingTree: (page) => git.getWorkingTree(page),
    resolveRevision: (ref) => git.resolveRevision(ref),
    getDiff: (request) => git.getDiff(request),
    getHistory: (request) => git.getHistory(request),
    readFileAtRevision: (request) => git.readFileAtRevision(request),
    getChangedFiles: (request) => git.getChangedFiles(request),
  };
}

function fakeGit(
  identity: { name: string; email: string },
  currentRepoState: () => RepoState,
): FakeGit {
  return {
    async getRepoState() { return currentRepoState(); },
    async getIdentity() { return identity; },
    async getWorkingTree() { return { items: [], nextCursor: null, truncated: false }; },
    async resolveRevision(ref: string) { return ref; },
    async getDiff(request: GitDiffRequest) {
      return { target: request.target, diff: "", bytes: 0, truncated: false };
    },
    async getHistory(_request?: GitHistoryRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
    async readFileAtRevision(_request: GitFileAtRevisionRequest) { return null; },
    async getChangedFiles(_request: GitChangedFilesRequest) {
      return { items: [], nextCursor: null, truncated: false };
    },
  };
}

function repoState(): RepoState {
  return {
    branch: "codex/team-relay-handoffs",
    head: HEAD,
    dirty: false,
    observedAt: NOW,
  };
}

function relayHash(value: unknown): Revision {
  return createHash("sha256").update(boundedRelayJson(value)).digest("hex") as Revision;
}

function stableHash(value: unknown): Revision {
  return createHash("sha256").update(JSON.stringify(sortJson(value))).digest("hex") as Revision;
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function artifactExpectation(path: string, revision: Revision): RevisionExpectation {
  return { target: { kind: "artifact", path }, revision };
}

function localDraftIds(root: string): readonly string[] {
  if (!existsSync(join(root, ".mex/local/team.db"))) return [];
  try {
    return new TeamLocalState({ projectRoot: root, scaffoldId: SCAFFOLD_ID, now: () => NOW })
      .listLocalDrafts({ kind: "relay", limit: 100 }).items.map((item) => item.id);
  } catch {
    return [];
  }
}

function activityIds(root: string): readonly string[] {
  const base = join(root, ".mex/events/activity");
  if (!existsSync(base)) return [];
  return walkFiles(base)
    .filter((path) => path.endsWith(".md"))
    .map((path) => path.slice(path.lastIndexOf("/") + 1, -3))
    .sort();
}

function fileIds(directory: string): readonly string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory)
    .filter((name) => name.endsWith(".md"))
    .map((name) => name.slice(0, -3))
    .sort();
}

function digestFile(path: string): Revision | null {
  return existsSync(path)
    ? createHash("sha256").update(readFileSync(path)).digest("hex") as Revision
    : null;
}

function digestTree(root: string, include: (path: string) => boolean): Revision {
  const hash = createHash("sha256");
  for (const absolute of walkFiles(root)) {
    const path = relative(root, absolute).replaceAll("\\", "/");
    if (!include(path)) continue;
    hash.update(path).update("\0").update(readFileSync(absolute)).update("\0");
  }
  return hash.digest("hex") as Revision;
}

function digestOutside(roots: readonly string[]): Revision {
  const hash = createHash("sha256");
  for (const root of [...roots].sort()) {
    for (const absolute of walkFiles(root)) {
      const path = relative(root, absolute).replaceAll("\\", "/");
      hash.update(path).update("\0").update(readFileSync(absolute)).update("\0");
    }
  }
  return hash.digest("hex") as Revision;
}

async function createRelayGitClones(): Promise<{
  left: string;
  right: string;
  close(): void;
}> {
  const fixture = mkdtempSync(join(tmpdir(), "mex-relay-git-clones-"));
  const seed = join(fixture, "seed");
  const origin = join(fixture, "origin.git");
  const left = join(fixture, "left");
  const right = join(fixture, "right");
  mkdirSync(seed, { recursive: true });
  await seedMembers(seed);
  writeFileSync(join(seed, ".gitignore"), ".mex/local/\n");
  runGit(seed, ["init", "--initial-branch=main"]);
  configureGitIdentity(seed);
  runGit(seed, ["add", ".gitignore", ".mex/team/members"]);
  runGit(seed, ["commit", "-m", "Seed Relay team memory"]);
  runGit(fixture, ["init", "--bare", origin]);
  runGit(seed, ["remote", "add", "origin", origin]);
  runGit(seed, ["push", "--set-upstream", "origin", "main"]);
  runGit(fixture, ["clone", "--branch", "main", origin, left]);
  runGit(fixture, ["clone", "--branch", "main", origin, right]);
  configureGitIdentity(left);
  configureGitIdentity(right);
  return {
    left,
    right,
    close: () => rmSync(fixture, { recursive: true, force: true }),
  };
}

function commitAndPushRelayCanonical(root: string, message: string): void {
  runGit(root, ["add", ".mex/relays", ".mex/events/activity"]);
  runGit(root, ["commit", "-m", message]);
  runGit(root, ["push", "origin", "main"]);
}

function pullRelayCanonical(root: string): void {
  runGit(root, ["pull", "--ff-only", "origin", "main"]);
}

function configureGitIdentity(root: string): void {
  runGit(root, ["config", "user.name", "Relay Contract"]);
  runGit(root, ["config", "user.email", "relay-contract@example.test"]);
}

function runGit(root: string, args: readonly string[]): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function walkFiles(root: string): readonly string[] {
  if (!existsSync(root)) return [];
  const result: string[] = [];
  const visit = (directory: string) => {
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory()) visit(path);
      else if (stat.isFile()) result.push(path);
    }
  };
  visit(root);
  return result;
}

function id(prefix: "member" | "ws" | "relay" | "event", entropy: number): string {
  return generateArtifactId(prefix, {
    now: Date.parse(NOW),
    random: new Uint8Array(10).fill(entropy),
  });
}

function failId(prefix: "relay" | "event"): string {
  return `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5FZZ`;
}
