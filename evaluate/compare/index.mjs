#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildConfiguredArmArtifacts, prepareEvaluation, validateSubjectFixture } from "./lib/prepare.mjs";
import { generateReport } from "./lib/report.mjs";
import { runEvaluation } from "./lib/runner.mjs";
import { loadSuite, resolveArmCommands, suiteContext } from "./lib/suite.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const HARNESS_ROOT = resolve(HERE, "..", "..");

export function parseArgs(argv) {
  const args = { mode: null, repo: process.cwd(), model: null, timeoutMs: 300_000, resume: false, armCli: {}, noIndex: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (["--validate", "--prepare", "--run", "--report"].includes(arg)) {
      if (args.mode) throw new Error("choose exactly one of --validate, --prepare, --run, or --report");
      args.mode = arg.slice(2);
    } else if (arg === "--suite") args.suite = resolve(argv[++i]);
    else if (arg === "--repo") args.repo = resolve(argv[++i]);
    else if (arg === "--output") args.output = resolve(argv[++i]);
    else if (arg === "--model") args.model = argv[++i];
    else if (arg === "--timeout-ms") args.timeoutMs = Number(argv[++i]);
    else if (arg === "--resume") args.resume = true;
    else if (arg === "--no-index") args.noIndex = true;
    else if (arg === "--arm-cli") {
      const value = argv[++i] ?? "", split = value.indexOf("=");
      if (split < 1) throw new Error("--arm-cli must be id=/path/to/cli.js");
      args.armCli[value.slice(0, split)] = resolve(value.slice(split + 1));
    } else if (arg === "--baseline-cli") args.armCli.baseline = resolve(argv[++i]);
    else if (arg === "--patched-cli") args.armCli.patched = resolve(argv[++i]);
    else if (arg === "--claude") args.claude = resolve(argv[++i]);
    else throw new Error(`unknown argument: ${arg}`);
  }
  if (!args.mode) throw new Error("choose one of --validate, --prepare, --run, or --report");
  if (!args.suite) throw new Error("--suite <file> is required");
  if (!Number.isFinite(args.timeoutMs) || args.timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  return args;
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  const suite = loadSuite(args.suite);
  const outputDir = args.output ?? join(HARNESS_ROOT, "evaluate", "results", "compare", suite.id);
  if (args.mode === "validate") {
    console.log(`valid suite: ${suite.id} (${suite.tasks.length} tasks, ${Object.keys(suite.arms).length} arms)`);
    return;
  }
  if (args.mode === "report") {
    const report = generateReport({ suite, outputDir });
    console.log(JSON.stringify(report, null, 2));
    return;
  }
  if (!existsSync(args.repo)) throw new Error(`subject repository does not exist: ${args.repo}`);
  const context = suiteContext(suite, HARNESS_ROOT, args.repo);
  if (args.mode === "prepare") {
    const subjectFixture = validateSubjectFixture(suite, args.repo);
    const overrides = buildConfiguredArmArtifacts({ suite, context, outputDir, overrides: args.armCli });
    const armCommands = resolveArmCommands(suite, context, overrides);
    const manifest = prepareEvaluation({ suite, subjectRoot: args.repo, harnessRoot: HARNESS_ROOT, armCommands, outputDir, index: !args.noIndex, subjectFixture });
    console.log(`prepared ${suite.id} at ${outputDir} (${manifest.goldEvidence.length} tasks; no repository was cloned)`);
    return;
  }
  const existingOverrides = { ...args.armCli };
  for (const [armId, arm] of Object.entries(suite.arms)) {
    if (!existingOverrides[armId] && arm.buildFromGit) {
      const artifactCli = join(outputDir, "artifacts", armId, arm.buildFromGit.cli);
      if (existsSync(artifactCli)) existingOverrides[armId] = artifactCli;
    }
  }
  const armCommands = resolveArmCommands(suite, context, existingOverrides);
  if (args.mode === "run") {
    if (!args.model) throw new Error("--run requires --model <name>");
    const agentCommand = args.claude ? [args.claude] : ["claude"];
    const result = await runEvaluation({ suite, subjectRoot: args.repo, outputDir, armCommands, model: args.model, timeoutMs: args.timeoutMs, resume: args.resume, agentCommand });
    const report = generateReport({ suite, outputDir, rows: result.rows });
    console.log(JSON.stringify(report, null, 2));
    if (!report.executionValid) process.exitCode = 1;
    return;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((error) => { console.error(`[eval:compare] ${error.message}`); process.exitCode = 1; });
}
