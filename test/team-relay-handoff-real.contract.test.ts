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
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
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
} from "../src/team/contracts/workflow.js";
import { MemberRepository } from "../src/team/identity/member-repository.js";
import { TeamLocalState } from "../src/team/local-state/index.js";
import { TEAM_RECEIPT_SIGNER_RELATIVE_PATH } from "../src/team/local-state/receipt-signer.js";
import { normalizeRelayProductDraftInput } from "../src/team/relay/handoff.js";
import { MockWikiPort } from "../src/team/testing/wiki/mock-wiki-port.js";
import type { WikiPort } from "../src/team/contracts/wiki.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  type RepositoryTeamWorkflowPort,
  type TeamWorkflowPhaseBoundary,
} from "../src/team/workflow/repository-team-workflow-port.js";

const NOW = "2026-08-29T06:30:00.000Z";
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
    try {
      const draft = left.oracle.populatedDraft;
      if (draft === null) throw new Error("Expected left Relay draft.");
      const published = await left.port.applyRelay(
        await left.port.previewRelay(
          await left.commandFor("relay.publish", draft, "relay_two_clone_publish"),
        ),
      );
      const leftAfterPublish = await left.snapshot();
      const rightBeforeSync = await right.snapshot();
      commitAndPushRelayCanonical(left.root, "Publish Relay");
      pullRelayCanonical(right.root);
      const rightAfterSync = await right.snapshot();
      expect(rightAfterSync.localStateDigest).toBe(rightBeforeSync.localStateDigest);
      expect(rightAfterSync.signerDigest).toBe(rightBeforeSync.signerDigest);

      right.reserveGeneratedIds(0, 1);
      const recipient = await right.selectActor("recipient");
      const rightRelay = await recipient.getRelay(published.relays[0]!.ref.id);
      if (rightRelay === null) throw new Error("Expected synchronized Relay.");
      await recipient.applyRelay(
        await recipient.previewRelay(
          await right.commandFor(
            "relay.acknowledge",
            rightRelay,
            "relay_two_clone_acknowledge",
          ),
        ),
      );
      const rightAfterAcknowledge = await right.snapshot();
      commitAndPushRelayCanonical(right.root, "Acknowledge Relay");
      pullRelayCanonical(left.root);
      const leftAfterAcknowledgeSync = await left.snapshot();
      expect(leftAfterAcknowledgeSync.localStateDigest).toBe(leftAfterPublish.localStateDigest);
      expect(leftAfterAcknowledgeSync.signerDigest).toBe(leftAfterPublish.signerDigest);

      left.reserveGeneratedIds(0, 1);
      const acknowledged = await left.port.getRelay(published.relays[0]!.ref.id);
      if (acknowledged === null) throw new Error("Expected acknowledged Relay.");
      await left.port.applyRelay(
        await left.port.previewRelay(
          await left.commandFor(
            "relay.close",
            acknowledged,
            "relay_two_clone_close",
          ),
        ),
      );
      const leftAfterClose = await left.snapshot();
      commitAndPushRelayCanonical(left.root, "Close Relay");
      pullRelayCanonical(right.root);
      await expect(recipient.getRelay(published.relays[0]!.ref.id)).resolves.toMatchObject({
        state: "closed",
      });
      const rightAfterCloseSync = await right.snapshot();
      expect(rightAfterCloseSync.localStateDigest)
        .toBe(rightAfterAcknowledge.localStateDigest);
      expect(rightAfterCloseSync.signerDigest).toBe(rightAfterAcknowledge.signerDigest);
      expect(leftAfterClose.outboundRequests + rightAfterCloseSync.outboundRequests).toBe(0);
      expect(leftAfterClose.modelInvocations + rightAfterCloseSync.modelInvocations).toBe(0);
    } finally {
      await left.close();
      await right.close();
      clones.close();
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
    await seedMembersAndWorkstream(root);
    return this.attach(root, scenario);
  }

  static async attach(
    root: string,
    scenario: TeamRelayScenario,
  ): Promise<RepositoryRelayHarness> {
    const actor = scenario === "no-current-member" ? "none" : "sender";
    let populatedDraft: TeamRelayDraftDetail | null = null;
    let populatedRelay: TeamRelayDetail | null = null;
    if (scenario === "populated") {
      new TeamLocalState({ projectRoot: root, scaffoldId: SCAFFOLD_ID, now: () => NOW })
        .saveLocalDraft({
          id: DRAFT_ID,
          kind: "relay",
          payload: draftInput(),
          expectedRevision: null,
          updatedAt: NOW,
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
      const acknowledged = await repository.previewUpdate(created.ref.id, {
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
    populatedDraft = scenario === "populated"
      ? await harness.port.getRelayDraft(DRAFT_ID)
      : null;
    populatedRelay = scenario === "legacy-v1"
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
    const workstreams = new WorkstreamRepository(this.root);
    const workstream = await workstreams.get(draft.input.workstream.id);
    if (workstream === null) throw new Error("Relay fixture Workstream is missing.");
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
        artifactExpectation(workstream.sourcePath, workstream.revision),
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

  async setWorkstreamStates(
    states: readonly ("active" | "blocked" | "done" | "archived")[],
  ): Promise<void> {
    const repository = new WorkstreamRepository(this.root);
    for (const state of states) {
      const current = await repository.get(WORKSTREAM_ID);
      if (current === null) throw new Error("Relay fixture Workstream is missing.");
      const plan = await repository.previewUpdate(current.ref.id, {
        title: current.title,
        goal: current.goal,
        summary: current.summary,
        state,
        owners: current.owners,
        contributors: current.contributors,
        paths: current.paths,
        code: current.code,
        topics: current.topics,
        components: current.components,
        related: current.related,
        blockers: state === "blocked" ? ["Waiting for review"] : [],
        currentState: state === "blocked" ? "Waiting for review" : `State ${state}`,
        nextMilestone: current.nextMilestone,
        createdBy: current.createdBy,
        createdAt: current.createdAt,
        updatedBy: current.updatedBy,
        updatedAt: this.#now,
      }, current.revision);
      await repository.apply(plan, plan.previewRevision);
    }
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

  reserveGeneratedIds(relays: number, events: number): void {
    this.#relayOffset += relays;
    this.#eventOffset += events;
  }

  async snapshot(): Promise<TeamRelaySnapshot> {
    return {
      canonicalDigest: digestTree(this.root, (path) =>
        path.startsWith(".mex/") && !path.startsWith(".mex/local/")),
      localStateDigest: digestFile(join(this.root, ".mex/local/team.db")),
      signerDigest: digestFile(join(this.root, TEAM_RECEIPT_SIGNER_RELATIVE_PATH)),
      gitHead: this.#repoState.head,
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
    return createRepositoryTeamWorkflowPortWithDependencies(this.root, {
      scaffoldId: SCAFFOLD_ID,
      wiki: new MockWikiPort({ now: () => this.#now }) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
      git: fakeGit(identity, () => this.#repoState),
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

async function seedMembersAndWorkstream(root: string): Promise<void> {
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
    ...relaySeedInput(SENDER, [RECIPIENT]),
    id: RELAY_IDS[0],
    publishedAt: "2026-08-29T06:10:00.000Z",
    summary: "Published to recipient",
  });
  await repository.apply(first, first.previewRevision);
  const second = await repository.previewCreate({
    ...relaySeedInput(RECIPIENT, [SENDER]),
    id: RELAY_IDS[1],
    publishedAt: "2026-08-29T06:20:00.000Z",
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
    ...relaySeedInput(SENDER, [SENDER]),
    id: RELAY_IDS[2],
    summary: "Legacy self handoff",
  });
  await repository.apply(legacy, legacy.previewRevision);
}

function relaySeedInput(sender: ActorRef, recipients: readonly ActorRef[]) {
  return {
    sender,
    recipients,
    workstream: { id: WORKSTREAM_ID, kind: "workstream" as const, title: "Relay lane" },
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

function relayStoredInput(relay: Relay) {
  return {
    sender: relay.sender,
    recipients: relay.recipients,
    workstream: relay.workstream,
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
    ...(relay.publishedAt === undefined ? {} : { publishedAt: relay.publishedAt }),
  };
}

function draftInput(): RelayDraftInput {
  return normalizeRelayProductDraftInput({
    recipients: [RECIPIENT, ALTERNATE_RECIPIENT],
    workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Relay lane" },
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

interface FakeGit extends GitPort {}

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
  await seedMembersAndWorkstream(seed);
  runGit(seed, ["init", "--initial-branch=main"]);
  configureGitIdentity(seed);
  runGit(seed, ["add", ".mex/team/members", ".mex/workstreams"]);
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
