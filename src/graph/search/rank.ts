// ============================================================================
// mex code-graph — result ranking  (search)
// ============================================================================
//
// Re-scores an over-fetched candidate pool before `search()` slices it to the
// caller's limit.
//
// **Why re-scoring needs an over-fetch, stated once because everything here
// depends on it.** Post-hoc scoring can only reorder rows the SQL already
// returned; a rule that would promote a row from position 300 to position 1
// does nothing if the fetch stopped at 100. So the store fetches several times
// the requested page, ranks the pool, then takes the page.
//
// The pool is ordered by two things, in this order:
//
//   1. a **match class** — what kind of answer this node is to this query;
//   2. within a class, the **retrieval score** (bm25, higher is better), with a
//      multiplier for nodes that live in test files.
//
// Classes rather than one blended number, because the failure being fixed is
// not a scoring imprecision: bm25 has no notion of "this node IS the thing you
// named". It scores `PatTokenResolver` and `PatTokenResolver::constructor` on
// field-length arithmetic, and the constructor wins because its qualified name
// carries the queried word in a shorter field. No weight tuning fixes that,
// because the two are genuinely close by every measure bm25 has. A class says
// the thing bm25 cannot: one of them is the answer.

import type { NodeKind } from "../types.js";
import type { QueryPlan } from "./query.js";

/** A pool entry: node identity, plus a retrieval score (higher is better). */
export interface SearchCandidate {
  id: string;
  kind: NodeKind;
  name: string;
  qualifiedName: string;
  filePath: string;
  /** bm25-derived, higher is better. 0 for tiers that carry no bm25 score. */
  base: number;
}

/** A ranked pool entry, carrying the class it landed in. */
export interface RankedCandidate extends SearchCandidate {
  matchClass: MatchClass;
  score: number;
}

/**
 * Ordered answer classes, best first.
 *
 *   - `exact-file` — the query IS this file's name or path. Someone who types
 *     `PatTokenResolver.ts` wants the file, not the class inside it, and that
 *     is the only case where a `file:` node is the best answer.
 *   - `exact-symbol` — a query term is exactly this node's name. This is the
 *     symbol-lookup guarantee: the thing you named comes back first.
 *   - `symbol` — an ordinary prefix or substring match on a declaration.
 *   - `file` — any other `file:` node.
 *
 * `file:` nodes sit at the bottom because their `name` is derived (the path
 * basename), not declared. It matches a symbol query strongly and sits in a
 * very short FTS field, so bm25 puts the file — and its test file — above the
 * symbol the user asked for. They are demoted rather than excluded because
 * `mex graph query` resolves a file target through this same search, and the
 * `exact-file` class is what keeps that working.
 */
export type MatchClass = "exact-file" | "exact-symbol" | "symbol" | "file";

const CLASS_ORDER: Record<MatchClass, number> = {
  "exact-file": 3,
  "exact-symbol": 2,
  symbol: 1,
  file: 0,
};

/**
 * Multiplier for a node defined in a test file.
 *
 * A demotion, not an exclusion: the test IS the answer when the user is looking
 * for it, and a query naming a symbol that only exists in tests must still find
 * it. It only has to stop a spec file's nodes from outranking the source they
 * exercise — in a corpus checked against this change, a constant destructured
 * as `{ findNearestConfigDir }` in two spec files outranked the function of
 * that name.
 *
 * The value is not sensitive: any factor in (0, 1) orders two otherwise-equal
 * candidates identically, and it applies WITHIN a class, so it can never push a
 * test-file node below a class of weaker answers. 0.5 says a test-file node has
 * to be twice as good by bm25 to outrank an equivalent source node.
 */
const TEST_FILE_PENALTY = 0.5;

/** Path shapes that mark a file as tests across the languages mex indexes. */
const TEST_PATH = /(^|\/)(__tests__|__test__|tests?|spec)\/|\.(test|spec)\.|(^|\/)test_[^/]*$|_test\.[^/.]+$/;

/**
 * Whether a file path belongs to a test/spec file.
 *
 * Path-shaped rather than language-aware on purpose: the same `search()` serves
 * TypeScript, JavaScript, Python and Rust indexes, and every one of them marks
 * tests by directory or filename convention (`__tests__/`, `foo.spec.ts`,
 * `tests/`, `test_foo.py`, `foo_test.rs`).
 */
