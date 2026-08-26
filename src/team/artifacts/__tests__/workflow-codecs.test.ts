import { describe, expect, it } from "vitest";
import type { ActorRef, RepoRelativePath } from "../../contracts/shared.js";
import {
  inboxProposalArtifactPath,
  parseInboxProposalArtifact,
  parsePlaybookArtifact,
  parsePlaybookRunArtifact,
  parseRelayArtifact,
  parseWorkstreamArtifact,
  playbookArtifactPath,
  playbookRunArtifactPath,
  relayArtifactPath,
  serializeInboxProposalArtifact,
  serializePlaybookArtifact,
  serializePlaybookRunArtifact,
  serializeRelayArtifact,
  serializeWorkstreamArtifact,
  workstreamArtifactPath,
} from "../workflow-codecs.js";
import { generateArtifactId } from "../ulid.js";

const NOW = "2026-08-27T10:00:00.000Z";
const MEMBER = generateArtifactId("member", { now: 1, random: new Uint8Array(10).fill(1) });
const ACTOR: ActorRef = { kind: "member", memberId: MEMBER, displayName: "Ada" };
const WORKSTREAM = generateArtifactId("ws", { now: 2, random: new Uint8Array(10).fill(2) });
const PROPOSAL = generateArtifactId("proposal", { now: 3, random: new Uint8Array(10).fill(3) });
const RELAY = generateArtifactId("relay", { now: 4, random: new Uint8Array(10).fill(4) });
const PLAYBOOK = generateArtifactId("playbook", { now: 5, random: new Uint8Array(10).fill(5) });
const RUN = generateArtifactId("run", { now: 6, random: new Uint8Array(10).fill(6) });

describe("workflow artifact codecs", () => {
  it("round-trips strict v1 workstream, relay, playbook, and run Wiki entities", () => {
    const workstream = serializeWorkstreamArtifact({
      id: WORKSTREAM, entityRevision: 3, state: "active", title: "Release", goal: "Ship safely", summary: "Release work",
      owners: [ACTOR], contributors: [], paths: ["src/team"], code: [], topics: [], components: [], related: [], blockers: [],
      currentState: "Implementing", nextMilestone: "Conformance", createdBy: ACTOR, createdAt: NOW, updatedBy: ACTOR, updatedAt: NOW,
    });
    expect(workstream).toContain(`mex: {"id":${JSON.stringify(WORKSTREAM)},"revision":3`);
    expect(parseWorkstreamArtifact(workstream, workstreamArtifactPath(WORKSTREAM))).toMatchObject({
      ref: { id: WORKSTREAM, kind: "workstream", title: "Release" }, entityRevision: 3, state: "active",
    });

    const relay = serializeRelayArtifact({
      id: RELAY, entityRevision: 1, state: "published", sender: ACTOR, recipients: [ACTOR],
      workstream: { id: WORKSTREAM, kind: "workstream" }, summary: "Handoff", completed: [], inProgress: ["Tests"],
      decisions: [], blockers: [], unresolvedQuestions: [], changedFiles: ["src/team/index.ts"], code: [], evidence: [], nextActions: ["Review"],
    });
    expect(parseRelayArtifact(relay, relayArtifactPath(RELAY))).toMatchObject({ entityRevision: 1, state: "published" });

    const playbook = serializePlaybookArtifact({
      id: PLAYBOOK, entityRevision: 2, state: "active", title: "Release playbook", purpose: "Repeatable release", trigger: "Release requested",
      owners: [ACTOR], prerequisites: ["Green CI"], steps: [{ id: "verify", title: "Verify", instructions: "Run checks", requiredChecks: ["unit"], expectedOutputs: ["report"] }], related: [],
    });
    expect(parsePlaybookArtifact(playbook, playbookArtifactPath(PLAYBOOK))).toMatchObject({ entityRevision: 2, state: "active" });

    const run = serializePlaybookRunArtifact({
      id: RUN, entityRevision: 1, state: "active", playbook: { id: PLAYBOOK, kind: "playbook" },
      workstream: { id: WORKSTREAM, kind: "workstream" }, steps: [{ stepId: "verify" }], startedBy: ACTOR, startedAt: NOW,
    });
    expect(parsePlaybookRunArtifact(run, playbookRunArtifactPath(RUN))).toMatchObject({ entityRevision: 1, state: "active" });
  });

  it("persists a bounded declarative Wiki request without actor, time, handles, or plans", () => {
    const document = serializeInboxProposalArtifact({
      id: PROPOSAL, state: "pending", author: ACTOR, rationale: "Keep docs current", evidence: [],
      request: {
        operation: { opId: "wiki-op-1", type: "update-entry", entityId: "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD", payload: { summary: "Updated" } },
        expectedRevisions: [],
      },
      targetRevisions: [],
    });
    expect(document).not.toContain("actor");
    expect(document).not.toContain("timestamp");
    expect(parseInboxProposalArtifact(document, inboxProposalArtifactPath(PROPOSAL))).toMatchObject({
      state: "pending", request: { operation: { opId: "wiki-op-1", type: "update-entry" } },
    });

    expect(() => serializeInboxProposalArtifact({
      id: PROPOSAL, state: "pending", author: ACTOR, rationale: "Unsafe", evidence: [],
      request: { operation: { opId: "wiki-op-2", type: "update-entry", payload: { compiledPlan: { handle: 7 } } }, expectedRevisions: [] },
      targetRevisions: [],
    })).toThrow(/process-local/);
  });

  it("rejects wrong paths, noncanonical bytes, lifecycle contradictions, and bodies", () => {
    const document = serializeWorkstreamArtifact({
      id: WORKSTREAM, entityRevision: 1, state: "blocked", title: "Blocked", goal: "Unblock", summary: "Waiting", owners: [ACTOR],
      contributors: [], paths: [], code: [], topics: [], components: [], related: [], blockers: ["Approval"], currentState: "Waiting",
      nextMilestone: "Approval", createdBy: ACTOR, createdAt: NOW, updatedBy: ACTOR, updatedAt: NOW,
    });
    expect(() => parseWorkstreamArtifact(document, `.mex/workstreams/${RELAY}.md` as RepoRelativePath)).toThrow(/path must/);
    expect(() => parseWorkstreamArtifact(document.replace("schema_version: 1\n", "").replace("id:", "id:\n schema_version: 1\nignored:"), workstreamArtifactPath(WORKSTREAM))).toThrow();
    expect(() => parseWorkstreamArtifact(`${document}body\n`, workstreamArtifactPath(WORKSTREAM))).toThrow(/frontmatter only/);
    expect(() => serializeWorkstreamArtifact({
      id: WORKSTREAM, entityRevision: 1, state: "active", title: "Invalid", goal: "No blockers", summary: "Contradiction", owners: [ACTOR],
      contributors: [], paths: [], code: [], topics: [], components: [], related: [], blockers: ["Still blocked"], currentState: "Active",
      nextMilestone: "Soon", createdBy: ACTOR, createdAt: NOW, updatedBy: ACTOR, updatedAt: NOW,
    })).toThrow(/blocked workstream/);
  });
});
