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

import { existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { schemaPath } from "../assets.js";
import { GraphRebuildRequiredError } from "../errors.js";
import { openSqlite, type SqliteDatabase } from "./sqlite.js";

/** The schema version this build writes/expects (matches schema.sql's seed). */
export const DB_SCHEMA_VERSION = 3;

/** @deprecated Prefer the explicit DB_SCHEMA_VERSION name. */
export const CURRENT_SCHEMA_VERSION = DB_SCHEMA_VERSION;

export interface OpenGraphDatabaseOptions {
  /** Builders may open a migrated database in order to replace its derived rows. */
  allowRebuild?: boolean;
  /** Reader-only commands must not mutate pragmas, schema, or version metadata. */
  readOnly?: boolean;
  /**
   * Ignore SQLite WAL state and prohibit sidecar creation. Callers must first
   * establish that no non-empty WAL contains authoritative graph data.
   */
  immutable?: boolean;
}

function configureConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000"); // MUST be first
  db.pragma("foreign_keys = ON"); // per-connection; required for ON DELETE CASCADE
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = NORMAL"); // safe under WAL
  db.pragma("temp_store = MEMORY");
}

function configureReadOnlyConnection(db: SqliteDatabase): void {
  db.pragma("busy_timeout = 5000");
  db.pragma("query_only = ON");
}

/**
 * Open the graph DB at `dbPath`, creating the file + parent dir and applying the
 * schema when absent. Idempotent: re-opening an existing DB re-applies PRAGMAs
 * and re-asserts the schema (all statements are `IF NOT EXISTS`).
 */
export function openGraphDatabase(
  dbPath: string,
  options: OpenGraphDatabaseOptions = {},
): SqliteDatabase {
  if (options.immutable && !options.readOnly) {
    throw new TypeError("Immutable graph access requires readOnly: true.");
  }
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    if (options.readOnly) throw new GraphRebuildRequiredError("The graph index does not exist. Run `mex graph` first.");
    mkdirSync(dir, { recursive: true });
  }

  if (options.readOnly) {
    return options.immutable
      ? openImmutableGraphDatabase(dbPath)
      : openReadOnlyGraphDatabase(dbPath);
  }
  const db = openSqlite(dbPath);
  configureConnection(db);

  const schema = readFileSync(schemaPath(), "utf-8");
  const hasVersions = tableExists(db, "schema_versions");
  if (!hasVersions) {
    db.exec(schema);
  } else {
    const current = readSchemaVersion(db) ?? 1;
    if (current > DB_SCHEMA_VERSION) {
      db.close();
      throw new GraphRebuildRequiredError(
        `This mex build supports graph schema ${DB_SCHEMA_VERSION}, but the index uses ${current}.`,
      );
    }
    if (current < DB_SCHEMA_VERSION) {
      if (!options.allowRebuild) {
        db.close();
        throw new GraphRebuildRequiredError(
          `This mex build expects graph schema ${DB_SCHEMA_VERSION}; the index uses ${current}. Run \`mex graph rebuild\`.`,
        );
      }
      migrate(db, schema, current);
    } else db.exec(schema);
  }

  // Belt-and-suspenders: guarantee the version row exists even if the SQL seed
  // is ever changed, so the schema_versions table is never dead (migration
  // safety — Phase 0 shipped this table for exactly this reason).
  writeSchemaVersion(db, DB_SCHEMA_VERSION);

  if (!options.allowRebuild && graphRequiresRebuild(db)) {
    db.close();
    throw new GraphRebuildRequiredError();
  }

  return db;
}

function validateReadOnlyGraphDatabase(db: SqliteDatabase): SqliteDatabase {
  configureReadOnlyConnection(db);
  if (!tableExists(db, "schema_versions") || readSchemaVersion(db) !== DB_SCHEMA_VERSION) {
    throw new GraphRebuildRequiredError();
  }
  if (graphRequiresRebuild(db)) throw new GraphRebuildRequiredError();
  return db;
}

function openImmutableGraphDatabase(dbPath: string): SqliteDatabase {
  const db = openSqlite(dbPath, { readOnly: true, immutable: true });
  try {
    return validateReadOnlyGraphDatabase(db);
  } catch (error) {
    db.close();
    throw error;
  }
}

