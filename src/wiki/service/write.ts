/**
 * The write half of the service surface, and the one command that builds an index.
 *
 * §16's rule is that **mutation returns a plan before it applies**, unless the
 * caller has explicit apply authority. That is not `--dry-run`; `--dry-run` is
 * something a user opts into. This is the other way round: `wikiApplyOperation`
 * plans and stops unless it is *told* to write, so the safe behaviour is what
 * happens when a caller says nothing. An agent that forgets a flag gets a plan.
 *
 * Everything that writes Markdown goes through P5's `planOperation` /
 * `applyOperation`, which is where `wiki.readOnly`, write-scope enforcement,
 * path containment, the audit log and `verifyPlan` live (D9, finding 41). There
 * is no second writer here and there must not be one.
 */

import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { rebuildWikiIndex } from "../index/rebuild.js";
import { planOperation, type PlanOptions } from "../operations/plan.js";
import { previewPlan, renderPreview, type WikiPreview } from "../operations/preview.js";
import { applyOperation, type ApplyOptions } from "../operations/apply.js";
import { createParseCache } from "../operations/locate.js";
import {
  migrateScaffold,
  planMigration,
  renderMigrationReport,
  reportIsBlocked,
  type MigrationReport,
} from "../migration/migrate.js";
import { indexPathFor, type ServiceResult, type WikiServiceOptions } from "./read.js";

/** Everything a write needs beyond where the scaffold is. */
export interface WikiWriteOptions extends WikiServiceOptions {
  exclude?: readonly string[];
  /** `wiki.readOnly` globs. Enforced in `plan.ts`, which is the whole surface (finding 41). */
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  /** The live code graph, required to mint or verify a grounding. */
  graph?: GroundingGraph | null;
}

function planOptionsFrom(options: WikiWriteOptions): PlanOptions {
  return {
    scaffoldRoot: resolve(options.scaffoldRoot),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
  };
}

export interface PlanData {
  planned: boolean;
  opId: string | null;
  /** The unified diff a reviewer reads, and the hash that pins it. */
  preview: WikiPreview | null;
  diff: string | null;
  /** Files the plan would touch. Empty on a refusal. */
  files: string[];
}

/** §16 `wiki_plan_operation` — plan and diff, never write. */
export function wikiPlanOperation(
  envelope: unknown,
  options: WikiWriteOptions,
): ServiceResult<PlanData> {
  const planned = planOperation(envelope, planOptionsFrom(options));
  if (!planned.ok) {
    return {
      data: { planned: false, opId: null, preview: null, diff: null, files: [] },
      diagnostics: planned.diagnostics,
    };
  }
  const preview = previewPlan(planned.plan);
  return {
    data: {
      planned: true,
      opId: planned.plan.opId,
      preview,
      diff: renderPreview(preview),
      files: planned.plan.files.map((file) => file.path),
    },
    diagnostics: planned.diagnostics,
  };
}

export interface ApplyData extends PlanData {
  /** True only when bytes were written. False for every plan-only outcome. */
  applied: boolean;
  /** True when the audit log already held a completion for this `opId`. */
  replayed: boolean;
  changedFiles: string[];
  createdIds: string[];
}

/**
 * §16 `wiki_apply_operation` — plan, and write **only** with explicit authority.
 *
 * `apply: true` is the authority, and its absence is a plan rather than an
 * error, because §5.4's posture is that agents propose and MEX applies. The
 * negative worth asserting is not that the return value is a plan — a tool that
 * returned a plan *and* wrote would satisfy that — but that nothing on disk
 * moved and no audit line was appended.
 */
export function wikiApplyOperation(
  envelope: unknown,
  options: WikiWriteOptions & { apply?: boolean },
): ServiceResult<ApplyData> {
  const planned = wikiPlanOperation(envelope, options);
  if (options.apply !== true || !planned.data.planned) {
    return {
      data: { ...planned.data, applied: false, replayed: false, changedFiles: [], createdIds: [] },
      diagnostics: planned.diagnostics,
    };
  }

  const applyOptions: ApplyOptions = planOptionsFrom(options);
  const result = applyOperation(envelope, applyOptions);
  return {
    data: {
      ...planned.data,
      applied: result.ok && !result.replayed,
      replayed: result.replayed,
      changedFiles: [...result.changedFiles],
      createdIds: [...result.createdIds],
    },
    diagnostics: suppressIndexRefresh(result.diagnostics, options),
  };
}

