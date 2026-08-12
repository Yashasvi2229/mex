import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { findChangedSourceFiles } from "../runtime.js";
import cases from "./fixtures/symbol-lookup-cases.json" with { type: "json" };

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  "fixtures",
  "sample.rs",
);

let root: string;
let engine: GraphEngine;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "mex-rust-graph-"));
  cpSync(FIXTURE, join(root, "sample.rs"));
  engine = createGraphEngine({ rootDir: root });
  await engine.build(root);
});

afterAll(() => {
  engine.close();
  rmSync(root, { recursive: true, force: true });
});

describe("Rust graph discovery", () => {
  it("indexes Rust files during a full graph build", () => {
    expect(engine.searchNodes("User").some((node) => (
      node.name === "User" && node.language === "rust"
    ))).toBe(true);
    expect(engine.searchNodes("create_user").some((node) => (
      node.name === "create_user" && node.language === "rust"
    ))).toBe(true);
  });

  // The Rust half of the shared symbol-lookup control (see
  // `store-search.test.ts`). `Order` is the interesting one: its own fields and
  // methods carry `Order` in their qualified names, and used to outrank it.
  it.each(cases.filter((testCase) => testCase.corpus === "rust"))(
    "$id: $query returns $expect.name first",
    (testCase) => {
      const results = engine.searchNodes(testCase.query, { limit: 20 });
      const rank =
        results.findIndex(
          (node) =>
            node.name === testCase.expect.name &&
            (testCase.expect.kind === undefined || node.kind === testCase.expect.kind),
        ) + 1;
      expect(rank, `${testCase.expect.name} not found for "${testCase.query}"`).toBeGreaterThan(0);
      expect(rank).toBeLessThanOrEqual(testCase.maxRank);
    },
  );

  it("includes new Rust files in incremental change discovery", () => {
    writeFileSync(join(root, "added.rs"), "pub fn added() {}\n");
    const db = openSqlite(join(root, ".mex", "graph.db"));
    try {
      expect(findChangedSourceFiles(root, db)).toContain("added.rs");
    } finally {
      db.close();
    }
  });
});
