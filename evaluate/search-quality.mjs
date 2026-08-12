// Category 2 — search quality.
//
// Black-box smoke test for `graph query`, independent of source payload. The
// committed gates are `where-defined` foundRate (deterministic, needs no
// hand-labeling) and symbol-lookup top rate. who-calls / what-calls fan-out is
// reported for visibility; labeled recall/MRR sets are a documented follow-up.
//
// **Symbol lookup is measured through `graph scope`, not `graph query`, and the
// reason is the whole point of the second fixture.** `resolveSymbol` filters
// `where-defined` results down to exact name matches before anything is
// printed, so that command reports rank 1 whether the ranking put the symbol
// first or seventh — it cannot observe a ranking defect at all. That blind spot
// is why `whereDefinedFoundRate` stayed at 1.0 through a measured 5-in-10
// exact-name failure. `graph scope` orders the facts it returns, so it can.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, runCli, REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

export function runSearchQuality({ root = REPO_ROOT, outDir = join(HERE, "results") } = {}) {
  const tasks = JSON.parse(readFileSync(join(HERE, "fixtures", "symbol-tasks.json"), "utf-8"));

  const rows = tasks.map((task) => {
    const expected = task.expected[0];
    const wd = parseJsonl(runCli(["graph", "query", "where-defined", task.query], root).stdout);
    const results = wd.filter((r) => r.type === "result");
    const rank = results.findIndex((r) => r.name === expected || String(r.qualifiedName ?? "").includes(expected));
    const whoCalls = parseJsonl(runCli(["graph", "query", "who-calls", task.query], root).stdout).filter((r) => r.type === "result").length;
    const whatCalls = parseJsonl(runCli(["graph", "query", "what-calls", task.query], root).stdout).filter((r) => r.type === "result").length;
    return {
      id: task.id,
      query: task.query,
      whereDefinedResults: results.length,
      found: rank >= 0,
      rank: rank >= 0 ? rank + 1 : null,
      whoCallsCount: whoCalls,
      whatCallsCount: whatCalls,
    };
  });

  const lookupRows = runSymbolLookup(root);
  const fragmentRows = runFragmentLookup(root);
  const foundRate = Number((rows.filter((r) => r.found).length / rows.length).toFixed(3));
  const topRate = Number(
    (lookupRows.filter((r) => r.rank === 1).length / lookupRows.length).toFixed(3),
  );
  const fragmentRate = Number(
    (fragmentRows.filter((r) => r.fileFacts === 0).length / fragmentRows.length).toFixed(3),
  );
  const summary = {
    foundRate,
    symbolLookupTopRate: topRate,
    fragmentSymbolRate: fragmentRate,
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(
    join(outDir, "search-quality.json"),
    JSON.stringify({ summary, rows, symbolLookup: lookupRows, fragmentLookup: fragmentRows }, null, 2),
  );
  const header = "id,query,whereDefinedResults,found,rank,whoCallsCount,whatCallsCount";
  const csv = [header, ...rows.map((r) =>
    [r.id, r.query, r.whereDefinedResults, r.found, r.rank ?? "", r.whoCallsCount, r.whatCallsCount].join(","),
  )].join("\n");
  writeFileSync(join(outDir, "search-quality.csv"), csv + "\n");

  return { summary, rows, symbolLookup: lookupRows, fragmentLookup: fragmentRows };
}

/**
 * Symbol lookup: ask `graph scope` for a symbol by its own name and check that
 * the symbol is the first fact returned. `rank` is its position among the
 * facts, or null when it is missing entirely.
 */
export function runSymbolLookup(root = REPO_ROOT) {
  const cases = JSON.parse(readFileSync(join(HERE, "fixtures", "symbol-lookup.json"), "utf-8"));
  return cases.map((testCase) => {
    const facts = parseJsonl(runCli(["graph", "scope", testCase.query], root).stdout)
      .filter((record) => record.type === "fact");
    const index = facts.findIndex((fact) => fact.name === testCase.expect);
    return {
      id: testCase.id,
      query: testCase.query,
      expect: testCase.expect,
      facts: facts.length,
      rank: index >= 0 ? index + 1 : null,
      top: facts[0]?.name ?? null,
    };
  });
}

/**
 * Fragment lookup: a query that is part of a name rather than a whole one, so
 * nothing short-circuits to an exact match and the ranking itself decides the
 * order. Counts `file:` facts among the leading results — a file node's name is
 * the path basename, which matches a name fragment strongly and tells an agent
 * nothing, so a fragment query used to spend most of its slots on files.
 */
export function runFragmentLookup(root = REPO_ROOT) {
  const cases = JSON.parse(readFileSync(join(HERE, "fixtures", "fragment-lookup.json"), "utf-8"));
  const HEAD = 5;
  return cases.map((testCase) => {
    const facts = parseJsonl(runCli(["graph", "scope", testCase.query], root).stdout)
      .filter((record) => record.type === "fact");
    const head = facts.slice(0, HEAD);
    return {
      id: testCase.id,
      query: testCase.query,
      facts: facts.length,
      fileFacts: head.filter((fact) => fact.kind === "file").length,
      top: head[0]?.name ?? null,
    };
  });
}
