// ============================================================================
// mex code-graph — task-scope scoring tests
// ============================================================================
//
// Each case is a claim about how `selectScope` scores a task, asserted against a
// hand-built engine so the arithmetic is visible rather than inferred from a
// corpus. The end-to-end half — the same claims over a real index built from the
// checked-in fixtures — lives in `scope-selection.test.ts`.
//
// Five of these fail against the pre-milestone scoring, which awarded every
// exact name match a flat 1.0: the corroboration cases, the rarity case, the
// test-file demotion, and the two quota cases.

import { describe, expect, it, vi } from "vitest";
import type { GraphEngine } from "../engine.js";
import { selectScope } from "../scope.js";
import { corroboration, taskCoverage, taskTerms, termWeight } from "../scope-rank.js";
import type { GraphNode } from "../types.js";

function node(name: string, extra: Partial<GraphNode> = {}): GraphNode {
  return {
    id: `function:${name}`, name, kind: "function", qualifiedName: name,
    filePath: "src/orders.ts", language: "typescript",
    startLine: 1, endLine: 2, startColumn: 0, endColumn: 1, updatedAt: 1, ...extra,
  };
}

/**
 * An engine that answers every search from one fixed corpus, ranking a hit
 * whose name or qualified name contains the query ahead of one that does not.
 * That is enough for scoring: what is under test is how `selectScope` weighs
 * the hits, not how the store finds them.
 */
function engineOver(nodes: GraphNode[]): GraphEngine {
  const matches = (n: GraphNode, q: string): boolean =>
    `${n.name} ${n.qualifiedName}`.toLowerCase().includes(q.toLowerCase());
  return {
    build: vi.fn(), sync: vi.fn(), close: vi.fn(),
    searchNodes: (query, options) => {
      const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
      return nodes
        .filter((n) => terms.some((t) => matches(n, t)))
        .sort((a, b) => terms.filter((t) => matches(b, t)).length - terms.filter((t) => matches(a, t)).length
          || a.name.length - b.name.length || a.id.localeCompare(b.id))
        .slice(0, options?.limit ?? 100);
    },
    getNode: (id) => nodes.find((n) => n.id === id) ?? null,
    getCallers: () => [], getCallees: () => [],
  };
}

const scoreOf = (result: ReturnType<typeof selectScope>, name: string): number | undefined =>
  result.candidates.find((c) => c.id === `function:${name}`)?.score;

describe("task term planning", () => {
  it("drops question grammar and one-character fragments that name nothing", () => {
    expect(taskTerms("how does the order shipment work").map((t) => t.term)).toEqual(["order", "shipment"]);
    expect(taskTerms("a b shipment").map((t) => t.term)).toEqual(["shipment"]);
  });

  it("keeps the planner's terms when the length filter would empty the task", () => {
    expect(taskTerms("a b c").length).toBeGreaterThan(0);
  });
});

describe("term weighting", () => {
  it("gives a word borne by many declarations less of the task than a rare one", () => {
    expect(termWeight(0)).toBeGreaterThan(termWeight(1));
    expect(termWeight(1)).toBeGreaterThan(termWeight(12));
    expect(termWeight(12)).toBeGreaterThan(termWeight(60));
  });

  it("saturates rather than collapsing, so no single word can carry a whole task", () => {
    expect(termWeight(1_000_000)).toBeGreaterThan(0);
    expect(termWeight(0) / termWeight(1_000_000)).toBeLessThan(30);
  });
});

describe("corroboration", () => {
  it("leaves a fully covered task at full weight — a symbol lookup is scored as before", () => {
    expect(corroboration(1, false)).toBe(1);
    expect(corroboration(1, true)).toBe(1);
  });

  it("exempts a match on an identifier the user plainly typed", () => {
    expect(corroboration(0.2, true)).toBe(1);
  });

  it("charges once, not twice, for one measurement of agreement", () => {
    // Coverage damping and the plain-word demotion read the same quantity. If
    // they compounded, a node matching a third of a task would land near 1% of
    // its base rather than near 10%.
    const third = corroboration(1 / 3, false);
    expect(third).toBeCloseTo((1 / 3) ** 2, 6);
    expect(third).toBeGreaterThan((1 / 3) ** 2 * 0.2);
  });

  it("takes the stronger charge where the demotion is the stronger one", () => {
    // Above ~0.45 coverage, squaring alone is too gentle for a one-word match.
    expect(corroboration(0.7, false)).toBe(0.2);
  });

  it("is monotonic in coverage", () => {
    const scores = [0.1, 0.3, 0.5, 0.9, 1].map((c) => corroboration(c, false));
    expect(scores).toEqual([...scores].sort((a, b) => a - b));
  });
});

