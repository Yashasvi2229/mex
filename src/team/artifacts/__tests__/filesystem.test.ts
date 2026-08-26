import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { RepoRelativePath } from "../../contracts/shared.js";
import {
  atomicCreateArtifact,
  atomicReplaceArtifact,
  readContainedArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../filesystem.js";
import { revisionOf } from "../revision.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contained atomic artifact I/O", () => {
  it("publishes complete bytes, refuses overwrite, and preserves stale revisions", () => {
    const root = temporaryRoot();
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;
    const first = "first\n";
    const second = "second\n";

    expect(tryReadContainedArtifact(root, path, 100)).toBeNull();
    expect(existsSync(join(root, ".mex"))).toBe(false);
    expect(atomicCreateArtifact(root, path, first)).toBe(revisionOf(first));
    expect(readContainedArtifact(root, path, 100)).toMatchObject({ revision: revisionOf(first) });
    expect(() => atomicCreateArtifact(root, path, "overwrite\n")).toThrow(/already exists/);
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(first);

    expect(atomicReplaceArtifact(root, path, revisionOf(first), second)).toBe(revisionOf(second));
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(second);
    expect(() => atomicReplaceArtifact(root, path, revisionOf(first), "stale\n")).toThrow(/expected revision/);
    expect(readFileSync(join(root, ...path.split("/")), "utf8")).toBe(second);
    expect(readdirSync(dirname(join(root, ...path.split("/")))).every(
      (name) => !name.includes("mex-tmp") && !name.includes("mex-lock"),
    )).toBe(true);
  });

  it("does not remove another writer's lock", () => {
    const root = temporaryRoot();
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;
    atomicCreateArtifact(root, path, "first\n");
    const lock = join(root, ".mex/team/members", `.${path.split("/").at(-1)}.mex-lock`);
    writeFileSync(lock, "other writer\n");

    expect(() => atomicReplaceArtifact(root, path, revisionOf("first\n"), "second\n")).toThrow(/locked/);
    expect(readFileSync(lock, "utf8")).toBe("other writer\n");
  });

  it("rejects a concurrent collection lock without removing the active writer's lock", async () => {
    const root = temporaryRoot();
    const directory = ".mex/team/members" as RepoRelativePath;
    const lockPath = join(root, directory, ".members.mex-lock");
    let enterFirst!: () => void;
    let releaseFirst!: () => void;
    const firstEntered = new Promise<void>((resolve) => { enterFirst = resolve; });
    const firstReleased = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = withContainedArtifactLock(
      root,
      directory,
      ".members.mex-lock",
      async () => {
        enterFirst();
        await firstReleased;
        return "first complete";
      },
    );

    await firstEntered;
    const heldLockBytes = readFileSync(lockPath, "utf8");
    try {
      await expect(withContainedArtifactLock(
        root,
        directory,
        ".members.mex-lock",
        () => "second complete",
      )).rejects.toMatchObject({ problem: { code: "REVISION_CONFLICT" } });
      expect(readFileSync(lockPath, "utf8")).toBe(heldLockBytes);
    } finally {
      releaseFirst();
    }

    await expect(first).resolves.toBe("first complete");
    expect(existsSync(lockPath)).toBe(false);
  });

  it("rejects lexical escapes and symlinked ancestors without touching the target", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, ".mex"));
    mkdirSync(join(outside, "team", "members"), { recursive: true });
    symlinkSync(outside, join(root, ".mex", "team"), process.platform === "win32" ? "junction" : "dir");
    const path = ".mex/team/members/member_00000000000000000000000000.md" as RepoRelativePath;

    expect(() => atomicCreateArtifact(root, path, "secret\n")).toThrow(/Path component|Unsafe/);
    expect(existsSync(join(outside, "team", "members", path.split("/").at(-1)!))).toBe(false);
    expect(lstatSync(join(root, ".mex", "team")).isSymbolicLink()).toBe(true);
    expect(() => atomicCreateArtifact(
      root,
      "../outside.md" as RepoRelativePath,
      "escape\n",
    )).toThrow(/repository-relative/);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-artifacts-"));
  roots.push(root);
  return root;
}
