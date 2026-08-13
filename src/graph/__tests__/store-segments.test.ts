// ============================================================================
// mex code-graph — segmented, stemmed index tests  (schema v2)
// ============================================================================
//
// Every case here is a claim about what the INDEX can answer, measured on a
// real index built from the checked-in fixtures. The first two fail against the
// pre-v2 schema: they ask for a word sitting inside a camelCase name, which a
// five-column, non-stemming `nodes_fts` holds no token for.
//
// The rest are the properties a schema change has to keep: an index written
// under the old shape is detected and rebuilt at open, the rebuild moves no
// node's identity, and the same query still returns the same rows.

import { cpSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGraphEngine } from "../index.js";
import { CURRENT_SCHEMA_VERSION, openGraphDatabase, readSchemaVersion } from "../db/database.js";
import { openSqlite } from "../db/sqlite.js";
import { segmentsFor, splitIdentifier } from "../search/segments.js";
import type { GraphEngine } from "../engine.js";

const FIXTURES = join(dirname(fileURLToPath(import.meta.url)), "fixtures");

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-segments-"));
  mkdirSync(join(root, "payments"), { recursive: true });
  cpSync(join(FIXTURES, "payments"), join(root, "payments"), { recursive: true });
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
}, 60_000);

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

const names = (query: string, limit = 20): string[] =>
  engine.searchNodes(query, { limit }).map((node) => node.name);

describe("identifier segments", () => {
  it("splits camelCase, acronyms and snake_case into the words a person would type", () => {
    expect(splitIdentifier("formatMoney")).toEqual(["format", "money"]);
    expect(splitIdentifier("HTTPServer")).toEqual(["http", "server"]);
    expect(splitIdentifier("get_user_by_id")).toEqual(["get", "user", "by", "id"]);
    expect(splitIdentifier("base64Encode")).toEqual(["base64", "encode"]);
  });

  it("drops the segment that is the whole name, so a one-word name is not indexed twice", () => {
    expect(segmentsFor("resolve")).toBe("");
    expect(segmentsFor("formatMoney")).toBe("format money");
  });
});

describe("a word inside a name is retrievable", () => {
  it("finds formatMoney by the second half of its name", () => {
    // Fails on the pre-v2 index: `formatMoney` is one token there, `money*`
    // cannot prefix-match it, and `moneyFormatDefaults` satisfies the term so
    // the substring tier never runs.
    expect(names("money")).toContain("formatMoney");
  });

  it("still ranks the whole name first when the whole name is queried", () => {
    // The segment column is what makes `money` reach this node; the `name`
    // column at nearly seven times the weight is what keeps the compound
    // winning its own lookup. Segment reachability must not cost exact lookup.
    expect(names("formatMoney")[0]).toBe("formatMoney");
  });

  it("finds a mid-name term even when another candidate carries it as a prefix", () => {
    // The shape that made a real symbol unreachable at any fetch depth: FTS
    // prefix-matches, so `migration*` cannot reach the token `runmigrations`,
    // and the substring tier never fires because `migrationTemplate` carries
    // the term as a prefix and satisfies it.
    expect(names("migration")).toContain("runMigrations");
  });

  it("matches across an inflection, because both sides go through one stemmer", () => {
    expect(names("migrating")).toContain("runMigrations");
    expect(names("migrating")).toContain("migrationTemplate");
  });
});

