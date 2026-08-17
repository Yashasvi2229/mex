#!/usr/bin/env node
/**
 * Report — every table the write-up needs, from the session records on disk.
 * No measurement happens here; this only aggregates.
 *
 *   node report.mjs --label pm-mex-1 [--json]
 */
import { readdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT_DIR = resolve(flag("--output", join(HERE, "results", flag("--label", "run-1"))));
const runsDir = join(OUT_DIR, "runs");
if (!existsSync(runsDir)) throw new Error(`no runs at ${runsDir}`);

const rows = readdirSync(runsDir).filter((f) => f.endsWith(".json")).sort()
  .map((f) => JSON.parse(readFileSync(join(runsDir, f), "utf8")));
const suite = JSON.parse(readFileSync(join(HERE, "suite.json"), "utf8"));
const byId = Object.fromEntries(suite.tasks.map((t) => [t.id, t]));
const arms = [...new Set(rows.map((r) => r.arm))];
const nl = (r) => byId[r.taskId].kind === "nl";
const mh = (r) => byId[r.taskId].kind === "multihop";

const sum = (xs) => xs.reduce((a, b) => a + b, 0);
const mean = (xs) => (xs.length ? sum(xs) / xs.length : 0);
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); return s.length ? (s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0; };
const pad = (v, n) => String(v).padStart(n);

console.log(`sessions: ${rows.length}   invalid: ${rows.filter((r) => !r.valid).length}`);
for (const r of rows.filter((x) => !x.valid)) console.log(`  INVALID ${r.runId}: ${r.violations.join("; ")}`);

console.log("\n=== 0. VALIDITY / ISOLATION ===");
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  const tools = [...new Set(rs.map((r) => (r.toolsOffered ?? []).slice().sort().join(",")))];
  console.log(`  ${arm.padEnd(6)} sessions ${pad(rs.length, 3)}  toolsOffered: ${tools.join(" | ")}`);
  console.log(`         mcpServers: ${JSON.stringify([...new Set(rs.map((r) => JSON.stringify(r.mcpServers ?? [])))])}`);
  console.log(`         timeouts ${rs.filter((r) => r.timedOut).length}  denials ${sum(rs.map((r) => (r.denials ?? []).length))}  apiErrors ${rs.filter((r) => r.apiErrorStatus).length}`);
}

console.log("\n=== 1. CORRECTNESS ===");
console.log("  arm".padEnd(10), "NL correct", " file ok", " sym ok", "  multihop exact");
for (const arm of arms) {
  const n = rows.filter((r) => r.arm === arm && nl(r)), m = rows.filter((r) => r.arm === arm && mh(r));
  console.log("  " + arm.padEnd(8),
    pad(`${n.filter((r) => r.grade.correct).length}/${n.length}`, 10),
    pad(`${n.filter((r) => r.grade.fileOK).length}/${n.length}`, 8),
    pad(`${n.filter((r) => r.grade.symOK).length}/${n.length}`, 7),
    pad(`${m.filter((r) => r.grade.correct).length}/${m.length}`, 16));
}

console.log("\n=== 2. PER TASK (correct count per arm) ===");
console.log("  task".padEnd(36), "tier".padEnd(12), arms.map((a) => a.padStart(10)).join(""));
for (const t of suite.tasks) {
  const cell = (a) => { const rs = rows.filter((r) => r.taskId === t.id && r.arm === a); return `${rs.filter((r) => r.grade.correct).length}/${rs.length}`; };
  console.log("  " + t.id.padEnd(34), t.tier.padEnd(12), arms.map((a) => pad(cell(a), 10)).join(""));
}

console.log("\n=== 3. EFFICIENCY (all tasks) ===");
const metrics = [
  ["median turns", (rs) => med(rs.map((r) => r.turns))],
  ["median wall s", (rs) => Math.round(med(rs.map((r) => r.wallMs)) / 1000)],
  ["total wall min", (rs) => (sum(rs.map((r) => r.wallMs)) / 60000).toFixed(1)],
  ["total tool calls", (rs) => sum(rs.map((r) => r.toolCallTotal))],
  ["total file calls", (rs) => sum(rs.map((r) => r.fileCalls))],
  ["total graph calls", (rs) => sum(rs.map((r) => r.graphCalls))],
  ["median tokens", (rs) => Math.round(med(rs.map((r) => r.usage.total)))],
  ["total tokens", (rs) => sum(rs.map((r) => r.usage.total))],
  ["total cost usd", (rs) => sum(rs.map((r) => r.costUsd ?? 0)).toFixed(2)],
];
console.log("  metric".padEnd(20), arms.map((a) => a.padStart(14)).join(""), "   ratio");
for (const [name, fn] of metrics) {
  const vals = arms.map((a) => fn(rows.filter((r) => r.arm === a)));
  const ratio = arms.length === 2 && Number(vals[0]) ? (Number(vals[1]) / Number(vals[0])).toFixed(2) + "x" : "";
  console.log("  " + name.padEnd(18), vals.map((v) => pad(v, 14)).join(""), pad(ratio, 8));
}

