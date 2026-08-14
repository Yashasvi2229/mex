// ============================================================================
// mex code-graph — partial answers, and honest empties
// ============================================================================
//
// Two claims, over real indexes built from checked-in fixtures — no mocks, no
// external checkout:
//
//   1. A lookup that finds nothing is an ANSWER, not an error, and where the
//      store holds evidence it did not resolve, that evidence is returned,
//      labelled with how it was obtained and bounded with an honest total.
//   2. A task the index cannot answer is SAID to be unanswerable, cheaply, and
//      the rest of the same response stops claiming otherwise.
//
// Which of these fail against pre-milestone code, and what they report there,
// is recorded in the handoff. In short: every case in `recoverable outcomes`
// and `unresolved-reference evidence` fails, because the old code emitted
// `{ type: "error", code: "TARGET_NOT_FOUND" }` and had no evidence records at
// all; the `honest empties` cases fail because `confidence` did not exist.
//
// The `honest empties` suite needs a corpus with a DELIBERATE HOLE — a task
// with no covering declaration. `fixtures/shipping` supplies it by being about
// exactly one subject: nothing in it concerns webhooks, so
// "webhook signature verification" is unanswerable there by construction, and
// stays unanswerable if the fixture grows, as long as it does not grow a
// webhook. The tasks asserted answerable are answerable in the same way — by
// naming declarations the fixture actually contains.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { runGraphQuery, runGraphScope, type AgentCommandDeps } from "../cli-agent.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

type Rec = Record<string, unknown>;

interface Corpus {
  root: string;
  engine: GraphEngine;
  db: SqliteDatabase;
  deps: AgentCommandDeps;
  lines: string[];
}

async function buildCorpus(...dirs: string[]): Promise<Corpus> {
  const root = mkdtempSync(join(tmpdir(), "mex-m4-"));
  for (const dir of dirs) {
    mkdirSync(join(root, dir), { recursive: true });
    cpSync(join(FIXTURES, dir), join(root, dir), { recursive: true });
  }
  const engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
  const db = openSqlite(join(root, ".mex", "graph.db"));
  const lines: string[] = [];
  const deps: AgentCommandDeps = {
    open: () => ({ graph: engine, db, close: () => {} }),
    write: (line) => lines.push(line),
  };
  return { root, engine, db, deps, lines };
}

function capture(corpus: Corpus, run: () => void): Rec[] {
  corpus.lines.length = 0;
  run();
  return corpus.lines.map((line) => JSON.parse(line) as Rec);
}

/** Every record's own token cost, the same estimate the emitter accounts with. */
const tokensOf = (records: Rec[]): number =>
  records.reduce((sum, record) => sum + Math.ceil(JSON.stringify(record).length / 4), 0);

// ── partial answers ─────────────────────────────────────────────────────────

