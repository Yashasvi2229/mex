#!/usr/bin/env node
/**
 * Root-fixing wrapper for the graph arm.
 *
 * `mex graph scope|get|query` and `mex impact` resolve the project root from the process
 * working directory — there is no `--root` flag on the query commands. The A/B run needs the
 * agent's shell to sit in a neutral directory (so the subject repository's own CLAUDE.md,
 * AGENTS.md and skills cannot load and contaminate the run), which would otherwise leave the
 * CLI unable to find `.mex/graph.db`.
 *
 * This wrapper changes directory to the subject root and forwards argv unchanged. It adds no
 * flags, filters no output, and touches no result. Both arms run from the same neutral cwd, so
 * the isolation is symmetric; only this arm needs the chdir because only this arm has a CLI.
 *
 *   node mexg.mjs graph scope "some task"
 *
 * SUBJECT_ROOT and CLI are injected by the runner via environment so the wrapper is not
 * repository-specific.
 */
import { spawnSync } from "node:child_process";

const root = process.env.MEX_EVAL_SUBJECT_ROOT;
const cli = process.env.MEX_EVAL_CLI;
if (!root || !cli) {
  console.error("mexg: MEX_EVAL_SUBJECT_ROOT and MEX_EVAL_CLI must be set");
  process.exit(2);
}

const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  cwd: root,
  stdio: "inherit",
  env: process.env,
});
process.exit(result.status ?? 1);
