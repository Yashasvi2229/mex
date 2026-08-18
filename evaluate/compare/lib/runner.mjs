import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { getAgentAdapter } from "../../adapters/agents/index.mjs";
import { commandBundleIdentity, objectHash } from "../../core/hash.mjs";
import { ANSWER_SCHEMA, gradeAnswer } from "./answer.mjs";
import { shellQuote, validateTranscriptPolicy } from "./policy.mjs";
import { buildPrompt } from "./prompt.mjs";
import { runTimed } from "./process.mjs";
import { fileHash, GraphDbGuard, repositoryIdentity, worktreeDiffHash } from "./prepare.mjs";
import { buildSchedule } from "./schedule.mjs";
import { suiteHash } from "./suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const GRAPH_COMMAND = join(HERE, "graph-command.mjs");

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

export async function runSession({ agentCommand, agentId = "claude", policy = "forced-first", subjectRoot, model, task, armId, arm, armCommands, timeoutMs }) {
  const adapter = getAgentAdapter(agentId);
  const sessionRoot = mkdtempSync(join(tmpdir(), `mex-agent-${agentId}-`));
  const sessionCommands = {};
  try {
    for (const [id, realCommand] of Object.entries(armCommands)) {
      const configPath = join(sessionRoot, `${id}-graph-command.json`);
      writeFileSync(configPath, `${JSON.stringify({ subjectRoot, command: realCommand }, null, 2)}\n`);
      sessionCommands[id] = [process.execPath, GRAPH_COMMAND, configPath];
    }
    const command = sessionCommands[armId] ?? [];
    const prompt = buildPrompt(task, armId, arm, command, subjectRoot, policy);
    const schemaPath = join(sessionRoot, "answer-schema.json");
    writeFileSync(schemaPath, `${JSON.stringify(ANSWER_SCHEMA, null, 2)}\n`);
    const defaultCommand = agentId === "codex" ? ["codex"] : ["claude"];
    const [agent, ...agentPrefix] = agentCommand ?? defaultCommand;
    const toolPolicy = allowedTools(arm, command);
    const invocation = adapter.buildInvocation({
      executable: agent,
      prefix: agentPrefix,
      prompt,
      model,
      schema: ANSWER_SCHEMA,
      schemaPath,
      subjectRoot,
      tools: toolPolicy.tools,
      allowedTools: toolPolicy.allowed,
    });
    const processResult = await runTimed(invocation.command, invocation.args, { cwd: sessionRoot, timeoutMs });
    const parsed = adapter.parseTranscript(processResult.stdout, task);
    const violations = validateTranscriptPolicy(parsed.toolCalls, armId, arm, sessionCommands, {
      allowFileShell: agentId === "codex",
      requireGraphFirst: policy === "forced-first",
    });
  if (parsed.permissionDenials) violations.push(`${parsed.permissionDenials} permission denial(s)`);
  if (parsed.malformedLines) violations.push(`${parsed.malformedLines} malformed stream line(s)`);
  if (!parsed.structured.ok) violations.push(parsed.structured.error);
  if (processResult.timedOut) violations.push("session timeout");
  if (processResult.code !== 0) violations.push(`agent exited ${processResult.code}`);
  if (parsed.graph.vocab > 1) violations.push("more than one vocabulary retry");
  const answer = parsed.structured.ok ? parsed.structured.value : null;
  const usage = parsed.usage;
  return {
    process: { code: processResult.code, signal: processResult.signal, timedOut: processResult.timedOut, elapsedMs: processResult.elapsedMs, stderr: processResult.stderr },
    promptSha256: objectHash(prompt),
    agent: agentId,
    policy,
    transcript: processResult.stdout,
    metrics: {
      uncachedInput: usage.uncachedInput, cacheCreation: usage.cacheWrite, cacheWrite: usage.cacheWrite,
      cacheRead: usage.cacheRead, output: usage.output, processed: usage.reportedTotal,
      reportedTotal: usage.reportedTotal, newTokens: usage.newTokens, cacheUseRatio: usage.cacheUseRatio,
      rawUsage: usage.raw, costUsd: usage.reportedCostUsd, elapsedMs: processResult.elapsedMs, turns: parsed.turns,
      toolCalls: parsed.toolCalls.length, graphCalls: parsed.graph.calls, scopeCalls: parsed.graph.scope,
      distinctScopeQueries: parsed.graph.distinctScopeQueries, vocabularyRetries: parsed.graph.vocab,
      fallbacks: arm.kind === "graph" ? parsed.graph.fallbacks : 0, expectedSymbolInitialScopeRank: parsed.graph.initialScopeRank,
      uniqueToolResultChars: parsed.toolResultChars, uniqueToolResultTokens: parsed.toolResultTokensApprox,
      toolErrors: parsed.toolErrors,
    },
    answer, grade: answer ? gradeAnswer(answer, task, subjectRoot) : { correct: false, matchedSymbols: [], missingSymbols: task.expectedSymbols ?? task.gold?.map((entry) => entry.symbol) ?? [], answerSymbolRank: null },
    valid: violations.length === 0, violations,
  };
  } finally {
    rmSync(sessionRoot, { recursive: true, force: true });
  }
}

