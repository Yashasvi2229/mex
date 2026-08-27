import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { generateArtifactId } from "../../artifacts/ulid.js";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitPort,
} from "../../contracts/git.js";
import type { JsonValue, RepoState } from "../../contracts/shared.js";
import type {
  TeamIdentityActivityCommand,
  TeamIdentityActivityPreviewEnvelope,
} from "../../contracts/workflow.js";
import type { WikiPort } from "../../contracts/wiki.js";
import { MockWikiPort } from "../../testing/wiki/mock-wiki-port.js";
import { TEAM_RECEIPT_SIGNER_RELATIVE_PATH } from "../../local-state/receipt-signer.js";
import {
  createRepositoryTeamWorkflowPortWithDependencies,
  type RepositoryTeamWorkflowPort,
  type RepositoryTeamWorkflowPortOptions,
  WorkflowPhaseInterruption,
} from "../repository-team-workflow-port.js";

const NOW = "2026-08-27T04:05:06.000Z";
const HEAD = "1".repeat(40);
const MEMBER_IDS = [id("member", 1), id("member", 2), id("member", 3)] as const;
const EVENT_IDS = [id("event", 4), id("event", 5), id("event", 6), id("event", 7)] as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("RepositoryTeamWorkflowPort identity and Activity contract", () => {
  it("prepares only the signer and applies the serialized envelope in a fresh service", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const previewer = port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    });
    const envelope = await previewer.previewIdentityActivity(
      addMember("identity_portable_add", "Ada Lovelace"),
    );

    expect(envelope).toMatchObject({
      schemaVersion: 1,
      request: { operationId: "identity_portable_add" },
      preview: { valid: true, scope: "canonical" },
      receipt: {
        schemaVersion: 1,
        purposeIds: [
          { purpose: "activity", id: EVENT_IDS[0] },
          { purpose: "member", id: MEMBER_IDS[0] },
        ],
      },
    });
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(Buffer.byteLength(JSON.stringify(envelope.receipt), "utf8")).toBeLessThanOrEqual(8 * 1024);
    expect(existsSync(signerPath(root))).toBe(true);
    if (process.platform !== "win32") {
      expect(statSync(signerPath(root)).mode & 0o777).toBe(0o600);
    }
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);
    expect(existsSync(join(root, ".mex/team"))).toBe(false);
    expect(existsSync(join(root, ".mex/events/activity"))).toBe(false);

    const serialized = JSON.parse(JSON.stringify(envelope)) as TeamIdentityActivityPreviewEnvelope;
    const applier = port(root, git, {
      memberIds: [failId("member")],
      eventIds: [failId("event")],
      pid: 202,
    });
    const result = await applier.applyIdentityActivity(serialized);

    expect(result).toMatchObject({
      operationId: "identity_portable_add",
      idempotentReplay: false,
      artifacts: [{ ref: { id: MEMBER_IDS[0], kind: "member" } }],
      events: [{ id: EVENT_IDS[0], action: "member.added" }],
    });
    expect(activityFiles(root)).toEqual([`${EVENT_IDS[0]}.md`]);
  });

  it("keeps generic previews and reads noninitializing while C preview or Hub startup prepares only the signer", async () => {
    const previewRoot = temporaryRoot();
    const service = port(previewRoot, fakeGit(), {
      memberIds: [MEMBER_IDS[0], MEMBER_IDS[1]],
      eventIds: [EVENT_IDS[0], EVENT_IDS[1]],
    });
    await expect(service.getCurrentActor()).resolves.toBeDefined();
    await service.preview(addMember("identity_generic_preview", "Ada Lovelace"));
    expect(existsSync(join(previewRoot, ".mex/local"))).toBe(false);
    await service.previewIdentityActivity(
      addMember("identity_c_preview", "Ada Lovelace"),
    );
    expect(existsSync(signerPath(previewRoot))).toBe(true);
    expect(existsSync(join(previewRoot, ".mex/local/team.db"))).toBe(false);
    expect(existsSync(join(previewRoot, ".mex/team"))).toBe(false);

    const hubRoot = temporaryRoot();
    const hubService = port(hubRoot, fakeGit());
    hubService.initializeIdentityActivitySigner();
    expect(existsSync(signerPath(hubRoot))).toBe(true);
    expect(existsSync(join(hubRoot, ".mex/local/team.db"))).toBe(false);
    expect(existsSync(join(hubRoot, ".mex/team"))).toBe(false);
  });

  it("requires re-preview when the local receipt signing credential is lost", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const envelope = await port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    }).previewIdentityActivity(addMember("identity_missing_signer", "Ada Lovelace"));
    unlinkSync(signerPath(root));

    await expect(port(root, git).applyIdentityActivity(envelope)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);
    expect(existsSync(join(root, ".mex/team"))).toBe(false);
    expect(existsSync(join(root, ".mex/events/activity"))).toBe(false);
  });

  it("rejects request, presentation, receipt, authority, and expiry drift before publication", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const previewer = port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    });
    const envelope = await previewer.previewIdentityActivity(
      addMember("identity_tamper", "Ada Lovelace"),
    );

    const requestTamper = structuredClone(envelope) as any;
    requestTamper.request.action.member.displayName = "Mallory";
    await expect(previewer.applyIdentityActivity(requestTamper)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });

    const presentationTamper = structuredClone(envelope) as any;
    presentationTamper.preview.scope = "local";
    await expect(previewer.applyIdentityActivity(presentationTamper)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });

    const receiptTamper = structuredClone(envelope) as any;
    receiptTamper.receipt.purposeIds[0].id = EVENT_IDS[1];
    await expect(previewer.applyIdentityActivity(receiptTamper)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });

    git.state = { ...git.state, head: "2".repeat(40) };
    await expect(previewer.applyIdentityActivity(envelope)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    git.state = { ...git.state, head: HEAD };

    const expired = port(root, git, {
      now: "2026-08-27T04:35:06.001Z",
      memberIds: [failId("member")],
      eventIds: [failId("event")],
    });
    await expect(expired.applyIdentityActivity(envelope)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);
    expect(existsSync(join(root, ".mex/team"))).toBe(false);
    expect(existsSync(join(root, ".mex/events/activity"))).toBe(false);
  });

  it("renews an expired same-operation portable preview without reusing its IDs", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    let clock = new Date(NOW);
    const service = port(root, git, {
      clock: () => new Date(clock.getTime()),
      memberIds: [MEMBER_IDS[0], MEMBER_IDS[1]],
      eventIds: [EVENT_IDS[0], EVENT_IDS[1]],
    });
    const command = addMember("identity_renew_preview", "Ada Lovelace");
    const first = await service.previewIdentityActivity(command);
    expect(await service.previewIdentityActivity(command)).toEqual(first);

    clock = new Date(Date.parse(NOW) + 30 * 60 * 1_000 + 1);
    git.state = { ...git.state, observedAt: clock.toISOString() };
    const renewed = await service.previewIdentityActivity(command);
    expect(renewed.receipt.authority.occurredAt).toBe(clock.toISOString());
    expect(renewed.receipt.purposeIds).toEqual([
      { purpose: "activity", id: EVENT_IDS[1] },
      { purpose: "member", id: MEMBER_IDS[1] },
    ]);
    expect(renewed.receipt.previewRevision).not.toBe(first.receipt.previewRevision);
    await expect(service.applyIdentityActivity(first)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    await expect(service.applyIdentityActivity(renewed)).resolves.toMatchObject({
      events: [{ id: EVENT_IDS[1] }],
    });
  });

  it("replays a completed journal across processes without live authority or expiry", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const envelope = await port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    }).previewIdentityActivity(addMember("identity_replay", "Ada Lovelace"));
    await port(root, git, { pid: 301 }).applyIdentityActivity(envelope);

    unlinkSync(signerPath(root));
    git.state = { ...git.state, dirty: true };
    const replay = await port(root, git, {
      pid: 302,
      now: "2026-08-28T10:00:00.000Z",
    }).applyIdentityActivity(JSON.parse(JSON.stringify(envelope)));
    expect(replay).toMatchObject({
      operationId: "identity_replay",
      idempotentReplay: true,
      events: [{ id: EVENT_IDS[0] }],
    });
    expect(activityFiles(root)).toHaveLength(1);

    const altered = await port(root, git, {
      memberIds: [MEMBER_IDS[1]],
      eventIds: [EVENT_IDS[1]],
      now: "2026-08-28T10:00:00.000Z",
    }).previewIdentityActivity(addMember("identity_replay", "Different intent"));
    await expect(port(root, git).applyIdentityActivity(altered)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(activityFiles(root)).toHaveLength(1);
  });

  it("recovers a journaled fresh intent without requiring the lost signer", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const envelope = await port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    }).previewIdentityActivity(addMember("identity_intent_without_signer", "Ada Lovelace"));
    await expect(port(root, git, {
      pid: 321,
      phaseHook(boundary) {
        if (boundary === "before-canonical-publication") {
          throw new WorkflowPhaseInterruption(boundary);
        }
      },
    }).applyIdentityActivity(envelope)).rejects.toBeInstanceOf(WorkflowPhaseInterruption);
    unlinkSync(signerPath(root));

    await expect(port(root, git, { pid: 322 }).applyIdentityActivity(envelope))
      .resolves.toMatchObject({
        idempotentReplay: true,
        artifacts: [{ ref: { id: MEMBER_IDS[0] } }],
        events: [{ id: EVENT_IDS[0] }],
      });
  });

  it("attests completed Activity bytes while allowing later member revisions", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const firstService = port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    });
    const firstEnvelope = await firstService.previewIdentityActivity(
      addMember("identity_attested_replay", "Ada Lovelace"),
    );
    const first = await firstService.applyIdentityActivity(firstEnvelope);
    const member = first.artifacts[0]!;

    const updater = port(root, git, { eventIds: [EVENT_IDS[1]], pid: 311 });
    const update = await updater.previewIdentityActivity({
      operationId: "identity_later_member_update",
      action: {
        kind: "member.update",
        memberId: member.ref.id,
        patch: { displayName: "Ada Byron" },
      },
      expectedRevisions: [{
        target: { kind: "artifact", path: member.sourcePath },
        revision: member.revision,
      }],
    });
    await updater.applyIdentityActivity(update);

    await expect(port(root, git, { pid: 312 }).applyIdentityActivity(firstEnvelope))
      .resolves.toMatchObject({ idempotentReplay: true, artifacts: [] });

    const activityPath = join(
      root,
      ".mex/events/activity",
      NOW.slice(0, 7),
      `${EVENT_IDS[0]}.md`,
    );
    appendFileSync(activityPath, "tampered\n", "utf8");
    await expect(port(root, git, { pid: 313 }).applyIdentityActivity(firstEnvelope))
      .rejects.toMatchObject({ problem: { code: "OPERATION_INTERRUPTED" } });
    unlinkSync(activityPath);
    await expect(port(root, git, { pid: 314 }).applyIdentityActivity(firstEnvelope))
      .rejects.toMatchObject({ problem: { code: "OPERATION_INTERRUPTED" } });
  });

  it("abandons an unpublished intent when authority is stale and requires a fresh preview", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const envelope = await port(root, git, {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    }).previewIdentityActivity(addMember("identity_recover_intent", "Ada Lovelace"));
    const interrupted = port(root, git, {
      pid: 351,
      phaseHook(boundary) {
        if (boundary === "before-canonical-publication") {
          throw new WorkflowPhaseInterruption(boundary);
        }
      },
    });
    await expect(interrupted.applyIdentityActivity(envelope)).rejects.toBeInstanceOf(
      WorkflowPhaseInterruption,
    );
    expect(activityFiles(root)).toEqual([]);

    git.state = { ...git.state, dirty: true };
    await expect(port(root, git, {
      pid: 352,
      now: "2026-08-28T10:00:00.000Z",
    }).applyIdentityActivity(JSON.parse(JSON.stringify(envelope))))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
    expect(activityFiles(root)).toEqual([]);
    expect(existsSync(join(root, ".mex/team"))).toBe(false);

    git.state = { ...git.state, dirty: false };
    const retry = port(root, git, {
      pid: 353,
      now: "2026-08-28T10:00:00.000Z",
      memberIds: [MEMBER_IDS[1]],
      eventIds: [EVENT_IDS[1]],
    });
    const renewed = await retry.previewIdentityActivity(
      addMember("identity_recover_intent", "Ada Lovelace"),
    );
    const recovered = await retry.applyIdentityActivity(renewed);
    expect(recovered).toMatchObject({
      operationId: "identity_recover_intent",
      idempotentReplay: false,
      artifacts: [{ ref: { id: MEMBER_IDS[1] } }],
      events: [{ id: EVENT_IDS[1] }],
    });
    expect(activityFiles(root)).toHaveLength(1);
  });

  it("revalidates actor, branch, HEAD, and dirty state before audit-only intent publication", async () => {
    const mutations: readonly [string, (git: FakeGit) => void][] = [
      ["actor", (git) => { git.identity = { name: "Grace", email: "grace@example.test" }; }],
      ["branch", (git) => { git.state = { ...git.state, branch: "other" }; }],
      ["HEAD", (git) => { git.state = { ...git.state, head: "2".repeat(40) }; }],
      ["dirty", (git) => { git.state = { ...git.state, dirty: true }; }],
    ];
    for (const [label, mutate] of mutations) {
      const root = temporaryRoot();
      const git = fakeGit();
      const command: TeamIdentityActivityCommand = {
        operationId: `identity_audit_authority_${label.toLowerCase()}`,
        action: {
          kind: "activity.record",
          activity: { action: "review.started", subjects: [] },
        },
        expectedRevisions: [],
      };
      const envelope = await port(root, git, { eventIds: [EVENT_IDS[0]] })
        .previewIdentityActivity(command);
      const interrupted = port(root, git, {
        pid: 360,
        phaseHook(boundary) {
          if (boundary === "before-canonical-publication") {
            throw new WorkflowPhaseInterruption(boundary);
          }
        },
      });
      await expect(interrupted.applyIdentityActivity(envelope))
        .rejects.toBeInstanceOf(WorkflowPhaseInterruption);

      mutate(git);
      await expect(port(root, git, { pid: 361 }).applyIdentityActivity(envelope))
        .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      expect(activityFiles(root), label).toEqual([]);
    }
  });

  it("abandons an audit-only intent whose unpublished path became conflicting", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const command: TeamIdentityActivityCommand = {
      operationId: "identity_audit_path_conflict",
      action: {
        kind: "activity.record",
        activity: { action: "review.started", subjects: [] },
      },
      expectedRevisions: [],
    };
    const envelope = await port(root, git, { eventIds: [EVENT_IDS[0]] })
      .previewIdentityActivity(command);
    await expect(port(root, git, {
      pid: 370,
      phaseHook(boundary) {
        if (boundary === "before-canonical-publication") {
          throw new WorkflowPhaseInterruption(boundary);
        }
      },
    }).applyIdentityActivity(envelope)).rejects.toBeInstanceOf(WorkflowPhaseInterruption);

    const path = join(
      root,
      ".mex/events/activity",
      NOW.slice(0, 7),
      `${EVENT_IDS[0]}.md`,
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, "conflicting bytes\n", "utf8");
    await expect(port(root, git, { pid: 371 }).applyIdentityActivity(envelope))
      .rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

    unlinkSync(path);
    const retry = port(root, git, { pid: 372, eventIds: [EVENT_IDS[1]] });
    const renewed = await retry.previewIdentityActivity(command);
    await expect(retry.applyIdentityActivity(renewed)).resolves.toMatchObject({
      idempotentReplay: false,
      events: [{ id: EVENT_IDS[1] }],
    });
  });

  it("keeps selection local, blocks deactivation of the selection, and records canonical mutations once", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const service = port(root, git, {
      memberIds: [MEMBER_IDS[0], MEMBER_IDS[1]],
      eventIds: [EVENT_IDS[0], EVENT_IDS[1], EVENT_IDS[2]],
    });
    const firstAdd = await service.previewIdentityActivity(
      addMember("identity_add_first", "Ada Lovelace"),
    );
    const firstResult = await service.applyIdentityActivity(firstAdd);
    const first = firstResult.artifacts[0]!;
    const secondAdd = await service.previewIdentityActivity(
      addMember("identity_add_second", "Grace Hopper"),
    );
    await service.applyIdentityActivity(secondAdd);
    expect(activityFiles(root)).toHaveLength(2);

    const select = await service.previewIdentityActivity({
      operationId: "identity_select",
      action: { kind: "member.select", memberId: first.ref.id },
      expectedRevisions: [
        { target: { kind: "artifact", path: first.sourcePath }, revision: first.revision },
        {
          target: { kind: "local", namespace: "member-selection", id: "current" },
          revision: null,
        },
      ],
    });
    expect(select.preview).toMatchObject({ scope: "local", changes: [] });
    expect(select.receipt.purposeIds).toEqual([]);
    await port(root, git, { pid: 402 }).applyIdentityActivity(select);
    expect(activityFiles(root)).toHaveLength(2);
    const current = await service.getCurrentActor();
    expect(current).toMatchObject({
      source: "configured-member",
      actor: { kind: "member", memberId: first.ref.id },
      selection: { memberId: first.ref.id },
    });

    await expect(service.previewIdentityActivity({
      operationId: "identity_deactivate_selected",
      action: { kind: "member.deactivate", memberId: first.ref.id },
      expectedRevisions: [{
        target: { kind: "artifact", path: first.sourcePath },
        revision: first.revision,
      }],
    })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

    await expect(service.previewIdentityActivity({
      operationId: "identity_forbid_update_deactivate",
      action: { kind: "member.update", memberId: first.ref.id, patch: { active: false } },
      expectedRevisions: [{
        target: { kind: "artifact", path: first.sourcePath },
        revision: first.revision,
      }],
    } as any)).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });

    const selectionRevision = current.selection!.revision;
    const clear = await service.previewIdentityActivity({
      operationId: "identity_clear",
      action: { kind: "member.clear" },
      expectedRevisions: [{
        target: { kind: "local", namespace: "member-selection", id: "current" },
        revision: selectionRevision,
      }],
    });
    await service.applyIdentityActivity(clear);
    expect((await service.getCurrentActor()).selection).toBeNull();
    expect(activityFiles(root)).toHaveLength(2);

    const deactivate = await service.previewIdentityActivity({
      operationId: "identity_deactivate",
      action: { kind: "member.deactivate", memberId: first.ref.id },
      expectedRevisions: [{
        target: { kind: "artifact", path: first.sourcePath },
        revision: first.revision,
      }],
    });
    const deactivated = await service.applyIdentityActivity(deactivate);
    expect(deactivated).toMatchObject({
      artifacts: [{ active: false }],
      events: [{ action: "member.deactivated" }],
    });
    expect(activityFiles(root)).toHaveLength(3);
  });

  it("provides bounded filtered member and fail-closed canonical Activity reads", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const service = port(root, git, {
      memberIds: [MEMBER_IDS[0], MEMBER_IDS[1]],
      eventIds: [EVENT_IDS[0], EVENT_IDS[1], EVENT_IDS[2]],
    });
    await service.applyIdentityActivity(await service.previewIdentityActivity(
      addMember("identity_reads_first", "Ada Lovelace"),
    ));
    await service.applyIdentityActivity(await service.previewIdentityActivity({
      ...addMember("identity_reads_second", "Grace Hopper"),
      action: {
        kind: "member.add",
        member: { displayName: "Grace Hopper", gitAliases: [], active: false },
      },
    }));
    await service.applyIdentityActivity(await service.previewIdentityActivity({
      operationId: "identity_direct_activity",
      action: {
        kind: "activity.record",
        activity: {
          action: "activity.recorded",
          subjects: [{ kind: "file", path: "src/index.ts" }],
        },
      },
      expectedRevisions: [],
    }));

    const active = await service.listMembers({ active: true, limit: 1 });
    expect(active.items.map((member) => member.ref.id)).toEqual([MEMBER_IDS[0]]);
    const inactive = await service.listMembers({ active: false, limit: 1 });
    expect(inactive.items.map((member) => member.ref.id)).toEqual([MEMBER_IDS[1]]);
    const firstPage = await service.listMembers({ limit: 1 });
    expect(firstPage.nextCursor).not.toBeNull();
    const secondPage = await service.listMembers({
      limit: 1,
      cursor: firstPage.nextCursor!,
    });
    expect(secondPage.items[0]!.ref.id).toBe(MEMBER_IDS[1]);
    await expect(service.listMembers({
      active: true,
      cursor: firstPage.nextCursor!,
    })).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });

    const activity = await service.listActivity({ limit: 2 });
    expect(activity.items).toHaveLength(2);
    expect(activity.nextCursor).not.toBeNull();
    expect(await service.getActivity(EVENT_IDS[2])).toMatchObject({
      id: EVENT_IDS[2],
      action: "activity.recorded",
    });
  });

  it("enforces the envelope and receipt bounds before any apply write", async () => {
    const root = temporaryRoot();
    const service = port(root, fakeGit(), {
      memberIds: [MEMBER_IDS[0]],
      eventIds: [EVENT_IDS[0]],
    });
    const oversized = addMember("identity_oversized", "x".repeat(70 * 1024)) as any;
    await expect(service.previewIdentityActivity(oversized)).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    expect(existsSync(signerPath(root))).toBe(false);

    const envelope = await service.previewIdentityActivity(
      addMember("identity_receipt_bound", "Ada Lovelace"),
    );
    const tooMany = structuredClone(envelope) as any;
    tooMany.receipt.purposeIds.push({ purpose: "member", id: MEMBER_IDS[1] });
    await expect(service.applyIdentityActivity(tooMany)).rejects.toMatchObject({
      problem: { code: "INVALID_REQUEST" },
    });
    expect(existsSync(join(root, ".mex/local/team.db"))).toBe(false);
  });
});