function openReadOnlyGraphDatabase(dbPath: string): SqliteDatabase {
  let db = openSqlite(dbPath, { readOnly: true });
  try {
    return validateReadOnlyGraphDatabase(db);
  } catch (error) {
    db.close();
    const message = error instanceof Error ? error.message : String(error);
    if (!/read.?only/i.test(message)) throw error;
    const walPath = `${dbPath}-wal`;
    if (existsSync(walPath) && statSync(walPath).size > 0) {
      throw new Error(
        "The graph has uncheckpointed WAL data and cannot be opened in this read-only sandbox. "
        + "Run `mex graph` outside the sandbox and retry.",
      );
    }
    // A checkpointed WAL-mode database can still ask SQLite to create -shm on
    // first read. Immutable mode is safe only when no WAL payload exists.
    db = openSqlite(dbPath, { readOnly: true, immutable: true });
    try {
      return validateReadOnlyGraphDatabase(db);
    } catch (immutableError) {
      db.close();
      throw immutableError;
    }
  }
}

/** Ensure a `schema_versions` row for `version` exists (no-op if already there). */
export function writeSchemaVersion(db: SqliteDatabase, version: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)",
  ).run(version, Date.now(), "mex code-graph schema (Track A build)");
}

/**
 * Record `version` as the highest schema this database has actually reached.
 *
 * Stamping is not a plain insert, because a migration step is allowed to
 * `exec` the frozen schema — and the schema seeds its own version row. Without
 * the delete, {@link migrateV1ToV2}'s schema exec would stamp the database with
 * the *current* version halfway up the ladder; a crash in the next step would
 * then leave a half-migrated database claiming to be finished, and the next
 * open would skip every remaining step. Trimming anything above the step that
 * actually completed is what makes the ladder resumable.
 */
function stampSchemaVersion(db: SqliteDatabase, version: number): void {
  writeSchemaVersion(db, version);
  db.prepare("DELETE FROM schema_versions WHERE version > ?").run(version);
}

/** The highest recorded schema version, or null if none is recorded. */
export function readSchemaVersion(db: SqliteDatabase): number | null {
  const row = db
    .prepare("SELECT version FROM schema_versions ORDER BY version DESC LIMIT 1")
    .get() as { version: number } | undefined;
  return row ? row.version : null;
}

/** Mark a successfully validated graph snapshot safe for readers. */
export function markGraphReady(db: SqliteDatabase, manifestHash: string): void {
  setMetadata(db, "rebuild_required", "0");
  setMetadata(db, "manifest_hash", manifestHash);
}

/** Force readers to abstain until a full build publishes a compatible graph. */
export function markGraphRebuildRequired(db: SqliteDatabase, reason: string): void {
  setMetadata(db, "rebuild_required", "1");
  setMetadata(db, "rebuild_reason", reason);
}

export function graphRequiresRebuild(db: SqliteDatabase): boolean {
  if (!tableExists(db, "project_metadata")) return false;
  const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'rebuild_required'").get() as
    | { value: string }
    | undefined;
  return row?.value === "1";
}

