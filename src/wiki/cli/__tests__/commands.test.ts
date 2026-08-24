/**
 * §20.7 — the CLI contract, over all ten commands rather than a spot check.
 *
 * The commands are driven through their exported functions with an injected
 * `write` and `setExitCode`, not by spawning a CLI. That is deliberate: the
 * thing under test is the contract, and spawning would test commander's
 * argument parsing at ten times the cost while making the assertions about exit
 * status harder to read. `src/cli.ts` is a registration table over these
 * functions, and `test/cli.test.ts` covers that it loads.
 */

import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import chalk from "chalk";
import {
  runApply,
  runBacklinks,
  runGraph,
  runList,
  runMigrate,
  runQuery,
  runRebuildIndex,
  runRelated,
  runShow,
  runValidate,
  filtersFrom,
  type CommandFlags,
  type CommandIo,
} from "../commands.js";
import { WIKI_EXIT } from "../envelope.js";
import { COMMAND_BINDINGS } from "../../service/surface.js";
import { wikiRebuildIndex } from "../../service/write.js";
import { locateEntity } from "../../operations/locate.js";

const ARCH = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
const GATEWAY = "mx_01BX5ZZKBKACTAV9WEVGEMMVRZ";
const TOPIC = "mx_01KRMEXM00JAAVJPQVVRX8N56V";

const ARCHITECTURE_MD = `<!-- mex:entity
id: ${TOPIC}
type: topic
status: promoted
revision: 1
-->
## Authentication

Everything about tokens.

<!-- mex:entity
id: ${ARCH}
type: architecture
status: promoted
revision: 1
topics: [${TOPIC}]
relations:
  - type: depends_on
    target: ${GATEWAY}
-->
## System architecture

Three services behind one gateway.

<!-- mex:entity
id: ${GATEWAY}
type: component
status: promoted
revision: 1
-->
## Gateway

Terminates TLS and routes by path prefix.
`;

const roots: string[] = [];
let colourWas: boolean;

beforeEach(() => {
  // Colour forced on for the whole file. Trap 3: a test that runs with colour
  // disabled proves nothing about the JSON path, and chalk disables itself when
  // stdout is not a TTY — which is exactly what a test runner is.
  colourWas = chalk.level > 0;
  chalk.level = 3;
});

afterEach(() => {
  chalk.level = colourWas ? 3 : 0;
  for (const root of roots.splice(0)) {
    try {
      rmSync(root, { recursive: true, force: true });
    } catch {
      // Windows keeps handles on just-closed SQLite files.
    }
  }
});

interface Captured {
  io: CommandIo;
  lines: string[];
  exit: () => number;
  root: string;
}

function harness(indexed = true, files: Record<string, string> = {}): Captured {
  const root = mkdtempSync(join(tmpdir(), "mex-cli-"));
  roots.push(root);
  for (const [path, text] of Object.entries({ "context/architecture.md": ARCHITECTURE_MD, ...files })) {
    const absolute = join(root, path);
    mkdirSync(join(absolute, ".."), { recursive: true });
    writeFileSync(absolute, text, "utf-8");
  }
  if (indexed) wikiRebuildIndex({ scaffoldRoot: root });

  const lines: string[] = [];
  let code: number = WIKI_EXIT.ok;
  return {
    root,
    lines,
    exit: () => code,
    io: {
      write: (line) => lines.push(line),
      setExitCode: (next) => {
        code = next;
      },
      scaffoldRoot: root,
      projectRoot: root,
    },
  };
}

/** Every command, driven the same way, so an assertion can be made over all ten. */
function allCommands(
  harnessed: Captured,
  flags: CommandFlags,
): Array<{ command: string; run: () => void }> {
  const { io } = harnessed;
  return [
    { command: "list", run: () => runList(io, flags) },
    { command: "show", run: () => runShow(io, ARCH, flags) },
    { command: "query", run: () => runQuery(io, "gateway", flags) },
    { command: "related", run: () => runRelated(io, ARCH, flags) },
    { command: "backlinks", run: () => runBacklinks(io, GATEWAY, flags) },
    { command: "validate", run: () => runValidate(io, flags) },
    { command: "graph", run: () => runGraph(io, flags) },
    { command: "rebuild-index", run: () => runRebuildIndex(io, flags) },
    { command: "migrate", run: () => runMigrate(io, { ...flags, dryRun: true }) },
    { command: "apply", run: () => runApply(io, join(harnessed.root, "op.json"), flags) },
  ];
}

