import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitPort } from "../../team/contracts/git.js";
import { TeamIdentityActivityFoundation } from "../../team/foundation.js";
import {
  createLocalHubReadServices,
  type HubGraphReadService,
} from "../services.js";

const EVENT = "event_01ARZ3NDEKTSV4RRFFQ69G5FAB";
const MEMBER = "member_01ARZ3NDEKTSV4RRFFQ69G5FAV";
const NOW = new Date("2026-08-23T00:00:00.000Z");

const git = {
  getRepoState: async () => ({
    branch: "feat/project-hub-foundation",
    head: "a".repeat(40),
    dirty: true,
    observedAt: "2026-08-23T00:00:00.000Z",
  }),
  getIdentity: async () => ({ name: "Daksh", email: "daksh@example.test" }),
} as Pick<GitPort, "getRepoState" | "getIdentity"> as GitPort;

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), "mex-hub-services-"));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

describe("createLocalHubReadServices", () => {
  it("uses real repository context without inventing unavailable project data", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.home()).resolves.toMatchObject({
      repository: {
        name: expect.stringMatching(/^mex-hub-services-/),
        branch: "feat/project-hub-foundation",
        dirty: true,
      },
      actor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      sections: {
        workstreams: { availability: "unavailable", count: null },
        relays: { availability: "unavailable", count: null },
        inbox: { availability: "unavailable", count: null },
        activity: { availability: "available", count: 0 },
      },
      activeJobs: 0,
      attention: [],
    });
  });

  it("keeps Wiki and graph search groups independently unavailable", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki.status).toBe("unavailable");
    expect(result.groups.symbols.status).toBe("unavailable");
    expect(result.groups.sources.status).toBe("unavailable");
    expect(result.groups.wiki.items).toEqual([]);
  });

  it("reports foundation health honestly", async () => {
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const health = await services.health();
    expect(health.status).toBe("degraded");
    expect(health.components.map((component) => [component.id, component.status])).toEqual([
      ["git", "healthy"],
      ["local_state", "healthy"],
      ["migration", "healthy"],
      ["graph", "unavailable"],
      ["wiki", "unavailable"],
    ]);
  });

  it("projects real graph search, workspace, health, and safe maintenance eligibility", async () => {
    const status = {
      status: "stale" as const,
      observedAt: NOW.toISOString(),
      currentRepo: {
        branch: "feature",
        head: "b".repeat(40),
        dirty: true,
        observedAt: NOW.toISOString(),
      },
      lastSuccessfulIndexAt: NOW.toISOString(),
      indexedAt: NOW.toISOString(),
      indexedBranch: "main",
      indexedHead: "a".repeat(40),
      schemaVersion: 2,
      extractorVersion: "extractor-1",
      grammarVersion: "grammar-1",
      parseHealth: {
        total: 2,
        ok: 1,
        partial: 1,
        failed: 0,
        failedPaths: [],
        failedPathsTruncated: false,
      },
      changes: {
        total: 1,
        added: ["src/new.ts"],
        modified: [],
        deleted: [],
        truncated: false,
        branchChanged: true,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      diagnostics: [{
        code: "GRAPH_INDEX_BRANCH_CHANGED",
        severity: "warning" as const,
        message: "private detail /Users/alice/project",
        path: "/Users/alice/project.ts",
        remediation: [{ label: "Refresh", command: "mex graph refresh" }],
      }],
    };
    const symbol = {
      ref: { kind: "symbol" as const, symbolId: "function:router" },
      symbolKind: "function",
      name: "router",
      qualifiedName: "hub.router",
      language: "typescript",
      path: "src/router.ts",
      startLine: 3,
      endLine: 7,
      signature: "router(): void",
    };
    const graph: HubGraphReadService = {
      inspectStatus: async () => status,
      searchBundle: async () => ({
        revision: "c".repeat(64),
        status,
        nodes: {
          ok: true,
          value: { items: [symbol], nextCursor: "next-symbol", truncated: false },
        },
        sources: {
          ok: false,
          problem: {
            title: "Stale cursor",
            status: 409,
            code: "REVISION_CONFLICT",
            detail: "private stale cursor detail",
          },
        },
      }),
      readSymbolWorkspace: async () => ({
        revision: "c".repeat(64),
        status,
        symbol,
        source: {
          items: [{
            path: "src/router.ts",
            startLine: 3,
            endLine: 7,
            content: "export function router() {}",
            contentHash: "d".repeat(64),
            symbolRefs: [symbol.ref],
          }],
          nextCursor: null,
          truncated: false,
        },
        callers: {
          items: [{
            kind: "calls",
            source: { kind: "symbol", symbolId: "function:caller" },
            target: symbol.ref,
            path: "src/caller.ts",
            line: 9,
            provenance: "semantic",
          }],
          nextCursor: null,
          truncated: false,
        },
        callees: null,
        impact: null,
      }),
    };
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      graph: {
        read: { availability: "available" },
        refresh: { availability: "available" },
        rebuild: { availability: "available" },
      },
      wiki: { read: { availability: "unavailable" } },
    });
    const search = await services.search({ q: "router", limit: 25 });
    expect(search.groups.symbols).toMatchObject({
      status: "available",
      revision: "c".repeat(64),
      items: [{ kind: "code_symbol", id: "function:router", path: "src/router.ts" }],
    });
    expect(search.groups.sources).toMatchObject({
      status: "failed",
      code: "REVISION_CONFLICT",
      revision: null,
    });

    await expect(services.codeSymbol?.("function:router", {
      view: "callers",
      limit: 25,
    })).resolves.toMatchObject({
      revision: "c".repeat(64),
      symbol: { id: "function:router" },
      source: { items: [{ content: "export function router() {}" }] },
      traversal: {
        view: "callers",
        items: [{ sourceId: "function:caller", targetId: "function:router" }],
      },
    });

    const health = await services.health();
    const graphHealth = health.components.find((component) => component.id === "graph");
    expect(graphHealth).toMatchObject({
      status: "degraded",
      repairJobKind: "graph_refresh",
      graph: {
        indexStatus: "stale",
        allowedJobKinds: ["graph_refresh"],
        recommendedJobKind: "graph_refresh",
      },
    });
    expect(JSON.stringify(graphHealth)).not.toContain("/Users/alice");
    await expect(services.assertJobStartAllowed?.("graph_refresh")).resolves.toBeUndefined();
    await expect(services.assertJobStartAllowed?.("graph_rebuild")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
  });

  it("recognizes legacy rebuild remediation and marks structural inspection failure unavailable", async () => {
    const missing = {
      status: "missing" as const,
      observedAt: NOW.toISOString(),
      currentRepo: { branch: "main", head: null, dirty: false, observedAt: NOW.toISOString() },
      lastSuccessfulIndexAt: null,
      indexedAt: null,
      indexedBranch: null,
      indexedHead: null,
      schemaVersion: null,
      extractorVersion: null,
      grammarVersion: null,
      parseHealth: { total: 0, ok: 0, partial: 0, failed: 0, failedPaths: [], failedPathsTruncated: false },
      changes: {
        total: 0,
        added: [],
        modified: [],
        deleted: [],
        truncated: false,
        branchChanged: false,
        manifestChanged: false,
        configChanged: false,
        grammarChanged: false,
      },
      diagnostics: [{
        code: "GRAPH_INDEX_MISSING",
        severity: "warning" as const,
        message: "missing",
        remediation: [{ label: "Build graph", command: "mex graph" }],
      }],
    };
    const base = {
      searchBundle: async () => { throw new Error("unused"); },
      readSymbolWorkspace: async () => { throw new Error("unused"); },
    };
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph: { ...base, inspectStatus: async () => missing },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    await expect(services.assertJobStartAllowed?.("graph_rebuild")).resolves.toBeUndefined();

    const failed = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph: { ...base, inspectStatus: async () => { throw new Error("/Users/alice/private"); } },
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    const health = await failed.health();
    expect(health.components.find((component) => component.id === "graph")).toMatchObject({
      status: "unavailable",
    });
    expect(JSON.stringify(health)).not.toContain("/Users/alice");
  });

  it("lets the durable job manager retain its authoritative active-job conflict", async () => {
    const inspectStatus = vi.fn(async () => { throw new Error("must not inspect during contention"); });
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph: {
        inspectStatus,
        searchBundle: async () => { throw new Error("unused"); },
        readSymbolWorkspace: async () => { throw new Error("unused"); },
      },
      jobs: {
        list: () => ({
          items: [{
            id: "job_01ARZ3NDEKTSV4RRFFQ69G5FAV",
            scaffoldId: "scaffold-local",
            kind: "graph_refresh",
            generation: 1,
            phase: "running",
            progress: null,
            state: "running",
            cancelRequested: false,
            createdAt: NOW.toISOString(),
            startedAt: NOW.toISOString(),
            revision: "a".repeat(64),
          }],
        }),
      },
      now: () => new Date(NOW),
    });

    await expect(services.assertJobStartAllowed?.("graph_rebuild")).resolves.toBeUndefined();
    expect(inspectStatus).not.toHaveBeenCalled();
  });

  it("projects canonical and legacy activity without exposing private fields", async () => {
    const writer = new TeamIdentityActivityFoundation({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      now: () => new Date(NOW),
      activityIdFactory: () => EVENT,
    });
    const longPath = `src/${"x".repeat(390)}.ts`;
    const preview = await writer.previewActivity({
      action: "member.updated",
      subjects: [
        { kind: "entity", entity: { id: "workstream_alpha", kind: "workstream", title: "Alpha" } },
        { kind: "code", code: { kind: "symbol", symbolId: "symbol:router" } },
        { kind: "code", code: { kind: "file", path: "src/router.ts" } },
        { kind: "file", path: longPath },
        { kind: "commit", hash: "a".repeat(40) },
        { kind: "file", path: "src/1.ts" },
        { kind: "file", path: "src/2.ts" },
        { kind: "file", path: "src/3.ts" },
        { kind: "file", path: "src/4.ts" },
        { kind: "file", path: "src/5.ts" },
      ],
      workstream: { id: "workstream_alpha", kind: "workstream", title: "Alpha" },
      metadata: { reason: "private projection detail" },
    });
    await writer.applyActivity(preview, preview.activity.previewRevision);
    await writer.members.create({
      id: MEMBER,
      displayName: "Daksh Current",
      gitAliases: [{ name: "Daksh", email: "daksh@example.test" }],
    });

    mkdirSync(join(projectRoot, ".mex/events"), { recursive: true });
    writeFileSync(join(projectRoot, ".mex/events/decisions.jsonl"), [
      JSON.stringify({
        timestamp: "2026-08-24T00:00:00.000Z",
        kind: "note",
        message: "Legacy note",
        files: ["src/legacy.ts", longPath, "/Users/alice/private.ts", "src/\u0080.ts"],
        cwd: "/Users/alice/private-project",
        trace: "/Users/alice/private-trace",
        source: "secret-origin",
        status: "private-status",
      }),
      "not valid json",
      "",
    ].join("\n"), "utf8");

    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      activity: { availability: "available" },
    });
    await expect(services.home()).resolves.toMatchObject({
      sections: { activity: { availability: "available", count: 1 } },
    });

    const result = await services.activity({ limit: 25 });
    expect(result.items.map((item) => item.source)).toEqual(["legacy", "activity"]);
    const legacy = result.items[0];
    expect(legacy).toMatchObject({
      source: "legacy",
      recordedActor: null,
      effectiveActor: null,
      repository: null,
      message: "Legacy note",
      messageTruncated: false,
      subjectCount: 2,
      subjectsTruncated: true,
      subjects: [{ kind: "file", path: "src/legacy.ts" }],
    });
    const canonical = result.items[1];
    expect(canonical).toMatchObject({
      source: "activity",
      recordedActor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
      effectiveActor: { kind: "member", memberId: MEMBER, displayName: "Daksh Current" },
      subjectCount: 10,
      subjectsTruncated: true,
      workstream: { id: "workstream_alpha", entityKind: "workstream", title: "Alpha" },
    });
    expect(canonical?.subjects).toHaveLength(8);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      code: "LEGACY_ACTIVITY_MALFORMED",
      message: "A malformed legacy activity row was ignored.",
    }));
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("private projection detail");
    expect(serialized).not.toContain("/Users/alice");
    expect(serialized).not.toContain("private-trace");
    expect(serialized).not.toContain("secret-origin");
    expect(serialized).not.toContain("private-status");
  });

  it("caps projected diagnostics and reports a truncated legacy message", async () => {
    mkdirSync(join(projectRoot, ".mex/events"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".mex/events/decisions.jsonl"),
      `${JSON.stringify({
        timestamp: "2026-08-24T00:00:00.000Z",
        kind: "note",
        message: "é".repeat(1_100),
        files: [],
      })}\n${Array.from({ length: 60 }, () => "malformed").join("\n")}\n`,
      "utf8",
    );
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    const result = await services.activity({ source: "legacy", limit: 25 });
    expect(result.diagnostics).toHaveLength(50);
    expect(result.diagnosticsTruncated).toBe(true);
    expect(result.items[0]).toMatchObject({
      source: "legacy",
      messageTruncated: true,
    });
    expect(Buffer.byteLength((result.items[0] as { message: string }).message, "utf8")).toBe(2_048);
  });
});