describe("task coverage", () => {
  it("counts a qualified name, so a member of a well-named owner covers the task", () => {
    const terms = taskTerms("shipment tracker retry").map((t) => ({ ...t, bearers: 1, weight: 1 }));
    const member = node("retry", { qualifiedName: "ShipmentTracker::retry" });
    expect(taskCoverage(member, terms)).toBe(1);
  });

  it("is a share of the task, not a count of the node's words", () => {
    const terms = taskTerms("order shipment tracking").map((t) => ({ ...t, bearers: 1, weight: 1 }));
    expect(taskCoverage(node("shipment"), terms)).toBeCloseTo(1 / 3, 6);
  });
});

describe("scored scope selection", () => {
  const corpus = [
    node("OrderShipmentTracker", { kind: "class" }),
    node("buildOrderShipment"),
    node("shipment", { id: "constant:shipment", kind: "constant", filePath: "src/tests/orderChecks.ts" }),
    node("tracking", { id: "constant:tracking", kind: "constant", filePath: "src/tests/orderChecks.ts" }),
  ];

  it("does not let one ordinary word matched exactly outrank a well-corroborated node", () => {
    const { candidates } = selectScope(engineOver(corpus), "order shipment tracking", 10);
    // Which of the two compound declarations leads is the search ranking's call.
    // The claim here is that both of them lead, and that the single-word locals
    // which used to score a flat 1.0 now sit below both.
    const corroborated = ["function:OrderShipmentTracker", "function:buildOrderShipment"];
    expect(corroborated).toContain(candidates[0]!.id);
    const worst = Math.min(...candidates.filter((c) => corroborated.includes(c.id)).map((c) => c.score));
    for (const id of ["constant:shipment", "constant:tracking"]) {
      expect(candidates.find((c) => c.id === id)!.score).toBeLessThan(worst);
    }
  });

  it("still returns the demoted node — this is a demotion, never an exclusion", () => {
    const { candidates } = selectScope(engineOver(corpus), "order shipment tracking", 10);
    expect(candidates.map((c) => c.id)).toContain("constant:shipment");
  });

  it("finds a test-file symbol when the task names it, demotion notwithstanding", () => {
    // The same question M1 answered for search: a task genuinely about a test
    // must still reach the test. A one-word task has full coverage, so the only
    // factor left is the test-file multiplier, which cannot reorder a field of one.
    const { candidates } = selectScope(engineOver(corpus), "tracking", 10);
    expect(candidates[0]!.id).toBe("constant:tracking");
  });

  it("scores a task that IS a symbol name exactly as the flat boost did", () => {
    const { candidates } = selectScope(engineOver(corpus), "buildOrderShipment", 10);
    expect(candidates[0]).toMatchObject({ id: "function:buildOrderShipment", score: 1 });
  });

  it("exempts an identifier-shaped word inside a longer task", () => {
    const { candidates } = selectScope(engineOver(corpus), "why is buildOrderShipment slow", 10);
    expect(candidates[0]).toMatchObject({ id: "function:buildOrderShipment", score: 1 });
  });

  it("demotes a test-file node below an equally-corroborated source node", () => {
    const twins = [
      node("shipmentRetry", { id: "function:src", filePath: "src/orders.ts" }),
      node("shipmentRetry", { id: "function:test", filePath: "src/tests/orderChecks.ts" }),
    ];
    const { candidates } = selectScope(engineOver(twins), "shipmentRetry", 10);
    expect(candidates.map((c) => c.id)).toEqual(["function:src", "function:test"]);
    expect(candidates[1]!.score).toBeLessThan(candidates[0]!.score);
  });

  it("orders totally and reproducibly", () => {
    const graph = engineOver(corpus);
    const once = selectScope(graph, "order shipment tracking", 10);
    const twice = selectScope(graph, "order shipment tracking", 10);
    expect(twice).toEqual(once);
  });
});

describe("maxNodes controls output size", () => {
  const corpus = Array.from({ length: 24 }, (_, i) =>
    node(`shipmentStep${String(i).padStart(2, "0")}`, { id: `function:step-${i}` }),
  );

  it("returns as many nodes as the caller asked for while the pool lasts", () => {
    const graph = engineOver(corpus);
    const counts = [3, 6, 12, 20].map((n) => selectScope(graph, "shipment", n).candidates.length);
    expect(counts).toEqual([3, 6, 12, 20]);
  });

  it("stops at the pool rather than inventing nodes", () => {
    const graph = engineOver(corpus);
    const { candidates, matchedCount } = selectScope(graph, "shipment", 500);
    expect(candidates).toHaveLength(matchedCount);
  });

  it("keeps every category represented as the request grows", () => {
    // A pool that is entirely one category must still fill the request — the
    // quota exists to stop crowding out, not to withhold results.
    const graph = engineOver(corpus);
    expect(selectScope(graph, "shipment", 15).candidates).toHaveLength(15);
  });
});
