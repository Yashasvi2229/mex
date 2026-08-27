import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Command } from "commander";
import Ajv2020 from "ajv/dist/2020.js";
import {
  CAPABILITIES_MAX_BYTES,
  CAPABILITY_COMMAND_CATALOG,
  inspectCapabilities,
  runCapabilities,
  type CapabilityInspectionDependencies,
} from "../src/capabilities.js";
import {
  isFirstRunNoticeExemptCommand,
  isTelemetryExemptCommand,
  program,
} from "../src/cli.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { GRAPH_CORPUS_LIMITS } from "../src/graph/corpus-policy.js";
import { WIKI_CORPUS_LIMITS } from "../src/wiki/index/corpus-policy.js";
import { rebuildWikiIndex } from "../src/wiki/index/rebuild.js";
import {
  readTeamCommandFile,
  type TeamMutationCommandName,
} from "../src/team/cli/request-file.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("mex capabilities manifest", () => {
  it("matches the deterministic uninitialized golden without running index inspectors", async () => {
    const root = temporaryRoot();
    const inspectTeam = vi.fn<CapabilityInspectionDependencies["inspectTeam"]>();
    const inspectGraphIndex = vi.fn<CapabilityInspectionDependencies["inspectGraphIndex"]>();
    const inspectWikiIndex = vi.fn<CapabilityInspectionDependencies["inspectWikiIndex"]>();

    const envelope = await inspectCapabilities(root, { inspectTeam, inspectGraphIndex, inspectWikiIndex });

    expect(JSON.stringify(envelope, null, 2) + "\n").toBe(golden("not-git.json"));
    expect(inspectTeam).not.toHaveBeenCalled();
    expect(inspectGraphIndex).not.toHaveBeenCalled();
    expect(inspectWikiIndex).not.toHaveBeenCalled();
  });

  it("matches the ready golden and honors bounded Wiki exclude configuration", async () => {
    const root = readyRoot();
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-001",
      wiki: { exclude: ["private/**", "generated/**"] },
    }));
    execFileSync("git", ["add", ".mex/config.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "configure wiki"], { cwd: root });
    const inspectGraphIndex = vi.fn(async () => inspection("fresh"));
    const inspectWikiIndex = vi.fn(async () => inspection("fresh"));

    const first = await inspectCapabilities(root, { inspectGraphIndex, inspectWikiIndex });
    const second = await inspectCapabilities(root, { inspectGraphIndex, inspectWikiIndex });

    expect(JSON.stringify(first, null, 2) + "\n").toBe(golden("ready.json"));
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
    expect(inspectWikiIndex).toHaveBeenCalledWith(join(root, ".mex"), ["private/**", "generated/**"]);
    expect(Buffer.byteLength(JSON.stringify(first), "utf8")).toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
  });

  it("publishes a complete machine-readable Team request and exit contract", async () => {
    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    const contract = envelope.data.teamCliContract;
    const validate = new Ajv2020({ strict: true }).compile(contract.requestFile.schema);

    expect(contract).toMatchObject({
      schemaVersion: 1,
      requestFile: {
        contractId: "team.identity_activity.request.v1",
        mediaType: "application/json",
        encoding: "utf-8",
        maxBytes: 65_536,
        maxDepth: 32,
        maxNodes: 4_096,
        textPolicy: {
          normalization: "NFC",
          leadingOrTrailingWhitespace: "forbidden",
          controlCharacters: "forbidden",
        },
        utf8ByteLimits: {
          operationId: 128,
          memberDisplayName: 200,
          gitAliasName: 200,
          gitAliasEmail: 320,
          entityId: 256,
          entityKind: 64,
          entityTitle: 512,
          activityAction: 128,
          codeIdentifierOrFingerprint: 1_024,
          repositoryPath: 4_096,
        },
      },
      applyFile: {
        contractId: "team.identity_activity.preview-envelope.v1",
        maxBytes: 65_536,
      },
    });
    expect(contract.exitCodes).toEqual([
      { code: 0, name: "ok", meaning: "Success, including exact idempotent replay." },
      {
        code: 1,
        name: "validation",
        meaning: "Validation, invalid-preview, job, or internal command failure; inspect problem.code and diagnostics.",
      },
      { code: 2, name: "usage", meaning: "Arguments, request JSON, or preview-envelope input are invalid." },
      { code: 3, name: "unavailable", meaning: "Repository state or the requested resource is unavailable." },
      { code: 4, name: "conflict", meaning: "A revision, operation, or recovery conflict prevented the action." },
      { code: 5, name: "refused", meaning: "A containment, authorization, or origin safety policy refused the action." },
    ]);

    const exampleRoot = temporaryRoot();
    for (const example of contract.requestFile.examples) {
      expect(validate(example.request), `${example.command}: ${JSON.stringify(validate.errors)}`).toBe(true);
      const requestPath = join(exampleRoot, `${example.command}.json`);
      writeFileSync(requestPath, JSON.stringify(example.request));
      const parserCommand: TeamMutationCommandName = example.command === "member.clear"
        ? "member.select"
        : example.command;
      expect(readTeamCommandFile(requestPath, parserCommand)).toEqual(example.request);
      expect(example.usage).toContain("request.json --json");
    }
    expect(contract.requestFile.examples.map((entry) => entry.command)).toEqual([
      "member.add",
      "member.update",
      "member.deactivate",
      "member.select",
      "member.clear",
      "activity.record",
    ]);

    const teamPreviewIds = [
      "member.add.preview",
      "member.update.preview",
      "member.deactivate.preview",
      "member.select.preview",
      "activity.record.preview",
    ];
    const teamApplyIds = teamPreviewIds.map((id) => id.replace(/\.preview$/u, ".apply"));
    for (const descriptor of envelope.data.commands.preview.filter((entry) => teamPreviewIds.includes(entry.id))) {
      expect(descriptor.inputContract).toMatch(/^team\.identity_activity\.request\.v1#\/\$defs\//u);
    }
    for (const descriptor of envelope.data.commands.apply.filter((entry) => teamApplyIds.includes(entry.id))) {
      expect(descriptor.inputContract).toMatch(/^team\.identity_activity\.preview-envelope\.v1#/u);
    }
    expect(envelope.data.commands.preview.filter((entry) => teamPreviewIds.includes(entry.id))).toHaveLength(5);
    expect(envelope.data.commands.apply.filter((entry) => teamApplyIds.includes(entry.id))).toHaveLength(5);
    expect(Buffer.byteLength(JSON.stringify(envelope), "utf8")).toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
  });

  it("returns success with safe missing-index states and a concrete next action", async () => {
    const root = readyRoot();
    const writes: string[] = [];
    const setExitCode = vi.fn();

    const envelope = await runCapabilities({
      cwd: root,
      write: (line) => writes.push(line),
      setExitCode,
      dependencies: {
        inspectGraphIndex: async () => inspection("missing", [{
          code: "GRAPH_INDEX_MISSING",
          message: "The local code-graph index does not exist.",
          remediation: [{ command: "mex graph rebuild" }],
        }]),
        inspectWikiIndex: async () => inspection("missing"),
      },
    });

    expect(envelope).toMatchObject({
      ok: true,
      data: {
        repository: { graphIndexState: "missing", wikiIndexState: "missing" },
        nextInitializationAction: { command: "mex graph rebuild --json" },
      },
    });
    expect(setExitCode).not.toHaveBeenCalled();
    expect(writes).toEqual([JSON.stringify(envelope)]);
  });

  it("surfaces migration as preview first and never claims stale Graph reads are available", async () => {
    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("stale", [{
        code: "GRAPH_SOURCE_CORPUS_MISMATCH",
        message: "The source corpus changed.",
        remediation: [{ command: "mex graph refresh" }],
      }]),
      inspectWikiIndex: async () => inspection("migration_required"),
    });

    expect(envelope.data.nextInitializationAction).toEqual({
      command: "mex graph refresh --json",
      reason: "Refresh the stale Code Graph index.",
    });
    expect(envelope.data.commands.read.map((entry) => entry.id)).not.toContain("graph.scope");
    expect(envelope.data.commands.preview.map((entry) => entry.usage)).toContain(
      "mex wiki migrate --dry-run --json",
    );
    expect(envelope.data.commands.apply.map((entry) => entry.usage)).toContain("mex wiki migrate --json");
  });

  it("reports corpus ceilings as capability-only states without doomed maintenance commands", async () => {
    const root = readyRoot();
    const graphLimited = await inspectCapabilities(root, {
      inspectGraphIndex: async () => ({
        state: "degraded",
        diagnostics: [{
          code: "GRAPH_SOURCE_CORPUS_LIMIT_EXCEEDED",
          message: "The supported source corpus exceeds MEX's bounded inspection policy.",
          remediation: [{ command: "mex graph rebuild" }],
        }],
      }),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    expect(graphLimited.data.repository.graphIndexState).toBe("corpus_limit_exceeded");
    expect(graphLimited.data.capabilities.find((entry) => entry.id === "code_graph")?.unavailableReason?.code)
      .toBe("GRAPH_CORPUS_LIMIT_EXCEEDED");
    expect(graphLimited.data.commands.apply.map((entry) => entry.id))
      .not.toContain("graph.rebuild");
    expect(graphLimited.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Manually narrow the Code Graph corpus, then run mex capabilities --json again.",
    });

    const wikiLimited = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => ({
        state: "degraded",
        diagnostics: [{
          code: "WIKI_PARSE_ERROR",
          message: "The canonical Wiki corpus exceeds MEX's bounded inspection policy.",
        }],
      }),
    });

    expect(wikiLimited.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
    expect(wikiLimited.data.capabilities.find((entry) => entry.id === "wiki")?.unavailableReason?.code)
      .toBe("WIKI_CORPUS_LIMIT_EXCEEDED");
    expect(wikiLimited.data.commands.read.map((entry) => entry.id)).not.toContain("wiki.validate");
    expect(wikiLimited.data.commands.apply.map((entry) => entry.id))
      .not.toContain("wiki.rebuild_index");
    expect(wikiLimited.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Manually narrow wiki.exclude or the canonical Wiki corpus, then run mex capabilities --json again.",
    });
  });

  it("preserves Graph status remediation safety in advertised maintenance and next actions", async () => {
    const root = readyRoot();
    const unsafe = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("missing", [{
        code: "GRAPH_INDEX_MISSING",
        message: "The graph is missing, but build prerequisites could not be inspected.",
        remediation: [{}],
      }]),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    expect(unsafe.data.commands.apply.map((entry) => entry.id)).not.toContain("graph.rebuild");
    expect(unsafe.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Resolve the Code Graph status diagnostics, then run mex capabilities --json again.",
    });

    const safe = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("missing", [{
        code: "GRAPH_INDEX_MISSING",
        message: "The graph is missing and build prerequisites are complete.",
        remediation: [{ command: "mex graph rebuild" }],
      }]),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    expect(safe.data.commands.apply.map((entry) => entry.id)).toContain("graph.rebuild");
    expect(safe.data.nextInitializationAction?.command).toBe("mex graph rebuild --json");
  });

  it("suppresses Team commands when the tracked scaffold identity has changed", async () => {
    const root = readyRoot();
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-changed",
    }));

    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });

    for (const id of ["project_hub", "team_identity", "activity_read", "activity_record"] as const) {
      expect(envelope.data.capabilities.find((entry) => entry.id === id)).toMatchObject({
        availability: "unavailable",
        unavailableReason: { code: "TEAM_SCAFFOLD_IDENTITY_CHANGED" },
      });
    }
    expect(JSON.stringify(envelope.data.commands)).not.toMatch(/mex (?:member|activity) /u);
    expect(envelope.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Review and commit the intended .mex/config.json, then run mex capabilities --json again.",
    });
  });

  it("does not advertise Wiki rebuild for degraded, migration, corrupt, or unavailable states", async () => {
    const root = readyRoot();
    for (const state of ["degraded", "migration_required", "corrupt"] as const) {
      const envelope = await inspectCapabilities(root, {
        inspectGraphIndex: async () => inspection("fresh"),
        inspectWikiIndex: async () => inspection(state),
      });
      expect(envelope.data.commands.apply.map((entry) => entry.id), state)
        .not.toContain("wiki.rebuild_index");
    }
  });

  it("classifies an over-limit Wiki corpus before advertising a missing-index rebuild", async () => {
    const root = readyRoot();
    let deepWikiDirectory = join(root, ".mex");
    for (let depth = 0; depth <= WIKI_CORPUS_LIMITS.maxDirectoryDepth; depth += 1) {
      deepWikiDirectory = join(deepWikiDirectory, `depth-${depth}`);
    }
    mkdirSync(deepWikiDirectory, { recursive: true });
    writeFileSync(join(deepWikiDirectory, "too-deep.md"), "# Too deep\n");

    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
    });

    expect(envelope.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
    expect(envelope.data.commands.apply.map((entry) => entry.id)).not.toContain("wiki.rebuild_index");
    expect(envelope.data.nextInitializationAction).toEqual({
      command: null,
      reason: "Manually narrow wiki.exclude or the canonical Wiki corpus, then run mex capabilities --json again.",
    });

    const oversizedRoot = readyRoot();
    writeFileSync(join(oversizedRoot, ".mex", "a-canonical.md"), "---\nmex:\n  id: note:canonical\n---\n");
    writeFileSync(
      join(oversizedRoot, ".mex", "z-oversized.md"),
      "x".repeat(WIKI_CORPUS_LIMITS.maxFileBytes + 1),
    );
    const oversized = await inspectCapabilities(oversizedRoot, {
      inspectGraphIndex: async () => inspection("fresh"),
    });
    expect(oversized.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
    expect(oversized.data.commands.apply.map((entry) => entry.id)).not.toContain("wiki.rebuild_index");
  });

  it("uses the real initialized-index inspectors without writes or outbound requests", async () => {
    const root = readyRoot();
    const home = temporaryRoot();
    rmSync(join(root, ".git"), { recursive: true, force: true });
    execFileSync("git", ["init", "--quiet"], { cwd: root });
    execFileSync("git", ["config", "user.email", "capabilities@example.invalid"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Capabilities Contract"], { cwd: root });
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src", "example.ts"), "export const example = 1;\n");
    writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
      scaffold_id: "scaffold-capabilities-001",
      aiTools: ["claude"],
    }));
    execFileSync("git", ["add", "src/example.ts", ".mex/ROUTER.md", ".mex/config.json"], { cwd: root });
    execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
    const graph = createGraphEngine({ rootDir: root, dbPath: join(root, ".mex", "graph.db") });
    try {
      await graph.build();
    } finally {
      graph.close();
    }
    rebuildWikiIndex({ scaffoldRoot: join(root, ".mex") });
    const projectBefore = snapshotTree(root);
    const homeBefore = snapshotTree(home);
    const originalHome = process.env.HOME;
    process.env.HOME = home;
    const socketConnect = vi.spyOn(Socket.prototype, "connect").mockImplementation((() => {
      throw new Error("Outbound network access is forbidden during capability discovery.");
    }) as typeof Socket.prototype.connect);
    const fetchCall = vi.fn(async () => {
      throw new Error("Outbound fetch is forbidden during capability discovery.");
    });
    vi.stubGlobal("fetch", fetchCall);

    try {
      const envelope = await inspectCapabilities(root);
      expect(envelope.ok).toBe(true);
      expect(envelope.data.repository.initializationState).toBe("ready");
      expect(envelope.data.repository.graphIndexState).toBe("fresh");
      expect(envelope.data.repository.wikiIndexState).toBe("fresh");
      expect(socketConnect).not.toHaveBeenCalled();
      expect(fetchCall).not.toHaveBeenCalled();
      expect(snapshotTree(root)).toEqual(projectBefore);
      expect(snapshotTree(home)).toEqual(homeBefore);

      const oversizedSource = join(root, "src", "oversized.ts");
      writeFileSync(oversizedSource, "x".repeat(GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1));
      const graphLimited = await inspectCapabilities(root);
      expect(graphLimited.data.repository.graphIndexState).toBe("corpus_limit_exceeded");
      expect(graphLimited.data.commands.apply.map((entry) => entry.id)).not.toContain("graph.rebuild");
      rmSync(oversizedSource);

      let deepWikiDirectory = join(root, ".mex");
      for (let depth = 0; depth <= WIKI_CORPUS_LIMITS.maxDirectoryDepth; depth += 1) {
        deepWikiDirectory = join(deepWikiDirectory, `depth-${depth}`);
      }
      mkdirSync(deepWikiDirectory, { recursive: true });
      writeFileSync(join(deepWikiDirectory, "too-deep.md"), "# Too deep\n");
      const wikiLimited = await inspectCapabilities(root);
      expect(wikiLimited.data.repository.wikiIndexState).toBe("corpus_limit_exceeded");
      expect(wikiLimited.data.commands.apply.map((entry) => entry.id)).not.toContain("wiki.rebuild_index");
    } finally {
      if (originalHome === undefined) delete process.env.HOME;
      else process.env.HOME = originalHome;
    }
  }, 30_000);

  it("uses a bounded safe problem and exit 2 when inspection unexpectedly fails", async () => {
    const root = readyRoot();
    const writes: string[] = [];
    const setExitCode = vi.fn();
    const secret = join(root, "private-source-path");

    const envelope = await runCapabilities({
      cwd: root,
      write: (line) => writes.push(line),
      setExitCode,
      dependencies: {
        inspectGraphIndex: async () => { throw new Error(`failed at ${secret}`); },
        inspectWikiIndex: async () => inspection("fresh"),
      },
    });

    expect(envelope).toEqual({
      schemaVersion: 1,
      ok: false,
      data: null,
      diagnostics: [],
      problem: {
        title: "Capability discovery failed",
        status: 500,
        code: "INTERNAL_ERROR",
        detail: "MEX could not inspect repository capabilities safely.",
      },
    });
    expect(setExitCode).toHaveBeenCalledOnce();
    expect(setExitCode).toHaveBeenCalledWith(2);
    expect(writes).toEqual([JSON.stringify(envelope)]);
    expect(writes[0]).not.toContain(secret);
    expect(Buffer.byteLength(writes[0]!, "utf8")).toBeLessThanOrEqual(CAPABILITIES_MAX_BYTES);
  });

  it("advertises only registered current-product command paths", async () => {
    const registered = registeredCommandPaths(program);
    expect(CAPABILITY_COMMAND_CATALOG.map((entry) => entry.id))
      .not.toEqual(expect.arrayContaining(["wiki.build", "wiki.prepare", "wiki.propose.preview", "wiki.propose.apply"]));
    for (const descriptor of CAPABILITY_COMMAND_CATALOG) {
      expect(registered, descriptor.path).toContain(descriptor.path);
      expect(descriptor.usage.startsWith(descriptor.path), descriptor.usage).toBe(true);
      const registeredCommand = commandAtPath(program, descriptor.path);
      for (const option of descriptor.usage.match(/--[a-z-]+/g) ?? []) {
        expect(
          registeredCommand?.options.some((candidate) => candidate.long === option),
          `${descriptor.usage} advertises unregistered option ${option}`,
        ).toBe(true);
      }
    }

    const root = readyRoot();
    const envelope = await inspectCapabilities(root, {
      inspectGraphIndex: async () => inspection("fresh"),
      inspectWikiIndex: async () => inspection("fresh"),
    });
    expect(envelope.data.capabilities.map((entry) => entry.id)).toEqual([
      "project_hub",
      "team_identity",
      "activity_read",
      "activity_record",
      "code_graph",
      "wiki",
    ]);
    const serializedCommands = JSON.stringify(envelope.data.commands);
    expect(serializedCommands).not.toMatch(/workstream|inbox|relay|playbook|catch[-_ ]?up/i);
    expect(serializedCommands).not.toMatch(/activity\.(?:create|update|delete)/i);
    expect(serializedCommands).not.toMatch(/wiki\.(?:build|prepare|propose)/i);
  });

  it("registers only --json and exempts discovery from telemetry and first-run writes", () => {
    const capabilities = program.commands.find((candidate) => candidate.name() === "capabilities");
    expect(capabilities?.options.map((option) => option.long)).toEqual(["--json"]);
    expect(isTelemetryExemptCommand("capabilities", "mex")).toBe(true);
    expect(isTelemetryExemptCommand("list", "member")).toBe(true);
    expect(isTelemetryExemptCommand("record", "activity")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("capabilities")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("member")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("activity")).toBe(true);
    expect(isFirstRunNoticeExemptCommand("check")).toBe(false);
  });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-capabilities-"));
  roots.push(root);
  return root;
}