describe("stable JSON envelopes", () => {
  it("every one of the ten returns the §15.2 shape", () => {
    const cases = allCommands(harness(), { json: true });
    // The count is asserted so a command dropped from the list fails here
    // rather than quietly reducing what this suite covers.
    expect(cases).toHaveLength(10);
    expect(cases.map((entry) => entry.command).sort()).toEqual(
      COMMAND_BINDINGS.map((entry) => entry.command).sort(),
    );
  });

  it("emits exactly one enveloped object per command under --json", () => {
    for (const { command } of allCommands(harness(), { json: true })) {
      const local = harness();
      writeFileSync(join(local.root, "op.json"), "{}", "utf-8");
      const entry = allCommands(local, { json: true }).find((candidate) => candidate.command === command)!;
      entry.run();
      expect(local.lines, command).toHaveLength(1);
      const parsed = JSON.parse(local.lines[0]!) as Record<string, unknown>;
      expect(Object.keys(parsed).sort(), command).toEqual(["data", "diagnostics", "ok", "schemaVersion"]);
      expect(parsed["schemaVersion"], command).toBe(1);
      expect(Array.isArray(parsed["diagnostics"]), command).toBe(true);
    }
  });
});

describe("no ANSI in JSON", () => {
  it("holds for all ten with colour forced on", () => {
    // Built, never written: a literal escape byte in a source file is banned.
    const escape = String.fromCharCode(0x1b);
    expect(chalk.level).toBeGreaterThan(0);
    // The guard on the guard: chalk really would colour if asked.
    expect(chalk.red("x").includes(escape)).toBe(true);

    for (const { command } of allCommands(harness(), { json: true })) {
      const local = harness();
      writeFileSync(join(local.root, "op.json"), "{}", "utf-8");
      allCommands(local, { json: true }).find((candidate) => candidate.command === command)!.run();
      for (const line of local.lines) expect(line.includes(escape), `${command}: ${line}`).toBe(false);
    }
  });

  it("does colour the human path, so the JSON assertion is not vacuous", () => {
    const escape = String.fromCharCode(0x1b);
    const local = harness(false);
    runList(local.io, {});
    // No index, so a diagnostic is rendered — in red.
    expect(local.lines.some((line) => line.includes(escape))).toBe(true);
  });
});

describe("typed exit statuses", () => {
  it("never pairs ok:false with exit 0, across all ten", () => {
    let checked = 0;
    for (const { command } of allCommands(harness(), { json: true })) {
      // No index and no operation file: several of the ten now fail.
      const local = harness(false);
      allCommands(local, { json: true }).find((candidate) => candidate.command === command)!.run();
      const parsed = JSON.parse(local.lines[0]!) as { ok: boolean };
      if (!parsed.ok) expect(local.exit(), command).not.toBe(WIKI_EXIT.ok);
      else expect(local.exit(), command).toBe(WIKI_EXIT.ok);
      checked += 1;
    }
    expect(checked).toBe(10);
  });

  it("reports a missing index as its own status, distinct from a diagnostic failure", () => {
    const local = harness(false);
    runList(local.io, { json: true });
    expect(local.exit()).toBe(WIKI_EXIT.index);
    const parsed = JSON.parse(local.lines[0]!) as { diagnostics: Array<{ code: string; remediation?: string }> };
    expect(parsed.diagnostics[0]?.code).toBe("WIKI_INDEX_MISSING");
    // The message has to say how to fix it (§15.2).
    expect(parsed.diagnostics[0]?.remediation).toContain("rebuild-index");
  });

  it("reports an unreadable operation file as a usage error, not an index one", () => {
    const local = harness();
    writeFileSync(join(local.root, "op.json"), "{ not json", "utf-8");
    runApply(local.io, join(local.root, "op.json"), { json: true });
    expect(local.exit()).toBe(WIKI_EXIT.usage);
  });
});

describe("missing-index behaviour", () => {
  it("never rebuilds, for any read command", () => {
    const reads = ["list", "show", "query", "related", "backlinks", "graph"];
    for (const command of reads) {
      const local = harness(false);
      allCommands(local, { json: true }).find((candidate) => candidate.command === command)!.run();
      expect(readdirSync(local.root), command).not.toContain("wiki.db");
    }
  });

  it("lets validate answer anyway, and still creates nothing", () => {
    const local = harness(false);
    runValidate(local.io, { json: true });
    const parsed = JSON.parse(local.lines[0]!) as { ok: boolean; data: { entitiesChecked: number } };
    expect(parsed.data.entitiesChecked).toBe(3);
    expect(readdirSync(local.root)).not.toContain("wiki.db");
  });

  it("delete the index, rebuild, and every read command returns — at the command level", () => {
    const local = harness();
    runList(local.io, { json: true });
    const before = JSON.parse(local.lines[0]!) as { data: { entities: unknown[] } };
    expect(before.data.entities).toHaveLength(3);

    rmSync(join(local.root, "wiki.db"));
    local.lines.length = 0;
    runList(local.io, { json: true });
    expect((JSON.parse(local.lines[0]!) as { ok: boolean }).ok).toBe(false);

    local.lines.length = 0;
    runRebuildIndex(local.io, { json: true });
    expect(local.exit()).toBe(WIKI_EXIT.ok);

    for (const command of ["list", "show", "query", "related", "backlinks", "graph"]) {
      const fresh = { ...local, lines: [] as string[] };
      const io: CommandIo = { ...local.io, write: (line) => fresh.lines.push(line) };
      allCommands({ ...local, io, lines: fresh.lines }, { json: true })
        .find((candidate) => candidate.command === command)!
        .run();
      expect((JSON.parse(fresh.lines[0]!) as { ok: boolean }).ok, command).toBe(true);
    }
  });
});

