import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type {
  GitChangedFilesRequest,
  GitDiffRequest,
  GitFileAtRevisionRequest,
  GitHistoryRequest,
  GitPort,
} from "../../contracts/git.js";
import type { RepoState } from "../../contracts/shared.js";
import { MexPortError } from "../../contracts/shared.js";
import { ActivityRepository, TimelineReader } from "../repository.js";

const roots: string[] = [];
const timestamp = "2026-08-23T01:02:03.000Z";
const firstId = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const secondId = "event_01ARZ3NDEKTSV4RRFFQ69G5FAC";

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("ActivityRepository", () => {
  it("previews without writes, captures Git state, and atomically creates an immutable event", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);

    const preview = await repository.previewCreate({
      actor: { kind: "member", memberId: "member_01ARZ3NDEKTSV4RRFFQ69G5FAV" },
      action: "member.updated",
      subjects: [{ kind: "file", path: "src/index.ts" }],
      metadata: { reason: "ownership changed" },
    });

    expect(existsSync(join(root, ".mex/events/activity"))).toBe(false);
    expect(preview.changes[0]).toMatchObject({ kind: "create", beforeRevision: null });
    const stored = await repository.applyCreate(preview, preview.previewRevision);
    expect(stored.repoState).toEqual(git.state);
    expect(repository.get(firstId)).toEqual(stored);

    await expect(repository.applyCreate(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
  });

  it("rejects stale previews before writing", async () => {
    const root = temporaryRoot();
    const git = fakeGit();
    const repository = fixedRepository(root, git, firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" },
      action: "workstream.observed",
      subjects: [],
    });

    git.state = { ...git.state, dirty: true };
    await expect(repository.applyCreate(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(existsSync(join(root, ...preview.sourcePath.split("/")))).toBe(false);
  });

  it("diagnoses malformed and conflicting canonical events", async () => {
    const root = temporaryRoot();
    const first = fixedRepository(root, fakeGit(), firstId);
    const preview = await first.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    await first.applyCreate(preview, preview.previewRevision);

    const conflictDir = join(root, ".mex/events/activity/2026-09");
    mkdirSync(conflictDir, { recursive: true });
    writeFileSync(join(conflictDir, `${firstId}.md`), readFileSync(join(root, ...preview.sourcePath.split("/")), "utf8").replace(timestamp, "2026-09-23T01:02:03.000Z"));
    writeFileSync(join(conflictDir, "bad.md"), "not-frontmatter\n");

    const read = first.readAll();
    expect(read.events).toEqual([]);
    expect(read.diagnostics.map((item) => item.code)).toContain("ACTIVITY_ID_CONFLICT");
    expect(read.diagnostics.map((item) => item.code)).toContain("ACTIVITY_ARTIFACT_UNEXPECTED");
  });

  it("combines canonical and legacy history without rewriting legacy bytes", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), secondId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    await repository.applyCreate(preview, preview.previewRevision);
    const legacyPath = join(root, ".mex/events/decisions.jsonl");
    mkdirSync(join(root, ".mex/events"), { recursive: true });
    const legacy = `${JSON.stringify({ timestamp: "2026-08-22T00:00:00.000Z", kind: "note", message: "old", files: [] })}\n`;
    writeFileSync(legacyPath, legacy, "utf8");

    const page = new TimelineReader(root, repository).list();

    expect(page.items.map((item) => item.source)).toEqual(["activity", "legacy"]);
    expect(readFileSync(legacyPath, "utf8")).toBe(legacy);
  });

  it("rejects a forged preview digest", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    await expect(repository.applyCreate(preview, "f".repeat(64))).rejects.toBeInstanceOf(MexPortError);
  });

  it("rejects caller-forged repository provenance even with an issued digest", async () => {
    const root = temporaryRoot();
    const repository = fixedRepository(root, fakeGit(), firstId);
    const preview = await repository.previewCreate({
      actor: { kind: "unknown" }, action: "workstream.observed", subjects: [],
    });
    const forged = structuredClone(preview);
    forged.event.repoState.observedAt = "2026-08-23T00:00:00.000Z";

    await expect(repository.applyCreate(forged, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(repository.list().items).toEqual([]);
  });
});

function fixedRepository(root: string, git: FakeGit, id: string): ActivityRepository {
  return new ActivityRepository({
    projectRoot: root,
    git,
    now: () => new Date(timestamp),
    generateId: () => id,
  });
}

interface FakeGit extends GitPort {
  state: RepoState;
}

function fakeGit(): FakeGit {
  const git: FakeGit = {
    state: {
      branch: "feature/team",
      head: "1".repeat(40),
      dirty: false,
      observedAt: timestamp,
    },
    async getRepoState() { return git.state; },
    async getIdentity() { return { name: "Dev", email: "dev@example.test" }; },
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

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-activity-"));
  roots.push(root);
  return root;
}
