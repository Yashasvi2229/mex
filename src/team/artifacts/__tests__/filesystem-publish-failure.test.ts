import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { memberArtifactPath, serializeMemberArtifact } from "../codecs.js";
import {
  atomicCreateArtifact,
  atomicReplaceArtifact,
} from "../filesystem.js";
import { revisionOf } from "../revision.js";
import { generateArtifactId } from "../ulid.js";

const publicationFault = vi.hoisted(() => ({ enabled: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    renameSync(source: Parameters<typeof actual.renameSync>[0], target: Parameters<typeof actual.renameSync>[1]) {
      if (publicationFault.enabled && String(source).includes(".mex-tmp-")) {
        throw Object.assign(new Error("injected publication failure"), { code: "EIO" });
      }
      return actual.renameSync(source, target);
    },
  };
});

const roots: string[] = [];

afterEach(() => {
  publicationFault.enabled = false;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("contained artifact publication failure", () => {
  it("preserves canonical bytes and removes staged and lock files when replacement fails", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-artifact-publish-failure-"));
    roots.push(root);
    const id = generateArtifactId("member", {
      now: Date.UTC(2026, 7, 23),
      random: new Uint8Array(10).fill(7),
    });
    const path = memberArtifactPath(id);
    const absolutePath = join(root, ...path.split("/"));
    const before = serializeMemberArtifact({
      id,
      displayName: "Before Publish",
      gitAliases: [],
      active: true,
    });
    const after = serializeMemberArtifact({
      id,
      displayName: "After Publish",
      gitAliases: [],
      active: true,
    });
    atomicCreateArtifact(root, path, before);

    publicationFault.enabled = true;
    expect(() => atomicReplaceArtifact(root, path, revisionOf(before), after, 64 * 1024))
      .toThrow(/injected publication failure/);
    publicationFault.enabled = false;

    expect(readFileSync(absolutePath, "utf8")).toBe(before);
    expect(readdirSync(dirname(absolutePath))).toEqual([`${id}.md`]);
  });
});
