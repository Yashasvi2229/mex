import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readLegacyTimeline } from "../legacy.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("readLegacyTimeline", () => {
  it("normalizes valid rows, diagnoses malformed and duplicate rows, and writes nothing", () => {
    const root = temporaryRoot();
    const eventsDir = join(root, ".mex", "events");
    mkdirSync(eventsDir, { recursive: true });
    const file = join(eventsDir, "decisions.jsonl");
    const valid = JSON.stringify({
      timestamp: "2026-08-23T01:02:03.000Z",
      kind: "decision",
      message: "Use immutable activity files",
      files: ["src/events.ts", 1],
      cwd: ".",
      source: "meeting",
    });
    writeFileSync(file, `${valid}\nnot-json\n${valid}\n`, "utf8");
    const before = readFileSync(file);
    const beforeStat = statSync(file);

    const result = readLegacyTimeline(root);

    expect(result.entries).toHaveLength(2);
    expect(result.entries[0]).toMatchObject({
      source: "legacy",
      actor: null,
      repoState: null,
      kind: "decision",
      message: "Use immutable activity files",
      files: ["src/events.ts"],
      origin: "meeting",
      sourceLine: 1,
    });
    expect(result.entries[0]?.id).toMatch(/^legacy_[a-f0-9]{64}$/);
    expect(result.entries[1]?.id).not.toBe(result.entries[0]?.id);
    expect(result.diagnostics.map((item) => item.code)).toEqual([
      "LEGACY_ACTIVITY_MALFORMED",
      "LEGACY_ACTIVITY_DUPLICATE",
    ]);
    expect(result.truncated).toBe(false);
    expect(readFileSync(file)).toEqual(before);
    expect(statSync(file).mtimeMs).toBe(beforeStat.mtimeMs);
  });

  it("normalizes offset timestamps before chronological ordering", () => {
    const root = temporaryRoot();
    const eventsDir = join(root, ".mex", "events");
    mkdirSync(eventsDir, { recursive: true });
    writeFileSync(join(eventsDir, "decisions.jsonl"), `${JSON.stringify({
      timestamp: "2026-08-23T06:32:03+05:30",
      kind: "note",
      message: "offset",
      files: [],
    })}\n`, "utf8");

    expect(readLegacyTimeline(root).entries[0]?.timestamp).toBe("2026-08-23T01:02:03.000Z");
  });

  it("uses byte offsets for stable IDs with multibyte preceding lines", () => {
    const root = temporaryRoot();
    const eventsDir = join(root, ".mex", "events");
    mkdirSync(eventsDir, { recursive: true });
    const file = join(eventsDir, "decisions.jsonl");
    const rows = ["not-json-😀", JSON.stringify({
      timestamp: "2026-08-23T01:02:03.000Z",
      kind: "note",
      message: "stable",
      files: [],
    })];
    writeFileSync(file, `${rows.join("\n")}\n`, "utf8");

    const first = readLegacyTimeline(root);
    const second = readLegacyTimeline(root);

    expect(first.entries[0]?.id).toBe(second.entries[0]?.id);
    expect(first.entries[0]?.sourceLine).toBe(2);
  });

  it("refuses a legacy file that escapes through a symlink", () => {
    const root = temporaryRoot();
    const outside = temporaryRoot();
    mkdirSync(join(root, ".mex"), { recursive: true });
    mkdirSync(join(outside, "events"), { recursive: true });
    writeFileSync(join(outside, "events", "decisions.jsonl"), "{}\n", "utf8");
    symlinkSync(join(outside, "events"), join(root, ".mex", "events"));

    const result = readLegacyTimeline(root);

    expect(result.entries).toEqual([]);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "PATH_OUTSIDE_PROJECT" }),
    ]);
    expect(lstatSync(join(root, ".mex", "events")).isSymbolicLink()).toBe(true);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-lane-c-legacy-"));
  roots.push(root);
  return root;
}
