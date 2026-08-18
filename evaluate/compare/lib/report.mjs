import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { bootstrapMeanInterval, distribution, mean, round, sum } from "../../core/stats.mjs";
import { objectHash } from "../../core/hash.mjs";
import { suiteHash } from "./suite.mjs";

const DELTA_METRICS = [
  "newTokens", "uncachedInput", "cacheWrite", "cacheRead", "output", "reportedTotal", "processed", "costUsd",
  "uniqueToolResultChars", "uniqueToolResultTokens", "elapsedMs", "turns", "toolCalls", "graphCalls",
  "scopeCalls", "distinctScopeQueries", "vocabularyRetries", "fallbacks",
];

function numericDelta(a, b) {
  return Number.isFinite(a) && Number.isFinite(b) ? b - a : null;
}

export function pairedDeltas(rows, armIds) {
  const byPair = Map.groupBy(rows, (row) => `${row.taskId}\0${row.repetition ?? 1}`);
  const pairs = [];
  for (let left = 0; left < armIds.length; left++) {
    for (let right = left + 1; right < armIds.length; right++) {
      const [from, to] = [armIds[left], armIds[right]];
      const matched = [];
      for (const taskRows of byPair.values()) {
        const a = taskRows.find((row) => row.arm === from);
        const b = taskRows.find((row) => row.arm === to);
        if (!a || !b || a.valid === false || b.valid === false) continue;
        matched.push({
          taskId: a.taskId,
          repetition: a.repetition ?? 1,
          ...Object.fromEntries(DELTA_METRICS.map((metric) => [metric, numericDelta(a.metrics[metric], b.metrics[metric])])),
        });
      }
      const means = {};
      const confidence95 = {};
      for (const metric of DELTA_METRICS) {
        const values = matched.map((row) => row[metric]).filter(Number.isFinite);
        means[metric] = round(mean(values));
        const interval = bootstrapMeanInterval(values);
        confidence95[metric] = { low: round(interval.low), high: round(interval.high), samples: interval.samples };
      }
      pairs.push({ from, to, matchedPairs: matched.length, perTaskRepetition: matched, perTask: matched, mean: means, confidence95 });
    }
  }
  return pairs;
}

function blindId(suiteId, runId) {
  return objectHash(`${suiteId}\0${runId}`);
}

function reviewIdentity(suiteId, runIdentity, rows) {
  return objectHash({ suiteId, runIdentity, rows: [...rows].sort((a, b) => a.runId.localeCompare(b.runId)).map((row) => ({ runId: row.runId, answer: row.answer })) });
}

export function buildBlindReview(suiteId, rows, runIdentity = null) {
  const identity = reviewIdentity(suiteId, runIdentity, rows);
  const shuffled = [...rows].sort((a, b) => blindId(suiteId, a.runId).localeCompare(blindId(suiteId, b.runId)));
  const answers = shuffled.map((row, index) => ({
    blindId: `A${String(index + 1).padStart(3, "0")}`,
    taskId: row.taskId,
    repetition: row.repetition ?? 1,
    answer: row.answer,
    manual: { correct: null, complete: null, unsupportedClaims: null, adjudicated: null, notes: "" },
  }));
  const reveal = Object.fromEntries(answers.map((answer, index) => [answer.blindId, { runId: shuffled[index].runId, arm: shuffled[index].arm }]));
  return {
    answersDocument: { schemaVersion: 2, reviewIdentity: identity, answers },
    revealDocument: { schemaVersion: 2, reviewIdentity: identity, reveal },
  };
}

function readBlindFiles(blindPath, revealPath, generated) {
  if (!existsSync(blindPath) || !existsSync(revealPath)) return { ...generated, validIdentity: true, existing: false };
  const answersRaw = JSON.parse(readFileSync(blindPath, "utf8"));
  const revealRaw = JSON.parse(readFileSync(revealPath, "utf8"));
  const answersDocument = Array.isArray(answersRaw) ? { schemaVersion: 1, reviewIdentity: null, answers: answersRaw } : answersRaw;
  const revealDocument = revealRaw?.reveal ? revealRaw : { schemaVersion: 1, reviewIdentity: null, reveal: revealRaw };
  return {
    answersDocument,
    revealDocument,
    validIdentity: answersDocument.reviewIdentity === generated.answersDocument.reviewIdentity
      && revealDocument.reviewIdentity === generated.revealDocument.reviewIdentity,
    existing: true,
  };
}

