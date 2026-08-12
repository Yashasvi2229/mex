import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { parseStructuredAnswer } from "../lib/answer.mjs";
import { validateTranscriptPolicy } from "../lib/policy.mjs";
import { prepareEvaluation } from "../lib/prepare.mjs";
import { pairedDeltas } from "../lib/report.mjs";
import { runEvaluation, runSession } from "../lib/runner.mjs";
import { buildSchedule, SIX_ARM_ORDERS } from "../lib/schedule.mjs";
import { parseTranscript } from "../lib/transcript.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const FAKE = join(HERE, "fixtures", "fake-claude.mjs");
const ARMS = { grep: { kind: "grep" }, baseline: { kind: "graph", vocabRetry: false }, patched: { kind: "graph", vocabRetry: true } };
const COMMANDS = { baseline: ["node", "/tmp/baseline.js"], patched: ["node", "/tmp/patched.js"] };

test("six tasks use all six arm permutations exactly once", () => {
  const tasks = Array.from({ length: 6 }, (_, index) => ({ id: `t${index}` }));
  const schedule = buildSchedule(tasks, Object.keys(ARMS));
  const orders = tasks.map((_, index) => schedule.slice(index * 3, index * 3 + 3).map((row) => Object.keys(ARMS).indexOf(row.armId)));
  assert.deepEqual(orders, SIX_ARM_ORDERS);
});

test("stream JSON accounting sums assistant usage and deduplicates tool payloads", () => {
  const assistant = (usage) => JSON.stringify({ type: "assistant", message: { usage, content: [] } });
  const tool = JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "x", content: "same" }] } });
  const result = JSON.stringify({ type: "result", structured_output: { answer: "S", symbols: ["S"], evidence: [{ path: "a", line: 1 }], complete: true }, total_cost_usd: 0.25, num_turns: 2 });
  const parsed = parseTranscript([assistant({ input_tokens: 1, cache_creation_input_tokens: 2, cache_read_input_tokens: 3, output_tokens: 4 }), tool, assistant({ input_tokens: 5, output_tokens: 6 }), tool, result].join("\n"));
  assert.deepEqual(parsed.usage, { uncachedInput: 6, cacheCreation: 2, cacheRead: 3, output: 10, processed: 21 });
  assert.equal(parsed.uniqueToolResultChars, 4);
  assert.equal(parsed.costUsd, 0.25);
});

test("structured answers reject malformed evidence", () => {
  assert.equal(parseStructuredAnswer('{"answer":"x","symbols":[],"evidence":[],"complete":true}').ok, true);
  assert.equal(parseStructuredAnswer('{"answer":"x","symbols":[],"evidence":[{"path":"a","line":0}],"complete":true}').ok, false);
});

test("policy rejects shell operators, SQLite, cross-arm binaries, and missing scope", () => {
  const bash = (command) => ({ name: "Bash", input: { command } });
  assert.match(validateTranscriptPolicy([bash('node /tmp/patched.js graph scope x && rg y')], "patched", ARMS.patched, COMMANDS).join("\n"), /control operator/);
  assert.match(validateTranscriptPolicy([{ name: "Read", input: { file_path: ".mex/graph.db" } }], "grep", ARMS.grep, COMMANDS).join("\n"), /SQLite/);
  assert.match(validateTranscriptPolicy([bash('node /tmp/baseline.js graph scope x')], "patched", ARMS.patched, COMMANDS).join("\n"), /cross-arm/);
  assert.match(validateTranscriptPolicy([{ name: "Read", input: { file_path: "src/a.ts" } }], "patched", ARMS.patched, COMMANDS).join("\n"), /did not start/);
});

test("paired deltas are matched within each task", () => {
  const row = (taskId, arm, processed) => ({ taskId, arm, metrics: { processed, costUsd: 0, uniqueToolResultChars: 0, uniqueToolResultTokens: 0, elapsedMs: 0, turns: 0, toolCalls: 0, graphCalls: 0, vocabularyRetries: 0, fallbacks: 0 } });
  const pairs = pairedDeltas([row("a", "grep", 10), row("a", "baseline", 7), row("b", "grep", 100), row("b", "baseline", 90)], ["grep", "baseline"]);
  assert.deepEqual(pairs[0].perTask.map((entry) => entry.processed), [-3, -10]);
  assert.equal(pairs[0].mean.processed, -6.5);
});

