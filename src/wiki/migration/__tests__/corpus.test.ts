/**
 * The tier-1 migration corpus, and the two things that make it an oracle.
 *
 * It is generated (`scripts/generate-wiki-migration-corpus.mjs`) to match a
 * committed shape census (plan section 6a condition 2), and it must contain
 * nothing that has already been migrated — a migration test over an
 * already-migrated corpus passes and proves nothing (finding 28).
 *
 * This file lands in the corpus commit, **before the classifier exists**, which
 * is condition 1: a fixture written after the rules is a fixture shaped to pass
 * them.
 */
import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { isEntityId } from "../../model/ids.js";

const REPO_ROOT = resolve(__dirname, "..", "..", "..", "..");
const CORPUS = join(REPO_ROOT, "test", "fixtures", "wiki", "migration", "tier1");
const CENSUS = join(REPO_ROOT, "test", "fixtures", "wiki", "migration", "census.json");
const CENSUS_SCRIPT = join(REPO_ROOT, "scripts", "wiki-scaffold-census.mjs");

function markdownFiles(directory: string, out: string[] = []): string[] {
  for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    const absolute = join(directory, entry.name);
    if (entry.isDirectory()) markdownFiles(absolute, out);
    else if (entry.name.endsWith(".md")) out.push(absolute);
  }
  return out;
}

const FILES = markdownFiles(CORPUS);
const RELATIVE = FILES.map((path) => relative(CORPUS, path).split(sep).join("/"));

/** Histograms are compared as maps: key order is not a fact, and absent is 0. */
function sameCounts(actual: unknown, expected: unknown): boolean {
  if (typeof actual !== "object" || typeof expected !== "object" || actual === null || expected === null) {
    return JSON.stringify(actual) === JSON.stringify(expected);
  }
  const keys = new Set([...Object.keys(actual), ...Object.keys(expected)]);
  for (const key of keys) {
    const a = (actual as Record<string, number>)[key] ?? 0;
    const b = (expected as Record<string, number>)[key] ?? 0;
    if (a !== b) return false;
  }
  return true;
}

describe("the tier-1 migration corpus", () => {
  it("is not empty, and is the size the census declares", () => {
    // Everything below compares counts. If the walk found nothing, every
    // comparison would be over an empty set and would pass for the wrong
    // reason.
    expect(FILES.length).toBe(25);
    expect(RELATIVE).toContain("context/decisions.md");
    expect(RELATIVE).toContain("patterns/INDEX.md");
  });

  it("matches the committed shape census", () => {
    // Run the committed instrument, exactly as a user would, rather than a
    // second implementation of it that could drift.
    const output = execFileSync(process.execPath, [CENSUS_SCRIPT, CORPUS], { encoding: "utf-8" });
    const actual = JSON.parse(output) as Record<string, unknown>;
    const expected = JSON.parse(readFileSync(CENSUS, "utf-8")) as Record<string, unknown>;

    const mismatched: string[] = [];
    for (const key of Object.keys(expected)) {
      if (key === "schema" || key === "provenance") continue;
      if (!sameCounts(actual[key], expected[key])) {
        mismatched.push(`${key}: census ${JSON.stringify(expected[key])} but corpus ${JSON.stringify(actual[key])}`);
      }
    }
    expect(mismatched, "regenerate the corpus, or update the census deliberately").toEqual([]);
  });

  it("carries no valid entity id and no `mex:` key — it has not already been migrated", () => {
    // Finding 28's shape. Without this, every migration assertion downstream
    // could be measuring a corpus that arrived already finished.
    const offenders: string[] = [];
    for (const path of FILES) {
      const text = readFileSync(path, "utf-8");
      const name = relative(CORPUS, path).split(sep).join("/");
      for (const token of text.match(/mx_[0-9A-Za-z]+/g) ?? []) {
        if (isEntityId(token)) offenders.push(`${name} declares a valid entity id ${token}`);
      }
      if (/^mex:/m.test(text) || text.includes("<!-- mex:entity")) offenders.push(`${name} already carries mex metadata`);
    }
    expect(offenders).toEqual([]);
  });

  it("carries the legacy shapes migration exists to convert", () => {
    const texts = new Map(FILES.map((path) => [relative(CORPUS, path).split(sep).join("/"), readFileSync(path, "utf-8")]));
    const withEdges = [...texts.values()].filter((text) => /^edges:/m.test(text));
    const withGrounds = [...texts.entries()].filter(([, text]) => /^grounds_to:/m.test(text)).map(([name]) => name);

    expect(withEdges.length).toBe(21);
    // One on a file that will yield several entities (ambiguous, section 9.4)
    // and one on a file that will yield exactly one (unambiguous).
    expect(withGrounds.sort()).toEqual(["context/architecture.md", "patterns/add-queue-rule.md"]);
    expect([...texts.values()].filter((text) => text.includes("](mex://")).length).toBe(2);
    // The nested-deeper case: `###` decisions inside a `##` container.
    expect(texts.get("context/decisions.md")).toMatch(/^### Store raw mail before parsing it$/m);
  });

  it("is byte-identical to what the generator produces", () => {
    // Determinism: a generator with a clock or a random seed would make the
    // fixture drift on its own, and the census assertion above would then be
    // measuring whichever run happened last.
    const before = new Map(FILES.map((path) => [path, readFileSync(path, "utf-8")]));
    execFileSync(process.execPath, [join(REPO_ROOT, "scripts", "generate-wiki-migration-corpus.mjs")], { encoding: "utf-8" });
    for (const [path, text] of before) {
      expect(readFileSync(path, "utf-8"), `${relative(CORPUS, path)} changed when regenerated`).toBe(text);
    }
    expect(markdownFiles(CORPUS).length).toBe(before.size);
  });

  it("has no CRLF or BOM in tier 1 — those belong to tier 3, deliberately", () => {
    for (const path of FILES) {
      const text = readFileSync(path, "utf-8");
      expect(text.includes("\r\n"), `${relative(CORPUS, path)} has CRLF`).toBe(false);
      expect(text.charCodeAt(0) === 0xfeff, `${relative(CORPUS, path)} has a BOM`).toBe(false);
    }
    expect(statSync(CORPUS).isDirectory()).toBe(true);
  });
});
