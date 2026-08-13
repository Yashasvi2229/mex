import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

const ARM_KINDS = new Set(["grep", "graph"]);

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${label} must be a non-empty string`);
  return value;
}

function stringArray(value, label, { min = 0 } = {}) {
  if (!Array.isArray(value) || value.length < min || value.some((item) => typeof item !== "string" || item === "")) {
    throw new Error(`${label} must be an array of at least ${min} non-empty strings`);
  }
  return value;
}

export function validateSuite(raw, source = "suite") {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`${source} must contain a JSON object`);
  if (raw.schemaVersion !== 1) throw new Error(`${source}.schemaVersion must be 1`);
  requiredString(raw.id, `${source}.id`);
  if (!raw.subject || typeof raw.subject !== "object") throw new Error(`${source}.subject is required`);
  requiredString(raw.subject.name, `${source}.subject.name`);
  if (!Array.isArray(raw.tasks) || raw.tasks.length === 0) throw new Error(`${source}.tasks must be a non-empty array`);

  const taskIds = new Set();
  for (const [index, task] of raw.tasks.entries()) {
    const label = `${source}.tasks[${index}]`;
    requiredString(task?.id, `${label}.id`);
    if (taskIds.has(task.id)) throw new Error(`${label}.id is duplicated: ${task.id}`);
    taskIds.add(task.id);
    requiredString(task.question, `${label}.question`);
    stringArray(task.expectedSymbols, `${label}.expectedSymbols`, { min: 1 });
  }

  if (!raw.arms || typeof raw.arms !== "object" || Array.isArray(raw.arms)) throw new Error(`${source}.arms is required`);
  const armIds = Object.keys(raw.arms);
  if (armIds.length !== 3) throw new Error(`${source}.arms must define exactly three arms`);
  for (const id of armIds) {
    const arm = raw.arms[id];
    if (!ARM_KINDS.has(arm?.kind)) throw new Error(`${source}.arms.${id}.kind must be grep or graph`);
    if (arm.kind === "graph") {
      if (arm.cli !== undefined) stringArray(arm.cli, `${source}.arms.${id}.cli`, { min: 1 });
      if (arm.vocabRetry !== undefined && typeof arm.vocabRetry !== "boolean") {
        throw new Error(`${source}.arms.${id}.vocabRetry must be boolean`);
      }
      if (arm.buildFromGit !== undefined) {
        const build = arm.buildFromGit;
        if (!build || typeof build !== "object") throw new Error(`${source}.arms.${id}.buildFromGit must be an object`);
        requiredString(build.root, `${source}.arms.${id}.buildFromGit.root`);
        requiredString(build.revision, `${source}.arms.${id}.buildFromGit.revision`);
        requiredString(build.cli, `${source}.arms.${id}.buildFromGit.cli`);
        if (!Array.isArray(build.commands) || build.commands.length === 0) throw new Error(`${source}.arms.${id}.buildFromGit.commands must be non-empty`);
        build.commands.forEach((command, index) => stringArray(command, `${source}.arms.${id}.buildFromGit.commands[${index}]`, { min: 1 }));
      }
    }
  }
  if (armIds.filter((id) => raw.arms[id].kind === "grep").length !== 1) {
    throw new Error(`${source}.arms must contain exactly one grep arm`);
  }
  return raw;
}

export function loadSuite(path) {
  const absolutePath = resolve(path);
  const suite = validateSuite(JSON.parse(readFileSync(absolutePath, "utf8")), absolutePath);
  Object.defineProperty(suite, "__path", { value: absolutePath, enumerable: false });
  return suite;
}

export function expandToken(token, context) {
  return token.replaceAll(/\{(suiteDir|harnessRoot|subjectRoot|armRoot)\}/g, (_, key) => context[key]);
}

export function resolveArmCommands(suite, context, overrides = {}) {
  const commands = {};
  for (const [id, arm] of Object.entries(suite.arms)) {
    if (arm.kind === "grep") continue;
    const override = overrides[id];
    const raw = override ? [process.execPath, resolve(override)] : arm.cli;
    if (!raw) throw new Error(`No CLI configured for graph arm ${id}; pass --${id}-cli <file> or set arms.${id}.cli`);
    commands[id] = raw.map((token) => expandToken(token, context));
    const executable = commands[id][0];
    if ((isAbsolute(executable) || executable.includes("/")) && !existsSync(executable)) {
      throw new Error(`CLI executable for ${id} does not exist: ${executable}`);
    }
    if (commands[id][0] === process.execPath && !existsSync(commands[id][1])) {
      throw new Error(`CLI script for ${id} does not exist: ${commands[id][1]}`);
    }
  }
  return commands;
}

export function suiteContext(suite, harnessRoot, subjectRoot) {
  return {
    suiteDir: dirname(suite.__path ?? resolve(".")),
    harnessRoot: resolve(harnessRoot),
    subjectRoot: resolve(subjectRoot),
  };
}
