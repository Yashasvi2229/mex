// ============================================================================
// mex code-graph — persistence + read queries  (A3)
// ============================================================================
//
// All SQL over the graph DB: node/edge/file/unresolved-ref writes, the reader
// queries the `GraphEngine` surface needs (getNode, search, incoming/outgoing
// edges), and the bulk reads resolution uses. Rows are snake_case in SQLite and
// decoded to the camelCase `GraphNode`/`GraphEdge` value types here.

import { planQuery, toMatchExpression, type QueryPlan } from "../search/query.js";
import {
  exactLookupTerms,
  normalizeQueryPath,
  rankCandidates,
  unmatchedTerms,
  type SearchCandidate,
} from "../search/rank.js";
import { segmentsFor } from "../search/segments.js";
import type { EdgeKind, GraphEdge, GraphNode, Language, NodeKind, ReferenceKind } from "../types.js";
import type { SqliteDatabase } from "./sqlite.js";

/** An unresolved reference row: a name a node points at, bound after indexing. */
export interface UnresolvedRefRecord {
  fromNodeId: string;
  referenceName: string;
  referenceKind: ReferenceKind;
  filePath: string;
  language: Language;
  line?: number;
  column?: number;
  candidates?: string[];
}

/** A tracked-file row (drives incremental change detection for `sync`). */
export interface FileRecord {
  path: string;
  contentHash: string;
  language: Language;
  size: number;
  modifiedAt: number;
  indexedAt: number;
  nodeCount: number;
}

/** Reference edge kinds — everything except the intra-file `contains` edge.
 *  `sync` wipes these and rebuilds them from `unresolved_refs`. */
export const REFERENCE_EDGE_KINDS: EdgeKind[] = [
  "calls",
  "imports",
  "exports",
  "extends",
  "implements",
  "references",
  "type_of",
  "returns",
  "instantiates",
  "overrides",
  "decorates",
];

interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  is_abstract: number;
  decorators: string | null;
  type_parameters: string | null;
  return_type: string | null;
  body_hash: string | null;
  updated_at: number;
}

interface EdgeRow {
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  provenance: string | null;
}

function parseJson<T>(raw: string | null): T | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

function rowToNode(row: NodeRow): GraphNode {
  return {
    id: row.id,
    kind: row.kind as NodeKind,
    name: row.name,
    qualifiedName: row.qualified_name,
    filePath: row.file_path,
    language: row.language as Language,
    startLine: row.start_line,
    endLine: row.end_line,
    startColumn: row.start_column,
    endColumn: row.end_column,
    docstring: row.docstring ?? undefined,
    signature: row.signature ?? undefined,
    visibility: (row.visibility as GraphNode["visibility"]) ?? undefined,
    isExported: row.is_exported === 1,
    isAsync: row.is_async === 1,
    isStatic: row.is_static === 1,
    isAbstract: row.is_abstract === 1,
    decorators: parseJson<string[]>(row.decorators),
    typeParameters: parseJson<string[]>(row.type_parameters),
    returnType: row.return_type ?? undefined,
    bodyHash: row.body_hash ?? undefined,
    updatedAt: row.updated_at,
  };
}

/**
 * How far past the caller's `limit` the candidate pool is fetched before it is
 * ranked. Ranking can only reorder rows the fetch returned, so the pool has to
 * be wider than the page; the floor matters as much as the multiplier, since a
 * `limit: 1` lookup would otherwise rank a pool of five.
 */
const FETCH_MULTIPLIER = 5;
const MIN_FETCH = 100;

/**
 * Cap on the rows one term may contribute to the exact-name tier. A name is
 * rarely ambiguous; the cap only bounds the degenerate case (`constructor`),
 * where the bm25 tier has already supplied the ranked candidates anyway.
 */
const EXACT_NAME_LIMIT = 20;

/** Shortest term the substring tier will scan for — below this it matches everything. */
const MIN_SUBSTRING_TERM = 2;

