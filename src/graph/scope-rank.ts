// ============================================================================
// mex code-graph — task-scope scoring  (scope)
// ============================================================================
//
// `selectScope` answers a different question from `search()`. Search is given a
// query and asked which node it names; scope is given a *task* — a sentence —
// and asked which handful of declarations an agent should read to do it. The
// ranking underneath (`search/rank.ts`) already orders the whole-task hits well.
// What this module fixes is the tier layered on top of them: the exact-name
// boost scope awards to a node whose name is literally one of the task's words.
//
// **Why that boost was the defect.** It was a constant. A three-word task like
// "user organization membership" made an exact-name match on `membership` worth
// 1.0, while the best whole-task hit — ranked by the search layer over the
// entire sentence — topped out at 0.6. So matching ONE word of the question
// exactly beat matching the WHOLE question well, and because every such node
// scored exactly the same constant, they tied and the order among them fell
// through to the node id, which is a content hash. Measured on a 22,506-node
// index, the first fact returned for a realistic task was a local variable
// declared inside a spec file 8 times out of 10.
//
// The replacement keeps the boost but makes it earn its value, from three
// signals about the SAME node/task pair:
//
//   1. **coverage** — how much of the task the node's name accounts for,
//      weighted so that a word naming half the corpus counts for less than a
//      word naming almost nothing;
//   2. **the identifier exemption** — when the user plainly typed a symbol
//      name, the other words of the sentence are context, not evidence against
//      it, and the boost applies at full weight;
//   3. **the plain-word demotion** — the same test read the other way. An exact
//      match on an ordinary dictionary word, with the rest of the task
//      corroborating nothing, is a coincidence and is pushed down.
//
// **One charge per property.** Signals 1 and 3 are two readings of one
// measurement — "how much of this task does the node agree with" — so they are
// combined by taking the stronger, never by multiplying. Multiplying bills a
// node twice for a single observation and lands a genuinely correct answer at a
// few percent of its base, which buries it under nodes that matched nothing in
// particular. The test-file demotion measures something else entirely (where
// the node lives, not what it matched), so it composes as its own multiplier.

import type { QueryTerm } from "./search/query.js";
import { planQuery } from "./search/query.js";
import type { GraphNode } from "./types.js";

/**
 * Shortest task word that can carry meaning. A single character is either a
 * loop variable or punctuation the sanitizer left behind; either way it names
 * nothing and would only dilute the coverage denominator.
 */
const MIN_TERM_LENGTH = 2;

/**
 * Exponent applied to coverage.
 *
 * Two, not one, and the reason is the size of the boost it damps. The exact-name
 * tier awards 1.0 where the whole-task tier tops out at 0.6, so under LINEAR
 * coverage a node accounting for a little over half the task by weight still
 * beats the best answer to the whole of it — and "a little over half" is one
 * word of a two-word task whenever that word is the rarer of the two. Squaring
 * puts the crossover at ~0.77 of the task instead of ~0.6, which is the margin
 * that makes broad agreement beat one loud coincidence.
 *
 * Sensitivity: at 1 the mechanism still fixes most of the measured failures but
 * loses that margin on two-word tasks; at 4 nothing that matched partially can
 * outrank the whole-task tier at all, which costs the cases where a partial
 * match on a rare word IS the answer. Both are ordering changes, not cliffs —
 * the tier is a demotion throughout, so no value here can drop a node out.
 */
const COVERAGE_EXPONENT = 2;

/**
 * Multiplier for an exact name match on a plain word the task did not
 * corroborate.
 *
 * Harder than coverage damping alone because the failure it prevents is worse:
 * without it, "authentication guard" is answered by a two-line local named
 * `guard` in a spec file on the strength of one incidental word. It binds only
 * where it is stronger than coverage damping — above ~0.45 coverage — which is
 * exactly the short-task case coverage handles least well.
 */
const COMMON_WORD_DEMOTION = 0.2;

/**
 * Multiplier for a node declared in a test file.
 *
 * The same value and the same reasoning as the search ranker's: a demotion, not
 * an exclusion, so a task genuinely about a test still finds the test. Any
 * factor in (0, 1) orders two otherwise-equal candidates identically; 0.5 says
 * a test-file node has to be twice as well corroborated to outrank a source
 * node. It is deliberately not a cliff, because the same predicate also routes
 * these nodes into their own quota bucket, and two hard exclusions of the same
 * population would leave a test-only symbol unreachable through scope.
 */
export const TEST_FILE_PENALTY = 0.5;

/** A task word, with what the index knows about how common its name is. */
export interface TaskTerm extends QueryTerm {
  /**
   * Declarations found bearing this exact name, saturating at the per-term
   * fetch limit. A count, not a frequency: scope has no way to ask the engine
   * how large the index is.
   */
  bearers: number;
  /** Share of the task this word carries. Rarer names carry more. */
  weight: number;
}

