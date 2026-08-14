// ============================================================================
// mex code-graph — partial answers for a target with no resolved callers
// ============================================================================
//
// `who-calls X` reads one edge kind: `calls`. When resolution never bound a
// reference to `X`, no such edge exists and the command returns nothing —
// measured on a 22,506-node index, that is 4,552 of 7,380 function/method/class
// declarations, 61.7% of them. "Nothing" is the wrong answer for most of those,
// because the store is still holding two other kinds of evidence about the
// same node and no command will show either:
//
//   1. **References that named it and did not bind.** Extraction parks every
//      cross-file reference in `unresolved_refs`; the resolution pass reads them
//      all and emits an edge for each one it can place. A row whose reference
//      never produced an edge is a real reference site, at a real line, that the
//      graph knows about and cannot attribute. There are 72,152 of them.
//   2. **Resolved edges of a different kind.** A class that is only ever `new`ed
//      has `instantiates` edges and no `calls` edge, so `who-calls` calls it
//      uncalled while the graph holds the exact answer one edge kind away.
//
// Both are returned here, and NEITHER may be presentable as a resolved `calls`
// edge. Every row carries a `resolution` label saying how it was obtained, and
// the two failure modes stay apart:
//
//   `unresolved`   nothing eligible bore the name — no candidate existed
//   `ambiguous`    several eligible declarations did, and the pass declined
//   `related-edge` a real, resolved edge, of a kind other than `calls`
//
// **The labels are derived at query time, never stored.** A row is dropped the
// moment an edge exists for it, and the `unresolved`/`ambiguous` split replays
// the resolver's own `TARGET_KINDS` table rather than restating it. So neither
// label can outlive the condition it describes: re-index, and evidence that
// became an edge stops being reported as evidence, with nothing to remember to
// clear. That failure — an honesty annotation that survives its own condition —
// is the one that teaches an agent to distrust a signal that is usually right.
//
// **The evidence is ranked, not dumped.** A reference from the target's own
// file, or from a file that imports the target's file, is far likelier to mean
// THIS declaration than a same-named one elsewhere; measured on the same index,
// corroboration of either kind holds for 5.3% of raw name matches, so ordering
// by it is the difference between a useful sample and a list of coincidences.
// The ordering is applied over the whole population in SQL and only then
// bounded, so the bound never decides the rank — the mistake of ranking a
// window instead of a population is one this codebase has already made once.

import { isTestPath } from "./search/rank.js";
import { TARGET_KINDS } from "./resolution/resolver.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import type { GraphNode, NodeKind } from "./types.js";

/** How a piece of evidence was obtained. Never "a resolved `calls` edge". */
export type EvidenceResolution = "unresolved" | "ambiguous" | "related-edge";

/** One reference site, labelled with how it was obtained. */
export interface EvidenceRow {
  /** How this row was obtained — the guarantee that it is not a `calls` edge. */
  resolution: EvidenceResolution;
  /** The reference kind as extraction recorded it (`calls`, `instantiates`, …). */
  referenceKind: string;
  /** The declaration the reference was made from. */
  fromId: string;
  fromName: string;
  fromKind: string;
  filePath: string;
  line: number;
  /**
   * Declarations the resolver was allowed to choose between. 0 for `unresolved`
   * (nothing eligible bore the name), >= 2 for `ambiguous`. Absent on a
   * `related-edge` row, which is not a resolution failure at all.
   */
  candidateCount?: number;
}

/**
 * How strongly the reference site corroborates THIS declaration rather than a
 * same-named one elsewhere: declared in the same file (2), declared in a file
 * that imports the target's file (1), or neither (0).
 *
 * Internal to ranking and not emitted — it is a reason to believe a row, not a
 * fact about the code, and putting a number an agent cannot check on the wire
 * invites it to be read as a probability.
 */
type Corroboration = 0 | 1 | 2;

/**
 * A bounded body of evidence: a ranked sample, the true total, and whether the
 * sample is all of it.
 *
 * All three, not a choice between them. A sample alone lets an agent conclude
 * "three callers" from three rows out of ninety; a count alone gives it nothing
 * to read. `truncated` is the field that makes the other two safe to combine.
 */
export interface EvidenceGroup {
  rows: EvidenceRow[];
  count: number;
  truncated: boolean;
}

