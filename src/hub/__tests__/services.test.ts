import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitPort } from "../../team/contracts/git.js";
import {
  createLocalHubReadServices as createLocalHubReadServicesBase,
  type HubGraphReadService,
  type HubWikiReadService,
  type LocalHubReadServicesOptions,
} from "../services.js";
import { createRepositoryWikiPort } from "../../wiki/application-adapter.js";
import type { WikiIndexStatus } from "../../team/contracts/wiki.js";
import { createRepositoryTeamWorkflowPortWithDependencies } from "../../team/workflow/repository-team-workflow-port.js";
import { ActivityRepository } from "../../team/activity/repository.js";
import { MemberRepository } from "../../team/identity/member-repository.js";

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

function wikiWithStatus(state: WikiIndexStatus["state"]): HubWikiReadService {
  const unused = async (): Promise<never> => { throw new Error("unused"); };
  return {
    inspectIndex: async () => ({
      state,
      observedAt: NOW.toISOString(),
      schemaVersion: state === "missing" ? null : 3,
      indexedRevision: ["missing", "rebuild_required", "migration_required"].includes(state)
        ? null
        : "f".repeat(64),
      indexedAt: state === "missing" ? null : NOW.toISOString(),
      diagnostics: [],
    }),
    listBundle: unused,
    searchBundle: unused,
    readKnowledgeWorkspace: unused,
    knowledgeForCode: unused,
  };
}