test("fake agent exercises success, failure, and timeout without model usage", { concurrency: false }, async () => {
  const task = { id: "fake", question: "Where?", expectedSymbols: ["FakeSymbol"] };
  const original = process.env.FAKE_CLAUDE_MODE;
  try {
    process.env.FAKE_CLAUDE_MODE = "ok";
    const success = await runSession({ agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task, armId: "patched", arm: ARMS.patched, armCommands: COMMANDS, timeoutMs: 2_000 });
    assert.equal(success.valid, true); assert.equal(success.metrics.processed, 50); assert.equal(success.grade.correct, true);
    process.env.FAKE_CLAUDE_MODE = "failure";
    const failure = await runSession({ agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task, armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 2_000 });
    assert.equal(failure.valid, false); assert.match(failure.violations.join("\n"), /exited 7/);
    process.env.FAKE_CLAUDE_MODE = "timeout";
    const timeout = await runSession({ agentCommand: [process.execPath, FAKE], subjectRoot: tmpdir(), model: "fake", task, armId: "grep", arm: ARMS.grep, armCommands: COMMANDS, timeoutMs: 30 });
    assert.equal(timeout.process.timedOut, true);
  } finally {
    if (original === undefined) delete process.env.FAKE_CLAUDE_MODE; else process.env.FAKE_CLAUDE_MODE = original;
  }
});

test("resume skips completed run IDs", { concurrency: false }, async () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compare-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-compare-output-"));
  mkdirSync(join(root, ".mex"), { recursive: true });
  const indices = {};
  for (const armId of ["baseline", "patched"]) {
    const path = join(output, `${armId}.db`); writeFileSync(path, `fake-${armId}`); indices[armId] = { path };
  }
  writeFileSync(join(output, "prepare.json"), JSON.stringify({ indices }));
  const suite = { id: "fake", arms: ARMS, tasks: [{ id: "task", question: "Where?", expectedSymbols: ["FakeSymbol"] }] };
  const first = await runEvaluation({ suite, subjectRoot: root, outputDir: output, armCommands: COMMANDS, model: "fake", timeoutMs: 2_000, agentCommand: [process.execPath, FAKE] });
  assert.equal(first.rows.length, 3);
  process.env.FAKE_CLAUDE_MODE = "failure";
  try {
    const resumed = await runEvaluation({ suite, subjectRoot: root, outputDir: output, armCommands: COMMANDS, model: "fake", timeoutMs: 2_000, resume: true, agentCommand: [process.execPath, FAKE] });
    assert.equal(resumed.rows.every((row) => row.valid), true);
  } finally { delete process.env.FAKE_CLAUDE_MODE; }
});

test("prepare verifies gold evidence, snapshots both graph indices, and restores the subject graph", () => {
  const root = mkdtempSync(join(tmpdir(), "mex-compare-prepare-root-"));
  const output = mkdtempSync(join(tmpdir(), "mex-compare-prepare-output-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex"), { recursive: true });
  writeFileSync(join(root, "src", "fake.ts"), "export function FakeSymbol() {}\n");
  writeFileSync(join(root, ".mex", "graph.db"), "original");
  for (const args of [["init", "-q"], ["config", "user.email", "eval@example.invalid"], ["config", "user.name", "Eval Test"], ["add", "src/fake.ts"], ["commit", "-qm", "fixture"]]) {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
  const graphCli = join(output, "fake-graph.mjs");
  writeFileSync(graphCli, 'import { mkdirSync, writeFileSync } from "node:fs"; mkdirSync(".mex", { recursive: true }); writeFileSync(".mex/graph.db", process.argv[2]); console.log("{}");\n');
  const suite = { id: "prepare", subject: { name: "fixture" }, arms: ARMS, tasks: [{ id: "task", question: "Where?", expectedSymbols: ["FakeSymbol"] }] };
  const armCommands = { baseline: [process.execPath, graphCli, "baseline"], patched: [process.execPath, graphCli, "patched"] };
  const harnessRoot = resolve(HERE, "..", "..", "..");
  const manifest = prepareEvaluation({ suite, subjectRoot: root, harnessRoot, armCommands, outputDir: output });
  assert.equal(readFileSync(join(root, ".mex", "graph.db"), "utf8"), "original");
  assert.equal(readFileSync(manifest.indices.baseline.path, "utf8"), "baseline");
  assert.equal(readFileSync(manifest.indices.patched.path, "utf8"), "patched");
  assert.equal(manifest.goldEvidence[0].symbols[0].path, "src/fake.ts");
  assert.equal(manifest.goldEvidence[0].symbols[0].line, 1);
});