/** Everything the store knows about a target beyond its resolved `calls` edges. */
export interface TargetEvidence {
  unresolved: EvidenceGroup;
  ambiguous: EvidenceGroup;
  related: EvidenceGroup;
}

/**
 * How many rows to draw into the ranked slice per group, as a multiple of what
 * the caller can actually emit.
 *
 * The corroboration ordering is total and applied in SQL over every matching
 * row, so this multiple cannot change which rows rank highest — it only leaves
 * the in-memory pass (the test-file demotion, which is a property of the node
 * and not expressible without restating `isTestPath` in SQL) something to
 * reorder within a tier. A multiple rather than a constant so the slice tracks
 * the request; the floor keeps a one-node request from ranking a field of one.
 */
const SLICE_MULTIPLE = 4;
const SLICE_FLOOR = 40;

/**
 * Eligible candidates from which a reference counts as *ambiguous* rather than
 * merely unbound.
 *
 * Two, and it is a definition rather than a tuning knob — it is what the word
 * means. Below it the two labels say what they say and nothing is inferred
 * about why the resolver behaved as it did:
 *
 *   `ambiguous`   several declarations bore the name; picking one would be a
 *                 guess, and which one matters
 *   `unresolved`  it did not bind, and there was no field of candidates to
 *                 choose from — `candidateCount` on the row carries the actual
 *                 number, so 0 and 1 stay distinguishable to a consumer
 *
 * An earlier version tried to be cleverer and reconstruct the resolver's own
 * choice, dropping any row whose candidate count implied a binding must have
 * happened. It cost eleven of the 2,141 dead-end declarations their only
 * evidence: the resolver has paths this cannot see from a row (framework
 * resolvers, its per-(source,target,kind) dedup, its same-file and
 * import-preference rules), so the reconstruction was sometimes wrong and
 * always unfalsifiable from here. What survives is the one thing that is
 * directly observable — an edge exists, or it does not, which the query already
 * asks — and a count reported rather than interpreted.
 */
const AMBIGUOUS_FROM = 2;

/** Reference kinds that name a SYMBOL, and so can be evidence about a declaration. */
const SYMBOL_REFERENCE_KINDS = ["calls", "instantiates", "extends", "implements", "function_ref", "references"];

/**
 * Edge kinds that are evidence about a target but are not what `who-calls`
 * reads. `contains` is excluded because it is the file that declares the node,
 * which every node has and which answers nothing.
 */
const RELATED_EDGE_EXCLUSIONS = ["calls", "contains"];

interface RefRow {
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  file_path: string;
  from_name: string | null;
  from_kind: string | null;
  corroboration: number;
}

/**
 * Everything the store holds about `target` other than its resolved `calls`
 * edges, ranked and bounded to `limit` rows per group.
 *
 * `limit` bounds each group independently: an agent asking "who calls this"
 * should not lose the one ambiguous reference site because ninety unresolved
 * ones came first, and the emitter applies the real node budget on top anyway.
 */
export function evidenceForTarget(
  db: SqliteDatabase,
  target: GraphNode,
  limit: number,
): TargetEvidence {
  const slice = Math.max(SLICE_FLOOR, limit * SLICE_MULTIPLE);
  const rows = fetchReferenceRows(db, target, slice);
  const bearers = eligibleBearers(db, target.name);

  const unresolved: Ranked[] = [];
  const ambiguous: Ranked[] = [];
  for (const row of rows) {
    const eligible = eligibleFor(bearers, row.reference_kind, { name: row.from_name, kind: row.from_kind }, row.reference_name);
    const built: EvidenceRow = {
      resolution: eligible >= AMBIGUOUS_FROM ? "ambiguous" : "unresolved",
      referenceKind: row.reference_kind,
      fromId: row.from_node_id,
      fromName: row.from_name ?? row.from_node_id,
      fromKind: row.from_kind ?? "unknown",
      filePath: row.file_path,
      line: row.line,
      candidateCount: eligible,
    };
    (eligible >= AMBIGUOUS_FROM ? ambiguous : unresolved).push({ row: built, corroboration: row.corroboration as Corroboration });
  }

  return {
    unresolved: bound(unresolved, countReferences(db, target, "unresolved", bearers), limit),
    ambiguous: bound(ambiguous, countReferences(db, target, "ambiguous", bearers), limit),
    related: relatedEdges(db, target, limit),
  };
}

