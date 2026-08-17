/**
 * Transcript policy.
 *
 * The graph arm is handed `Bash`, which the file-only arm does not have. Without a constraint
 * that asymmetry would wreck the comparison: an agent could `grep` through the shell and the
 * fallback census would count it as a graph call, or it could read `.mex/graph.db` with sqlite
 * and bypass the retrieval layer entirely — measuring SQL, not the graph.
 *
 * So Bash is confined to the graph wrapper by an `--allowedTools` prefix rule at the harness
 * level, and re-checked here from the transcript. A violation invalidates the session rather
 * than being averaged in, because a run that quietly allowed one is not the experiment.
 */
import { classifySegment, segments } from "./transcript.mjs";

export function shellWords(command) {
  const words = [];
  let word = "", quote = null, escaped = false;
  for (const char of command.trim()) {
    if (escaped) { word += char; escaped = false; continue; }
    if (char === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (char === quote) quote = null; else word += char; continue; }
    if (char === "'" || char === '"') { quote = char; continue; }
    if (/\s/.test(char)) { if (word) { words.push(word); word = ""; } continue; }
    word += char;
  }
  if (quote || escaped) throw new Error("unterminated shell quoting");
  if (word) words.push(word);
  return words;
}

const ALLOWED = new Set(["graph scope", "graph query", "graph get", "impact"]);

export function validate({ arm, toolsOffered, toolCalls, bashCommands, wrapperToken, denials, malformedLines, timedOut, exitCode, answerOk }) {
  const v = [];
  const offered = new Set(toolsOffered);

  // Both arms are offered the identical tool set. The arms differ only in whether the prompt
  // tells the agent a graph CLI exists, so anything asymmetric in the OFFER is a harness fault.
  for (const t of ["Read", "Grep", "Glob", "Bash"]) {
    if (!offered.has(t)) v.push(`${arm.id} arm was not offered ${t}`);
  }
  // The control arm is never told the graph exists. If it finds and runs it anyway, the arms are
  // no longer distinct and the session cannot be used.
  if (arm.kind === "files") {
    const usedGraph = bashCommands.some((c) => wrapperToken && String(c.command).includes(wrapperToken));
    if (usedGraph) v.push("control arm invoked the graph CLI");
  }
  if (offered.size === 0) v.push("no tools recorded in the init event");

  // What can and cannot invalidate a session — this list was wrong once and cost a run.
  //
  // NOT a violation:
  //   - shell operators. `<graph command> 2>&1 | head -20` is an output filter, and agents write
  //     it constantly. Treating a pipe as a bypass invalidated every graph session in the first
  //     attempt at this run.
  //   - a shell `grep`/`cat`. Both arms are offered Read/Grep/Glob, so this is the same
  //     capability through a different door. It is counted as fallback, not scored as cheating.
  //   - a refused command. That is the allowlist working; the attempt is recorded as a metric.
  //
  // IS a violation:
  //   - touching graph.db with sqlite, which bypasses retrieval and measures SQL instead.
  //   - a graph subcommand outside the four the suite permits.
  for (const { command, executed } of bashCommands) {
    if (!executed) continue;
    const c = String(command).trim();
    for (const seg of segments(c)) {
      const kind = classifySegment(seg, wrapperToken);
      if (kind === "sqlite") { v.push(`graph.db opened directly: ${seg.slice(0, 120)}`); continue; }
      if (!kind.startsWith("graph ") && kind !== "impact") continue;
      let words;
      try { words = shellWords(seg); } catch (e) { v.push(e.message); continue; }
      // Match the absolute wrapper path OR its basename — agents rewrite the invocation as
      // `cd <dir> && node mexg.mjs ...`, which drops the absolute token. Without the basename
      // arm the wrapper word is never located, `args` keeps `node mexg.mjs` at the front, and
      // every relative graph call is misread as a disallowed subcommand.
      const i = words.findIndex((w) => (wrapperToken && w.includes(wrapperToken)) || /\bmexg\.mjs$/.test(w));
      if (i === -1) { v.push(`graph segment with no locatable wrapper: ${seg.slice(0, 120)}`); continue; }
      const args = words.slice(i + 1);
      const key = args[0] === "impact" ? "impact" : `${args[0] ?? ""} ${args[1] ?? ""}`.trim();
      if (!ALLOWED.has(key)) v.push(`disallowed graph command: ${seg.slice(0, 120)}`);
    }
  }

  // A graph session in which the graph never actually RAN is not a measurement of the graph.
  //
  // Run pm-mex-3 shipped 30 such sessions and read as a clean 60/60: the permission mode denied
  // every wrapper call, so the arm quietly became a second file arm, and its headline finding
  // ("0/30 graph-only") was an artifact of the harness rather than a property of the graph.
  // Nothing here caught it, because refusals were being treated as the allowlist working.
  //
  // So: attempted-but-never-executed is a violation now, not a metric.
  if (arm.kind === "graph") {
    const attempted = bashCommands.filter((c) => String(c.kind ?? "").startsWith("graph ") || c.kind === "impact");
    if (attempted.length && !attempted.some((c) => c.executed)) {
      v.push(`graph arm executed 0 of ${attempted.length} attempted graph call(s) — all refused`);
    }
  }
  // Denials are no longer expected in EITHER arm: with confinement abandoned there is no
  // allowlist left to bounce off, so a denial means a permission setting is fighting the design.
  if (denials?.length) v.push(`${denials.length} permission denial(s) in the ${arm.id} arm`);
  if (malformedLines) v.push(`${malformedLines} malformed stream line(s)`);
  if (timedOut) v.push("session timeout");
  if (exitCode !== 0) v.push(`agent exited ${exitCode}`);
  if (!answerOk) v.push("no parseable structured answer");
  return v;
}
