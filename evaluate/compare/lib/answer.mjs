import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export const ANSWER_SCHEMA = {
  type: "object",
  additionalProperties: false,
  properties: {
    answer: { type: "string" },
    symbols: { type: "array", items: { type: "string" } },
    evidence: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: { path: { type: "string" }, line: { type: "integer", minimum: 1 } },
        required: ["path", "line"],
      },
    },
    complete: { type: "boolean" },
  },
  required: ["answer", "symbols", "evidence", "complete"],
};

export function parseStructuredAnswer(value) {
  let answer = value;
  if (typeof answer === "string") {
    const trimmed = answer.trim();
    try { answer = JSON.parse(trimmed); }
    catch {
      const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
      if (!fenced) return { ok: false, error: "assistant result is not JSON" };
      try { answer = JSON.parse(fenced[1]); }
      catch { return { ok: false, error: "assistant JSON fence is malformed" }; }
    }
  }
  if (!answer || typeof answer !== "object" || Array.isArray(answer)) return { ok: false, error: "answer must be an object" };
  if (typeof answer.answer !== "string" || !Array.isArray(answer.symbols) || answer.symbols.some((v) => typeof v !== "string")) {
    return { ok: false, error: "answer and symbols have invalid types" };
  }
  if (!Array.isArray(answer.evidence) || answer.evidence.some((e) => !e || typeof e.path !== "string" || !Number.isInteger(e.line) || e.line < 1)) {
    return { ok: false, error: "evidence must contain path and positive integer line" };
  }
  if (typeof answer.complete !== "boolean") return { ok: false, error: "complete must be boolean" };
  return { ok: true, value: answer };
}

export function gradeAnswer(answer, taskOrSymbols, subjectRoot = null) {
  const expected = Array.isArray(taskOrSymbols)
    ? taskOrSymbols
    : (taskOrSymbols.gold?.map((entry) => entry.symbol) ?? taskOrSymbols.expectedSymbols ?? []);
  const ranks = expected.map((symbol) => answer.symbols.indexOf(symbol));
  const matched = expected.filter((symbol) => answer.symbols.includes(symbol));
  const missing = expected.filter((symbol) => !answer.symbols.includes(symbol));
  const expectedPaths = Array.isArray(taskOrSymbols)
    ? []
    : (taskOrSymbols.gold ?? []).map((entry) => entry.path.replace(/^\.\//, "").replaceAll("\\", "/"));
  const citedPaths = new Set(answer.evidence.map((entry) => entry.path.replace(/^\.\//, "").replaceAll("\\", "/")));
  const missingEvidencePaths = expectedPaths.filter((path) => !citedPaths.has(path));
  const invalidEvidence = [];
  if (!Array.isArray(taskOrSymbols) && taskOrSymbols.gold?.length && subjectRoot) {
    const root = resolve(subjectRoot);
    for (const evidence of answer.evidence) {
      const path = resolve(root, evidence.path);
      const rel = relative(root, path);
      if (rel.startsWith("..") || isAbsolute(rel)) { invalidEvidence.push(`${evidence.path}:${evidence.line} escapes repository`); continue; }
      if (!existsSync(path)) { invalidEvidence.push(`${evidence.path}:${evidence.line} does not exist`); continue; }
      const lines = readFileSync(path, "utf8").split(/\r?\n/);
      if (evidence.line > lines.length) invalidEvidence.push(`${evidence.path}:${evidence.line} is past end of file`);
    }
  }
  return {
    correct: expected.length > 0 && missing.length === 0 && missingEvidencePaths.length === 0 && invalidEvidence.length === 0 && answer.complete === true,
    matchedSymbols: matched,
    missingSymbols: missing,
    missingEvidencePaths,
    invalidEvidence,
    answerSymbolRank: ranks.filter((rank) => rank >= 0).length ? Math.min(...ranks.filter((rank) => rank >= 0)) + 1 : null,
  };
}
