import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { GraphEngine } from "./engine.js";
import type { QueryTerm } from "./search/query.js";
import { isTestPath } from "./search/rank.js";
import { exactNameScore, taskTerms, TEST_FILE_PENALTY, weighTerms, type TaskTerm } from "./scope-rank.js";
import type { GraphNode, NodeKind } from "./types.js";

export type DetailLevel = "minimal" | "standard" | "source";

/**
 * Ephemeral, agent-facing fact for one graph node — structure and relationship
 * counts, never the source body. Source is a separate, opt-in {@link SourceRange}
 * record. Never persisted.
 */
export interface CompactFact {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature?: string;
  callerCount: number;
  calleeCount: number;
  detail: DetailLevel;
  sourceIncluded: boolean;
  /** Short content hash (node body sha256) for cache-aware source expansion. */
  bodyHash?: string;
  /** Full serialized minhash fingerprint. Opt-in (--fingerprint); used by grounding. */
  fingerprint?: string;
  /** Relevance score in [0,1]. Present on `scope` facts only. */
  score?: number;
  /** Why this node was selected (e.g. "exact-name-match"). Scope facts only. */
  selectionReasons?: string[];
}

/** Quota bucket for scope selection diversity. */
export type SelectionCategory = "direct" | "neighbor" | "test";

/** A ranked scope candidate with its reasons and quota bucket. */
export interface ScopedCandidate {
  id: string;
  score: number;
  reasons: string[];
  category: SelectionCategory;
}

/** One node's source body, read on demand and line-capped. */
export interface SourceRange {
  startLine: number;
  endLine: number;
  nodeIds: string[];
  content: string;
  truncated: boolean;
}

/** FTS top-ten seeds expanded by one hop in both call directions. Deduped. */
export function scopeSelect(graph: GraphEngine, task: string): string[] {
  const ids = new Set<string>();
  for (const seed of graph.searchNodes(task, { limit: 10 })) {
    ids.add(seed.id);
    for (const caller of graph.getCallers(seed.id)) ids.add(caller.id);
    for (const callee of graph.getCallees(seed.id)) ids.add(callee.id);
  }
  return [...ids];
}

/**
 * Relative share of the returned nodes each category may claim.
 *
 * The numbers are a ratio, not a count. They used to be the count — a fixed
 * 5/4/2 consulted before `maxNodes` — which made 11 the true ceiling of every
 * scope call no matter what the caller asked for, so `--max-nodes 30` and
 * `--max-nodes 100` returned the same nine facts as `--max-nodes 10`. The point
 * of the quota is that one category cannot crowd out the others; the point was
 * never the number 11.
 */
const QUOTA_SHARE: Record<SelectionCategory, number> = { direct: 5, neighbor: 4, test: 2 };
const QUOTA_TOTAL = QUOTA_SHARE.direct + QUOTA_SHARE.neighbor + QUOTA_SHARE.test;
const HOP_CAP = 3;

/**
 * Fewest whole-task hits to seed the pool with, regardless of how few nodes the
 * caller asked for. The neighborhood is grown from these, so a request for three
 * nodes still wants a real field to pick them from.
 */
const MIN_SEEDS = 10;

/**
 * Results fetched per task word when looking for exact-name matches.
 *
 * Fixed, and deliberately not scaled with `maxNodes` like the seed fetch is.
 * Two dozen declarations sharing one name is already a degenerate name; past
 * that, more rows add near-identical candidates rather than better ones. The
 * same rows also supply the rarity weights, and a rarity estimate that saturates
 * is the right shape — see `termWeight`.
 */
const TERM_SEARCH_LIMIT = 20;

/**
 * Score band for whole-task hits: best hit at the top, last hit at the bottom,
 * spread evenly across however many came back.
 *
 * A band rather than the fixed per-rank decrement it replaces, because the seed
 * fetch now scales with `maxNodes`: a constant step sized for ten hits walks
 * past the neighbor score at the twentieth and past zero at the twenty-first,
 * so a large request would have ranked its own direct matches below one-hop
 * neighbors and then below nothing at all. The floor sits above the neighbor
 * score because a node that matched the task is better evidence than a node
 * that merely calls one, however far down the list it came.
 */
const SEED_SCORE_MAX = 0.6;
const SEED_SCORE_MIN = 0.35;
const NEIGHBOR_SCORE = 0.3;

/**
 * Per-category caps for a given `maxNodes`, keeping the shares proportional.
 *
 * Every category keeps at least one slot: a request small enough to round a
 * share to zero should still be able to show a neighbor or a test, and a floor
 * is cheaper to reason about than a remainder-distribution rule. The shares sum
 * to slightly more than `maxNodes` at small sizes because of that floor and the
 * rounding, which is harmless — `maxNodes` is enforced separately and remains
 * the real cap.
 */
