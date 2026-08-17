#!/usr/bin/env node
/**
 * Live-agent A/B runner — two arms, one subject repository.
 *
 *   files   Read + Grep + Glob                                    the control
 *   graph   Read + Grep + Glob + Bash(<wrapper> graph|impact ...)  the shipping shape
 *
 * `graph` deliberately keeps the file tools. An arm with the graph and nothing else cannot
 * measure fallback — a zero there is zero by construction and says nothing. Offering both is
 * the only configuration in which "did it reach for Grep" is a real question.
 *
 * ISOLATION — every flag here cost something to learn:
 *   --safe-mode                the subject repo ships CLAUDE.md, AGENTS.md and marketplace
 *                              plugins; loading them is contamination and a network dependency
 *   neutral cwd + --add-dir    belt and braces on the same problem: nothing is auto-discovered
 *                              from the subject root. This is why the graph arm needs mexg.mjs
 *   --setting-sources ""       drops user/project/local settings
 *   --disable-slash-commands   the subject repo ships skills
 *   --strict-mcp-config        on BOTH arms: neither may pick up an ambient MCP server
 *   --no-session-persistence   every task is a cold session; no cross-task learning
 *
 * The known asymmetry, recorded rather than hidden: a neutral cwd means the file tools do not
 * default to the subject repo, so the prompt states the root explicitly. Both arms carry it.
 *
 * INDEX GUARD. The subject's `.mex/graph.db` is swapped for a pinned snapshot before the run
 * and restored afterwards, with a checksum either side. Opening an older index migrates it in
 * place, so an unguarded run would mutate the very thing every prior measurement was taken
 * against.
 *
 * Usage:
 *   node runner.mjs --arms files,graph --repeats 3 --model claude-opus-5 --effort high \
 *                   --label pm-mex-1 [--only <taskId>] [--resume] [--dry-run]
 */
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildPrompt, MULTIHOP_SCHEMA, NL_SCHEMA } from "./prompt.mjs";
import { parseTranscript } from "./transcript.mjs";
import { validate } from "./policy.mjs";
import { gradeTask } from "./grade.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..");

const argv = process.argv.slice(2);
const flag = (name, dflt) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : dflt);
const has = (name) => argv.includes(name);

// Forward slashes everywhere the agent will see or type a path. Two reasons, both load-bearing:
// `process.execPath` on Windows is under "C:\Program Files\", whose space breaks any prefix
// allowlist; and a backslash is an escape character to the shell-word parser the policy check
// uses, so a backslash path cannot be validated. Node accepts forward slashes on Windows.
const fwd = (p) => p.split("\\").join("/");

const SUITE = JSON.parse(readFileSync(flag("--suite", join(HERE, "suite.json")), "utf8"));
const SUBJECT_ROOT = fwd(resolve(flag("--repo", SUITE.subject.root)));
const CLI = fwd(resolve(flag("--cli", join(HARNESS_ROOT, "dist", "cli.js"))));
const WRAPPER = fwd(join(HERE, "mexg.mjs"));
const CLAUDE = flag("--claude", "claude");
const MODEL = flag("--model", "claude-opus-5");
const EFFORT = flag("--effort", "high");
const REPEATS = Number(flag("--repeats", "3"));
const LABEL = flag("--label", "run-1");
const BUDGET_USD = flag("--max-budget-usd", "2");
const TIMEOUT_MS = Number(flag("--timeout-ms", String(10 * 60 * 1000)));
const ARMS = flag("--arms", "files,graph").split(",");
const ONLY = flag("--only", null);
const DRY = has("--dry-run");
const RESUME = has("--resume");

const OUT_DIR = resolve(flag("--output", join(HERE, "results", LABEL)));
const NEUTRAL_CWD = join(OUT_DIR, "neutral");
const SNAPSHOT = flag("--index-snapshot", null);

const ARM_DEFS = {
  files: { id: "files", kind: "files", label: "Read/Grep/Glob only" },
  graph: { id: "graph", kind: "graph", label: "Read/Grep/Glob + mex graph CLI" },
};