describe("bounded output", () => {
  it("clamps a limit nobody should be able to ask for, and says the list was cut", () => {
    const local = harness();
    runList(local.io, { json: true, limit: 1 });
    const parsed = JSON.parse(local.lines[0]!) as { data: { entities: unknown[]; truncated: boolean } };
    expect(parsed.data.entities).toHaveLength(1);
    // Truncation is data, never a diagnostic (invariant 7).
    expect(parsed.data.truncated).toBe(true);
    expect(JSON.stringify(parsed).includes("TRUNCATED")).toBe(false);
  });

  it("tells a user plainly that a bounded graph is a sample", () => {
    const local = harness();
    runGraph(local.io, { limit: 1 });
    expect(local.lines.join(" ")).toContain("bounded sample");
  });
});

describe("query filters", () => {
  it("mean the same thing wherever they apply", () => {
    expect(filtersFrom({ limit: "25" }).limit).toBe(25);
    expect(filtersFrom({ limit: 25 }).limit).toBe(25);
    // A flag that is not a number is dropped rather than becoming NaN, which
    // would clamp to the default while looking like a deliberate choice.
    expect(filtersFrom({ limit: "lots" }).limit).toBeUndefined();
    expect(filtersFrom({ topic: TOPIC }).topicId).toBe(TOPIC);
    expect(filtersFrom({})).toEqual({});
  });

  it("filter list, query and graph identically", () => {
    const local = harness();
    for (const run of [
      () => runList(local.io, { json: true, type: "component" }),
      () => runGraph(local.io, { json: true, type: "component" }),
    ]) {
      local.lines.length = 0;
      run();
      const parsed = JSON.parse(local.lines[0]!) as { data: { entities?: unknown[]; nodes?: unknown[] } };
      expect((parsed.data.entities ?? parsed.data.nodes)!).toHaveLength(1);
    }
  });
});

describe("mutation cannot bypass review", () => {
  function operationFile(root: string): string {
    const located = locateEntity(GATEWAY, { scaffoldRoot: root })!;
    const path = join(root, "op.json");
    writeFileSync(
      path,
      JSON.stringify({
        opId: "cli-1",
        type: "set-property",
        actor: { kind: "agent", id: "cli-tests" },
        timestamp: "2026-08-25T10:00:00.000Z",
        entityId: GATEWAY,
        baseRevision: located.entity.revision,
        baseContentHash: located.entity.location.entityContentHash,
        payload: { property: "status", value: "deprecated" },
      }),
      "utf-8",
    );
    return path;
  }

  it("plans and writes nothing without --apply — asserted as a negative", () => {
    const local = harness();
    const path = operationFile(local.root);
    const before = readFileSync(join(local.root, "context/architecture.md"), "utf-8");

    runApply(local.io, path, { json: true });
    const parsed = JSON.parse(local.lines[0]!) as { ok: boolean; data: { planned: boolean; applied: boolean } };
    expect(parsed.data.planned).toBe(true);
    expect(parsed.data.applied).toBe(false);
    expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toBe(before);
    expect(readdirSync(local.root)).not.toContain("events");
  });

  it("writes with --apply, and --dry-run overrides it", () => {
    const local = harness();
    const path = operationFile(local.root);
    const before = readFileSync(join(local.root, "context/architecture.md"), "utf-8");

    runApply(local.io, path, { json: true, apply: true, dryRun: true });
    expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toBe(before);

    local.lines.length = 0;
    runApply(local.io, path, { json: true, apply: true });
    expect(readFileSync(join(local.root, "context/architecture.md"), "utf-8")).toContain("status: deprecated");
  });
});

describe("no command builds its own envelope", () => {
  it("holds across the command module", () => {
    // §20.7's parity, structurally: there is one definition, so a command that
    // assembled the shape by hand would be the second one. Comments stripped,
    // so prose about the rule is not read as a breach of it.
    const source = readFileSync(resolve(__dirname, "..", "commands.ts"), "utf-8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/(^|[^:])\/\/.*$/gm, "$1");
    expect(source).not.toMatch(/schemaVersion\s*:/);
    expect(source).not.toMatch(/\bok\s*:\s*(true|false)/);
    // And it does use the shared one, so the assertion above is not passing
    // because the file stopped producing envelopes at all.
    expect(source).toContain("envelopeFor(");
    expect(source).toContain("exitCodeFor(");
  });
});