/**
 * bm25 column weights, in `nodes_fts` column order:
 * `(id, name, qualified_name, docstring, signature, segments)`.
 *
 * `id` is weighted 0 — it is a content hash and matching one is not evidence of
 * anything. The rest bias toward a name match over an incidental docstring
 * mention, and they are unchanged from the weights this ranking was measured on.
 *
 * `segments` (schema v2) is the one new weight. It sits BELOW `name` and
 * `qualified_name` and ABOVE `signature` and `docstring`: matching `money`
 * inside `formatMoney` is real evidence, and weaker evidence than matching
 * `formatMoney` itself. That ordering is what stops segment reachability from
 * costing exact-name lookups — a query naming a symbol still wins on the `name`
 * column, at nearly seven times the weight.
 *
 * Sensitivity, swept on a 22,506-node index at 2 / 3 / 5 / 8 (see the handoff):
 * the ordering constraint is what matters, not the value. Raising it past
 * `qualified_name` is the change that would hurt, because it would let a node
 * that merely contains the word outrank one whose qualified name is about it.
 */
const BM25_WEIGHTS = "0, 20, 5, 1, 2, 3";

interface Filters {
  clause: string;
  params: Array<string | number>;
}

function rowToEdge(row: EdgeRow): GraphEdge {
  return {
    source: row.source,
    target: row.target,
    kind: row.kind as EdgeKind,
    metadata: parseJson<Record<string, unknown>>(row.metadata),
    line: row.line ?? undefined,
    column: row.col ?? undefined,
    provenance: (row.provenance as GraphEdge["provenance"]) ?? undefined,
  };
}

export class GraphStore {
  constructor(private readonly db: SqliteDatabase) {}