function readyRoot(): string {
  const root = temporaryRoot();
  mkdirSync(join(root, ".mex"));
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(join(root, ".mex", "config.json"), JSON.stringify({
    scaffold_id: "scaffold-capabilities-001",
  }));
  execFileSync("git", ["init", "--quiet"], { cwd: root });
  execFileSync("git", ["config", "user.email", "capabilities@example.invalid"], { cwd: root });
  execFileSync("git", ["config", "user.name", "Capabilities Contract"], { cwd: root });
  execFileSync("git", ["add", ".mex/ROUTER.md", ".mex/config.json"], { cwd: root });
  execFileSync("git", ["commit", "--quiet", "-m", "fixture"], { cwd: root });
  return root;
}

function golden(name: string): string {
  return readFileSync(join("test", "fixtures", "capabilities", name), "utf8");
}

function inspection<State extends string>(
  state: State,
  diagnostics: Array<{
    code: string;
    message: string;
    remediation?: readonly { command?: string }[];
  }> = [],
): { state: State; diagnostics: typeof diagnostics } {
  return { state, diagnostics };
}

function snapshotTree(root: string): Record<string, string> {
  const snapshot: Record<string, string> = {};
  const visit = (absolute: string, prefix: string): void => {
    for (const name of readdirSync(absolute).sort()) {
      const path = join(absolute, name);
      const relative = prefix === "" ? name : `${prefix}/${name}`;
      const stats = lstatSync(path, { bigint: true });
      const identity = `${stats.mode}:${stats.size}:${stats.mtimeNs}:${stats.ctimeNs}`;
      if (stats.isDirectory()) {
        snapshot[relative] = `directory:${identity}`;
        visit(path, relative);
      } else if (stats.isSymbolicLink()) {
        snapshot[relative] = `symlink:${identity}:${readlinkSync(path)}`;
      } else {
        const digest = createHash("sha256").update(readFileSync(path)).digest("hex");
        snapshot[relative] = `file:${identity}:${digest}`;
      }
    }
  };
  visit(root, "");
  return snapshot;
}

function registeredCommandPaths(root: Command): string[] {
  const paths: string[] = [];
  const visit = (parent: Command, prefix: readonly string[]): void => {
    for (const child of parent.commands) {
      const current = [...prefix, child.name()];
      paths.push(current.join(" "));
      visit(child, current);
    }
  };
  visit(root, [root.name()]);
  return paths;
}

function commandAtPath(root: Command, path: string): Command | undefined {
  const names = path.split(" ");
  if (names.shift() !== root.name()) return undefined;
  let current = root;
  for (const name of names) {
    const child = current.commands.find((candidate) => candidate.name() === name);
    if (!child) return undefined;
    current = child;
  }
  return current;
}
