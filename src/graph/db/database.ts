// ============================================================================
// mex code-graph — database open / schema init  (A3)
// ============================================================================
//
// Opens the graph SQLite DB, loads the FROZEN `src/graph/schema.sql` (resolved
// from the install location via `assets.ts`), applies the connection-level
// PRAGMAs, and guarantees a `schema_versions` row exists.
//
// PRAGMA notes (must be applied in code on EVERY open — spec / schema.sql):
//   * busy_timeout FIRST, before any pragma that touches the file, so a
//     concurrent writer is waited out instead of throwing "database is locked".
//   * foreign_keys is PER-CONNECTION and MUST be re-asserted every open — the
//     per-file replace path (sync) relies on ON DELETE CASCADE.
//   * journal_mode=WAL persists in the file header; re-asserting is harmless.

import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";
import { schemaPath } from "../assets.js";
import { segmentsFor } from "../search/segments.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

/** The schema version this build writes/expects (matches schema.sql's seed). */
export const CURRENT_SCHEMA_VERSION = 2;

function configureConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000"); // MUST be first
  db.pragma("foreign_keys = ON"); // per-connection; required for ON DELETE CASCADE
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // safe under WAL
  db.pragma("temp_store = MEMORY");
}

/**
 * Open the graph DB at `dbPath`, creating the file + parent dir and applying the
 * schema when absent. Idempotent: re-opening an existing DB re-applies PRAGMAs
 * and re-asserts the schema (all statements are `IF NOT EXISTS`).
 */
export function openGraphDatabase(dbPath: string): SqliteDatabase {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const db = openSqlite(dbPath);
  configureConnection(db);

  // Load + apply the frozen schema (creates tables/indexes/triggers, and — via
  // its own INSERT OR IGNORE — seeds the schema_versions row).
  const schema = readFileSync(schemaPath(), "utf-8");
  db.exec(schema);

  // Bring a database written under an older schema up to this one. Every
  // statement above is `IF NOT EXISTS`, which adds new TABLES to an old file for
  // free but never adds a COLUMN to a table that already exists, and never
  // replaces a virtual table whose definition changed.
  migrateSchema(db, schema);

  // Belt-and-suspenders: guarantee the version row exists even if the SQL seed
  // is ever changed, so the schema_versions table is never dead (migration
  // safety — Phase 0 shipped this table for exactly this reason).
  writeSchemaVersion(db, CURRENT_SCHEMA_VERSION);

  return db;
}

/** Does `nodes` already carry the v2 derived `segments` column? */
function hasSegmentsColumn(db: SqliteDatabase): boolean {
  const columns = db.prepare("PRAGMA table_info(nodes)").all() as Array<{ name: string }>;
  return columns.some((column) => column.name === "segments");
}

/**
 * Does the live `nodes_fts` definition match the one this build would create?
 *
 * Compared on the stored DDL text rather than on a version counter, so the check
 * is derived from the schema itself and cannot drift out of step with it. This
 * asks "is it the RIGHT index", which is a different failure from "is it
 * POPULATED" with the same symptom: an index written under v1 is perfectly full
 * and simply cannot answer a segment or a stemmed query.
 */
function ftsShapeIsCurrent(db: SqliteDatabase): boolean {
  const row = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'nodes_fts'")
    .get() as { sql: string | null } | undefined;
  if (row?.sql == null) return false;
  const live = row.sql.replace(/\s+/g, " ");
  return live.includes("segments") && live.includes("porter unicode61");
}

/**
 * Is the inverted index empty while `nodes` holds rows?
 *
 * Detected through the `nodes_fts_docsize` shadow table, which holds one row per
 * INDEXED document. The two obvious alternatives are both blind to an empty
 * external-content index, verified on this build of SQLite: `SELECT COUNT(*)
 * FROM nodes_fts` reads THROUGH to the content table and reports the full node
 * count, and `INSERT INTO nodes_fts(nodes_fts) VALUES('integrity-check')`
 * PASSES. Only `docsize` distinguishes populated from empty.
 */
function ftsIsUnpopulated(db: SqliteDatabase): boolean {
  const nodes = (db.prepare("SELECT count(*) AS c FROM nodes").get() as { c: number }).c;
  if (nodes === 0) return false; // a fresh database has nothing to index
  const indexed = (db.prepare("SELECT count(*) AS c FROM nodes_fts_docsize").get() as { c: number }).c;
  return indexed < nodes;
}

/**
 * Migrate an existing database to the current schema, in place. Idempotent, and
 * a no-op (three cheap reads) on a database this build just created.
 *
 * v1 → v2 adds `nodes.segments` and re-shapes `nodes_fts` around it. The column
 * is a pure function of `name`, so it is BACK-FILLED rather than left empty:
 * leaving it blank would mean a migrated index silently lost half of every
 * camelCase name until someone happened to re-index, which is the same
 * silent-degradation failure the FTS triggers exist to prevent. Nothing is
 * re-extracted and no other column is written, so no node's `id` or `body_hash`
 * moves.
 */
export function migrateSchema(db: SqliteDatabase, schema: string): void {
  const addedColumn = !hasSegmentsColumn(db);
  if (addedColumn) {
    db.exec("ALTER TABLE nodes ADD COLUMN segments TEXT NOT NULL DEFAULT ''");
  }
  if (!addedColumn && ftsShapeIsCurrent(db) && !ftsIsUnpopulated(db)) return;

  db.transaction(() => {
    // Drop the triggers before the back-fill: they exist to keep the index in
    // step with single-row writes, and firing 20,000 delete+insert pairs into an
    // index that is about to be rebuilt wholesale is pure cost. Dropping the
    // table too is what forces the new DDL to be applied — `CREATE VIRTUAL TABLE
    // IF NOT EXISTS` would see the old definition and leave it exactly as it is.
    db.exec(`
      DROP TRIGGER IF EXISTS nodes_ai;
      DROP TRIGGER IF EXISTS nodes_ad;
      DROP TRIGGER IF EXISTS nodes_au;
      DROP TABLE IF EXISTS nodes_fts;
    `);
    if (addedColumn) {
      const rows = db.prepare("SELECT id, name FROM nodes").all() as Array<{ id: string; name: string }>;
      const update = db.prepare("UPDATE nodes SET segments = ? WHERE id = ?");
      for (const row of rows) update.run(segmentsFor(row.name), row.id);
    }
    // Re-running the whole schema is safe (every statement is IF NOT EXISTS) and
    // keeps one canonical definition of the index: the file the build ships.
    db.exec(schema);
    db.exec("INSERT INTO nodes_fts(nodes_fts) VALUES('rebuild')");
  });
}

/** Ensure a `schema_versions` row for `version` exists (no-op if already there). */
export function writeSchemaVersion(db: SqliteDatabase, version: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)",
  ).run(version, Date.now(), "mex code-graph schema (Track A build)");
}

/** The highest recorded schema version, or null if none is recorded. */
export function readSchemaVersion(db: SqliteDatabase): number | null {
  const row = db
    .prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  return row ? row.version : null;
}