function summarizeArm(armRows) {
  const valid = armRows.filter((row) => row.valid);
  const scopeRows = valid.filter((row) => Number(row.metrics.scopeCalls ?? row.metrics.graphCalls) > 0);
  const finite = (metric) => valid.map((row) => row.metrics[metric]).filter(Number.isFinite);
  const usage = {};
  for (const metric of ["uncachedInput", "cacheWrite", "cacheRead", "output", "reportedTotal", "newTokens", "costUsd"]) {
    usage[metric] = distribution(finite(metric));
    usage[metric].total = finite(metric).length ? round(sum(finite(metric))) : null;
  }
  return {
    runs: armRows.length,
    valid: valid.length,
    automaticCorrect: valid.filter((row) => row.grade.correct).length,
    complete: valid.filter((row) => row.answer?.complete).length,
    usage,
    meanCacheUseRatio: round(mean(finite("cacheUseRatio"))),
    meanFallbacks: round(mean(finite("fallbacks"))),
    meanScopeCalls: round(mean(finite("scopeCalls"))),
    meanDistinctScopeQueries: round(mean(finite("distinctScopeQueries"))),
    initialScopeRecallAt5: scopeRows.length ? round(scopeRows.filter((row) => Number.isFinite(row.metrics.expectedSymbolInitialScopeRank) && row.metrics.expectedSymbolInitialScopeRank <= 5).length / scopeRows.length) : null,
    initialScopeMissRate: scopeRows.length ? round(scopeRows.filter((row) => !Number.isFinite(row.metrics.expectedSymbolInitialScopeRank)).length / scopeRows.length) : null,
    initialScopeMrr: scopeRows.length ? round(mean(scopeRows.map((row) => Number.isFinite(row.metrics.expectedSymbolInitialScopeRank) ? 1 / row.metrics.expectedSymbolInitialScopeRank : 0))) : null,
    latencyMs: distribution(finite("elapsedMs")),
    toolResultChars: distribution(finite("uniqueToolResultChars")),
  };
}

function manualLabels(blind, rows) {
  const byRun = new Map();
  for (const item of blind.answersDocument.answers) {
    const runId = blind.revealDocument.reveal[item.blindId]?.runId;
    if (runId) byRun.set(runId, item.manual);
  }
  return rows.map((row) => ({ row, manual: byRun.get(row.runId) }));
}

