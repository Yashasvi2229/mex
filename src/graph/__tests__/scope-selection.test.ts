// ============================================================================
// mex code-graph — task-scope selection, end to end
// ============================================================================
//
// The same claims as `scope-rank.test.ts`, but over a real index built from the
// checked-in `fixtures/shipping` corpus — no mocks, no external checkout. The
// unit tests pin the arithmetic; these pin that the arithmetic survives real
// extraction, a real FTS ranking underneath it, and the JSONL emitter above it.
//
// Both cases fail against the pre-milestone code: the first because every exact
// name match scored a flat 1.0, so a two-line `const shipment` in a test file
// led the answer; the second because the per-category quotas summed to 11 and
// were consulted before `maxNodes`, making 11 the true ceiling of every call.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { selectScope } from "../scope.js";
import { isTestPath } from "../search/rank.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const TASK = "order shipment tracking";

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-scope-"));
  mkdirSync(join(root, "shipping"), { recursive: true });
  cpSync(join(FIXTURES, "shipping"), join(root, "shipping"), { recursive: true });
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
}, 60_000);

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

const pick = (task: string, maxNodes: number) => selectScope(engine, task, maxNodes).candidates;
const nodeFor = (id: string) => engine.getNode(id)!;

describe("scope top-1 quality", () => {
  it("leads with a source declaration, not a single-word local in a test file", () => {
    const top = nodeFor(pick(TASK, 10)[0]!.id);
    expect(isTestPath(top.filePath)).toBe(false);
    expect(top.name.toLowerCase()).not.toBe("shipment");
  });

  it("no longer flattens every exact match onto the same score", () => {
    const scores = pick(TASK, 10).map((c) => c.score);
    expect(scores.filter((s) => s === 1).length).toBeLessThanOrEqual(1);
    expect(new Set(scores).size).toBeGreaterThan(1);
  });

  it("still reaches a test-file declaration when the task names one", () => {
    const top = nodeFor(pick("checkCarrierLedger", 10)[0]!.id);
    expect(top.name).toBe("checkCarrierLedger");
    expect(isTestPath(top.filePath)).toBe(true);
  });

  it("still answers a plain symbol lookup at full score", () => {
    expect(pick("buildOrderShipment", 10)[0]).toMatchObject({ score: 1 });
    expect(nodeFor(pick("buildOrderShipment", 10)[0]!.id).name).toBe("buildOrderShipment");
  });
});

describe("maxNodes controls output size", () => {
  it("returns strictly more for a larger request, up to the pool", () => {
    const { matchedCount } = selectScope(engine, TASK, 30);
    expect(matchedCount).toBeGreaterThan(11);
    const counts = [3, 5, 11, 30].map((n) => pick(TASK, n).length);
    expect(counts[0]).toBe(3);
    expect(counts[1]).toBe(5);
    expect(counts[2]).toBeGreaterThan(counts[1]!);
    // The old fixed quota (5 direct + 4 neighbor + 2 test) capped every call at
    // eleven facts however many were asked for.
    expect(counts[3]).toBeGreaterThan(11);
  });

  it("reports a matchedCount that covers what it returned, so truncation is honest", () => {
    // The pool itself grows with the request — the seed fetch scales with
    // `maxNodes` — so this is deliberately NOT an assertion that the two calls
    // consider the same pool. What must hold is that each call reports the pool
    // it actually considered, and never claims to have returned more than it saw.
    for (const maxNodes of [3, 5, 30]) {
      const { candidates, matchedCount } = selectScope(engine, TASK, maxNodes);
      expect(candidates.length).toBeLessThanOrEqual(matchedCount);
    }
    const small = selectScope(engine, TASK, 3);
    expect(small.candidates.length).toBeLessThan(small.matchedCount);
  });

  it("emits in score order and reproduces exactly for a given request", () => {
    const scores = pick(TASK, 30).map((c) => c.score);
    expect(scores).toEqual([...scores].sort((a, b) => b - a));
    expect(pick(TASK, 30)).toEqual(pick(TASK, 30));
  });
});