export function isTestPath(filePath: string): boolean {
  return TEST_PATH.test(filePath);
}

/** Normalize a typed path so a Windows or `./`-prefixed query still matches. */
export function normalizeQueryPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

/**
 * Which query terms may claim an exact-name match.
 *
 * A one-term query is a symbol lookup by definition — nothing else in it could
 * have been meant. In a longer query only identifier-shaped words qualify, so
 * that "where is the flat object built" cannot be answered by a constant named
 * `FLAT` on the strength of one incidental word. Plain words are not thrown
 * away by this: they still match, still rank, and can still win on bm25. What
 * they are denied is the guaranteed top slot.
 *
 * Exported because the store looks these terms up directly — the exact-name
 * tier and the exact-name class have to agree on which words qualify, so the
 * rule lives in one place.
 */
export function exactLookupTerms(plan: QueryPlan): string[] {
  const eligible = plan.terms.length === 1 ? plan.terms : plan.terms.filter((t) => t.identifierLike);
  return eligible.map((entry) => entry.term);
}

/**
 * Terms no candidate in the pool contains, as a case-insensitive substring of
 * its name or qualified name.
 *
 * This is what turns the old zero-results LIKE escape hatch into a tier: a
 * fragment FTS cannot prefix-match (`serby` in `getUserById`) is unmatched
 * whether or not the query's *other* terms returned rows, and only unmatched
 * terms are worth a scan — so the common case, where every term already hit,
 * pays nothing.
 */
export function unmatchedTerms(plan: QueryPlan, candidates: readonly SearchCandidate[]): string[] {
  const haystack = candidates.map((c) => `${c.name} ${c.qualifiedName}`.toLowerCase());
  return [...new Set(plan.terms.map((entry) => entry.term))].filter(
    (term) => !haystack.some((text) => text.includes(term)),
  );
}

/** Classify one candidate against the planned query. */
function classify(
  candidate: SearchCandidate,
  exactTerms: ReadonlySet<string>,
  rawQuery: string,
): MatchClass {
  if (candidate.kind === "file") {
    const name = normalizeQueryPath(candidate.name);
    const path = normalizeQueryPath(candidate.qualifiedName);
    return name === rawQuery || path === rawQuery ? "exact-file" : "file";
  }
  return exactTerms.has(candidate.name.toLowerCase()) ? "exact-symbol" : "symbol";
}

/**
 * Rank the pool. Pure given its inputs: the same pool and plan always produce
 * the same order, and ties break on node id, so a rebuilt graph yields
 * byte-identical output.
 */
export function rankCandidates(
  candidates: readonly SearchCandidate[],
  plan: QueryPlan,
): RankedCandidate[] {
  const exactTerms = new Set(exactLookupTerms(plan));
  const rawQuery = normalizeQueryPath(plan.raw);

  // bm25 can legitimately score every candidate 0 — a term present in nearly
  // every indexed node separates nothing — and the supplement and LIKE tiers
  // carry no bm25 at all. A multiplier on 0 decides nothing, so give those rows
  // a floor: far below any real score when there is one (they must not overtake
  // a row bm25 actually ranked), a plain unit when there is none.
  const maxBase = candidates.reduce((max, entry) => Math.max(max, entry.base), 0);
  const floor = maxBase > 0 ? maxBase * 1e-6 : 1;

  const ranked = candidates.map((candidate) => ({
    ...candidate,
    matchClass: classify(candidate, exactTerms, rawQuery),
    score: Math.max(candidate.base, floor) * (isTestPath(candidate.filePath) ? TEST_FILE_PENALTY : 1),
  }));

  // Total order, so the same pool always comes back the same way. Name length
  // sits before the id tie-break because whole classes of candidate carry no
  // bm25 at all (the exact-name and substring tiers) and would otherwise be
  // ordered by hash: between two equally-scored matches the shorter name is the
  // more specific one — `findNearestConfigDir` before `{ findNearestConfigDir }`.
  ranked.sort(
    (a, b) =>
      CLASS_ORDER[b.matchClass] - CLASS_ORDER[a.matchClass] ||
      b.score - a.score ||
      a.name.length - b.name.length ||
      a.id.localeCompare(b.id),
  );
  return ranked;
}
