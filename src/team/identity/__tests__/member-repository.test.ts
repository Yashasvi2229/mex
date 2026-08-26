import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { memberArtifactPath, serializeMemberArtifact } from "../../artifacts/codecs.js";
import { atomicCreateArtifact, atomicReplaceArtifact } from "../../artifacts/filesystem.js";
import { generateArtifactId } from "../../artifacts/ulid.js";
import { MemberRepository } from "../member-repository.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("MemberRepository", () => {
  it("previews exact create bytes and diff without writing, then requires the approved preview", async () => {
    const root = temporaryRoot();
    const id = memberId(0);
    const repository = new MemberRepository(root);
    const preview = await repository.previewCreate({
      id,
      displayName: "Preview Only",
      gitAliases: [],
    });

    expect(preview.change).toMatchObject({
      kind: "create",
      path: memberArtifactPath(id),
      beforeRevision: null,
      afterRevision: preview.member.revision,
    });
    expect(preview.change.diff).toContain(`--- /dev/null\n+++ b/${memberArtifactPath(id)}`);
    expect(() => statSync(join(root, ".mex"))).toThrow();

    await expect(repository.apply(preview, "f".repeat(64))).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect(() => statSync(join(root, ".mex"))).toThrow();

    const applied = await repository.apply(preview, preview.previewRevision);
    expect(applied.member.ref.id).toBe(id);
    expect(readFileSync(join(root, ...applied.change.path.split("/")), "utf8")).toBe(preview.document);
  });

  it("keeps missing reads non-mutating and creates one canonical file per member", async () => {
    const root = temporaryRoot();
    const firstId = memberId(1);
    const secondId = memberId(2);
    const repository = new MemberRepository(root, { idFactory: () => firstId });

    expect(await repository.get(firstId)).toBeNull();
    expect(await repository.list()).toEqual([]);
    expect(() => statSync(join(root, ".mex"))).toThrow();

    const first = await repository.create({
      displayName: "Ada Lovelace",
      gitAliases: [{ name: "Ada", email: "ada@example.com" }],
    });
    const second = await repository.create({
      id: secondId,
      displayName: "Grace Hopper",
      gitAliases: [{ name: "Grace", email: "grace@example.com" }],
      active: false,
    });

    expect(first.ref.id).toBe(firstId);
    expect(second.active).toBe(false);
    expect(readFileSync(join(root, ...first.sourcePath.split("/")), "utf8")).toBe(
      serializeMemberArtifact({
        id: firstId,
        displayName: "Ada Lovelace",
        gitAliases: [{ name: "Ada", email: "ada@example.com" }],
        active: true,
      }),
    );
    expect((await repository.list()).map((member) => member.ref.id)).toEqual([firstId, secondId]);
  });

  it("updates only the expected exact revision and leaves stale writes untouched", async () => {
    const root = temporaryRoot();
    const id = memberId(3);
    const repository = new MemberRepository(root);
    const created = await repository.create({ id, displayName: "Lin", gitAliases: [] });

    const updated = await repository.update(id, { displayName: "Lin Chen", active: false }, created.revision);
    expect(updated).toMatchObject({ displayName: "Lin Chen", active: false });
    await expect(repository.update(id, { displayName: "stale" }, created.revision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect((await repository.get(id))?.displayName).toBe("Lin Chen");

    const noOp = await repository.update(id, {}, updated.revision);
    expect(noOp.revision).toBe(updated.revision);
  });

  it("rejects a stale update preview without changing the newer member", async () => {
    const root = temporaryRoot();
    const id = memberId(7);
    const repository = new MemberRepository(root);
    const created = await repository.create({ id, displayName: "Before", gitAliases: [] });
    const preview = await repository.previewUpdate(id, { displayName: "Preview" }, created.revision);
    const concurrent = serializeMemberArtifact({
      id,
      displayName: "Concurrent",
      gitAliases: [],
      active: true,
    });
    atomicReplaceArtifact(root, created.sourcePath, created.revision, concurrent);

    await expect(repository.apply(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "REVISION_CONFLICT" },
    });
    expect((await repository.get(id))?.displayName).toBe("Concurrent");
  });

  it("rechecks alias uniqueness under the apply lock", async () => {
    const root = temporaryRoot();
    const candidateId = memberId(8);
    const mergedId = memberId(9);
    const repository = new MemberRepository(root);
    const preview = await repository.previewCreate({
      id: candidateId,
      displayName: "Candidate",
      gitAliases: [{ name: "Candidate", email: "shared@example.com" }],
    });
    const mergedPath = memberArtifactPath(mergedId);
    atomicCreateArtifact(root, mergedPath, serializeMemberArtifact({
      id: mergedId,
      displayName: "Merged Teammate",
      gitAliases: [{ name: "Merged", email: "SHARED@example.com" }],
      active: true,
    }));

    await expect(repository.apply(preview, preview.previewRevision)).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
    expect(await repository.get(candidateId)).toBeNull();
    expect((await repository.get(mergedId))?.displayName).toBe("Merged Teammate");
  });

  it("rejects duplicate email ownership case-insensitively", async () => {
    const root = temporaryRoot();
    const repository = new MemberRepository(root);
    await repository.create({
      id: memberId(4),
      displayName: "First",
      gitAliases: [{ name: "First", email: "PERSON@example.com" }],
    });

    await expect(repository.create({
      id: memberId(5),
      displayName: "Second",
      gitAliases: [{ name: "Second", email: "person@EXAMPLE.com" }],
    })).rejects.toMatchObject({ problem: { code: "VALIDATION_FAILED" } });
    expect(await repository.get(memberId(5))).toBeNull();
  });

  it("fails visibly on malformed canonical member files", async () => {
    const root = temporaryRoot();
    const id = memberId(6);
    const path = memberArtifactPath(id);
    const absolute = join(root, ...path.split("/"));
    mkdirSync(join(root, ".mex", "team", "members"), { recursive: true });
    writeFileSync(absolute, `${serializeMemberArtifact({
      id,
      displayName: "Malformed",
      gitAliases: [],
      active: true,
    })}body\n`, "utf8");

    const repository = new MemberRepository(root);
    await expect(repository.list()).rejects.toMatchObject({
      problem: { code: "VALIDATION_FAILED" },
    });
  });
});

function memberId(fill: number): string {
  return generateArtifactId("member", {
    now: Date.UTC(2026, 7, 23),
    random: new Uint8Array(10).fill(fill),
  });
}

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-members-"));
  roots.push(root);
  return root;
}