function createLocalHubReadServices(
  options: Omit<LocalHubReadServicesOptions, "team">,
): ReturnType<typeof createLocalHubReadServicesBase> {
  const team = createRepositoryTeamWorkflowPortWithDependencies(options.projectRoot, {
    scaffoldId: options.scaffoldId,
    wiki: createRepositoryWikiPort(options.projectRoot, {
      now: () => (options.now ?? (() => new Date()))().toISOString(),
    }),
    ...(options.git === undefined ? {} : { git: options.git }),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  return createLocalHubReadServicesBase({ ...options, team });
}

describe("createLocalHubReadServices", () => {
  it("projects real bounded Wiki browse, detail, relations, search, Code links, and health", async () => {
    const entity = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";
    const target = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJE";
    const context = join(projectRoot, ".mex", "context");
    mkdirSync(context, { recursive: true });
    writeFileSync(join(context, "queue.md"), `<!-- mex:entity
id: ${entity}
type: architecture
status: promoted
revision: 1
relations:
  - type: depends_on
    target: ${target}
sources:
  - type: agent_session
    ref: session_01Jo6Wr2CMDPtLn3
  - type: manual
    note: Maintainer evidence
  - type: manual
    ref: '(\\\\server\\share\\secret)'
    note: trace(/Users/alice/private-note)
    repository: 'cwd=C:\\Users\\alice\\private-repository'
  - type: manual
    ref: file://localhost/Users/alice/file-authority-ref
    note: file://server/share/file-authority-note
provenance:
  createdBy:
    kind: agent
    id: file://localhost/Users/alice/private-provenance
grounds_to:
  - node: function:1111111111111111
    fingerprint: mh:4:11111111
    reason: file://server/share/private-grounding
-->
## Durable queue

One service owns durable queueing.
`, "utf8");
    writeFileSync(join(context, "worker.md"), `<!-- mex:entity
id: ${target}
type: component
status: promoted
revision: 1
-->
## Queue worker

The worker drains the durable queue.
`, "utf8");
    const wiki = createRepositoryWikiPort(projectRoot, { now: () => NOW.toISOString() });
    await wiki.rebuildIndex();
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    await expect(services.capabilities()).resolves.toMatchObject({
      wiki: {
        read: { availability: "available" },
        refresh: { availability: "available" },
        rebuild: { availability: "available" },
      },
    });
    const browse = await services.wikiEntities?.({ limit: 25 });
    expect(browse?.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: entity, kind: "architecture", title: "Durable queue" }),
    ]));
    expect(browse?.nextCursor).toBeNull();
    const detail = await services.wikiEntity?.(entity);
    expect(detail).toMatchObject({
      entity: { id: entity, groundingHealth: "unverified" },
      body: { content: expect.stringContaining("One service owns") },
      relationCount: 1,
      backlinkCount: 0,
      sources: { total: 4 },
    });
    expect(detail?.sources.items.find((source) => source.type === "agent_session")?.ref).toBeNull();
    expect(JSON.stringify(detail)).not.toContain("session_01Jo6Wr2CMDPtLn3");
    expect(JSON.stringify(detail)).not.toContain("/Users/alice");
    expect(JSON.stringify(detail)).not.toContain("C:\\\\Users");
    expect(JSON.stringify(detail)).not.toContain("server\\\\share");
    expect(JSON.stringify(detail)).not.toContain("file://");
    await expect(services.wikiRelations?.(entity, { direction: "outgoing", limit: 25 })).resolves.toMatchObject({
      items: [{ direction: "outgoing", relation: { target: { id: target } } }],
    });
    await expect(services.wikiBacklinks?.(target, { limit: 25 })).resolves.toMatchObject({
      items: [{ source: { id: entity }, target: { id: target } }],
    });
    await expect(services.codeKnowledge?.("function:1111111111111111", { limit: 25 })).resolves.toMatchObject({
      items: [{ entity: { id: entity }, matchedNodes: ["function:1111111111111111"] }],
    });
    const search = await services.search({ q: "durable", limit: 25 });
    expect(search.groups.wiki.status).toBe("available");
    expect(search.groups.wiki.items).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: entity,
        kind: "wiki",
        matchedFields: expect.arrayContaining(["body"]),
      }),
    ]));
    expect(search.groups.symbols.status).toBe("unavailable");
    const wikiHealth = (await services.health()).components.find((component) => component.id === "wiki");
    expect(wikiHealth).toMatchObject({
      status: "healthy",
      wiki: {
        indexStatus: "fresh",
        allowedJobKinds: ["wiki_refresh", "wiki_rebuild"],
        recommendedJobKind: null,
      },
    });
  });

  it("revalidates Wiki maintenance eligibility for every index state", async () => {
    const expected: Record<WikiIndexStatus["state"], readonly string[]> = {
      missing: ["wiki_rebuild"],
      fresh: ["wiki_refresh", "wiki_rebuild"],
      stale: ["wiki_refresh", "wiki_rebuild"],
      degraded: [],
      rebuild_required: ["wiki_rebuild"],
      corrupt: ["wiki_rebuild"],
      migration_required: [],
    };
    for (const [state, allowed] of Object.entries(expected) as Array<[WikiIndexStatus["state"], readonly string[]]>) {
      const wiki = wikiWithStatus(state);
      const services = createLocalHubReadServices({
        projectRoot,
        scaffoldId: "scaffold-local",
        git,
        wiki,
        jobs: { list: () => ({ items: [] }) },
        now: () => new Date(NOW),
      });
      for (const kind of ["wiki_refresh", "wiki_rebuild"] as const) {
        const assertion = services.assertJobStartAllowed?.(kind);
        if (allowed.includes(kind)) await expect(assertion, `${state}:${kind}`).resolves.toBeUndefined();
        else await expect(assertion, `${state}:${kind}`).rejects.toMatchObject({ code: "CAPABILITY_UNAVAILABLE" });
      }
      const health = await services.health();
      expect(health.components.find((component) => component.id === "wiki")?.wiki?.allowedJobKinds)
        .toEqual(allowed);
    }

    const unsafeWiki = {
      ...wikiWithStatus("stale"),
      inspectIndex: async () => ({
        ...(await wikiWithStatus("stale").inspectIndex()),
        diagnostics: [{
          code: "PATH_OUTSIDE_SCAFFOLD",
          severity: "warning" as const,
          message: "/Users/alice/private symlink target",
        }],
      }),
    } satisfies HubWikiReadService;
    const unsafe = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      wiki: unsafeWiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });
    await expect(unsafe.assertJobStartAllowed?.("wiki_refresh")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    await expect(unsafe.assertJobStartAllowed?.("wiki_rebuild")).rejects.toMatchObject({
      code: "CAPABILITY_UNAVAILABLE",
    });
    const unsafeHealth = await unsafe.health();
    const unsafeComponent = unsafeHealth.components.find((component) => component.id === "wiki");
    expect(unsafeComponent).toMatchObject({
      wiki: { allowedJobKinds: [], recommendedJobKind: null },
    });
    expect(unsafeComponent).not.toHaveProperty("repairJobKind");
    expect(JSON.stringify(unsafeHealth)).not.toContain("/Users/alice");
  });

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

  it("keeps a Wiki search failure local without erasing trustworthy graph groups", async () => {
    const wiki = {
      ...wikiWithStatus("stale"),
      searchBundle: async () => {
        throw {
          problem: {
            code: "INDEX_STALE",
            status: 409,
            detail: "/Users/alice/private Wiki error",
          },
        };
      },
    } satisfies HubWikiReadService;
    const graph = {
      inspectStatus: async () => { throw new Error("unused"); },
      readSymbolWorkspace: async () => { throw new Error("unused"); },
      searchBundle: async () => ({
        revision: "c".repeat(64),
        status: {} as never,
        nodes: {
          ok: true as const,
          value: { items: [], nextCursor: null, truncated: false },
        },
        sources: {
          ok: true as const,
          value: { items: [], nextCursor: null, truncated: false },
        },
      }),
    } satisfies HubGraphReadService;
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki).toMatchObject({
      status: "failed",
      code: "INDEX_STALE",
      items: [],
      revision: null,
    });
    expect(result.groups.symbols).toMatchObject({ status: "available", revision: "c".repeat(64) });
    expect(result.groups.sources).toMatchObject({ status: "available", revision: "c".repeat(64) });
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
  });

  it("fails both invalidated graph groups without erasing a trustworthy Wiki group", async () => {
    const wiki = {
      ...wikiWithStatus("fresh"),
      searchBundle: async () => ({
        indexedRevision: "f".repeat(64),
        observedAt: NOW.toISOString(),
        results: { items: [], nextCursor: null, estimatedTokens: 0, truncated: false },
      }),
    } satisfies HubWikiReadService;
    const graph = {
      inspectStatus: async () => { throw new Error("unused"); },
      readSymbolWorkspace: async () => { throw new Error("unused"); },
      searchBundle: async () => {
        throw {
          problem: {
            code: "OPERATION_INTERRUPTED",
            status: 503,
            detail: "/Users/alice/private graph race",
          },
        };
      },
    } satisfies HubGraphReadService;
    const services = createLocalHubReadServices({
      projectRoot,
      scaffoldId: "scaffold-local",
      git,
      graph,
      wiki,
      jobs: { list: () => ({ items: [] }) },
      now: () => new Date(NOW),
    });

    const result = await services.search({ q: "grounding", limit: 25 });
    expect(result.groups.wiki).toMatchObject({ status: "available", revision: "f".repeat(64) });
    expect(result.groups.symbols).toMatchObject({
      status: "failed",
      code: "OPERATION_INTERRUPTED",
      revision: null,
    });
    expect(result.groups.sources).toMatchObject({
      status: "failed",
      code: "OPERATION_INTERRUPTED",
      revision: null,
    });
    expect(JSON.stringify(result)).not.toContain("/Users/alice");
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
    const activity = new ActivityRepository({
      projectRoot,
      git,
      now: () => new Date(NOW),
      generateId: () => EVENT,
    });
    const longPath = `src/${"x".repeat(390)}.ts`;
    const preview = await activity.previewCreate({
      actor: { kind: "git", name: "Daksh", email: "daksh@example.test" },
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
    await activity.applyCreate(preview, preview.previewRevision);
    await new MemberRepository(projectRoot).create({
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
