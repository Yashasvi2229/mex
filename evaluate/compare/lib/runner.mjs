import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ANSWER_SCHEMA, gradeAnswer } from "./answer.mjs";
import { shellQuote, validateTranscriptPolicy } from "./policy.mjs";
import { buildPrompt } from "./prompt.mjs";
import { runTimed } from "./process.mjs";
import { fileHash, GraphDbGuard, repositoryIdentity } from "./prepare.mjs";
import { buildSchedule } from "./schedule.mjs";
import { parseTranscript } from "./transcript.mjs";

function allowedTools(arm, command) {
  if (arm.kind === "grep") return { tools: "Read,Grep,Glob", allowed: ["Read", "Grep", "Glob"] };
  const prefix = command.map(shellQuote).join(" ");
  return { tools: "Read,Grep,Glob,Bash", allowed: ["Read", "Grep", "Glob", `Bash(${prefix} graph *)`, `Bash(${prefix} impact *)`] };
}

export function claudeArgs({ prompt, model, arm, command }) {
  const tools = allowedTools(arm, command);
  return [
    "-p", prompt, "--output-format", "stream-json", "--verbose", "--safe-mode",
    "--no-session-persistence", "--exclude-dynamic-system-prompt-sections",
    "--permission-mode", "dontAsk", "--model", model, "--json-schema", JSON.stringify(ANSWER_SCHEMA),
    "--tools", tools.tools, "--allowedTools", ...tools.allowed,
  ];
}

export async function runSession({ agentCommand = ["claude"], subjectRoot, model, task, armId, arm, armCommands, timeoutMs }) {
  const command = armCommands[armId] ?? [];
  const prompt = buildPrompt(task, armId, arm, command);
  const [agent, ...agentPrefix] = agentCommand;
  const processResult = await runTimed(agent, [...agentPrefix, ...claudeArgs({ prompt, model, arm, command })], { cwd: subjectRoot, timeoutMs });
  const parsed = parseTranscript(processResult.stdout, task.expectedSymbols);
  const violations = validateTranscriptPolicy(parsed.toolCalls, armId, arm, armCommands);
  if (parsed.permissionDenials) violations.push(`${parsed.permissionDenials} permission denial(s)`);
  if (parsed.malformedLines) violations.push(`${parsed.malformedLines} malformed stream line(s)`);
  if (!parsed.structured.ok) violations.push(parsed.structured.error);
  if (processResult.timedOut) violations.push("session timeout");
  if (processResult.code !== 0) violations.push(`agent exited ${processResult.code}`);
  if (parsed.graph.vocabRetries > 1) violations.push("more than one vocabulary retry");
  const answer = parsed.structured.ok ? parsed.structured.value : null;
  return {
    process: { code: processResult.code, signal: processResult.signal, timedOut: processResult.timedOut, elapsedMs: processResult.elapsedMs, stderr: processResult.stderr },
    transcript: processResult.stdout,
    metrics: {
      ...parsed.usage, costUsd: parsed.costUsd, elapsedMs: processResult.elapsedMs, turns: parsed.turns,
      toolCalls: parsed.toolCalls.length, graphCalls: parsed.graph.calls, vocabularyRetries: parsed.graph.vocabRetries,
      fallbacks: arm.kind === "graph" ? parsed.graph.fallbacks : 0, expectedSymbolInitialScopeRank: parsed.graph.initialScopeRank,
      uniqueToolResultChars: parsed.uniqueToolResultChars, uniqueToolResultTokens: parsed.uniqueToolResultTokens,
    },
    answer, grade: answer ? gradeAnswer(answer, task.expectedSymbols) : { correct: false, matchedSymbols: [], answerSymbolRank: null },
    valid: violations.length === 0, violations,
  };
}

export async function runEvaluation({ suite, subjectRoot, outputDir, armCommands, model, timeoutMs = 300_000, resume = false, agentCommand = ["claude"] }) {
  const preparePath = join(outputDir, "prepare.json");
  if (!existsSync(preparePath)) throw new Error(`missing ${preparePath}; run --prepare first`);
  const prepared = JSON.parse(readFileSync(preparePath, "utf8"));
  if (prepared.subject) {
    const currentSubject = repositoryIdentity(subjectRoot);
    if (currentSubject.sha !== prepared.subject.sha || currentSubject.dirty) {
      throw new Error("subject repository no longer matches the prepared fixture");
    }
  }
  for (const [armId, command] of Object.entries(armCommands)) {
    const preparedCli = prepared.cli?.[armId];
    if (!preparedCli) continue;
    if (JSON.stringify(command) !== JSON.stringify(preparedCli.command)) throw new Error(`CLI command changed after prepare for ${armId}`);
    const script = command[0] === process.execPath ? command[1] : command[0];
    if (preparedCli.sha256 && fileHash(script) !== preparedCli.sha256) throw new Error(`CLI bytes changed after prepare for ${armId}`);
  }
  for (const [armId, index] of Object.entries(prepared.indices ?? {})) {
    if (index.sha256 && fileHash(index.path) !== index.sha256) throw new Error(`prepared graph index changed for ${armId}`);
  }
  const schedule = buildSchedule(suite.tasks, Object.keys(suite.arms));
  const runsDir = join(outputDir, "runs"), transcriptsDir = join(outputDir, "transcripts");
  mkdirSync(runsDir, { recursive: true }); mkdirSync(transcriptsDir, { recursive: true });
  const scratch = join(outputDir, ".run-scratch");
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const rows = [];
  const startedAt = new Date().toISOString();
  try {
    for (const item of schedule) {
      const resultPath = join(runsDir, `${item.runId}.json`);
      if (resume && existsSync(resultPath)) { rows.push(JSON.parse(readFileSync(resultPath, "utf8"))); continue; }
      if (!resume && existsSync(resultPath)) throw new Error(`run already exists: ${item.runId}; use --resume or a different --output`);
      const arm = suite.arms[item.armId];
      if (arm.kind === "graph") {
        const snapshot = prepared.indices?.[item.armId]?.path;
        if (!snapshot || !existsSync(snapshot)) throw new Error(`missing prepared graph index for ${item.armId}`);
        guard.activate(snapshot);
      } else guard.clear();
      process.stderr.write(`[eval:compare] ${item.runId}\n`);
      const session = await runSession({ agentCommand, subjectRoot, model, task: item.task, armId: item.armId, arm, armCommands, timeoutMs });
      writeFileSync(join(transcriptsDir, `${item.runId}.jsonl`), session.transcript);
      const row = { runId: item.runId, taskId: item.task.id, arm: item.armId, taskIndex: item.taskIndex, orderIndex: item.orderIndex, ...session };
      delete row.transcript;
      writeFileSync(resultPath, `${JSON.stringify(row, null, 2)}\n`);
      rows.push(row);
      if (!row.valid) throw new Error(`${item.runId} violated evaluation policy: ${row.violations.join("; ")}`);
    }
  } finally { guard.restore(); rmSync(scratch, { recursive: true, force: true }); }
  const manifest = { schemaVersion: 1, suiteId: suite.id, model, startedAt, completedAt: new Date().toISOString(), schedule: schedule.map(({ runId, taskIndex, orderIndex, armId }) => ({ runId, taskIndex, orderIndex, armId })) };
  writeFileSync(join(outputDir, "run-manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return { rows, manifest };
}