function quotaFor(maxNodes: number): Record<SelectionCategory, number> {
  const scale = (share: number): number => Math.max(1, Math.round((maxNodes * share) / QUOTA_TOTAL));
  return {
    direct: scale(QUOTA_SHARE.direct),
    neighbor: scale(QUOTA_SHARE.neighbor),
    test: scale(QUOTA_SHARE.test),
  };
}

interface Candidate {
  node: GraphNode;
  score: number;
  reasons: Set<string>;
  category: SelectionCategory;
}

/** Test-file membership, shared with search ranking so both agree on it. */
function isTestNode(node: GraphNode): boolean {
  return isTestPath(node.filePath);
}

/** Whether a node is named exactly by a task word — its own name, or the tail of its qualified name. */
function namedBy(node: GraphNode, term: string): boolean {
  const name = node.name.toLowerCase();
  const qualified = node.qualifiedName.toLowerCase();
  return name === term || qualified === term || qualified.endsWith(`::${term}`);
}

/**
 * Scored, quota-limited scope selection. Combines whole-task semantic search,
 * exact identifier matches (scored by how much of the task they corroborate, so
 * an explicitly named symbol survives trimming and an incidental word does not),
 * and a capped one-hop neighborhood, then applies proportional per-category
 * quotas under `maxNodes`. Deterministic: ties break by node id.
 *
 * Returns the picked candidates plus `matchedCount`, the size of the candidate
 * pool before the cap (so callers can report truncation).
 */
export function selectScope(
  graph: GraphEngine,
  task: string,
  maxNodes: number,
): { candidates: ScopedCandidate[]; matchedCount: number } {
  const pool = new Map<string, Candidate>();
  const add = (node: GraphNode, score: number, reason: string, bucket: SelectionCategory): void => {
    const category = isTestNode(node) ? "test" : bucket;
    const existing = pool.get(node.id);
    if (existing) {
      existing.score = Math.max(existing.score, score);
      existing.reasons.add(reason);
      if (category === "direct") existing.category = "direct";
    } else {
      pool.set(node.id, { node, score, reasons: new Set([reason]), category });
    }
  };

  // The pool has to be at least as large as what the caller asked for, or
  // `maxNodes` is a cap on nothing: the seed fetch was a hard 10, so a request
  // for 30 selected from at most ten whole-task hits plus their neighbors.
  const seeds = graph.searchNodes(task, { limit: Math.max(MIN_SEEDS, maxNodes) });
  const span = Math.max(1, seeds.length - 1);
  seeds.forEach((node, i) =>
    add(node, SEED_SCORE_MAX - ((SEED_SCORE_MAX - SEED_SCORE_MIN) * i) / span, "semantic-match", "direct"));

  // One search per task word, reused twice over: it supplies the exact-name
  // candidates AND — through how many of its hits bear the word as a name — the
  // rarity weight that decides how much of the task that word is worth. The
  // second reading costs nothing; the rows were already fetched.
  const planned = taskTerms(task);
  const hitsByTerm = new Map<string, GraphNode[]>();
  for (const entry of planned) {
    if (!hitsByTerm.has(entry.term)) hitsByTerm.set(entry.term, graph.searchNodes(entry.raw, { limit: TERM_SEARCH_LIMIT }));
  }
  const terms: TaskTerm[] = weighTerms(planned, (entry) =>
    (hitsByTerm.get(entry.term) ?? []).filter((node) => namedBy(node, entry.term)).length,
  );

  const exactMatches = new Map<string, { node: GraphNode; matched: QueryTerm[] }>();
  for (const entry of terms) {
    for (const match of hitsByTerm.get(entry.term) ?? []) {
      if (!namedBy(match, entry.term)) continue;
      const seen = exactMatches.get(match.id);
      if (seen) seen.matched.push(entry);
      else exactMatches.set(match.id, { node: match, matched: [entry] });
    }
  }
  for (const { node, matched } of exactMatches.values()) {
    add(node, exactNameScore(node, terms, matched), "exact-name-match", "direct");
  }

  const directSeeds = [...pool.values()]
    .filter((c) => c.category === "direct")
    .sort((a, b) => b.score - a.score || a.node.id.localeCompare(b.node.id))
    .slice(0, 6);
  for (const seed of directSeeds) {
    for (const caller of graph.getCallers(seed.node.id).slice(0, HOP_CAP)) add(caller, NEIGHBOR_SCORE, "caller-of-seed", "neighbor");
    for (const callee of graph.getCallees(seed.node.id).slice(0, HOP_CAP)) add(callee, NEIGHBOR_SCORE, "callee-of-seed", "neighbor");
  }

  // The test-file demotion is applied here rather than at each `add`, because it
  // is a property of the node and not of the evidence that found it: a node
  // reached by three routes must be charged for living in a test file once.
  const scored = [...pool.values()].map((candidate) => ({
    candidate,
    score: candidate.score * (isTestNode(candidate.node) ? TEST_FILE_PENALTY : 1),
  }));
  const ranked = scored.sort((a, b) => b.score - a.score || a.candidate.node.id.localeCompare(b.candidate.node.id));

  // Two passes, because the quota exists to stop one category crowding out the
  // others and NOT to withhold results when the others have nothing to offer.
  // The first pass spends the per-category allowances, guaranteeing every
  // category represented in the pool gets its share of the answer. The second
  // fills whatever `maxNodes` still has room for from the best of the rest —
  // without it, a task whose pool is entirely `direct` returns two facts when
  // five were asked for, which is the original defect wearing a ratio.
  const quota = quotaFor(maxNodes);
  const used: Record<SelectionCategory, number> = { direct: 0, neighbor: 0, test: 0 };
  const picked = new Map<string, { candidate: Candidate; score: number }>();
  for (const entry of ranked) {
    if (picked.size >= maxNodes) break;
    if (used[entry.candidate.category] >= quota[entry.candidate.category]) continue;
    used[entry.candidate.category] += 1;
    picked.set(entry.candidate.node.id, entry);
  }
  for (const entry of ranked) {
    if (picked.size >= maxNodes) break;
    picked.set(entry.candidate.node.id, entry);
  }

  const candidates = [...picked.values()]
    .sort((a, b) => b.score - a.score || a.candidate.node.id.localeCompare(b.candidate.node.id))
    .map(({ candidate, score }) => ({
      id: candidate.node.id,
      // Three places, not two: corroboration scores spread across a range the
      // old flat boost never used, and rounding them to two would collapse the
      // demoted end of it back into a tie broken by node id.
      score: Number(score.toFixed(3)),
      reasons: [...candidate.reasons].sort(),
      category: candidate.category,
    }));
  return { candidates, matchedCount: pool.size };
}

