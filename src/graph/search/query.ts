// ============================================================================
// mex code-graph — query planning  (search)
// ============================================================================
//
// Turns the raw string a caller passed to `GraphStore.search` into a plan the
// SQL layer and the ranker can both read: the terms to hand the FTS index, and
// what is known about each of them.
//
// Two things happen here that did not happen before, and both are about the
// difference between a *question* and a *symbol*:
//
//   1. Stopwords are dropped. `search()` used to OR-join every whitespace-
//      separated word, so a task phrased as English ("where is the token
//      refreshed on failure") let `on`, `is` and `the` match half the index and
//      decide the ranking. Filler words no longer reach the index.
//   2. Terms are marked `identifierLike`. A word the user typed with a
//      camelCase hump, an underscore or a digit is a symbol they named on
//      purpose; a plain dictionary word in a multi-word question is not. The
//      ranker uses that distinction to decide whether an exact name match is
//      evidence or coincidence — see `rank.ts`.
//
// The FTS-operator handling is unchanged from the original `search()`: strip
// the characters FTS5 treats as syntax, drop bareword operators, and quote each
// term before prefixing it. It was already correct and is only moved here.

import { QUERY_STOPWORDS } from "./stopwords.js";

/** One planned query word, kept in both the typed and the indexed form. */
export interface QueryTerm {
  /** The word as typed, case intact. The only form that can show intent. */
  raw: string;
  /** Lowercased form — what the index and the exact-name test compare against. */
  term: string;
  /**
   * True when `raw` looks like an identifier the user deliberately typed
   * (camelCase, PascalCase, snake_case, or containing a digit).
   */
  identifierLike: boolean;
}

/** A planned query: what to search for, and what was set aside getting there. */
export interface QueryPlan {
  /** The query as given, trimmed. Kept so a file path can be matched whole. */
  raw: string;
  /** Terms handed to the index, in the order typed. Empty only if `raw` is. */
  terms: QueryTerm[];
  /** True when every word was a stopword and the unfiltered terms were used. */
  usedStopwordFallback: boolean;
  /** Stopwords removed from the query. Useful when explaining a bad result. */
  dropped: string[];
}

/** Characters FTS5 reads as syntax, plus the separators a query arrives with. */
const FTS_SYNTAX = /[."'*():^-]/g;
const FTS_OPERATOR = /^(AND|OR|NOT|NEAR)$/i;

/**
 * Whether a token looks like an identifier the user deliberately typed, rather
 * than a plain dictionary word (`token`, `flat`, `check`).
 *
 * **Classified from the token AS TYPED, never from the name that matched**, and
 * that direction is the whole point. The query `flat object` matching a
 * constant named `FLAT` must not count as "the user named this symbol" — they
 * typed an adjective and an unrelated declaration happened to spell it. Judging
 * by the matched name would decide the opposite in exactly the case that
 * matters.
 *
 * A leading capital alone is not evidence (sentence case, proper nouns), so
 * only a capital after the first character counts.
 */
export function isIdentifierLike(token: string): boolean {
  if (token.length === 0) return false;
  if (/[_$0-9]/.test(token)) return true;
  return /[A-Z]/.test(token.slice(1));
}

/**
 * Plan a raw query string: sanitize, drop stopwords, mark identifier-shaped
 * terms.
 *
 * **The all-stopword fallback is load-bearing.** "how does it work" is entirely
 * stopwords; filtering leaves nothing, and a search for nothing returns
 * nothing. Falling back to the unfiltered terms makes that query a badly ranked
 * search instead of a failed one, which is the right trade every time.
 */
export function planQuery(query: string): QueryPlan {
  const raw = query.trim();
  const all: QueryTerm[] = raw
    .replace(FTS_SYNTAX, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0 && !FTS_OPERATOR.test(token))
    .map((token) => ({
      raw: token,
      term: token.toLowerCase(),
      identifierLike: isIdentifierLike(token),
    }));

  const kept = all.filter((entry) => !QUERY_STOPWORDS.has(entry.term));
  const usedStopwordFallback = kept.length === 0 && all.length > 0;
  return {
    raw,
    terms: usedStopwordFallback ? all : kept,
    usedStopwordFallback,
    dropped: all.filter((entry) => QUERY_STOPWORDS.has(entry.term)).map((entry) => entry.term),
  };
}

/**
 * Build the FTS5 MATCH expression: every term quoted, prefixed, and OR-joined.
 *
 * OR rather than FTS5's implicit AND: under AND every term must prefix-match
 * the same node, which no declaration satisfies for a sentence-length query.
 * OR admits anything matching a term and leaves the choice between them to the
 * ranker, which is where that choice belongs.
 */
export function toMatchExpression(plan: QueryPlan): string {
  return plan.terms.map((entry) => `"${entry.raw}"*`).join(" OR ");
}
