// ============================================================================
// mex code-graph — identifier segments  (search)
// ============================================================================
//
// The words a declaration would be called in prose, derived from its name.
//
// **The defect this closes.** FTS5's `unicode61` tokenizer breaks on
// punctuation and `_`, but not on a camelCase hump, so `formatMoney` is indexed
// as the single token `formatmoney`. `format*` prefix-matches it; `money*`
// cannot. Half of every camelCase name is unreachable by the word a person
// would type, and mex's substring tier does not cover the gap — it only fires
// for a term that matches *nothing* in the pool, so `migration` finds nothing
// inside `runMigrations` as long as some other node carries it as a prefix.
//
// **Why the split is indexed rather than applied to the query.** Rewriting the
// query cannot help: the index holds no `money` token for any rewrite to find.
// The segments have to exist as indexed terms, so they are written at index
// time into a column of their own, alongside the compound. The whole name keeps
// its own column at a higher bm25 weight, so an exact-name lookup still matches
// what it always matched.

/** Segments shorter than this carry no prose signal and collide with everything. */
const MIN_SEGMENT_LENGTH = 2;

/**
 * Split an identifier into lowercase word segments.
 *
 * Handles, in one pass over each alphanumeric run:
 *   - camelCase / PascalCase — a capital after a lowercase or digit starts a
 *     word (`formatMoney` → format/money, `base64Encode` → base64/encode);
 *   - the acronym boundary — the last capital of a capital run starts a word
 *     when a lowercase follows (`HTTPServer` → http/server). Without it the run
 *     glues to the next word and `server` stays unreachable;
 *   - snake_case, kebab-case, dotted and slashed names — every non-alphanumeric
 *     is a separator, which is exactly how `unicode61` already segments.
 *
 * Purely derived and order-independent: the same name always yields the same
 * list. Digit-only fragments are dropped (a bare `2` names nothing); digits
 * glued to a word are kept, because that is how they are typed.
 */
export function splitIdentifier(name: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const run of name.match(/[\p{L}\p{N}]+/gu) ?? []) {
    const parts = run.split(/(?<=[\p{Ll}\p{N}])(?=\p{Lu})|(?<=\p{Lu})(?=\p{Lu}\p{Ll})/u);
    for (const part of parts) {
      const segment = part.toLowerCase();
      if (segment.length < MIN_SEGMENT_LENGTH) continue;
      if (/^\p{N}+$/u.test(segment)) continue;
      if (seen.has(segment)) continue;
      seen.add(segment);
      out.push(segment);
    }
  }
  return out;
}

/**
 * The indexed segment text for one node name, or `""` when it has none.
 *
 * Only the *name* is split, never the qualified name: `unicode61` already
 * breaks a qualified name on `.`, `/`, `-` and `::`, so every path word is
 * already an indexed term in its own column. The only words it does not
 * produce are the camelCase segments of the final component — which are
 * exactly these.
 *
 * A segment identical to the whole lowercased name (`resolve`) is dropped: the
 * compound is already indexed in the `name` column at a higher weight, and
 * repeating it here would make one-word names outrank multi-word ones for a
 * reason no reader could defend.
 */
export function segmentsFor(name: string): string {
  const lower = name.toLowerCase();
  return splitIdentifier(name)
    .filter((segment) => segment !== lower)
    .join(" ");
}
