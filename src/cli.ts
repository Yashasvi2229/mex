import chalk from "chalk";
import { Command, InvalidArgumentError } from "commander";
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { findConfig, getScaffoldIdentity, readScaffoldId } from "./config.js";
import { reportConsole, reportQuiet, reportJSON, reportVerbose } from "./reporter.js";
import { VERSION } from "./version.js";
import { captureCommand, flush, isEnabled, getPayloadPreview, showFirstRunNotice } from "./telemetry/index.js";
import { readMachineId, setGlobalConfigKey } from "./global-config.js";
import { runFeedback, maybeShowInvite, dismissInvite, enableInvite } from "./feedback/index.js";
import type { MexConfig } from "./types.js";
import type { RunHubCommandOptions } from "./hub/command.js";

/**
 * Load config for a CLI command and backfill scaffold identity on the way.
 * Centralises the E1 migration: any command that loads config mints a
 * scaffold_id if one is missing (silent, cheap, best-effort). Keeps findConfig
 * itself a pure read for embedders.
 */
function loadConfig(): ReturnType<typeof findConfig> {
  const config = findConfig();
  getScaffoldIdentity(config);
  return config;
}

export function parseIntArg(raw: string): number {
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 0) {
    throw new InvalidArgumentError(`Expected a non-negative integer, got "${raw}".`);
  }
  return n;
}

export function parsePositiveIntArg(raw: string): number {
  const n = parseIntArg(raw);
  if (n <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${raw}".`);
  }
  return n;
}

export function parsePortArg(raw: string): number {
  if (!/^[0-9]+$/.test(raw)) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${raw}".`);
  }
  const port = Number(raw);
  if (!Number.isSafeInteger(port) || port <= 0) {
    throw new InvalidArgumentError(`Expected a positive integer, got "${raw}".`);
  }
  if (port > 65_535) {
    throw new InvalidArgumentError(`Expected a TCP port from 1 to 65535, got "${raw}".`);
  }
  return port;
}

/** Pure Hub bootstrap projection so CLI and production wiring share Wiki scope. */
export function createHubRunOptions(
  config: Pick<MexConfig, "projectRoot" | "wiki">,
  scaffoldId: string,
  options: { port?: number; open: boolean },
): RunHubCommandOptions {
  return {
    projectRoot: config.projectRoot,
    scaffoldId,
    port: options.port,
    openBrowser: options.open,
    ...(config.wiki?.exclude === undefined ? {} : { wikiExclude: config.wiki.exclude }),
    ...(config.wiki?.readOnly === undefined ? {} : { wikiReadOnly: config.wiki.readOnly }),
  };
}

export const program = new Command();

export function isTelemetryExemptCommand(
  commandName: string,
  parentName?: string,
): boolean {
  return parentName === "telemetry"
    || parentName === "config"
    || commandName === "hub"
    || commandName === "capabilities";
}

/** Commands whose machine/read-only contract must precede any global notice. */
export function isFirstRunNoticeExemptCommand(commandName?: string): boolean {
  return commandName === "hub" || commandName === "capabilities";
}

async function runTuiCommand(): Promise<void> {
  const { launchTui } = await import("./tui.js");
  launchTui();
}

// ── Telemetry hooks ──

// preAction: fire the event at the START of the command. Two reasons:
//  - the async request gets the whole command runtime to land in the background
//  - commands that call process.exit() (e.g. `check` on drift) are still
//    counted; a postAction hook would never run after process.exit and would
//    systematically miss every error/drift outcome.
// scaffold_id is resolved read-only (never mints). Telemetry never throws here.
program.hook("preAction", (_thisCommand, actionCommand) => {
  try {
    // Never count the telemetry/config meta-commands. In particular,
    // `telemetry inspect` must have zero side effects — no event sent, no
    // machine-id file created — so it stays a pure audit surface.
    const parentName = actionCommand.parent?.name();
    if (isTelemetryExemptCommand(actionCommand.name(), parentName)) return;

    let scaffoldId: string | undefined;
    try {
      scaffoldId = readScaffoldId(findConfig().scaffoldRoot);
    } catch {
      // No scaffold (or not in one) — omit scaffold_id.
    }
    captureCommand(actionCommand.name(), scaffoldId);
  } catch {
    // Telemetry must never affect command behaviour.
  }
});

