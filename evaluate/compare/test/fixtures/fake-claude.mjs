const mode = process.env.FAKE_CLAUDE_MODE ?? "ok";
if (mode === "timeout") setTimeout(() => {}, 60_000);
else if (mode === "failure") { process.stderr.write("fake failure\n"); process.exit(7); }
else {
  const promptIndex = process.argv.indexOf("-p");
  const prompt = process.argv[promptIndex + 1] ?? "";
  const graphPrefix = prompt.match(/Start with `(.+?) graph scope/);
  const toolId = "tool-1";
  if (graphPrefix) {
    const command = `${graphPrefix[1]} graph scope "fake question"`;
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, content: [{ type: "tool_use", id: toolId, name: "Bash", input: { command } }] } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: '{"type":"fact","name":"FakeSymbol"}\n' }] } })}\n`);
  } else {
    process.stdout.write(`${JSON.stringify({ type: "assistant", message: { usage: { input_tokens: 11, cache_creation_input_tokens: 12, cache_read_input_tokens: 13, output_tokens: 14 }, content: [{ type: "tool_use", id: toolId, name: "Grep", input: { pattern: "FakeSymbol" } }] } })}\n`);
    process.stdout.write(`${JSON.stringify({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: toolId, content: "src/fake.ts:1:function FakeSymbol() {}" }] } })}\n`);
  }
  process.stdout.write(`${JSON.stringify({ type: "result", structured_output: { answer: "FakeSymbol does it.", symbols: ["FakeSymbol"], evidence: [{ path: "src/fake.ts", line: 1 }], complete: true }, total_cost_usd: 0.001, num_turns: 1, permission_denials: [] })}\n`);
}
