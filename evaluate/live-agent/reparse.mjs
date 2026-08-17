#!/usr/bin/env node
/**
 * Rebuild session records from the saved transcripts.
 *
 * Parsing and policy are downstream of what the agent actually did: fixing a classifier does not
 * change a single byte the model saw. So when the analysis is wrong but the sessions are sound,
 * re-parsing is the correct repair — re-running would spend money to reproduce identical
 * transcripts.
 *
 *   node reparse.mjs --label pm-mex-1
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseTranscript } from "./transcript.mjs";
import { validate } from "./policy.mjs";
import { gradeTask } from "./grade.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const OUT_DIR = resolve(flag("--output", join(HERE, "results", flag("--label", "run-1"))));
const WRAPPER = join(HERE, "mexg.mjs").split("\\").join("/");

const SUITE = JSON.parse(readFileSync(join(HERE, "suite.json"), "utf8"));
const byId = Object.fromEntries(SUITE.tasks.map((t) => [t.id, t]));
const ARM_DEFS = { files: { kind: "files" }, graph: { kind: "graph" } };

const tDir = join(OUT_DIR, "transcripts");
const rDir = join(OUT_DIR, "runs");
let rebuilt = 0, nowValid = 0, stillInvalid = 0;

for (const f of readdirSync(tDir).filter((x) => x.endsWith(".jsonl"))) {
  const runId = f.replace(/\.jsonl$/, "");
  const runPath = join(rDir, `${runId}.json`);
  const prior = JSON.parse(readFileSync(runPath, "utf8"));
  const task = byId[prior.taskId];
  const arm = ARM_DEFS[prior.arm];
  const raw = readFileSync(join(tDir, f), "utf8");

  const expected = task.kind === "nl" ? task.expected : task.anchor;
  const t = parseTranscript(raw, { expected, wrapperToken: WRAPPER });
  const grade = gradeTask(task, t.answer);
  const violations = validate({
    arm, toolsOffered: t.toolsOffered, toolCalls: t.toolCalls, bashCommands: t.bashCommands,
    wrapperToken: WRAPPER, denials: t.denials, malformedLines: t.malformedLines,
    timedOut: prior.timedOut, exitCode: prior.exitCode,
    answerOk: t.answer != null && !t.answer._raw,
  });

  const row = {
    ...prior, ...t, grade, valid: violations.length === 0, violations,
    reparsedAt: new Date().toISOString(),
  };
  delete row.bashCommands;
  row.bashCommandSample = t.bashCommands.slice(0, 12).map((c) => ({ kind: c.kind, executed: c.executed, command: c.command.slice(0, 200) }));
  writeFileSync(runPath, `${JSON.stringify(row, null, 2)}\n`);
  rebuilt += 1;
  if (!prior.valid && row.valid) nowValid += 1;
  if (!row.valid) { stillInvalid += 1; console.log(`  still INVALID ${runId}: ${violations.join("; ")}`); }
}
console.log(`reparsed ${rebuilt} session(s); ${nowValid} became valid; ${stillInvalid} still invalid`);