// postAction: best-effort bounded flush for commands that exit naturally.
// Commands that process.exit() skip this, but their event was already sent
// from preAction (flushAt:1 fires the request immediately).
program.hook("postAction", async (_thisCommand, actionCommand) => {
  if (isTelemetryExemptCommand(actionCommand.name(), actionCommand.parent?.name())) return;
  try {
    await flush();
  } catch {
    // Telemetry must never affect command behaviour.
  }
});

program
  .name("mex")
  .description("CLI engine for mex scaffold — drift detection, pre-analysis, and targeted sync")
  .version(VERSION)
  .showHelpAfterError()
  .action(async () => {
    await runTuiCommand();
  });

program
  .command("tui")
  .description("Open the interactive mex dashboard")
  .action(async () => {
    await runTuiCommand();
  });

program
  .command("hub")
  .description("Launch the local Project Hub")
  .option("--port <n>", "Bind a specific loopback port", parsePortArg)
  .option("--no-open", "Do not open the browser automatically")
  .action(async (opts: { port?: number; open: boolean }) => {
    try {
      const config = loadConfig();
      const identity = getScaffoldIdentity(config);
      const { runHubCommand } = await import("./hub/command.js");
      await runHubCommand(createHubRunOptions(config, identity.scaffold_id, opts));
    } catch (err) {
      console.error((err as Error).message);
      process.exitCode = 1;
    }
  });

program
  .command("capabilities")
  .description("Inspect installed and currently available machine capabilities")
  .option("--json", "Emit the versioned machine-readable capability manifest")
  .action(async (options: { json?: boolean }) => {
    if (options.json !== true) {
      console.error("mex capabilities requires --json.");
      process.exitCode = 2;
      return;
    }
    const { runCapabilities } = await import("./capabilities.js");
    await runCapabilities();
  });

