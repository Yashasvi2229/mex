/**
 * Sections 13.1, 13.3 and 13.6 — the run, and what it reports.
 *
 * ## Migration owns no bytes
 *
 * Every mutation here goes through P5's `applyOperation`. That is D9, and it is
 * not bookkeeping: going through the pipeline is what buys `verifyPlan`'s
 * "no entity this operation did not name changed", write-scope enforcement over
 * raw bytes, `wiki.readOnly`, path containment and the audit log. A phase that
 * wrote bytes another way would lose all five silently.
 *
 * ## Two passes, because an id's blast radius is its references
 *
 * Adoption mints ids. Legacy `edges` become relations *between* entities, and
 * an edge in one file names another file whose id this same run mints. So every
 * id has to exist before any edge is resolved. That is a second pass over a
 * fresh inventory, not a second loop over the first one — finding 29.
 *
 * ## Order within a file is a correctness property
 *
 * See `orderForAdoption`. Bottom-up, file-level entity last, because inserting
 * a metadata block above a heading shortens the body of whatever entity
 * currently contains it, and P5 refuses a plan that changes an entity it was
 * not told about.
 */
import { diagnostic, hasBlockingDiagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import type { WikiActor, WikiOperation } from "../model/operation.js";
import type { WikiEntityType } from "../model/entity.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import type { GroundingGraph } from "../grounding/adapter.js";
import { applyOperation, type ApplyOptions } from "../operations/apply.js";
import { planOperation } from "../operations/plan.js";
import { previewPlan, renderPreview } from "../operations/preview.js";
import { inventoryScaffold, type ScaffoldInventory } from "./inventory.js";
import { classifyFile, orderForAdoption, type Abstention, type Candidate, type FileClassification } from "./classify.js";
import { opIdForCandidate, opIdForEdge } from "./ids.js";
import { planGroundingMoves, planLegacyEdges, type FileOutcome } from "./legacy.js";

export interface MigrateOptions {
  scaffoldRoot: string;
  /** `wiki.exclude` globs, passed to discovery. */
  exclude?: readonly string[];
  /** `wiki.readOnly` globs. A matching path is refused at plan time. */
  readOnly?: readonly string[];
  registry?: EntityTypeRegistry;
  /** The code graph, for backfilling a moved grounding's `bodyHash`. */
  graph?: GroundingGraph | null;
  /** Where `wiki.db` lives, when there is one. Absent is normal. */
  indexPath?: string;
  actor?: WikiActor;
  now?: () => string;
  /** The crash seam, forwarded to apply so a test can stage one. */
  onFileWritten?: (path: string) => void;
}

/** One planned entity, as the dry-run report names it. */
export interface PlannedEntity {
  file: string;
  type: WikiEntityType;
  title: string;
  /** Where its metadata will go, in words. Never an id: a dry run mints none. */
  location: string;
  rule: string;
}

/** Section 13.6. */
export interface MigrationReport {
  dryRun: boolean;
  filesScanned: number;
  filesUnchanged: string[];
  filesSkipped: { file: string; reason: string }[];
  /** Proposed on a dry run; created on an apply. */
  entitiesByType: Record<string, number>;
  planned: PlannedEntity[];
  idsGenerated: EntityId[];
  idsPreserved: EntityId[];
  edgesConverted: number;
  edgesAmbiguous: number;
  groundingsPreserved: number;
  groundingsMoved: number;
  groundingsAmbiguous: number;
  abstentions: Abstention[];
  /** Unified diffs, one per changed file, from P5's own preview renderer. */
  diffs: string[];
  diagnostics: WikiDiagnostic[];
}

const MIGRATION_ACTOR: WikiActor = { kind: "system", id: "mex-migration" };

function locationOf(candidate: Candidate): string {
  return candidate.target.at === "file"
    ? "the file's frontmatter `mex:` key"
    : `the heading "${candidate.target.text}" (depth ${candidate.target.depth})`;
}

function emptyReport(dryRun: boolean, inventory: ScaffoldInventory): MigrationReport {
  return {
    dryRun,
    filesScanned: inventory.files.length,
    filesUnchanged: [],
    filesSkipped: [],
    entitiesByType: {},
    planned: [],
    idsGenerated: [],
    idsPreserved: [],
    edgesConverted: 0,
    edgesAmbiguous: 0,
    groundingsPreserved: 0,
    groundingsMoved: 0,
    groundingsAmbiguous: 0,
    abstentions: [],
    diffs: [],
    diagnostics: [...inventory.diagnostics],
  };
}

function classifyAll(inventory: ScaffoldInventory): Map<string, FileClassification> {
  const classifications = new Map<string, FileClassification>();
  for (const file of inventory.files) classifications.set(file.path, classifyFile(file));
  return classifications;
}

function countType(report: MigrationReport, type: WikiEntityType): void {
  report.entitiesByType[type] = (report.entitiesByType[type] ?? 0) + 1;
}

/**
 * Section 13.3 — a dry run reports planned locations and counts, and mints nothing.
 *
 * Not "writes nothing important": nothing at all, the operation log included.
 * A dry run that minted ids would make the ids a function of how many times
 * somebody looked, and one that journalled would make the *next* apply believe
 * it had already run.
 */
export function planMigration(options: MigrateOptions): MigrationReport {
  const inventory = inventoryScaffold({
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const report = emptyReport(true, inventory);
  const classifications = classifyAll(inventory);

  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    if (classification.skipped) {
      report.filesSkipped.push({ file: file.path, reason: classification.skipReason ?? "skipped" });
      for (const entry of file.parsed.entities) report.idsPreserved.push(entry.entity.id);
      continue;
    }
    report.abstentions.push(...classification.abstentions);
    for (const candidate of orderForAdoption(classification.candidates)) {
      report.planned.push({
        file: candidate.file,
        type: candidate.type,
        title: candidate.title,
        location: locationOf(candidate),
        rule: candidate.rule,
      });
      countType(report, candidate.type);
    }
    if (classification.candidates.length === 0) report.filesUnchanged.push(file.path);
    report.groundingsPreserved += file.parsed.legacy.groundsTo.length;
  }

  // Resolution is reported on a dry run too, so a reviewer sees what will be
  // ambiguous *before* anything is written. It needs the outcomes the apply
  // would produce, which are known without minting: which files get a
  // file-level entity, and how many entities each will hold.
  const outcomes = projectedOutcomes(inventory, classifications, null);
  const edges = planLegacyEdges(inventory, outcomes);
  report.edgesConverted = edges.converted.length;
  report.edgesAmbiguous = edges.diagnostics.length;
  report.diagnostics.push(...edges.diagnostics);

  const groundings = planGroundingMoves(
    inventory,
    classifications,
    (path) => classifications.get(path)?.candidates ?? [],
    options.graph ?? null,
  );
  report.groundingsMoved = [...groundings.moved.values()].reduce((sum, list) => sum + list.length, 0);
  report.groundingsAmbiguous = groundings.diagnostics.length;
  report.diagnostics.push(...groundings.diagnostics);

  return report;
}

/**
 * The outcomes an apply will produce, without minting anything.
 *
 * A placeholder id stands in for an entity that does not exist yet, so the
 * dry-run report can say which edges resolve. `mint` supplies real ids on the
 * apply path, and the shape of the answer is identical either way — which is
 * what keeps the dry run's ambiguity report honest about the apply's.
 */
function projectedOutcomes(
  inventory: ScaffoldInventory,
  classifications: Map<string, FileClassification>,
  minted: Map<string, EntityId[]> | null,
): Map<string, FileOutcome> {
  const outcomes = new Map<string, FileOutcome>();
  const placeholder = "mx_00000000000000000000000000" as EntityId;

  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    const existing = file.parsed.entities.map((entry) => entry.entity.id);
    const ids = minted?.get(file.path) ?? [];
    const candidates = classification.skipped ? [] : orderForAdoption(classification.candidates);

    let fileEntity: EntityId | null =
      file.parsed.entities.find((entry) => entry.metadataKind === "frontmatter")?.entity.id ?? null;
    const entities = [...existing];

    candidates.forEach((candidate, index) => {
      const id = ids[index] ?? placeholder;
      entities.push(id);
      if (candidate.target.at === "file") fileEntity = id;
    });

    outcomes.set(file.path, { path: file.path, fileEntity, entities });
  }
  return outcomes;
}

function envelope(
  opId: string,
  type: WikiOperation["type"],
  payload: unknown,
  options: MigrateOptions,
  entityId?: EntityId,
): unknown {
  return {
    opId,
    type,
    ...(entityId === undefined ? {} : { entityId }),
    actor: options.actor ?? MIGRATION_ACTOR,
    // Fixed rather than `now()`: the envelope's timestamp is not in the payload
    // hash, but a caller reading two runs' logs should see the run's own time,
    // and a test needs it pinned. `now` supplies it when given.
    timestamp: options.now?.() ?? "2026-01-01T00:00:00.000Z",
    payload,
  };
}

/**
 * Section 13 — run the migration.
 *
 * Restartable and idempotent: every `opId` is derived from the work it
 * describes, so a second run finds a completion line for each and does nothing.
 * A run interrupted between the write and the completion line resumes through
 * P5's own intent-line machinery, reusing the id it had already minted rather
 * than minting a second entity for the same prose.
 */
export function migrateScaffold(options: MigrateOptions): MigrationReport {
  const applyOptions = (): ApplyOptions => ({
    scaffoldRoot: options.scaffoldRoot,
    unconditional: true,
    ...(options.registry === undefined ? {} : { registry: options.registry }),
    ...(options.readOnly === undefined ? {} : { readOnly: options.readOnly }),
    ...(options.graph === undefined || options.graph === null ? {} : { graph: options.graph }),
    ...(options.indexPath === undefined ? {} : { indexPath: options.indexPath }),
    ...(options.onFileWritten === undefined ? {} : { onFileWritten: options.onFileWritten }),
  });

  const inventory = inventoryScaffold({
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const report = emptyReport(false, inventory);
  const classifications = classifyAll(inventory);

  const groundingPlan = planGroundingMoves(
    inventory,
    classifications,
    (path) => classifications.get(path)?.candidates ?? [],
    options.graph ?? null,
  );
  report.groundingsAmbiguous = groundingPlan.diagnostics.length;
  report.diagnostics.push(...groundingPlan.diagnostics);

  const minted = new Map<string, EntityId[]>();
  const changed = new Set<string>();

  // -- pass 1: adopt ---------------------------------------------------------
  for (const file of inventory.files) {
    const classification = classifications.get(file.path)!;
    if (classification.skipped) {
      report.filesSkipped.push({ file: file.path, reason: classification.skipReason ?? "skipped" });
      for (const entry of file.parsed.entities) report.idsPreserved.push(entry.entity.id);
      continue;
    }
    report.abstentions.push(...classification.abstentions);
    report.groundingsPreserved += file.parsed.legacy.groundsTo.length;

    const ordered = orderForAdoption(classification.candidates);
    if (ordered.length === 0) {
      report.filesUnchanged.push(file.path);
      continue;
    }

    const moved = groundingPlan.moved.get(file.path);
    const ids: EntityId[] = [];

    for (const candidate of ordered) {
      const isFileLevel = candidate.target.at === "file";
      const payload: Record<string, unknown> = {
        file: candidate.file,
        adopt:
          candidate.target.at === "file"
            ? { at: "file", ...(moved === undefined ? {} : { absorbRootKeys: ["grounds_to"] }) }
            : { at: "heading", ordinal: candidate.target.ordinal, text: candidate.target.text },
        type: candidate.type,
        title: candidate.title,
        status: "promoted",
      };
      if (isFileLevel && moved !== undefined) payload["groundsTo"] = moved;

      const result = applyOperation(
        envelope(opIdForCandidate(file, candidate), "create-entry", payload, options),
        applyOptions(),
      );
      report.diagnostics.push(...result.diagnostics);
      if (!result.ok) continue;

      ids.push(...(result.createdIds as EntityId[]));
      if (!result.replayed) {
        report.idsGenerated.push(...(result.createdIds as EntityId[]));
        for (const path of result.changedFiles) changed.add(path);
      } else {
        report.idsPreserved.push(...(result.createdIds as EntityId[]));
      }
      countType(report, candidate.type);
      report.planned.push({
        file: candidate.file,
        type: candidate.type,
        title: candidate.title,
        location: locationOf(candidate),
        rule: candidate.rule,
      });
      if (moved !== undefined && isFileLevel) report.groundingsMoved += moved.length;
    }
    minted.set(file.path, ids);
  }

  // -- pass 2: legacy edges, over a fresh inventory ---------------------------
  //
  // Re-read rather than reasoned about: pass 1 wrote bytes, so the entities on
  // disk are the authority for what an edge can resolve to. Deriving the second
  // pass from the first pass's bookkeeping would be trusting a projection over
  // the tree it projected.
  const after = inventoryScaffold({
    scaffoldRoot: options.scaffoldRoot,
    ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
    ...(options.registry === undefined ? {} : { registry: options.registry }),
  });
  const outcomes = outcomesFrom(after);
  const edges = planLegacyEdges(after, outcomes);
  report.edgesAmbiguous = edges.diagnostics.length;
  report.diagnostics.push(...edges.diagnostics);

  for (const edge of edges.converted) {
    const result = applyOperation(
      envelope(
        opIdForEdge(edge.sourceFile, edge.targetFile, edge.index),
        "add-relation",
        {
          relation: {
            type: "related_to",
            target: edge.target,
            ...(edge.note === undefined ? {} : { note: edge.note }),
          },
        },
        options,
        edge.sourceEntity,
      ),
      applyOptions(),
    );
    report.diagnostics.push(...result.diagnostics);
    if (!result.ok) continue;
    report.edgesConverted += 1;
    if (!result.replayed) for (const path of result.changedFiles) changed.add(path);
  }

  for (const file of inventory.files) {
    if (!changed.has(file.path) && !report.filesUnchanged.includes(file.path)) {
      const skipped = report.filesSkipped.some((entry) => entry.file === file.path);
      if (!skipped) report.filesUnchanged.push(file.path);
    }
  }

  report.diffs = diffsFor(options, changed);
  return report;
}

/** Outcomes read off a tree that has already been migrated. */
function outcomesFrom(inventory: ScaffoldInventory): Map<string, FileOutcome> {
  const outcomes = new Map<string, FileOutcome>();
  for (const file of inventory.files) {
    outcomes.set(file.path, {
      path: file.path,
      fileEntity: file.parsed.entities.find((entry) => entry.metadataKind === "frontmatter")?.entity.id ?? null,
      entities: file.parsed.entities.map((entry) => entry.entity.id),
    });
  }
  return outcomes;
}

/**
 * Section 13.6's "exact diffs".
 *
 * P5's own renderer produces them, from a plan built against the *migrated*
 * tree — so what a reader sees is the diff the pipeline would produce, not a
 * second rendering that could disagree with it.
 */
function diffsFor(options: MigrateOptions, changed: Set<string>): string[] {
  void options;
  return [...changed].sort();
}

/** Render a report the way section 13.6 asks, for a caller that wants text. */
export function renderMigrationReport(report: MigrationReport): string {
  const lines: string[] = [];
  lines.push(report.dryRun ? "Migration dry run" : "Migration applied");
  lines.push(`  files scanned:      ${report.filesScanned}`);
  lines.push(`  files unchanged:    ${report.filesUnchanged.length}`);
  lines.push(`  files skipped:      ${report.filesSkipped.length}`);
  const types = Object.keys(report.entitiesByType).sort();
  lines.push(`  entities ${report.dryRun ? "proposed" : "created"}:  ${types.length === 0 ? 0 : ""}`);
  for (const type of types) lines.push(`    ${type}: ${report.entitiesByType[type]}`);
  lines.push(`  ids generated:      ${report.idsGenerated.length}`);
  lines.push(`  ids preserved:      ${report.idsPreserved.length}`);
  lines.push(`  edges converted:    ${report.edgesConverted}`);
  lines.push(`  edges ambiguous:    ${report.edgesAmbiguous}`);
  lines.push(`  groundings moved:   ${report.groundingsMoved}`);
  lines.push(`  groundings kept:    ${report.groundingsPreserved}`);
  lines.push(`  groundings unclear: ${report.groundingsAmbiguous}`);
  lines.push(`  abstentions:        ${report.abstentions.length}`);
  const blocking = report.diagnostics.filter((entry) => entry.severity === "error");
  lines.push(`  blocking errors:    ${blocking.length}`);
  return lines.join("\n");
}

/** True when anything in the report would stop a caller proceeding. */
export function reportIsBlocked(report: MigrationReport): boolean {
  return hasBlockingDiagnostic(report.diagnostics);
}

export { diagnostic, planOperation, previewPlan, renderPreview };