export function generateReport({ suite, outputDir, rows: suppliedRows }) {
  const rows = suppliedRows ?? loadRows(outputDir);
  const preparePath = join(outputDir, "prepare.json");
  if (existsSync(preparePath)) {
    const prepared = JSON.parse(readFileSync(preparePath, "utf8"));
    if (prepared.suiteSha256 && prepared.suiteSha256 !== suiteHash(suite)) throw new Error("suite changed after preparation");
  }
  const manifestPath = join(outputDir, "run-manifest.json");
  const runManifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, "utf8")) : null;
  const runIdentity = runManifest?.runIdentity ?? null;
  const armIds = Object.keys(suite.arms);
  const byArm = Object.fromEntries(armIds.map((armId) => [armId, summarizeArm(rows.filter((row) => row.arm === armId))]));
  const expectedRunCount = runManifest?.schedule?.length ?? suite.tasks.length * armIds.length;
  const executionValid = rows.length === expectedRunCount && rows.every((row) => row.valid)
    && (!runIdentity || rows.every((row) => row.runIdentity === runIdentity));
  const blindPath = join(outputDir, "blind-review.json");
  const revealPath = join(outputDir, "blind-reveal.json");
  const generatedBlind = buildBlindReview(suite.id, rows, runIdentity);
  const blind = readBlindFiles(blindPath, revealPath, generatedBlind);
  const labels = manualLabels(blind, rows);
  const manuallyScored = blind.validIdentity && labels.length === rows.length && labels.every(({ manual }) =>
    typeof manual?.correct === "boolean" && typeof manual?.complete === "boolean" && typeof manual?.unsupportedClaims === "boolean",
  );
  const disagreements = labels.flatMap(({ row, manual }) => {
    return row && typeof manual?.correct === "boolean" && manual.correct !== row.grade.correct
      ? [{ runId: row.runId, automatic: row.grade.correct, manual: manual.correct, adjudicated: manual.adjudicated === true }]
      : [];
  });
  const disagreementsAdjudicated = disagreements.every((item) => item.adjudicated);
  const pilotValid = executionValid && manuallyScored && disagreementsAdjudicated;
  const roleId = (role, fallback) => Object.keys(suite.arms).find((id) => suite.arms[id].role === role) ?? (suite.arms[fallback] ? fallback : null);
  const controlIds = [roleId("control", "grep"), roleId("released", "baseline")].filter(Boolean);
  const patchedId = roleId("patched", "patched");
  const finalCorrectness = Object.fromEntries(armIds.map((armId) => [armId, rows.filter((row) => row.arm === armId).reduce((count, row) => {
    if (!manuallyScored) return count + Number(row.grade.correct);
    const manual = labels.find((entry) => entry.row.runId === row.runId)?.manual;
    return count + Number(manual?.correct === true);
  }, 0)]));
  const noCorrectnessRegression = Boolean(patchedId) && controlIds.every((armId) => finalCorrectness[patchedId] >= finalCorrectness[armId]);
  const baselineId = roleId("released", "baseline");
  const allDeltas = pairedDeltas(rows, armIds);
  const baselineToPatched = allDeltas.find((entry) => entry.from === baselineId && entry.to === patchedId)
    ?? allDeltas.find((entry) => entry.from === patchedId && entry.to === baselineId);
  const signed = baselineToPatched?.from === baselineId ? 1 : -1;
  const improvements = {
    retrievalMrr: Boolean(baselineId && patchedId && byArm[patchedId].initialScopeMrr > byArm[baselineId].initialScopeMrr),
    fallbackBehavior: Boolean(baselineId && patchedId && byArm[patchedId].meanFallbacks < byArm[baselineId].meanFallbacks),
    pairedNewTokens: Boolean(baselineToPatched && Number.isFinite(baselineToPatched.mean.newTokens) && signed * baselineToPatched.mean.newTokens < 0),
    pairedCost: Boolean(baselineToPatched && Number.isFinite(baselineToPatched.mean.costUsd) && signed * baselineToPatched.mean.costUsd < 0),
  };
  const decision = {
    descriptivePilotOnly: true,
    usesManualFinalLabels: manuallyScored,
    noCorrectnessRegression,
    improvements,
    patchedWin: pilotValid && noCorrectnessRegression && Object.values(improvements).some(Boolean),
  };
  const report = {
    schemaVersion: 2,
    suiteId: suite.id,
    runIdentity,
    generatedAt: new Date().toISOString(),
    executionValid,
    reviewIdentityValid: blind.validIdentity,
    manuallyScored,
    disagreementsAdjudicated,
    pilotValid,
    disagreements,
    runCount: rows.length,
    expectedRunCount,
    byArm,
    pairedDeltas: allDeltas,
    finalCorrectness,
    decision,
  };
  writeFileSync(join(outputDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  if (!blind.existing) {
    writeFileSync(blindPath, `${JSON.stringify(blind.answersDocument, null, 2)}\n`);
    writeFileSync(revealPath, `${JSON.stringify(blind.revealDocument, null, 2)}\n`);
  }
  return report;
}

export function loadRows(outputDir) {
  const runsDir = join(outputDir, "runs");
  if (!existsSync(runsDir)) return [];
  return readdirSync(runsDir).filter((name) => name.endsWith(".json")).sort().map((name) => JSON.parse(readFileSync(join(runsDir, name), "utf8")));
}