/**
 * The task words that reach the ranking: sanitized and stopword-filtered by the
 * shared query planner, then stripped of fragments too short to mean anything.
 *
 * Reusing `planQuery` is the point. Scope used to split on non-identifier
 * characters and keep every word of two or more characters, so "how does the
 * user organization membership work" arrived as eight terms including `how`,
 * `does`, `the` and `work` — four words that match a large fraction of any
 * index, name nothing, and each add a full unit to the coverage denominator.
 * The stopword set already exists and is already reviewed; scope had simply
 * never been wired to it.
 *
 * If the length filter empties the list, the planner's terms are used as they
 * are — the same shape as its own all-stopword fallback, and for the same
 * reason: a task that reduces to nothing is a task nothing can answer.
 */
export function taskTerms(task: string): QueryTerm[] {
  const planned = planQuery(task).terms;
  const kept = planned.filter((entry) => entry.term.length >= MIN_TERM_LENGTH);
  return kept.length > 0 ? kept : planned;
}

/**
 * How much of a task one word carries, from the number of declarations that
 * bear its name.
 *
 * This is the half the mechanism this was modelled on leaves out, and leaving it
 * out has a cost: weighting only *how many* words matched treats a task carrying
 * one word that names half the codebase exactly like one carrying a word that
 * names a single function, so a node is charged the same for failing to account
 * for a word that could not have discriminated anything. A saturating inverse of
 * the bearer count fixes that with no corpus statistics to plumb through — 0
 * bearers scores 1.0, one bearer 0.63, twelve 0.26, twenty 0.23. The spread is
 * about 4x across the observable range, which is enough to reorder two words of
 * a task and never enough to let one word stand in for the whole of it.
 *
 * Saturation is a feature, not a limitation of the fetch: past a couple of dozen
 * declarations sharing a name, "how common is this" has already been answered.
 */
export function termWeight(bearers: number): number {
  return 1 / Math.log2(2 + Math.max(0, bearers));
}

/** Attach bearer counts and weights to planned task terms. */
export function weighTerms(terms: readonly QueryTerm[], bearersOf: (term: QueryTerm) => number): TaskTerm[] {
  return terms.map((entry) => {
    const bearers = bearersOf(entry);
    return { ...entry, bearers, weight: termWeight(bearers) };
  });
}

/** Whether a node's declared name accounts for a task word. */
function accountsFor(node: GraphNode, term: string): boolean {
  return node.name.toLowerCase().includes(term) || node.qualifiedName.toLowerCase().includes(term);
}

/**
 * The weighted share of the task this node's name accounts for, in [0, 1].
 *
 * Measured against the node's declared and qualified names rather than by asking
 * the index one term at a time. That is a deliberate divergence: an index probe
 * describes the matching that actually happened, which is the better question,
 * but `selectScope` is handed a `GraphEngine` whose only retrieval verb is
 * `searchNodes(query, { limit })`. Probing it per term would judge candidates
 * inside the fetch window differently from identical candidates just outside it,
 * making coverage a function of fetch depth rather than of the node. A name test
 * is total — every candidate is measured the same way — which is what a ranking
 * signal has to be. The cost is that a match earned through a docstring or a
 * signature does not count toward coverage, and that is the right cost to pay
 * here: scope is choosing DECLARATIONS to read, and a declaration's name is what
 * says whether it is about the task.
 */
export function taskCoverage(node: GraphNode, terms: readonly TaskTerm[]): number {
  const total = terms.reduce((sum, entry) => sum + entry.weight, 0);
  if (total === 0) return 1;
  const matched = terms.reduce((sum, entry) => (accountsFor(node, entry.term) ? sum + entry.weight : sum), 0);
  return matched / total;
}

/**
 * The corroboration multiplier for an exact-name match: what fraction of the
 * full boost this match has earned.
 *
 * Returns exactly 1 — the score the flat boost used to hand out unconditionally
 * — in the two cases where the flat boost was right all along: a task that IS a
 * symbol name (coverage 1, which every single-word task has by definition), and
 * a task in which the user typed something identifier-shaped that this node is
 * named. Symbol lookup through scope is therefore scored exactly as it was
 * before this existed, which is the property that lets the whole mechanism ship
 * without a regression in the thing scope already did well.
 */
export function corroboration(coverage: number, distinctiveExact: boolean): number {
  if (distinctiveExact) return 1;
  const covered = coverage ** COVERAGE_EXPONENT;
  // One charge per property: `commonWord` is `coverage < 1` plus a name test, so
  // it and coverage damping read the same measurement. Take the stronger.
  const commonWord = coverage < 1 ? COMMON_WORD_DEMOTION : 1;
  return Math.min(covered, commonWord);
}

/**
 * Score an exact-name match on `node` for a task, in [0, 1].
 *
 * `matchedTerms` are the task words this node's name matches exactly. The
 * exemption keys on how the user TYPED the word, never on the name that
 * matched: a task asking about "the flat object layout" must not be answered by
 * a constant named `FLAT` on the grounds that the constant looks like an
 * identifier — it always does, it is one. Only the typed token can say whether
 * a symbol was meant.
 */
export function exactNameScore(node: GraphNode, terms: readonly TaskTerm[], matchedTerms: readonly QueryTerm[]): number {
  const distinctiveExact = matchedTerms.some((entry) => entry.identifierLike);
  return corroboration(taskCoverage(node, terms), distinctiveExact);
}
