import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from "vitest";
import { Command, InvalidArgumentError } from "commander";
import { execFileSync, execSync, spawnSync } from "node:child_process";
import {
  lstatSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  mkdtempSync,
  rmSync,
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runLog, runTimeline } from "../src/events.js";
import { createRepositoryGraphPort } from "../src/graph/application-adapter.js";
import type { MexConfig } from "../src/types.js";

vi.mock("../src/events.js", () => ({
  runLog: vi.fn(),
  runTimeline: vi.fn(),
}));

let parseIntArg: typeof import("../src/cli.js").parseIntArg;
let parsePositiveIntArg: typeof import("../src/cli.js").parsePositiveIntArg;

const config: MexConfig = {
  projectRoot: process.cwd(),
  scaffoldRoot: `${process.cwd()}/.mex`,
  aiTools: [],
};

beforeAll(async () => {
  const originalArgv = process.argv;
  const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.argv = ["node", "mex", "completion", "bash"];
  try {
    ({ parseIntArg, parsePositiveIntArg } = await import("../src/cli.js"));
  } finally {
    process.argv = originalArgv;
    logSpy.mockRestore();
  }
});

beforeEach(() => {
  vi.mocked(runLog).mockResolvedValue(undefined);
  vi.mocked(runTimeline).mockResolvedValue(undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function buildProgram(): Command {
  const program = new Command();
  program
    .name("mex")
    .exitOverride()
    .configureOutput({
      writeOut: () => {},
      writeErr: () => {},
    });

  program
    .command("log <message>")
    .description("Append a decision, note, risk, or todo to the mex event log")
    .option("--type <type>", "Event type: decision, note, risk, todo", "note")
    .option("--file <path>", "Related file path (repeatable)", (value, prev: string[]) => [...prev, value], [])
    .action(async (message, opts) => {
      try {
        const { runLog } = await import("../src/events.js");
        await runLog(config, message, { kind: opts.type, files: opts.file });
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
        const { runTimeline } = await import("../src/events.js");
        await runTimeline(config, opts);
      } catch (err) {
        console.error((err as Error).message);
        process.exit(1);
      }
    });

  return program;
}

describe("CLI argument parsers", () => {
  it("parses non-negative integers", () => {
    expect(parseIntArg("0")).toBe(0);
    expect(parseIntArg("12")).toBe(12);
  });

  it("parses positive integers", () => {
    expect(parsePositiveIntArg("1")).toBe(1);
    expect(parsePositiveIntArg("12")).toBe(12);
  });

  it("rejects non-positive and non-numeric values for positive integers", () => {
    for (const value of ["0", "-1", "foo"]) {
      expect(() => parsePositiveIntArg(value)).toThrow(InvalidArgumentError);
    }
  });
});

describe("mex log parsing", () => {
  it("passes the default type through as note", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "log", "captured context"]);

    expect(runLog).toHaveBeenCalledWith(config, "captured context", {
      kind: "note",
      files: [],
    });
  });

  it("preserves repeated --file values", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "mex",
      "log",
      "tracked files",
      "--file",
      "src/cli.ts",
      "--file",
      "test/cli.test.ts",
      "--file",
      "README.md",
    ]);

    expect(runLog).toHaveBeenCalledWith(config, "tracked files", {
      kind: "note",
      files: ["src/cli.ts", "test/cli.test.ts", "README.md"],
    });
  });

  it("passes --type decision through as kind", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "log", "choose commander", "--type", "decision"]);

    expect(runLog).toHaveBeenCalledWith(config, "choose commander", {
      kind: "decision",
      files: [],
    });
  });

  it("reports invalid --type failures from the log handler", async () => {
    vi.mocked(runLog).mockRejectedValueOnce(
      new Error('Unknown event type "invalid". Use decision, note, risk, or todo.'),
    );
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: string | number | null) => {
      throw new Error(`process.exit ${code}`);
    }) as typeof process.exit);
    const program = buildProgram();

    await expect(
      program.parseAsync(["node", "mex", "log", "bad type", "--type", "invalid"]),
    ).rejects.toThrow("process.exit 1");

    expect(runLog).toHaveBeenCalledWith(config, "bad type", {
      kind: "invalid",
      files: [],
    });
    expect(errorSpy).toHaveBeenCalledWith('Unknown event type "invalid". Use decision, note, risk, or todo.');
    expect(exitSpy).toHaveBeenCalledWith(1);
  });
});