  /** Run `fn` inside a single transaction (bulk-write speed + atomicity). */
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn);
  }

  // --- Writes ---------------------------------------------------------------

  insertNode(node: GraphNode): void {
    this.db
      .prepare(
        `INSERT INTO nodes (
           id, kind, name, qualified_name, file_path, language,
           start_line, end_line, start_column, end_column,
           docstring, signature, visibility,
           is_exported, is_async, is_static, is_abstract,
           decorators, type_parameters, return_type, body_hash, updated_at, segments
         ) VALUES (?,?,?,?,?,?, ?,?,?,?, ?,?,?, ?,?,?,?, ?,?,?,?,?, ?)
         ON CONFLICT(id) DO UPDATE SET
           kind = excluded.kind,
           name = excluded.name,
           qualified_name = excluded.qualified_name,
           file_path = excluded.file_path,
           language = excluded.language,
           start_line = excluded.start_line,
           end_line = excluded.end_line,
           start_column = excluded.start_column,
           end_column = excluded.end_column,
           docstring = excluded.docstring,
           signature = excluded.signature,
           visibility = excluded.visibility,
           is_exported = excluded.is_exported,
           is_async = excluded.is_async,
           is_static = excluded.is_static,
           is_abstract = excluded.is_abstract,
           decorators = excluded.decorators,
           type_parameters = excluded.type_parameters,
           return_type = excluded.return_type,
           body_hash = excluded.body_hash,
           updated_at = excluded.updated_at,
           segments = excluded.segments`,
      )
      .run(
        node.id,
        node.kind,
        node.name,
        node.qualifiedName ?? node.name,
        node.filePath,
        node.language,
        node.startLine,
        node.endLine,
        node.startColumn,
        node.endColumn,
        node.docstring ?? null,
        node.signature ?? null,
        node.visibility ?? null,
        node.isExported ? 1 : 0,
        node.isAsync ? 1 : 0,
        node.isStatic ? 1 : 0,
        node.isAbstract ? 1 : 0,
        node.decorators ? JSON.stringify(node.decorators) : null,
        node.typeParameters ? JSON.stringify(node.typeParameters) : null,
        node.returnType ?? null,
        node.bodyHash ?? null,
        node.updatedAt,
        // Derived, never authored: the caller cannot supply it and nothing reads
        // it back into a `GraphNode`. Written here so the one write path and the
        // FTS 'rebuild' path index the same bytes.
        segmentsFor(node.name),
      );
  }

  /** Rebuild the external-content FTS index from the final nodes table. */
  rebuildSearchIndex(): void {
    this.db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  }

  /** Insert an edge, skipping it unless both endpoints exist (FK safety). */
  insertEdge(edge: GraphEdge): void {
    this.db
      .prepare(
        `INSERT INTO edges (source, target, kind, metadata, line, col, provenance)
         SELECT ?,?,?,?,?,?,?
         WHERE EXISTS (SELECT 1 FROM nodes WHERE id = ?)
           AND EXISTS (SELECT 1 FROM nodes WHERE id = ?)`,
      )
      .run(
        edge.source,
        edge.target,
        edge.kind,
        edge.metadata ? JSON.stringify(edge.metadata) : null,
        edge.line ?? null,
        edge.column ?? null,
        edge.provenance ?? null,
        edge.source,
        edge.target,
      );
  }

  upsertFile(file: FileRecord): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO files (
           path, content_hash, language, size, modified_at, indexed_at, node_count
         ) VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        file.path,
        file.contentHash,
        file.language,
        file.size,
        file.modifiedAt,
        file.indexedAt,
        file.nodeCount,
      );
  }

  insertUnresolvedRef(ref: UnresolvedRefRecord): void {
    this.db
      .prepare(
        `INSERT INTO unresolved_refs (
           from_node_id, reference_name, reference_kind, line, col, candidates, file_path, language
         ) VALUES (?,?,?,?,?,?,?,?)`,
      )
      .run(
        ref.fromNodeId,
        ref.referenceName,
        ref.referenceKind,
        ref.line ?? 0,
        ref.column ?? 0,
        ref.candidates ? JSON.stringify(ref.candidates) : null,
        ref.filePath,
        ref.language,
      );
  }

  /** Delete all nodes for a file (ON DELETE CASCADE clears their edges +
   *  unresolved refs). Used by `sync` before re-indexing a changed file. */
  deleteNodesByFile(filePath: string): void {
    this.db.prepare("DELETE FROM nodes WHERE file_path = ?").run(filePath);
  }

  /** Wipe every reference edge (keeping intra-file `contains`), so `sync` can
   *  rebuild them from `unresolved_refs` with no duplicates. */
  clearReferenceEdges(): void {
    this.db.prepare("DELETE FROM edges WHERE kind != 'contains'").run();
  }

  // --- Reads ----------------------------------------------------------------

  getNodeById(id: string): GraphNode | null {
    const row = this.db.prepare("SELECT * FROM nodes WHERE id = ?").get(id) as
      | NodeRow
      | undefined;
    return row ? rowToNode(row) : null;
  }

  getAllNodes(): GraphNode[] {
    return (this.db.prepare("SELECT * FROM nodes").all() as NodeRow[]).map(rowToNode);
  }

  getAllUnresolvedRefs(): UnresolvedRefRecord[] {
    const rows = this.db.prepare("SELECT * FROM unresolved_refs").all() as Array<{
      from_node_id: string;
      reference_name: string;
      reference_kind: string;
      line: number;
      col: number;
      candidates: string | null;
      file_path: string;
      language: string;
    }>;
    return rows.map((r) => ({
      fromNodeId: r.from_node_id,
      referenceName: r.reference_name,
      referenceKind: r.reference_kind as ReferenceKind,
      line: r.line,
      column: r.col,
      candidates: parseJson<string[]>(r.candidates),
      filePath: r.file_path,
      language: r.language as Language,
    }));
  }

  getFileRecord(path: string): FileRecord | null {
    const row = this.db.prepare("SELECT * FROM files WHERE path = ?").get(path) as
      | {
          path: string;
          content_hash: string;
          language: string;
          size: number;
          modified_at: number;
          indexed_at: number;
          node_count: number;
        }
      | undefined;
    if (!row) return null;
    return {
      path: row.path,
      contentHash: row.content_hash,
      language: row.language as Language,
      size: row.size,
      modifiedAt: row.modified_at,
      indexedAt: row.indexed_at,
      nodeCount: row.node_count,
    };
  }

  getIncomingEdges(targetId: string, kinds?: EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE target = ? AND kind IN (${placeholders}) ORDER BY source, target, kind`)
        .all(targetId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE target = ? ORDER BY source, target, kind")
        .all(targetId) as EdgeRow[]
    ).map(rowToEdge);
  }

  getOutgoingEdges(sourceId: string, kinds?: EdgeKind[]): GraphEdge[] {
    if (kinds && kinds.length > 0) {
      const placeholders = kinds.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM edges WHERE source = ? AND kind IN (${placeholders}) ORDER BY source, target, kind`)
        .all(sourceId, ...kinds) as EdgeRow[];
      return rows.map(rowToEdge);
    }
    return (
      this.db
        .prepare("SELECT * FROM edges WHERE source = ? ORDER BY source, target, kind")
        .all(sourceId) as EdgeRow[]
    ).map(rowToEdge);
  }

  /** Batch node lookup by id (one round-trip), keyed by id. */
  getNodesByIds(ids: readonly string[]): Map<string, GraphNode> {
    const out = new Map<string, GraphNode>();
    if (ids.length === 0) return out;
    const CHUNK = 500;
    for (let i = 0; i < ids.length; i += CHUNK) {
      const chunk = ids.slice(i, i + CHUNK);
      const placeholders = chunk.map(() => "?").join(",");
      const rows = this.db
        .prepare(`SELECT * FROM nodes WHERE id IN (${placeholders})`)
        .all(...chunk) as NodeRow[];
      for (const row of rows) out.set(row.id, rowToNode(row));
    }
    return out;
  }

  /**
   * Search nodes by free text. Backs `searchNodes` on the engine surface.
   *
   * Three tiers feed one candidate pool, which is then ranked (see
   * `../search/rank.ts`) and sliced to `limit`:
   *
   *   1. **bm25 over FTS5** — the primary tier, over-fetched so the ranking has
   *      something to reorder.
   *   2. **exact name** — every identifier-shaped term is looked up directly
   *      against `nodes.name`. bm25 can bury a short exact name under longer
   *      compounds that share its prefix, past any fetch window, where no
   *      amount of re-ranking reaches it. This tier makes symbol lookup
   *      independent of how deep the pool went.
   *   3. **substring** — for terms nothing in the pool contains, a LIKE scan
   *      catches fragments FTS's prefix match cannot (`serby` in `getUserById`).
   *      It used to run only when FTS returned *nothing at all*, so a query that
   *      returned one bad row never reached it.
   *
   * Ordering is total and stable (match class, score, name length, node id), so
   * the same index and query return byte-identical results on every run.
   */
  search(
    query: string,
    options: { kinds?: NodeKind[]; languages?: Language[]; limit?: number } = {},
  ): GraphNode[] {
    const { kinds, languages, limit = 100 } = options;
    const plan = planQuery(query);
    if (plan.terms.length === 0) return [];

    const filters = buildFilters(kinds, languages);
    const fetch = Math.max(limit * FETCH_MULTIPLIER, MIN_FETCH);

    // Pool keyed by node id; a node found by several tiers keeps its best score.
    const pool = new Map<string, { row: NodeRow; base: number }>();
    const admit = (row: NodeRow, base: number): void => {
      const existing = pool.get(row.id);
      if (existing) existing.base = Math.max(existing.base, base);
      else pool.set(row.id, { row, base });
    };

    for (const hit of this.ftsCandidates(plan, filters, fetch)) admit(hit.row, hit.base);
    for (const row of this.exactNameCandidates(plan, filters)) admit(row, 0);

    const candidates: SearchCandidate[] = [...pool.values()].map(toCandidate);
    const missing = unmatchedTerms(plan, candidates).filter((term) => term.length >= MIN_SUBSTRING_TERM);
    if (missing.length > 0) {
      for (const row of this.substringCandidates(missing, filters, fetch)) admit(row, 0);
    }

    const ranked = rankCandidates([...pool.values()].map(toCandidate), plan);
    return ranked.slice(0, limit).map((entry) => rowToNode(pool.get(entry.id)!.row));
  }

  /** Tier 1: weighted bm25 over the FTS index, over-fetched. */
  private ftsCandidates(
    plan: QueryPlan,
    filters: Filters,
    fetch: number,
  ): Array<{ row: NodeRow; base: number }> {
    // bm25 returns negative scores (more negative = better), so the pool carries
    // `-rank` and treats higher as better throughout. See `BM25_WEIGHTS`.
    try {
      const rows = this.db
        .prepare(
          // Aliased `bm25_rank`, not `rank`: `rank` is a hidden FTS5 column, and
          // ordering by the bare name would silently use its default weights.
          `SELECT nodes.*, nodes.rowid AS row_id, bm25(nodes_fts, ${BM25_WEIGHTS}) AS bm25_rank FROM nodes_fts
             JOIN nodes ON nodes_fts.id = nodes.id
             WHERE nodes_fts MATCH ?${filters.clause}
             ORDER BY bm25_rank, nodes.id LIMIT ?`,
        )
        .all(toMatchExpression(plan), ...filters.params, fetch) as Array<NodeRow & { bm25_rank: number }>;
      return rows.map((row) => ({ row, base: -row.bm25_rank }));
    } catch {
      // A MATCH expression the tokenizer rejects is a recoverable no-match: the
      // caller asked a question, and "nothing" is a legitimate answer to it.
      return [];
    }
  }

  /**
   * Tier 2: exact `name` matches for the terms allowed to claim one. Uses the
   * `lower(name)` expression index, so it stays a keyed lookup rather than a
   * scan even on a large index.
   */
  private exactNameCandidates(plan: QueryPlan, filters: Filters): NodeRow[] {
    const rows: NodeRow[] = [];
    const statement = this.db.prepare(
      `SELECT * FROM nodes WHERE lower(name) = ?${filters.clause} ORDER BY id LIMIT ?`,
    );
    const seen = new Set<string>();
    for (const term of exactLookupTerms(plan)) {
      if (seen.has(term)) continue;
      seen.add(term);
      rows.push(...(statement.all(term, ...filters.params, EXACT_NAME_LIMIT) as NodeRow[]));
    }
    // A query that names a file wants that file, and demoting `file:` nodes in
    // the ranking means bm25 alone can no longer be trusted to have kept it.
    const path = normalizeQueryPath(plan.raw);
    if (/[./\\]/.test(plan.raw)) {
      rows.push(
        ...(this.db
          .prepare(
            `SELECT * FROM nodes WHERE kind = 'file'
               AND (lower(name) = ? OR lower(qualified_name) = ?)${filters.clause}
               ORDER BY id LIMIT ?`,
          )
          .all(path, path, ...filters.params, EXACT_NAME_LIMIT) as NodeRow[]),
      );
    }
    return rows;
  }

  /** Tier 3: substring scan for terms the pool does not already contain. */
  private substringCandidates(terms: readonly string[], filters: Filters, fetch: number): NodeRow[] {
    const patterns = terms.map((term) => `%${term}%`);
    const clause = terms.map(() => "(name LIKE ? OR qualified_name LIKE ?)").join(" OR ");
    const params = patterns.flatMap((pattern) => [pattern, pattern]);
    return this.db
      .prepare(
        `SELECT * FROM nodes WHERE (${clause})${filters.clause}
           ORDER BY length(name), name, id LIMIT ?`,
      )
      .all(...params, ...filters.params, fetch) as NodeRow[];
  }
}

/** Assemble the optional kind/language filter, and only the params it names. */
function buildFilters(kinds: NodeKind[] | undefined, languages: Language[] | undefined): Filters {
  const sql: string[] = [];
  const params: Array<string | number> = [];
  if (kinds && kinds.length > 0) {
    sql.push(`nodes.kind IN (${kinds.map(() => "?").join(",")})`);
    params.push(...kinds);
  }
  if (languages && languages.length > 0) {
    sql.push(`nodes.language IN (${languages.map(() => "?").join(",")})`);
    params.push(...languages);
  }
  return { clause: sql.length > 0 ? ` AND ${sql.join(" AND ")}` : "", params };
}

function toCandidate(entry: { row: NodeRow; base: number }): SearchCandidate {
  return {
    id: entry.row.id,
    kind: entry.row.kind as NodeKind,
    name: entry.row.name,
    qualifiedName: entry.row.qualified_name,
    filePath: entry.row.file_path,
    base: entry.base,
  };
}
