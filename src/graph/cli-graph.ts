import type { GraphSourceChanges, GraphStatus } from "../team/contracts/graph.js";
import {
  rebuildGraph,
  refreshGraph,
  type GraphMaintenanceResult,
} from "./maintenance.js";
import { inspectGraphStatus } from "./status.js";

export interface GraphCommandOptions {
  /** Project root to inspect or maintain (defaults to cwd). */
  root?: string;
  /** Emit the complete machine-readable result. */
  json?: boolean;
}

/** Strictly read-only graph health/freshness command. */
export async function runGraphStatus(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const status = await inspectGraphStatus({ projectRoot: rootDir });
  if (options.json) console.log(JSON.stringify(status, null, 2));
  else printStatus(status);
}

/** Explicit correctness-first refresh through the existing full semantic sync path. */
export async function runGraphRefresh(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const result = await refreshGraph(rootDir);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printMaintenance("refreshed", result);
}

/** Explicit isolated candidate rebuild with atomic publication and recovery. */
export async function runGraphRebuild(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const result = await rebuildGraph(rootDir);
  if (options.json) console.log(JSON.stringify(result, null, 2));
  else printMaintenance("rebuilt", result);
}

/** Backward-compatible `mex graph`, now implemented as a safe rebuild. */
export async function runGraph(options: GraphCommandOptions = {}): Promise<void> {
  const rootDir = options.root ?? process.cwd();
  const result = await rebuildGraph(rootDir);
  if (options.json) {
    console.log(JSON.stringify({
      filesIndexed: result.filesIndexed,
      nodesCreated: result.nodesCreated,
      edgesCreated: result.edgesCreated,
      durationMs: result.durationMs,
      health: {
        ok: result.status.parseHealth.ok,
        partial: result.status.parseHealth.partial,
        failed: result.status.parseHealth.failed,
      },
    }, null, 2));
    return;
  }
  console.log(
    `Code graph built: ${result.nodesCreated} nodes, ${result.edgesCreated} edges `
      + `across ${result.filesIndexed} files in ${result.durationMs}ms → .mex/graph.db`,
  );
}

function printStatus(status: GraphStatus): void {
  const branch = status.currentRepo.branch ?? "detached/no branch";
  const head = status.currentRepo.head?.slice(0, 12) ?? "no HEAD";
  const changes = status.changes;
  console.log(`Graph status: ${status.status}`);
  console.log(`Repository: ${branch} @ ${head}${status.currentRepo.dirty ? " (dirty)" : ""}`);
  console.log(`Last successful index: ${status.lastSuccessfulIndexAt ?? "never"}`);
  console.log(formatGraphSourceChanges(changes));
  console.log(
    `Parse health: ${status.parseHealth.ok} ok, ${status.parseHealth.partial} partial, `
      + `${status.parseHealth.failed} failed`,
  );
  for (const diagnostic of status.diagnostics) {
    console.log(`${diagnostic.severity.toUpperCase()} ${diagnostic.code}: ${diagnostic.message}`);
  }
  const command = status.diagnostics
    .flatMap((diagnostic) => diagnostic.remediation ?? [])
    .find((action) => action.command)?.command;
  if (command) console.log(`Next: ${command}`);
}

/** Internal human-output formatter; JSON output retains the complete contract. */
export function formatGraphSourceChanges(changes: GraphSourceChanges): string {
  if (changes.truncated) {
    const shown = changes.added.length + changes.modified.length + changes.deleted.length;
    const omitted = Math.max(0, changes.total - shown);
    const omission = omitted > 0 ? `${omitted} paths omitted` : "path details truncated";
    return `Sources: ${changes.total} changed (`
      + `${changes.added.length} added shown, ${changes.modified.length} modified shown, `
      + `${changes.deleted.length} deleted shown; ${omission})`;
  }
  return `Sources: ${changes.total} changed `
    + `(${changes.added.length} added, ${changes.modified.length} modified, ${changes.deleted.length} deleted)`;
}

function printMaintenance(verb: "refreshed" | "rebuilt", result: GraphMaintenanceResult): void {
  console.log(
    `Code graph ${verb}: ${result.nodesCreated} nodes, ${result.edgesCreated} edges `
      + `across ${result.filesIndexed} files in ${result.durationMs}ms; status ${result.status.status}.`,
  );
  if (result.recoveryPath) {
    console.log(`Previous index retained for local recovery: ${result.recoveryPath}`);
  }
}
