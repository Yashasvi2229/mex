import { existsSync } from "node:fs";
import { relative, resolve } from "node:path";
import { createGraphEngine } from "./engine-impl.js";
import type { GraphEngine } from "./engine.js";
import { openSqlite, type SqliteDatabase } from "./db/sqlite.js";
import type { GraphNode } from "./types.js";
import {
  compactFact, groupByFile, readNodeSource, selectScope,
  type CompactFact, type DetailLevel, type SourceRange,
} from "./scope.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { serializeFingerprint } from "./fingerprint.js";
import { BudgetLedger, estimateTokens, resolveOptions, SCHEMA_VERSION, type AgentOptions } from "./agent-protocol.js";
import { evidenceForTarget, hasEvidence, type EvidenceResolution, type TargetEvidence } from "./evidence.js";
import { assessConfidence, CONFIDENCE_CONFIRM_DEPTH, type ConfidenceAssessment } from "./confidence.js";

type QueryRelation = "who-calls" | "what-calls" | "where-defined";

interface AgentGraphSession {
  graph: GraphEngine;
  db: SqliteDatabase;
  close(): void;
}

export interface AgentCommandDeps {
  open?: (rootDir: string) => AgentGraphSession;
  write?: (line: string) => void;
}

type RawOptions = Partial<Record<keyof AgentOptions, unknown>>;
type Rec = Record<string, unknown>;

