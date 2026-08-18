import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertGraphOutputIsolation } from "../../core/artifacts.mjs";
import { commandBundleIdentity } from "../../core/hash.mjs";
import { parseJsonLines, validateGraphResponse } from "../../core/jsonl.mjs";
import { gradeRetrieval, summarizeRetrievalRows } from "../../graders/retrieval.mjs";
import { loadGraphSuite, validateGraphSuite } from "../../schemas/graph-suite.mjs";
import { validateEvidenceInSource } from "../lib/fixture.mjs";
import { prepareGraphEvaluation } from "../lib/prepare.mjs";
import { generateGraphReport } from "../lib/report.mjs";
import { runGraphEvaluation } from "../lib/runner.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..", "..");
const FAKE = join(HERE, "fixtures", "fake-graph.mjs");

function rawSuite(tasks) {
  return {
    schemaVersion: 2,
    id: "fake-suite",
    subject: { name: "fake" },
    determinismRebuilds: 2,
    systems: { fake: { role: "candidate", command: [process.execPath, FAKE] } },
    tasks,
    gates: { floors: { budgetComplianceRate: 1 }, ceilings: { invalidRuns: 0 } },
  };
}

function positiveTask() {
  return {
    id: "target",
    category: "natural-language-symbol",
    operation: "scope",
    query: "Where is the target behavior?",
    gold: [{ symbol: "TargetSymbol", kind: "function", path: "src/subject.ts" }],
  };
}

function fixture() {
  const subjectRoot = mkdtempSync(join(tmpdir(), "mex-graph-subject-"));
  mkdirSync(join(subjectRoot, "src"), { recursive: true });
  writeFileSync(join(subjectRoot, "src", "subject.ts"), "export function TargetSymbol() {}\nexport function OtherSymbol() {}\n");
  const suitePath = join(subjectRoot, "suite.json");
  writeFileSync(suitePath, `${JSON.stringify(rawSuite([positiveTask()]), null, 2)}\n`);
  return { subjectRoot, suite: loadGraphSuite(suitePath), outputDir: mkdtempSync(join(tmpdir(), "mex-graph-output-")) };
}

test("suite schema rejects empty, duplicate, and underspecified task fixtures", () => {
  assert.throws(() => validateGraphSuite(rawSuite([])), /tasks must be non-empty/);
  const duplicate = rawSuite([positiveTask(), positiveTask()]);
  assert.throws(() => validateGraphSuite(duplicate), /duplicated/);
  const noGold = rawSuite([{ id: "bad", category: "scope", operation: "scope", query: "x", gold: [] }]);
  assert.throws(() => validateGraphSuite(noGold), /at least 1 evidence/);
});

test("graph outputs cannot place source artifacts in the indexed subject", () => {
  const root = resolve(tmpdir(), "subject");
  assert.throws(() => assertGraphOutputIsolation(root, join(root, "evaluate", "results", "run")), /not scanner-isolated/);
  assert.doesNotThrow(() => assertGraphOutputIsolation(root, join(root, ".mex", "eval-results", "run")));
  assert.doesNotThrow(() => assertGraphOutputIsolation(root, resolve(tmpdir(), "separate-output")));
});

test("CLI provenance recognizes PATH-resolved Node launchers", () => {
  const identity = commandBundleIdentity(["node", FAKE]);
  assert.equal(identity.entrypoint, FAKE);
  assert.match(identity.bundleSha256, /^[a-f0-9]{64}$/);
});

test("source evidence validation rejects stale, escaping, and ambiguous declarations", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-gold-"));
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export function Same() {}\nexport function Same() {}\n");
  assert.throws(() => validateEvidenceInSource(root, { symbol: "Missing", kind: "function", path: "src/a.ts" }), /was not found/);
  assert.throws(() => validateEvidenceInSource(root, { symbol: "Same", kind: "function", path: "src/a.ts" }), /ambiguous/);
  assert.throws(() => validateEvidenceInSource(root, { symbol: "Same", kind: "function", path: "../outside.ts" }), /escapes/);
});

