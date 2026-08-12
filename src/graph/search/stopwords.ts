// ============================================================================
// mex code-graph — query stopwords  (search)
// ============================================================================
//
// Words dropped from a *query* before it reaches the index. Nothing is dropped
// from the index itself: a declaration genuinely named `all` or `no` stays
// findable, because a question's grammar is not a property of the code.
//
// One rule governs every entry: NEVER drop a word that is a plausible
// declaration name. `get`, `set`, `add`, `find`, `list`, `run`, `check`,
// `send`, `load`, `parse`, `count`, `total`, `name`, `value`, `key`, `type`,
// `code`, `test`, `config`, `service` are ordinary English *and* ordinary
// identifiers; dropping one costs a lookup that used to work. When a word is
// arguable it is left OUT — a list that is too short loses a little ranking
// precision, a list that is too long loses whole queries.
//
// A second rule lives at the call site (`planQuery`): if filtering empties the
// term list, the UNFILTERED terms are searched instead. Without that, a query
// made only of these words searches for nothing and returns nothing, which is
// a worse answer than a badly ranked one.
//
// English only, deliberately. Every added word is a collision risk against an
// identifier somewhere, and a function word in one language is a content word
// in another (`die`, `hat`, `son`).

/**
 * Grammar: articles, pronouns, auxiliaries, prepositions, conjunctions and
 * question words. The deliberate OMISSIONS are the load-bearing half, and each
 * one was checked against real indexes rather than argued from taste:
 *
 *   - `is`, `has`, `no`, `not` — auxiliaries, and also the most common
 *     predicate-name prefix in real code (`isExported`, `hasFatal`,
 *     `NO_CONTENT`). Dropping them turns the exact lookup `is_exported` into a
 *     search for `exported` alone, which an unrelated symbol can then win.
 *   - `all`, `any`, `out`, `one`, `own`, `same`, `other` — each is a plausible
 *     identifier segment, but none is the *discriminating* half of a name, and
 *     each appears in almost every English question, where it matches broadly
 *     and separates nothing. Kept as stopwords.
 *   - OMITTED `up` — it reads exactly like the words above and is not: a large
 *     TypeScript index used to check this list held 126 methods named `up`
 *     (migration files pair `up`/`down`). A word that names a whole convention
 *     is not filler, and dropping only half the pair would be worse still.
 *   - `work` / `works` / `working` — plausible identifiers, overwhelmingly
 *     question framing ("how does X work"). The all-stopword fallback covers
 *     the degenerate query.
 *   - `show`, `give`, `tell` — imperative framing an agent prepends to a
 *     question, unlike `get`/`set`, which are excluded from this list.
 */
const GRAMMAR = `
a about after also am an and any are as at be because been before being both
but by can could did do does doing during each either else every few for from
had have he her here hers him his how i if in into it its itself just may me
might more most much must my neither nor now of on once only or other ought
our ours out over own same shall she should so some such than that the their
theirs them then there these they this those through thus to too under until
upon us very was we were what when where whether which while who whom whose
why will with within would you your yours
show give tell work works working used using done made
`;

/**
 * Words that name the KIND of thing being asked for rather than the thing
 * itself: "which function parses the header" is a question about `parse` and
 * `header`. Deliberate omissions again carry the reasoning:
 *
 *   - OMITTED `type` — `type_alias` is a real node kind and `type` is a real
 *     declaration name in every language the graph indexes. Ranking is the
 *     right tool for type noise; a stopword is too blunt.
 *   - OMITTED `code`, `test`, `config`, `service`, `module` — all are domain
 *     words that appear as declaration names constantly. Removing them breaks
 *     ordinary lookups for a gain that is close to zero.
 *   - KEPT `file`/`files` — a file *path* is not in the searchable text at all
 *     (only the basename is, on `file:` nodes), so the word can only match
 *     incidentally in a prose query. A query that is only `file` still works,
 *     via the all-stopword fallback.
 */
const KIND_NOISE = `
file files function functions method methods class classes bug fix
`;

/** The committed set: lowercase, deduplicated, frozen at module load. */
export const QUERY_STOPWORDS: ReadonlySet<string> = new Set(
  `${GRAMMAR} ${KIND_NOISE}`.split(/\s+/).filter((word) => word.length > 0),
);
