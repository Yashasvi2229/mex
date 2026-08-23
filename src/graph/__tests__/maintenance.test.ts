import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { GraphMaintenanceOptions } from "../../team/contracts/graph.js";
import { openSqlite } from "../db/sqlite.js";
import { createGraphEngine } from "../engine-impl.js";
import {
  acquireGraphMaintenanceLease,
  GraphMaintenanceError,
  rebuildGraph,
  refreshGraph,
} from "../maintenance.js";
import { inspectGraphStatus } from "../status.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(prefix = "mex-graph-maintenance-"): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function source(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, ".."), { recursive: true });
  writeFileSync(absolute, contents);
}

async function buildBaseline(root: string): Promise<string> {
  const engine = createGraphEngine({ rootDir: root });
  try {
    await engine.build();
  } finally {
    engine.close();
  }
  return join(root, ".mex", "graph.db");
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function ownedArtifacts(root: string): string[] {
  const mexDir = join(root, ".mex");
  return readdirSync(mexDir)
    .filter((name) => name.startsWith("graph.db.candidate-")
      || name.startsWith("graph.db.rollback-")
      || name === "graph.db.lock"
      || name === "graph.db.lock.gate")
    .sort();
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  }).trim();
}

describe("graph maintenance", () => {
  it("rebuilds a missing graph through a validated candidate without leftovers", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = true;\n");
    const phases: string[] = [];

    const result = await rebuildGraph(root, {
      onProgress: (progress) => phases.push(progress.phase),
    });

    expect(result.status.status).toBe("fresh");
    expect(result.filesIndexed).toBe(1);
    expect(phases).toEqual(["discover", "stage", "validate", "publish"]);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("restores a missing index when first publication fails post-validation", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = true;\n");
    const dbPath = join(root, ".mex", "graph.db");
    const options = {
      __internal: {
        afterPublish(livePath: string) {
          writeFileSync(livePath, "corrupt after first atomic publication");
        },
      },
    } as GraphMaintenanceOptions;

    await expect(rebuildGraph(root, options)).rejects.toBeInstanceOf(GraphMaintenanceError);

    expect(() => readFileSync(dbPath)).toThrow();
    expect((await inspectGraphStatus({ projectRoot: root })).status).toBe("missing");
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("refreshes edited source through sync and republishes branch provenance", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    git(root, "init", "-q", "-b", "main");
    git(root, "config", "user.name", "Maintenance Test");
    git(root, "config", "user.email", "maintenance@example.invalid");
    source(root, ".gitignore", ".mex/graph.db*\n");
    git(root, "add", ".");
    git(root, "commit", "-qm", "fixture");
    await buildBaseline(root);
    git(root, "switch", "-qc", "feature/refresh");
    source(root, "src/service.ts", "export const service = 2;\n");

    const result = await refreshGraph(root);

    expect(result.status.status).toBe("fresh");
    expect(result.status.indexedBranch).toBe("feature/refresh");
    expect(result.status.changes.total).toBe(0);
    expect(ownedArtifacts(root)).toEqual([]);
  }, 15_000);

  it("rejects a candidate replaced after validation and leaves live bytes exact", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    source(root, "src/service.ts", "export const service = 2;\n");
    const before = sha256(dbPath);
    const options = {
      __internal: {
        afterCandidateValidated(candidatePath: string) {
          writeFileSync(candidatePath, "replacement candidate");
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_RACE",
    });

    expect(sha256(dbPath)).toBe(before);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("does not overwrite a live graph changed at the final revalidation boundary", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    source(root, "src/service.ts", "export const service = 2;\n");
    const externalBytes = Buffer.from("externally replaced graph bytes\n");
    const options = {
      __internal: {
        beforeLiveRevalidation() {
          writeFileSync(dbPath, externalBytes);
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_RACE",
    });

    expect(readFileSync(dbPath)).toEqual(externalBytes);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("aborts on a nonempty candidate WAL instead of unlinking it into publication", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    source(root, "src/service.ts", "export const service = 2;\n");
    const before = sha256(dbPath);
    const options = {
      __internal: {
        afterCandidateValidated(candidatePath: string) {
          writeFileSync(`${candidatePath}-wal`, "authoritative candidate WAL bytes");
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_LOCKED",
    });

    expect(sha256(dbPath)).toBe(before);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("preserves the prior snapshot after a failed parse or cancellation", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export function service(): number { return 1; }\n");
    const dbPath = await buildBaseline(root);
    const before = sha256(dbPath);
    source(root, "src/service.ts", "}\n");

    await expect(refreshGraph(root)).rejects.toMatchObject({ name: "GraphSourceStagingError" });
    expect(sha256(dbPath)).toBe(before);

    source(root, "src/service.ts", "export function service(): number { return 2; }\n");
    const controller = new AbortController();
    controller.abort();
    await expect(refreshGraph(root, { signal: controller.signal })).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_CANCELLED",
    });
    expect(sha256(dbPath)).toBe(before);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("rolls back exact live bytes when post-publication validation fails", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    const before = sha256(dbPath);
    source(root, "src/service.ts", "export const service = 2;\n");
    const options = {
      __internal: {
        afterPublish(livePath: string) {
          writeFileSync(livePath, "corrupt after atomic publication");
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toBeInstanceOf(GraphMaintenanceError);

    expect(sha256(dbPath)).toBe(before);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("retains the only exact prior copy when automatic rollback itself fails", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    const priorBytes = readFileSync(dbPath);
    source(root, "src/service.ts", "export const service = 2;\n");
    const options = {
      __internal: {
        afterPublish(livePath: string) {
          writeFileSync(livePath, "failed published candidate");
        },
        beforeRollbackRestore() {
          throw new Error("injected rollback rename failure");
        },
      },
    } as GraphMaintenanceOptions;

    let failure: GraphMaintenanceError | null = null;
    try {
      await refreshGraph(root, options);
    } catch (error) {
      failure = error as GraphMaintenanceError;
    }

    expect(failure).toMatchObject({
      code: "GRAPH_PUBLICATION_FAILED",
      recoveryPath: expect.stringMatching(/^\.mex\/graph\.db\.recovery-/u),
    });
    expect(readFileSync(join(root, failure!.recoveryPath!))).toEqual(priorBytes);
    expect(failure!.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_RECOVERY_RETAINED",
      path: failure!.recoveryPath,
    }));
  });

  it("does not overwrite a replacement live database while attempting rollback", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    const priorBytes = readFileSync(dbPath);
    const replacementBytes = Buffer.from("independent replacement live graph\n");
    source(root, "src/service.ts", "export const service = 2;\n");
    const options = {
      __internal: {
        afterPublish(livePath: string) {
          const replacementPath = join(root, ".mex", "independent-replacement.tmp");
          writeFileSync(replacementPath, replacementBytes);
          renameSync(replacementPath, livePath);
        },
      },
    } as GraphMaintenanceOptions;

    let failure: GraphMaintenanceError | null = null;
    try {
      await refreshGraph(root, options);
    } catch (error) {
      failure = error as GraphMaintenanceError;
    }

    expect(failure).toMatchObject({
      code: "GRAPH_PUBLICATION_FAILED",
      recoveryPath: expect.stringMatching(/^\.mex\/graph\.db\.recovery-/u),
    });
    expect(readFileSync(dbPath)).toEqual(replacementBytes);
    expect(readFileSync(join(root, failure!.recoveryPath!))).toEqual(priorBytes);
  });

  it("fails closed when a callback retargets the bound .mex directory", async () => {
    const root = temporaryRoot();
    const external = temporaryRoot("mex-graph-maintenance-external-");
    source(root, "src/service.ts", "export const service = 1;\n");
    const dbPath = await buildBaseline(root);
    const priorBytes = readFileSync(dbPath);
    source(root, "src/service.ts", "export const service = 2;\n");
    const displacedMex = join(root, ".mex-bound-original");
    const externalSentinel = Buffer.from("must not be deleted by stale cleanup\n");
    const options = {
      __internal: {
        afterCandidateValidated(candidatePath: string) {
          renameSync(join(root, ".mex"), displacedMex);
          writeFileSync(join(external, basename(candidatePath)), externalSentinel);
          symlinkSync(external, join(root, ".mex"), "dir");
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_PATH_UNSAFE",
    });

    expect(readFileSync(join(displacedMex, "graph.db"))).toEqual(priorBytes);
    const externalEntries = readdirSync(external);
    expect(externalEntries).toHaveLength(1);
    expect(readFileSync(join(external, externalEntries[0]!))).toEqual(externalSentinel);
  });

  it("revalidates the bound .mex directory immediately before creating a candidate database", async () => {
    const root = temporaryRoot();
    const external = temporaryRoot("mex-graph-maintenance-open-external-");
    source(root, "src/service.ts", "export const service = 1;\n");
    const displacedMex = join(root, ".mex-bound-before-open");
    const externalSentinel = Buffer.from("candidate path must remain untouched\n");
    const options = {
      __internal: {
        beforeCandidateDatabaseOpen(candidatePath: string) {
          renameSync(join(root, ".mex"), displacedMex);
          writeFileSync(join(external, basename(candidatePath)), externalSentinel);
          symlinkSync(external, join(root, ".mex"), "dir");
        },
      },
    } as GraphMaintenanceOptions;

    await expect(rebuildGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_PATH_UNSAFE",
    });

    const externalEntries = readdirSync(external);
    expect(externalEntries).toHaveLength(1);
    expect(readFileSync(join(external, externalEntries[0]!))).toEqual(externalSentinel);
    expect(readdirSync(displacedMex)).not.toContain(expect.stringMatching(/^graph\.db\.candidate-/u));
  });

  it("retains exact corrupt bytes in ignored recovery after a successful rebuild", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const recovered = true;\n");
    mkdirSync(join(root, ".mex"), { recursive: true });
    const dbPath = join(root, ".mex", "graph.db");
    const corrupt = Buffer.from("not a sqlite graph\n");
    writeFileSync(dbPath, corrupt);

    const result = await rebuildGraph(root);

    expect(result.status.status).toBe("fresh");
    expect(result.recoveryPath).toMatch(/^\.mex\/graph\.db\.recovery-/u);
    expect(readFileSync(join(root, result.recoveryPath!))).toEqual(corrupt);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_RECOVERY_RETAINED",
    }));
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("clones an older readable index to preserve grounding continuity", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const migrated = true;\n");
    const dbPath = await buildBaseline(root);
    const db = openSqlite(dbPath);
    try {
      db.prepare(
        `INSERT INTO _mex_grounded_source
         (scaffold_file, node_id, source, body_hash, fingerprint) VALUES (?, ?, ?, ?, ?)`,
      ).run(".mex/context/architecture.md", "legacy-node", "legacy body", "hash", "fingerprint");
      db.exec("DELETE FROM schema_versions");
      db.prepare(
        "INSERT INTO schema_versions(version, applied_at, description) VALUES(1, ?, ?)",
      ).run(Date.now(), "legacy fixture");
    } finally {
      db.close();
    }
    const priorBytes = readFileSync(dbPath);

    const result = await rebuildGraph(root);

    expect(result.status.status).toBe("fresh");
    expect(result.recoveryPath).toMatch(/^\.mex\/graph\.db\.recovery-/u);
    expect(readFileSync(join(root, result.recoveryPath!))).toEqual(priorBytes);
    const rebuilt = openSqlite(dbPath, { readOnly: true, immutable: true });
    try {
      expect(rebuilt.prepare(
        "SELECT source FROM _mex_grounded_source WHERE scaffold_file = ? AND node_id = ?",
      ).get(".mex/context/architecture.md", "legacy-node")).toEqual({ source: "legacy body" });
    } finally {
      rebuilt.close();
    }
  });

  it("falls back from a malformed older clone to a fresh candidate and retains recovery", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const fallbackBuilt = true;\n");
    const dbPath = await buildBaseline(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DROP TABLE nodes");
      db.exec("DELETE FROM schema_versions");
      db.prepare(
        "INSERT INTO schema_versions(version, applied_at, description) VALUES(1, ?, ?)",
      ).run(Date.now(), "malformed legacy fixture");
    } finally {
      db.close();
    }
    const priorBytes = readFileSync(dbPath);

    const result = await rebuildGraph(root);

    expect(result.status.status).toBe("fresh");
    expect(result.recoveryPath).toMatch(/^\.mex\/graph\.db\.recovery-/u);
    expect(readFileSync(join(root, result.recoveryPath!))).toEqual(priorBytes);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "GRAPH_INDEX_CONTINUITY_FALLBACK",
    }));
  });

  it("does not let an older-schema fallback hide a current source parse failure", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const previouslyValid = true;\n");
    const dbPath = await buildBaseline(root);
    const db = openSqlite(dbPath);
    try {
      db.exec("DROP TABLE nodes");
      db.exec("DELETE FROM schema_versions");
      db.prepare(
        "INSERT INTO schema_versions(version, applied_at, description) VALUES(1, ?, ?)",
      ).run(Date.now(), "malformed legacy fixture");
    } finally {
      db.close();
    }
    const priorBytes = readFileSync(dbPath);
    source(root, "src/service.ts", "}\n");

    await expect(rebuildGraph(root)).rejects.toMatchObject({
      name: "GraphSourceStagingError",
      code: "GRAPH_SOURCE_STAGING_FAILED",
    });

    expect(readFileSync(dbPath)).toEqual(priorBytes);
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("starts fresh for a newer index while retaining its exact recovery bytes", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const downgradedSafely = true;\n");
    const dbPath = await buildBaseline(root);
    const db = openSqlite(dbPath);
    try {
      db.prepare(
        `INSERT INTO _mex_grounded_source
         (scaffold_file, node_id, source, body_hash, fingerprint) VALUES (?, ?, ?, ?, ?)`,
      ).run(".mex/context/architecture.md", "future-node", "future body", "hash", "fingerprint");
      db.prepare(
        "INSERT INTO schema_versions(version, applied_at, description) VALUES(3, ?, ?)",
      ).run(Date.now(), "future fixture");
    } finally {
      db.close();
    }
    const priorBytes = readFileSync(dbPath);

    const result = await rebuildGraph(root);

    expect(result.status.status).toBe("fresh");
    expect(result.recoveryPath).toMatch(/^\.mex\/graph\.db\.recovery-/u);
    expect(readFileSync(join(root, result.recoveryPath!))).toEqual(priorBytes);
    const rebuilt = openSqlite(dbPath, { readOnly: true, immutable: true });
    try {
      expect(rebuilt.prepare("SELECT COUNT(*) AS count FROM _mex_grounded_source").get())
        .toEqual({ count: 0 });
    } finally {
      rebuilt.close();
    }
  });

  it("reclaims a well-formed owner-token lock only after its process is dead", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    await buildBaseline(root);
    writeFileSync(join(root, ".mex", "graph.db.lock"), `${JSON.stringify({
      pid: 2_147_483_647,
      token: "a".repeat(48),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`);
    let contenderCode: string | null = null;
    const options = {
      __internal: {
        beforeDeadLockReclaim() {
          try {
            const contender = acquireGraphMaintenanceLease(root, "refresh");
            contender.release();
          } catch (error) {
            contenderCode = (error as { code?: string }).code ?? null;
          }
        },
      },
    } as GraphMaintenanceOptions;

    const result = await refreshGraph(root, options);

    expect(result.status.status).toBe("fresh");
    expect(contenderCode).toBe("GRAPH_MAINTENANCE_LOCKED");
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("does not reclaim a dead main lock after losing the acquisition gate", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    await buildBaseline(root);
    const lockPath = join(root, ".mex", "graph.db.lock");
    const gatePath = join(root, ".mex", "graph.db.lock.gate");
    const staleLock = `${JSON.stringify({
      pid: 2_147_483_647,
      token: "d".repeat(48),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    const replacementGate = `${JSON.stringify({
      pid: process.pid,
      token: "e".repeat(48),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    writeFileSync(lockPath, staleLock);
    const options = {
      __internal: {
        beforeDeadLockReclaim() {
          unlinkSync(gatePath);
          writeFileSync(gatePath, replacementGate);
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_RACE",
    });

    expect(readFileSync(lockPath, "utf8")).toBe(staleLock);
    expect(readFileSync(gatePath, "utf8")).toBe(replacementGate);
  });

  it("reports a crash-stale acquisition gate with an explicit recovery path", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    await buildBaseline(root);
    const gatePath = join(root, ".mex", "graph.db.lock.gate");
    writeFileSync(gatePath, `${JSON.stringify({
      pid: 2_147_483_647,
      token: "b".repeat(48),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`);

    await expect(refreshGraph(root)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_GATE_STALE",
      diagnostics: [expect.objectContaining({
        code: "GRAPH_MAINTENANCE_GATE_STALE",
        path: ".mex/graph.db.lock.gate",
      })],
    });

    // Explicit operator recovery is token-safe: maintenance never guesses and
    // never unlinks a possibly active acquisition gate on its own.
    unlinkSync(gatePath);
    expect((await refreshGraph(root)).status.status).toBe("fresh");
    expect(ownedArtifacts(root)).toEqual([]);
  });

  it("does not create the main lock after the acquisition gate loses ownership", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    await buildBaseline(root);
    const replacement = `${JSON.stringify({
      pid: process.pid,
      token: "c".repeat(48),
      startedAt: "2026-01-01T00:00:00.000Z",
    })}\n`;
    const options = {
      __internal: {
        afterLockGateAcquired(gatePath: string) {
          unlinkSync(gatePath);
          writeFileSync(gatePath, replacement);
        },
      },
    } as GraphMaintenanceOptions;

    await expect(refreshGraph(root, options)).rejects.toMatchObject({
      code: "GRAPH_MAINTENANCE_RACE",
    });

    expect(readFileSync(join(root, ".mex", "graph.db.lock.gate"), "utf8")).toBe(replacement);
    expect(readdirSync(join(root, ".mex"))).not.toContain("graph.db.lock");
    unlinkSync(join(root, ".mex", "graph.db.lock.gate"));
  });

  it("holds one owner-token lease across refresh and subsequent writable work", async () => {
    const root = temporaryRoot();
    source(root, "src/service.ts", "export const service = 1;\n");
    await buildBaseline(root);
    const lease = acquireGraphMaintenanceLease(root, "refresh");
    try {
      await lease.refresh();
      await expect(refreshGraph(root)).rejects.toMatchObject({
        code: "GRAPH_MAINTENANCE_LOCKED",
      });
      const db = openSqlite(lease.databasePath);
      try {
        db.prepare(
          "INSERT INTO project_metadata(key, value, updated_at) VALUES(?, ?, ?)",
        ).run("lease_test", "held", Date.now());
      } finally {
        db.close();
      }
    } finally {
      lease.release();
    }

    expect((await inspectGraphStatus({ projectRoot: root })).status).toBe("fresh");
    expect(ownedArtifacts(root)).toEqual([]);
  });
});
