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

export function gradeAnswer(answer, expectedSymbols) {
  const haystack = `${answer.answer}\n${answer.symbols.join("\n")}`;
  const ranks = expectedSymbols.map((symbol) => answer.symbols.indexOf(symbol)).filter((rank) => rank >= 0);
  const matched = expectedSymbols.filter((symbol) => haystack.includes(symbol));
  return {
    correct: matched.length > 0,
    matchedSymbols: matched,
    answerSymbolRank: ranks.length ? Math.min(...ranks) + 1 : null,
  };
}
