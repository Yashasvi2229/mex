/**
 * The task prompt.
 *
 * The TASK half is byte-identical across arms — same wording, same schema instruction, same
 * root statement. Only a TOOL PREAMBLE differs, and it differs for one reason: the file tools
 * are built in and self-describing, while a CLI is not. An agent handed `Bash` with no
 * description of what to run cannot be said to have been offered the graph at all, so the
 * preamble is the CLI's equivalent of a built-in tool's own description.
 *
 * What the preamble deliberately does NOT do:
 *   - it does not mandate an order ("start with scope") — that would measure a prompt
 *   - it does not tell the agent when to fall back, or discourage falling back
 *   - it does not describe what the graph is good at
 *
 * Anything beyond capability and syntax is prompt engineering and belongs in a separate arm.
 */
const GRAPH_PREAMBLE = (cli) => [
  `A code graph index of this repository is available through a CLI. Invoke it with Bash:`,
  ``,
  `  ${cli} graph scope "<free text>"      retrieve a set of declarations relevant to a task`,
  `  ${cli} graph query <relation> <target>  relations: who-calls | what-calls | where-defined`,
  `  ${cli} graph get <id> [--detail source]  expand specific node ids returned by the above`,
  `  ${cli} impact <symbol-or-file>          transitive dependents of a declaration`,
  ``,
  `All of these emit JSONL on stdout. Use whichever tools you prefer.`,
].join("\n");

const FILES_PREAMBLE = "Use Read, Grep and Glob to investigate the repository.";

function taskBody(task, repoRoot) {
  if (task.kind === "nl") {
    return [
      `You are answering a question about the TypeScript monorepo at: ${repoRoot}`,
      `All file paths you report must be relative to that root (e.g. "packages/foo/src/bar.ts").`,
      ``,
      `Question: ${task.question}`,
      ``,
      `Identify the single declaration (function, class, method, interface, type, or constant)`,
      `that best answers it. Report its file path and its bare symbol name.`,
      `If you genuinely cannot find it, set symbolName to "NOT_FOUND".`,
    ].join("\n");
  }
  return [
    `You are answering a question about the TypeScript monorepo at: ${repoRoot}`,
    ``,
    `Question: ${task.question}`,
    ``,
    `Report the bare names only (no paths, no parentheses). List every one you find.`,
  ].join("\n");
}

export function buildPrompt(task, arm, repoRoot, cli) {
  const preamble = arm.kind === "graph" ? GRAPH_PREAMBLE(cli) : FILES_PREAMBLE;
  return `${preamble}\n\n${taskBody(task, repoRoot)}`;
}

export const NL_SCHEMA = {
  type: "object",
  properties: {
    filePath: { type: "string", description: "Repository-relative path of the file containing the declaration" },
    symbolName: { type: "string", description: "Bare name of the declaration, or NOT_FOUND" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["filePath", "symbolName", "confidence"],
  additionalProperties: false,
};

export const MULTIHOP_SCHEMA = {
  type: "object",
  properties: {
    neighbors: { type: "array", items: { type: "string" }, description: "Bare names of the neighbouring declarations" },
    confidence: { type: "string", enum: ["high", "medium", "low"] },
  },
  required: ["neighbors", "confidence"],
  additionalProperties: false,
};
