/**
 * The ten §15.1 commands, as adapters over the service surface.
 *
 * Every command here does three things and no more: turn flags into a service
 * options object, call one service function, and render. It never opens a
 * database, never parses Markdown, and never constructs an envelope of its own —
 * `envelopeFor` and `exitCodeFor` are the single definition, and a test asserts
 * no command in this file builds the shape by hand. That is what makes §20.7's
 * "exact schema parity" a property of having one definition rather than a
 * promise that three implementations agree.
 *
 * ## Two output shapes, and the rule for which
 *
 * P7's `for-code` established a duality: JSONL records by default, because
 * `mex graph scope|query|get` already speak that, and one enveloped object under
 * `--json`. It generalizes here with a stated rule:
 *
 * - a command whose answer is a **list** streams JSONL by default, so it
 *   composes with the graph commands an agent is already piping;
 * - a command whose answer is **one thing** — `show`, `validate`, `migrate`,
 *   `apply`, `rebuild-index` — has no stream to speak, and prints a compact
 *   human summary by default;
 * - `--json` gives every one of the ten the same enveloped object.
 *
 * The reason to write the rule down rather than decide per command: an agent
 * that has to switch parsers between two halves of one answer will parse one of
 * them wrong, and the failure looks like a data problem rather than a contract
 * problem.
 *
 * ## Colour
 *
 * `chalk` is imported here and only here. Every function that produces `data`
 * lives under `src/wiki/service/`, which has no colour library in scope at all,
 * so the JSON path cannot emit an escape even when the terminal is a TTY —
 * §15.2's rule holds structurally rather than by recollection.
 */

import chalk from "chalk";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import {
  envelopeFor,
  exitCodeFor,
  renderEnvelope,
  WIKI_EXIT,
  type WikiEnvelope,
  type WikiExitCode,
} from "./envelope.js";
import {
  malformedOperationDiagnostic,
  wikiApplyOperation,
  wikiBacklinks,
  wikiGet,
  wikiGraph,
  wikiList,
  wikiMigrate,
  wikiNeighborhood,
  wikiRebuildIndex,
  wikiRegenerateViews,
  wikiSearch,
  wikiValidate,
  type ServiceResult,
  type WikiFilterOptions,
} from "../service/index.js";

/** Everything the CLI layer needs that is not a service concern. */
export interface CommandIo {
  /** Where lines go. Injected so a test reads output instead of a terminal. */
  write: (line: string) => void;
  /** Set instead of calling `process.exit`, so a test can assert the status. */
  setExitCode: (code: WikiExitCode) => void;
  /** Absolute scaffold root. */
  scaffoldRoot: string;
  projectRoot?: string;
  exclude?: readonly string[];
  readOnly?: readonly string[];
}

/** Raw commander flags. Strings, because that is what a shell hands over. */
export interface CommandFlags {
  json?: boolean;
  type?: string;
  topic?: string;
  status?: string;
  health?: string;
  sourceType?: string;
  depth?: string | number;
  limit?: string | number;
  maxTokens?: string | number;
  includeArchived?: boolean;
  dryRun?: boolean;
  apply?: boolean;
  body?: boolean;
}

/**
 * Flags to service options.
 *
 * One conversion for all ten commands, so `--limit` means the same thing
 * wherever it applies. A value that is not a number is dropped rather than
 * coerced to NaN: the bounds layer clamps an absent value to its default, and
 * `NaN` would silently become the default anyway while looking like a choice.
 */
export function filtersFrom(flags: CommandFlags): WikiFilterOptions {
  const numeric = (value: string | number | undefined): number | undefined => {
    if (value === undefined) return undefined;
    const parsed = typeof value === "number" ? value : Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  };
  return {
    ...(flags.type === undefined ? {} : { type: flags.type }),
    ...(flags.topic === undefined ? {} : { topicId: flags.topic }),
    ...(flags.status === undefined ? {} : { status: flags.status }),
    ...(flags.health === undefined ? {} : { health: flags.health }),
    ...(flags.includeArchived === undefined ? {} : { includeArchived: flags.includeArchived }),
    ...(numeric(flags.limit) === undefined ? {} : { limit: numeric(flags.limit) }),
    ...(numeric(flags.depth) === undefined ? {} : { depth: numeric(flags.depth) }),
    ...(numeric(flags.maxTokens) === undefined ? {} : { maxTokens: numeric(flags.maxTokens) }),
  };
}

/**
 * Emit one service result, and set the exit status from it.
 *
 * The single exit point for all ten commands. `ok` comes from the diagnostics
 * and the status comes from the envelope, so a command physically cannot report
 * failure with a zero exit — there is no parameter for it to get wrong.
 */
function emit<T>(
  io: CommandIo,
  result: ServiceResult<T>,
  flags: CommandFlags,
  human: (data: T, envelope: WikiEnvelope<T>) => void,
): void {
  const envelope = envelopeFor(result.data, result.diagnostics);
  if (flags.json === true) {
    io.write(renderEnvelope(envelope));
  } else {
    human(result.data, envelope);
    renderDiagnostics(io, result.diagnostics);
  }
  io.setExitCode(exitCodeFor(envelope));
}