interface FakeGit extends GitPort {
  state: RepoState;
  identity: { name: string; email: string };
}

function port(
  root: string,
  git: FakeGit,
  options: {
    now?: string;
    clock?: () => Date;
    pid?: number;
    memberIds?: readonly string[];
    eventIds?: readonly string[];
    phaseHook?: RepositoryTeamWorkflowPortOptions<JsonValue>["phaseHook"];
  } = {},
): RepositoryTeamWorkflowPort<JsonValue, unknown> {
  const member = queue(options.memberIds ?? []);
  const event = queue(options.eventIds ?? []);
  const currentDate = options.clock ?? (() => new Date(options.now ?? NOW));
  return createRepositoryTeamWorkflowPortWithDependencies(root, {
    scaffoldId: "identity_activity_test_scaffold",
    wiki: new MockWikiPort({ now: () => currentDate().toISOString() }) as unknown as WikiPort<unknown, JsonValue, unknown, unknown>,
    git,
    now: currentDate,
    pid: options.pid ?? 100,
    processStatus: () => "dead",
    phaseHook: options.phaseHook,
    idFactories: {
      member,
      activity: event,
      leaseToken: () => "a".repeat(64),
    },
  });
}

function addMember(
  operationId: string,
  displayName: string,
): TeamIdentityActivityCommand {
  return {
    operationId,
    action: {
      kind: "member.add",
      member: { displayName, gitAliases: [] },
    },
    expectedRevisions: [],
  };
}