/** True when any group holds a row — i.e. there is a partial answer to give. */
export function hasEvidence(evidence: TargetEvidence): boolean {
  return evidence.unresolved.count > 0 || evidence.ambiguous.count > 0 || evidence.related.count > 0;
}

/**
 * Reference rows naming `target`, ordered by corroboration across the WHOLE
 * matching population before any bound is applied.
 *
 * A row is excluded when an edge already carries it (`NOT EXISTS`), which is
 * what keeps the two answers — the resolved graph and this evidence — from ever
 * describing the same reference twice.
 */
function fetchReferenceRows(db: SqliteDatabase, target: GraphNode, slice: number): RefRow[] {
  const kinds = SYMBOL_REFERENCE_KINDS.map(() => "?").join(",");
  return db
    .prepare(
      `SELECT u.from_node_id, u.reference_name, u.reference_kind, u.line, u.file_path,
              n.name AS from_name, n.kind AS from_kind,
              CASE WHEN u.file_path = ? THEN 2
                   WHEN EXISTS (SELECT 1 FROM edges e
                                WHERE e.kind = 'imports' AND e.source = 'file:' || u.file_path
                                  AND e.target = ?) THEN 1
                   ELSE 0 END AS corroboration
         FROM unresolved_refs u
         LEFT JOIN nodes n ON n.id = u.from_node_id
        WHERE (u.reference_name = ? OR u.reference_name LIKE ?)
          AND u.reference_kind IN (${kinds})
          AND NOT EXISTS (SELECT 1 FROM edges e
                          WHERE e.source = u.from_node_id AND e.target = ?
                            AND e.kind = u.reference_kind)
        ORDER BY corroboration DESC, u.file_path, u.line
        LIMIT ?`,
    )
    .all(
      target.filePath,
      `file:${target.filePath}`,
      target.name,
      `%.${target.name}`,
      ...SYMBOL_REFERENCE_KINDS,
      target.id,
      slice,
    ) as RefRow[];
}

/**
 * The true total per label, counted over the whole population rather than the
 * ranked slice — so `count` stays honest however small the sample is.
 *
 * Counted through the same eligibility test the labeller uses, which is cheap
 * because eligibility depends only on (reference kind, referring node, name),
 * so the count is a group-by rather than a per-row decision. Sharing the test
 * is what makes `count` and `rows` describe the same population — a total
 * computed by a second rule would be a number nobody could reconcile with the
 * sample beside it.
 */
function countReferences(
  db: SqliteDatabase,
  target: GraphNode,
  label: "unresolved" | "ambiguous",
  bearers: Map<string, number>,
): number {
  const kinds = SYMBOL_REFERENCE_KINDS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT u.reference_kind AS kind, u.from_node_id AS from_id, u.reference_name AS ref_name,
              n.name AS from_name, n.kind AS from_kind, COUNT(*) AS n
         FROM unresolved_refs u
         LEFT JOIN nodes n ON n.id = u.from_node_id
        WHERE (u.reference_name = ? OR u.reference_name LIKE ?)
          AND u.reference_kind IN (${kinds})
          AND NOT EXISTS (SELECT 1 FROM edges e
                          WHERE e.source = u.from_node_id AND e.target = ?
                            AND e.kind = u.reference_kind)
        GROUP BY u.reference_kind, u.from_node_id, u.reference_name`,
    )
    .all(target.name, `%.${target.name}`, ...SYMBOL_REFERENCE_KINDS, target.id) as Array<{ kind: string; from_id: string; ref_name: string; from_name: string | null; from_kind: string | null; n: number }>;

  let total = 0;
  for (const row of rows) {
    const eligible = eligibleFor(bearers, row.kind, { name: row.from_name, kind: row.from_kind }, row.ref_name);
    if ((eligible >= AMBIGUOUS_FROM ? "ambiguous" : "unresolved") === label) total += row.n;
  }
  return total;
}

/** Resolved inbound edges of a kind `who-calls` does not read. */
function relatedEdges(db: SqliteDatabase, target: GraphNode, limit: number): EvidenceGroup {
  const excluded = RELATED_EDGE_EXCLUSIONS.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.kind, e.source, e.line, n.name AS from_name, n.kind AS from_kind, n.file_path
         FROM edges e LEFT JOIN nodes n ON n.id = e.source
        WHERE e.target = ? AND e.kind NOT IN (${excluded})
        ORDER BY n.file_path, e.line, e.source`,
    )
    .all(target.id, ...RELATED_EDGE_EXCLUSIONS) as Array<{
      kind: string; source: string; line: number | null;
      from_name: string | null; from_kind: string | null; file_path: string | null;
    }>;
  const built: Ranked[] = rows.map((row) => ({
    row: {
      resolution: "related-edge",
      referenceKind: row.kind,
      fromId: row.source,
      fromName: row.from_name ?? row.source,
      fromKind: row.from_kind ?? "unknown",
      filePath: row.file_path ?? "",
      line: row.line ?? 0,
    },
    // A resolved edge is evidence about this node by construction — there is no
    // same-named declaration it could have meant instead — so every row sits in
    // the same tier and only the test-file demotion separates them.
    corroboration: 2,
  }));
  return bound(built, built.length, limit);
}

