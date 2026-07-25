import { cpSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../index.js";
import type { GraphEngine } from "../engine.js";
import { findChangedSourceFiles } from "../runtime.js";

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