/** Diagnostics for a human: the code, what happened, and what to do about it. */
function renderDiagnostics(io: CommandIo, diagnostics: readonly WikiDiagnostic[]): void {
  for (const entry of diagnostics) {
    const paint = entry.severity === "error" ? chalk.red : entry.severity === "warning" ? chalk.yellow : chalk.dim;
    const where = entry.file === undefined ? "" : ` ${chalk.dim(entry.file)}`;
    io.write(`${paint(entry.severity)} ${chalk.bold(entry.code)}${where} ${entry.message}`);
    if (entry.remediation !== undefined) io.write(`  ${chalk.dim(entry.remediation)}`);
  }
}

/** JSONL for a list command, one record per line. */
function stream(io: CommandIo, records: readonly unknown[]): void {
  for (const record of records) io.write(JSON.stringify(record));
}

function serviceOptions(io: CommandIo): {
  scaffoldRoot: string;
  exclude?: readonly string[];
  readOnly?: readonly string[];
} {
  return {
    scaffoldRoot: resolve(io.scaffoldRoot),
    ...(io.exclude === undefined ? {} : { exclude: io.exclude }),
    ...(io.readOnly === undefined ? {} : { readOnly: io.readOnly }),
  };
}

// -- the ten -----------------------------------------------------------------

export function runList(io: CommandIo, flags: CommandFlags): void {
  emit(io, wikiList({ ...serviceOptions(io), ...filtersFrom(flags) }), flags, (data) => {
    stream(io, data.entities);
    if (data.truncated) io.write(chalk.dim(`… bounded at ${data.limit}; narrow with --type, --topic or --limit`));
  });
}

export function runShow(io: CommandIo, id: string, flags: CommandFlags): void {
  const result = wikiGet({ ...serviceOptions(io), id, includeBody: flags.body !== false });
  emit(io, result, flags, (data) => {
    if (data.entity === null) return;
    io.write(`${chalk.bold(data.entity.title)}  ${chalk.dim(data.entity.id)}`);
    io.write(
      `${data.entity.type} · ${data.entity.status} · rev ${data.entity.revision} · ${data.entity.file}:${data.entity.startLine}`,
    );
    // Null health is "nothing looked", never "verified as unknown" (§41.4).
    io.write(`health: ${data.entity.health ?? chalk.dim("not resolved in this checkout")}`);
    if (data.body !== null) {
      io.write("");
      io.write(data.body);
    }
  });
}

export function runQuery(io: CommandIo, text: string, flags: CommandFlags): void {
  emit(io, wikiSearch({ ...serviceOptions(io), ...filtersFrom(flags), text }), flags, (data) => {
    stream(io, data.hits);
    if (data.truncated) io.write(chalk.dim("… bounded; narrow the query or raise --limit"));
  });
}

export function runRelated(io: CommandIo, id: string, flags: CommandFlags): void {
  emit(io, wikiNeighborhood({ ...serviceOptions(io), ...filtersFrom(flags), id }), flags, (data) => {
    if (data === null) return;
    // `record` rather than `type`: an entity already has a `type`, and a
    // discriminator that overwrote it would make every streamed entity claim to
    // be of type "reached".
    stream(io, [
      { record: "origin", ...data.origin },
      ...data.relations.map((edge) => ({ record: "relation", ...edge })),
      ...data.backlinks.map((edge) => ({ record: "backlink", ...edge })),
      ...data.reached.map((entity) => ({ record: "reached", ...entity })),
    ]);
    if (data.truncated) io.write(chalk.dim("… bounded; lower --depth or raise --limit"));
  });
}

export function runBacklinks(io: CommandIo, id: string, flags: CommandFlags): void {
  emit(io, wikiBacklinks({ ...serviceOptions(io), ...filtersFrom(flags), id }), flags, (data) => {
    stream(io, data.backlinks);
  });
}

export function runValidate(io: CommandIo, flags: CommandFlags): void {
  const result = wikiValidate({
    ...serviceOptions(io),
    ...(io.projectRoot === undefined ? {} : { projectRoot: io.projectRoot }),
    ...filtersFrom(flags),
  });
  emit(io, result, flags, (data) => {
    io.write(
      `${data.filesScanned} file(s), ${data.entitiesChecked} entities — ` +
        `${data.counts.error} error, ${data.counts.warning} warning, ${data.counts.info} info`,
    );
    if (data.truncated) io.write(chalk.dim("… more diagnostics than the bound; raise --limit to see them"));
    if (data.groundingsUnverified) {
      // Not a diagnostic: it says how much was checked, not that anything is
      // wrong, and a CI run needs to tell a clean report from an unread one.
      io.write(chalk.dim("grounding checks did not run — no code graph in this checkout"));
    }
  });
}

