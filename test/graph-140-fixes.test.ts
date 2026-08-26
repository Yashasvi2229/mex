// Regression coverage for the issue #140 fix set:
//  1. a crashing TypeScript program (TS-internal assertion) must not abort the
//     whole graph build — affected files fall back to tree-sitter extraction;
//  2. `mex check` opens the graph read-only: no staging, no store writes, and
//     staleness is reported instead of silently rebuilt;
//  3. `mex graph repair` recovers a stranded WAL (killed writer) in place.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { MexConfig } from "../src/types.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { openSqlite } from "../src/graph/db/sqlite.js";
import { loadGroundingRuntime } from "../src/graph/runtime.js";
import { runGraphRepair } from "../src/graph/cli-graph.js";

const roots: string[] = [];

function fixture(prefix: string): { root: string; source: string; config: MexConfig; dbPath: string } {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  const source = join(root, "src", "checkout.ts");
  writeFileSync(source, `
export function calculateCheckoutTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const shipping = subtotal >= 100 ? 0 : 12;
  return subtotal + shipping;
}
`);
  return {
    root,
    source,
    config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] },
    dbPath: join(root, ".mex", "graph.db"),
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    try { rmSync(root, { recursive: true, force: true }); } catch { /* Windows file locks */ }
  }
});

describe("compiler program-crash isolation (#140 follow-up)", () => {
  it("completes the build via tree-sitter when every TS program creation asserts", async () => {
    const { root, dbPath } = fixture("mex-140-isolation-");
    const engine = createGraphEngine({
      rootDir: root,
      compilerExtraction: {
        programFactory: () => { throw new Error("Debug Failure. False expression."); },
      },
    });
    const result = await engine.build();
    engine.close();

    expect(result.filesIndexed).toBeGreaterThan(0);
    const db = openSqlite(dbPath, { readOnly: true });
    try {
      const row = db.prepare(
        "SELECT COUNT(*) AS n FROM nodes WHERE file_path = 'src/checkout.ts' AND kind = 'function'",
      ).get() as { n: number };
      // The function still exists in the graph — extracted by tree-sitter.
      expect(row.n).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  }, 30_000);
});

describe("read-only grounding runtime (#140 observation 2)", () => {
  it("never writes the store and reports staleness instead of staging", async () => {
    const { root, source, config, dbPath } = fixture("mex-140-readonly-");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();
    const before = createHash("sha256").update(readFileSync(dbPath)).digest("hex");

    const fresh = await loadGroundingRuntime(config, { readOnly: true });
    expect(fresh).not.toBeNull();
    expect(fresh!.staleSourceFiles).toBe(0);
    fresh!.close();

    writeFileSync(source, readFileSync(source, "utf-8").replace(": 12", ": 15"));
    const stale = await loadGroundingRuntime(config, { readOnly: true });
    expect(stale!.staleSourceFiles).toBe(1);
    stale!.close();

    const after = createHash("sha256").update(readFileSync(dbPath)).digest("hex");
    expect(after).toBe(before);
  }, 30_000);
});

describe("mex graph repair (#140 observation 3)", () => {
  it("checkpoints a stranded WAL from a killed writer without rebuilding", async () => {
    const { root, dbPath } = fixture("mex-140-repair-");
    const engine = createGraphEngine({ rootDir: root });
    await engine.build();
    engine.close();

    // Simulate a killed writer: a child process writes under WAL with
    // auto-checkpoint disabled and dies without closing the connection.
    const strand = spawnSync(process.execPath, ["-e", `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA wal_autocheckpoint = 0");
      db.prepare(
        "INSERT INTO project_metadata (key, value, updated_at) VALUES (?, ?, ?) " +
        "ON CONFLICT(key) DO UPDATE SET value = excluded.value"
      ).run("stranded_marker", "1", Date.now());
      process.kill(process.pid, "SIGKILL");
    `, dbPath], { encoding: "utf-8" });
    expect(strand.status).not.toBe(0);
    const walPath = `${dbPath}-wal`;
    expect(existsSync(walPath) && statSync(walPath).size > 0).toBe(true);

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    try {
      expect(await runGraphRepair(root)).toBe(0);
      expect(log.mock.calls.flat().join("\n")).toContain("integrity ok");
    } finally {
      log.mockRestore();
    }
    // The WAL is checkpointed and truncated; the write it held survived.
    expect(!existsSync(walPath) || statSync(walPath).size === 0).toBe(true);
    const db = openSqlite(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM project_metadata WHERE key = 'stranded_marker'").get() as
        | { value: string } | undefined;
      expect(row?.value).toBe("1");
    } finally {
      db.close();
    }
  }, 30_000);

  it("returns 1 when no graph store exists", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-140-norepair-"));
    roots.push(root);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      expect(await runGraphRepair(root)).toBe(1);
    } finally {
      error.mockRestore();
    }
  });
});