// ── Setup (npx entry point) ──
program
  .command("setup")
  .description("First-time setup — create .mex/ scaffold and populate with AI")
  .option("--mode <mode>", "Template mode: code-repo (default) or agent-memory", "code-repo")
  .option("--dry-run", "Show what would happen without making changes")
  .action(async (opts) => {
    try {
      const { runSetup } = await import("./setup/index.js");
      await runSetup({ dryRun: opts.dryRun, mode: opts.mode });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 2: Drift Detection ──
program
  .command("check")
  .description("Detect drift between scaffold files and codebase reality")
  .option("--json", "Output full drift report as JSON")
  .option("--quiet", "Single-line summary only")
  .option("--fix", "Run sync to fix any issues found")
  .option("--verbose", "Show detailed diagnostic output")
  .option("--stale-warn-days <n>", "Warn when a file hasn't changed in N days (default 30)", parseIntArg)
  .option("--stale-error-days <n>", "Error when a file hasn't changed in N days (default 90)", parseIntArg)
  .option("--stale-warn-commits <n>", "Warn when a file has N commits since its last change (default 50)", parseIntArg)
  .option("--stale-error-commits <n>", "Error when a file has N commits since its last change (default 200)", parseIntArg)
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runDriftCheckWithGraphStatus } = await import("./drift/index.js");
      const { DEFAULT_STALENESS_THRESHOLDS } = await import("./drift/checkers/staleness.js");

      const stalenessThresholds = {
        warnDays: opts.staleWarnDays ?? config.stalenessThresholds?.warnDays ?? DEFAULT_STALENESS_THRESHOLDS.warnDays,
        errorDays: opts.staleErrorDays ?? config.stalenessThresholds?.errorDays ?? DEFAULT_STALENESS_THRESHOLDS.errorDays,
        warnCommits: opts.staleWarnCommits ?? config.stalenessThresholds?.warnCommits ?? DEFAULT_STALENESS_THRESHOLDS.warnCommits,
        errorCommits: opts.staleErrorCommits ?? config.stalenessThresholds?.errorCommits ?? DEFAULT_STALENESS_THRESHOLDS.errorCommits,
      };

      const report = await runDriftCheckWithGraphStatus(
        { ...config, stalenessThresholds },
        { verbose: opts.verbose },
      );

      if (opts.json) {
        reportJSON(report, { verbose: opts.verbose });
      } else if (opts.quiet) {
        reportQuiet(report);
      } else {
        if (opts.verbose) reportVerbose(report);
        reportConsole(report);
      }

      // If --fix and there are issues, jump to sync
      const hasErrors = report.issues.some((i) => i.severity === "error");
      if (opts.fix && hasErrors) {
        const { runSync } = await import("./sync/index.js");
        await runSync(config, {});
        return;
      }

      if (hasErrors) process.exit(1);

      // Warm moment — a clean check just gave the user value. Quietly invite
      // feedback (only on success, never right before an error exit).
      maybeShowInvite();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 1: Pre-analysis Scanner ──
program
  .command("init")
  .description("Scan codebase and generate pre-analysis brief for AI")
  .option("--json", "Output scanner brief as JSON")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runScan } = await import("./scanner/index.js");
      const result = await runScan(config, { jsonOnly: opts.json });

      if (opts.json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(result);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Code Graph ──
const graphCommand = program
  .command("graph")
  .description("Inspect or explicitly maintain the code knowledge graph")
  .option("--json", "Output the build summary as JSON")
  .option("--root <dir>", "Project root to index (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraph } = await import("./graph/cli-graph.js");
      await runGraph({ root: opts.root, json: opts.json });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

graphCommand
  .command("status")
  .description("Inspect graph freshness without writing or rebuilding")
  .option("--json", "Output the complete graph status as JSON")
  .option("--root <dir>", "Project root to inspect (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphStatus } = await import("./graph/cli-graph.js");
      await runGraphStatus({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

graphCommand
  .command("refresh")
  .description("Explicitly refresh a compatible graph from the current repository")
  .option("--json", "Output the complete refresh result as JSON")
  .option("--root <dir>", "Project root to refresh (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphRefresh } = await import("./graph/cli-graph.js");
      await runGraphRefresh({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

graphCommand
  .command("rebuild")
  .description("Rebuild in isolation, validate, and atomically publish the graph")
  .option("--json", "Output the complete rebuild result as JSON")
  .option("--root <dir>", "Project root to rebuild (defaults to current directory)")
  .action(async (opts) => {
    try {
      const { runGraphRebuild } = await import("./graph/cli-graph.js");
      await runGraphRebuild({
        root: opts.root ?? graphCommand.opts().root,
        json: opts.json ?? graphCommand.opts().json,
      });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

graphCommand
  .command("query <relation> <target>")
  .description("Query graph structure: who-calls, what-calls, or where-defined")
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--max-nodes <n>", "maximum results to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .action((relation, target, options) => {
    return import("./graph/cli-agent.js").then(({ runGraphQuery }) => runGraphQuery(relation, target, process.cwd(), {}, options));
  });

graphCommand
  .command("scope <task...>")
  .description("Retrieve source-backed code context and execution flow for a task as JSONL")
  .option("--detail <level>", "minimal | standard | source", "source")
  .option("--max-nodes <n>", "maximum nodes to return")
  .option("--max-files <n>", "maximum source files to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .option("--fingerprint", "attach serialized node fingerprints (grounding workflow)")
  .option("--wiki", "also return knowledge entities grounded to the nodes in scope")
  .action(async (task: string[], options) => {
    const { runGraphScope } = await import("./graph/cli-agent.js");
    // Composed here, not imported by the graph. With the flag off there is no
    // provider at all, so the graph's output path is the same code it was
    // before this option existed — which is what makes "byte-identical when
    // off" a structural property rather than a promise.
    const deps = options.wiki === true
      ? await import("./wiki/cli/for-code.js").then(({ knowledgeRecordsFor }) => ({
          knowledgeFor: (nodeIds: readonly string[]): Array<Record<string, unknown>> =>
            knowledgeRecordsFor(nodeIds).map((record) => ({ ...record })),
        }))
      : {};
    return runGraphScope(task.join(" "), process.cwd(), deps, options);
  });

// ── Wiki ──
//
// P9 owns the full wiki command surface and the JSON envelope. This one command
// exists now because the reverse join is the phase's product claim and a
// library function does not demonstrate it. It is a thin shell over
// `wiki/query/for-code.ts`.
const wikiCommand = program
  .command("wiki")
  .description("Knowledge-graph commands over the .mex wiki");

/**
 * The scaffold-shaped options every wiki command needs.
 *
 * One resolution, so ten commands cannot disagree about where the scaffold is
 * or which paths are reserved. `wiki.exclude` and `wiki.readOnly` come from
 * config (D10) rather than from flags: a reserved path is a property of the
 * project, not of the invocation.
 */
function wikiIo(): import("./wiki/cli/commands.js").CommandIo {
  // Advertised Wiki reads and previews are non-persisting. In particular,
  // resolving their configuration must never backfill a missing scaffold_id.
  const config = findConfig();
  return {
    write: (line: string) => console.log(line),
    setExitCode: (code: number) => {
      process.exitCode = code;
    },
    scaffoldRoot: config.scaffoldRoot,
    projectRoot: config.projectRoot,
    ...(config.wiki?.exclude === undefined ? {} : { exclude: config.wiki.exclude }),
    ...(config.wiki?.readOnly === undefined ? {} : { readOnly: config.wiki.readOnly }),
  };
}

/** The §15.1 filters, added to whichever commands they apply to. */
function withReadFilters(command: Command): Command {
  return command
    .option("--type <type>", "only entities of this type")
    .option("--topic <id-or-alias>", "only entities in this topic")
    .option("--status <status>", "only entities in this lifecycle state")
    .option("--health <health>", "only entities whose worst grounding health is this")
    .option("--limit <n>", "maximum records to return; clamped, never unbounded")
    .option("--include-archived", "include archived entities, which are excluded by default")
    .option("--json", "emit one enveloped JSON object instead of JSONL records");
}

withReadFilters(wikiCommand.command("list").description("Entities in this scaffold, bounded")).action(
  async (options) => {
    const { runList } = await import("./wiki/cli/commands.js");
    runList(wikiIo(), options);
  },
);

wikiCommand
  .command("show <id>")
  .description("One entity, with its body")
  .option("--no-body", "omit the entity body")
  .option("--json", "emit one enveloped JSON object")
  .action(async (id: string, options) => {
    const { runShow } = await import("./wiki/cli/commands.js");
    runShow(wikiIo(), id, options);
  });

withReadFilters(wikiCommand.command("query <text...>").description("Full-text search, title before body")).action(
  async (text: string[], options) => {
    const { runQuery } = await import("./wiki/cli/commands.js");
    runQuery(wikiIo(), text.join(" "), options);
  },
);

withReadFilters(wikiCommand.command("related <id>").description("The bounded neighbourhood around an entity"))
  .option("--depth <n>", "traversal depth; clamped")
  .option("--max-tokens <n>", "token budget for the neighbourhood")
  .action(async (id: string, options) => {
    const { runRelated } = await import("./wiki/cli/commands.js");
    runRelated(wikiIo(), id, options);
  });

withReadFilters(wikiCommand.command("backlinks <id>").description("Entities that point at this one")).action(
  async (id: string, options) => {
    const { runBacklinks } = await import("./wiki/cli/commands.js");
    runBacklinks(wikiIo(), id, options);
  },
);

wikiCommand
  .command("validate")
  .description("Check the whole scaffold; works with no index and no code graph")
  .option("--limit <n>", "maximum diagnostics to report")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runValidate } = await import("./wiki/cli/commands.js");
    runValidate(wikiIo(), options);
  });

withReadFilters(wikiCommand.command("graph").description("A bounded slice of the relation graph")).action(
  async (options) => {
    const { runGraph } = await import("./wiki/cli/commands.js");
    runGraph(wikiIo(), options);
  },
);

wikiCommand
  .command("rebuild-index")
  .description("Rebuild the disposable index; the only command that creates it")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runRebuildIndex } = await import("./wiki/cli/commands.js");
    runRebuildIndex(wikiIo(), options);
  });

wikiCommand
  .command("regenerate-views")
  .description("Rewrite generated sections that have drifted; --dry-run reports only")
  .option("--dry-run", "report what has drifted and write nothing")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runRegenerateViews } = await import("./wiki/cli/commands.js");
    runRegenerateViews(wikiIo(), options);
  });

wikiCommand
  .command("migrate")
  .description("Convert a pre-wiki scaffold; --dry-run writes nothing and mints no id")
  .option("--dry-run", "report what would happen and write nothing")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runMigrate } = await import("./wiki/cli/commands.js");
    runMigrate(wikiIo(), options);
  });

wikiCommand
  .command("apply <operation-file>")
  .description("Plan an operation from a JSON file; writes only with --apply")
  .option("--apply", "write the change, rather than only planning it")
  .option("--dry-run", "plan only, even if --apply was given")
  .option("--json", "emit one enveloped JSON object")
  .action(async (file: string, options) => {
    const { runApply } = await import("./wiki/cli/commands.js");
    runApply(wikiIo(), file, options);
  });

/**
 * The synthesis wiring: the code graph, and an agent launcher.
 *
 * Composed here rather than imported anywhere under `src/wiki/`, for the same
 * reason `knowledgeFor` is (handoff §39.7): a `src/graph/` to `src/wiki/`
 * import would be a genuine cycle, and injection makes "synthesis does nothing
 * without a graph" a structural property rather than a promise. Everything
 * below is lazily imported so a `mex check` pays none of it.
 */
async function synthesisIo(): Promise<import("./wiki/cli/commands.js").CommandIo> {
  const base = wikiIo();
  const config = loadConfig();
  const { resolve } = await import("node:path");
  const { existsSync } = await import("node:fs");
  const dbPath = resolve(config.projectRoot, ".mex", "graph.db");
  if (!existsSync(dbPath)) return base;

  const [
    { createGroundingGraph, createSynthesisGraph },
    { openGraphDatabase },
    { createGraphEngine },
    { MinHashReconciler },
    { FingerprintStore },
    { AI_TOOLS },
    { isCliAvailable },
    { runToolInteractive },
  ] = await Promise.all([
    import("./wiki/grounding/adapter.js"),
    import("./graph/db/database.js"),
    import("./graph/engine-impl.js"),
    import("./graph/reconcile-engine.js"),
    import("./graph/fingerprint-store.js"),
    import("./types.js"),
    import("./cli-tools.js"),
    import("./sync/index.js"),
  ]);

  const db = openGraphDatabase(dbPath);
  const engine = createGraphEngine({ rootDir: config.projectRoot, dbPath });
  return {
    ...base,
    repoRoot: config.projectRoot,
    codeGraph: createSynthesisGraph(engine, db),
    graph: createGroundingGraph(engine, new MinHashReconciler(new FingerprintStore(db)), db),
    ...(config.wiki?.synthesis === undefined ? {} : { synthesisScope: config.wiki.synthesis }),
    launchAgent: (playbook: string) => {
      // mex's own launcher, not a second one: six tools, cross-platform
      // detection, and the Windows shim handling that issue #85 paid for.
      // The configured tools first, then whatever else is installed. No
      // interactive question: an agent-facing command that stopped to ask which
      // CLI to use would hang the run it was supposed to start.
      const candidates = [...config.aiTools, ...(Object.keys(AI_TOOLS) as import("./types.js").AiTool[])];
      for (const tool of candidates) {
        const meta = AI_TOOLS[tool];
        if (meta.cli === null || !isCliAvailable(meta.cli)) continue;
        return runToolInteractive(tool, playbook, config.projectRoot);
      }
      return false;
    },
  };
}

wikiCommand
  .command("build")
  .description("Discover clusters and hand an agent the synthesis playbook")
  .option("--cluster <name>", "restrict the run to one cluster")
  .option("--print", "print the playbook rather than launching an agent")
  .option("--json", "emit one enveloped JSON object; never launches an agent")
  .action(async (options) => {
    const { runBuild } = await import("./wiki/cli/commands.js");
    runBuild(await synthesisIo(), { ...options, print: options.print === true || options.json === true });
  });

wikiCommand
  .command("prepare")
  .description("The deterministic scope and prompt for one synthesis stage")
  .option("--stage <stage>", "architecture_component | pattern | convention | global | relationships")
  .option("--cluster <name>", "which cluster, for the per-cluster stages")
  .option("--json", "emit one enveloped JSON object")
  .action(async (options) => {
    const { runPrepare } = await import("./wiki/cli/commands.js");
    runPrepare(await synthesisIo(), options);
  });

wikiCommand
  .command("propose <response-file>")
  .description("Validate an agent's synthesis response into operation plans; writes only with --apply")
  .option("--apply", "write the changes, rather than only planning them")
  .option("--dry-run", "plan only, even if --apply was given")
  .option("--stage <stage>", "the stage this response answers, when the file does not say")
  .option("--cluster <name>", "the cluster this response is for, when the file does not say")
  .option("--json", "emit one enveloped JSON object")
  .action(async (file: string, options) => {
    const { runPropose } = await import("./wiki/cli/commands.js");
    runPropose(await synthesisIo(), file, options);
  });

wikiCommand
  .command("for-code <nodeId...>")
  .description("Knowledge entities grounded to the given code-graph node ids")
  .option("--json", "Emit one enveloped JSON object instead of JSONL records")
  .option("--limit <n>", "maximum entities to return")
  .option("--include-archived", "include archived entities, which are excluded by default")
  .action(async (nodeIds: string[], options) => {
    const { runWikiForCode } = await import("./wiki/cli/for-code.js");
    runWikiForCode(nodeIds, process.cwd(), {
      json: options.json === true,
      limit: options.limit === undefined ? undefined : Number(options.limit),
      includeArchived: options.includeArchived === true,
    });
  });

graphCommand
  .command("get <id...>")
  .description("Expand source for specific node ids as JSONL")
  .option("--detail <level>", "source (get always returns source)", "source")
  .option("--max-source-lines <n>", "per-node source line cap")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .action((ids: string[], options) => {
    return import("./graph/cli-agent.js").then(({ runGraphGet }) => runGraphGet(ids, process.cwd(), {}, options));
  });

graphCommand
  .command("ground")
  .description("Retro-ground an existing pre-0.7 scaffold using the code graph")
  .option("--dry-run", "Print the migration prompt without launching an agent")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runGraphGround } = await import("./graph/cli-ground.js");
      await runGraphGround(config, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("impact <target>")
  .description("Show transitive code and scaffold blast radius for a symbol or file")
  .option("--detail <level>", "minimal | standard | source", "minimal")
  .option("--depth <n>", "transitive caller depth", "2")
  .option("--max-nodes <n>", "maximum impacted nodes to return")
  .option("--max-output-tokens <n>", "hard output token ceiling")
  .option("--max-source-lines <n>", "per-node source line cap (with --detail source)")
  .action((target, options) => {
    return import("./graph/cli-agent.js").then(({ runImpact }) => runImpact(target, process.cwd(), {}, options));
  });

// ── Agent Memory Events ──
program
  .command("log <message>")
  .description("Append a decision, note, risk, or todo to the mex event log")
  .option("--type <type>", "Event type: decision, note, risk, todo", "note")
  .option("--file <path>", "Related file path (repeatable)", (value, prev: string[]) => [...prev, value], [])
  .option("--source <source>", "Where the event came from (e.g. meeting, manual, agent)")
  .option("--status <status>", "Lifecycle status (e.g. decided, implemented)")
  .action(async (message, opts) => {
    try {
      const config = loadConfig();
      const { runLog } = await import("./events.js");
      await runLog(config, message, { kind: opts.type, files: opts.file, source: opts.source, status: opts.status });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("timeline")
  .description("Show recent mex event log entries")
  .option("--json", "Output events as JSON")
  .option("--since <date>", "Filter from YYYY-MM-DD or relative Nd, e.g. 30d")
  .option("--type <type>", "Filter by event type")
  .option("--limit <n>", "Maximum number of entries", parsePositiveIntArg)
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runTimeline } = await import("./events.js");
      await runTimeline(config, opts);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("heartbeat")
  .description("Run lightweight agent-memory health checks once")
  .option("--json", "Output heartbeat report as JSON")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runHeartbeat } = await import("./heartbeat.js");
      await runHeartbeat(config, { json: opts.json });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("doctor")
  .description("Run a friendly scaffold health diagnostic")
  .action(async () => {
    try {
      const config = loadConfig();
      const { runDoctor } = await import("./doctor.js");
      await runDoctor(config);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 3: Targeted Sync ──
program
  .command("sync")
  .description("Run drift check, then build targeted prompts for AI to fix flagged files")
  .option("--dry-run", "Show what would be synced without executing")
  .option("--warnings", "Include warning-only files (by default only errors are synced)")
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { runSync } = await import("./sync/index.js");
      await runSync(config, { dryRun: opts.dryRun, includeWarnings: opts.warnings });
      maybeShowInvite();
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Layer 4: Patterns ──
const patternCmd = program
  .command("pattern")
  .description("Manage pattern files");

patternCmd
  .command("add <name>")
  .description("Create a new pattern file and add it to the index")
  .action(async (name) => {
    try {
      const config = loadConfig();
      const { runPatternAdd } = await import("./pattern/index.js");
      await runPatternAdd(config, name);
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Git Hook ──
program
  .command("watch")
  .description("Install/uninstall post-commit hook, or run heartbeat on an interval")
  .option("--uninstall", "Remove the post-commit hook")
  .option("--interval [minutes]", "Run mex heartbeat repeatedly instead of installing a hook", (v) => v === undefined ? true : parsePositiveIntArg(v))
  .action(async (opts) => {
    try {
      const config = loadConfig();
      const { manageHook } = await import("./watch.js");
      const intervalMinutes = opts.interval === true
        ? config.watch?.intervalMinutes ?? 30
        : typeof opts.interval === "number"
          ? opts.interval
          : undefined;
      await manageHook(config, { uninstall: opts.uninstall, intervalMinutes });
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

program
  .command("completion <shell>")
  .description("Print shell completion script for bash, zsh, or fish")
  .action((shell) => {
    try {
      console.log(buildCompletion(shell));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Telemetry ──
const telemetryCmd = program
  .command("telemetry")
  .description("Telemetry transparency commands");

telemetryCmd
  .command("inspect")
  .description("Print the exact JSON payload that would be sent (without sending it)")
  .action(() => {
    try {
      // Read-only: use readScaffoldId (never mints), not getScaffoldIdentity
      let scaffoldId: string | undefined;
      try {
        const config = findConfig();
        scaffoldId = readScaffoldId(config.scaffoldRoot);
      } catch { /* no scaffold — omit scaffold_id */ }

      // Read-only: show the machine_id only if it already exists. Auditing the
      // payload must never plant the tracking file on disk.
      const machineId = readMachineId();

      const payload = getPayloadPreview("inspect", scaffoldId, machineId);
      console.log(JSON.stringify(payload, null, 2));
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

telemetryCmd
  .command("status")
  .description("Show whether telemetry is enabled and the active opt-out reason")
  .action(() => {
    const result = isEnabled();
    if (result.enabled) {
      console.log("Telemetry: enabled");
    } else {
      console.log(`Telemetry: disabled (reason: ${result.reason})`);
    }
  });

// ── Config ──
const configCmd = program
  .command("config")
  .description("Manage global mex configuration");

configCmd
  .command("set <key> <value>")
  .description("Set a global config value (e.g. telemetry on|off)")
  .action((key: string, value: string) => {
    try {
      if (key === "telemetry") {
        if (value !== "on" && value !== "off") {
          console.error(`Invalid value "${value}" for telemetry. Use "on" or "off".`);
          process.exit(1);
        }
        setGlobalConfigKey("telemetry", value);
        console.log(`Telemetry set to "${value}" in ~/.mex/config.json`);
      } else if (key === "feedback") {
        if (value !== "on" && value !== "off") {
          console.error(`Invalid value "${value}" for feedback. Use "on" or "off".`);
          process.exit(1);
        }
        // "off" hides the invite; "on" re-enables it.
        if (value === "off") dismissInvite();
        else enableInvite();
        console.log(`Feedback invite ${value === "off" ? "hidden" : "re-enabled"}.`);
      } else {
        console.error(`Unknown config key "${key}". Supported keys: telemetry, feedback`);
        process.exit(1);
      }
    } catch (err) {
      console.error((err as Error).message);
      process.exit(1);
    }
  });

// ── Feedback ──
program
  .command("feedback")
  .description("Open the mex feedback form (the maintainer is doing user research calls)")
  .action(() => {
    runFeedback();
  });

// ── Quick Reference ──
program
  .command("commands")
  .description("List all available commands and scripts")
  .action(() => {
    console.log(chalk.bold("\nCLI Commands") + chalk.dim("  (run from project root)\n"));
    console.log("  mex setup              First-time setup — create .mex/ scaffold");
    console.log("  mex setup --dry-run    Preview setup without making changes");
    console.log("  mex capabilities --json  Discover structured agent capabilities");
    console.log("  mex check              Drift score — are scaffold files still accurate?");
    console.log("  mex check --quiet      One-liner drift score");
    console.log("  mex check --json       Full drift report as JSON");
    console.log("  mex check --fix        Check and fix any errors found");
    console.log("  mex sync               Fix drift — AI updates only what's broken");
    console.log("  mex sync --dry-run     Preview fix prompts without running them");
    console.log("  mex sync --warnings    Include warning-only files in sync");
    console.log("  mex init               Pre-scan codebase, build brief for AI");
    console.log("  mex init --json        Scanner brief as JSON");
    console.log("  mex graph              Build the code knowledge graph into .mex/graph.db");
    console.log("  mex graph --json       Graph build summary as JSON");
    console.log("  mex graph scope <task>               Compact task neighborhood as JSONL");
    console.log("  mex graph get <id...>                Expand source for node ids as JSONL");
    console.log("  mex graph ground                     Ground an existing pre-0.7 scaffold");
    console.log("  mex graph query <relation> <target>  Structural lookup as JSONL");
    console.log("  mex impact <symbol|file>              Blast radius as JSONL");
    console.log("  mex log <message>      Append a note/decision/risk/todo to the event log");
    console.log("  mex timeline           Show recent event log entries");
    console.log("  mex heartbeat          Run lightweight agent-memory health checks");
    console.log("  mex doctor             Friendly scaffold health summary");
    console.log("  mex tui                Open the interactive mex dashboard");
    console.log("  mex hub                Launch the local Project Hub");
    console.log("  mex hub --no-open      Launch without opening a browser");
    console.log("  mex pattern add <name> Create a new pattern file");
    console.log("  mex watch              Install post-commit hook for auto drift score");
    console.log("  mex watch --interval   Run heartbeat every 30 minutes (or config value)");
    console.log("  mex watch --uninstall  Remove the post-commit hook");
    console.log("  mex telemetry inspect  Show the exact telemetry payload (without sending)");
    console.log("  mex telemetry status   Show telemetry enabled/disabled and reason");
    console.log("  mex config set <k> <v> Set a global config value (e.g. telemetry off)");
    console.log("  mex feedback           Open the feedback form (the maintainer does user calls)");
    console.log();
    console.log(chalk.dim("Not installed globally? Replace 'mex' with 'npx mex-agent'."));
    console.log();
  });

// Skip auto-parse when imported (e.g. by tests). The bin entry is built by
// tsup as ./dist/cli.js with a shebang banner; only run program.parseAsync()
// when this module is the script being invoked. Resolve argv[1] so symlinked
// bins (npm global, npx, node_modules/.bin) match import.meta.url.
//
// Critical: use parseAsync(), not parse(). Commander's sync parse() does not
// await the promise chain built by hooks and async actions — preAction/
// postAction hooks would silently never execute and telemetry events would
// never flush.
let isMainModule = false;
if (process.argv[1]) {
  try {
    isMainModule = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  } catch {
    // argv[1] is missing or not on disk (e.g. test fixtures) — not the main entry.
  }
}
if (isMainModule) {
  if (!isFirstRunNoticeExemptCommand(process.argv[2])) showFirstRunNotice();
  program.parseAsync().catch((err: Error) => {
    console.error(err.message);
    process.exit(1);
  });
}

function buildCompletion(shell: string): string {
  const commands = [
    "setup", "capabilities", "check", "init", "graph", "wiki", "impact", "sync", "pattern", "log", "timeline",
    "heartbeat", "doctor", "watch", "tui", "commands", "completion",
    "telemetry", "config", "feedback", "hub",
  ];
  if (shell === "bash") {
    return `_mex_completion() {
  COMPREPLY=($(compgen -W "${commands.join(" ")}" -- "\${COMP_WORDS[COMP_CWORD]}"))
}
complete -F _mex_completion mex`;
  }
  if (shell === "zsh") {
    return `#compdef mex
_arguments '1:command:(${commands.join(" ")})'`;
  }
  if (shell === "fish") {
    return commands.map((cmd) => `complete -c mex -f -a ${cmd}`).join("\n");
  }
  throw new Error(`Unknown shell "${shell}". Use bash, zsh, or fish.`);
}
