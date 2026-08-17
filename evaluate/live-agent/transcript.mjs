/**
 * Stream-json transcript parser.
 *
 * Records everything the write-up needs, per session: token usage split by kind, cost, turns,
 * a tool-call census, a per-tool payload census (how many characters each tool pushed into the
 * context window), the fallback pattern, and the rank of the expected symbol in the first
 * graph retrieval.
 *
 * The payload census is the thing a naive parser misses. Turn count and call count both favour
 * a tool that returns a lot per call; only measuring the returned bytes shows what a call
 * actually costs, because every tool result is a cache write on arrival and is re-read on
 * every subsequent turn.
 */

const FILE_TOOLS = ["Read", "Grep", "Glob"];

function payloadText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((b) => (typeof b === "string" ? b : b?.text ?? JSON.stringify(b))).join("\n");
  }
  return content == null ? "" : JSON.stringify(content);
}

/** Rank of the expected symbol within a `graph scope` JSONL payload. */
function scopeRank(payload, expected) {
  if (!expected) return null;
  const facts = payload.split("\n").flatMap((line) => {
    try { const r = JSON.parse(line); return r.type === "fact" ? [r] : []; } catch { return []; }
  });
  const norm = (s) => (s ?? "").trim().split("\\").join("/").replace(/^\.\//, "").toLowerCase();
  const i = facts.findIndex((f) => norm(f.filePath) === norm(expected.filePath) && f.name === expected.symbolName);
  return i === -1 ? null : i + 1;
}

/**
 * Classify a Bash command by SEGMENT, not as one string.
 *
 * The first version of this treated any shell operator as a violation, which was wrong and
 * invalidated a whole run: agents routinely write `<graph command> 2>&1 | head -20`, and a pipe
 * into `head` is an output filter, not a repository search.
 *
 * What actually matters for a fair comparison is narrower than "no shell operators":
 *   - BOTH arms already have Read/Grep/Glob, so a shell `grep` or `cat` is the same capability
 *     through a different door. It is not an unfair advantage — but it IS a fallback, and must
 *     be counted as one rather than as a graph call.
 *   - Reading `graph.db` with sqlite bypasses the retrieval layer entirely. That is the real
 *     violation, because then the arm is not using the graph, it is using SQL.
 */
const STDIN_FILTERS = new Set(["head", "tail", "wc", "sort", "uniq", "cut", "tr", "jq", "sed", "awk", "echo", "true"]);
const REPO_READERS = new Set(["grep", "rg", "cat", "find", "ls", "dir", "type", "fgrep", "egrep", "more", "less"]);
const SQLITE = /\b(?:sqlite3?|better-sqlite3)\b/i;
const GRAPH_DB = /graph\.db(?:-wal|-shm)?\b/i;

/** Split on shell separators, keeping it simple: we only need the leading word of each segment. */
export function segments(command) {
  return String(command ?? "")
    .split(/\|\||&&|[;|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * Does this segment invoke the graph wrapper?
 *
 * The absolute path alone is not enough. The prompt hands the agent an absolute invocation, but
 * agents routinely rewrite it as `cd <wrapper dir> && node mexg.mjs ...`, at which point the
 * absolute token is gone and a substring test misses. Run pm-mex-4 opened with a session that
 * made five executed graph calls and was recorded as `graphCalls: 0, non-graph bash: 5` for
 * exactly this reason — a classifier bug that reads as "the agent ignored the graph".
 *
 * So match the wrapper's BASENAME too. It is distinctive enough to carry the whole job.
 */
const WRAPPER_BASENAME = /\bmexg\.mjs\b/;
function invokesWrapper(s, wrapperToken) {
  return (wrapperToken && s.includes(wrapperToken)) || WRAPPER_BASENAME.test(s);
}

/** Classify one segment. */
export function classifySegment(segment, wrapperToken) {
  const s = segment.trim();
  if (SQLITE.test(s) || (GRAPH_DB.test(s) && !invokesWrapper(s, wrapperToken))) return "sqlite";
  if (invokesWrapper(s, wrapperToken)) {
    if (/\bgraph\s+scope\b/.test(s)) return "graph scope";
    if (/\bgraph\s+query\b/.test(s)) return "graph query";
    if (/\bgraph\s+get\b/.test(s)) return "graph get";
    if (/\bimpact\b/.test(s)) return "impact";
    return "graph other";
  }
  const head = s.replace(/^\d?>?[&\s]*/, "").split(/\s+/)[0]?.replace(/^.*[/\\]/, "") ?? "";
  if (STDIN_FILTERS.has(head)) return "output filter";
  if (REPO_READERS.has(head)) return "shell file-read";
  return head ? "other shell" : "output filter";
}

/**
 * Whole-command classification, for the per-call census. A command counts as a graph call if any
 * segment invoked the graph; as a shell file-read if any segment read the repo; and only the
 * leftovers are "non-graph bash".
 */
export function classifyBash(command, wrapperToken) {
  const kinds = segments(command).map((s) => classifySegment(s, wrapperToken));
  if (kinds.includes("sqlite")) return "sqlite";
  const graph = kinds.find((k) => k.startsWith("graph ") || k === "impact");
  if (graph) return graph;
  if (kinds.includes("shell file-read")) return "shell file-read";
  if (kinds.every((k) => k === "output filter")) return "output filter";
  return "non-graph bash";
}

export function parseTranscript(raw, { expected = null, wrapperToken = null } = {}) {
  const events = [];
  let malformedLines = 0;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { events.push(JSON.parse(line)); } catch { malformedLines += 1; }
  }

  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  const toolCalls = {};        // tool name -> count
  const bashKinds = {};        // classified graph subcommand -> count
  const payloadByTool = {};    // tool name -> { calls, chars, max }
  const toolUseById = new Map();
  const resultState = new Map();  // tool_use_id -> { refused, chars }
  const bashCommands = [];        // { id, command, kind }
  let firstScopeRank = null, firstScopeSeen = false;
  let result = null, costUsd = 0, turns = 0, denials = [], stopReason = null, isError = null, finalUsage = null;
  let durationMs = null, durationApiMs = null, apiErrorStatus = null;
  let toolsOffered = [], mcpServers = [];

  for (const e of events) {
    if (e.type === "system" && e.subtype === "init") {
      toolsOffered = e.tools ?? [];
      mcpServers = e.mcp_servers ?? [];
    } else if (e.type === "assistant") {
      const u = e.message?.usage ?? {};
      usage.input += Number(u.input_tokens ?? 0);
      usage.output += Number(u.output_tokens ?? 0);
      usage.cacheRead += Number(u.cache_read_input_tokens ?? 0);
      usage.cacheWrite += Number(u.cache_creation_input_tokens ?? 0);
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_use") continue;
        toolCalls[b.name] = (toolCalls[b.name] ?? 0) + 1;
        if (b.id) toolUseById.set(b.id, b);
        if (b.name === "Bash") {
          const cmd = String(b.input?.command ?? "");
          const kind = classifyBash(cmd, wrapperToken);
          bashCommands.push({ id: b.id, command: cmd, kind });
          bashKinds[kind] = (bashKinds[kind] ?? 0) + 1;
        }
      }
    } else if (e.type === "user") {
      for (const b of e.message?.content ?? []) {
        if (b.type !== "tool_result") continue;
        const call = toolUseById.get(b.tool_use_id);
        const text = payloadText(b.content);
        // Did this call actually run, or was it refused? A refused shell command is the agent
        // ATTEMPTING to escape to the shell — real behaviour worth counting — while an executed
        // one means the allowlist leaked and the comparison is broken. They must not be conflated.
        const refused = b.is_error === true || /permission|not allowed|denied|requires approval/i.test(text.slice(0, 400));
        if (call) resultState.set(b.tool_use_id, { refused, chars: text.length });
        // Attribute a Bash payload to the graph subcommand that produced it, so the census
        // separates "the graph returned 15k chars" from "a shell command did".
        let label = call?.name ?? "unknown";
        if (call?.name === "Bash") label = classifyBash(call.input?.command, wrapperToken);
        const slot = (payloadByTool[label] ??= { calls: 0, chars: 0, max: 0 });
        slot.calls += 1;
        slot.chars += text.length;
        slot.max = Math.max(slot.max, text.length);
        if (!firstScopeSeen && label === "graph scope") {
          firstScopeSeen = true;
          firstScopeRank = scopeRank(text, expected);
        }
      }
    } else if (e.type === "result") {
      costUsd = Number(e.total_cost_usd ?? 0);
      turns = Number(e.num_turns ?? 0);
      denials = e.permission_denials ?? [];
      stopReason = e.stop_reason ?? null;
      isError = e.is_error ?? null;
      durationMs = e.duration_ms ?? null;
      durationApiMs = e.duration_api_ms ?? null;
      apiErrorStatus = e.api_error_status ?? null;
      if (e.result != null) {
        try { result = JSON.parse(e.result); } catch { result = { _raw: e.result }; }
      }
      // AUTHORITATIVE token figure. Summing per-assistant-event usage double-counts cache reads
      // once per turn, so it inflates with turn count — measured at 3.4x on one session, and it
      // biases any arm comparison toward whichever arm takes more turns. The result event's
      // usage is the session total and is what other runs report, so it is the comparable one.
      if (e.usage) {
        finalUsage = {
          input: Number(e.usage.input_tokens ?? 0),
          output: Number(e.usage.output_tokens ?? 0),
          cacheRead: Number(e.usage.cache_read_input_tokens ?? 0),
          cacheWrite: Number(e.usage.cache_creation_input_tokens ?? 0),
        };
        finalUsage.total = finalUsage.input + finalUsage.output + finalUsage.cacheRead + finalUsage.cacheWrite;
      }
    }
  }

  const offered = new Set(toolsOffered);
  // Count only tools the session was actually offered: models emit tool_use blocks for tools
  // they never had, and counting those invents a fallback that never happened.
  const fileToolCalls = FILE_TOOLS.reduce((n, k) => n + (offered.has(k) ? (toolCalls[k] ?? 0) : 0), 0);
  const graphCalls = Object.entries(bashKinds)
    .filter(([k]) => k.startsWith("graph ") || k === "impact")
    .reduce((n, [, v]) => n + v, 0);

  // Three distinct behaviours, deliberately not merged:
  //   shellEscapeAttempts — the agent tried to reach the shell for something other than the
  //                         graph (grep, cat, find). Blocked by the allowlist, but the ATTEMPT
  //                         is real agent behaviour and is exactly what happens in the wild.
  //   shellEscapeExecuted — a non-graph shell command that actually RAN. The allowlist leaked;
  //                         the session is invalid, because the arm just got a search tool the
  //                         control arm never had.
  //   fileCalls           — ordinary fallback to Read/Grep/Glob. Permitted, and the headline
  //                         fallback number.
  // Stamp each recorded bash call with whether it actually ran. A call with no result at all
  // (the session ended first) counts as not executed — the conservative reading.
  for (const c of bashCommands) c.executed = resultState.get(c.id)?.refused === false;

  const escapeKinds = new Set(["non-graph bash", "shell file-read"]);
  const nonGraphBashCalls = bashCommands.filter((c) => escapeKinds.has(c.kind));
  const shellEscapeAttempts = nonGraphBashCalls.filter((c) => resultState.get(c.id)?.refused !== false);
  const shellEscapeExecuted = nonGraphBashCalls.filter((c) => resultState.get(c.id)?.refused === false);
  const graphRefused = bashCommands.filter((c) => !escapeKinds.has(c.kind) && resultState.get(c.id)?.refused === true);
  // A shell file-read that RAN is a fallback by another door, and is added to the file-tool
  // count so the fallback census tells the truth. Both arms have Read/Grep/Glob, so this is
  // not an unfair capability — but calling it a graph call would be a lie.
  const shellFileReads = bashCommands.filter((c) => c.kind === "shell file-read" && c.executed).length;

  return {
    toolsOffered, mcpServers, toolCalls, bashKinds, bashCommands,
    shellEscapeAttempts: shellEscapeAttempts.length,
    shellEscapeExecuted: shellEscapeExecuted.length,
    shellEscapeCommands: shellEscapeAttempts.map((c) => c.command.slice(0, 200)),
    shellEscapeExecutedCommands: shellEscapeExecuted.map((c) => c.command.slice(0, 200)),
    graphCallsRefused: graphRefused.length,
    toolCallTotal: Object.values(toolCalls).reduce((a, b) => a + b, 0),
    fileToolCalls, shellFileReads,
    fileCalls: fileToolCalls + shellFileReads,
    graphCalls, nonGraphBash: bashKinds["non-graph bash"] ?? 0,
    payloadByTool,
    totalPayloadChars: Object.values(payloadByTool).reduce((n, s) => n + s.chars, 0),
    firstScopeRank,
    // `usage` is the comparable session total from the result event. `usagePerTurnSum` is the
    // old summed figure, kept only so the two can be reconciled — never quote it as a total.
    usage: finalUsage ?? { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
    usagePerTurnSum: { ...usage, total: usage.input + usage.output + usage.cacheRead + usage.cacheWrite },
    costUsd, turns, denials, stopReason, isError, durationMs, durationApiMs, apiErrorStatus,
    malformedLines, answer: result,
  };
}
