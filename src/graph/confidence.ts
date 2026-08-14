// ============================================================================
// mex code-graph — saying "I don't know" when the index has no answer
// ============================================================================
//
// `graph scope` always returns something. Asked about a subject the codebase
// does not contain, it returns its best guesses at the same scores a genuine hit
// receives — measured over 25 realistic tasks against a 22,506-node index, nine
// had no declaration covering them anywhere and all nine were answered
// confidently, for about 1,362 tokens each. An agent cannot tell those nine from
// the sixteen that were right, so it learns to distrust all twenty-five and
// reaches for a text search instead. That is the whole failure this module
// exists to stop, and it is the expensive kind: the tool is paid for twice.
//
// **A zero-result guard cannot catch it.** The results exist. They are simply
// not about the question — a task about cache invalidation matching a class
// called `ProgramStatusChangeEvent` because both contain a common word. So the
// question the predicate asks is not "did anything match" but "did anything
// match for a reason worth acting on".
//
// **The predicate is binary and structural, not a threshold.** There is no
// score to compare and no constant to tune, because a tuned cutoff on this
// measurement is a memorised answer key: the input is a natural-language
// sentence, and a number fitted to separate one set of sentences says nothing
// about the next one. What it reads instead are three facts that generalise —
// how many content words the task has, whether the user typed a symbol name,
// and how many distinct words of the task a candidate accounts for.
//
// **The asymmetry that sets the rules.** Missing a low-confidence task returns a
// mediocre answer, which is what the command does today — no regression. Wrongly
// declaring low confidence tells the agent "nothing here" about a question that
// had an answer, and that is the failure that sends it to grep for good. So
// every rule here is written to be conservative in one direction: two structural
// exemptions guarantee that a single-symbol lookup and an explicitly typed
// identifier are NEVER declared low-confidence, whatever else is true.
//
// The response is a degraded answer, not an empty one: the weak matches are
// still returned, labelled, alongside the directories they cluster in — so even
// a wrong answer leaves the agent somewhere useful — and the guidance names a
// command with its arguments rather than saying "nothing found".

import { isTestPath } from "./search/rank.js";
import { splitIdentifier } from "./search/segments.js";
import { taskTerms } from "./scope-rank.js";
import type { GraphNode } from "./types.js";

/**
 * Fewest content words a task must have before it can be judged weak at all.
 *
 * Two, and it is a structural exemption rather than a tuning knob. A one-word
 * task IS a symbol lookup — "membership", "runMigrations" — and its single best
 * match is the answer by definition, not a coincidence to be hedged. There is
 * nothing to corroborate a single word against, so no evidence could ever make
 * the predicate fire honestly, and firing it anyway would put the false positive
 * exactly where it costs most. This is the first of the two guarantees behind
 * the zero-false-positive requirement.
 */
const MIN_CONTENT_TERMS = 2;

/**
 * Shortest word that counts as content when deciding whether a task is weak.
 *
 * Three characters. The task's own words already pass through the shared query
 * planner's stopword filter, so this catches what is left: fragments like `id`,
 * `db` or `ui` which are real terms for retrieval and carry no topic, and would
 * let a two-word task reach the threshold on one real word plus a stub.
 *
 * Sensitivity: this constant can only make the predicate fire LESS often as it
 * rises (fewer tasks reach two content words) and more often as it falls. At 2
 * it admits tasks whose second word is a two-letter fragment; at 6 it stops
 * firing on ordinary three-word tasks. Both directions were measured — see the
 * handoff — and 3 is where a word first has to be a word.
 */
const MIN_CONTENT_TERM_LENGTH = 3;

/**
 * Distinct task words a candidate must account for to be a strong answer.
 *
 * Two, and it is what "corroborated" means throughout this codebase: one word
 * in common is a coincidence, two is a subject. It is the same judgement the
 * scope ranker makes continuously with weighted coverage, taken here as a count
 * because the output is a yes/no about the whole result set rather than an
 * ordering within it — and because a weighted threshold would be the tuned
 * constant this predicate is designed not to have.
 */
const STRONG_TERM_MATCHES = 2;

/** Most directories worth naming in a low-confidence response. */
const MAX_LIKELY_DIRECTORIES = 4;