describe("mex timeline parsing", () => {
  it("parses --limit as an integer", async () => {
    const program = buildProgram();
    await program.parseAsync(["node", "mex", "timeline", "--limit", "5"]);

    expect(runTimeline).toHaveBeenCalledWith(config, { limit: 5 });
  });

  it("rejects invalid --limit values", async () => {
    for (const value of ["0", "foo"]) {
      const program = buildProgram();
      await expect(program.parseAsync(["node", "mex", "timeline", "--limit", value])).rejects.toMatchObject({
        code: "commander.invalidArgument",
        message: expect.stringContaining(`argument '${value}' is invalid`),
      });
    }
  });

  it("passes --json, --since, and --type through to the timeline handler", async () => {
    const program = buildProgram();
    await program.parseAsync([
      "node",
      "mex",
      "timeline",
      "--json",
      "--since",
      "30d",
      "--type",
      "risk",
    ]);

    expect(runTimeline).toHaveBeenCalledWith(config, {
      json: true,
      since: "30d",
      type: "risk",
    });
  });
});

describe("built CLI main-module guard", () => {
  const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
  const cliPath = join(repoRoot, "dist", "cli.js");
  const pkg = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as { version: string };

  beforeAll(() => {
    // Vitest sets NODE_ENV=test. The build must still select React's production
    // condition and must not leave a development Hub bundle in dist/.
    execSync("npm run build", {
      cwd: repoRoot,
      env: { ...process.env, NODE_ENV: "test" },
      stdio: "pipe",
      // execSync blocks Vitest's hook timer, so bound the child build itself.
      timeout: 60_000,
    });
  }, 65_000);

  it("parses argv when invoked through a symlinked bin (npm/npx layout)", () => {
    const binDir = mkdtempSync(join(tmpdir(), "mex-bin-"));
    const symlinkedCli = join(binDir, "mex");
    try {
      symlinkSync(cliPath, symlinkedCli);
      const result = spawnSync(process.execPath, [symlinkedCli, "--version"], {
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      expect(result.status).toBe(0);
      expect((result.stdout ?? "").trim()).toBe(pkg.version);
    } finally {
      rmSync(binDir, { recursive: true, force: true });
    }
  });

  it("emits the capability golden without writing project or global state", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-capability-cli-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-capability-home-"));
    const projectSentinel = join(project, "sentinel.txt");
    const homeSentinel = join(userHome, "sentinel.txt");
    writeFileSync(projectSentinel, "project-before\n");
    writeFileSync(homeSentinel, "home-before\n");
    const projectEntries = readdirSync(project);
    const homeEntries = readdirSync(userHome);
    try {
      const result = spawnSync(process.execPath, [cliPath, "capabilities", "--json"], {
        cwd: project,
        encoding: "utf8",
        env: {
          ...process.env,
          HOME: userHome,
          MEX_TELEMETRY: "1",
          NO_COLOR: "1",
        },
      });
      const golden = JSON.parse(
        readFileSync(join(repoRoot, "test/fixtures/capabilities/not-git.json"), "utf8"),
      ) as unknown;

      expect(result.status).toBe(0);
      expect(result.stdout).toBe(JSON.stringify(golden) + "\n");
      expect(result.stderr).toBe("");
      expect(readdirSync(project)).toEqual(projectEntries);
      expect(readdirSync(userHome)).toEqual(homeEntries);
      expect(readFileSync(projectSentinel, "utf8")).toBe("project-before\n");
      expect(readFileSync(homeSentinel, "utf8")).toBe("home-before\n");
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("uses the capability problem envelope for malformed JSON invocations", () => {
    const project = mkdtempSync(join(tmpdir(), "mex-capability-cli-invalid-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-capability-invalid-home-"));
    try {
      for (const args of [
        ["capabilities", "--json", "unexpected"],
        ["capabilities", "--json", "--unknown"],
      ] as const) {
        const result = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: project,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        });
        expect(result.status, args.join(" ")).toBe(2);
        expect(result.stderr, args.join(" ")).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          schemaVersion: 1,
          ok: false,
          data: null,
          diagnostics: [],
          problem: {
            title: "Invalid capability command",
            status: 400,
            code: "INVALID_REQUEST",
            detail: "Use exactly: mex capabilities --json",
          },
        });
      }
      expect(readdirSync(project)).toEqual([]);
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(project, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("does not auto-parse when dist/cli.js is imported as a module", () => {
    const result = spawnSync(
      process.execPath,
      ["-e", "import('./dist/cli.js').then(() => console.log('imported'))"],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("imported");
    expect(result.stdout).not.toContain(pkg.version);
  });

  it("backfills scaffold_id on an existing scaffold when a command loads config", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-migrate-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath, { recursive: true });
      writeFileSync(join(mexPath, "ROUTER.md"), "");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({ aiTools: ["claude"] }));

      // timeline reads config (via loadConfig) and returns [] on an empty log.
      const result = spawnSync(process.execPath, [cliPath, "timeline", "--json"], {
        cwd: fixture,
        encoding: "utf8",
        env: { ...process.env, NO_COLOR: "1" },
      });
      expect(result.status).toBe(0);

      const raw = JSON.parse(readFileSync(join(mexPath, "config.json"), "utf8")) as {
        aiTools: string[];
        scaffold_id?: string;
      };
      expect(raw.scaffold_id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(raw.aiTools).toEqual(["claude"]); // existing keys preserved
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  }, 10_000);

  it("keeps every advertised Wiki read and preview from minting scaffold identity", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-wiki-readonly-config-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-wiki-readonly-home-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(join(fixture, ".git"));
      mkdirSync(mexPath);
      const routerPath = join(mexPath, "ROUTER.md");
      const routerBytes = "# Router\n";
      writeFileSync(routerPath, routerBytes);
      const configPath = join(mexPath, "config.json");
      const configBytes = JSON.stringify({ aiTools: ["claude"], wiki: { exclude: ["private/**"] } });
      writeFileSync(configPath, configBytes);
      const operationPath = join(fixture, "operation.json");
      const operationBytes = "{}\n";
      writeFileSync(operationPath, operationBytes);
      const mexEntriesBefore = readdirSync(mexPath).sort();
      const homeEntriesBefore = readdirSync(userHome).sort();

      const invocations = [
        ["wiki", "list", "--json"],
        ["wiki", "show", "missing", "--json"],
        ["wiki", "query", "missing", "--json"],
        ["wiki", "related", "missing", "--json"],
        ["wiki", "backlinks", "missing", "--json"],
        ["wiki", "validate", "--json"],
        ["wiki", "graph", "--json"],
        ["wiki", "for-code", "missing", "--json"],
        ["wiki", "apply", operationPath, "--json"],
        ["wiki", "regenerate-views", "--dry-run", "--json"],
        ["wiki", "migrate", "--dry-run", "--json"],
      ] as const;

      for (const args of invocations) {
        const result = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: fixture,
          encoding: "utf8",
          env: {
            ...process.env,
            HOME: userHome,
            MEX_TELEMETRY: "0",
            DO_NOT_TRACK: "1",
            NO_COLOR: "1",
          },
        });
        expect(result.error, args.join(" ")).toBeUndefined();
      }

      expect(readFileSync(configPath, "utf8")).toBe(configBytes);
      expect(JSON.parse(readFileSync(configPath, "utf8"))).not.toHaveProperty("scaffold_id");
      expect(readFileSync(routerPath, "utf8")).toBe(routerBytes);
      expect(readFileSync(operationPath, "utf8")).toBe(operationBytes);
      expect(readdirSync(mexPath).sort()).toEqual(mexEntriesBefore);
      expect(readdirSync(userHome).sort()).toEqual(homeEntriesBefore);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  }, 40_000);

  it("keeps advertised grounded Spec reads available when only Team config attestation changes", async () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-spec-cli-config-drift-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-spec-cli-config-home-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(join(mexPath, "context"), { recursive: true });
      mkdirSync(join(fixture, "src"), { recursive: true });
      writeFileSync(join(fixture, ".gitignore"), ".mex/*.db*\n.mex/local/\n");
      writeFileSync(
        join(fixture, "src", "release-spec.ts"),
        "export function releaseSpecTarget(): string { return 'ready'; }\n",
      );
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      const configPath = join(mexPath, "config.json");
      writeFileSync(configPath, `${JSON.stringify({
        scaffold_id: "scaffold-spec-config-drift-001",
        scaffold_name: "Spec fixture",
      })}\n`);
      const specId = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
      writeFileSync(join(mexPath, "context", "release-spec.md"), `<!-- mex:entity
id: ${specId}
type: spec
status: promoted
revision: 1
title: Release Spec
-->
# Release Spec

Canonical read-only release requirements.
`);
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "spec-cli@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Spec CLI Contract"], { cwd: fixture });
      execFileSync("git", ["add", ".gitignore", ".mex", "src"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });

      const graph = createRepositoryGraphPort(fixture);
      await graph.rebuild();
      const symbol = (await graph.searchNodes({ query: "releaseSpecTarget", limit: 10 }))
        .items.find((item) => item.name === "releaseSpecTarget");
      if (symbol === undefined) throw new Error("Expected the Spec CLI fixture symbol.");
      const grounding = await graph.withFreshGroundingSnapshot((snapshot) => ({
        node: snapshot.getNode(symbol.ref.symbolId),
        fingerprint: snapshot.getFingerprint(symbol.ref.symbolId),
      }));
      if (grounding.node == null || grounding.fingerprint == null) {
        throw new Error("Expected exact grounding facts for the Spec CLI fixture.");
      }
      writeFileSync(join(mexPath, "context", "release-spec.md"), `<!-- mex:entity
id: ${specId}
type: spec
status: promoted
revision: 1
title: Release Spec
grounds_to:
  - node: ${JSON.stringify(symbol.ref.symbolId)}
    fingerprint: ${JSON.stringify(grounding.fingerprint)}
    bodyHash: ${JSON.stringify(grounding.node.bodyHash)}
    reason: Exact Spec CLI grounding.
-->
# Release Spec

Canonical read-only release requirements.
`);
      execFileSync("git", ["add", ".mex/context/release-spec.md"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "ground spec fixture"], { cwd: fixture });
      await graph.rebuild();

      const rebuilt = spawnSync(
        process.execPath,
        [cliPath, "wiki", "rebuild-index", "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "0", NO_COLOR: "1" },
        },
      );
      expect(rebuilt.status, rebuilt.stderr).toBe(0);
      writeFileSync(configPath, `${JSON.stringify({
        scaffold_id: "scaffold-spec-config-drift-001",
        scaffold_name: "Locally renamed Spec fixture",
      })}\n`);

      const capabilityResult = spawnSync(
        process.execPath,
        [cliPath, "capabilities", "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "0", NO_COLOR: "1" },
        },
      );
      expect(capabilityResult.status, capabilityResult.stderr).toBe(0);
      const capabilities = JSON.parse(capabilityResult.stdout) as {
        data: { capabilities: Array<{ id: string; availability: string }> };
      };
      expect(capabilities.data.capabilities.find((entry) => entry.id === "spec_read"))
        .toMatchObject({ availability: "available" });
      expect(capabilities.data.capabilities.find((entry) => entry.id === "team_workstreams"))
        .toMatchObject({ availability: "unavailable" });

      const listed = spawnSync(
        process.execPath,
        [cliPath, "spec", "list", "--grounding", "fresh", "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "0", NO_COLOR: "1" },
        },
      );
      expect(listed.status, listed.stderr).toBe(0);
      expect(JSON.parse(listed.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "spec.list",
        ok: true,
        data: {
          availability: "ready",
          page: { items: [{ id: specId, groundingHealth: "fresh" }] },
        },
      });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  }, 40_000);

  it("keeps Team reads immutable and provisions only the signed preview key", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-team-cli-process-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-team-cli-home-"));
    const requestRoot = mkdtempSync(join(tmpdir(), "mex-team-cli-request-"));
    try {
      const mexPath = join(fixture, ".mex");
      mkdirSync(mexPath);
      writeFileSync(join(mexPath, "ROUTER.md"), "# Router\n");
      writeFileSync(join(mexPath, "config.json"), JSON.stringify({
        scaffold_id: "scaffold-team-cli-process-001",
      }));
      execFileSync("git", ["init", "--quiet"], { cwd: fixture });
      execFileSync("git", ["config", "user.email", "team-cli@example.invalid"], { cwd: fixture });
      execFileSync("git", ["config", "user.name", "Team CLI Contract"], { cwd: fixture });
      execFileSync("git", ["add", ".mex/ROUTER.md", ".mex/config.json"], { cwd: fixture });
      execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: fixture });

      const projectBefore = snapshotProcessTree(fixture);
      const homeBefore = snapshotProcessTree(userHome);
      for (const args of [
        ["member", "list", "--json"],
        ["member", "current", "--json"],
        ["activity", "list", "--json"],
      ] as const) {
        const result = spawnSync(process.execPath, [cliPath, ...args], {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        });
        expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
        expect(JSON.parse(result.stdout)).toMatchObject({ schemaVersion: 1, ok: true });
      }
      expect(snapshotProcessTree(fixture)).toEqual(projectBefore);
      expect(snapshotProcessTree(userHome)).toEqual(homeBefore);

      const requestPath = join(requestRoot, "activity-record.json");
      writeFileSync(requestPath, JSON.stringify({
        operationId: "activity-record-process-001",
        action: {
          kind: "activity.record",
          activity: {
            action: "review.completed",
            subjects: [{ kind: "file", path: "src/index.ts" }],
          },
        },
        expectedRevisions: [],
      }));
      const preview = spawnSync(
        process.execPath,
        [cliPath, "activity", "record", requestPath, "--json"],
        {
          cwd: fixture,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        },
      );
      expect(preview.status, preview.stderr).toBe(0);
      expect(JSON.parse(preview.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "activity.record",
        mode: "preview",
        ok: true,
      });
      expect(readdirSync(join(mexPath, "local"))).toEqual([
        "identity-activity-signing.key",
      ]);
      expect(snapshotProcessTree(userHome)).toEqual(homeBefore);
    } finally {
      rmSync(fixture, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
      rmSync(requestRoot, { recursive: true, force: true });
    }
  }, 40_000);

  it("uses the Team JSON envelope for parser and repository-readiness failures", () => {
    const outsideRepository = mkdtempSync(join(tmpdir(), "mex-team-cli-no-repo-"));
    const userHome = mkdtempSync(join(tmpdir(), "mex-team-cli-problem-home-"));
    try {
      const cases = [
        {
          args: ["member", "show", "--json"],
          command: "member.show",
          mode: "read",
        },
        {
          args: ["member", "unknown", "--json"],
          command: "member",
          mode: "read",
        },
        {
          args: ["activity", "record", "--apply", "--json"],
          command: "activity.record",
          mode: "apply",
        },
        {
          args: ["member", "add", "--apply=preview.json", "--unknown", "--json"],
          command: "member.add",
          mode: "apply",
        },
      ] as const;

      for (const testCase of cases) {
        const result = spawnSync(process.execPath, [cliPath, ...testCase.args], {
          cwd: outsideRepository,
          encoding: "utf8",
          env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
        });
        expect(result.status, testCase.args.join(" ")).toBe(2);
        expect(result.stderr, testCase.args.join(" ")).toBe("");
        expect(JSON.parse(result.stdout)).toEqual({
          command: testCase.command,
          data: null,
          diagnostics: [],
          mode: testCase.mode,
          ok: false,
          problem: {
            code: "INVALID_REQUEST",
            detail: "The Team command arguments are invalid. Review the command help and retry.",
            status: 400,
            title: "Invalid Team command request",
          },
          schemaVersion: 1,
        });
      }

      const unavailable = spawnSync(process.execPath, [cliPath, "member", "list", "--json"], {
        cwd: outsideRepository,
        encoding: "utf8",
        env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
      });
      expect(unavailable.status).toBe(3);
      expect(unavailable.stderr).toBe("");
      expect(JSON.parse(unavailable.stdout)).toMatchObject({
        schemaVersion: 1,
        command: "member.list",
        mode: "read",
        ok: false,
        problem: { code: "NOT_FOUND" },
      });
      expect(readdirSync(outsideRepository)).toEqual([]);
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(outsideRepository, { recursive: true, force: true });
      rmSync(userHome, { recursive: true, force: true });
    }
  });

  it("rejects unsafe or oversized Team config without following or initializing it", () => {
    const userHome = mkdtempSync(join(tmpdir(), "mex-team-cli-config-home-"));
    const outside = mkdtempSync(join(tmpdir(), "mex-team-cli-config-outside-"));
    const outsideConfig = join(outside, "config.json");
    writeFileSync(outsideConfig, JSON.stringify({ scaffold_id: "outside-secret" }));
    try {
      for (const fixtureKind of ["symlink", "oversized"] as const) {
        const fixture = mkdtempSync(join(tmpdir(), `mex-team-cli-${fixtureKind}-`));
        try {
          mkdirSync(join(fixture, ".git"));
          mkdirSync(join(fixture, ".mex"));
          writeFileSync(join(fixture, ".mex", "ROUTER.md"), "# Router\n");
          const configPath = join(fixture, ".mex", "config.json");
          if (fixtureKind === "symlink") {
            symlinkSync(outsideConfig, configPath);
          } else {
            writeFileSync(configPath, JSON.stringify({
              scaffold_id: `scaffold-${"x".repeat(70 * 1024)}`,
            }));
          }
          const before = snapshotProcessTree(fixture);
          const result = spawnSync(process.execPath, [cliPath, "activity", "list", "--json"], {
            cwd: fixture,
            encoding: "utf8",
            env: { ...process.env, HOME: userHome, MEX_TELEMETRY: "1", NO_COLOR: "1" },
          });
          expect(result.status).toBe(fixtureKind === "symlink" ? 5 : 1);
          expect(result.stderr).toBe("");
          expect(JSON.parse(result.stdout)).toMatchObject({
            schemaVersion: 1,
            command: "activity.list",
            mode: "read",
            ok: false,
            problem: {
              code: fixtureKind === "symlink" ? "PATH_OUTSIDE_PROJECT" : "VALIDATION_FAILED",
            },
          });
          expect(snapshotProcessTree(fixture)).toEqual(before);
          expect(readFileSync(outsideConfig, "utf8")).toBe(
            JSON.stringify({ scaffold_id: "outside-secret" }),
          );
        } finally {
          rmSync(fixture, { recursive: true, force: true });
        }
      }
      expect(readdirSync(userHome)).toEqual([]);
    } finally {
      rmSync(userHome, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });
});

