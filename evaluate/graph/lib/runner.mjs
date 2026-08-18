import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { GraphDbGuard } from "../../core/artifacts.mjs";
import { commandBundleIdentity, fileHash, objectHash, repositoryIdentity } from "../../core/hash.mjs";
import { parseJsonLines, validateGraphResponse } from "../../core/jsonl.mjs";
import { runProcess } from "../../core/process.mjs";
import { gradeRetrieval } from "../../graders/retrieval.mjs";
import { expectedGraphCommand, graphSuiteHash, graphTaskArgs } from "../../schemas/graph-suite.mjs";
import { loadPreparedGraphEvaluation } from "./prepare.mjs";

function safeId(value) {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export function buildGraphSchedule(suite) {
  const systems = Object.keys(suite.systems);
  return suite.tasks.flatMap((task, taskIndex) => {
    const offset = taskIndex % systems.length;
    const order = [...systems.slice(offset), ...systems.slice(0, offset)];
    return order.map((systemId, orderIndex) => ({
      runId: `${String(taskIndex + 1).padStart(3, "0")}-${safeId(task.id)}--${safeId(systemId)}`,
      taskIndex,
      orderIndex,
      task,
      systemId,
    }));
  });
}

function assertPreparedIdentity({ suite, subjectRoot, systemCommands, prepared }) {
  if (graphSuiteHash(suite) !== prepared.suiteSha256) throw new Error("suite or task fixture changed after preparation");
  const subject = repositoryIdentity(subjectRoot);
  if (subject.sha !== prepared.subject.sha || subject.treeStateSha256 !== prepared.subject.treeStateSha256) {
    throw new Error("subject repository changed after preparation");
  }
  for (const [systemId, command] of Object.entries(systemCommands)) {
    const system = prepared.systems?.[systemId];
    if (!system) throw new Error(`system ${systemId} was not prepared`);
    if (JSON.stringify(command) !== JSON.stringify(system.command)) throw new Error(`system ${systemId} command changed after preparation`);
    const bundle = commandBundleIdentity(command);
    if (bundle.bundleSha256 !== system.cli.bundleSha256) throw new Error(`system ${systemId} CLI bundle changed after preparation`);
    if (!existsSync(system.index.path) || fileHash(system.index.path) !== system.index.sha256) {
      throw new Error(`system ${systemId} graph snapshot changed after preparation`);
    }
  }
}

function existingResult(path, expected) {
  const row = JSON.parse(readFileSync(path, "utf8"));
  if (row.runIdentity !== expected.runIdentity || row.runId !== expected.runId || row.taskId !== expected.taskId || row.system !== expected.system) {
    throw new Error(`resume identity mismatch in ${path}`);
  }
  return row;
}

export async function runGraphEvaluation({
  suite,
  subjectRoot,
  outputDir,
  systemCommands,
  timeoutMs = 120_000,
  maxOutputBytes = 32 * 1024 * 1024,
  resume = false,
}) {
  const prepared = loadPreparedGraphEvaluation(outputDir);
  assertPreparedIdentity({ suite, subjectRoot, systemCommands, prepared });
  const schedule = buildGraphSchedule(suite);
  const runConfig = { timeoutMs, maxOutputBytes };
  const runIdentity = objectHash({ preparedRunIdentity: prepared.runIdentity, runConfig, schedule: schedule.map(({ runId, taskIndex, orderIndex, systemId }) => ({ runId, taskIndex, orderIndex, systemId })) });
  const runsDir = join(outputDir, "runs");
  const rawDir = join(outputDir, "raw", "queries");
  const scratch = join(outputDir, ".run-scratch");
  mkdirSync(runsDir, { recursive: true });
  mkdirSync(rawDir, { recursive: true });
  const manifestPath = join(outputDir, "run-manifest.json");
  if (existsSync(manifestPath)) {
    const previous = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (!resume) throw new Error(`run manifest already exists: ${manifestPath}; use --resume or a new output directory`);
    if (previous.runIdentity !== runIdentity) throw new Error("resume run identity does not match the existing manifest");
  }
  const startedAt = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")).startedAt : new Date().toISOString();
  const baseManifest = {
    schemaVersion: 2,
    suiteId: suite.id,
    preparedRunIdentity: prepared.runIdentity,
    runIdentity,
    runConfig,
    startedAt,
    status: "running",
    schedule: schedule.map(({ runId, taskIndex, orderIndex, systemId }) => ({ runId, taskIndex, orderIndex, systemId })),
  };
  writeFileSync(manifestPath, `${JSON.stringify(baseManifest, null, 2)}\n`);
  const guard = new GraphDbGuard(subjectRoot, scratch);
  const rows = [];
  try {
    for (const item of schedule) {
      const resultPath = join(runsDir, `${item.runId}.json`);
      const expectedIdentity = { runIdentity, runId: item.runId, taskId: item.task.id, system: item.systemId };
      if (existsSync(resultPath)) {
        if (!resume) throw new Error(`result already exists: ${resultPath}`);
        const rawStdout = join(rawDir, `${item.runId}.stdout.jsonl`);
        const rawStderr = join(rawDir, `${item.runId}.stderr.txt`);
        if (!existsSync(rawStdout) || !existsSync(rawStderr)) throw new Error(`resume result is missing raw output: ${item.runId}`);
        rows.push(existingResult(resultPath, expectedIdentity));
        continue;
      }
      const preparedSystem = prepared.systems[item.systemId];
      guard.activate(preparedSystem.index.path);
      const command = systemCommands[item.systemId];
      const args = [...command.slice(1), ...graphTaskArgs(item.task)];
      process.stderr.write(`[eval:graph] ${item.runId}\n`);
      const processResult = await runProcess(command[0], args, { cwd: subjectRoot, timeoutMs, maxOutputBytes });
      writeFileSync(join(rawDir, `${item.runId}.stdout.jsonl`), processResult.stdout);
      writeFileSync(join(rawDir, `${item.runId}.stderr.txt`), processResult.stderr);
      const parsed = parseJsonLines(processResult.stdout, item.runId);
      const allowError = item.task.expect?.noResult === true || (item.task.expect?.errorCodes?.length ?? 0) > 0;
      const violations = [...parsed.errors];
      if (processResult.timedOut) violations.push("command timed out");
      if (processResult.error) violations.push(`command error: ${processResult.error.message}`);
      if (processResult.code !== 0) violations.push(`command exited ${processResult.code}`);
      violations.push(...validateGraphResponse(parsed.records, expectedGraphCommand(item.task), {
        allowErrorRecords: allowError,
        allowTerminalError: allowError,
      }));
      const metrics = gradeRetrieval(item.task, parsed.records, processResult);
      if (!metrics.errorExpectationMet) {
        violations.push(
          `unexpected error code(s) ${metrics.unexpectedErrorCodes.join(", ")}; allowed codes are `
          + `${(item.task.expect?.errorCodes ?? []).join(", ") || "none"}`,
        );
      }
      const row = {
        schemaVersion: 2,
        ...expectedIdentity,
        taskIndex: item.taskIndex,
        orderIndex: item.orderIndex,
        task: item.task,
        command: processResult.command,
        process: {
          code: processResult.code,
          signal: processResult.signal,
          timedOut: processResult.timedOut,
          elapsedMs: processResult.elapsedMs,
          stdoutBytes: processResult.stdoutBytes,
          stderrBytes: processResult.stderrBytes,
        },
        metrics,
        valid: violations.length === 0,
        violations,
      };
      writeFileSync(resultPath, `${JSON.stringify(row, null, 2)}\n`);
      rows.push(row);
    }
  } finally {
    guard.restore();
    rmSync(scratch, { recursive: true, force: true });
  }
  const manifest = { ...baseManifest, status: "complete", completedAt: new Date().toISOString(), resultCount: rows.length };
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  return { rows, manifest, prepared };
}

export function loadGraphRows(outputDir) {
  const manifestPath = join(outputDir, "run-manifest.json");
  if (!existsSync(manifestPath)) throw new Error(`missing run manifest: ${manifestPath}`);
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  return manifest.schedule.map((item) => {
    const path = join(outputDir, "runs", `${item.runId}.json`);
    if (!existsSync(path)) return null;
    return JSON.parse(readFileSync(path, "utf8"));
  }).filter(Boolean);
}