// The exact prefix the agent must use. Both the allowlist and the policy check key off it.
// `node` bare, resolved from PATH, rather than process.execPath — see the note on `fwd` above.
const NODE = flag("--node", "node");
const WRAPPER_PREFIX = [NODE, WRAPPER];
const WRAPPER_CLI_STRING = `${NODE} ${WRAPPER}`;

const sha256 = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Swap in a pinned index for the duration of the run; always put the original back. */
class IndexGuard {
  constructor(subjectRoot, snapshot, scratch) {
    this.live = join(subjectRoot, ".mex", "graph.db");
    this.snapshot = snapshot;
    this.backup = join(scratch, "graph.db.original");
    this.sidecars = [".mex/graph.db-wal", ".mex/graph.db-shm"].map((s) => join(subjectRoot, ...s.split("/")));
    this.active = false;
  }
  activate() {
    if (!this.snapshot) return null;
    if (!existsSync(this.snapshot)) throw new Error(`index snapshot missing: ${this.snapshot}`);
    mkdirSync(dirname(this.backup), { recursive: true });
    const before = existsSync(this.live) ? sha256(this.live) : null;
    if (existsSync(this.live)) copyFileSync(this.live, this.backup);
    for (const s of this.sidecars) if (existsSync(s)) rmSync(s, { force: true });
    copyFileSync(this.snapshot, this.live);
    this.active = true;
    return { originalSha: before, snapshotSha: sha256(this.snapshot) };
  }
  restore() {
    if (!this.active) return null;
    for (const s of this.sidecars) if (existsSync(s)) rmSync(s, { force: true });
    if (existsSync(this.backup)) copyFileSync(this.backup, this.live);
    this.active = false;
    return existsSync(this.live) ? sha256(this.live) : null;
  }
}

function claudeArgs(task, arm) {
  const schema = task.kind === "nl" ? NL_SCHEMA : MULTIHOP_SCHEMA;
  const common = [
    "-p", buildPrompt(task, arm, SUBJECT_ROOT, WRAPPER_CLI_STRING),
    "--model", MODEL,
    "--effort", EFFORT,
    "--output-format", "stream-json",
    "--verbose",
    "--safe-mode",
    "--no-session-persistence",
    "--setting-sources", "",
    "--disable-slash-commands",
    "--strict-mcp-config",
    // PERMISSION MODE — this flag has now been wrong in two different directions, so both are
    // recorded here.
    //
    //   bypassPermissions  grants every tool unconditionally, so an --allowedTools prefix rule
    //                      does not bind. Run pm-mex-1: 51 non-graph shell commands executed.
    //   dontAsk            honours an allowlist without prompting — but DENIES any Bash command
    //                      that is not on one. Run pm-mex-3 carried `dontAsk` after the
    //                      --allowedTools rule had been removed, so every wrapper call was
    //                      refused: 51 graph calls attempted, 51 denied, 0 executed. The graph
    //                      arm silently degraded into a second file arm.
    //
    // Confinement was abandoned deliberately (see the note on tools below) — there is no longer
    // an allowlist for `dontAsk` to honour, so it can only deny. `bypassPermissions` is the
    // setting that matches the design. The control is the transcript policy validator, which
    // still rejects a session that opens graph.db directly or runs an out-of-suite subcommand.
    "--permission-mode", "bypassPermissions",
    "--max-budget-usd", BUDGET_USD,
    "--json-schema", JSON.stringify(schema),
    "--add-dir", SUBJECT_ROOT,
  ];
  // BOTH arms get Bash, and this is the second correction this run forced.
  //
  // The plan was to give Bash only to the graph arm and confine it with an --allowedTools
  // prefix. Measured twice on 2026-08-14: the prefix rule does NOT bind Bash under either
  // `bypassPermissions` or `dontAsk` — the agent ran `cd <repo> && grep -rn ...` and
  // `cd <repo> && ls && sed -n 1,80p ...` in both configurations. Confinement is therefore not
  // available, and a graph arm with an unconstrained shell against a control arm with no shell
  // compares two different capability sets, not two retrieval strategies.
  //
  // So the shell is given to both. The ONLY difference between the arms is now whether the
  // agent is told a graph CLI exists — which is exactly the question. The cost is that this
  // control is stronger than a Read/Grep/Glob-only control, so it is a harder baseline to beat
  // and cross-run comparisons against a no-Bash baseline must say so.
  const tools = ["--tools", "Read,Grep,Glob,Bash"];
  return [...common, ...tools];
}

