// ============================================================================
// mex code-graph — symbol-lookup search tests
// ============================================================================
//
// Every case here is a claim about `GraphStore.search` that failed before the
// pool was ranked by match class, measured on a real index built from the
// checked-in fixtures — no mocks, no external checkout.
//
// The headline claim is the one in `fixtures/symbol-lookup-cases.json`: asking
// the graph for a symbol's own name returns that symbol first. It used to
// return the file the symbol lives in, that file's test file, or one of the
// symbol's own methods. That fixture carries cases for other languages too;
// they run in `engine-python.test.ts` and `engine-rust.test.ts`, because a
// single test process holds one grammar comfortably and not three.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import type { GraphNode } from "../types.js";
import cases from "./fixtures/symbol-lookup-cases.json" with { type: "json" };

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const typescriptCases = cases.filter((testCase) => testCase.corpus === "typescript");

let root: string;
let engine: GraphEngine;

/**
 * Copy the TypeScript fixtures this file needs — deliberately few. A graph
 * build holds every parsed syntax tree for the length of the build, so a test
 * process that indexes a large corpus runs out of memory; the existing engine
 * tests keep their corpora to a handful of files for the same reason.
 */
function buildCorpus(): string {
  const dir = mkdtempSync(join(tmpdir(), "mex-search-"));
  mkdirSync(join(dir, "payments"), { recursive: true });
  cpSync(join(FIXTURES, "payments"), join(dir, "payments"), { recursive: true });
  cpSync(join(FIXTURES, "sample.ts"), join(dir, "sample.ts"));
  return dir;
}

beforeAll(async () => {
  root = buildCorpus();
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
}, 60_000);

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

const search = (query: string, limit = 20): GraphNode[] => engine.searchNodes(query, { limit });
const names = (query: string, limit = 20): string[] => search(query, limit).map((node) => node.name);

describe("exact-name lookup", () => {
  // The control: one case per language, each naming a symbol the corpus
  // declares. `maxRank` is 1 everywhere — "the thing you named comes first" is
  // the whole contract.
  it.each(typescriptCases)("$id: $query returns $expect.name at rank <= $maxRank", (testCase) => {
    const results = search(testCase.query);
    const rank =
      results.findIndex(
        (node) =>
          node.name === testCase.expect.name &&
          (testCase.expect.kind === undefined || node.kind === testCase.expect.kind),
      ) + 1;
    expect(rank, `${testCase.expect.name} not found for "${testCase.query}"`).toBeGreaterThan(0);
    expect(rank).toBeLessThanOrEqual(testCase.maxRank);
  });

  it("ranks a class above its own methods", () => {
    const results = search("PaymentProcessor");
    const owner = results.findIndex((node) => node.name === "PaymentProcessor" && node.kind === "class");
    const members = results.findIndex((node) => node.qualifiedName.startsWith("PaymentProcessor::"));
    expect(owner).toBeGreaterThanOrEqual(0);
    expect(members, "expected the class's members in the results too").toBeGreaterThanOrEqual(0);
    expect(owner).toBeLessThan(members);
  });

  it("ranks an exact name above a longer name sharing its prefix", () => {
    const results = names("PaymentProcessor");
    expect(results.indexOf("PaymentProcessor")).toBeLessThan(results.indexOf("PaymentProcessorFactory"));
  });

  it("prefers the symbol over the file that declares it", () => {
    const results = search("PaymentProcessor");
    const symbol = results.findIndex((node) => node.name === "PaymentProcessor" && node.kind === "class");
    const files = results.map((node, index) => (node.kind === "file" ? index : -1)).filter((i) => i >= 0);
    expect(symbol).toBe(0);
    for (const file of files) expect(file).toBeGreaterThan(symbol);
  });

  it("still resolves a file node when the query names the file", () => {
    // `mex graph query` resolves a file target through this same search, so
    // demoting `file:` nodes may not cost the lookup that genuinely wants one.
    const [top] = search("payments/PaymentProcessor.ts");
    expect(top?.kind).toBe("file");
    expect(top?.filePath).toBe("payments/PaymentProcessor.ts");
    expect(search("PaymentProcessor.ts")[0]?.kind).toBe("file");
  });

  it("ranks a source node above an equivalent node in a test file", () => {
    const results = search("PaymentProcessor");
    const source = results.findIndex((node) => node.filePath === "payments/PaymentProcessor.ts");
    const test = results.findIndex((node) => node.filePath.includes("/tests/"));
    expect(source).toBeGreaterThanOrEqual(0);
    expect(test, "expected the test file's nodes in the results too").toBeGreaterThanOrEqual(0);
    expect(source).toBeLessThan(test);
    // Demoted, never dropped: a query for the test's own symbol still finds it.
    expect(names("checkCharge")[0]).toBe("checkCharge");
  });
});

describe("query planning", () => {
  it("returns results for a query made entirely of stopwords", () => {
    // The all-stopword fallback: filtering leaves nothing, so the unfiltered
    // terms are searched instead. A bad ranking beats an empty answer.
    expect(search("how does it work").length).toBeGreaterThan(0);
    expect(search("what is the class").length).toBeGreaterThan(0);
  });

  it("does not let a stopword outrank the real term it was typed with", () => {
    // Regression test for the reported natural-language failure: task words
    // (`the`, `how`, `of`) collided with real identifiers and buried the target.
    // `THE_DEFAULT_TIMEOUT` indexes a `the` token, and used to win on it.
    const results = names("how is the charge computed");
    expect(results[0]).toBe("charge");
    expect(results.indexOf("THE_DEFAULT_TIMEOUT")).not.toBe(0);
  });

  it("returns nothing for a query with no searchable terms", () => {
    expect(search("")).toEqual([]);
    expect(search("   ")).toEqual([]);
    expect(search("*(:^-")).toEqual([]);
  });

  it("survives punctuation that FTS5 would read as syntax", () => {
    expect(() => search('"quoted" AND (Greeter OR NEAR)')).not.toThrow();
    expect(() => search("{ PaymentProcessor }")).not.toThrow();
    expect(names('"quoted" AND (Greeter OR NEAR)')).toContain("Greeter");
  });
});

describe("substring tier", () => {
  it("finds a fragment prefix search misses, even when FTS returned rows", () => {
    // `serby` is inside `getUserById` but starts no token, so no prefix search
    // can reach it. The tier used to run only when FTS returned nothing at all.
    const results = names("Greeter serby");
    expect(results).toContain("Greeter");
    expect(results).toContain("getUserById");
  });
});
