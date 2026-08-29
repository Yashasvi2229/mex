import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  RelayDetailSchema,
  RelayListResponseSchema,
  RelayOperationApplyResponseSchema,
  RelayOperationPreviewResponseSchema,
} from "@mex/hub-contracts";
import type { RelayOperationPreviewRequest } from "@mex/hub-contracts";
import type { GitPort } from "../../team/contracts/git.js";
import type { Diagnostic, Revision } from "../../team/contracts/shared.js";
import type {
  TeamMember,
  TeamRelayCommand,
  TeamRelayDetail,
  TeamRelayHandoffPort,
  TeamRelayPreviewEnvelope,
  TeamRelaySummary,
} from "../../team/contracts/workflow.js";
import {
  createLocalHubReadServices,
  type HubTeamIdentityActivityService,
} from "../services.js";

const MEMBER_ID = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const WORKSTREAM_ID = "ws_01ARZ3NDEKTSV4RRFFQ69G5FAC";
const RELAY_ID = "relay_01000000000000000000000001";
const NOW = "2026-08-29T03:04:05.000Z";
const LEGACY_WARNING = "One or more legacy schema-v1 Relays have no canonical publication timestamp.";

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "mex-hub-relay-services-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

function member(): TeamMember {
  return {
    schemaVersion: 1,
    kind: "member",
    ref: { id: MEMBER_ID, kind: "member", title: "Ada Lovelace" },
    displayName: "Ada Lovelace",
    gitAliases: [{ name: "Ada", email: "ada@example.test" }],
    active: true,
    sourcePath: `.mex/team/members/${MEMBER_ID}.md`,
    revision: "a".repeat(64) as Revision,
  };
}

function relay(): TeamRelayDetail {
  return {
    schemaVersion: 1,
    ref: { id: RELAY_ID, kind: "relay", title: "Legacy handoff" },
    sourcePath: `.mex/relays/${RELAY_ID}.md`,
    revision: "b".repeat(64) as Revision,
    state: "published",
    sender: { kind: "member", memberId: MEMBER_ID, displayName: "Ada Lovelace" },
    recipients: [{ kind: "member", memberId: MEMBER_ID, displayName: "Ada Lovelace" }],
    workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Relay" },
    summary: "Legacy handoff",
    publishedAt: null,
    completed: ["Characterization completed."],
    inProgress: ["Reviewing the gate."],
    decisions: [{ id: "decision-1", kind: "decision", title: "Keep it pinned" }],
    blockers: [],
    unresolvedQuestions: [],
    changedFiles: ["src/hub/services.ts"],
    code: [{ kind: "file", path: "src/hub/services.ts", fingerprint: "c".repeat(64) }],
    evidence: [
      { kind: "entity", entity: { id: "decision-1", kind: "decision", title: "Keep it pinned" } },
      { kind: "code", code: { kind: "symbol", symbolId: "relay.apply" } },
      { kind: "file", path: "src/hub/services.ts" },
      { kind: "commit", hash: "d".repeat(40) },
      { kind: "external", uri: "https://example.test/evidence", label: "Run" },
      { kind: "manual", note: "Observed locally." },
    ],
    nextActions: ["Run the matrix."],
    diagnostics: [{
      code: "RELAY_LEGACY_PUBLICATION_TIME",
      severity: "warning",
      message: LEGACY_WARNING,
      path: ".mex/relays/private.md",
      detail: { absolutePath: "/Users/alice/private" },
    }],
  };
}

function summary(detail: TeamRelayDetail): TeamRelaySummary {
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
    ...result
  } = detail;
  return result;
}

function identity(actor: "member" | "git" = "member"): HubTeamIdentityActivityService {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    getMember: async (id) => id === MEMBER_ID ? member() : null,
    listMembers: unused,
    getCurrentActor: async () => actor === "member"
      ? {
          actor: { kind: "member" as const, memberId: MEMBER_ID, displayName: "Ada Lovelace" },
          source: "configured-member" as const,
          selection: { memberId: MEMBER_ID, updatedAt: NOW, revision: "e".repeat(64) as Revision },
          diagnostics: [] as Diagnostic[],
        }
      : {
          actor: { kind: "git" as const, name: "Unknown", email: "unknown@example.test" },
          source: "git-fallback" as const,
          selection: null,
          diagnostics: [] as Diagnostic[],
        },
    getActivity: unused,
    listActivity: unused,
    previewIdentityActivity: unused,
    applyIdentityActivity: unused,
  };
}