function runSession(task, arm) {
  return new Promise((res) => {
    const started = Date.now();
    // A .mjs/.js agent is a test double (see test/fake-claude.mjs); Windows cannot spawn a
    // script directly, so it is run through node. A real `claude` binary spawns as itself.
    const isScript = /\.(mjs|js)$/i.test(CLAUDE);
    const exe = isScript ? process.execPath : CLAUDE;
    const argsFor = isScript ? [CLAUDE, ...claudeArgs(task, arm)] : claudeArgs(task, arm);
    const proc = spawn(exe, argsFor, {
      cwd: NEUTRAL_CWD,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MEX_EVAL_SUBJECT_ROOT: SUBJECT_ROOT, MEX_EVAL_CLI: CLI },
    });
    let out = "", err = "", timedOut = false;
    const timer = setTimeout(() => { timedOut = true; proc.kill(); }, TIMEOUT_MS);
    proc.stdout.on("data", (d) => { out += d; });
    proc.stderr.on("data", (d) => { err += d; });
    proc.on("close", (code) => {
      clearTimeout(timer);
      res({ stdout: out, stderr: err, code, timedOut, wallMs: Date.now() - started });
    });
  });
}

/**
 * Detect an account-level stop (session/usage limit) rather than a task-level failure.
 *
 * Learned the expensive way on run pm-mex-2: a 429 mid-run does not stop the runner. It turns
 * every remaining session into a `turns=1, cost=$0, no answer` shell, and the loop cheerfully
 * writes 26 of those to disk as records. They are not data — they are the absence of data — and
 * on a later --resume they are indistinguishable from completed work unless you look inside.
 *
 * Two signals, either sufficient:
 *   explicit  the limit text appears in the stream or on stderr
 *   shape     the session ended in <=1 turn having spent nothing and answered nothing, which no
 *             genuine session does
 * On a hit the runner writes NO record and stops immediately, so the on-disk state stays exactly
 * "everything before this point, complete" and --resume picks up at the right session.
 */
/**
 * The stream carries a STRUCTURED rate-limit signal, so do not pattern-match prose.
 *
 *   {"type":"rate_limit_event","rate_limit_info":{"status":"allowed_warning","utilization":0.9,
 *    "rateLimitType":"five_hour","resetsAt":1786920600,...}}
 *
 * This event fires on healthy sessions — `allowed_warning` means allowed, merely close to the
 * ceiling. A regex over the raw stream therefore halts on perfectly good runs, which it did
 * twice here before this was written. Only a status outside the allowed set is a real stop.
 */
const ALLOWED_STATUS = new Set(["allowed", "allowed_warning"]);
const LIMIT_TEXT_RE = /(hit your (session|usage) limit|usage limit reached|credit balance is too low)/i;

/** Last rate_limit_info seen in the stream, for reporting how close the ceiling is. */
function rateLimitInfo(stdout) {
  let last = null;
  for (const line of stdout.split("\n")) {
    if (!line.includes('"rate_limit_event"')) continue;
    try { const e = JSON.parse(line); if (e.rate_limit_info) last = e.rate_limit_info; } catch { /* partial line */ }
  }
  return last;
}

function accountStop(session, parsed, rl) {
  if (rl && rl.status && !ALLOWED_STATUS.has(rl.status)) {
    return { reason: `rate_limit_event status=${rl.status} (${rl.rateLimitType}, resets ${new Date((rl.resetsAt ?? 0) * 1000).toISOString()})`, rateLimit: rl };
  }
  // Plain-text block message on stderr only. The agent's own ANSWER can contain limit vocabulary
  // — one suite task is about login rate limiting — so stdout is not scanned for prose.
  const hit = LIMIT_TEXT_RE.exec(session.stderr);
  if (hit) return { reason: `limit message on stderr: ${JSON.stringify(hit[0])}`, rateLimit: rl };
  if ((parsed.turns ?? 0) <= 1 && !(parsed.costUsd > 0) && parsed.answer == null) {
    return { reason: "empty session (turns<=1, $0 spent, no answer)", rateLimit: rl };
  }
  return null;
}