console.log("\n=== 4. TOKEN COMPOSITION ===");
console.log("  arm".padEnd(10), "input".padStart(9), "output".padStart(10), "cacheRead".padStart(12), "cacheWrite".padStart(12), "total".padStart(12));
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  console.log("  " + arm.padEnd(8),
    pad(sum(rs.map((r) => r.usage.input)), 9), pad(sum(rs.map((r) => r.usage.output)), 10),
    pad(sum(rs.map((r) => r.usage.cacheRead)), 12), pad(sum(rs.map((r) => r.usage.cacheWrite)), 12),
    pad(sum(rs.map((r) => r.usage.total)), 12));
}

console.log("\n=== 5. FALLBACK CENSUS (graph arm — the only arm with a real choice) ===");
const pattern = (r) => r.graphCalls > 0 && r.fileCalls === 0 ? "graph-only"
  : r.graphCalls === 0 && r.fileCalls > 0 ? "files-only"
  : r.graphCalls > 0 ? "graph-then-files" : "neither";
for (const arm of arms.filter((a) => a !== "files")) {
  const rs = rows.filter((r) => r.arm === arm);
  const tally = {};
  for (const r of rs) tally[pattern(r)] = (tally[pattern(r)] ?? 0) + 1;
  for (const [k, v] of Object.entries(tally)) console.log(`  ${k.padEnd(18)} ${v} / ${rs.length}`);
  console.log(`  NL tasks with zero file calls: ${rs.filter((r) => nl(r) && r.fileCalls === 0).length}/${rs.filter(nl).length}`);
  console.log(`  multihop with any file call  : ${rs.filter((r) => mh(r) && r.fileCalls > 0).length}/${rs.filter(mh).length}`);

  console.log("\n  --- shell use for something other than the graph ---");
  const attempts = sum(rs.map((r) => r.shellEscapeAttempts ?? 0));
  const executed = sum(rs.map((r) => r.shellEscapeExecuted ?? 0));
  const sessionsWith = rs.filter((r) => (r.shellEscapeExecuted ?? 0) > 0);
  console.log(`  blocked by the allowlist     : ${attempts}`);
  console.log(`  EXECUTED                     : ${executed} across ${sessionsWith.length}/${rs.length} sessions`);
  console.log(`    (counted as file fallback, not as graph calls. A non-zero here means the`);
  console.log(`     --allowedTools prefix did not bind — see --permission-mode.)`);
  console.log(`  graph calls refused          : ${sum(rs.map((r) => r.graphCallsRefused ?? 0))}  (a non-zero here means the allowlist is too tight)`);
  const cmds = rs.flatMap((r) => r.shellEscapeCommands ?? []);
  if (cmds.length) {
    console.log("  what it tried to run:");
    const tally = {};
    for (const c of cmds) { const head = c.trim().split(/\s+/)[0]; tally[head] = (tally[head] ?? 0) + 1; }
    for (const [k, v] of Object.entries(tally).sort((a, b) => b[1] - a[1])) console.log(`    ${String(v).padStart(3)}x  ${k}`);
    for (const c of [...new Set(cmds)].slice(0, 10)) console.log(`         ${c}`);
  }
}

console.log("\n=== 6. PAYLOAD ANATOMY (chars pushed into context, per tool) ===");
console.log("  arm".padEnd(8), "tool".padEnd(18), "calls".padStart(7), "median".padStart(9), "max".padStart(9), "total".padStart(11), "~tokens".padStart(10));
for (const arm of arms) {
  const rs = rows.filter((r) => r.arm === arm);
  const agg = {};
  for (const r of rs) for (const [tool, s] of Object.entries(r.payloadByTool ?? {})) {
    const a = (agg[tool] ??= { calls: 0, chars: 0, max: 0, per: [] });
    a.calls += s.calls; a.chars += s.chars; a.max = Math.max(a.max, s.max);
    a.per.push(s.calls ? s.chars / s.calls : 0);
  }
  for (const [tool, a] of Object.entries(agg).sort((x, y) => y[1].chars - x[1].chars)) {
    console.log("  " + arm.padEnd(6), tool.padEnd(18), pad(a.calls, 7), pad(Math.round(med(a.per)), 9),
      pad(a.max, 9), pad(a.chars, 11), pad(Math.ceil(a.chars / 4), 10));
  }
  console.log(`  ${arm.padEnd(6)} ${"TOTAL".padEnd(18)} ${pad("", 7)} ${pad("", 9)} ${pad("", 9)} ${pad(sum(rs.map((r) => r.totalPayloadChars)), 11)} ${pad(Math.ceil(sum(rs.map((r) => r.totalPayloadChars)) / 4), 10)}`);
}

console.log("\n=== 7. RETRIEVAL RESOLUTION — rank of the target in the FIRST graph scope ===");
for (const arm of arms.filter((a) => a !== "files")) {
  const rs = rows.filter((r) => r.arm === arm && r.firstScopeRank !== null);
  const miss = rows.filter((r) => r.arm === arm && r.firstScopeRank === null && r.graphCalls > 0);
  console.log(`  ${arm}: ranked in first scope ${rs.length}, absent ${miss.length}`);
  console.log(`    ranks: ${rs.map((r) => r.firstScopeRank).sort((a, b) => a - b).join(", ") || "none"}`);
}

if (argv.includes("--json")) {
  writeFileSync(join(OUT_DIR, "report.json"), JSON.stringify({ rows }, null, 2));
  console.log(`\nwrote ${join(OUT_DIR, "report.json")}`);
}