test("retrieval grading requires exact symbol, kind, and path and keeps misses in MRR", () => {
  const task = {
    ...positiveTask(),
    gold: [
      { symbol: "TargetSymbol", kind: "function", path: "src/subject.ts" },
      { symbol: "SecondSymbol", kind: "class", path: "src/second.ts" },
    ],
  };
  const wrongSubstring = { type: "fact", name: "TargetSymbolHelper", kind: "function", filePath: "src/subject.ts" };
  const exact = { type: "fact", name: "TargetSymbol", kind: "function", filePath: "src/subject.ts" };
  const metrics = gradeRetrieval(task, [wrongSubstring, exact], { stdout: "x", elapsedMs: 1 });
  assert.equal(metrics.goldRanks[0].rank, 2);
  assert.equal(metrics.goldRanks[1].rank, null);
  assert.equal(metrics.completeEvidence, false);
  const rows = [
    { valid: true, task, metrics },
    { valid: true, task, metrics: { ...metrics, reciprocalRank: 0, goldRanks: metrics.goldRanks.map((entry) => ({ ...entry, rank: null })) } },
  ];
  assert.equal(summarizeRetrievalRows(rows).mrr, 0.25);
});

test("negative error codes are an allowlist, not a required response shape", () => {
  const task = {
    id: "negative",
    category: "negative",
    operation: "query",
    relation: "where-defined",
    query: "Missing",
    gold: [],
    expect: { noResult: true, errorCodes: ["TARGET_NOT_FOUND"] },
  };
  const notFound = gradeRetrieval(task, [{ type: "not-found", target: "Missing" }], { stdout: "", elapsedMs: 1 });
  assert.equal(notFound.errorExpectationMet, true);
  assert.equal(notFound.noResultCorrect, true);
  const allowedError = gradeRetrieval(task, [{ type: "error", code: "TARGET_NOT_FOUND" }], { stdout: "", elapsedMs: 1 });
  assert.equal(allowedError.noResultCorrect, true);
  const irrelevantFacts = gradeRetrieval(task, [{ type: "result", name: "Other", kind: "function", filePath: "src/other.ts" }], { stdout: "", elapsedMs: 1 });
  assert.equal(irrelevantFacts.noResultCorrect, false);
  const wrongError = gradeRetrieval(task, [{ type: "error", code: "INTERNAL_ERROR" }], { stdout: "", elapsedMs: 1 });
  assert.equal(wrongError.errorExpectationMet, false);
});

test("JSONL validation rejects malformed, empty, and structured-error success", () => {
  assert.match(parseJsonLines("not-json\n").errors.join("\n"), /malformed/);
  assert.match(parseJsonLines("").errors.join("\n"), /empty/);
  const records = [{ type: "meta", command: "graph scope" }, { type: "error", code: "BROKEN" }, { type: "summary" }];
  assert.match(validateGraphResponse(records, "graph scope").join("\n"), /error record/);
});

test("prepared runs capture graph loss and successful exact retrieval", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const commands = { fake: [process.execPath, FAKE] };
  const prepared = prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  assert.equal(prepared.systems.fake.deterministic, true);
  assert.equal(prepared.systems.fake.rebuilds[0].integrity.extractedToStoredLoss, 1);
  const result = await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
  assert.equal(result.rows[0].valid, true);
  assert.equal(result.rows[0].metrics.recallAt1, 1);
  const report = generateGraphReport({ suite, outputDir, suppliedRows: result.rows });
  assert.equal(report.gate.passed, true);
  assert.equal(readFileSync(join(outputDir, "raw", "queries", "001-target--fake.stdout.jsonl"), "utf8").includes("TargetSymbol"), true);
});

test("nonzero CLI exits are invalid and cannot become empty successful retrievals", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  const previous = process.env.FAKE_GRAPH_QUERY_MODE;
  process.env.FAKE_GRAPH_QUERY_MODE = "failure";
  try {
    const result = await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
    assert.equal(result.rows[0].valid, false);
    assert.match(result.rows[0].violations.join("\n"), /exited 7/);
  } finally {
    if (previous === undefined) delete process.env.FAKE_GRAPH_QUERY_MODE;
    else process.env.FAKE_GRAPH_QUERY_MODE = previous;
  }
});

test("resume rejects a changed run identity", { concurrency: false }, async () => {
  const { subjectRoot, suite, outputDir } = fixture();
  const commands = { fake: [process.execPath, FAKE] };
  prepareGraphEvaluation({ suite, subjectRoot, harnessRoot: HARNESS_ROOT, outputDir, systemCommands: commands });
  await runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 2_000 });
  await assert.rejects(
    runGraphEvaluation({ suite, subjectRoot, outputDir, systemCommands: commands, timeoutMs: 3_000, resume: true }),
    /run identity/,
  );
});