// --- main -------------------------------------------------------------------------------
const tasks = ONLY ? SUITE.tasks.filter((t) => t.id === ONLY) : SUITE.tasks;
if (!tasks.length) throw new Error(`no task matched --only ${ONLY}`);
for (const a of ARMS) if (!ARM_DEFS[a]) throw new Error(`unknown arm: ${a}`);

mkdirSync(OUT_DIR, { recursive: true });
mkdirSync(NEUTRAL_CWD, { recursive: true });
mkdirSync(join(OUT_DIR, "runs"), { recursive: true });
mkdirSync(join(OUT_DIR, "transcripts"), { recursive: true });
if (!existsSync(CLI)) throw new Error(`mex CLI not built: ${CLI} (run npm run build)`);

const total = tasks.length * ARMS.length * REPEATS;
console.log(`label=${LABEL} model=${MODEL} effort=${EFFORT}`);
console.log(`${tasks.length} task(s) x ${ARMS.length} arm(s) x ${REPEATS} rep(s) = ${total} sessions`);
console.log(`subject=${SUBJECT_ROOT}\ncli=${CLI}\nneutral cwd=${NEUTRAL_CWD}\nout=${OUT_DIR}\n`);

if (DRY) {
  const t = tasks[0];
  for (const armId of ARMS) {
    const arm = ARM_DEFS[armId];
    console.log(`--- ${armId} ---`);
    console.log(claudeArgs(t, arm).map((a) => (a.includes("\n") ? JSON.stringify(a) : a)).join(" "));
    console.log();
  }
  process.exit(0);
}

const guard = new IndexGuard(SUBJECT_ROOT, SNAPSHOT, join(OUT_DIR, ".scratch"));
const guardInfo = guard.activate();
if (guardInfo) console.log(`index guard: original ${guardInfo.originalSha?.slice(0, 12)} -> snapshot ${guardInfo.snapshotSha.slice(0, 12)}\n`);