export async function runEvaluation({ suite, subjectRoot, outputDir, armCommands, model, timeoutMs = 300_000, resume = false, agentCommand, agentId = "claude", policy = "forced-first", repetitions = 1 }) {
  const preparePath = join(outputDir, "prepare.json");
  if (!existsSync(preparePath)) throw new Error(`missing ${preparePath}; run --prepare first`);
  const prepared = JSON.parse(readFileSync(preparePath, "utf8"));
  if (prepared.suiteSha256 && prepared.suiteSha256 !== suiteHash(suite)) throw new Error("suite changed after preparation");
  if (prepared.subject) {
    const currentSubject = repositoryIdentity(subjectRoot);
    const currentDiff = worktreeDiffHash(subjectRoot);
    if (currentSubject.sha !== prepared.subject.sha || currentDiff !== prepared.subject.diffSha256) {
      throw new Error("subject repository no longer matches the prepared fixture");
    }
  }
  for (const [armId, command] of Object.entries(armCommands)) {
    const preparedCli = prepared.cli?.[armId];
    if (!preparedCli) continue;
    if (JSON.stringify(command) !== JSON.stringify(preparedCli.command)) throw new Error(`CLI command changed after prepare for ${armId}`);
    const script = command[0] === process.execPath ? command[1] : command[0];
    if (preparedCli.sha256 && fileHash(script) !== preparedCli.sha256) throw new Error(`CLI bytes changed after prepare for ${armId}`);
    if (preparedCli.bundleSha256 && commandBundleIdentity(command).bundleSha256 !== preparedCli.bundleSha256) throw new Error(`CLI bundle changed after prepare for ${armId}`);
  }
  for (const [armId, index] of Object.entries(prepared.indices ?? {})) {
    if (index.sha256 && fileHash(index.path) !== index.sha256) throw new Error(`prepared graph index changed for ${armId}`);
  }
  const schedule = buildSchedule(suite.tasks, Object.keys(suite.arms), repetitions);
  const runsDir = join(outputDir, "runs"), transcriptsDir = join(outputDir, "transcripts");
  mkdirSync(runsDir, { recursive: true }); mkdirSync(transcriptsDir, { recursive: true });
  const manifestPath = join(outputDir, "run-manifest.json");
  const runIdentity = objectHash({
    prepare: fileHash(preparePath),
    suiteId: suite.id,
    model,
    agentId,
    policy,
    repetitions,
    timeoutMs,
    agentCommand: agentCommand ?? null,
    schedule: schedule.map(({ runId, taskIndex, repetition, orderIndex, armId }) => ({ runId, taskIndex, repetition, orderIndex, armId })),
  });
  if (existsSync(manifestPath)) {
    const existing = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!resume) throw new Error(`run manifest already exists: ${manifestPath}`);
    if (existing.runIdentity !== runIdentity) throw new Error("resume run identity does not match model, agent, policy, repetitions, timeout, suite, or prepared artifacts");
  }
  const scratch = join(outputDir, ".run-scratch");
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const rows = [];
  const startedAt = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).startedAt : new Date().toISOString();
  const baseManifest = {
    schemaVersion: 2, suiteId: suite.id, runIdentity, model, agent: agentId, policy, repetitions, timeoutMs, startedAt, status: "running",
    schedule: schedule.map(({ runId, taskIndex, repetition, orderIndex, armId }) => ({ runId, taskIndex, repetition, orderIndex, armId })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`);
  try {
    for (const item of schedule) {
      const resultPath = join(runsDir, `${item.runId}.json`);
      if (resume && existsSync(resultPath)) {
        const existing = JSON.parse(readFileSync(resultPath, "utf8"));
        if (existing.runIdentity !== runIdentity || existing.runId !== item.runId) throw new Error(`resume identity mismatch: ${item.runId}`);
        if (!existsSync(join(transcriptsDir, `${item.runId}.jsonl`))) throw new Error(`resume transcript missing: ${item.runId}`);
        rows.push(existing);
        continue;
      }
      if (!resume && existsSync(resultPath)) throw new Error(`run already exists: ${item.runId}; use --resume or a different --output`);
      const arm = suite.arms[item.armId];
      if (arm.kind === "graph") {
        const snapshot = prepared.indices?.[item.armId]?.path;
        if (!snapshot || !existsSync(snapshot)) throw new Error(`missing prepared graph index for ${item.armId}`);
        guard.activate(snapshot);
      } else guard.clear();
      process.stderr.write(`[eval:compare] ${item.runId}\n`);
      const session = await runSession({ agentCommand, agentId, policy, subjectRoot, model, task: item.task, armId: item.armId, arm, armCommands, timeoutMs });
      writeFileSync(join(transcriptsDir, `${item.runId}.jsonl`), session.transcript);
      const row = { runIdentity, runId: item.runId, taskId: item.task.id, arm: item.armId, taskIndex: item.taskIndex, repetition: item.repetition, orderIndex: item.orderIndex, ...session };
      delete row.transcript;
      writeFileSync(resultPath, `${JSON.stringify(row, null, 2)}\n`);
      rows.push(row);
    }
  } finally { guard.restore(); rmSync(scratch, { recursive: true, force: true }); }
  const manifest = { ...baseManifest, status: "complete", completedAt: new Date().toISOString(), resultCount: rows.length };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { rows, manifest };
}
