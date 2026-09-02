import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { assertFts5Available, openGraphDatabase } from "../db/database.js";
import type { SqliteDatabase } from "../db/sqlite.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

/** Minimal SqliteDatabase fake: only `exec` is exercised by assertFts5Available. */
function fakeDb(execImpl: (sql: string) => void): SqliteDatabase {
  return {
    prepare: () => {
      throw new Error("not used by this test");
    },
    exec: execImpl,
    pragma: () => {},
    transaction: (fn) => fn(),
    close: () => {},
    open: true,
  };
}

describe("assertFts5Available", () => {
  it("does not throw when FTS5 statements succeed", () => {
    expect(() => assertFts5Available(fakeDb(() => {}))).not.toThrow();
  });

  it("raises an actionable, Node-version-specific message on the exact SQLite error from issue #110", () => {
    const db = fakeDb(() => {
      throw new Error("no such module: fts5");
    });

    expect(() => assertFts5Available(db)).toThrowError(
      new RegExp(`Node \\(${process.version.replace(/[.+]/g, "\\$&")}\\).*FTS5.*no such module: fts5`, "s"),
    );
  });

  it("re-throws an unrelated exec failure unchanged, rather than misattributing it to FTS5", () => {
    const db = fakeDb(() => {
      throw new Error("database is locked");
    });

    expect(() => assertFts5Available(db)).toThrowError("database is locked");
    expect(() => assertFts5Available(db)).not.toThrow(/FTS5/);
  });
});

describe("openGraphDatabase FTS5 preflight", () => {
  it("still opens normally on a machine whose SQLite build has FTS5 (the common case)", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-database-fts5-"));
    roots.push(root);

    const db = openGraphDatabase(join(root, "graph.db"));
    try {
      // exercised implicitly by openGraphDatabase not throwing; assert the FTS5
      // tables schema.sql defines actually exist, confirming the preflight probe
      // did not somehow prevent or corrupt the real schema application
      const tables = db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE '%_fts%'")
        .all() as Array<{ name: string }>;
      expect(tables.length).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });
});
