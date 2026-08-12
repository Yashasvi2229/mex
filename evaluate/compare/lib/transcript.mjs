import { parseStructuredAnswer } from "./answer.mjs";

function payloadText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((block) => typeof block === "string" ? block : block?.text ?? JSON.stringify(block)).join("\n");
  return content == null ? "" : JSON.stringify(content);
}

function scopeRank(payload, expectedSymbols) {
  const facts = payload.split("\n").flatMap((line) => {
    try { const record = JSON.parse(line); return record.type === "fact" ? [record] : []; }
    catch { return []; }
  });
  const ranks = [];
  for (const symbol of expectedSymbols) {
    const index = facts.findIndex((fact) => fact.name === symbol || fact.symbol === symbol || JSON.stringify(fact).includes(symbol));
    if (index >= 0) ranks.push(index + 1);
  }
  return ranks.length ? Math.min(...ranks) : null;
}

export function parseTranscript(raw, expectedSymbols = []) {
  const usage = { uncachedInput: 0, cacheCreation: 0, cacheRead: 0, output: 0 };
  const toolCalls = [], toolUseById = new Map(), payloads = [], graph = { calls: 0, vocabRetries: 0, fallbacks: 0, initialScopeRank: null };
  let resultValue = "", costUsd = 0, turns = 0, permissionDenials = 0, malformedLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch { malformedLines += 1; continue; }
    if (event.type === "assistant") {
      const u = event.message?.usage ?? {};
      usage.uncachedInput += Number(u.input_tokens ?? 0);
      usage.cacheCreation += Number(u.cache_creation_input_tokens ?? 0);
      usage.cacheRead += Number(u.cache_read_input_tokens ?? 0);
      usage.output += Number(u.output_tokens ?? 0);
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_use") continue;
        const call = { id: block.id, name: block.name, input: block.input ?? {} };
        toolCalls.push(call);
        if (block.id) toolUseById.set(block.id, call);
        if (["Read", "Grep", "Glob"].includes(block.name)) graph.fallbacks += 1;
        if (block.name === "Bash") {
          const command = String(block.input?.command ?? "");
          if (/\bgraph\s+(?:scope|query|get|vocab)\b|\bimpact\b/.test(command)) graph.calls += 1;
          if (/\bgraph\s+vocab\b/.test(command)) graph.vocabRetries += 1;
        }
      }
    } else if (event.type === "user") {
      for (const block of event.message?.content ?? []) {
        if (block.type !== "tool_result") continue;
        const text = payloadText(block.content);
        payloads.push(text);
        const call = toolUseById.get(block.tool_use_id);
        if (graph.initialScopeRank === null && call?.name === "Bash" && /\bgraph\s+scope\b/.test(String(call.input?.command ?? ""))) {
          graph.initialScopeRank = scopeRank(text, expectedSymbols);
        }
      }
    } else if (event.type === "result") {
      resultValue = event.structured_output ?? event.result ?? resultValue;
      costUsd = Number(event.total_cost_usd ?? costUsd);
      turns = Number(event.num_turns ?? turns);
      permissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials.length : permissionDenials;
    }
  }
  const uniquePayloads = [...new Set(payloads)];
  const uniqueToolResultChars = uniquePayloads.reduce((sum, value) => sum + value.length, 0);
  const structured = parseStructuredAnswer(resultValue);
  return {
    usage: { ...usage, processed: Object.values(usage).reduce((sum, n) => sum + n, 0) },
    costUsd, turns, permissionDenials, malformedLines, toolCalls, graph,
    uniqueToolResultChars, uniqueToolResultTokens: Math.ceil(uniqueToolResultChars / 4),
    structured,
  };
}