function fakeGit(): FakeGit {
  const git: FakeGit = {
    identity: { name: "Ada", email: "ada@example.test" },
    state: {
      branch: "feature/team-identity",
      head: HEAD,
      dirty: false,
      observedAt: NOW,
    },
    async getRepoState() { return structuredClone(git.state); },
    async getIdentity() { return structuredClone(git.identity); },
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
  return git;
}

function queue(values: readonly string[]): () => string {
  let offset = 0;
  return () => {
    const value = values[offset];
    if (value === undefined) throw new Error("unexpected generated ID");
    offset += 1;
    return value;
  };
}

function failId(prefix: "member" | "event"): string {
  return `${prefix}_01ARZ3NDEKTSV4RRFFQ69G5FZZ`;
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-team-identity-activity-"));
  roots.push(root);
  return root;
}

function activityFiles(root: string): readonly string[] {
  const directory = join(root, ".mex/events/activity", NOW.slice(0, 7));
  return existsSync(directory) ? readdirSync(directory).sort() : [];
}

function signerPath(root: string): string {
  return join(root, ...TEAM_RECEIPT_SIGNER_RELATIVE_PATH.split("/"));
}

function id(prefix: "member" | "event", entropy: number): string {
  return generateArtifactId(prefix, {
    now: Date.parse(NOW),
    random: new Uint8Array(10).fill(entropy),
  });
}
