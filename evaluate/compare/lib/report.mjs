import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const DELTA_METRICS = ["processed", "costUsd", "uniqueToolResultChars", "uniqueToolResultTokens", "elapsedMs", "turns", "toolCalls", "graphCalls", "vocabularyRetries", "fallbacks"];

function mean(values) { return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null; }

export function pairedDeltas(rows, armIds) {
  const byTask = Map.groupBy(rows, (row) => row.taskId);
  const pairs = [];
  for (let left = 0; left < armIds.length; left++) {
    for (let right = left + 1; right < armIds.length; right++) {
      const [from, to] = [armIds[left], armIds[right]];
      const perTask = [];
      for (const [taskId, taskRows] of byTask) {
        const a = taskRows.find((row) => row.arm === from), b = taskRows.find((row) => row.arm === to);
        if (!a || !b) continue;
        perTask.push({ taskId, ...Object.fromEntries(DELTA_METRICS.map((metric) => [metric, b.metrics[metric] - a.metrics[metric]])) });
      }
      pairs.push({ from, to, perTask, mean: Object.fromEntries(DELTA_METRICS.map((metric) => [metric, mean(perTask.map((row) => row[metric]))])) });
    }
  }
  return pairs;
}

function blindId(suiteId, runId) {
  return createHash("sha256").update(`${suiteId}\0${runId}`).digest("hex");
}

export function buildBlindReview(suiteId, rows) {
  const shuffled = [...rows].sort((a, b) => blindId(suiteId, a.runId).localeCompare(blindId(suiteId, b.runId)));
  const answers = shuffled.map((row, index) => ({
    blindId: `A${String(index + 1).padStart(3, "0")}`,
    taskId: row.taskId,
    answer: row.answer,
    manual: { correct: null, complete: null, unsupportedClaims: null, adjudicated: null, notes: "" },
  }));
  const reveal = Object.fromEntries(answers.map((answer, index) => [answer.blindId, { runId: shuffled[index].runId, arm: shuffled[index].arm }]));
  return { answers, reveal };
}

export function generateReport({ suite, outputDir, rows: suppliedRows }) {
  const runsDir = join(outputDir, "runs");
  const rows = suppliedRows ?? readdirSync(runsDir).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")));
  const armIds = Object.keys(suite.arms);
  const byArm = Object.fromEntries(armIds.map((armId) => {
    const armRows = rows.filter((row) => row.arm === armId);
    return [armId, {
      runs: armRows.length,
      valid: armRows.filter((row) => row.valid).length,
      correct: armRows.filter((row) => row.grade.correct).length,
      complete: armRows.filter((row) => row.answer?.complete).length,
      meanProcessedTokens: mean(armRows.map((row) => row.metrics.processed)),
      meanCostUsd: mean(armRows.map((row) => row.metrics.costUsd)),
      meanFallbacks: mean(armRows.map((row) => row.metrics.fallbacks)),
      meanInitialScopeRank: mean(armRows.map((row) => row.metrics.expectedSymbolInitialScopeRank).filter(Number.isFinite)),
    }];
  }));
  const executionValid = rows.length === suite.tasks.length * armIds.length && rows.every((row) => row.valid);
  const blindPath = join(outputDir, "blind-review.json"), revealPath = join(outputDir, "blind-reveal.json");
  const blind = existsSync(blindPath)
    ? { answers: JSON.parse(readFileSync(blindPath, "utf8")), reveal: JSON.parse(readFileSync(revealPath, "utf8")) }
    : buildBlindReview(suite.id, rows);
  const manuallyScored = blind.answers.length === rows.length && blind.answers.every((item) =>
    typeof item.manual?.correct === "boolean" && typeof item.manual?.complete === "boolean" && typeof item.manual?.unsupportedClaims === "boolean",
  );
  const rowById = new Map(rows.map((row) => [row.runId, row]));
  const disagreements = blind.answers.flatMap((item) => {
    const row = rowById.get(blind.reveal[item.blindId]?.runId);
    return row && typeof item.manual?.correct === "boolean" && item.manual.correct !== row.grade.correct
      ? [{ blindId: item.blindId, runId: row.runId, automatic: row.grade.correct, manual: item.manual.correct, adjudicated: item.manual.adjudicated === true }]
      : [];
  });
  const disagreementsAdjudicated = disagreements.every((item) => item.adjudicated);
  const pilotValid = executionValid && manuallyScored && disagreementsAdjudicated;
  const roleId = (role, fallback) => Object.keys(suite.arms).find((id) => suite.arms[id].role === role) ?? (suite.arms[fallback] ? fallback : null);
  const controlIds = [roleId("control", "grep"), roleId("released", "baseline")].filter(Boolean);
  const patchedId = roleId("patched", "patched");
  const correctness = Object.fromEntries(armIds.map((armId) => [armId, rows.filter((row) => row.arm === armId && row.grade.correct).length]));
  const noCorrectnessRegression = Boolean(patchedId) && controlIds.every((armId) => correctness[patchedId] >= correctness[armId]);
  const baselineId = roleId("released", "baseline");
  const baselineToPatched = baselineId && patchedId
    ? pairedDeltas(rows, [baselineId, patchedId])[0]
    : null;
  const baselineRank = baselineId ? byArm[baselineId]?.meanInitialScopeRank : null;
  const patchedRank = patchedId ? byArm[patchedId]?.meanInitialScopeRank : null;
  const improvements = {
    retrievalRank: patchedRank !== null && (baselineRank === null || patchedRank < baselineRank),
    fallbackBehavior: Boolean(baselineId && patchedId && byArm[patchedId].meanFallbacks < byArm[baselineId].meanFallbacks),
    pairedProcessedTokens: Boolean(baselineToPatched && baselineToPatched.mean.processed < 0),
    pairedCost: Boolean(baselineToPatched && baselineToPatched.mean.costUsd < 0),
  };
  const decision = {
    descriptivePilotOnly: true,
    noCorrectnessRegression,
    improvements,
    patchedWin: pilotValid && noCorrectnessRegression && Object.values(improvements).some(Boolean),
  };
  const report = {
    schemaVersion: 1, suiteId: suite.id, generatedAt: new Date().toISOString(),
    executionValid, manuallyScored, disagreementsAdjudicated, pilotValid, disagreements,
    runCount: rows.length, expectedRunCount: suite.tasks.length * armIds.length,
    byArm, pairedDeltas: pairedDeltas(rows, armIds), decision,
  };
  writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!existsSync(blindPath)) writeFileSync(blindPath, `${JSON.stringify(blind.answers, null, 2)}\n`);
  if (!existsSync(revealPath)) writeFileSync(revealPath, `${JSON.stringify(blind.reveal, null, 2)}\n`);
  return report;
}

export function loadRows(outputDir) {
  const runsDir = join(outputDir, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")));
}