describe("an index written under the old schema", () => {
  /** The v1 shape, written out so the migration can be tested against it. */
  function writeLegacyIndex(dbPath: string): void {
    const db = openSqlite(dbPath);
    db.exec(`
      CREATE TABLE schema_versions (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL, description TEXT);
      INSERT INTO schema_versions VALUES (1, 0, 'legacy');
      CREATE TABLE nodes (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT NOT NULL,
        file_path TEXT NOT NULL, language TEXT NOT NULL, start_line INTEGER NOT NULL, end_line INTEGER NOT NULL,
        start_column INTEGER NOT NULL, end_column INTEGER NOT NULL, docstring TEXT, signature TEXT,
        visibility TEXT, is_exported INTEGER DEFAULT 0, is_async INTEGER DEFAULT 0, is_static INTEGER DEFAULT 0,
        is_abstract INTEGER DEFAULT 0, decorators TEXT, type_parameters TEXT, return_type TEXT,
        body_hash TEXT, updated_at INTEGER NOT NULL
      );
      CREATE VIRTUAL TABLE nodes_fts USING fts5(
        id, name, qualified_name, docstring, signature, content='nodes', content_rowid='rowid'
      );
      INSERT INTO nodes (id, kind, name, qualified_name, file_path, language,
        start_line, end_line, start_column, end_column, body_hash, updated_at)
      VALUES ('function:legacy', 'function', 'formatMoney', 'formatMoney', 'a.ts', 'typescript', 1, 2, 0, 0, 'hash-a', 1);
      INSERT INTO nodes_fts(rowid, id, name, qualified_name, docstring, signature)
        SELECT rowid, id, name, qualified_name, docstring, signature FROM nodes;
    `);
    db.close();
  }

  it("is detected on its shape and rebuilt, keeping every node's identity", () => {
    const dir = mkdtempSync(join(tmpdir(), "mex-legacy-"));
    const dbPath = join(dir, "graph.db");
    try {
      writeLegacyIndex(dbPath);

      const before = openSqlite(dbPath);
      const legacyDdl = (before.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'").get() as { sql: string }).sql;
      const legacyRow = before.prepare("SELECT id, body_hash FROM nodes").get() as { id: string; body_hash: string };
      // The index is FULLY POPULATED and still cannot answer the question —
      // which is why the detector has to look at the shape, not the row count.
      const legacyDocs = (before.prepare("SELECT count(*) AS c FROM nodes_fts_docsize").get() as { c: number }).c;
      expect(legacyDdl).not.toContain("segments");
      expect(legacyDocs).toBe(1);
      before.close();

      const db = openGraphDatabase(dbPath);
      const ddl = (db.prepare("SELECT sql FROM sqlite_master WHERE name = 'nodes_fts'").get() as { sql: string }).sql;
      expect(ddl).toContain("segments");
      expect(ddl).toContain("porter unicode61");
      expect(readSchemaVersion(db)).toBe(CURRENT_SCHEMA_VERSION);

      // The derived column is back-filled, so a migrated index answers the
      // question a re-indexed one would.
      const row = db.prepare("SELECT id, body_hash, segments FROM nodes").get() as {
        id: string; body_hash: string; segments: string;
      };
      expect(row.segments).toBe("format money");
      const hit = db
        .prepare("SELECT nodes.name AS name FROM nodes_fts JOIN nodes ON nodes.rowid = nodes_fts.rowid WHERE nodes_fts MATCH ?")
        .get('"money"*') as { name: string } | undefined;
      expect(hit?.name).toBe("formatMoney");

      // A derived column may not move node identity.
      expect(row.id).toBe(legacyRow.id);
      expect(row.body_hash).toBe(legacyRow.body_hash);
      db.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is left alone once current: reopening does not rewrite a healthy index", () => {
    const dbPath = join(root, ".mex", "graph.db");
    const first = openGraphDatabase(dbPath);
    const before = first.prepare("SELECT count(*) AS c FROM nodes_fts_docsize").get() as { c: number };
    first.close();
    const second = openGraphDatabase(dbPath);
    const after = second.prepare("SELECT count(*) AS c FROM nodes_fts_docsize").get() as { c: number };
    second.close();
    expect(after.c).toBe(before.c);
  });
});

describe("determinism", () => {
  it("returns identical results across a reopen of the same index", () => {
    const first = names("ledger migration runner", 30);
    const reopened = createGraphEngine({ rootDir: root });
    try {
      const second = reopened.searchNodes("ledger migration runner", { limit: 30 }).map((node) => node.name);
      expect(second).toEqual(first);
    } finally {
      reopened.close();
    }
  });
});