const rows = [];
const startedAt = new Date().toISOString();
let aborted = null;
try {
  outer:
  for (let rep = 1; rep <= REPEATS; rep += 1) {
    for (const task of tasks) {
      for (const armId of ARMS) {
        const arm = ARM_DEFS[armId];
        const runId = `${task.id}.${armId}.r${rep}`;
        const resultPath = join(OUT_DIR, "runs", `${runId}.json`);
        if (existsSync(resultPath)) {
          if (RESUME) {
            const prior = JSON.parse(readFileSync(resultPath, "utf8"));
            // Resume carries forward completed work only. An invalid record is not work — it is
            // a session that was thrown out — so re-run it rather than baking the defect into
            // the resumed run. This is what makes "resume after a 429" produce a clean 60/60
            // instead of a 60-record file with holes in it.
            if (prior.valid) { rows.push(prior); continue; }
            console.log(`  r${rep} ${task.id.padEnd(34)} ${armId.padEnd(6)} ... re-running (prior invalid: ${prior.violations?.join("; ") || "?"})`);
          } else {
            throw new Error(`run already exists: ${runId} — pass --resume or use a new --label`);
          }
        }
        process.stdout.write(`  r${rep} ${task.id.padEnd(34)} ${armId.padEnd(6)} ... `);
        const s = await runSession(task, arm);
        const expected = task.kind === "nl" ? task.expected : task.anchor;
        const t = parseTranscript(s.stdout, { expected, wrapperToken: WRAPPER });
        const rl = rateLimitInfo(s.stdout);
        const stop = accountStop(s, t, rl);
        if (stop) {
          // No RECORD is written — a halted session is not data — but the raw stream IS kept,
          // under halted/ rather than transcripts/ so it can never be mistaken for a session.
          // Without it there is no way to tell a real 429 from a detector false positive.
          const haltDir = join(OUT_DIR, "halted");
          mkdirSync(haltDir, { recursive: true });
          writeFileSync(join(haltDir, `${runId}.jsonl`), s.stdout);
          writeFileSync(join(haltDir, `${runId}.stderr.txt`), s.stderr);
          console.log(`ACCOUNT STOP — ${stop.reason}`);
          aborted = { runId, ...stop, turns: t.turns, costUsd: t.costUsd, exitCode: s.code, stderrTail: s.stderr.slice(-600) };
          break outer;
        }
        const grade = gradeTask(task, t.answer);
        const violations = validate({
          arm, toolsOffered: t.toolsOffered, toolCalls: t.toolCalls,
          bashCommands: t.bashCommands,
          wrapperToken: WRAPPER, denials: t.denials, malformedLines: t.malformedLines,
          timedOut: s.timedOut, exitCode: s.code, answerOk: t.answer != null && !t.answer._raw,
        });
        const row = {
          runId, label: LABEL, model: MODEL, effort: EFFORT, rep,
          taskId: task.id, kind: task.kind, tier: task.tier, arm: armId,
          ...t, grade, wallMs: s.wallMs, exitCode: s.code, timedOut: s.timedOut, rateLimit: rl,
          stderrTail: s.stderr.slice(-400), valid: violations.length === 0, violations,
        };
        delete row.bashCommands;
        row.bashCommandSample = t.bashCommands.slice(0, 12).map((c) => ({ kind: c.kind, executed: c.executed, command: c.command.slice(0, 200) }));
        writeFileSync(join(OUT_DIR, "transcripts", `${runId}.jsonl`), s.stdout);
        writeFileSync(resultPath, `${JSON.stringify(row, null, 2)}\n`);
        rows.push(row);
        const pattern = row.graphCalls > 0 && row.fileCalls === 0 ? "graph-only"
          : row.graphCalls === 0 && row.fileCalls > 0 ? "files-only"
          : row.graphCalls > 0 ? "graph-then-files" : "neither";
        console.log(`turns=${t.turns} graph=${row.graphCalls} file=${row.fileCalls} ${pattern} ` +
          `${Math.round(s.wallMs / 1000)}s $${(t.costUsd ?? 0).toFixed(3)} ` +
          `${grade.correct ? "OK " : "-- "}${rl?.utilization != null ? `util=${Math.round(rl.utilization * 100)}% ` : ""}` +
          `${row.valid ? "" : "INVALID: " + violations.join("; ")}`);
      }
    }
  }
} finally {
  const restored = guard.restore();
  if (restored) console.log(`\nindex restored: ${restored.slice(0, 12)}`);
  rmSync(join(OUT_DIR, ".scratch"), { recursive: true, force: true });
}

writeFileSync(join(OUT_DIR, "manifest.json"), JSON.stringify({
  label: LABEL, model: MODEL, effort: EFFORT, arms: ARMS, repeats: REPEATS,
  suiteId: SUITE.id, subject: SUITE.subject, cli: CLI, cliSha256: sha256(CLI),
  indexSnapshot: SNAPSHOT, indexGuard: guardInfo,
  startedAt, completedAt: new Date().toISOString(), sessions: rows.length,
  expectedSessions: total, complete: !aborted && rows.length === total, aborted,
}, null, 2));
console.log(`\nwrote ${rows.length} session records -> ${OUT_DIR}`);

if (aborted) {
  console.log(`\n=== RUN HALTED at ${aborted.runId}: ${aborted.reason} ===`);
  console.log(`${rows.length}/${total} sessions complete on disk. Nothing was written for the halted session.`);
  console.log(`Resume with the identical command plus --resume:\n  ... --label ${LABEL} --resume`);
  if (aborted.stderrTail.trim()) console.log(`stderr tail:\n${aborted.stderrTail}`);
  process.exitCode = 2;
}
const invalid = rows.filter((r) => !r.valid);
if (invalid.length) {
  console.log(`\n${invalid.length} INVALID session(s):`);
  for (const r of invalid) console.log(`  ${r.runId}: ${r.violations.join("; ")}`);
  process.exitCode = 1;
}
