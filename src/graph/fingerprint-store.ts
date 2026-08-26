import type { GroundedSource, GroundingBaseline, GroundingSubject } from "./grounding.js";
import { bandHashes } from "./fingerprint.js";
import type { Fingerprint } from "./reconcile.js";
import type { SQLInputValue } from "node:sqlite";

export interface SqliteDatabase {
  prepare(sql: string): {
    run(...params: SQLInputValue[]): unknown;
    get(...params: SQLInputValue[]): unknown;
    all(...params: SQLInputValue[]): unknown[];
  };
  exec(sql: string): void;
}

interface FingerprintRow {
  node_id: string;
  minhash: string;
  neighbors: string;
  token_count: number;
}

export class FingerprintStore {
  constructor(private readonly db: SqliteDatabase) {}

  upsert(nodeId: string, fingerprint: Fingerprint): void {
    this.upsertMany([{ nodeId, fingerprint }]);
  }

  /**
   * Persist a corpus of fingerprints with one savepoint and one set of
   * prepared statements. Each node still replaces exactly the same fingerprint
   * and LSH rows as {@link upsert}; batching only removes statement preparation,
   * savepoint, and per-band insert overhead from full graph builds.
   */
  upsertMany(entries: Iterable<{ nodeId: string; fingerprint: Fingerprint }>): void {
    const latestByNode = new Map<string, { nodeId: string; fingerprint: Fingerprint }>();
    for (const entry of entries) latestByNode.set(entry.nodeId, entry);
    const ordered = [...latestByNode.values()].sort((left, right) => left.nodeId.localeCompare(right.nodeId));
    if (ordered.length === 0) return;

    const upsertFingerprint = this.db.prepare(
      `INSERT INTO node_fingerprints (node_id, minhash, neighbors, token_count)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(node_id) DO UPDATE SET minhash=excluded.minhash,
         neighbors=excluded.neighbors, token_count=excluded.token_count`,
    );
    const bucketCount = bandHashes(ordered[0]!.fingerprint).length;
    const insertBuckets = this.db.prepare(
      `INSERT INTO lsh_buckets (band, band_hash, node_id) VALUES ${
        Array.from({ length: bucketCount }, () => "(?, ?, ?)").join(", ")
      }`,
    );

    this.db.exec("SAVEPOINT mex_fingerprint_upsert_many");
    try {
      // Delete prior buckets before inserting any replacements. Without a
      // node_id-oriented LSH index, deleting once per node degenerates into a
      // full-table scan for every fingerprint as this table grows. Chunked IN
      // deletes scan the old table only a bounded number of times and produce
      // the identical final rows (the last entry for a duplicate node wins).
      const deleteChunkSize = 500;
      for (let offset = 0; offset < ordered.length; offset += deleteChunkSize) {
        const nodeIds = ordered.slice(offset, offset + deleteChunkSize).map((entry) => entry.nodeId);
        this.db.prepare(
          `DELETE FROM lsh_buckets WHERE node_id IN (${nodeIds.map(() => "?").join(",")})`,
        ).run(...nodeIds);
      }
      for (const { nodeId, fingerprint } of ordered) {
        const buckets = bandHashes(fingerprint);
        if (buckets.length !== bucketCount) {
          throw new Error(`Inconsistent fingerprint band count for ${nodeId}.`);
        }
        upsertFingerprint.run(
          nodeId,
          JSON.stringify(fingerprint.minhash),
          JSON.stringify(fingerprint.neighbors),
          fingerprint.tokenCount,
        );
        insertBuckets.run(...buckets.flatMap((bandHash, band) => [band, bandHash, nodeId]));
      }
      this.db.exec("RELEASE mex_fingerprint_upsert_many");
    } catch (error) {
      this.db.exec("ROLLBACK TO mex_fingerprint_upsert_many");
      this.db.exec("RELEASE mex_fingerprint_upsert_many");
      throw error;
    }
  }

  get(nodeId: string): Fingerprint | null {
    const row = this.db.prepare(
      `SELECT node_id, minhash, neighbors, token_count
       FROM node_fingerprints WHERE node_id = ?
       UNION ALL
       SELECT fingerprints.node_id, fingerprints.minhash, fingerprints.neighbors, fingerprints.token_count
       FROM node_aliases aliases
       JOIN node_fingerprints fingerprints ON fingerprints.node_id = aliases.canonical_node_id
       WHERE aliases.alias_id = ?
       LIMIT 1`,
    ).get(nodeId, nodeId) as FingerprintRow | undefined;
    return row ? decodeRow(row) : null;
  }

