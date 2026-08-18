import { mean, round } from "../core/stats.mjs";

export function normalizeRepoPath(path) {
  return typeof path === "string" ? path.replace(/^\.\//, "").replaceAll("\\", "/") : null;
}

export function evidenceKey(evidence) {
  return `${evidence.symbol}\0${evidence.kind}\0${normalizeRepoPath(evidence.path)}`;
}

export function recordEvidenceKey(record) {
  const symbol = typeof record.name === "string" ? record.name : typeof record.symbol === "string" ? record.symbol : null;
  const path = normalizeRepoPath(record.filePath ?? record.path);
  return symbol && typeof record.kind === "string" && path ? `${symbol}\0${record.kind}\0${path}` : null;
}

export function resultRecordsForTask(task, records) {
  const types = task.operation === "scope"
    ? new Set(["fact"])
    : task.operation === "query"
      ? new Set(["result"])
      : new Set(["defines", "caller"]);
  return records.filter((record) => types.has(record.type));
}

function rankEvidence(results, evidence) {
  const key = evidenceKey(evidence);
  const index = results.findIndex((record) => recordEvidenceKey(record) === key);
  return index < 0 ? null : index + 1;
}

function recallAt(ranks, k) {
  return ranks.length ? ranks.filter((rank) => rank !== null && rank <= k).length / ranks.length : null;
}

function dcg(relevance) {
  return relevance.reduce((total, value, index) => total + (value ? 1 / Math.log2(index + 2) : 0), 0);
}

function ndcgAt(results, relevantKeys, k) {
  if (!relevantKeys.size) return null;
  const relevance = results.slice(0, k).map((record) => Number(relevantKeys.has(recordEvidenceKey(record))));
  while (relevance.length < k) relevance.push(0);
  const ideal = Array.from({ length: k }, (_, index) => Number(index < Math.min(k, relevantKeys.size)));
  const idealDcg = dcg(ideal);
  return idealDcg ? dcg(relevance) / idealDcg : null;
}

export function gradeRetrieval(task, records, processResult = {}) {
  const results = resultRecordsForTask(task, records);
  const gold = task.gold ?? [];
  const alternates = task.acceptableAlternates ?? [];
  const prohibited = task.mustNotReturn ?? [];
  const goldRanks = gold.map((evidence) => ({ ...evidence, rank: rankEvidence(results, evidence) }));
  const alternateRanks = alternates.map((evidence) => ({ ...evidence, rank: rankEvidence(results, evidence) }));
  const prohibitedRanks = prohibited.map((evidence) => ({ ...evidence, rank: rankEvidence(results, evidence) }));
  const ranks = goldRanks.map((entry) => entry.rank);
  const firstRelevantRank = [...goldRanks, ...alternateRanks].map((entry) => entry.rank).filter(Number.isFinite).sort((a, b) => a - b)[0] ?? null;
  const relevantKeys = new Set([...gold, ...alternates].map(evidenceKey));
  const relevantTop5 = results.slice(0, 5).filter((record) => relevantKeys.has(recordEvidenceKey(record))).length;
  const errorCodes = records.filter((record) => record.type === "error").map((record) => record.code ?? "UNKNOWN");
  const expectedErrorCodes = task.expect?.errorCodes ?? [];
  const noResultExpected = task.expect?.noResult === true;
  // errorCodes is an allowlist for implementations that represent a negative
  // outcome as an error record. A clean not-found response need not emit one.
  const unexpectedErrorCodes = errorCodes.filter((code) => !expectedErrorCodes.includes(code));
  const errorExpectationMet = unexpectedErrorCodes.length === 0;
  const noResultCorrect = noResultExpected ? results.length === 0 && errorExpectationMet : null;
  const completeEvidence = noResultExpected ? noResultCorrect : ranks.every(Number.isFinite);
  const prohibitedHit = prohibitedRanks.some((entry) => Number.isFinite(entry.rank));
  const summary = records.findLast((record) => record.type === "summary") ?? null;
  const outputChars = String(processResult.stdout ?? "").length;
  const outputTokensApprox = Math.ceil(outputChars / 4);
  const maxOutputTokens = Number(summary?.maxOutputTokens ?? task.options?.maxOutputTokens ?? NaN);
  const estimatedOutputTokens = Number(summary?.estimatedOutputTokens ?? NaN);
  const budgetCompliant = Number.isFinite(maxOutputTokens) && Number.isFinite(estimatedOutputTokens)
    ? estimatedOutputTokens <= maxOutputTokens
    : null;
  const relevantReturned = results.filter((record) => relevantKeys.has(recordEvidenceKey(record))).length;
  return {
    returned: results.length,
    goldCount: gold.length,
    goldRanks,
    alternateRanks,
    prohibitedRanks,
    recallAt1: round(recallAt(ranks, 1)),
    recallAt5: round(recallAt(ranks, 5)),
    recallAt10: round(recallAt(ranks, 10)),
    reciprocalRank: firstRelevantRank ? round(1 / firstRelevantRank) : 0,
    ndcgAt10: round(ndcgAt(results, relevantKeys, 10)),
    precisionAt5: round(relevantTop5 / 5),
    precisionAmongReturnedAt5: round(results.length ? relevantTop5 / Math.min(5, results.length) : 0),
    irrelevantRate: round(results.length ? (results.length - relevantReturned) / results.length : 0),
    completeEvidence,
    noResultCorrect,
    prohibitedHit,
    firstRelevantRank,
    miss: !noResultExpected && firstRelevantRank === null,
    errorCodes,
    unexpectedErrorCodes,
    errorExpectationMet,
    truncated: summary?.truncated ?? null,
    budgetCompliant,
    outputChars,
    outputTokensApprox,
    elapsedMs: processResult.elapsedMs ?? null,
    relevantFactsPer1kTokens: outputTokensApprox ? round(relevantReturned * 1_000 / outputTokensApprox) : 0,
  };
}

export function summarizeRetrievalRows(rows) {
  const valid = rows.filter((row) => row.valid);
  const positive = valid.filter((row) => row.task.expect?.noResult !== true);
  const negative = valid.filter((row) => row.task.expect?.noResult === true);
  const evidenceCount = positive.reduce((total, row) => total + row.metrics.goldCount, 0);
  const evidenceAt = (k) => positive.reduce((total, row) => total + row.metrics.goldRanks.filter((entry) => entry.rank !== null && entry.rank <= k).length, 0);
  return {
    runs: rows.length,
    validRuns: valid.length,
    invalidRuns: rows.length - valid.length,
    recallAt1: evidenceCount ? round(evidenceAt(1) / evidenceCount) : null,
    recallAt5: evidenceCount ? round(evidenceAt(5) / evidenceCount) : null,
    recallAt10: evidenceCount ? round(evidenceAt(10) / evidenceCount) : null,
    mrr: round(mean(positive.map((row) => row.metrics.reciprocalRank))),
    meanNdcgAt10: round(mean(positive.map((row) => row.metrics.ndcgAt10).filter(Number.isFinite))),
    completeEvidenceRate: positive.length ? round(positive.filter((row) => row.metrics.completeEvidence).length / positive.length) : null,
    missRate: positive.length ? round(positive.filter((row) => row.metrics.miss).length / positive.length) : null,
    negativeAccuracy: negative.length ? round(negative.filter((row) => row.metrics.noResultCorrect).length / negative.length) : null,
    prohibitedHitRate: valid.length ? round(valid.filter((row) => row.metrics.prohibitedHit).length / valid.length) : null,
    budgetComplianceRate: valid.filter((row) => row.metrics.budgetCompliant !== null).length
      ? round(valid.filter((row) => row.metrics.budgetCompliant).length / valid.filter((row) => row.metrics.budgetCompliant !== null).length)
      : null,
  };
}