/**
 * How deep to look before declaring that the index has no answer.
 *
 * The claim "nothing here" is about the index, not about the ten rows a caller
 * happened to ask for, so it is confirmed against a deeper look first. Measured
 * over 25 tasks on a 22,506-node index, the false-positive rate — answerable
 * tasks wrongly declared low-confidence — is 1/16 with no confirmation and
 * 0/16 at every depth from 20 to 200, while the true-positive rate is 6/9 at
 * every one of those depths including 0. The check is therefore decisive well
 * below this value and completely insensitive above it: the nine tasks with no
 * answer have no answer at any depth, which is the result that says the
 * predicate is reading the index rather than the size of the slice.
 *
 * 50 is 2.5x the depth at which the measurement stops moving. It is not free —
 * it is one extra index search — but it runs only on a response that is already
 * about to be declared weak, so a task with a good answer never pays it.
 */
export const CONFIDENCE_CONFIRM_DEPTH = 50;

/**
 * Shortest shared prefix that lets a task word and a declaration's word count as
 * the same word.
 *
 * The search index stems both sides of every comparison with porter, so it
 * considers `standards` and `Standard`, `sending` and `sendEmail`, `results` and
 * `Result` to be matches — and they are. A plain containment test does not, and
 * measured over the tasks that DO have answers, that single disagreement was the
 * whole of this predicate's false-positive rate: four sixteenths of the gate,
 * every one of them an English inflection the index had already seen through.
 * This codebase has been caught by the same gap before, deciding a local
 * `name.includes(term)` test agreed with the index when it disagreed 16% of the
 * time.
 *
 * A prefix test rather than a stemmer, for two reasons. It needs no dependency
 * and no word list, so it cannot become a table of English that drifts from the
 * tokenizer's. And it errs the safe way: it can only find MORE matches than
 * containment, which can only make a result look stronger, which can only make
 * this predicate quieter. Every error it makes is an error toward answering
 * rather than toward wrongly saying "nothing here" — the one direction the gate
 * cares about.
 *
 * Four characters. Sensitivity: below it, short unrelated words start sharing
 * prefixes (`get`/`getting` is fine, `api`/`apiary` is not) and the predicate
 * grows quieter still; above it, genuine short stems (`user`/`users`,
 * `role`/`roles`) stop matching and it grows louder — toward false positives.
 * Both directions measured; see the handoff.
 */
const MIN_STEM_PREFIX = 4;

/** Why a response was not confident. Absent when it was. */
export type LowConfidenceReason = "no-match" | "no-strong-match";

/**
 * The single definition of "this answer is weak", produced once per response and
 * passed to everything that has to agree with it.
 *
 * It is an object rather than a string on the wire precisely so that the
 * emitter and the parts of the response that must stop contradicting it cannot
 * drift apart: there is nothing to compare in two places and nothing to
 * remember to clear, because the assessment is derived at emit time from the
 * results actually being emitted and does not outlive them.
 */
export interface ConfidenceAssessment {
  level: "high" | "low";
  reason?: LowConfidenceReason;
  /** Directories the weak matches cluster in — somewhere to look next. */
  likelyDirectories: string[];
}

/** A confident assessment. The common case, and the default. */
const CONFIDENT: ConfidenceAssessment = { level: "high", likelyDirectories: [] };

/**
 * Whether the results for `task` are worth presenting as an answer.
 *
 * `results` are the candidates about to be returned, in rank order. The test is
 * over the whole set: one strong match makes the response confident, because a
 * good answer surrounded by weak ones is still a good answer.
 */
