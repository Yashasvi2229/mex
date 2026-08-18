import { existsSync, readFileSync } from "node:fs";
import { relative, resolve, sep } from "node:path";
import { repositoryIdentity } from "../../core/hash.mjs";

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function declarationPattern(evidence) {
  const name = escapeRegExp(evidence.symbol);
  switch (evidence.kind) {
    case "function": return new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?(?:async\\s+)?(?:function|def|fn|func)\\s+${name}\\b`);
    case "class": return new RegExp(`\\b(?:export\\s+)?(?:default\\s+)?class\\s+${name}\\b`);
    case "interface": return new RegExp(`\\b(?:export\\s+)?interface\\s+${name}\\b`);
    case "struct": return new RegExp(`\\b(?:pub(?:\\([^)]*\\))?\\s+)?struct\\s+${name}\\b`);
    case "trait": return new RegExp(`\\b(?:pub\\s+)?trait\\s+${name}\\b`);
    case "enum": return new RegExp(`\\b(?:export\\s+)?(?:pub\\s+)?enum\\s+${name}\\b`);
    case "type_alias": return new RegExp(`\\b(?:export\\s+)?(?:pub\\s+)?type\\s+${name}\\b`);
    case "constant": return new RegExp(`\\b(?:export\\s+)?(?:pub\\s+)?(?:const|static)\\s+${name}\\b`);
    case "variable": return new RegExp(`\\b(?:export\\s+)?(?:const|let|var)\\s+${name}\\b`);
    case "method": return new RegExp(`^\\s*(?:pub(?:\\([^)]*\\))?\\s+)?(?:async\\s+)?${name}\\s*(?:<[^>]*>)?\\s*\\(`);
    case "component": return new RegExp(`\\b(?:function|class|const)\\s+${name}\\b`);
    default: return new RegExp(`\\b${name}\\b`);
  }
}

function insideRoot(root, path) {
  const rel = relative(root, path);
  return rel !== "" && rel !== ".." && !rel.startsWith(`..${sep}`) && !resolve(path).startsWith(`${resolve(root)}${sep}..${sep}`);
}

export function validateEvidenceInSource(root, evidence, label = "evidence") {
  const absoluteRoot = resolve(root);
  const absolute = resolve(absoluteRoot, evidence.path);
  if (!insideRoot(absoluteRoot, absolute)) throw new Error(`${label}.path escapes the subject repository: ${evidence.path}`);
  if (!existsSync(absolute)) throw new Error(`${label}.path does not exist: ${evidence.path}`);
  const lines = readFileSync(absolute, "utf8").split(/\r?\n/);
  const pattern = declarationPattern(evidence);
  const matches = [];
  lines.forEach((line, index) => { if (pattern.test(line)) matches.push(index + 1); });
  if (evidence.line !== undefined) {
    if (!matches.includes(evidence.line)) {
      throw new Error(`${label} declaration ${evidence.kind} ${evidence.symbol} was not found at ${evidence.path}:${evidence.line}`);
    }
    return { ...evidence, line: evidence.line };
  }
  if (matches.length === 0) throw new Error(`${label} declaration ${evidence.kind} ${evidence.symbol} was not found in ${evidence.path}`);
  if (matches.length > 1) {
    throw new Error(`${label} declaration ${evidence.kind} ${evidence.symbol} is ambiguous in ${evidence.path}; add line (${matches.join(", ")})`);
  }
  return { ...evidence, line: matches[0] };
}

export function validateSubjectFixture(suite, subjectRoot) {
  const subject = repositoryIdentity(subjectRoot);
  if (suite.subject.revision && subject.sha !== suite.subject.revision) {
    throw new Error(`subject revision mismatch: expected ${suite.subject.revision}, found ${subject.sha ?? "non-git subject"}`);
  }
  if (suite.subject.requireClean && subject.dirty !== false) {
    throw new Error(`subject must be a clean checkout: ${subject.dirtyEntries.join(", ") || "not a git checkout"}`);
  }
  const tasks = suite.tasks.map((task, taskIndex) => ({
    taskId: task.id,
    gold: (task.gold ?? []).map((evidence, index) => validateEvidenceInSource(subjectRoot, evidence, `tasks[${taskIndex}].gold[${index}]`)),
    acceptableAlternates: (task.acceptableAlternates ?? []).map((evidence, index) => validateEvidenceInSource(subjectRoot, evidence, `tasks[${taskIndex}].acceptableAlternates[${index}]`)),
    mustNotReturn: (task.mustNotReturn ?? []).map((evidence, index) => validateEvidenceInSource(subjectRoot, evidence, `tasks[${taskIndex}].mustNotReturn[${index}]`)),
  }));
  return { subject, tasks };
}
