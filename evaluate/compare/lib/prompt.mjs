import { shellQuote } from "./policy.mjs";

export function buildPrompt(task, armId, arm, command, subjectRoot, policy = "forced-first") {
  const common = [
    "Investigate the repository and answer the question using only the permitted tools.",
    `The repository root is ${subjectRoot}. Treat all answer evidence paths as relative to that root.`,
    `Question: ${task.question}`,
    "Return the requested JSON object. Cite repository-relative paths and exact 1-based line numbers. Set complete to true only when the answer covers the question.",
  ];
  if (arm.kind === "grep") {
    return [...common, "Use repository file search and reads only. Do not inspect .mex or any graph database."].join("\n\n");
  }
  const cli = command.map(shellQuote).join(" ");
  const graphFlow = policy === "optional"
    ? `The graph CLI is available as \`${cli}\`. Use graph scope/query/get/impact when useful, but choose the retrieval strategy yourself.`
    : arm.vocabRetry
      ? `Start with \`${cli} graph scope "<question>"\`. If it emits VOCABULARY_MISMATCH or clearly irrelevant results, run \`${cli} graph vocab\`, select 1-12 project terms, and retry scope exactly once. Then use graph query/get as needed.`
      : `Start with \`${cli} graph scope "<question>"\`. Then use graph query/get as needed.`;
  return [
    ...common,
    graphFlow,
    "You may fall back to Read, Grep, or Glob only when graph retrieval is insufficient. Never inspect .mex/graph.db or use SQLite directly. Bash may only invoke the exact graph CLI shown above.",
  ].join("\n\n");
}