function relayService(listRelays = vi.fn(), legacy = true): TeamRelayHandoffPort {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  const detail: TeamRelayDetail = legacy
    ? relay()
    : {
        ...relay(),
        schemaVersion: 2,
        publishedAt: NOW,
        diagnostics: [],
      };
  listRelays.mockResolvedValue({
    items: [summary(detail)],
    nextCursor: null,
    truncated: false,
    sourceTruncated: false,
    deterministicRevision: "f".repeat(64) as Revision,
    diagnostics: legacy
      ? [{
          code: "RELAY_LEGACY_PUBLICATION_TIME",
          severity: "warning",
          message: LEGACY_WARNING,
          detail: { absolutePath: "/Users/alice/private" },
        }]
      : [],
  });
  return {
    getRelayDraft: unused,
    listRelayDrafts: unused,
    getRelay: async (id) => id === RELAY_ID ? detail : null,
    listRelays,
    previewRelay: unused,
    applyRelay: unused,
  };
}

const git = {
  getRepoState: async () => ({
    branch: "feature/relay",
    head: "a".repeat(40),
    dirty: false,
    observedAt: NOW,
  }),
  getIdentity: async () => ({ name: "Ada", email: "ada@example.test" }),
} as Pick<GitPort, "getRepoState" | "getIdentity"> as GitPort;

