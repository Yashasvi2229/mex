import assert from "node:assert/strict";
import test from "node:test";
import { claudeAdapter } from "../../adapters/agents/claude.mjs";
import { codexAdapter } from "../../adapters/agents/codex.mjs";
import { ANSWER_SCHEMA } from "../../compare/lib/answer.mjs";

const task = {
  id: "target",
  gold: [{ symbol: "TargetSymbol", kind: "function", path: "src/subject.ts" }],
  expectedSymbols: ["TargetSymbol"],
};
const answer = { answer: "TargetSymbol implements it.", symbols: ["TargetSymbol"], evidence: [{ path: "src/subject.ts", line: 1 }], complete: true };
const fact = '{"type":"fact","name":"TargetSymbol","kind":"function","filePath":"src/subject.ts"}\n';

test("Claude adapter keeps cache composition and computes new-token work", () => {
  const raw = [
    { type: "assistant", message: { usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: 'node mex.js graph scope "question"' } }] } },
    { type: "user", message: { content: [{ type: "tool_result", tool_use_id: "t1", content: fact }] } },
    { type: "result", structured_output: answer, total_cost_usd: 0.25, num_turns: 1, permission_denials: [] },
  ].map(JSON.stringify).join("\n");
  const parsed = claudeAdapter.parseTranscript(raw, task);
  assert.deepEqual({
    uncachedInput: parsed.usage.uncachedInput,
    cacheWrite: parsed.usage.cacheWrite,
    cacheRead: parsed.usage.cacheRead,
    output: parsed.usage.output,
    reportedTotal: parsed.usage.reportedTotal,
    newTokens: parsed.usage.newTokens,
  }, { uncachedInput: 11, cacheWrite: 12, cacheRead: 13, output: 14, reportedTotal: 50, newTokens: 37 });
  assert.equal(parsed.graph.initialScopeRank, 1);
  assert.equal(parsed.structured.ok, true);
});

test("Codex adapter subtracts cached input while preserving the raw usage event", () => {
  const raw = [
    { type: "thread.started", thread_id: "fake" },
    { type: "turn.started" },
    { type: "item.started", item: { id: "c1", type: "command_execution", command: 'node mex.js graph scope "question"', status: "in_progress" } },
    { type: "item.completed", item: { id: "c1", type: "command_execution", command: 'node mex.js graph scope "question"', aggregated_output: fact, exit_code: 0, status: "completed" } },
    { type: "item.completed", item: { id: "a1", type: "agent_message", text: JSON.stringify(answer) } },
    { type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 60, output_tokens: 10, reasoning_output_tokens: 4 } },
  ].map(JSON.stringify).join("\n");
  const parsed = codexAdapter.parseTranscript(raw, task);
  assert.deepEqual({
    uncachedInput: parsed.usage.uncachedInput,
    cacheWrite: parsed.usage.cacheWrite,
    cacheRead: parsed.usage.cacheRead,
    output: parsed.usage.output,
    reportedInput: parsed.usage.reportedInput,
    reportedTotal: parsed.usage.reportedTotal,
    newTokens: parsed.usage.newTokens,
  }, { uncachedInput: 40, cacheWrite: null, cacheRead: 60, output: 10, reportedInput: 100, reportedTotal: 110, newTokens: 50 });
  assert.equal(parsed.usage.raw[0].reasoning_output_tokens, 4);
  assert.equal(parsed.graph.initialScopeRank, 1);
});

test("headless invocations are ephemeral and use local CLI authentication paths", () => {
  const claude = claudeAdapter.buildInvocation({ prompt: "p", model: "m", schema: ANSWER_SCHEMA, subjectRoot: "/repo" });
  assert.equal(claude.command, "claude");
  assert.equal(claude.args.includes("--no-session-persistence"), true);
  const codex = codexAdapter.buildInvocation({ prompt: "p", model: "m", schemaPath: "/tmp/schema.json", subjectRoot: "/repo" });
  assert.equal(codex.command, "codex");
  assert.equal(codex.args.slice(0, 2).join(" "), "exec --ephemeral");
  assert.equal(codex.args.includes("--json"), true);
  assert.equal(codex.args.includes("--output-schema"), true);
});
