// Category 3 — task-scope quality.
//
// Two gates on `graph scope`, the command an agent actually opens a task with.
// Both are black-box: they read the JSONL an agent would read, and neither
// imports MEX internals.
//
// **Why these two.** Measured on a large TypeScript index, the first fact
// returned for a realistic task was a single-word local declared inside a spec
// file 8 times in 10, every one of them scoring exactly 1.0 — because an exact
// match on one word of the task was worth more than a good match on the whole of
// it. And `--max-nodes` did nothing above eleven, whatever the caller asked for,
// because the per-category quotas were a fixed 5/4/2 consulted before it. The
// second is the more expensive defect of the two: the response says
// `truncated: true` and reports how many nodes it withheld, so an agent that
// reads the signal and retries with a bigger number pays twice for one answer.
//
// The tasks are ordinary prose about THIS repo, so the gates run for anyone who
// clones it with no external checkout.

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseJsonl, runCli, REPO_ROOT } from "./lib/run-cli.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));

/**
 * Test-file paths, by the conventions the graph itself classifies on. Restated
 * here rather than imported: this harness is black-box on purpose, and a gate
 * that shares its definition of "test file" with the code under test would pass
 * whenever the two drifted together.
 */
const TEST_PATH = /(^|\/)(__tests__|__test__|tests?|spec)\/|\.(test|spec)\.|(^|\/)test_[^/]*$|_test\.[^/.]+$/;

/** A generous ceiling, so these gates measure the node limit and not the budget. */
const HEADROOM_TOKENS = "20000";

function scopeFacts(root, query, maxNodes, maxOutputTokens) {
  const args = ["graph", "scope", query, "--max-nodes", String(maxNodes)];
  if (maxOutputTokens) args.push("--max-output-tokens", maxOutputTokens);
  const records = parseJsonl(runCli(args, root).stdout);
  return {
    facts: records.filter((record) => record.type === "fact"),
    summary: records.find((record) => record.type === "summary"),
  };
}

/**
 * Top-1 quality: is the FIRST fact a declaration from real source, or a local
 * from a test file? Only the first is scored — it is the one an agent reads
 * before deciding whether the graph is worth another call.
 */
export function runScopeTop(root = REPO_ROOT) {
  const cases = JSON.parse(readFileSync(join(HERE, "fixtures", "scope-tasks.json"), "utf-8"));
  return cases.map((testCase) => {
    const { facts } = scopeFacts(root, testCase.query, 30);
    const top = facts[0];
    return {
      id: testCase.id,
      query: testCase.query,
      facts: facts.length,
      top: top?.name ?? null,
      topPath: top?.filePath ?? null,
      topScore: top?.score ?? null,
      topIsTest: top ? TEST_PATH.test(top.filePath) : true,
    };
  });
}

/**
 * Limit responsiveness: asking for N returns N, whenever the pool and the token
 * budget both allow it.
 *
 * Stated as an equality rather than as "more than a smaller request", and that
 * is the whole difference between a gate that bites and one that does not. Under
 * the old fixed quota the counts still ROSE — 5, then 10, then 11 — because the
 * ceiling those quotas summed to was above five. They simply stopped rising at
 * eleven, forever, which is what an agent pays for when it reads
 * `truncated: true` and retries with a bigger number.
 *
 * `pool >= 30` is part of the condition on purpose: if these tasks ever stop
 * matching enough nodes for the request to be satisfiable, the fixture has
 * drifted and the gate should say so rather than pass vacuously.
 */
export function runScopeLimit(root = REPO_ROOT) {
  const cases = JSON.parse(readFileSync(join(HERE, "fixtures", "scope-limit.json"), "utf-8"));
  const asked = [5, 10, 30];
  return cases.map((testCase) => {
    const runs = asked.map((n) => scopeFacts(root, testCase.query, n, HEADROOM_TOKENS));
    const returned = runs.map((run) => run.facts.length);
    const pool = runs.at(-1).summary?.matchedNodes ?? 0;
    return {
      id: testCase.id,
      query: testCase.query,
      pool,
      atFive: returned[0],
      atTen: returned[1],
      atThirty: returned[2],
      responsive: pool >= 30 && asked.every((n, i) => returned[i] === n),
    };
  });
}

export function runScopeQuality({ root = REPO_ROOT, outDir = join(HERE, "results") } = {}) {
  const topRows = runScopeTop(root);
  const limitRows = runScopeLimit(root);

  const summary = {
    scopeTopSourceRate: Number((topRows.filter((r) => !r.topIsTest).length / topRows.length).toFixed(3)),
    scopeLimitResponseRate: Number((limitRows.filter((r) => r.responsive).length / limitRows.length).toFixed(3)),
  };

  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "scope-quality.json"), JSON.stringify({ summary, topRows, limitRows }, null, 2));
  const header = "id,query,facts,top,topPath,topScore,topIsTest";
  const csv = [header, ...topRows.map((r) =>
    [r.id, r.query, r.facts, r.top, r.topPath, r.topScore, r.topIsTest].join(","),
  )].join("\n");
  writeFileSync(join(outDir, "scope-quality.csv"), csv + "\n");

  return { summary, topRows, limitRows };
}
