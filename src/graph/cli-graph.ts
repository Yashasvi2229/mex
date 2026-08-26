// ============================================================================
// mex code-graph — `mex graph` command  (A6)
// ============================================================================
//
// Build/rebuild the code graph into `.mex/graph.db`. Deterministic (tree-sitter
// → SQLite, zero LLM). Runs in `mex setup` for fresh installs and on demand.
// Kept self-contained so `src/cli.ts` wires it with a single lazy import (like
// every other command), never disturbing the existing surface.

import { createGraphEngine } from "./index.js";

export interface GraphCommandOptions {
  /** Project root to index (defaults to cwd). */
  root?: string;
  /** Emit the build summary as JSON. */
  json?: boolean;
}

/**
 * Run `mex graph`: build the whole graph and print a one-line (or JSON) summary.
 * Degrades loudly on failure (a clear message + non-zero exit) rather than
 * leaving a half-written DB — the caller (`cli.ts`) maps a throw to `exit(1)`.
 */
export async function runGraph(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const engine = createGraphEngine({ rootDir });
  try {
    const result = await engine.build(rootDir);
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      console.log(
        `Code graph built: ${result.nodesCreated} nodes, ${result.edgesCreated} edges ` +
          `across ${result.filesIndexed} files in ${result.durationMs}ms → .mex/graph.db`,
      );
    }
  } finally {
    engine.close();
  }
}

/**
 * Run `mex graph repair`: checkpoint any stranded WAL and verify store
 * integrity — WITHOUT rebuilding. A killed writer (e.g. an interrupted check
 * or build) can leave a large uncheckpointed WAL that read-only consumers then
 * refuse to open; the WAL itself is not corrupt, so a clean writer-open plus
 * `wal_checkpoint(TRUNCATE)` recovers the store in seconds (issue #140 obs 3).
 * Deliberately avoids `openGraphDatabase`: repair must work on stores that
 * schema/rebuild gating would refuse.
 */
export async function runGraphRepair(root?: string): Promise<number> {
  const { existsSync, statSync } = await import("node:fs");
  const { resolve } = await import("node:path");
  const { openSqlite } = await import("./db/sqlite.js");
  const dbPath = resolve(root ?? process.cwd(), ".mex", "graph.db");
  if (!existsSync(dbPath)) {
    console.error(`No graph store at ${dbPath}. Run \`mex graph\` to build one.`);
    return 1;
  }
  const walPath = `${dbPath}-wal`;
  const walBefore = existsSync(walPath) ? statSync(walPath).size : 0;
  const db = openSqlite(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.pragma("wal_checkpoint(TRUNCATE)");
    const rows = db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>;
    const verdict = rows.map((row) => row.integrity_check).join("; ") || "ok";
    const walAfter = existsSync(walPath) ? statSync(walPath).size : 0;
    const checkpointed = walBefore > walAfter
      ? `checkpointed ${((walBefore - walAfter) / 1048576).toFixed(1)} MB of WAL`
      : "no WAL data pending";
    if (verdict === "ok") {
      console.log(`Graph store healthy: ${checkpointed}; integrity ok. No rebuild needed.`);
      return 0;
    }
    console.error(`Graph store integrity check failed: ${verdict}. Run \`mex graph\` to rebuild.`);
    return 1;
  } finally {
    db.close();
  }
}