describe("recoverable outcomes and unresolved-reference evidence", () => {
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await buildCorpus("dispatch");
  }, 60_000);

  afterAll(() => {
    corpus.engine.close();
    corpus.db.close();
    rmSync(corpus.root, { recursive: true, force: true });
  });

  const query = (relation: string, target: string, options: Rec = {}): Rec[] =>
    capture(corpus, () => runGraphQuery(relation, target, corpus.root, corpus.deps, options));

  it("answers an unresolvable target with a success-shaped record, not an error", () => {
    const records = query("who-calls", "noSuchSymbolAnywhere");
    expect(records.some((record) => record.type === "error")).toBe(false);
    expect(records[0]).toMatchObject({ type: "meta" });

    const outcome = records.find((record) => record.type === "not-found")!;
    expect(outcome).toBeDefined();
    expect(outcome.target).toBe("noSuchSymbolAnywhere");
    // Guidance that names the next command, not "try again".
    expect(typeof outcome.hint).toBe("string");

    const summary = records.at(-1)!;
    expect(summary).toMatchObject({ type: "summary", outcome: "not-found" });
    expect(summary.suggestedNextCommands).toContain("mex graph scope noSuchSymbolAnywhere");
  });

  it("returns unresolved references naming a target that has no resolved callers", () => {
    const records = query("who-calls", "ShipmentAudit");
    // The premise: `who-calls` itself found nothing.
    expect(records.some((record) => record.type === "result")).toBe(false);

    const evidence = records.filter((record) => record.type === "evidence");
    expect(evidence.length).toBeGreaterThan(0);
    for (const row of evidence) {
      expect(row.filePath).toBe("dispatch/coordinator.ts");
      expect(typeof row.line).toBe("number");
    }
  });

  it("keeps the two resolution failures distinct, and distinct from a resolved edge", () => {
    const records = query("who-calls", "ShipmentAudit");
    const byResolution = (value: string): Rec[] =>
      records.filter((record) => record.type === "evidence" && record.resolution === value);

    // `new ShipmentAudit()` bound — a real edge, of a kind `who-calls` does not read.
    const related = byResolution("related-edge");
    expect(related).toHaveLength(1);
    expect(related[0]!.referenceKind).toBe("instantiates");
    expect(related[0]).not.toHaveProperty("candidateCount");

    // `ShipmentAudit()` could not bind: a call may name a function or a method,
    // and this names a class, so the resolver had no eligible candidate at all.
    const unresolved = byResolution("unresolved");
    expect(unresolved).toHaveLength(1);
    expect(unresolved[0]!.referenceKind).toBe("calls");
    expect(unresolved[0]!.candidateCount).toBe(0);

    const summary = records.at(-1)! as { evidence: Record<string, { total: number }> };
    expect(summary.evidence.related.total).toBe(1);
    expect(summary.evidence.unresolved.total).toBe(1);
    expect(summary.evidence.ambiguous.total).toBe(0);
  });

  it("labels a reference the resolver declined to place as ambiguous, with the field size", () => {
    const records = query("who-calls", "processBatch");
    const ambiguous = records.filter(
      (record) => record.type === "evidence" && record.resolution === "ambiguous",
    );
    expect(ambiguous.length).toBeGreaterThan(0);
    // Two exported `processBatch` declarations, neither imported by the caller.
    expect(ambiguous[0]!.candidateCount).toBe(2);
    expect(ambiguous[0]!.referenceKind).toBe("calls");
  });

  it("says so when the declaration is indexed and nothing at all is recorded", () => {
    // The last silent path: the target resolves, the relation is empty, and the
    // fallthrough finds nothing either. It used to emit a `meta` and a `summary`
    // and no statement — a clean result with the reason it is not proof left out.
    const records = query("what-calls", "processBatch");
    expect(records.some((record) => record.type === "result")).toBe(false);

    const note = records.find((record) => record.type === "none-recorded")!;
    expect(note).toBeDefined();
    expect(note.name).toBe("processBatch");
    // Where the declaration lives, so the agent can check outside the graph.
    expect(note.filePath).toMatch(/batchRunner\.ts$/);
    expect(typeof note.line).toBe("number");
    expect(typeof note.message).toBe("string");
    expect(typeof note.caveat).toBe("string");

    const summary = records.at(-1)!;
    expect(summary.outcome).toBe("none-recorded");
    expect(summary.suggestedNextCommands).toHaveLength(1);
  });

  it("keeps `no such symbol` distinguishable from `that symbol, nothing recorded`", () => {
    // Opposite next moves — fix the name, or go and look outside the graph — so
    // a consumer must never have to guess which of the two it is holding.
    const missing = query("what-calls", "noSuchSymbolAnywhere").at(-1)!;
    const silent = query("what-calls", "processBatch").at(-1)!;
    expect(missing.outcome).toBe("not-found");
    expect(silent.outcome).toBe("none-recorded");
    expect(missing.outcome).not.toBe(silent.outcome);
  });

  it("never lets a partial answer be mistaken for a resolved edge", () => {
    for (const target of ["ShipmentAudit", "processBatch"]) {
      for (const record of query("who-calls", target)) {
        if (record.type !== "evidence") continue;
        // A resolved caller is a `result`; evidence is never that, and always
        // says which of the three ways it was obtained.
        expect(record.type).not.toBe("result");
        expect(["unresolved", "ambiguous", "related-edge"]).toContain(record.resolution);
      }
    }
  });

  it("bounds the evidence by --max-nodes while reporting the true total", () => {
    const records = query("who-calls", "ShipmentAudit", { maxNodes: 1 });
    const evidence = records.filter((record) => record.type === "evidence");
    const summary = records.at(-1)! as { evidence: Record<string, { returned: number; total: number; truncated: boolean }> };
    // One row per group is allowed, and both groups hold exactly one row here,
    // so what this pins is that the cap is applied per group and the totals are
    // reported from the store rather than from what survived the cap.
    for (const group of Object.values(summary.evidence)) {
      expect(group.returned).toBeLessThanOrEqual(1);
      expect(group.truncated).toBe(group.returned < group.total);
    }
    expect(evidence.length).toBeLessThanOrEqual(Object.keys(summary.evidence).length);
  });

  it("respects the token ceiling: nothing is emitted that was not accounted", () => {
    const records = query("who-calls", "ShipmentAudit", { maxOutputTokens: 200 });
    const summary = records.at(-1)!;
    expect(summary.type).toBe("summary");
    expect(summary.estimatedOutputTokens as number).toBeGreaterThanOrEqual(tokensOf(records));
    expect(summary.estimatedOutputTokens as number).toBeLessThanOrEqual(summary.maxOutputTokens as number);
  });

  it("is deterministic: the same query returns byte-identical output", () => {
    expect(JSON.stringify(query("who-calls", "ShipmentAudit")))
      .toBe(JSON.stringify(query("who-calls", "ShipmentAudit")));
  });

  it("keeps every field an existing consumer reads", () => {
    const records = query("where-defined", "coordinateDispatch");
    const summary = records.at(-1)!;
    for (const field of [
      "type", "matchedNodes", "returnedNodes", "returnedEdges",
      "estimatedOutputTokens", "maxOutputTokens", "truncated", "suggestedNextCommands",
    ]) {
      expect(summary).toHaveProperty(field);
    }
    const result = records.find((record) => record.type === "result")!;
    for (const field of ["id", "kind", "name", "qualifiedName", "filePath", "lineStart", "lineEnd", "callerCount", "calleeCount", "detail", "sourceIncluded"]) {
      expect(result).toHaveProperty(field);
    }
  });
});

