/**
 * Schema v3 — the subject-generalized grounding baseline, and the version
 * ladder that gets a database there.
 *
 * Three things are being defended here, and they fail in different ways.
 *
 * **The ladder.** The dispatch used to be a single `if`: any database below the
 * current version ran `migrateV1ToV2` and was then stamped with the current
 * version. With one migration that is correct; with two it silently mislabels
 * a v1 database as v3 while skipping the v3 step. Nothing throws, and the
 * damage is only visible much later.
 *
 * **The explicit upgrade boundary.** Ordinary readers and writers reject v2.
 * Only an isolated rebuild candidate opened with `allowRebuild` may carry its
 * grounding baseline into v3 before the full graph build replaces derived
 * facts. The live v2 database is never migrated by an ordinary read.
 */

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { schemaPath } from "../assets.js";
import {
  DB_SCHEMA_VERSION,
  graphRequiresRebuild,
  migrationSteps,
  openGraphDatabase,
  readSchemaVersion,
} from "../db/database.js";
import { openSqlite, type SqliteDatabase } from "../db/sqlite.js";
import { GraphRebuildRequiredError } from "../errors.js";
import { FingerprintStore } from "../fingerprint-store.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps a handle on a just-closed SQLite file often enough that
      // cleanup failure would otherwise be the only red in the file.
    }
  }
});

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function schemaSql(): string {
  return readFileSync(schemaPath(), "utf-8");
}

/**
 * A v2 database: the current schema with the one table v3 changed put back the
 * way v2 had it, and the version row wound back.
 *
 * Built by downgrading rather than by pasting a whole historical schema,
 * because the only difference that matters to this migration *is* that table —
 * and a hand-copied v2 schema would rot the moment anything else moved.
 */