/**
 * Declarations bearing `name`, counted per kind — the field the resolver had to
 * choose from. `file:` nodes are excluded: a symbol reference never binds to a
 * file node, and counting them would inflate ambiguity that does not exist.
 */
function eligibleBearers(db: SqliteDatabase, name: string): Map<string, number> {
  const rows = db
    .prepare("SELECT kind, COUNT(*) AS n FROM nodes WHERE name = ? AND kind != 'file' GROUP BY kind")
    .all(name) as Array<{ kind: string; n: number }>;
  return new Map(rows.map((row) => [row.kind, row.n]));
}

/**
 * How many declarations the resolver could have bound this reference to.
 *
 * `TARGET_KINDS` is imported from the resolver rather than restated, so the
 * label tracks what the resolver actually does rather than what it did when
 * this was written.
 *
 * The referring declaration is subtracted, because the resolver excludes it
 * (`n.id !== ref.fromNodeId`) — a function's call to itself is not a candidate
 * for binding. Without that subtraction a recursive call on a name nothing else
 * bears looks like the one case the resolver always binds, and gets dropped as
 * already-an-edge when in fact no edge exists: measured on the reference index,
 * that was the entire difference between reporting evidence for 2,139 of the
 * 2,141 dead-end declarations and all of them. Both misses were a logger method
 * delegating to a same-named method on the logger it wraps.
 */
function eligibleFor(
  bearers: Map<string, number>,
  referenceKind: string,
  from: { name: string | null; kind: string | null },
  referenceName: string,
): number {
  const allowed = TARGET_KINDS[referenceKind] ?? [];
  const permits = (kind: string): boolean => allowed.length === 0 || allowed.includes(kind as NodeKind);
  let total = 0;
  for (const [kind, n] of bearers) {
    if (permits(kind)) total += n;
  }
  const referrerIsBearer =
    from.name !== null && from.kind !== null && from.name === simpleName(referenceName) && permits(from.kind);
  return referrerIsBearer ? Math.max(0, total - 1) : total;
}

/** The part of a reference name the resolver binds on: `obj.method` -> `method`. */
function simpleName(referenceName: string): string {
  const dot = referenceName.lastIndexOf(".");
  return dot < 0 ? referenceName : referenceName.slice(dot + 1);
}

/** A row with the ranking signal that decided its position, kept off the wire. */
interface Ranked {
  row: EvidenceRow;
  corroboration: Corroboration;
}

/**
 * Rank within corroboration tier, then bound.
 *
 * The test-file demotion is applied here rather than in SQL because
 * `isTestPath` is the codebase's one definition of what a test file is, and
 * restating it as a LIKE would make two. It applies INSIDE the tier the SQL
 * ordering already established — the same shape as the search ranker's, where a
 * penalty reorders equals and can never move a row past a stronger class of
 * evidence. The SQL order supplies the tie-break below the penalty, so the
 * whole ordering is total and the same query returns the same rows.
 */
function bound(ranked: Ranked[], count: number, limit: number): EvidenceGroup {
  const stable = ranked.map((entry, index) => ({ ...entry, index }));
  stable.sort((a, b) => {
    if (a.corroboration !== b.corroboration) return b.corroboration - a.corroboration;
    const test = Number(isTestPath(a.row.filePath)) - Number(isTestPath(b.row.filePath));
    return test !== 0 ? test : a.index - b.index;
  });
  const kept = stable.slice(0, limit).map((entry) => entry.row);
  return { rows: kept, count, truncated: kept.length < count };
}