export function assessConfidence(
  task: string,
  results: readonly GraphNode[],
  deeper: () => readonly GraphNode[] = () => [],
): ConfidenceAssessment {
  const terms = contentTerms(task);
  // Exemption 1: a single-symbol or single-keyword query. Its best match IS the
  // answer; there is no second word for it to have failed to cover.
  if (terms.length < MIN_CONTENT_TERMS) return CONFIDENT;
  // Exemption 2: the user typed something identifier-shaped and a result is
  // named exactly that. The rest of the sentence is context around a symbol the
  // user already knows the name of, not evidence against the symbol.
  const typedIdentifiers = new Set(
    taskTerms(task).filter((entry) => entry.identifierLike).map((entry) => entry.term),
  );
  const strong = (nodes: readonly GraphNode[]): boolean =>
    nodes.some((node) =>
      typedIdentifiers.has(node.name.toLowerCase()) || matchedTerms(node, terms) >= STRONG_TERM_MATCHES);

  if (results.length > 0 && strong(results)) return CONFIDENT;
  // Nothing in the returned slice is worth acting on — but the claim about to be
  // made is about the INDEX, not about ten rows of it, so it is confirmed
  // against a deeper look before it is made. This is the whole cost of the
  // check and it lands only here, on the answers that are already weak: a task
  // with a good result never reaches this line. It is also the only arm that can
  // turn a "nothing here" back into an answer, which is the direction that
  // matters — a task whose answer merely ranked badly gets today's mediocre
  // response, not a wrong denial.
  const beyond = deeper();
  if (beyond.length > 0 && strong(beyond)) return CONFIDENT;
  if (results.length === 0) return { level: "low", reason: "no-match", likelyDirectories: [] };
  return {
    level: "low",
    reason: "no-strong-match",
    likelyDirectories: likelyDirectories(results),
  };
}

/** The task's content words: the shared planner's terms, minus fragments. */
function contentTerms(task: string): string[] {
  const seen = new Set<string>();
  for (const entry of taskTerms(task)) {
    if (entry.term.length >= MIN_CONTENT_TERM_LENGTH) seen.add(entry.term);
  }
  return [...seen];
}

/**
 * How many distinct task words this candidate accounts for, across its name and
 * the directories it is declared in.
 *
 * The directory half is the addition. mex's ranking reads a node's name and
 * qualified name and discards its path, so a declaration sitting in `src/auth/`
 * counts for nothing on a question about authentication even though its
 * location is exactly the corroboration a human would use. It is free — the
 * path is already on the node — and it is evidence of the same kind as a name
 * segment, so it is measured the same way: split into identifier segments and
 * matched by containment, the rule the scope ranker already uses for names.
 *
 * The file's own basename is deliberately included (it is the last path
 * segment); a file named `authService.ts` is corroboration by the same argument.
 */
function matchedTerms(node: GraphNode, terms: readonly string[]): number {
  const haystack = `${node.name} ${node.qualifiedName}`.toLowerCase();
  const words = [
    ...splitIdentifier(node.name),
    ...splitIdentifier(node.qualifiedName),
    ...pathSegments(node.filePath),
  ];
  let matched = 0;
  for (const term of terms) {
    if (haystack.includes(term) || words.some((word) => sameWord(word, term))) matched += 1;
  }
  return matched;
}

/**
 * Whether two words are the same word, allowing for the inflection the search
 * index already stems away. Containment covers a word sitting inside a longer
 * one; the prefix arm covers the endings.
 */
function sameWord(word: string, term: string): boolean {
  if (word.includes(term)) return true;
  const shorter = word.length <= term.length ? word : term;
  const longer = shorter === word ? term : word;
  return shorter.length >= MIN_STEM_PREFIX && longer.startsWith(shorter);
}

/** A file path's directory and file-name words, lowercased and split. */
function pathSegments(filePath: string): string[] {
  const out: string[] = [];
  for (const part of filePath.split("/")) {
    if (part === "") continue;
    const bare = part.includes(".") ? part.slice(0, part.lastIndexOf(".")) : part;
    out.push(bare.toLowerCase(), ...splitIdentifier(bare));
  }
  return out;
}

/**
 * The directories the weak matches cluster in, most-populated first.
 *
 * The point of naming them is that a weak answer should still leave the agent
 * somewhere to look. Test directories are dropped: sending an agent that got no
 * real answer into a test tree is the least useful place to send it, and the
 * same demotion applies everywhere else in this codebase.
 */
function likelyDirectories(results: readonly GraphNode[]): string[] {
  const counts = new Map<string, number>();
  for (const node of results) {
    if (isTestPath(node.filePath)) continue;
    const slash = node.filePath.lastIndexOf("/");
    if (slash <= 0) continue;
    const dir = node.filePath.slice(0, slash);
    counts.set(dir, (counts.get(dir) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, MAX_LIKELY_DIRECTORIES)
    .map(([dir]) => dir);
}