function createV2Database(path: string, rows: ReadonlyArray<[string, string, string, string, string]>): void {
  const db = openSqlite(path);
  try {
    db.exec(schemaSql());
    db.exec(`
      DROP INDEX IF EXISTS idx_grounded_subject;
      DROP INDEX IF EXISTS idx_grounded_node;
      DROP TABLE _mex_grounded_source;
      CREATE TABLE _mex_grounded_source (
          scaffold_file TEXT NOT NULL,
          node_id       TEXT NOT NULL,
          source        TEXT NOT NULL,
          body_hash     TEXT NOT NULL,
          fingerprint   TEXT NOT NULL,
          PRIMARY KEY (scaffold_file, node_id)
      );
      CREATE INDEX idx_grounded_node ON _mex_grounded_source(node_id);
      DELETE FROM schema_versions WHERE version > 2;
      INSERT OR IGNORE INTO schema_versions (version, applied_at, description)
        VALUES (2, 1, 'v2 fixture');
    `);
    const insert = db.prepare(
      "INSERT INTO _mex_grounded_source (scaffold_file, node_id, source, body_hash, fingerprint) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of rows) insert.run(...row);
  } finally {
    db.close();
  }
}

/**
 * A minimal pre-v2 database, with the *v1* grounding table — which has neither
 * `source` nor `fingerprint`.
 *
 * That shape is not hypothetical: `migrateV1ToV2` creates new tables with
 * `CREATE TABLE IF NOT EXISTS`, which leaves an existing table alone, so a
 * database that reached v2 by migrating still carries it. A v3 copy step that
 * names those columns unconditionally fails on exactly this path.
 */
function createV1Database(path: string): void {
  const db = openSqlite(path);
  try {
    db.exec(`
      CREATE TABLE schema_versions (
        version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT
      );
      INSERT INTO schema_versions VALUES (1, 1, 'legacy graph');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL,
        qualified_name TEXT NOT NULL, file_path TEXT NOT NULL, language TEXT NOT NULL,
        start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL,
        docstring TEXT, signature TEXT, visibility TEXT,
        is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0,
        is_static INTEGER DEFAULT 0, is_abstract INTEGER DEFAULT 0,
        decorators TEXT, type_parameters TEXT, return_type TEXT, body_hash TEXT,
        updated_at INTEGER NOT NULL
      );
      CREATE TABLE edges (
        id INTEGER PRIMARY KEY AUTOINCREMENT, source TEXT NOT NULL, target TEXT NOT NULL,
        kind TEXT NOT NULL, metadata TEXT, line INTEGER, col INTEGER, provenance TEXT
      );
      CREATE TABLE files (
        path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT NOT NULL,
        size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL,
        node_count INTEGER DEFAULT 0, errors TEXT
      );
      CREATE TABLE unresolved_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT, from_node_id TEXT NOT NULL,
        reference_name TEXT NOT NULL, reference_kind TEXT NOT NULL,
        line INTEGER NOT NULL, col INTEGER NOT NULL, candidates TEXT,
        file_path TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT 'unknown'
      );
      CREATE TABLE _mex_grounded_source (
        scaffold_file TEXT NOT NULL, node_id TEXT NOT NULL, body_hash TEXT NOT NULL,
        captured_at INTEGER NOT NULL, PRIMARY KEY (scaffold_file, node_id)
      );
      INSERT INTO _mex_grounded_source VALUES ('docs/unit.md', 'function:old', 'abc', 1);
    `);
  } finally {
    db.close();
  }
}

function rows(db: SqliteDatabase, sql: string): unknown[] {
  return db.prepare(sql).all() as unknown[];
}

function baselineRows(path: string): unknown[] {
  const db = openSqlite(path);
  try {
    return rows(
      db,
      `SELECT subject_kind, subject_id, node_id, source, body_hash, fingerprint, scaffold_file
       FROM _mex_grounded_source ORDER BY subject_kind, subject_id, node_id`,
    );
  } finally {
    db.close();
  }
}

const BASELINE: ReadonlyArray<[string, string, string, string, string]> = [
  ["docs/auth.md", "function:aaa1", "function rotate() {}", "hash-a", "mh:64:0a0b"],
  ["docs/auth.md", "function:bbb2", "function issue() {}", "hash-b", "mh:64:0c0d"],
  ["docs/cache.md", "function:ccc3", "function evict() {}", "hash-c", "mh:64:0e0f"],
];

describe("the migration ladder", () => {
  it("has a rung for every version from 1 to the current one", () => {
    const steps = migrationSteps();
    expect(steps.length).toBeGreaterThan(0);
    expect(steps[0]!.from).toBe(1);
    expect(steps.at(-1)!.to).toBe(DB_SCHEMA_VERSION);
    // Contiguous: no rung may be skipped, and no rung may span two versions.
    for (const step of steps) expect(step.to).toBe(step.from + 1);
    for (let index = 1; index < steps.length; index += 1) {
      expect(steps[index]!.from).toBe(steps[index - 1]!.to);
    }
  });

  it("applies both rungs to a v1 database, in order", () => {
    const dbPath = join(temporaryRoot("mex-v1-to-v3-"), "graph.db");
    createV1Database(dbPath);

    const db = openGraphDatabase(dbPath, { allowRebuild: true });
    try {
      expect(readSchemaVersion(db)).toBe(3);
      // Both rungs left their mark. Under the old single-`if` dispatch the
      // database would carry a v3 row and never have seen the v3 step; the v2
      // row is what proves the v1 rung ran rather than being jumped over.
      expect(rows(db, "SELECT version FROM schema_versions ORDER BY version"))
        .toEqual([{ version: 1 }, { version: 2 }, { version: 3 }]);

      // v1 facts stay untrustworthy — that is the v1 rung's own verdict and the
      // v3 rung must not launder it away.
      expect(graphRequiresRebuild(db)).toBe(true);

      // The v1 table had no `source` and no `fingerprint`. The row survives
      // with those carried as empty rather than being dropped: a baseline with
      // no captured source can still be re-grounded.
      expect(rows(db, "SELECT subject_kind, subject_id, node_id, source, fingerprint, body_hash FROM _mex_grounded_source"))
        .toEqual([{
          subject_kind: "scaffold",
          subject_id: "docs/unit.md",
          node_id: "function:old",
          source: "",
          fingerprint: "",
          body_hash: "abc",
        }]);
    } finally {
      db.close();
    }
  });
});

describe("migrateV2ToV3", () => {
  it("requires explicit rebuild permission before migrating a v2 candidate", () => {
    const dbPath = join(temporaryRoot("mex-v2-to-v3-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    expect(() => openGraphDatabase(dbPath)).toThrow(GraphRebuildRequiredError);
    expect(readSchemaVersionOf(dbPath)).toBe(2);

    const db = openGraphDatabase(dbPath, { allowRebuild: true });
    try {
      expect(readSchemaVersion(db)).toBe(3);
      expect(graphRequiresRebuild(db)).toBe(false);
    } finally {
      db.close();
    }

    // Every row readable as a scaffold subject, values untouched, and the
    // generated `scaffold_file` still projecting what v2 queries expect.
    expect(baselineRows(dbPath)).toEqual(
      BASELINE.map(([file, node, source, bodyHash, fingerprint]) => ({
        subject_kind: "scaffold",
        subject_id: file,
        node_id: node,
        source,
        body_hash: bodyHash,
        fingerprint,
        scaffold_file: file,
      })),
    );
  });

  it("leaves both indexes in place", () => {
    const dbPath = join(temporaryRoot("mex-v3-index-"), "graph.db");
    createV2Database(dbPath, BASELINE);
    openGraphDatabase(dbPath, { allowRebuild: true }).close();

    const db = openSqlite(dbPath);
    try {
      const names = (rows(db, "SELECT name FROM sqlite_master WHERE type = 'index'") as Array<{ name: string }>)
        .map((row) => row.name);
      // `idx_grounded_node` is the one at risk: it is dropped before the
      // rename so the schema can recreate it, and a mistake there loses the
      // reverse lookup silently.
      expect(names).toContain("idx_grounded_node");
      expect(names).toContain("idx_grounded_subject");
    } finally {
      db.close();
    }
  });

  it("is idempotent, and a v3 database is untouched by a second open", () => {
    const dbPath = join(temporaryRoot("mex-v3-idempotent-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    openGraphDatabase(dbPath, { allowRebuild: true }).close();
    const afterFirst = baselineRows(dbPath);
    openGraphDatabase(dbPath, { allowRebuild: true }).close();
    openGraphDatabase(dbPath, { allowRebuild: true }).close();

    expect(baselineRows(dbPath)).toEqual(afterFirst);
    expect(afterFirst).toHaveLength(BASELINE.length);

    const db = openSqlite(dbPath);
    try {
      // No legacy table left behind by any of the three opens.
      expect(rows(db, "SELECT name FROM sqlite_master WHERE name = '_mex_grounded_source_v2'")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("finishes a migration that was interrupted after the table was set aside", () => {
    // The crash window: the legacy table has been renamed but its rows have not
    // been copied. The version row is still 2, so the next open must resume and
    // finish rather than find an empty v3 table and call it done.
    const dbPath = join(temporaryRoot("mex-v3-resume-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    const staged = openSqlite(dbPath);
    try {
      staged.exec("DROP INDEX IF EXISTS idx_grounded_node");
      staged.exec("ALTER TABLE _mex_grounded_source RENAME TO _mex_grounded_source_v2");
    } finally {
      staged.close();
    }

    openGraphDatabase(dbPath, { allowRebuild: true }).close();

    expect(baselineRows(dbPath)).toHaveLength(BASELINE.length);
    const db = openSqlite(dbPath);
    try {
      expect(rows(db, "SELECT name FROM sqlite_master WHERE name = '_mex_grounded_source_v2'")).toEqual([]);
    } finally {
      db.close();
    }
  });

  it("keeps the drift checker reading exactly what it read before", () => {
    // The checker consumes `getGroundedSource(scaffoldFile, nodeId)`. Its answer
    // must not move across the migration — that is what "the drift checker's
    // behaviour is unchanged" means operationally.
    const dbPath = join(temporaryRoot("mex-v3-checker-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    const db = openGraphDatabase(dbPath, { allowRebuild: true });
    try {
      const store = new FingerprintStore(db);
      expect(store.getGroundedSource("docs/auth.md", "function:aaa1")).toEqual({
        scaffoldFile: "docs/auth.md",
        nodeId: "function:aaa1",
        source: "function rotate() {}",
        bodyHash: "hash-a",
        fingerprint: "mh:64:0a0b",
      });
      expect(store.getGroundedSource("docs/auth.md", "function:missing")).toBeNull();
    } finally {
      db.close();
    }
  });
});

describe("the subject-generalized baseline", () => {
  it("keeps entity baselines out of every scaffold-shaped query", () => {
    const dbPath = join(temporaryRoot("mex-v3-subject-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    const db = openGraphDatabase(dbPath, { allowRebuild: true });
    try {
      const store = new FingerprintStore(db);
      const subject = { kind: "entity" as const, id: "mx_01KR2E4K002H3ZYA9G0C4XV531" };
      store.saveBaseline({
        subject,
        nodeId: "function:aaa1",
        source: "function rotate() {}",
        bodyHash: "hash-a",
        fingerprint: "mh:64:0a0b",
      });

      expect(store.getBaseline(subject, "function:aaa1")?.subject).toEqual(subject);

      // The same node is grounded by a scaffold file and by an entity. Both
      // rows exist and neither is visible through the other's key — which is
      // the whole reason the key was generalized.
      expect(store.getGroundedSource("docs/auth.md", "function:aaa1")?.source).toBe("function rotate() {}");
      expect(store.getBaseline({ kind: "scaffold", id: subject.id }, "function:aaa1")).toBeNull();

      // A v2-shaped query sees the scaffold rows and not the entity one.
      expect(rows(db, "SELECT subject_id FROM _mex_grounded_source WHERE scaffold_file IS NOT NULL ORDER BY subject_id"))
        .toEqual([
          { subject_id: "docs/auth.md" }, { subject_id: "docs/auth.md" }, { subject_id: "docs/cache.md" },
        ]);

      store.deleteBaseline(subject, "function:aaa1");
      expect(store.getBaseline(subject, "function:aaa1")).toBeNull();
      // Deleting the entity's baseline left the scaffold's alone.
      expect(store.getGroundedSource("docs/auth.md", "function:aaa1")).not.toBeNull();
    } finally {
      db.close();
    }
  });

  it("lists every baseline a subject holds, in node order", () => {
    const dbPath = join(temporaryRoot("mex-v3-list-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    const db = openGraphDatabase(dbPath, { allowRebuild: true });
    try {
      const store = new FingerprintStore(db);
      expect(store.listBaselines({ kind: "scaffold", id: "docs/auth.md" }).map((entry) => entry.nodeId))
        .toEqual(["function:aaa1", "function:bbb2"]);
      expect(store.listBaselines({ kind: "entity", id: "mx_nothing" })).toEqual([]);
    } finally {
      db.close();
    }
  });
});

describe("the exact read-only schema boundary", () => {
  it("refuses a v2 database read-only without migrating it", () => {
    const dbPath = join(temporaryRoot("mex-v3-readonly-"), "graph.db");
    createV2Database(dbPath, BASELINE);

    expect(() => openGraphDatabase(dbPath, { readOnly: true })).toThrow(GraphRebuildRequiredError);
    expect(readSchemaVersionOf(dbPath)).toBe(2);
  });

  it("refuses a v1 database read-only", () => {
    const dbPath = join(temporaryRoot("mex-v3-readonly-v1-"), "graph.db");
    createV1Database(dbPath);
    expect(() => openGraphDatabase(dbPath, { readOnly: true })).toThrow(GraphRebuildRequiredError);
    // And it did not quietly migrate on the way to refusing.
    expect(readSchemaVersionOf(dbPath)).toBe(1);
  });

  it("refuses a database newer than this build", () => {
    const dbPath = join(temporaryRoot("mex-v3-readonly-future-"), "graph.db");
    createV2Database(dbPath, BASELINE);
    const staged = openSqlite(dbPath);
    try {
      staged.exec(`INSERT INTO schema_versions (version, applied_at, description) VALUES (${DB_SCHEMA_VERSION + 1}, 1, 'future')`);
    } finally {
      staged.close();
    }
    expect(existsSync(dbPath)).toBe(true);
    expect(() => openGraphDatabase(dbPath, { readOnly: true })).toThrow(GraphRebuildRequiredError);
  });
});

function readSchemaVersionOf(path: string): number | null {
  const db = openSqlite(path, { readOnly: true });
  try {
    return readSchemaVersion(db);
  } finally {
    db.close();
  }
}
