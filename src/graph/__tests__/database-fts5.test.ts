import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { assertFts5Available, openGraphDatabase } from "../db/database.js";
import type { SqliteDatabase } from "../db/sqlite.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.doUnmock("../db/sqlite.js");
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

/**
 * Load a fresh `database.js` whose `assertFts5Available` probes against
 * `fakeExec` instead of a real `:memory:` connection, by mocking the
 * `openSqlite` it imports from `sqlite.js`. `assertFts5Available` no longer
 * takes a `SqliteDatabase` parameter (PR #168 review: it must not touch the
 * caller's real graph database) — it opens its own throwaway connection
 * internally, so exercising the error paths now goes through this module
 * mock rather than an injected fake.
 */
async function assertFts5AvailableWith(fakeExec: (sql: string) => void) {
  vi.resetModules();
  vi.doMock("../db/sqlite.js", () => ({
    openSqlite: () => fakeDb(fakeExec),
  }));
  const fresh = await import("../db/database.js");
  return fresh.assertFts5Available;
}

describe("assertFts5Available", () => {
  it("does not throw when FTS5 statements succeed", () => {
    // node:sqlite is compiled with FTS5 in every environment these tests run
    // in (see sqlite.ts's module comment), so this exercises the real probe
    // against a real throwaway :memory: connection end to end.
    expect(() => assertFts5Available()).not.toThrow();
  });

  it("raises an actionable, Node-version-specific message on the exact SQLite error from issue #110", async () => {
    const probe = await assertFts5AvailableWith(() => {
      throw new Error("no such module: fts5");
    });

    expect(() => probe()).toThrowError(
      new RegExp(`Node \\(${process.version.replace(/[.+]/g, "\\$&")}\\).*FTS5.*no such module: fts5`, "s"),
    );
  });

  it("re-throws an unrelated exec failure unchanged, rather than misattributing it to FTS5", async () => {
    const probe = await assertFts5AvailableWith(() => {
      throw new Error("database is locked");
    });

    expect(() => probe()).toThrowError("database is locked");
    expect(() => probe()).not.toThrow(/FTS5/);
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

  it("closes the database handle when the FTS5 preflight fails, instead of leaking it open", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-database-fts5-close-"));
    roots.push(root);

    vi.resetModules();
    vi.doMock("../db/sqlite.js", async () => {
      const actual = await vi.importActual<typeof import("../db/sqlite.js")>("../db/sqlite.js");
      let realGraphDb: SqliteDatabase | undefined;
      return {
        ...actual,
        openSqlite: (path: string, options?: { readOnly?: boolean; immutable?: boolean }) => {
          if (path === ":memory:") {
            // The FTS5 preflight's own throwaway connection: fail it.
            return {
              prepare: () => {
                throw new Error("not used by this test");
              },
              exec: () => {
                throw new Error("no such module: fts5");
              },
              pragma: () => {},
              transaction: <T>(fn: () => T) => fn(),
              close: () => {},
              open: true,
            } satisfies SqliteDatabase;
          }
          realGraphDb = actual.openSqlite(path, options);
          return realGraphDb;
        },
        __getRealGraphDb: () => realGraphDb,
      };
    });

    const fresh = await import("../db/database.js");
    const sqliteMock = (await import("../db/sqlite.js")) as unknown as {
      __getRealGraphDb: () => SqliteDatabase | undefined;
    };

    expect(() => fresh.openGraphDatabase(join(root, "graph.db"))).toThrow(/FTS5/);
    expect(sqliteMock.__getRealGraphDb()?.open).toBe(false);
  });
});