describe("mex --version", () => {
  it("reports the version from package.json (guards against hard-coded drift)", async () => {
    // cli.js is imported (and parsed with a safe argv) in beforeAll; this
    // returns the cached module, so we read the version commander was configured with.
    const { program } = await import("../src/cli.js");

    const pkgPath = join(dirname(fileURLToPath(import.meta.url)), "..", "package.json");
    const { version } = JSON.parse(readFileSync(pkgPath, "utf8")) as { version: string };

    expect(program.version()).toBe(version);
    expect(program.version()).not.toBe("0.3.5"); // the original bug (#48)
  });
});

describe("snapshotProcessTree", () => {
  it("skips an entry that disappears after listing without hiding a dangling-link error", () => {
    const fixture = mkdtempSync(join(tmpdir(), "mex-snapshot-race-"));
    try {
      const transient = join(fixture, "maintenance.lock");
      writeFileSync(transient, "locked");
      expect(readdirSync(fixture)).toContain("maintenance.lock");
      rmSync(transient);

      expect(readFileOrDirectory(transient)).toBeUndefined();

      const dangling = join(fixture, "dangling");
      symlinkSync(join(fixture, "missing-target"), dangling);
      let danglingError: unknown;
      try {
        readFileOrDirectory(dangling);
      } catch (error) {
        danglingError = error;
      }
      expect(danglingError).toMatchObject({ code: "ENOENT" });
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});

function snapshotProcessTree(root: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (directory: string, prefix: string): void => {
    let names: string[];
    try {
      names = readdirSync(directory).sort();
    } catch (error) {
      // A child directory can disappear after it was classified below. The root
      // itself must always remain readable, and no other filesystem error is safe
      // to interpret as a transient Git-maintenance race.
      if (prefix.length > 0 && isFileSystemError(error, "ENOENT")) return;
      throw error;
    }
    for (const name of names) {
      const absolute = join(directory, name);
      const relative = prefix.length === 0 ? name : `${prefix}/${name}`;
      const entry = readFileOrDirectory(absolute);
      if (entry === undefined) continue;
      result[relative] = entry.kind === "file" ? entry.bytes : "directory";
      if (entry.kind === "directory") visit(absolute, relative);
    }
  };
  visit(root, "");
  return result;
}

function readFileOrDirectory(path: string):
  | { kind: "file"; bytes: string }
  | { kind: "directory" }
  | undefined {
  let stats: ReturnType<typeof lstatSync>;
  try {
    stats = lstatSync(path);
  } catch (error) {
    // The parent directory was just listed, so ENOENT here proves that this
    // entry disappeared during the snapshot (for example Git's maintenance
    // lock). Permission, I/O, and malformed-path errors must still fail loudly.
    if (isFileSystemError(error, "ENOENT")) return undefined;
    throw error;
  }
  if (stats.isDirectory()) return { kind: "directory" };

  try {
    return { kind: "file", bytes: readFileSync(path).toString("base64") };
  } catch (error) {
    if (isFileSystemError(error, "ENOENT")) {
      try {
        lstatSync(path);
      } catch (currentError) {
        if (isFileSystemError(currentError, "ENOENT")) return undefined;
        throw currentError;
      }
    }
    throw error;
  }
}

function isFileSystemError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