describe("Hub Relay projections", () => {
  it("projects strict full detail and bounded fixed legacy warnings", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "relay-fixture",
      jobs: { list: () => ({ items: [] }) },
      team: identity(),
      relays: relayService(),
      git,
      now: () => new Date(NOW),
    });
    const detail = await services.relay?.(RELAY_ID);
    expect(RelayDetailSchema.safeParse(detail).success).toBe(true);
    expect(detail).toMatchObject({
      schemaVersion: 1,
      publishedAt: null,
      evidence: [
        { kind: "entity" },
        { kind: "code" },
        { kind: "file" },
        { kind: "commit" },
        { kind: "external" },
        { kind: "manual" },
      ],
      diagnostics: [{ code: "RELAY_LEGACY_PUBLICATION_TIME", message: LEGACY_WARNING }],
      diagnosticsTruncated: false,
    });
    expect(JSON.stringify(detail)).not.toContain("/Users/alice");

    const page = await services.relays?.({ perspective: "all", limit: 25 });
    expect(RelayListResponseSchema.safeParse(page).success).toBe(true);
    expect(page?.diagnostics).toEqual([expect.objectContaining({
      code: "RELAY_LEGACY_PUBLICATION_TIME",
      message: LEGACY_WARNING,
    })]);
    expect(JSON.stringify(page)).not.toContain("/Users/alice");
  });

  it("counts the exact My-open predicate and reports no-Member recovery as unavailable", async () => {
    const listRelays = vi.fn();
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "relay-fixture",
      jobs: { list: () => ({ items: [] }) },
      team: identity(),
      relays: relayService(listRelays),
      git,
      now: () => new Date(NOW),
    });
    await expect(services.home()).resolves.toMatchObject({
      sections: { relays: { availability: "available", count: 1 } },
    });
    expect(listRelays).toHaveBeenCalledWith({
      perspective: "mine",
      states: ["published", "acknowledged"],
      limit: 100,
    });

    const unsafeList = vi.fn();
    const unsafeRelays = relayService(unsafeList, false);
    unsafeList.mockResolvedValue({
      items: [],
      nextCursor: null,
      truncated: false,
      sourceTruncated: false,
      deterministicRevision: "f".repeat(64) as Revision,
      diagnostics: [{
        code: "RELAY_CORPUS_UNTRUSTED",
        severity: "warning",
        message: "Unsafe adapter detail.",
      }],
    });
    const unsafe = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "relay-fixture",
      jobs: { list: () => ({ items: [] }) },
      team: identity(),
      relays: unsafeRelays,
      git,
      now: () => new Date(NOW),
    });
    await expect(unsafe.home()).resolves.toMatchObject({
      sections: {
        relays: {
          availability: "unavailable",
          count: null,
          reason: "Your open Relay summary could not establish a complete diagnostic-free corpus.",
        },
      },
    });

    const unavailableList = vi.fn();
    const noMember = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "relay-fixture",
      jobs: { list: () => ({ items: [] }) },
      team: identity("git"),
      relays: relayService(unavailableList, false),
      git,
      now: () => new Date(NOW),
    });
    await expect(noMember.home()).resolves.toMatchObject({
      sections: {
        relays: {
          availability: "unavailable",
          count: null,
          reason: "Select an active Member to see your open Relay handoffs.",
        },
      },
    });
    expect(unavailableList).not.toHaveBeenCalled();
  });

  it("round-trips a non-email Git authority through the Relay-only signed envelope unchanged", async () => {
    const draftId = "relay-draft-git-authority";
    const wireRequest: RelayOperationPreviewRequest = {
      operationId: "hub_relay_git_authority_round_trip",
      action: {
        kind: "relay.draft.save",
        draft: {
          recipients: [{ kind: "member", memberId: MEMBER_ID, displayName: "Ada Lovelace" }],
          workstream: { id: WORKSTREAM_ID, kind: "workstream", title: "Relay" },
          summary: "Preserve the configured Git authority bytes.",
          completed: [],
          inProgress: [],
          decisions: [],
          blockers: [],
          unresolvedQuestions: [],
          changedFiles: [],
          code: [],
          evidence: [],
          nextActions: [],
        },
      },
      expectedRevisions: [],
    };
    const command: TeamRelayCommand = wireRequest;
    const envelope: TeamRelayPreviewEnvelope = {
      schemaVersion: 1,
      request: command,
      preview: {
        valid: true,
        scope: "local",
        changes: [],
        localChanges: [{
          namespace: "relay-draft",
          id: draftId,
          beforeRevision: null,
          afterRevision: "1".repeat(64) as Revision,
          summary: "Create one checkout-local Relay draft.",
        }],
        diagnostics: [],
      },
      receipt: {
        schemaVersion: 1,
        authority: {
          actor: { kind: "git", name: "Local Operator", email: "not-an-email" },
          occurredAt: NOW,
          repoState: {
            branch: "feature/relay",
            head: "a".repeat(40),
            dirty: false,
            observedAt: NOW,
          },
        },
        purposeIds: [{ purpose: "relay-draft", id: draftId }],
        requestRevision: "2".repeat(64) as Revision,
        presentationRevision: "3".repeat(64) as Revision,
        previewRevision: "4".repeat(64) as Revision,
      },
    };
    const previewRelay = vi.fn(async (received: TeamRelayCommand) => {
      expect(received).toEqual(command);
      return envelope;
    });
    const applyRelay = vi.fn(async (received: TeamRelayPreviewEnvelope) => ({
      operationId: received.request.operationId,
      previewRevision: received.receipt.previewRevision,
      applied: true as const,
      idempotentReplay: false,
      changes: [],
      localChanges: received.preview.localChanges,
      relays: [],
      events: [],
    }));
    const unused = async (): Promise<never> => { throw new Error("unused"); };
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "relay-fixture",
      jobs: { list: () => ({ items: [] }) },
      team: identity("git"),
      relays: {
        getRelayDraft: unused,
        listRelayDrafts: unused,
        getRelay: unused,
        listRelays: unused,
        previewRelay,
        applyRelay,
      },
      git,
      now: () => new Date(NOW),
    });

    const wireEnvelope = await services.previewRelayOperation?.(wireRequest);
    expect(RelayOperationPreviewResponseSchema.safeParse(wireEnvelope).success).toBe(true);
    expect(wireEnvelope?.receipt.authority.actor).toEqual({
      kind: "git",
      name: "Local Operator",
      email: "not-an-email",
    });
    const serialized = JSON.stringify(wireEnvelope);
    const reparsed = RelayOperationPreviewResponseSchema.parse(JSON.parse(serialized));
    expect(JSON.stringify(reparsed)).toBe(serialized);

    const result = await services.applyRelayOperation?.(reparsed);
    expect(RelayOperationApplyResponseSchema.safeParse(result).success).toBe(true);
    expect(applyRelay).toHaveBeenCalledWith(envelope);
  });
});