  lookup(fingerprint: Fingerprint): Array<{ nodeId: string; fingerprint: Fingerprint }> {
    const candidates = new Set<string>();
    const lookup = this.db.prepare(
      "SELECT node_id FROM lsh_buckets WHERE band = ? AND band_hash = ?",
    );
    bandHashes(fingerprint).forEach((bandHash, band) => {
      for (const row of lookup.all(band, bandHash) as Array<{ node_id: string }>) {
        candidates.add(row.node_id);
      }
    });
    return [...candidates]
      .sort()
      .map((nodeId) => ({ nodeId, fingerprint: this.get(nodeId) }))
      .filter((entry): entry is { nodeId: string; fingerprint: Fingerprint } => entry.fingerprint !== null);
  }

  /**
   * The baseline for one (subject, node) pair, following a node alias when the
   * id it was grounded under has since been reconciled to a canonical one.
   *
   * Subject-generalized (schema v3). `getGroundedSource` is the scaffold-kind
   * projection of it, so there is one accessor and not two: a second one would
   * be a second place for the alias fallback to be forgotten.
   */
  getBaseline(subject: GroundingSubject, nodeId: string): GroundingBaseline | null {
    const row = this.db.prepare(
      `SELECT subject_kind, subject_id, node_id, source, body_hash, fingerprint
       FROM _mex_grounded_source
       WHERE subject_kind = ? AND subject_id = ? AND node_id = ?
       UNION ALL
       SELECT grounded.subject_kind, grounded.subject_id, grounded.node_id,
              grounded.source, grounded.body_hash, grounded.fingerprint
       FROM node_aliases aliases
       JOIN _mex_grounded_source grounded ON grounded.node_id = aliases.alias_id
       WHERE grounded.subject_kind = ? AND grounded.subject_id = ? AND aliases.canonical_node_id = ?
       LIMIT 1`,
    ).get(subject.kind, subject.id, nodeId, subject.kind, subject.id, nodeId) as BaselineRow | undefined;
    return row ? decodeBaseline(row) : null;
  }

  /** Every baseline recorded for one subject, in node order. */
  listBaselines(subject: GroundingSubject): GroundingBaseline[] {
    const rows = this.db.prepare(
      `SELECT subject_kind, subject_id, node_id, source, body_hash, fingerprint
       FROM _mex_grounded_source WHERE subject_kind = ? AND subject_id = ?
       ORDER BY node_id`,
    ).all(subject.kind, subject.id) as BaselineRow[];
    return rows.map(decodeBaseline);
  }

  saveBaseline(baseline: GroundingBaseline): void {
    this.db.prepare(
      `INSERT INTO _mex_grounded_source
       (subject_kind, subject_id, node_id, source, body_hash, fingerprint) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(subject_kind, subject_id, node_id) DO UPDATE SET source=excluded.source,
         body_hash=excluded.body_hash, fingerprint=excluded.fingerprint`,
    ).run(
      baseline.subject.kind,
      baseline.subject.id,
      baseline.nodeId,
      baseline.source,
      baseline.bodyHash,
      baseline.fingerprint,
    );
  }

  deleteBaseline(subject: GroundingSubject, nodeId: string): void {
    this.db.prepare(
      "DELETE FROM _mex_grounded_source WHERE subject_kind = ? AND subject_id = ? AND node_id = ?",
    ).run(subject.kind, subject.id, nodeId);
  }

  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null {
    const baseline = this.getBaseline({ kind: "scaffold", id: scaffoldFile }, nodeId);
    return baseline ? {
      scaffoldFile: baseline.subject.id,
      nodeId: baseline.nodeId,
      source: baseline.source,
      bodyHash: baseline.bodyHash,
      fingerprint: baseline.fingerprint,
    } : null;
  }

  saveGroundedSource(source: GroundedSource): void {
    this.saveBaseline({
      subject: { kind: "scaffold", id: source.scaffoldFile },
      nodeId: source.nodeId,
      source: source.source,
      bodyHash: source.bodyHash,
      fingerprint: source.fingerprint,
    });
  }

  deleteGroundedSource(scaffoldFile: string, nodeId: string): void {
    this.deleteBaseline({ kind: "scaffold", id: scaffoldFile }, nodeId);
  }
}

interface BaselineRow {
  subject_kind: string;
  subject_id: string;
  node_id: string;
  source: string;
  body_hash: string;
  fingerprint: string;
}

function decodeBaseline(row: BaselineRow): GroundingBaseline {
  return {
    subject: { kind: row.subject_kind as GroundingSubject["kind"], id: row.subject_id },
    nodeId: row.node_id,
    source: row.source,
    bodyHash: row.body_hash,
    fingerprint: row.fingerprint,
  };
}

function decodeRow(row: FingerprintRow): Fingerprint {
  return {
    minhash: JSON.parse(row.minhash) as number[],
    neighbors: JSON.parse(row.neighbors) as string[],
    tokenCount: row.token_count,
  };
}