function setMetadata(db: SqliteDatabase, key: string, value: string): void {
  db.prepare(
    `INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, value, Date.now());
}

function tableExists(db: SqliteDatabase, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table));
}

function columns(db: SqliteDatabase, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name),
  );
}

function addColumn(db: SqliteDatabase, table: string, name: string, definition: string): void {
  if (!columns(db, table).has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
}

/**
 * One rung of the version ladder: what it upgrades from, and to.
 *
 * A step never writes its own version row — {@link migrate} stamps it after the
 * step returns, so a step that throws leaves the database at the version it
 * actually still has.
 */
interface MigrationStep {
  from: number;
  to: number;
  run(db: SqliteDatabase, schema: string): void;
}

/**
 * Every migration, in order, each applying to exactly one version.
 *
 * **This replaced a single `if`.** The dispatch used to read
 * `if (current < DB_SCHEMA_VERSION) migrateV1ToV2(db, schema)`, which is
 * correct only while there is exactly one migration. The moment a second one
 * exists, a v1 database runs the v1 step, is stamped with the current version,
 * and never sees the v2 step — silently mislabelled, with no error and no
 * rebuild prompt. A ladder cannot do that: it applies every step whose target
 * is above the version the database actually has.
 *
 * A test asserts this list is contiguous from 1 and ends at
 * {@link DB_SCHEMA_VERSION}, so adding a step without wiring it up fails
 * loudly rather than skipping a rung.
 */
const MIGRATIONS: readonly MigrationStep[] = [
  { from: 1, to: 2, run: migrateV1ToV2 },
  { from: 2, to: 3, run: migrateV2ToV3 },
];

/** The ladder, exposed for the test that checks it has no gaps. */
export function migrationSteps(): ReadonlyArray<{ from: number; to: number }> {
  return MIGRATIONS.map((step) => ({ from: step.from, to: step.to }));
}

/** Apply every migration above `current`, in order, stamping each as it lands. */
function migrate(db: SqliteDatabase, schema: string, current: number): void {
  setAsideLegacyBaseline(db);
  let version = current;
  for (const step of MIGRATIONS) {
    if (version >= step.to) continue;
    step.run(db, schema);
    stampSchemaVersion(db, step.to);
    version = step.to;
  }
}

/** Where a pre-v3 grounding baseline waits while the v3 table is created. */
const LEGACY_GROUNDED_SOURCE = "_mex_grounded_source_v2";

/**
 * Move a pre-v3 grounding baseline aside **before any step execs the schema**.
 *
 * This is not tidiness, it is an ordering constraint with teeth. Every
 * migration step ends by exec'ing the frozen schema, and the schema now
 * declares `idx_grounded_subject` over v3-only columns. Exec'ing it against a
 * table that still has the v2 (or v1) shape fails with `no such column:
 * subject_kind` — so a v1 database would die inside the *v1* step, before the
 * v3 step it needs ever runs. Renaming the old table first means every
 * subsequent `exec(schema)` finds no table there and creates the v3 one from
 * the single frozen definition, with no DDL duplicated into TypeScript.
 *
 * The rename is pure DDL and carries no dependency on the database's version,
 * which is what lets it sit before the ladder rather than inside a rung. The
 * rows are carried across in {@link migrateV2ToV3}, where they belong.
 *
 * Resumable by construction: if the process dies between the rename and the
 * copy, the next open finds no `_mex_grounded_source` at all — so this returns
 * early, the schema recreates the v3 table, and the v3 rung finds the legacy
 * rows still waiting and finishes the job.
 */
function setAsideLegacyBaseline(db: SqliteDatabase): void {
  if (!tableExists(db, "_mex_grounded_source")) return;
  if (columns(db, "_mex_grounded_source").has("subject_kind")) return;

  // The index has to go first: renaming a table does not rename its indexes, so
  // `idx_grounded_node` would stay attached to the renamed table, the schema's
  // `CREATE INDEX IF NOT EXISTS` would find the name taken and do nothing, and
  // dropping the legacy table would then take the index with it — leaving v3
  // without its reverse lookup and nothing failing.
  db.exec("DROP INDEX IF EXISTS idx_grounded_node");
  db.exec(`ALTER TABLE _mex_grounded_source RENAME TO ${LEGACY_GROUNDED_SOURCE}`);
}

/**
 * Schema v1 graph facts are not trustworthy under the v2 identity/resolution
 * contract. The migration is additive so grounding snapshots can be retained,
 * then marks the derived graph for a mandatory full rebuild.
 */
function migrateV1ToV2(db: SqliteDatabase, schema: string): void {
  db.transaction(() => {
    addColumn(db, "nodes", "container_id", "TEXT");
    addColumn(db, "nodes", "identity_key", "TEXT NOT NULL DEFAULT ''");
    db.exec("UPDATE nodes SET identity_key = id WHERE identity_key = ''");

    addColumn(db, "edges", "confidence", "REAL NOT NULL DEFAULT 1.0");
    addColumn(db, "edges", "resolution_method", "TEXT");
    addColumn(db, "edges", "evidence", "TEXT");

    addColumn(db, "files", "parse_status", "TEXT NOT NULL DEFAULT 'ok'");
    addColumn(db, "files", "diagnostic_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "files", "missing_count", "INTEGER NOT NULL DEFAULT 0");
    addColumn(db, "files", "error_coverage", "REAL NOT NULL DEFAULT 0");
    addColumn(db, "files", "extractor_version", "TEXT NOT NULL DEFAULT 'legacy-v1'");

    addColumn(db, "unresolved_refs", "ref_key", "TEXT NOT NULL DEFAULT ''");
    addColumn(db, "unresolved_refs", "receiver", "TEXT");
    addColumn(db, "unresolved_refs", "qualifier", "TEXT");
    addColumn(db, "unresolved_refs", "import_source", "TEXT");
    addColumn(db, "unresolved_refs", "metadata", "TEXT");
    addColumn(db, "unresolved_refs", "status", "TEXT NOT NULL DEFAULT 'pending'");
    addColumn(db, "unresolved_refs", "target_id", "TEXT");
    addColumn(db, "unresolved_refs", "confidence", "REAL");
    addColumn(db, "unresolved_refs", "resolver", "TEXT");
    db.exec("UPDATE unresolved_refs SET ref_key = 'legacy:' || id WHERE ref_key = ''");

    // Existing v1 builds can contain duplicate traversal edges. Retain one row
    // per semantic callsite so the v2 uniqueness invariant can be installed.
    db.exec(`DELETE FROM edges WHERE id NOT IN (
      SELECT MIN(id) FROM edges
      GROUP BY source, target, kind, IFNULL(line, -1), IFNULL(col, -1)
    )`);
  });

  // Creates all new tables and indexes after the old tables have the v2 columns.
  db.exec(schema);
  db.exec("CREATE UNIQUE INDEX IF NOT EXISTS idx_unresolved_ref_key ON unresolved_refs(ref_key)");
  markGraphRebuildRequired(db, "schema-v1");
}

/**
 * v3 generalizes the grounding baseline's key from a scaffold file to a
 * subject, so a wiki entity can carry its own baseline (D1: one baseline
 * store, never two).
 *
 * SQLite cannot alter a primary key, so this is a table rebuild. It runs only
 * for an explicitly isolated rebuild candidate (`allowRebuild: true`). Status
 * and ordinary readers classify a live v2 database as rebuild-required; they
 * never migrate the user's live bytes as a side effect of retrieval.
 *
 * Two things here are not obvious and both are load-bearing:
 *
 * **The old table's shape is not knowable in advance.** A database that
 * reached v2 by migrating from v1 still has the *v1* grounding table, because
 * {@link migrateV1ToV2} creates new tables with `CREATE TABLE IF NOT EXISTS`,
 * which leaves an existing table alone — so it never gained `source` or
 * `fingerprint`. A copy that names those columns unconditionally fails on
 * exactly the v1-to-v3 path, which is the path most likely to exist in the
 * wild and least likely to be tested. Missing columns are copied as empty
 * strings: a baseline with no captured source can still be re-grounded, and
 * pretending otherwise would mean dropping the row.
 *
 * **The new table comes from the frozen schema, not from SQL repeated here.**
 * The old table is renamed out of the way first, so `exec(schema)` creates the
 * v3 shape from the one definition that ships. A second copy of the DDL in
 * TypeScript is a copy that drifts.
 */
function migrateV2ToV3(db: SqliteDatabase, schema: string): void {
  db.transaction(() => {
    // Creates the v3 table and both its indexes from the frozen schema. A
    // second copy of that DDL in TypeScript is a copy that drifts.
    db.exec(schema);
    if (!tableExists(db, LEGACY_GROUNDED_SOURCE)) return;

    const existing = columns(db, LEGACY_GROUNDED_SOURCE);
    const subjectId = existing.has("subject_id") ? "subject_id" : "scaffold_file";
    const carried = (column: string): string => (existing.has(column) ? column : "''");

    db.exec(
      `INSERT OR IGNORE INTO _mex_grounded_source (subject_kind, subject_id, node_id, source, body_hash, fingerprint)
       SELECT 'scaffold', ${subjectId}, node_id, ${carried("source")}, ${carried("body_hash")}, ${carried("fingerprint")}
       FROM ${LEGACY_GROUNDED_SOURCE}`,
    );
    db.exec(`DROP TABLE ${LEGACY_GROUNDED_SOURCE}`);
  });
}
