import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { assertNoForbiddenWorkbench, evaluateAssetBudgets } from "./assets.mjs";
import {
  releaseWorkbenchPaths,
  RELEASE_ROUTE_KEYS,
  RELEASE_ROUTE_PATTERNS,
} from "./routes.mjs";
import { createBenchmarkEnvironment } from "./environment.mjs";
import {
  fixtureInputSizes,
  initializeReleaseFixtureGit,
  RELEASE_FIXTURE_PROFILES,
} from "./fixtures.mjs";
import { startHub } from "./hub.mjs";
import { enforceWithConfirmation } from "./enforce.mjs";
import { candidateRuntimeBudgets, evaluateRuntimeBudgets } from "./runtime-budgets.mjs";
import {
  classifyRuntimeViolations,
  evaluateRuntimeConfirmation,
} from "./runtime-confirmation.mjs";
import { assetBudgetCandidate, runtimeBudgetCandidate, summarize } from "./statistics.mjs";

const budgets = JSON.parse(readFileSync(new URL("./budgets.json", import.meta.url), "utf8"));
const packageJson = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const reportSchema = JSON.parse(readFileSync(new URL("./report.schema.json", import.meta.url), "utf8"));

describe("release benchmark contract", () => {
  it("locks the sample counts and deterministic route budget surface", () => {
    expect(budgets.schemaVersion).toBe(1);
    expect(budgets.samples).toEqual({ timing: 10, idleMemory: 5 });
    expect(RELEASE_FIXTURE_PROFILES).toEqual({
      small: { sourceFiles: 4, wikiEntities: 4, activityEvents: 4 },
      medium: { sourceFiles: 16, wikiEntities: 16, activityEvents: 16 },
      large: { sourceFiles: 48, wikiEntities: 48, activityEvents: 48 },
    });
    expect(Object.keys(budgets.assets.routes)).toEqual(RELEASE_ROUTE_KEYS);
    expect(Object.keys(releaseWorkbenchPaths({
      knowledgeEntityId: "mx_knowledge",
      codeSymbolId: "symbol/release",
    }))).toEqual(RELEASE_ROUTE_KEYS);
    const appRoutes = readFileSync(
      new URL("../../packages/hub-web/src/app/App.tsx", import.meta.url),
      "utf8",
    );
    const registeredPatterns = [...appRoutes.matchAll(/<Route\s+(index|path="([^"]+)")\s+element=/gu)]
      .map((match) => match[1] === "index" ? "(index)" : match[2]);
    expect(registeredPatterns).toEqual(Object.values(RELEASE_ROUTE_PATTERNS));
    for (const profile of ["small", "medium", "large"]) {
      expect(Object.keys(budgets.runtime.browserHeapBytes[profile])).toEqual(RELEASE_ROUTE_KEYS);
    }
    expect(budgets.assets.routes.code).toEqual(budgets.assets.routes.search);
    expect(budgets.provisional).toBe(false);
    expect(budgets.calibration).toEqual({
      status: "calibrated-from-pinned-run-33005876613",
      runtimeFormula: "ceil(measured p95 * 1.15)",
      assetFormula: "ceil(built bytes * 1.05)",
    });
    expect(packageJson.scripts["benchmark:release"]).toContain(
      "scripts/release-benchmark/enforce.mjs",
    );
    expect(reportSchema.$defs.runtimeConfirmation.properties.status.enum).toEqual([
      "not_required",
      "skipped_immediate_failure",
      "passed",
      "failed",
      "operational_failure",
    ]);
  });

  it("uses nearest-rank p95 and rejects the wrong sample count", () => {
    expect(summarize([7, 1, 9, 4, 2, 10, 8, 6, 5, 3], 10)).toEqual({
      samples: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
      min: 1,
      median: 5.5,
      p95: 10,
      max: 10,
    });
    expect(() => summarize([1, 2, 3, 4], 5)).toThrow(/exactly 5 samples/u);
    expect(runtimeBudgetCandidate(100.01)).toBe(116);
    expect(assetBudgetCandidate(100.01)).toBe(106);
  });

  it("fails deterministic asset bytes above the committed golden", () => {
    const measurement = {
      largestJsChunk: { file: "assets/index.js", bytes: budgets.assets.maxJsChunkBytes },
      initial: { ...budgets.assets.initial, files: [] },
      routes: Object.fromEntries(Object.entries(budgets.assets.routes).map(([route, value]) => [
        route,
        { ...value, files: [] },
      ])),
    };
    expect(evaluateAssetBudgets(measurement, budgets.assets)).toEqual([]);
    measurement.routes.home.jsBytes += 1;
    expect(evaluateAssetBudgets(measurement, budgets.assets)).toEqual([{
      metric: "assets.routes.home.jsBytes",
      measured: budgets.assets.routes.home.jsBytes + 1,
      budget: budgets.assets.routes.home.jsBytes,
      reason: "budget_exceeded",
    }]);
  });

  it("rejects forbidden workbench modules hidden behind opaque chunk keys", () => {
    const manifest = {
      "_opaque.js": {
        file: "assets/opaque.js",
        src: "src/pages/ActivityPage.tsx",
      },
    };
    expect(() => assertNoForbiddenWorkbench(
      manifest,
      new Set(["_opaque.js"]),
      "Home workbench",
      ["ActivityPage"],
    )).toThrow(/Home workbench still includes ActivityPage/u);
  });

  it("keeps runtime candidates and enforcement scoped to each fixture profile", () => {
    const profiles = {
      small: runtimeProfile(100),
      medium: runtimeProfile(200),
      large: runtimeProfile(300),
    };
    const candidates = candidateRuntimeBudgets(profiles);
    expect(candidates.apiLatencyMs).toEqual({
      small: { search: 115 },
      medium: { search: 230 },
      large: { search: 345 },
    });
    expect(candidates.databaseToInputRatio).toEqual({
      small: { graph: 115, wiki: 115 },
      medium: { graph: 230, wiki: 230 },
      large: { graph: 345, wiki: 345 },
    });
    expect(evaluateRuntimeBudgets(profiles, candidates)).toEqual([]);
    candidates.apiLatencyMs.small.search = 99;
    expect(evaluateRuntimeBudgets(profiles, candidates)).toContainEqual({
      metric: "runtime.apiLatencyMs.small.search",
      measured: 100,
      budget: 99,
      reason: "budget_exceeded",
    });
  });

  it("retries only noisy runtime metrics and requires the same metric twice", () => {
    const knowledge = runtimeViolation("runtime.apiLatencyMs.medium.knowledge");
    const activity = runtimeViolation("runtime.apiLatencyMs.medium.activity");
    const initial = evaluateRuntimeConfirmation([knowledge]);
    expect(initial).toMatchObject({ retryRequired: true, status: "required" });

    expect(evaluateRuntimeConfirmation([knowledge], [activity])).toMatchObject({
      retryRequired: false,
      status: "passed",
      finalViolations: [],
    });
    expect(evaluateRuntimeConfirmation([knowledge], [knowledge])).toMatchObject({
      retryRequired: false,
      status: "failed",
      finalViolations: [knowledge],
      confirmed: [knowledge],
    });
  });

  it("keeps database ratios, outbound requests, and unknown metrics immediate", () => {
    const noisy = [
      "runtime.coldHubReadyMs.small",
      "runtime.idleRssBytes.small",
      "runtime.idleCpuMs.small",
      "runtime.apiLatencyMs.small.search",
      "runtime.maintenanceMs.small.graph_refresh",
      "runtime.maintenancePeakRssBytes.small.graph_refresh",
      "runtime.browserHeapBytes.small.home",
    ].map(runtimeViolation);
    const database = runtimeViolation("runtime.databaseToInputRatio.small.graph");
    const outbound = runtimeViolation("runtime.outboundRequestCount.small");
    const unknown = runtimeViolation("runtime.apiLatencyMs.unknown.future");
    expect(classifyRuntimeViolations([...noisy, database, outbound, unknown])).toEqual({
      confirmable: noisy,
      immediate: [database, outbound, unknown],
    });
    expect(evaluateRuntimeConfirmation([noisy[0], database])).toMatchObject({
      retryRequired: false,
      status: "skipped_immediate_failure",
      finalViolations: [database],
    });
  });

  it("does not retry a clean first pass and emits a consistent final report", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-clean-"));
    try {
      const result = runConfirmationHarness(root, [benchmarkPass()]);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(1);
      expect(result.report.budgetEvaluation).toMatchObject({
        assetViolations: [],
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "not_required",
          repositoryHead: "a".repeat(40),
          firstPassViolations: [],
          secondPassViolations: [],
          confirmedViolations: [],
        },
      });
      expect(existsSync(join(root, "report.attempt-1.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("passes different noisy metrics across attempts and retains both raw reports", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-different-"));
    const knowledge = runtimeViolation("runtime.apiLatencyMs.medium.knowledge");
    const activity = runtimeViolation("runtime.apiLatencyMs.medium.activity");
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [knowledge] }),
        benchmarkPass({ runtimeViolations: [activity] }),
      ]);
      expect(result.exitCode).toBe(0);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toEqual({
        assetViolations: [],
        runtimeViolations: [],
        passed: true,
        runtimeConfirmation: {
          status: "passed",
          repositoryHead: "a".repeat(40),
          firstPassViolations: [knowledge],
          secondPassViolations: [activity],
          confirmedViolations: [],
        },
      });
      expect(readRawAttempt(root, 1).budgetEvaluation.runtimeViolations).toEqual([knowledge]);
      expect(readRawAttempt(root, 2).budgetEvaluation.runtimeViolations).toEqual([activity]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails when the same noisy metric breaches twice", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-same-"));
    const knowledge = runtimeViolation("runtime.apiLatencyMs.medium.knowledge");
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [knowledge] }),
        benchmarkPass({ runtimeViolations: [knowledge] }),
      ]);
      expect(result.exitCode).toBe(1);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [knowledge],
        passed: false,
        runtimeConfirmation: {
          status: "failed",
          firstPassViolations: [knowledge],
          secondPassViolations: [knowledge],
          confirmedViolations: [knowledge],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("fails hard violations on either attempt without treating them as noise", () => {
    const graphRatio = runtimeViolation("runtime.databaseToInputRatio.small.graph");
    const knowledge = runtimeViolation("runtime.apiLatencyMs.medium.knowledge");
    const asset = runtimeViolation("assets.routes.home.jsBytes");
    for (const scenario of [
      {
        name: "first-runtime",
        passes: [benchmarkPass({ runtimeViolations: [graphRatio] })],
        calls: 1,
        finalRuntime: [graphRatio],
      },
      {
        name: "first-asset",
        passes: [benchmarkPass({ assetViolations: [asset] })],
        calls: 1,
        finalRuntime: [],
      },
      {
        name: "second-runtime",
        passes: [
          benchmarkPass({ runtimeViolations: [knowledge] }),
          benchmarkPass({ runtimeViolations: [graphRatio] }),
        ],
        calls: 2,
        finalRuntime: [graphRatio],
      },
    ]) {
      const root = mkdtempSync(join(tmpdir(), `mex-release-confirm-${scenario.name}-`));
      try {
        const result = runConfirmationHarness(root, scenario.passes);
        expect(result.exitCode).toBe(1);
        expect(result.calls).toBe(scenario.calls);
        expect(result.report.budgetEvaluation.passed).toBe(false);
        expect(result.report.budgetEvaluation.runtimeViolations).toEqual(scenario.finalRuntime);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("uses exit 2 for unusable child reports", () => {
    for (const pass of [null, "invalid", "oversized", "signaled", "inconsistent"]) {
      const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-invalid-first-"));
      try {
        const result = runConfirmationHarness(root, [pass]);
        expect(result.exitCode).toBe(2);
        expect(result.calls).toBe(1);
        expect(result.report).toBeUndefined();
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }

    const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-missing-second-"));
    const knowledge = runtimeViolation("runtime.apiLatencyMs.medium.knowledge");
    try {
      const result = runConfirmationHarness(root, [
        benchmarkPass({ runtimeViolations: [knowledge] }),
        null,
      ]);
      expect(result.exitCode).toBe(2);
      expect(result.calls).toBe(2);
      expect(result.report.budgetEvaluation).toMatchObject({
        runtimeViolations: [knowledge],
        passed: false,
        runtimeConfirmation: {
          status: "operational_failure",
          firstPassViolations: [knowledge],
          secondPassViolations: [],
          confirmedViolations: [],
        },
      });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses exit 2 if repository HEAD changes between or during attempts", () => {
    const knowledge = runtimeViolation("runtime.apiLatencyMs.medium.knowledge");
    for (const heads of [
      ["a".repeat(40), "b".repeat(40)],
      ["a".repeat(40), "a".repeat(40), "b".repeat(40)],
    ]) {
      const root = mkdtempSync(join(tmpdir(), "mex-release-confirm-head-change-"));
      try {
        const result = runConfirmationHarness(root, [
          benchmarkPass({ runtimeViolations: [knowledge] }),
          benchmarkPass(),
        ], { heads });
        expect(result.exitCode).toBe(2);
        expect(result.report.budgetEvaluation).toMatchObject({
          passed: false,
          runtimeConfirmation: { status: "operational_failure" },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  });

  it("counts Graph configuration files in the indexed-input denominator", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-input-size-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".mex", "context"), { recursive: true });
      mkdirSync(join(root, ".mex", "events"), { recursive: true });
      writeFileSync(join(root, "src", "index.ts"), "export const input = 1;\n");
      writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
      writeFileSync(join(root, "tsconfig.json"), "{\"compilerOptions\":{}}\n");
      writeFileSync(join(root, ".mex", "context", "knowledge.md"), "# Knowledge\n");
      writeFileSync(join(root, ".mex", "events", "ignored.md"), "# Event\n");
      const measured = fixtureInputSizes(root);
      expect(measured.graphFiles).toBe(3);
      expect(measured.graphBytes).toBe(
        Buffer.byteLength("export const input = 1;\n")
        + Buffer.byteLength("{\"private\":true}\n")
        + Buffer.byteLength("{\"compilerOptions\":{}}\n"),
      );
      expect(measured.wikiFiles).toBe(1);
      expect(measured.wikiBytes).toBe(Buffer.byteLength("# Knowledge\n"));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("makes fixture Git identity deterministic despite inherited overrides and hooks", () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-git-identity-"));
    try {
      const cleanRoot = join(root, "clean");
      const contaminatedRoot = join(root, "contaminated");
      const cleanEnvironmentRoot = join(root, "clean-environment");
      const contaminatedEnvironmentRoot = join(root, "contaminated-environment");
      const hookRoot = join(root, "hostile-hooks");
      const templateRoot = join(root, "hostile-template");
      const hookMarker = join(root, "hook-executed");
      for (const directory of [
        cleanEnvironmentRoot,
        contaminatedEnvironmentRoot,
        hookRoot,
        join(templateRoot, "hooks"),
      ]) mkdirSync(directory, { recursive: true });
      const hostileHook = [
        "#!/bin/sh",
        'printf executed > "$MEX_HOOK_MARKER"',
        "exit 91",
        "",
      ].join("\n");
      writeFileSync(join(hookRoot, "pre-commit"), hostileHook);
      writeFileSync(join(templateRoot, "hooks", "pre-commit"), hostileHook);
      chmodSync(join(hookRoot, "pre-commit"), 0o755);
      chmodSync(join(templateRoot, "hooks", "pre-commit"), 0o755);

      const cleanEnvironment = createBenchmarkEnvironment(cleanEnvironmentRoot, process.env);
      const contaminatedEnvironment = createBenchmarkEnvironment(contaminatedEnvironmentRoot, {
        ...process.env,
        GIT_AUTHOR_EMAIL: "attacker@example.invalid",
        GIT_AUTHOR_NAME: "Attacker",
        GIT_COMMITTER_EMAIL: "attacker@example.invalid",
        GIT_COMMITTER_NAME: "Attacker",
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: "core.hooksPath",
        GIT_CONFIG_VALUE_0: hookRoot,
        GIT_DEFAULT_HASH: "sha256",
        GIT_TEMPLATE_DIR: templateRoot,
        MEX_HOOK_MARKER: hookMarker,
      });
      writeMinimalReleaseFixture(cleanRoot);
      writeMinimalReleaseFixture(contaminatedRoot);
      const cleanHead = initializeReleaseFixtureGit(cleanRoot, cleanEnvironment);
      const contaminatedHead = initializeReleaseFixtureGit(contaminatedRoot, contaminatedEnvironment);

      expect(contaminatedHead).toBe(cleanHead);
      expect(contaminatedHead).toMatch(/^[0-9a-f]{40}$/u);
      expect(existsSync(hookMarker)).toBe(false);
      expect(gitCommitIdentity(contaminatedRoot, contaminatedEnvironment)).toEqual([
        "MEX Release Benchmark",
        "release-benchmark@example.invalid",
        "MEX Release Benchmark",
        "release-benchmark@example.invalid",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("terminates a Hub child that misses the readiness deadline", async () => {
    const root = mkdtempSync(join(tmpdir(), "mex-release-startup-timeout-"));
    const script = join(root, "hanging-hub.mjs");
    const terminated = join(root, "terminated");
    try {
      writeFileSync(script, [
        'import { writeFileSync } from "node:fs";',
        'process.on("SIGTERM", () => { writeFileSync(process.env.MEX_TERMINATION_FILE, "yes"); process.exit(0); });',
        "setInterval(() => undefined, 1_000);",
        "",
      ].join("\n"));
      await expect(startHub({
        projectRoot: root,
        cliPath: script,
        environment: { ...process.env, MEX_TERMINATION_FILE: terminated },
        startupTimeoutMs: 1_000,
      })).rejects.toThrow(/Timed out waiting for Hub readiness/u);
      expect(existsSync(terminated)).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

function runtimeProfile(value) {
  return {
    coldHubReadyMs: { p95: value },
    idle: { rssBytes: { p95: value }, cpuMs: { p95: value } },
    apiLatencyMs: { search: { p95: value } },
    maintenance: {
      graph_refresh: {
        elapsedMs: { p95: value },
        peakRssBytes: { p95: value },
      },
    },
    browserHeap: {
      outboundRequestCount: 0,
      routes: { home: { p95: value } },
    },
    database: {
      graph: { ratio: value },
      wiki: { ratio: value },
    },
  };
}

function runtimeViolation(metric) {
  return { metric, measured: 101, budget: 100, reason: "budget_exceeded" };
}

function benchmarkPass({ assetViolations = [], runtimeViolations = [] } = {}) {
  return {
    schemaVersion: 1,
    budgetEvaluation: {
      assetViolations,
      runtimeViolations,
      passed: assetViolations.length === 0 && runtimeViolations.length === 0,
    },
  };
}

function runConfirmationHarness(root, passes, options = {}) {
  let calls = 0;
  let headReads = 0;
  const output = join(root, "report.json");
  const exitCode = enforceWithConfirmation(output, {
    executePass(path) {
      const pass = passes[calls];
      calls += 1;
      if (pass === null) return { status: 1, signal: null };
      if (pass === "invalid") {
        writeFileSync(path, "not-json\n");
        return { status: 1, signal: null };
      }
      if (pass === "oversized") {
        writeFileSync(path, "x".repeat((2 * 1024 * 1024) + 1));
        return { status: 1, signal: null };
      }
      if (pass === "signaled") return { status: null, signal: "SIGTERM" };
      if (pass === "inconsistent") {
        writeFileSync(path, `${JSON.stringify(benchmarkPass())}\n`);
        return { status: 1, signal: null };
      }
      writeFileSync(path, `${JSON.stringify(pass)}\n`);
      return { status: pass.budgetEvaluation.passed ? 0 : 1, signal: null };
    },
    resolveRepositoryHead() {
      const heads = options.heads ?? ["a".repeat(40)];
      const head = heads[Math.min(headReads, heads.length - 1)];
      headReads += 1;
      return head;
    },
    emitReport: () => undefined,
  });
  return {
    calls,
    exitCode,
    report: existsSync(output) ? JSON.parse(readFileSync(output, "utf8")) : undefined,
  };
}

function readRawAttempt(root, attempt) {
  return JSON.parse(readFileSync(join(root, `report.attempt-${attempt}.json`), "utf8"));
}

function writeMinimalReleaseFixture(root) {
  mkdirSync(join(root, ".mex"), { recursive: true });
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, ".gitignore"), ".mex/graph.db*\n");
  writeFileSync(join(root, "package.json"), "{\"private\":true}\n");
  writeFileSync(join(root, "tsconfig.json"), "{\"compilerOptions\":{}}\n");
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Fixture\n");
  writeFileSync(join(root, "src", "index.ts"), "export const fixture = true;\n");
}

function gitCommitIdentity(root, environment) {
  const result = spawnSync(
    "git",
    ["show", "-s", "--format=%an%n%ae%n%cn%n%ce", "HEAD"],
    { cwd: root, encoding: "utf8", env: environment },
  );
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim().split("\n");
}
