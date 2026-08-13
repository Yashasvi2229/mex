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
//      multiplier for nodes that live in test files and one for how much of the
//      query the node accounts for.
//
// **Why coverage is here at all.** `search()` OR-joins its terms, so any node
// matching ANY term enters the pool — which is what makes a sentence-shaped
// query work at all, and what leaves bm25 deciding between a node that matched
// one word of three and a node that matched all three on field-length
// arithmetic alone. Naming a symbol still works because the match classes say
// what bm25 cannot; inside the `symbol` class there was no signal whatsoever.
// Coverage is that signal, and because it is applied within a class it can
// reorder equals and can never promote a candidate across a class boundary.
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
  /** Weighted share of the query this candidate accounts for, in [0, 1]. */
  coverage: number;
}

/**
 * What the store observed about the query and the pool, handed to the ranker.
 *
 * The ranker stays pure: it does no SQL, and the same evidence always produces
 * the same order. Both fields are read from the INDEX rather than recomputed
 * from a node's text, because the index stems and segments with a tokenizer
 * this module does not have — a local `name.includes(term)` test answers a
 * slightly different question from the matching that actually happened, and on
 * this corpus the two disagree on about one pool entry in seven.
 */
export interface QueryEvidence {
  /** Distinct query terms each candidate matched, keyed by node id. */
  matched: ReadonlyMap<string, ReadonlySet<string>>;
  /** How many nodes in the whole index each distinct term reaches. */
  reach: ReadonlyMap<string, number>;
}

/**
 * How much of a query one term carries, from how many nodes it reaches.
 *
 * A saturating inverse of the term's reach, so a word naming half the index
 * counts for less than one naming a single declaration, with no corpus
 * statistics to plumb through: 0 nodes scores 1.0, one 0.63, twelve 0.26, a
 * thousand 0.10. The spread is enough to reorder two words of a question and
 * never enough to let one word stand in for the whole of it.
 *
 * Shared with the scope ranker, which weighs task words the same way — the two
 * layers must agree about what makes a word informative, and this is the one
 * place that decides it.
 */
export function termWeight(reach: number): number {
  return 1 / Math.log2(2 + Math.max(0, reach));
}

/**
 * The weighted share of the query a candidate accounts for, in [0, 1].
 *
 * Distinct terms only: a query that repeats a word must not be able to give one
 * node two units of coverage for it. A query with no terms covers everything by
 * definition, which is what keeps an empty or all-stopword plan from damping the
 * entire pool to the floor.
 */
function queryCoverage(id: string, terms: readonly string[], evidence: QueryEvidence): number {
  if (terms.length === 0) return 1;
  const matched = evidence.matched.get(id);
  let total = 0;
  let covered = 0;
  for (const term of terms) {
    const weight = termWeight(evidence.reach.get(term) ?? 0);
    total += weight;
    if (matched?.has(term)) covered += weight;
  }
  return total === 0 ? 1 : covered / total;
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

/**
 * Exponent applied to query coverage.
 *
 * Two, matching the scope ranker, so the two layers damp partial agreement the
 * same way. **It is not load-bearing and no effort should be spent tuning it**:
 * measured on a 22,506-node index, 1, 2 and 3 move no metric in this milestone's
 * table — a candidate's coverage is either 1 (it accounts for the whole query,
 * where every exponent gives 1) or well below the neighbouring candidate's, and
 * the exponent only stretches a gap that already decided the order.
 */
const COVERAGE_EXPONENT = 2;

/**
 * Floor under the coverage multiplier, and it is the one value here that must
 * not be zero.
 *
 * A candidate matching none of the query's terms has coverage 0, and an
 * unfloored `coverage²` would multiply its score by exactly 0 — annihilating
 * the entire ranking layer for that candidate, not damping it, so a whole tier
 * would fall through to the name-length tie-break with every signal above it
 * silently inert. That is reachable here, not theoretical: the substring tier
 * exists precisely to admit candidates FTS could not match, and after this
 * milestone its rows can still carry terms the index cannot see.
 *
 * 0.05 keeps such a candidate ordered by its own base score while putting it
 * firmly below anything that agreed with the query. Sensitivity: at 0.01 and at
 * 0.2 the measured tables are identical — what matters is that it is positive.
 */
const COVERAGE_FLOOR = 0.05;

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
  evidence: QueryEvidence,
): RankedCandidate[] {
  const exactTerms = new Set(exactLookupTerms(plan));
  const rawQuery = normalizeQueryPath(plan.raw);
  const terms = [...new Set(plan.terms.map((entry) => entry.term))];

  // bm25 can legitimately score every candidate 0 — a term present in nearly
  // every indexed node separates nothing — and the supplement and LIKE tiers
  // carry no bm25 at all. A multiplier on 0 decides nothing, so give those rows
  // a floor: far below any real score when there is one (they must not overtake
  // a row bm25 actually ranked), a plain unit when there is none.
  const maxBase = candidates.reduce((max, entry) => Math.max(max, entry.base), 0);
  const floor = maxBase > 0 ? maxBase * 1e-6 : 1;

  // **One charge per property.** Each multiplier below reads a DIFFERENT
  // measurement about the candidate, which is why they compose by multiplying:
  // where the node lives (test file) and how much of the query it accounts for
  // (coverage), on top of what bm25 measured. Two factors
  // derived from the SAME measurement would have to compose by taking the
  // stronger instead — billing a node twice for one observation lands a
  // genuinely correct answer at a few percent of its base, under nodes that
  // matched nothing in particular. The scope ranker applies the same rule to
  // its own two same-measurement factors with a `min`; here no two factors read
  // the same measurement, so there is nothing to collapse.
  const ranked = candidates.map((candidate) => {
    const coverage = queryCoverage(candidate.id, terms, evidence);
    const covered = Math.max(COVERAGE_FLOOR, coverage ** COVERAGE_EXPONENT);
    return {
      ...candidate,
      matchClass: classify(candidate, exactTerms, rawQuery),
      coverage,
      score:
        Math.max(candidate.base, floor) *
        (isTestPath(candidate.filePath) ? TEST_FILE_PENALTY : 1) *
        covered,
    };
  });

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