/**
 * Build a compact fact (structure + relationship counts) for a node id, or null
 * if the node no longer exists. `sourceIncluded` reflects whether the caller
 * intends to emit a companion source record (detail === "source").
 */
export function compactFact(graph: GraphEngine, id: string, detail: DetailLevel): CompactFact | null {
  const node = graph.getNode(id);
  if (!node) return null;
  return {
    id: node.id,
    kind: node.kind,
    name: node.name,
    qualifiedName: node.qualifiedName,
    filePath: node.filePath,
    lineStart: node.startLine,
    lineEnd: node.endLine,
    signature: node.signature,
    callerCount: graph.getCallers(id).length,
    calleeCount: graph.getCallees(id).length,
    detail,
    // False at build time; the emitter flips it true only for facts whose source
    // record actually fit the budget (see planSource). Defaulting false keeps the
    // accounted record shape >= the emitted one, so the token ceiling stays hard.
    sourceIncluded: false,
    bodyHash: node.bodyHash,
  };
}

/**
 * Read a node's source body from disk, capped at `maxLines` (0 = unlimited).
 * Returns null when the file cannot be read.
 */
export function readNodeSource(node: GraphNode, rootDir: string, maxLines: number): SourceRange | null {
  let lines: string[];
  try {
    lines = readFileSync(resolve(rootDir, node.filePath), "utf-8").split("\n");
  } catch {
    return null;
  }
  const body = lines.slice(node.startLine - 1, node.endLine);
  const truncated = maxLines > 0 && body.length > maxLines;
  const kept = truncated ? body.slice(0, maxLines) : body;
  return {
    startLine: node.startLine,
    endLine: truncated ? node.startLine + kept.length - 1 : node.endLine,
    nodeIds: [node.id],
    content: kept.join("\n"),
    truncated,
  };
}

/** Group nodes by file path, preserving first-seen order of both files and nodes. */
export function groupByFile(nodes: GraphNode[]): Map<string, GraphNode[]> {
  const groups = new Map<string, GraphNode[]>();
  for (const node of nodes) {
    const bucket = groups.get(node.filePath);
    if (bucket) bucket.push(node);
    else groups.set(node.filePath, [node]);
  }
  return groups;
}
