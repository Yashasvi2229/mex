// ============================================================================
// mex code-graph — search planning + ranking (mechanism tests)
// ============================================================================
//
// The measured defect, reproduced against a hand-written index: every node that
// outranked an exact-name match on a real corpus was a `file:` node, a node in
// a test file, or a member of the target itself. The nodes below are those
// three shapes plus the two the ranking has to keep working — a longer name
// sharing the query's prefix, and a symbol reachable only by substring.
//
// Written against `GraphStore` directly rather than through a graph build: the
// claims are about SQL tiers and ordering, and a hand-written index states the
// shape being tested in one screen.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openGraphDatabase } from "../db/database.js";
import { GraphStore } from "../db/store.js";
import { planQuery } from "../search/query.js";
import { isTestPath, rankCandidates, unmatchedTerms, type SearchCandidate } from "../search/rank.js";
import type { GraphNode, NodeKind } from "../types.js";

const SOURCE = "src/payments/PaymentProcessor.ts";
const SPEC = "src/payments/PaymentProcessor.spec.ts";

function node(id: string, kind: NodeKind, name: string, qualifiedName: string, filePath: string): GraphNode {
  return {
    id, kind, name, qualifiedName, filePath, language: "typescript",
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 1,
  };
}

/** The corpus: one class, its members, its file, its spec file, and neighbours. */
const NODES: GraphNode[] = [
  node("file:source", "file", "PaymentProcessor.ts", SOURCE, SOURCE),
  node("file:spec", "file", "PaymentProcessor.spec.ts", SPEC, SPEC),
  node("class:processor", "class", "PaymentProcessor", "PaymentProcessor", SOURCE),
  node("method:charge", "method", "charge", "PaymentProcessor::charge", SOURCE),
  node("method:ctor", "method", "constructor", "PaymentProcessor::constructor", SOURCE),
  node("class:factory", "class", "PaymentProcessorFactory", "PaymentProcessorFactory", SOURCE),
  node("constant:destructured", "constant", "{ PaymentProcessor }", "{ PaymentProcessor }", SPEC),
  node("function:byid", "function", "getUserById", "getUserById", "src/users/lookup.ts"),
  node("constant:timeout", "constant", "THE_DEFAULT_TIMEOUT", "THE_DEFAULT_TIMEOUT", "src/config/values.ts"),
  node("function:refund", "function", "refundOrder", "refundOrder", "src/payments/refundOrder.ts"),
];

let store: GraphStore;
let close: () => void;

beforeAll(() => {
  const root = mkdtempSync(join(tmpdir(), "mex-search-rank-"));
  const db = openGraphDatabase(join(root, "graph.db"));
  store = new GraphStore(db);
  for (const entry of NODES) store.insertNode(entry);
  close = () => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  };
});

afterAll(() => close());

const ids = (query: string, limit = 20): string[] => store.search(query, { limit }).map((n) => n.id);

describe("exact-name lookup", () => {
  it("returns the named symbol first, ahead of its file, its spec and its members", () => {
    expect(ids("PaymentProcessor")[0]).toBe("class:processor");
  });

  it("ranks the class above every member whose qualified name carries its name", () => {
    const order = ids("PaymentProcessor");
    expect(order.indexOf("class:processor")).toBeLessThan(order.indexOf("method:charge"));
    expect(order.indexOf("class:processor")).toBeLessThan(order.indexOf("method:ctor"));
  });

  it("ranks an exact name above a longer name sharing its prefix", () => {
    const order = ids("PaymentProcessor");
    expect(order.indexOf("class:processor")).toBeLessThan(order.indexOf("class:factory"));
  });

  it("never lets a file node outrank a symbol on a symbol query", () => {
    const order = ids("PaymentProcessor");
    const symbol = order.indexOf("class:processor");
    for (const id of ["file:source", "file:spec"]) {
      expect(order.indexOf(id)).toBeGreaterThan(symbol);
    }
  });

  it("still puts the file first when the query names the file", () => {
    // `mex graph query` resolves a file target through this same search.
    expect(ids("PaymentProcessor.ts")[0]).toBe("file:source");
    expect(ids(SOURCE)[0]).toBe("file:source");
    expect(ids(`./${SOURCE}`)[0]).toBe("file:source");
  });

  it("demotes a test-file node below its source equivalent without dropping it", () => {
    const order = ids("PaymentProcessor");
    expect(order.indexOf("class:processor")).toBeLessThan(order.indexOf("constant:destructured"));
    expect(order).toContain("constant:destructured");
    expect(order).toContain("file:spec");
  });

  it("honours kind and language filters", () => {
    expect(store.search("PaymentProcessor", { kinds: ["method"] }).every((n) => n.kind === "method")).toBe(true);
    expect(store.search("PaymentProcessor", { languages: ["python"] })).toEqual([]);
  });

  it("respects the caller's limit", () => {
    expect(store.search("PaymentProcessor", { limit: 2 })).toHaveLength(2);
    // The pool is over-fetched, so a tiny limit still ranks before it slices.
    expect(store.search("PaymentProcessor", { limit: 1 })[0]?.id).toBe("class:processor");
  });
});