/**
 * Drop `INDEX_REFRESH_REQUIRED` when the scaffold has no index at all.
 *
 * Handoff §54.8: nothing in production has ever built an index, so *every*
 * apply in the wild returns that warning today. It is correct — the cache the
 * write invalidated does not exist — and telling a user to refresh a thing they
 * have never had teaches them to ignore a diagnostic code, which is the more
 * expensive habit. It stays when there *is* an index, because then it means
 * what it says: the index is now behind the files.
 */
function suppressIndexRefresh(
  diagnostics: readonly WikiDiagnostic[],
  options: WikiServiceOptions,
): WikiDiagnostic[] {
  if (existsSync(indexPathFor(options))) return [...diagnostics];
  return diagnostics.filter((entry) => entry.code !== "INDEX_REFRESH_REQUIRED");
}

export interface RebuildData {
  indexPath: string;
  fileCount: number;
  entityCount: number;
  /** Temp databases a crashed earlier build left behind, removed before this one. */
  sweptTempFiles: string[];
}

/**
 * `wiki rebuild-index` — the only command that builds one.
 *
 * Every other path in this engine reads, and P3's layering lint enforces that
 * `src/wiki/query/` cannot even import this module. §15.2 permits a read to
 * auto-rebuild "only when explicitly configured", and this is the explicit
 * configuration: a command the user runs.
 */
export function wikiRebuildIndex(options: WikiWriteOptions): ServiceResult<RebuildData> {
  const result = rebuildWikiIndex({
    scaffoldRoot: resolve(options.scaffoldRoot),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  return {
    data: {
      indexPath: result.indexPath,
      fileCount: result.fileCount,
      entityCount: result.entityCount,
      sweptTempFiles: result.sweptTempFiles,
    },
    diagnostics: result.diagnostics,
  };
}

export interface MigrateData {
  report: MigrationReport;
  /** The §13.6 report as text, for a human. */
  rendered: string;
  dryRun: boolean;
  /** True when the report holds something that must be resolved before applying. */
  blocked: boolean;
}

/**
 * `wiki migrate` — P6's run, behind a command.
 *
 * A dry run writes nothing and mints no id, which P6's own tests prove of the
 * library; this adds no policy of its own beyond choosing which of the two
 * functions to call. **Abstentions are not diagnostics** (finding 65.4): an
 * abstention is a decision not to decide and belongs in the report, and a
 * surface that collapsed the two would make migration look like it had failed
 * on a scaffold it handled correctly.
 */
export function wikiMigrate(
  options: WikiWriteOptions & { dryRun?: boolean; now?: () => string },
): ServiceResult<MigrateData> {
  const migrateOptions = {
    scaffoldRoot: resolve(options.scaffoldRoot),
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.graph === undefined ? {} : { graph: options.graph }),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.now === undefined ? {} : { now: options.now }),
  };
  const dryRun = options.dryRun === true;
  const report = dryRun ? planMigration(migrateOptions) : migrateScaffold(migrateOptions);
  return {
    data: {
      report,
      rendered: renderMigrationReport(report),
      dryRun,
      blocked: reportIsBlocked(report),
    },
    diagnostics: suppressIndexRefresh(report.diagnostics, options),
  };
}

/** A parse cache scoped to one batch of operations. Exposed so a caller can share one. */
export { createParseCache };

/** The typed refusal for an operation file that is not an operation. */
export function malformedOperationDiagnostic(path: string, reason: string): WikiDiagnostic {
  return diagnostic("INVALID_OPERATION_ENVELOPE", `${path} is not a readable operation envelope: ${reason}`, {
    file: path,
  });
}