export function runGraph(io: CommandIo, flags: CommandFlags): void {
  emit(io, wikiGraph({ ...serviceOptions(io), ...filtersFrom(flags) }), flags, (data) => {
    stream(io, [
      ...data.nodes.map((entity) => ({ record: "node", id: entity.id, entityType: entity.type, title: entity.title })),
      ...data.edges.map((edge) => ({ record: "edge", ...edge })),
    ]);
    if (data.truncated) {
      // Said plainly rather than implied: a bounded graph is a sample, and a
      // user who reads it as the whole graph will draw a wrong conclusion from
      // an absence.
      io.write(
        chalk.dim("… this is a bounded sample, not the whole graph; narrow with --type or --topic, or raise --limit"),
      );
    }
  });
}

export function runRebuildIndex(io: CommandIo, flags: CommandFlags): void {
  emit(io, wikiRebuildIndex(serviceOptions(io)), flags, (data) => {
    io.write(`Indexed ${data.entityCount} entities from ${data.fileCount} file(s) into ${data.indexPath}`);
    for (const swept of data.sweptTempFiles) io.write(chalk.dim(`removed a crashed build's temp index: ${swept}`));
  });
}

/**
 * `wiki regenerate-views` — rewrite generated sections that have drifted.
 *
 * An eleventh command, and the smaller of the two changes P6's seam could take.
 * §15.1 lists ten commands to implement rather than closing the surface, while
 * §11.2's eleven operation semantics *are* a closed vocabulary that
 * `operation.test.ts` pins — so adding a command costs a line in a list, and
 * adding an operation type would put a rendering act into the ledger of
 * knowledge changes. The reasoning for the write itself is on
 * `applyGeneratedViews`.
 *
 * `--dry-run` is the default posture for anything an agent can call, so this
 * reports what has drifted unless it is told to write.
 */
export function runRegenerateViews(io: CommandIo, flags: CommandFlags): void {
  const result = wikiRegenerateViews({ ...serviceOptions(io), dryRun: flags.dryRun === true });
  emit(io, result, flags, (data) => {
    if (data.examined.length === 0) {
      io.write("No generated sections in this scaffold.");
      return;
    }
    if (data.changedFiles.length === 0) {
      io.write(`${data.examined.length} generated section(s), all current.`);
      return;
    }
    const verb = data.dryRun ? "would be regenerated" : "regenerated";
    io.write(`${data.changedFiles.length} of ${data.examined.length} generated section(s) ${verb}:`);
    for (const file of data.changedFiles) io.write(`  ${file}`);
    if (data.dryRun) io.write(chalk.dim("re-run without --dry-run to write"));
  });
}

export function runMigrate(io: CommandIo, flags: CommandFlags): void {
  const result = wikiMigrate({ ...serviceOptions(io), dryRun: flags.dryRun === true });
  emit(io, result, flags, (data) => {
    io.write(data.rendered);
    if (data.report.abstentions.length > 0) {
      // Abstentions are an outcome, not a diagnostic (finding 65.4). A surface
      // that collapsed the two would make migration look like it had failed on
      // a scaffold it handled correctly.
      io.write("");
      io.write(chalk.dim(`${data.report.abstentions.length} section(s) left for a human to classify:`));
      for (const abstention of data.report.abstentions) {
        io.write(chalk.dim(`  ${abstention.file}: ${abstention.reason}`));
      }
    }
    if (data.blocked) io.write(chalk.yellow("Migration is blocked; resolve the errors above and re-run."));
  });
}

/**
 * `wiki apply <operation-file>` — the agent's write door.
 *
 * `--apply` is the explicit authority §16 requires. Without it this plans,
 * prints the diff and writes nothing, which is the safe outcome when a caller
 * says nothing at all rather than something a caller has to opt into.
 */
export function runApply(io: CommandIo, file: string, flags: CommandFlags): void {
  let envelope: unknown;
  try {
    envelope = JSON.parse(readFileSync(resolve(file), "utf-8"));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    const failure = envelopeFor({ planned: false }, [malformedOperationDiagnostic(file, reason)]);
    if (flags.json === true) io.write(renderEnvelope(failure));
    else renderDiagnostics(io, [malformedOperationDiagnostic(file, reason)]);
    io.setExitCode(exitCodeFor(failure));
    return;
  }

  const result = wikiApplyOperation(envelope, {
    ...serviceOptions(io),
    ...(flags.apply === true && flags.dryRun !== true ? { apply: true } : {}),
  });
  emit(io, result, flags, (data) => {
    if (data.diff !== null) io.write(data.diff);
    if (data.applied) io.write(chalk.green(`applied ${data.opId} — ${data.changedFiles.join(", ")}`));
    else if (data.replayed) io.write(chalk.dim(`${data.opId} was already applied; nothing to do`));
    else if (data.planned) io.write(chalk.dim("planned only — re-run with --apply to write"));
  });
}

/** Exported for the exit-code table's test, which asserts the CLI uses it. */
export { WIKI_EXIT };
