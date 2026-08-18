import { parseStructuredAnswer } from "../../compare/lib/answer.mjs";
import { contentText, parseEventStream, toolMetrics, usageRecord } from "./shared.mjs";

export const claudeAdapter = {
  id: "claude",

  buildInvocation({ executable = "claude", prefix = [], prompt, model, schema, subjectRoot, tools = "Read,Grep,Glob,Bash", allowedTools = [] }) {
    return {
      command: executable,
      args: [
        ...prefix,
        "-p", prompt,
        "--output-format", "stream-json",
        "--verbose",
        "--safe-mode",
        "--no-session-persistence",
        "--exclude-dynamic-system-prompt-sections",
        "--permission-mode", "dontAsk",
        "--model", model,
        "--json-schema", JSON.stringify(schema),
        "--add-dir", subjectRoot,
        "--tools", tools,
        ...(allowedTools.length ? ["--allowedTools", ...allowedTools] : []),
      ],
    };
  },

  parseTranscript(raw, task) {
    const { events, malformedLines } = parseEventStream(raw, "Claude stream");
    const rawUsage = [];
    const totals = { uncachedInput: 0, cacheWrite: 0, cacheRead: 0, output: 0 };
    const toolCalls = [];
    const byId = new Map();
    let resultValue = "";
    let reportedCostUsd = null;
    let turns = null;
    let resultPermissionDenials = 0;
    for (const event of events) {
      if (event.type === "assistant") {
        const value = event.message?.usage;
        if (value) {
          rawUsage.push(value);
          totals.uncachedInput += Number(value.input_tokens ?? 0);
          totals.cacheWrite += Number(value.cache_creation_input_tokens ?? 0);
          totals.cacheRead += Number(value.cache_read_input_tokens ?? 0);
          totals.output += Number(value.output_tokens ?? 0);
        }
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_use") continue;
          const call = { id: block.id ?? null, name: block.name, input: block.input ?? {}, status: "attempted", output: null };
          toolCalls.push(call);
          if (call.id) byId.set(call.id, call);
        }
      } else if (event.type === "user") {
        for (const block of event.message?.content ?? []) {
          if (block.type !== "tool_result") continue;
          const call = byId.get(block.tool_use_id);
          if (!call) continue;
          call.output = contentText(block.content);
          call.status = block.is_error ? "error" : "executed";
        }
      } else if (event.type === "result") {
        resultValue = event.structured_output ?? event.result ?? resultValue;
        if (Number.isFinite(Number(event.total_cost_usd))) reportedCostUsd = Number(event.total_cost_usd);
        if (Number.isFinite(Number(event.num_turns))) turns = Number(event.num_turns);
        resultPermissionDenials = Array.isArray(event.permission_denials) ? event.permission_denials.length : 0;
      }
    }
    const usage = usageRecord({
      ...totals,
      reportedInput: totals.uncachedInput + totals.cacheWrite + totals.cacheRead,
      reportedTotal: totals.uncachedInput + totals.cacheWrite + totals.cacheRead + totals.output,
      reportedCostUsd,
    }, rawUsage);
    const tools = toolMetrics(toolCalls, task);
    tools.permissionDenials += resultPermissionDenials;
    return {
      provider: "claude",
      usage,
      turns,
      toolCalls,
      ...tools,
      malformedLines,
      structured: parseStructuredAnswer(resultValue),
      rawResult: resultValue,
    };
  },
};
