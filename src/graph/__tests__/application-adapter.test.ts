import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MexPortError } from "../../team/contracts/shared.js";
import {
  createRepositoryGraphPort,
  type GraphSearchBundleResult,
} from "../application-adapter.js";
import { openSqlite } from "../db/sqlite.js";
import { FingerprintStore } from "../fingerprint-store.js";
import { serializeFingerprint } from "../fingerprint.js";
import { loadFreshGraphReadSession } from "../read-session.js";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-application-adapter-"));
  roots.push(root);
  return root;
}

function source(root: string, path: string, contents: string): void {
  const absolute = join(root, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, contents);
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, {
    cwd: root,
    stdio: "ignore",
    env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
}

async function fixture(): Promise<{
  root: string;
  port: ReturnType<typeof createRepositoryGraphPort>;
}> {
  const root = temporaryRoot();
  source(root, ".gitignore", ".mex/graph.db*\n");
  source(root, "src/service.ts", [
    "export function serviceTarget(input: number): number {",
    "  const doubled = input * 2;",
    "  const adjusted = doubled + 7;",
    "  return adjusted > 20 ? adjusted - 3 : adjusted + 3;",
    "}",
    "",
    "export function serviceCaller(): number {",
    "  return serviceTarget(10);",
    "}",
    "",
    "export function serviceOther(): number {",
    "  return serviceTarget(5);",
    "}",
    "",
  ].join("\n"));
  source(root, "src/auxiliary.ts", [
    "export function serviceAuxiliary(input: number): number {",
    "  const normalized = input + 1;",
    "  return normalized * 3;",
    "}",
    "",
  ].join("\n"));
  git(root, "init", "-q", "-b", "main");
  git(root, "config", "user.name", "Adapter Test");
  git(root, "config", "user.email", "adapter@example.invalid");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
  const port = createRepositoryGraphPort(root);
  await port.rebuild();
  return { root, port };
}

function expectPortCode(error: unknown, code: string): void {
  expect(error).toBeInstanceOf(MexPortError);
  expect((error as MexPortError).problem.code).toBe(code);
}

describe("RepositoryGraphPort", () => {
  it("keeps missing status read-only and maps unavailable reads", async () => {
    const root = temporaryRoot();
    source(root, "src/empty.ts", "export const empty = true;\n");
    const port = createRepositoryGraphPort(root);

    await expect(port.inspectStatus()).resolves.toMatchObject({ status: "missing" });
    await expect(port.searchNodes({ query: "empty", limit: 1 })).rejects.toSatisfy((error) => {
      expectPortCode(error, "INDEX_MISSING");
      return true;
    });
  });

  it("projects search, source, relations, impact, and workspace from one fresh snapshot", async () => {
    const { port } = await fixture();
    const status = await port.inspectStatus();
    expect(status.status).toBe("fresh");

    const nodes = await port.searchNodes({ query: "service", limit: 2 });
    expect(nodes.items).toHaveLength(2);
    expect(nodes.nextCursor).toEqual(expect.any(String));
    const second = await port.searchNodes({
      query: "service",
      limit: 2,
      cursor: nodes.nextCursor!,
    });
    expect(new Set([...nodes.items, ...second.items].map((item) => item.ref.symbolId)).size)
      .toBe(nodes.items.length + second.items.length);

    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const caller = (await port.searchNodes({ query: "serviceCaller", limit: 1 })).items[0]!;
    await expect(port.getNode(target.ref.symbolId)).resolves.toEqual(target);

    const sourcePage = await port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 1,
    });
    expect(sourcePage.items[0]).toMatchObject({
      path: "src/service.ts",
      startLine: target.startLine,
      endLine: target.startLine,
    });
    expect(sourcePage.nextCursor).toEqual(expect.any(String));
    const sourceContinuation = await port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 1,
      cursor: sourcePage.nextCursor!,
    });
    expect(sourceContinuation.items[0]!.startLine).toBeGreaterThan(target.startLine);

    const callers = await port.getCallers({ symbolId: target.ref.symbolId, limit: 10 });
    expect(callers.items.some((item) => item.source.symbolId === caller.ref.symbolId)).toBe(true);
    const callees = await port.getCallees({ symbolId: caller.ref.symbolId, limit: 10 });
    expect(callees.items.some((item) => item.target.symbolId === target.ref.symbolId)).toBe(true);

    const impact = await port.getImpact({ ref: target.ref, depth: 2, maxNodes: 20 });
    expect(impact.roots[0]?.ref.symbolId).toBe(target.ref.symbolId);
    expect(impact.impacted.some((item) => item.symbol.ref.symbolId === caller.ref.symbolId)).toBe(true);

    const workspace = await port.readSymbolWorkspace({
      symbolId: target.ref.symbolId,
      source: { maxLines: 20, maxBytes: 4096 },
      callers: { limit: 10 },
      impact: { depth: 1, maxNodes: 20 },
    });
    expect(workspace.symbol.ref.symbolId).toBe(target.ref.symbolId);
    expect(workspace.source.items).toHaveLength(1);
    expect(workspace.callers?.items.length).toBeGreaterThan(0);
    expect(workspace.callees).toBeNull();
    expect(workspace.impact?.roots).toHaveLength(1);

    const callersSource = await port.readSymbolWorkspace({
      symbolId: target.ref.symbolId,
      workspaceView: "callers",
      source: { maxLines: 1, maxBytes: 256 },
      callers: { limit: 10 },
    });
    expect(callersSource.source.nextCursor).toEqual(expect.any(String));
    await expect(port.readSymbolWorkspace({
      symbolId: target.ref.symbolId,
      workspaceView: "impact",
      source: {
        maxLines: 1,
        maxBytes: 256,
        cursor: callersSource.source.nextCursor!,
      },
      impact: { depth: 1, maxNodes: 20 },
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "VALIDATION_FAILED");
      return true;
    });
  }, 20_000);

  it("isolates request-specific bundle cursor errors while retaining the other group", async () => {
    const { port } = await fixture();

    const result: GraphSearchBundleResult = await port.searchBundle({
      nodes: { query: "service", cursor: "not-a-cursor", limit: 1 },
      sources: {
        query: "service",
        maxLinesPerMatch: 10,
        maxBytesPerMatch: 1024,
        limit: 2,
      },
    });

    expect(result.nodes).toMatchObject({
      ok: false,
      problem: { code: "VALIDATION_FAILED" },
    });
    expect(result.sources.ok).toBe(true);
    if (result.sources.ok) {
      expect(result.sources.value.items.length).toBeGreaterThan(0);
      expect(result.sources.value.items[0]).toMatchObject({
        linesTruncated: expect.any(Boolean),
        bytesTruncated: expect.any(Boolean),
      });
    }
  }, 20_000);

  it("reports exact source clipping and binds every paginated cursor to its limit", async () => {
    const { port } = await fixture();
    const expectLimitConflict = async (operation: Promise<unknown>) => {
      await expect(operation).rejects.toSatisfy((error) => {
        expectPortCode(error, "VALIDATION_FAILED");
        return true;
      });
    };

    const lineClipped = await port.searchSource({
      query: "service",
      maxLinesPerMatch: 1,
      maxBytesPerMatch: 4_096,
      limit: 1,
    });
    expect(lineClipped.items[0]).toMatchObject({ linesTruncated: true, bytesTruncated: false });
    expect(lineClipped.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.searchSource({
      query: "service",
      maxLinesPerMatch: 1,
      maxBytesPerMatch: 4_096,
      limit: 2,
      cursor: lineClipped.nextCursor!,
    }));

    const byteClipped = await port.searchSource({
      query: "service",
      maxLinesPerMatch: 40,
      maxBytesPerMatch: 1,
      limit: 1,
    });
    expect(byteClipped.items[0]).toMatchObject({ bytesTruncated: true });

    const nodes = await port.searchNodes({ query: "service", limit: 1 });
    expect(nodes.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.searchNodes({
      query: "service",
      limit: 2,
      cursor: nodes.nextCursor!,
    }));

    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const sourcePage = await port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 1,
    });
    expect(sourcePage.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.readSource({
      ref: target.ref,
      maxLines: 1,
      maxBytes: 256,
      limit: 2,
      cursor: sourcePage.nextCursor!,
    }));

    const callers = await port.getCallers({ symbolId: target.ref.symbolId, limit: 1 });
    expect(callers.nextCursor).toEqual(expect.any(String));
    await expectLimitConflict(port.getCallers({
      symbolId: target.ref.symbolId,
      limit: 2,
      cursor: callers.nextCursor!,
    }));
  }, 30_000);

  it("binds cursors to both the request and exact graph snapshot", async () => {
    const { root, port } = await fixture();
    const first = await port.searchNodes({ query: "service", limit: 1 });
    expect(first.nextCursor).toEqual(expect.any(String));

    await expect(port.searchNodes({
      query: "serviceTarget",
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "VALIDATION_FAILED");
      return true;
    });

    source(root, "src/service.ts", [
      "export function serviceTarget(input: number): number { return input * 4; }",
      "export function serviceCaller(): number { return serviceTarget(10); }",
      "export function serviceOther(): number { return serviceTarget(5); }",
      "",
    ].join("\n"));
    git(root, "add", "src/service.ts");
    git(root, "commit", "-qm", "change fixture");
    await port.rebuild();

    await expect(port.searchNodes({
      query: "service",
      limit: 1,
      cursor: first.nextCursor!,
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "REVISION_CONFLICT");
      return true;
    });
  }, 30_000);

  it("resolves symbol and file grounding without leaking persisted rows", async () => {
    const { root, port } = await fixture();
    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const db = openSqlite(join(root, ".mex", "graph.db"), { readOnly: true, immutable: true });
    const current = new FingerprintStore(db).get(target.ref.symbolId);
    db.close();
    expect(current).not.toBeNull();
    const fingerprint = serializeFingerprint(current!);

    await expect(port.resolveCodeRef({
      ref: { ...target.ref, fingerprint },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "resolved", health: "fresh" });
    await expect(port.resolveCodeRef({
      ref: { ...target.ref, fingerprint: `${fingerprint}00` },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "unverified", health: "unverified" });
    await expect(port.resolveCodeRef({
      ref: { kind: "symbol", symbolId: "function:missing", fingerprint },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "resolved", health: "fresh" });
    await expect(port.resolveCodeRef({
      ref: { kind: "file", path: "src/service.ts" },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "resolved", health: "fresh" });
    await expect(port.resolveCodeRef({
      ref: { kind: "file", path: "src/service.ts", fingerprint: "not-a-sha256" },
      maxCandidates: 5,
    })).resolves.toMatchObject({ status: "unverified", health: "unverified" });
    await expect(port.resolveCodeRef({
      ref: { kind: "file", path: "../outside.ts" },
      maxCandidates: 5,
    })).rejects.toSatisfy((error) => {
      expectPortCode(error, "PATH_OUTSIDE_PROJECT");
      return true;
    });
  }, 20_000);

  it("discards buffered output when final freshness revalidation fails", async () => {
    const { root } = await fixture();
    const port = createRepositoryGraphPort(root, {
      __internal: {
        loadFresh: async (...args) => {
          const loaded = await loadFreshGraphReadSession(...args);
          if (!loaded.session) return loaded;
          return {
            ...loaded,
            session: {
              ...loaded.session,
              revalidateFreshness: async () => ({
                valid: false,
                code: "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
                message: "test race",
                graphStatus: loaded.graphStatus,
              }),
            },
          };
        },
      },
    });

    await expect(port.searchNodes({ query: "service", limit: 1 })).rejects.toSatisfy((error) => {
      expectPortCode(error, "OPERATION_INTERRUPTED");
      expect((error as MexPortError).problem.detail).not.toContain("test race");
      return true;
    });
  }, 20_000);

  it("fails closed on out-of-range confidence and unknown relation provenance", async () => {
    const { root, port } = await fixture();
    const target = (await port.searchNodes({ query: "serviceTarget", limit: 1 })).items[0]!;
    const dbPath = join(root, ".mex", "graph.db");
    const updateRelation = (confidence: number, provenance: string) => {
      const db = openSqlite(dbPath);
      try {
        db.prepare(
          "UPDATE edges SET confidence = ?, provenance = ? WHERE kind = 'calls'",
        ).run(confidence, provenance);
      } finally {
        db.close();
      }
    };

    updateRelation(1.01, "tree-sitter");
    await expect(port.getCallers({ symbolId: target.ref.symbolId, limit: 10 }))
      .rejects.toSatisfy((error) => {
        expectPortCode(error, "INDEX_CORRUPT");
        return true;
      });

    updateRelation(0.9, "untrusted-provenance");
    await expect(port.getCallers({ symbolId: target.ref.symbolId, limit: 10 }))
      .rejects.toSatisfy((error) => {
        expectPortCode(error, "INDEX_CORRUPT");
        expect((error as MexPortError).problem.detail).not.toContain("untrusted-provenance");
        return true;
      });
  }, 20_000);
});