/** Agent-facing blast radius. Output is newline-delimited JSON (JSONL). */
export function runImpact(
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const fileNodes = nodesForFile(session, rootDir, target);
    const roots = fileNodes.length > 0 ? fileNodes : resolveSymbol(session.graph, target);
    if (roots.length === 0) {
      emitOutcome(write, "impact", opts, "not-found", {
        target,
        message: `No indexed declaration or file matches "${target}".`,
      }, [`mex graph scope ${quoteArg(target)}`]);
      return;
    }
    if (fileNodes.length === 0 && roots.length > 1) {
      emitOutcome(write, "impact", opts, "ambiguous", {
        ...ambiguousPayload(target, roots),
        message: "Several declarations share this name; impact needs exactly one.",
        hint: "Re-run with a `qualifiedName` from `candidates` as the target argument.",
      }, [`mex graph impact ${quoteArg(roots[0]!.qualifiedName)}`]);
      return;
    }

    // Definitions (roots) and transitive callers share one `maxNodes` cap on returned nodes.
    const rootsSorted = roots.sort(byId);
    const widen = widenCommand(`graph impact ${quoteArg(target)}`, opts);
    const ctx = beginResponse("impact", opts, undefined, [
      ...(rootsSorted.length > 0 ? [`mex graph get ${rootsSorted[0]!.id} --detail source`] : []),
      widen("max-output-tokens"),
    ]);
    const ledger = ctx.ledger;
    const meta = ctx.meta;

    const headRecords: Rec[] = [];  // `target` — data, but not a graph fact
    const factRecords: Rec[] = [];  // `defines` + `caller` — real facts, eligible for source
    const emittedNodes: GraphNode[] = [];
    let truncated = false;

    const targetRecord: Rec = { type: "target", targetType: fileNodes.length > 0 ? "file" : "symbol", value: target };
    if (ledger.tryAdd(targetRecord)) headRecords.push(targetRecord); else truncated = true;

    for (const root of rootsSorted) {
      if (emittedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, root.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "defines", ...fact };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      factRecords.push(record);
      emittedNodes.push(root);
    }

    const impacted = new Map<string, { node: GraphNode; depth: number; root: string }>();
    for (const root of rootsSorted) {
      for (const entry of transitiveCallers(session.graph, root, opts.depth)) {
        const current = impacted.get(entry.node.id);
        if (!current || entry.depth < current.depth) impacted.set(entry.node.id, { ...entry, root: root.id });
      }
    }
    const ordered = [...impacted.values()].sort((a, b) => a.depth - b.depth || a.node.id.localeCompare(b.node.id));
    for (const entry of ordered) {
      if (emittedNodes.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, entry.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "caller", depth: entry.depth, root: entry.root, ...fact };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      factRecords.push(record);
      emittedNodes.push(entry.node);
    }

    const sourceRecords = planSource(ledger, emittedNodes, rootDir, opts, factRecords);

    const affectedIds = [...new Set([...roots.map((node) => node.id), ...impacted.keys()])];
    const groundingRecords: Rec[] = [];
    for (const grounding of groundedFiles(session.db, affectedIds)) {
      const record: Rec = { type: "grounding", node: grounding.node_id, file: grounding.scaffold_file };
      if (ledger.tryAdd(record)) groundingRecords.push(record); else truncated = true;
    }

    emitAll(write, meta, [...headRecords, ...factRecords, ...sourceRecords, ...groundingRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: roots.length + impacted.size,
      returnedNodes: emittedNodes.length,
      returnedEdges: 0,
      truncated,
      maxNodes: opts.maxNodes,
      widen,
      suggestedNextCommands: emittedNodes.length > 0 ? [`mex graph get ${emittedNodes[0]!.id} --detail source`] : [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Structural graph lookup. Output is newline-delimited JSON (JSONL). */
export function runGraphQuery(
  relation: string,
  target: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  if (!isRelation(relation)) {
    writeJson(write, { type: "error", code: "INVALID_QUERY", relation, expected: ["who-calls", "what-calls", "where-defined"] });
    return;
  }
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const nodes = resolveSymbol(session.graph, target);
    if (nodes.length === 0) {
      emitOutcome(write, `graph query ${relation}`, opts, "not-found", {
        target,
        relation,
        message: `No indexed declaration matches "${target}".`,
        hint: "Search for the declaration first; `graph scope` takes a phrase, not a symbol name.",
      }, [`mex graph scope ${quoteArg(target)}`]);
      return;
    }

    // Preserve (queried target, result) pairs; dedupe by that pair, not by result id alone.
    //
    // `nodes` is emitted in the order `resolveSymbol` returned it, which is the
    // search ranking. It used to be re-sorted by node id here — a content hash —
    // which discarded every ordering decision the ranker made on the way out, and
    // is why no gate on this command could observe a ranking defect. Callers and
    // callees below KEEP their id sort: they come from traversal, carry no rank,
    // and the id order is what makes them a total order at all.
    const pairs: Array<{ targetId: string; node: GraphNode }> = [];
    const seen = new Set<string>();
    for (const queried of nodes) {
      const related = relation === "where-defined"
        ? [queried]
        : (relation === "who-calls" ? session.graph.getCallers(queried.id) : session.graph.getCallees(queried.id)).sort(byId);
      for (const node of related) {
        const key = `${queried.id} ${node.id}`;
        if (seen.has(key)) continue;
        seen.add(key);
        pairs.push({ targetId: queried.id, node });
      }
    }

    const widen = widenCommand(`graph query ${relation} ${quoteArg(target)}`, opts);
    // The reserve is sized from the suggestions the summary will ACTUALLY carry,
    // and a `who-calls` with no resolved callers still carries one: the
    // fallthrough below suggests reading the declaration an evidence row points
    // at. Anticipating it only when `pairs` is non-empty under-sizes the reserve
    // by exactly that string, and the summary then overruns a budget the ledger
    // has already reported as honoured. Node ids are fixed-width, so the id used
    // to size it need not be the one finally emitted.
    const anticipated = [
      ...(opts.detail !== "source" ? [`mex graph get ${(pairs[0]?.node ?? nodes[0]!).id} --detail source`] : []),
      widen("max-output-tokens"),
    ];
    const ctx = beginResponse(`graph query ${relation}`, opts, undefined, anticipated);
    const ledger = ctx.ledger;
    const meta = ctx.meta;

    const entries: Array<{ record: Rec; node: GraphNode }> = [];
    let truncated = false;
    for (const pair of pairs) {
      if (entries.length >= opts.maxNodes) { truncated = true; break; }
      const fact = factFor(session, pair.node.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const record: Rec = { type: "result", relation, target: pair.targetId, ...fact };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      entries.push({ record, node: pair.node });
    }

    const sourceRecords = planSource(ledger, entries.map((e) => e.node), rootDir, opts, entries.map((e) => e.record));

    // The fallthrough. `who-calls` reads `calls` edges and nothing else, so a
    // declaration nothing resolved a call to answers "nobody" — 61.7% of
    // function/method/class declarations on the measured index — while the store
    // is still holding reference sites that named it and resolved edges of other
    // kinds. Both are returned here, each row labelled with how it was obtained,
    // so none of it can be read as a resolved caller.
    const evidenceRecords: Rec[] = [];
    let evidenceSummary: Rec | undefined;
    // Evidence is about one declaration, so when the name resolved to several it
    // is gathered for the best-ranked one and the record's `target` names which.
    // Picking the top of an order the ranker already produced is the same choice
    // every other part of this response makes; reporting evidence for all of
    // them would multiply the counts by a number the agent did not ask for.
    if (relation === "who-calls" && entries.length === 0 && nodes.length > 0) {
      const evidence = evidenceForTarget(session.db, nodes[0]!, opts.maxNodes);
      if (hasEvidence(evidence)) {
        for (const group of [evidence.related, evidence.unresolved, evidence.ambiguous]) {
          for (const row of group.rows) {
            const record: Rec = { type: "evidence", relation, target: nodes[0]!.id, ...row };
            if (ledger.tryAdd(record)) evidenceRecords.push(record); else truncated = true;
          }
        }
        evidenceSummary = evidenceCounts(evidence, evidenceRecords);
      }
    }

    emitAll(write, meta, [...entries.map((e) => e.record), ...sourceRecords, ...evidenceRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: pairs.length,
      returnedNodes: entries.length,
      returnedEdges: 0,
      truncated,
      maxNodes: opts.maxNodes,
      widen,
      ...(evidenceSummary ? { evidence: evidenceSummary } : {}),
      suggestedNextCommands: entries.length > 0 && opts.detail !== "source"
        ? [`mex graph get ${entries[0]!.node.id} --detail source`]
        : evidenceRecords.length > 0
          ? [`mex graph get ${String(evidenceRecords[0]!.fromId)} --detail source`]
          : [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Broad graph retrieval for an agent task. Compact JSONL manifest by default. */
export function runGraphScope(
  task: string,
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions(rawOptions);
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const { candidates, matchedCount } = selectScope(session.graph, task, opts.maxNodes);
    const selected = candidates
      .map((candidate) => session.graph.getNode(candidate.id))
      .filter((node): node is GraphNode => node !== null);

    // Is this answer worth presenting as an answer? Asked once, before anything
    // is emitted, and the single result decides both what this response says and
    // what it must stop saying (Part D, in `summaryRecord`).
    const confidence = assessConfidence(task, selected, () =>
      session.graph.searchNodes(task, { limit: CONFIDENCE_CONFIRM_DEPTH }));
    if (confidence.level === "low") {
      emitLowConfidence(write, task, opts, confidence, selected, matchedCount);
      return;
    }

    const firstNode = selected[0] ?? null;
    const widen = widenCommand(`graph scope ${quoteArg(task)}`, opts);
    const ctx = beginResponse("graph scope", opts, task, [
      ...buildScopeSuggestions(firstNode ? [firstNode] : [], opts.detail),
      widen("max-output-tokens"),
    ]);
    const ledger = ctx.ledger;
    const meta = ctx.meta;

    const facts: Array<{ record: Rec; node: GraphNode }> = [];
    const returnedIds = new Set<string>();
    let truncated = candidates.length < matchedCount;
    for (const candidate of candidates) {
      const fact = factFor(session, candidate.id, opts.detail, opts.fingerprint);
      if (!fact) continue;
      const node = session.graph.getNode(candidate.id);
      if (!node) continue;
      const record: Rec = { type: "fact", ...fact, score: candidate.score, selectionReasons: candidate.reasons };
      if (!ledger.tryAdd(record)) { truncated = true; break; }
      facts.push({ record, node });
      returnedIds.add(candidate.id);
    }

    const edgeRecords: Rec[] = [];
    if (opts.detail !== "minimal") {
      for (const { node } of facts) {
        for (const callee of session.graph.getCallees(node.id)) {
          if (!returnedIds.has(callee.id)) continue;
          const record: Rec = { type: "edge", kind: "calls", source: node.id, target: callee.id, provenance: "static" };
          if (ledger.tryAdd(record)) edgeRecords.push(record); else truncated = true;
        }
      }
    }

    const sourceRecords = planSource(ledger, facts.map((f) => f.node), rootDir, opts, facts.map((f) => f.record));

    emitAll(write, meta, [...facts.map((f) => f.record), ...edgeRecords, ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: matchedCount,
      returnedNodes: facts.length,
      returnedEdges: edgeRecords.length,
      truncated,
      maxNodes: opts.maxNodes,
      widen,
      suggestedNextCommands: buildScopeSuggestions(facts.map((f) => f.node), opts.detail),
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

/** Targeted source expansion by node id. Output is JSONL source records. */
export function runGraphGet(
  ids: string[],
  rootDir = process.cwd(),
  deps: AgentCommandDeps = {},
  rawOptions: RawOptions = {},
): void {
  const write = deps.write ?? console.log;
  const opts = resolveOptions({ ...rawOptions, detail: "source" });
  const session = openSession(rootDir, deps, write);
  if (!session) return;
  try {
    const requested = opts.maxOutputTokens;
    const reserve = estimateTokens(summarySkeleton([])) + RESERVE_PAD;
    const buildMeta = (max: number): Rec => ({
      type: "meta", schemaVersion: SCHEMA_VERSION, command: "graph get",
      detail: "source", maxNodes: ids.length, maxOutputTokens: max,
    });
    const effectiveMax = Math.max(requested, estimateTokens(buildMeta(SIZE_PROBE)) + reserve);
    const meta = buildMeta(effectiveMax);
    const ledger = new BudgetLedger(effectiveMax, reserve);
    ledger.frame(meta);
    const ctx: ResponseCtx = { ledger, meta, effectiveMax, requested };

    const nodes: GraphNode[] = [];
    const errorRecords: Rec[] = [];
    let truncated = false;
    for (const id of ids) {
      const node = session.graph.getNode(id);
      if (!node) {
        // An id that is not in the index is a recoverable outcome, not a broken
        // tool — and it already coexists with real results in the same stream,
        // which is exactly the shape an error record should never have.
        const record: Rec = {
          type: "not-found", id,
          message: "No node with this id is in the index.",
          hint: "Node ids move when a declaration is renamed or its file is re-indexed; re-run `mex graph scope` to get current ids.",
        };
        if (ledger.tryAdd(record)) errorRecords.push(record); else truncated = true;
        continue;
      }
      nodes.push(node);
    }
    const sourceRecords = planSource(ledger, nodes, rootDir, opts);
    const sourcedIds = new Set(
      sourceRecords.flatMap((record) => (record.ranges as SourceRange[]).flatMap((range) => range.nodeIds)),
    );

    emitAll(write, meta, [...errorRecords, ...sourceRecords]);
    write(JSON.stringify(summaryRecord(ctx, {
      matchedNodes: ids.length,
      returnedNodes: sourcedIds.size,
      returnedEdges: 0,
      truncated,
      maxNodes: ids.length,
      suggestedNextCommands: [],
    })));
  } catch (error) {
    unavailable(write, error);
  } finally {
    try { session.close(); } catch { /* best-effort degradation cleanup */ }
  }
}

// ── recoverable outcomes ────────────────────────────────────────────────────
//
// Not every disappointing answer is a failure. "The symbol you named is not in
// the index" and "several declarations share that name" are ordinary, expected
// results of asking a code graph a question — the tool worked, and the answer is
// that the thing is elsewhere. Emitting `{ type: "error" }` for them tells an
// agent the tool is broken, and an agent that believes the tool is broken stops
// calling it. So a recoverable outcome is framed like any other answer: the
// normal `meta` … `summary` envelope, a record saying what happened, and
// guidance naming the next command WITH its arguments rather than "try again".
//
// Three of the seven sites that emitted an error record stay errors, because
// they are failures in the strict sense — the tool could not answer at all:
// both `GRAPH_UNAVAILABLE` sites (there is no index, or the store threw) and
// `INVALID_QUERY` (the relation named is not one this command has; the call
// itself is malformed, not the index). The classification of all seven, with
// the reasoning for each, is in the handoff.
//
// Exit status is unchanged and stays 0: none of these paths ever set one, so a
// script branching on exit status sees exactly what it saw before. The
// distinction lives in the records, where it always did.

/** What a command found, when what it found was not results. */
type Outcome = "not-found" | "ambiguous";

/**
 * Emit a full, success-shaped response whose payload is one recoverable outcome.
 *
 * Framed identically to a populated response — same `meta`, same `summary`, same
 * budget accounting — so a consumer parses it with the code it already has.
 */
function emitOutcome(
  write: (line: string) => void,
  command: string,
  opts: AgentOptions,
  outcome: Outcome,
  payload: Rec,
  suggestions: string[],
): void {
  const ctx = beginResponse(command, opts, undefined, suggestions);
  const record: Rec = { type: outcome, ...payload };
  const emitted = ctx.ledger.tryAdd(record);
  emitAll(write, ctx.meta, emitted ? [record] : []);
  write(JSON.stringify(summaryRecord(ctx, {
    matchedNodes: typeof payload.candidateCount === "number" ? payload.candidateCount : 0,
    returnedNodes: 0,
    returnedEdges: 0,
    truncated: !emitted,
    maxNodes: opts.maxNodes,
    outcome,
    suggestedNextCommands: suggestions,
  })));
}

/**
 * Weak matches to name when a response has declared low confidence.
 *
 * Few, and they are named rather than described. A full `fact` record is ~140
 * tokens of structure — qualified name, line span, signature, relationship
 * counts, body hash — all of which is worth paying for about a declaration the
 * agent is going to read, and none of which is worth paying for about a
 * declaration the response has just said is probably not the answer. Measured,
 * the confident version of this response costs about 1,362 tokens; the
 * expensive part of a wrong answer is not being wrong, it is being wrong at
 * length.
 *
 * Two, measured rather than chosen: a weak match costs 36 tokens (a file path
 * is the widest field), and two is what holds the whole response under 300
 * against the ~1,362 the confident version costs. The rows are there to let an
 * agent recognise a lucky hit, not to be read — a third example buys one more
 * coincidence for the price of most of `likelyDirectories`, which at 46 tokens
 * for four entries is the cheapest actionable content in the record.
 */
const MAX_WEAK_MATCHES = 2;

/**
 * A cheap, honest response for a task the index cannot answer.
 *
 * Degraded, not empty. It returns the weak matches — as names and locations,
 * not as facts — the directories they cluster in, and guidance naming a real
 * command with its arguments. Even a wrong answer should leave the agent
 * somewhere to look, and an agent told plainly that the graph has nothing can
 * spend its next call on a text search instead of on three more graph calls
 * that return the same coincidences.
 */
function emitLowConfidence(
  write: (line: string) => void,
  task: string,
  opts: AgentOptions,
  confidence: ConfidenceAssessment,
  weak: readonly GraphNode[],
  matchedCount: number,
): void {
  const shown = weak.slice(0, MAX_WEAK_MATCHES);
  // No suggested command, deliberately, and this is Part D at its sharpest.
  // Every command this response could name is a graph command, and it has just
  // said the graph has no answer — so `--max-nodes 30` would buy more of the
  // coincidences it is warning about, and cost a whole second call to learn
  // nothing. The genuinely useful next action is not a mex command at all: it is
  // to read the directories named below. That is said in `caveat`, in words,
  // rather than dressed up as a retry.
  const suggestions: string[] = [];
  const ctx = beginResponse("graph scope", opts, task, suggestions);
  const record: Rec = {
    type: "low-confidence",
    reason: confidence.reason,
    message: confidence.reason === "no-match"
      ? "Nothing in the index matched this task."
      : "No declaration in the index covers this task; the matches below share only a common word with it.",
    // Named, not described: enough to recognise a lucky hit, not enough to
    // mistake for an answer.
    weakMatches: shown.map((node) => ({ name: node.name, kind: node.kind, filePath: node.filePath, line: node.startLine })),
    weakMatchCount: matchedCount,
    weakMatchesTruncated: shown.length < matchedCount,
    likelyDirectories: confidence.likelyDirectories,
    // The closing line of every honest empty: what this response is NOT.
    caveat: "No covering declaration was recorded — which is not proof the codebase has none. Search the directories above before concluding it is absent.",
  };
  const emitted = ctx.ledger.tryAdd(record);
  emitAll(write, ctx.meta, emitted ? [record] : []);
  write(JSON.stringify(summaryRecord(ctx, {
    matchedNodes: matchedCount,
    returnedNodes: 0,
    returnedEdges: 0,
    truncated: !emitted,
    maxNodes: opts.maxNodes,
    confidence,
    suggestedNextCommands: suggestions,
  })));
}

/**
 * Most candidates to name when a target is ambiguous.
 *
 * Enough to choose from, few enough that the response stays cheap; the true
 * total and a truncation flag travel beside the list, so a caller is never left
 * inferring the size of the field from the size of the sample.
 */
const MAX_AMBIGUOUS_CANDIDATES = 10;

/**
 * The bounded `(returned, total, truncated)` triple per evidence label.
 *
 * The two resolution failures stay apart because they are different facts: "no
 * declaration eligible for that reference kind bore the name" and "several did
 * and the resolver declined to choose" call for different next moves, and
 * collapsing them into one number throws away which one this is. `returned`
 * counts what the budget actually let through, so it can differ from what the
 * evidence layer selected — the totals stay the store's, the returns stay the
 * response's.
 */
function evidenceCounts(evidence: TargetEvidence, emitted: readonly Rec[]): Rec {
  const returnedFor = (label: EvidenceResolution): number =>
    emitted.filter((record) => record.resolution === label).length;
  const group = (label: EvidenceResolution, count: number): Rec => {
    const returned = returnedFor(label);
    return { returned, total: count, truncated: returned < count };
  };
  return {
    related: group("related-edge", evidence.related.count),
    unresolved: group("unresolved", evidence.unresolved.count),
    ambiguous: group("ambiguous", evidence.ambiguous.count),
  };
}

/** Build the ambiguous payload: a bounded sample, the true count, and the flag. */
function ambiguousPayload(target: string, candidates: GraphNode[]): Rec {
  const shown = candidates.slice(0, MAX_AMBIGUOUS_CANDIDATES);
  return {
    target,
    candidates: shown.map(nodeRef),
    candidateCount: candidates.length,
    candidatesTruncated: shown.length < candidates.length,
  };
}

// ── shared helpers ──────────────────────────────────────────────────────────

/** Stable worst-case width for numeric summary fields, so the reserve covers them. */
const SIZE_PROBE = 9_999_999;
/** Slack over the anticipated summary size (covers node-id/name length variance). */
const RESERVE_PAD = 16;

interface ResponseCtx {
  ledger: BudgetLedger;
  meta: Rec;
  effectiveMax: number;
  requested: number;
}

/**
 * Set up a response so the token ceiling is genuinely hard. The summary reserve is
 * sized from the ACTUAL summary shape (its suggested commands can carry long node
 * ids/names), and the ceiling is clamped up to a framing floor (one meta + one
 * summary) so mandatory framing can never silently exceed the reported budget.
 * `anticipatedSuggestions` sizes the reserve; the final summary recomputes them
 * from what was actually returned (same fixed-width ids, so the reserve holds).
 * A clamp is surfaced as truncation.
 */
function beginResponse(command: string, opts: AgentOptions, task: string | undefined, anticipatedSuggestions: string[]): ResponseCtx {
  const requested = opts.maxOutputTokens;
  const reserve = estimateTokens(summarySkeleton(anticipatedSuggestions)) + RESERVE_PAD;
  const framingFloor = estimateTokens(metaRecord(command, { ...opts, maxOutputTokens: SIZE_PROBE }, task)) + reserve;
  const effectiveMax = Math.max(requested, framingFloor);
  const meta = metaRecord(command, { ...opts, maxOutputTokens: effectiveMax }, task);
  const ledger = new BudgetLedger(effectiveMax, reserve);
  ledger.frame(meta);
  return { ledger, meta, effectiveMax, requested };
}

function summarySkeleton(suggestions: string[]): Rec {
  return {
    type: "summary", matchedNodes: SIZE_PROBE, returnedNodes: SIZE_PROBE, returnedEdges: SIZE_PROBE,
    maxOutputTokens: SIZE_PROBE, truncated: true, truncatedBy: "max-output-tokens",
    suggestedNextCommands: suggestions, estimatedOutputTokens: SIZE_PROBE,
  };
}

/**
 * Which ceiling actually withheld results, or undefined when nothing was.
 *
 * `truncated: true` on its own tells an agent that it did not get everything and
 * nothing about how to get more — so an agent that reads the signal and retries
 * with a bigger `--max-nodes` pays for a second identical response when the
 * binding limit was the token budget. At default settings that is the common
 * case: 11 facts is roughly 1,500 tokens, so a request for 30 is bound by the
 * ledger long before it is bound by `--max-nodes`.
 *
 * The ledger is checked first because it is the outer ceiling: when both bind,
 * raising `--max-nodes` alone changes nothing.
 */
function truncationCause(ctx: ResponseCtx, returned: number, maxNodes: number): string | undefined {
  if (ctx.ledger.droppedAny || ctx.ledger.overBudget || ctx.effectiveMax > ctx.requested) return "max-output-tokens";
  return returned >= maxNodes ? "max-nodes" : undefined;
}

function metaRecord(command: string, opts: AgentOptions, task?: string): Rec {
  return {
    type: "meta", schemaVersion: SCHEMA_VERSION, command,
    ...(task !== undefined ? { task } : {}),
    detail: opts.detail, maxNodes: opts.maxNodes, maxOutputTokens: opts.maxOutputTokens,
  };
}

function summaryRecord(
  ctx: ResponseCtx,
  fields: {
    matchedNodes: number; returnedNodes: number; returnedEdges: number; truncated: boolean;
    suggestedNextCommands: string[];
    /** The caller's node cap, so truncation can name which ceiling bound. */
    maxNodes: number;
    /** The same command, widened — suggested only when a ceiling actually bound. */
    widen?: (cause: string) => string;
    /** A recoverable outcome, when the response carries one instead of results. */
    outcome?: Outcome;
    /** Per-label evidence totals, when a fallthrough supplied a partial answer. */
    evidence?: Rec;
    /**
     * The confidence assessment for this response, when one was made. Passed as
     * the assessment object rather than as a level string so that this — the one
     * place that decides what the rest of the summary says — reads the same
     * value the emitter did. See {@link retractsConfidentFraming}.
     */
    confidence?: ConfidenceAssessment;
  },
): Rec {
  const truncated = fields.truncated || ctx.ledger.droppedAny || ctx.ledger.overBudget || ctx.effectiveMax > ctx.requested;
  const cause = truncated ? truncationCause(ctx, fields.returnedNodes, fields.maxNodes) : undefined;
  // Part D: a response that has just said it does not know must stop saying, in
  // the same breath, that there is plenty more of this and here is how to get
  // it. `widen` is precisely that claim — it invites a retry that returns more
  // of the answer the response has already declared not worth having. The
  // suppression is derived from the same assessment object the low-confidence
  // record was built from, so the hedge and the framing it retracts cannot
  // disagree: there is no level string compared in two places and no field to
  // remember to clear.
  const retract = retractsConfidentFraming(fields.confidence);
  const widened = !retract && cause !== undefined && fields.widen ? [fields.widen(cause)] : [];
  const base: Rec = {
    type: "summary",
    matchedNodes: fields.matchedNodes,
    returnedNodes: fields.returnedNodes,
    returnedEdges: fields.returnedEdges,
    maxOutputTokens: ctx.effectiveMax,
    truncated,
    // Which ceiling withheld the rest, so the retry that follows can be the one
    // that actually changes the answer. Absent when nothing was withheld.
    ...(cause !== undefined ? { truncatedBy: cause } : {}),
    // What this response is, when it is not a list of results. Additive: absent
    // on every response that carries results, which is every response that
    // carried them before.
    ...(fields.outcome !== undefined ? { outcome: fields.outcome } : {}),
    ...(fields.evidence !== undefined ? { evidence: fields.evidence } : {}),
    ...(fields.confidence !== undefined ? { confidence: fields.confidence.level } : {}),
    suggestedNextCommands: [...fields.suggestedNextCommands, ...widened],
  };
  return { ...base, estimatedOutputTokens: ctx.ledger.estimatedTokens + estimateTokens({ ...base, estimatedOutputTokens: SIZE_PROBE }) };
}

/** Whether this response must withhold framing that would contradict its own hedge. */
function retractsConfidentFraming(confidence: ConfidenceAssessment | undefined): boolean {
  return confidence?.level === "low";
}

/**
 * Plan grouped-per-file source records for `nodes` (deduped by id) under the
 * ledger, only when detail is "source". Sets `sourceIncluded` on the already-built
 * `facts` records to reflect whether each node's source actually fit the budget.
 * Returns the source records to emit.
 */
function planSource(
  ledger: BudgetLedger,
  nodes: GraphNode[],
  rootDir: string,
  opts: AgentOptions,
  facts: Rec[] = [],
): Rec[] {
  if (opts.detail !== "source") {
    for (const fact of facts) fact.sourceIncluded = false;
    return [];
  }
  const sourceRecords: Rec[] = [];
  const sourcedIds = new Set<string>();
  const emit = (record: Rec, ids: string[]): void => {
    if (!ledger.tryAdd(record)) return;
    sourceRecords.push(record);
    for (const id of ids) sourcedIds.add(id);
  };
  for (const [filePath, fileNodes] of groupByFile(dedupeById(nodes))) {
    const ranges = fileNodes
      .map((node) => readNodeSource(node, rootDir, opts.maxSourceLines))
      .filter((range): range is SourceRange => range !== null);
    if (ranges.length === 0) continue;
    const grouped: Rec = { type: "source", filePath, ranges };
    // Prefer one grouped record per file (dedups shared context); if it doesn't
    // fit, degrade to per-range records so partial source still lands.
    if (ledger.fits(grouped)) emit(grouped, ranges.flatMap((range) => range.nodeIds));
    else for (const range of ranges) emit({ type: "source", filePath, ranges: [range] }, range.nodeIds);
  }
  for (const fact of facts) fact.sourceIncluded = typeof fact.id === "string" && sourcedIds.has(fact.id);
  return sourceRecords;
}

function emitAll(write: (line: string) => void, meta: Rec, records: Rec[]): void {
  write(JSON.stringify(meta));
  for (const record of records) write(JSON.stringify(record));
}

/** Quote an argument that may carry spaces, so a suggested command is runnable. */
function quoteArg(value: string): string {
  return /\s/.test(value) ? `"${value.replaceAll('"', '\\"')}"` : value;
}

/**
 * The same call, widened along whichever axis actually bound it.
 *
 * Raising `--max-nodes` when the ledger was the binding ceiling buys nothing,
 * and that is the retry an agent makes when all it is told is `truncated: true`.
 * The multipliers are deliberately modest: this is a suggestion the agent may
 * take, not a new default, and doubling twice is cheaper to reason about than
 * an estimate of how much budget the withheld records would have needed.
 */
function widenCommand(command: string, opts: AgentOptions): (cause: string) => string {
  return (cause) =>
    cause === "max-output-tokens"
      ? `mex ${command} --max-nodes ${opts.maxNodes} --max-output-tokens ${opts.maxOutputTokens * 4}`
      : `mex ${command} --max-nodes ${opts.maxNodes * 2}`;
}

function buildScopeSuggestions(nodes: GraphNode[], detail: DetailLevel): string[] {
  if (nodes.length === 0) return [];
  const suggestions: string[] = [];
  if (detail !== "source") suggestions.push(`mex graph get ${nodes[0]!.id} --detail source`);
  suggestions.push(`mex graph query who-calls ${nodes[0]!.name}`);
  return suggestions;
}

function factFor(session: AgentGraphSession, id: string, detail: DetailLevel, includeFingerprint: boolean): CompactFact | null {
  const fact = compactFact(session.graph, id, detail);
  if (!fact || !includeFingerprint) return fact;
  const fingerprint = new FingerprintStore(session.db).get(id);
  return fingerprint ? { ...fact, fingerprint: serializeFingerprint(fingerprint) } : fact;
}

function dedupeById(nodes: GraphNode[]): GraphNode[] {
  const seen = new Set<string>();
  const out: GraphNode[] = [];
  for (const node of nodes) {
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    out.push(node);
  }
  return out;
}

function openSession(rootDir: string, deps: AgentCommandDeps, write: (line: string) => void): AgentGraphSession | null {
  try {
    if (deps.open) return deps.open(rootDir);
    const dbPath = resolve(rootDir, ".mex", "graph.db");
    if (!existsSync(dbPath)) {
      writeJson(write, { type: "error", code: "GRAPH_UNAVAILABLE", message: "Run `mex graph` first." });
      return null;
    }
    const graph = createGraphEngine({ rootDir, dbPath });
    const db = openSqlite(dbPath);
    return { graph, db, close: () => { graph.close(); db.close(); } };
  } catch (error) {
    unavailable(write, error);
    return null;
  }
}

function resolveSymbol(graph: GraphEngine, target: string): GraphNode[] {
  const exactId = graph.getNode(target);
  if (exactId) return [exactId];
  const matches = graph.searchNodes(target, { limit: 100 });
  const exact = matches.filter((node) => node.name === target || node.qualifiedName === target);
  return exact.length > 0 ? exact : matches;
}

function nodesForFile(session: AgentGraphSession, rootDir: string, target: string): GraphNode[] {
  const relativeTarget = (target.startsWith("/") ? relative(rootDir, target) : target)
    .replace(/^\.\//, "").replaceAll("\\", "/");
  const rows = session.db.prepare("SELECT id FROM nodes WHERE file_path = ? ORDER BY id").all(relativeTarget) as Array<{ id: string }>;
  return rows.map((row) => session.graph.getNode(row.id)).filter((node): node is GraphNode => node !== null);
}

function transitiveCallers(graph: GraphEngine, root: GraphNode, maxDepth: number): Array<{ node: GraphNode; depth: number }> {
  const seen = new Set([root.id]);
  const queue: Array<{ node: GraphNode; depth: number }> = [{ node: root, depth: 0 }];
  const results: Array<{ node: GraphNode; depth: number }> = [];
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= maxDepth) continue;
    for (const caller of graph.getCallers(current.node.id).sort(byId)) {
      if (seen.has(caller.id)) continue;
      seen.add(caller.id);
      const entry = { node: caller, depth: current.depth + 1 };
      results.push(entry);
      queue.push(entry);
    }
  }
  return results;
}

function groundedFiles(db: SqliteDatabase, nodeIds: string[]): Array<{ scaffold_file: string; node_id: string }> {
  if (nodeIds.length === 0) return [];
  const placeholders = nodeIds.map(() => "?").join(",");
  return db.prepare(
    `SELECT scaffold_file, node_id FROM _mex_grounded_source WHERE node_id IN (${placeholders}) ORDER BY scaffold_file, node_id`,
  ).all(...nodeIds) as Array<{ scaffold_file: string; node_id: string }>;
}

function nodeRef(node: GraphNode): Record<string, string | number> {
  return { id: node.id, kind: node.kind, name: node.name, file: node.filePath, line: node.startLine };
}

function byId(left: GraphNode, right: GraphNode): number { return left.id.localeCompare(right.id); }
function isRelation(value: string): value is QueryRelation {
  return value === "who-calls" || value === "what-calls" || value === "where-defined";
}
function writeJson(write: (line: string) => void, value: unknown): void { write(JSON.stringify(value)); }
function unavailable(write: (line: string) => void, error: unknown): void {
  writeJson(write, {
    type: "error",
    code: "GRAPH_UNAVAILABLE",
    message: error instanceof Error ? error.message : String(error),
  });
}
