#!/usr/bin/env node
/**
 * A stand-in for the agent, so the whole pipeline — argument shape, transcript parsing, policy
 * validation, grading, reporting, and the index guard — can be exercised without spending money
 * or waiting on a model. It emits a stream-json transcript in the real shape.
 *
 * Behaviour is chosen from FAKE_MODE:
 *   correct-graph   answers correctly after one graph scope call        (valid)
 *   correct-files   answers correctly after Grep + Read                 (valid)
 *   wrong           answers with the wrong symbol                       (valid, incorrect)
 *   violate-shell   runs a shell grep through Bash                      (INVALID)
 *   violate-sqlite  reads graph.db with sqlite3                         (INVALID)
 */
const args = process.argv.slice(2);
const at = (n) => args[args.indexOf(n) + 1];
const mode = process.env.FAKE_MODE ?? "correct-graph";
const tools = (at("--tools") ?? "").split(",").filter(Boolean);
const prompt = at("-p") ?? "";
const emit = (o) => process.stdout.write(JSON.stringify(o) + "\n");

// Pull the expected answer straight out of the prompt's question so the fake can be "right".
const ANSWERS = {
  "hammering the sign-in": { filePath: "packages/accounts/src/application/services/LoginRateLimiterService.ts", symbolName: "LoginRateLimiterService" },
};
const key = Object.keys(ANSWERS).find((k) => prompt.includes(k));
const right = ANSWERS[key] ?? { filePath: "x/y.ts", symbolName: "NOT_FOUND" };
const answer = mode === "wrong" ? { ...right, symbolName: "SomethingElse" } : right;

emit({ type: "system", subtype: "init", tools, mcp_servers: [] });

const scopePayload = [
  JSON.stringify({ type: "meta", command: "graph scope" }),
  JSON.stringify({ type: "fact", name: right.symbolName, filePath: right.filePath, kind: "class" }),
  JSON.stringify({ type: "summary", returnedNodes: 1 }),
].join("\n");

const wrapper = (prompt.match(/node (\S+mexg\.mjs)/) ?? [])[1] ?? "mexg.mjs";
const calls = {
  "correct-graph": [{ name: "Bash", input: { command: `node ${wrapper} graph scope "sign in rate limit"` }, result: scopePayload }],
  "correct-files": [
    { name: "Grep", input: { pattern: "RateLimiter" }, result: "packages/accounts/.../LoginRateLimiterService.ts:11" },
    { name: "Read", input: { file_path: right.filePath }, result: "export class LoginRateLimiterService {}" },
  ],
  wrong: [{ name: "Bash", input: { command: `node ${wrapper} graph scope "sign in"` }, result: scopePayload }],
  // The realistic case: the agent tries the shell, the allowlist refuses, it falls back to the
  // Grep TOOL and still answers. Must stay VALID and be counted as one blocked attempt.
  "blocked-shell": [
    { name: "Bash", input: { command: `node ${wrapper} graph scope "sign in"` }, result: scopePayload },
    { name: "Bash", input: { command: "grep -rn RateLimiter packages/" }, result: "Permission to use Bash with this command has not been granted", isError: true },
    { name: "Grep", input: { pattern: "RateLimiter" }, result: "packages/accounts/.../LoginRateLimiterService.ts:11" },
  ],
  // The allowlist leaking: a shell grep that actually ran. Must be INVALID.
  "violate-shell": [{ name: "Bash", input: { command: "grep -r RateLimiter ." }, result: "packages/accounts/x.ts:11: RateLimiter" }],
  "violate-sqlite": [{ name: "Bash", input: { command: `node ${wrapper} graph scope "x"; sqlite3 .mex/graph.db 'select 1'` }, result: "1" }],
}[mode] ?? [];

let i = 0;
for (const c of calls) {
  const id = `toolu_${++i}`;
  emit({
    type: "assistant",
    message: {
      usage: { input_tokens: 10, output_tokens: 120, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900 },
      content: [{ type: "tool_use", id, name: c.name, input: c.input }],
    },
  });
  emit({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: id, content: c.result, ...(c.isError ? { is_error: true } : {}) }] } });
}

emit({
  type: "assistant",
  message: { usage: { input_tokens: 5, output_tokens: 60, cache_read_input_tokens: 5000, cache_creation_input_tokens: 300 }, content: [] },
});
emit({
  type: "result",
  result: JSON.stringify({ ...answer, confidence: "high" }),
  total_cost_usd: 0.12, num_turns: calls.length + 2, duration_ms: 1234, duration_api_ms: 1100,
  permission_denials: [], stop_reason: "end_turn", is_error: false,
  usage: { input_tokens: 15, output_tokens: 180, cache_read_input_tokens: 9000, cache_creation_input_tokens: 1200 },
});