// ── honest empties ──────────────────────────────────────────────────────────

describe("honest empties", () => {
  let corpus: Corpus;

  beforeAll(async () => {
    corpus = await buildCorpus("shipping");
  }, 60_000);

  afterAll(() => {
    corpus.engine.close();
    corpus.db.close();
    rmSync(corpus.root, { recursive: true, force: true });
  });

  const scope = (task: string, options: Rec = {}): Rec[] =>
    capture(corpus, () => runGraphScope(task, corpus.root, corpus.deps, options));
  const confidenceOf = (task: string): unknown => scope(task).at(-1)!.confidence;

  it("declares low confidence, and degrades rather than empties, on a task nothing covers", () => {
    // Weak matches DO exist here — every one of these words names something in
    // the fixture — but no declaration accounts for two of them, which is the
    // case a zero-result guard cannot catch and the one that costs the tokens.
    const records = scope("carrier webhook retry policy");
    expect(records.at(-1)!.confidence).toBe("low");

    const note = records.find((record) => record.type === "low-confidence")!;
    expect(note).toBeDefined();
    expect(note.reason).toBe("no-strong-match");
    // Degraded, not empty: it still says what it saw and where to look.
    expect((note.weakMatches as unknown[]).length).toBeGreaterThan(0);
    expect(note.weakMatchCount as number).toBeGreaterThan(0);
    expect((note.likelyDirectories as unknown[]).length).toBeGreaterThan(0);
    expect(typeof note.caveat).toBe("string");
  });

  it("says so plainly when nothing matched at all", () => {
    const records = scope("webhook signature verification");
    expect(records.at(-1)!.confidence).toBe("low");
    const note = records.find((record) => record.type === "low-confidence")!;
    expect(note.reason).toBe("no-match");
    expect(note.weakMatchCount).toBe(0);
  });

  it("NEVER declares low confidence on a single-symbol query", () => {
    // The structural exemption. A one-word query is a symbol lookup and its
    // best match IS the answer, so no evidence can make this fire.
    for (const symbol of ["buildOrderShipment", "OrderShipmentTracker", "shipment", "tracking", "carrier"]) {
      expect(confidenceOf(symbol)).not.toBe("low");
    }
  });

  it("NEVER declares low confidence on an answerable multi-term task", () => {
    // The gate. Every task here is answerable BY CONSTRUCTION — each names
    // words carried by declarations the checked-in fixture actually contains.
    for (const task of [
      "order shipment tracking",
      "build order shipment",
      "notify shipment customer",
      "cancel order shipment",
      "reconcile shipment ledger",
      "shipment retry limit",
      "order shipment tracker carrier",
      "how does order shipment tracking work",
    ]) {
      expect(confidenceOf(task), task).not.toBe("low");
    }
  });

  it("retracts confident framing rather than hedging and widening at once", () => {
    // Part D. A response that has said it does not know must not, in the same
    // breath, offer the retry that returns more of what it just disowned.
    const summary = scope("webhook signature verification", { maxNodes: 30 }).at(-1)!;
    expect(summary.confidence).toBe("low");
    expect(summary.suggestedNextCommands).toEqual([]);
    expect(summary.returnedNodes).toBe(0);
  });

  it("costs materially less than a confident answer", () => {
    const weak = tokensOf(scope("webhook signature verification"));
    const strong = tokensOf(scope("order shipment tracking"));
    expect(weak).toBeLessThan(strong / 2);
    expect(weak).toBeLessThan(300);
  });

  it("is deterministic", () => {
    expect(JSON.stringify(scope("webhook signature verification")))
      .toBe(JSON.stringify(scope("webhook signature verification")));
  });
});