describe("query planning", () => {
  it("drops stopwords but keeps domain words", () => {
    const plan = planQuery("how does the payment config service work");
    expect(plan.terms.map((t) => t.term)).toEqual(["payment", "config", "service"]);
    expect(plan.dropped).toEqual(["how", "does", "the", "work"]);
    expect(plan.usedStopwordFallback).toBe(false);
  });

  it("falls back to the unfiltered terms when every word is a stopword", () => {
    const plan = planQuery("how does it work");
    expect(plan.usedStopwordFallback).toBe(true);
    expect(plan.terms.map((t) => t.term)).toEqual(["how", "does", "it", "work"]);
  });

  it("still searches when the query is nothing but stopwords", () => {
    // Filtering leaves nothing, so the unfiltered terms go to the index and the
    // query finds whatever it can — a bad ranking beats an empty answer.
    // `THE_DEFAULT_TIMEOUT` indexes a `the` token, so `the class` reaches it.
    expect(ids("the class")).toContain("constant:timeout");
  });

  it("does not let a stopword outrank the real term typed with it", () => {
    // The reported natural-language failure: task words collided with real
    // identifiers and buried the target. `THE_DEFAULT_TIMEOUT` indexes a `the`
    // token, so an unfiltered query used to return it first.
    const order = ids("how is the order refunded");
    expect(order[0]).toBe("function:refund");
    expect(order).not.toContain("constant:timeout");
  });

  it("marks identifier-shaped terms and only those", () => {
    const plan = planQuery("getUserById user_id user 42x");
    expect(plan.terms.map((t) => t.identifierLike)).toEqual([true, true, false, true]);
  });

  it("returns nothing when the query has no searchable terms", () => {
    for (const query of ["", "   ", "*(:^-", '"']) expect(store.search(query)).toEqual([]);
  });

  it("survives punctuation and barewords FTS5 would read as syntax", () => {
    expect(() => store.search('"quoted" AND (charge OR NEAR)')).not.toThrow();
    expect(() => store.search("{ PaymentProcessor }")).not.toThrow();
    expect(ids("{ PaymentProcessor }")).toContain("class:processor");
  });
});

describe("substring tier", () => {
  it("finds a fragment prefix search misses, even when other terms matched", () => {
    // `serby` sits inside `getUserById` but starts no token, so no prefix search
    // reaches it. The tier used to run only when FTS returned nothing at all.
    const order = ids("charge serby");
    expect(order).toContain("method:charge");
    expect(order).toContain("function:byid");
  });

  it("reports only the terms the pool does not already cover", () => {
    const candidates: SearchCandidate[] = [
      { id: "a", kind: "function", name: "getUserById", qualifiedName: "getUserById", filePath: "a.ts", base: 1 },
    ];
    expect(unmatchedTerms(planQuery("getuser serby missing"), candidates)).toEqual(["missing"]);
  });
});

describe("ranking rules", () => {
  const candidate = (over: Partial<SearchCandidate>): SearchCandidate => ({
    id: "id", kind: "function", name: "charge", qualifiedName: "charge", filePath: "src/a.ts", base: 1, ...over,
  });

  it("keeps a plain word in a multi-term query out of the exact-name class", () => {
    // Classified from the token as typed: `order` in a sentence is a word, and
    // a symbol that happens to spell it may not claim the top slot outright.
    const ranked = rankCandidates(
      [candidate({ id: "plain", name: "order", base: 0.1 }), candidate({ id: "strong", base: 5 })],
      planQuery("refund the order twice"),
    );
    expect(ranked[0]?.id).toBe("strong");
  });

  it("gives a one-word query its exact match regardless of score", () => {
    const ranked = rankCandidates(
      [candidate({ id: "plain", name: "order", base: 0.1 }), candidate({ id: "strong", base: 5 })],
      planQuery("order"),
    );
    expect(ranked[0]?.id).toBe("plain");
  });

  it("orders equal candidates by name length then id, so ties are stable", () => {
    const ranked = rankCandidates(
      [
        candidate({ id: "z", name: "chargeCard", base: 0 }),
        candidate({ id: "a", name: "chargeCardTwice", base: 0 }),
        candidate({ id: "b", name: "chargeCard", base: 0 }),
      ],
      planQuery("charge"),
    );
    expect(ranked.map((entry) => entry.id)).toEqual(["b", "z", "a"]);
  });

  it("recognises test paths across the languages the graph indexes", () => {
    for (const path of [
      "src/__tests__/a.ts", "src/a.spec.ts", "src/a.test.tsx",
      "tests/a.py", "pkg/test_widget.py", "src/widget_test.rs", "spec/models/a.rb",
    ]) {
      expect(isTestPath(path), path).toBe(true);
    }
    for (const path of ["src/latest.ts", "src/contest.rs", "src/attest/a.py"]) {
      expect(isTestPath(path), path).toBe(false);
    }
  });
});

describe("determinism", () => {
  it("returns the same order however the nodes were inserted", () => {
    const other = mkdtempSync(join(tmpdir(), "mex-search-rank-2-"));
    const db = openGraphDatabase(join(other, "graph.db"));
    try {
      const scrambled = new GraphStore(db);
      for (const entry of [...NODES].reverse()) scrambled.insertNode(entry);
      for (const query of ["PaymentProcessor", "charge serby", "how does it work"]) {
        expect(scrambled.search(query, { limit: 20 }).map((n) => n.id)).toEqual(ids(query));
      }
    } finally {
      db.close();
      rmSync(other, { recursive: true, force: true });
    }
  });
});
