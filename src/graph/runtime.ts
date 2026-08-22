import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { globSync } from "glob";
import type { MexConfig, Grounding } from "../types.js";
import { extractGroundings, findMexAnchors, rewriteMexAnchor, writeGroundings } from "../markdown.js";
import { createGroundingChecker, type GroundingChecker, type GroundedSource } from "./grounding.js";
import { createGraphEngine, createGraphEngineFromOpenDatabase } from "./engine-impl.js";
import type { GraphEngine, IndexedFileInfo } from "./engine.js";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  GRAPH_CORPUS_IGNORE_GLOBS,
  GRAPH_SUPPORTED_SOURCE_GLOB,
} from "./corpus-policy.js";
import { openGraphDatabase } from "./db/database.js";
import type { SqliteDatabase } from "./db/sqlite.js";
import { FingerprintStore } from "./fingerprint-store.js";
import { deserializeFingerprint, serializeFingerprint } from "./fingerprint.js";
import { MinHashReconciler } from "./reconcile-engine.js";
import type { Fingerprint, Reconciler } from "./reconcile.js";
import {
  inspectGraphSidecars,
  inspectGraphStatus,
  inspectGraphStatusWithFreshObservation,
  resolveContainedGraphDatabasePath,
  type InternalGraphStatusInspection,
  type GraphSidecarProbe,
} from "./status.js";
import {
  GRAPH_SNAPSHOT_METADATA_KEY,
  computeSourceCorpusDigest,
  parseGraphSnapshot,
  type GraphSnapshot,
} from "./snapshot.js";
import type { GraphStatus } from "../team/contracts/graph.js";

export interface GroundingRuntime {
  graph: GraphEngine;
  reconciler: MinHashReconciler;
  checker: GroundingChecker;
  fingerprints: FingerprintStore;
  /** Pre-sync fingerprints for inline ids that may disappear during a rename. */
  anchorFingerprints: ReadonlyMap<string, Fingerprint>;
  close(): void;
}

export interface GroundingBaselineCaptureResult {
  captured: number;
  skipped: number;
}

export interface GroundingBaselineCaptureOptions {
  /** Sync may normalize an agent's stale fingerprint to the current graph fact. */
  updateFingerprints?: boolean;
  warn?: (message: string) => void;
}

export interface ReadOnlyGroundingRuntimeResult {
  graphStatus: GraphStatus;
  runtime: GroundingRuntime | null;
}

export interface LoadReadOnlyGroundingRuntimeOptions {
  /** Internal seam for status/error-path tests. */
  inspectStatus?: typeof inspectGraphStatus;
  /** Internal seam for deterministic reader-handshake tests. */
  inspectSidecars?: typeof inspectGraphSidecars;
  /** Inspect status without opening graph readers when grounding is irrelevant. */
  loadRuntime?: boolean;
}

interface ReadOnlyGroundingRuntimeInternalHooks {
  inspectObservation?: typeof inspectGraphStatusWithFreshObservation;
  afterStatusInspection?: (
    inspection: InternalGraphStatusInspection,
  ) => void | Promise<void>;
  afterDatabaseIdentityRead?: () => void | Promise<void>;
  afterDatabaseOpen?: (database: SqliteDatabase) => void | Promise<void>;
}

type LoadReadOnlyGroundingRuntimeInternalOptions = LoadReadOnlyGroundingRuntimeOptions & {
  /** Module-private deterministic race seams; deliberately absent from declarations. */
  __internal?: ReadOnlyGroundingRuntimeInternalHooks;
};

/**
 * Load grounding readers without synchronizing or otherwise repairing the
 * graph. A non-fresh snapshot is reported to the caller and never used for
 * grounding, because doing so could incorrectly present stale facts as clean.
 */
export async function loadReadOnlyGroundingRuntime(
  config: MexConfig,
  options: LoadReadOnlyGroundingRuntimeOptions = {},
): Promise<ReadOnlyGroundingRuntimeResult> {
  const dbPath = resolve(config.projectRoot, ".mex", "graph.db");
  const internal = (options as LoadReadOnlyGroundingRuntimeInternalOptions).__internal;
  const statusOptions = { projectRoot: config.projectRoot, dbPath };
  const inspection: InternalGraphStatusInspection = options.inspectStatus
    ? {
        graphStatus: await options.inspectStatus(statusOptions),
        freshObservation: null,
      }
    : await (internal?.inspectObservation ?? inspectGraphStatusWithFreshObservation)(statusOptions);
  await internal?.afterStatusInspection?.(inspection);
  const { graphStatus, freshObservation } = inspection;
  if (graphStatus.status !== "fresh" || options.loadRuntime === false) {
    return { graphStatus, runtime: null };
  }
  if (!freshObservation
    || createHash("sha256").update(freshObservation.snapshotRaw).digest("hex")
      !== freshObservation.snapshotHash) {
    return unavailableReadOnlyRuntime(
      graphStatus,
      "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
      "The fresh graph observation could not be bound to an exact snapshot; grounding was skipped.",
    );
  }

  const canonicalDbPath = resolveContainedGraphDatabasePath(config.projectRoot, dbPath);
  if (!canonicalDbPath || canonicalDbPath !== freshObservation.canonicalDbPath) {
    return unavailableReadOnlyRuntime(
      graphStatus,
      "GRAPH_INDEX_READER_PATH_CHANGED",
      "The graph database path changed or escaped the project after status inspection; grounding was skipped.",
    );
  }
  let databaseIdentityBefore: string;
  try {
    databaseIdentityBefore = readDatabaseIdentity(canonicalDbPath);
  } catch {
    return unavailableReadOnlyRuntime(
      graphStatus,
      "GRAPH_INDEX_READER_PATH_CHANGED",
      "The graph database became unavailable after status inspection; grounding was skipped.",
    );
  }
  if (databaseIdentityBefore !== freshObservation.databaseIdentity) {
    return unavailableReadOnlyRuntime(
      graphStatus,
      "GRAPH_INDEX_READER_DATABASE_CHANGED",
      "The graph database changed after status inspection; grounding was skipped.",
    );
  }
  await internal?.afterDatabaseIdentityRead?.();
  const inspectSidecars = options.inspectSidecars ?? inspectGraphSidecars;
  const sidecarsBeforeOpen = inspectSidecars(canonicalDbPath);
  if (sidecarsBeforeOpen.state !== "clear") {
    return unavailableReadOnlyRuntime(
      graphStatus,
      "GRAPH_INDEX_READER_SIDECAR_ACTIVITY",
      sidecarMessage("before immutable readers opened", sidecarsBeforeOpen),
    );
  }

  // Immutable readers never create or consume SQLite sidecars. Graph facts and
  // fingerprints deliberately share one adopted connection, so atomic path
  // replacement cannot split one grounding runtime across two database inodes.
  let graph: GraphEngine | null = null;
  let pendingDb: SqliteDatabase | null = null;
  try {
    pendingDb = openGraphDatabase(canonicalDbPath, { readOnly: true, immutable: true });
    await internal?.afterDatabaseOpen?.(pendingDb);
    const sharedDb = pendingDb;
    graph = createGraphEngineFromOpenDatabase({
      rootDir: config.projectRoot,
      dbPath: canonicalDbPath,
    }, sharedDb);
    pendingDb = null;
    const fingerprints = new FingerprintStore(sharedDb);
    const snapshotIdentity = readRuntimeSnapshotIdentity(sharedDb);
    const snapshot = snapshotIdentity.snapshot;
    const indexedFiles = graph.getIndexedFiles?.();
    if (snapshotIdentity.snapshotRaw !== freshObservation.snapshotRaw
      || snapshotIdentity.snapshotHash !== freshObservation.snapshotHash
      || !snapshot
      || !snapshotMatchesStatus(snapshot, graphStatus)
      || !indexedFiles
      || !snapshotMatchesIndexedFiles(snapshot, indexedFiles)) {
      graph.close();
      graph = null;
      return unavailableReadOnlyRuntime(
        graphStatus,
        "GRAPH_INDEX_READER_SNAPSHOT_CHANGED",
        "The graph snapshot changed while immutable grounding readers were opening; grounding was skipped.",
      );
    }
    const anchorFingerprints = snapshotAnchorFingerprints(config, fingerprints);
    const resolvedAfterOpen = resolveContainedGraphDatabasePath(config.projectRoot, dbPath);
    const sidecarsAfterOpen = inspectSidecars(canonicalDbPath);
    let databaseIdentityAfter: string | null = null;
    try {
      databaseIdentityAfter = readDatabaseIdentity(canonicalDbPath);
    } catch {
      // The shared failure branch below closes both read facades.
    }
    const databaseChanged = databaseIdentityAfter !== freshObservation.databaseIdentity;
    if (resolvedAfterOpen !== canonicalDbPath
      || sidecarsAfterOpen.state !== "clear"
      || databaseChanged) {
      graph.close();
      graph = null;
      return unavailableReadOnlyRuntime(
        graphStatus,
        resolvedAfterOpen !== canonicalDbPath
          ? "GRAPH_INDEX_READER_PATH_CHANGED"
          : databaseChanged
            ? "GRAPH_INDEX_READER_DATABASE_CHANGED"
          : "GRAPH_INDEX_READER_SIDECAR_ACTIVITY",
        resolvedAfterOpen !== canonicalDbPath
          ? "The graph database path changed while immutable grounding readers were opening; grounding was skipped."
          : databaseChanged
            ? "The graph database changed while immutable grounding readers were opening; grounding was skipped."
          : sidecarMessage("after immutable readers opened", sidecarsAfterOpen),
      );
    }
    const guardedStatus: GraphStatus = {
      ...graphStatus,
      diagnostics: [...graphStatus.diagnostics],
    };
    const guard: GroundingRuntimeGuard = {
      validate: () => {
        try {
          return resolveContainedGraphDatabasePath(config.projectRoot, dbPath) === canonicalDbPath
            && inspectSidecars(canonicalDbPath).state === "clear"
            && readDatabaseIdentity(canonicalDbPath) === freshObservation.databaseIdentity;
        } catch {
          return false;
        }
      },
      invalidate: () => {
        if (guardedStatus.diagnostics.some((entry) => entry.code === "GRAPH_INDEX_READER_DATABASE_CHANGED")) {
          return;
        }
        guardedStatus.status = "degraded";
        guardedStatus.diagnostics = [
          ...guardedStatus.diagnostics,
          {
            code: "GRAPH_INDEX_READER_DATABASE_CHANGED",
            severity: "warning",
            message: "The graph changed while grounding checks were running; graph-derived results were discarded.",
            remediation: [{ label: "Retry after graph maintenance finishes" }],
          },
        ];
      },
    };
    return {
      graphStatus: guardedStatus,
      runtime: assembleGroundingRuntime(graph, null, fingerprints, anchorFingerprints, guard),
    };
  } catch {
    graph?.close();
    pendingDb?.close();
    return unavailableReadOnlyRuntime(
      graphStatus,
      "GRAPH_INDEX_READER_OPEN_FAILED",
      "The graph changed or became unavailable while immutable grounding readers were opening; grounding was skipped.",
    );
  }
}

function readDatabaseIdentity(dbPath: string): string {
  const stats = statSync(dbPath);
  return JSON.stringify([stats.dev, stats.ino, stats.size, stats.mtimeMs, stats.ctimeMs]);
}

function readRuntimeSnapshotIdentity(db: SqliteDatabase): {
  snapshotRaw: string | null;
  snapshotHash: string | null;
  snapshot: GraphSnapshot | null;
} {
  const row = db.prepare(
    "SELECT value FROM project_metadata WHERE key = ?",
  ).get(GRAPH_SNAPSHOT_METADATA_KEY) as { value?: unknown } | undefined;
  const snapshotRaw = typeof row?.value === "string" ? row.value : null;
  return {
    snapshotRaw,
    snapshotHash: snapshotRaw === null
      ? null
      : createHash("sha256").update(snapshotRaw).digest("hex"),
    snapshot: parseGraphSnapshot(snapshotRaw),
  };
}

function snapshotMatchesStatus(snapshot: GraphSnapshot, status: GraphStatus): boolean {
  return snapshot.indexedAt === status.indexedAt
    && snapshot.lastSuccessfulIndexAt === status.lastSuccessfulIndexAt
    && snapshot.indexedBranch === status.indexedBranch
    && snapshot.indexedHead === status.indexedHead
    && snapshot.schemaVersion === status.schemaVersion
    && snapshot.extractorVersion === status.extractorVersion
    && snapshot.grammarHash === status.grammarVersion
    && snapshot.parseHealth.total === status.parseHealth.total
    && snapshot.parseHealth.ok === status.parseHealth.ok
    && snapshot.parseHealth.partial === status.parseHealth.partial
    && snapshot.parseHealth.failed === status.parseHealth.failed;
}

function snapshotMatchesIndexedFiles(
  snapshot: GraphSnapshot,
  files: readonly IndexedFileInfo[],
): boolean {
  if (snapshot.sourceCount !== files.length
    || snapshot.sourceCorpusDigest !== computeSourceCorpusDigest(files)) return false;
  let ok = 0;
  let partial = 0;
  let failed = 0;
  for (const file of files) {
    if (file.parseStatus === "ok") ok += 1;
    else if (file.parseStatus === "partial") partial += 1;
    else failed += 1;
  }
  return snapshot.parseHealth.total === files.length
    && snapshot.parseHealth.ok === ok
    && snapshot.parseHealth.partial === partial
    && snapshot.parseHealth.failed === failed;
}

function unavailableReadOnlyRuntime(
  status: GraphStatus,
  code: string,
  message: string,
): ReadOnlyGroundingRuntimeResult {
  return {
    graphStatus: {
      ...status,
      status: "degraded",
      diagnostics: [
        ...status.diagnostics,
        {
          code,
          severity: "warning",
          message,
          remediation: [{ label: "Retry after graph maintenance finishes" }],
        },
      ],
    },
    runtime: null,
  };
}

function sidecarMessage(when: string, probe: GraphSidecarProbe): string {
  const paths = probe.paths.length > 0 ? ` (${probe.paths.join(", ")})` : "";
  return probe.state === "active"
    ? `SQLite recovery activity was detected ${when}${paths}; grounding was skipped.`
    : `SQLite recovery state could not be verified ${when}${paths}; grounding was skipped.`;
}

/**
 * Load and synchronize grounding state for explicitly mutating setup/sync
 * workflows. Ordinary reads must use {@link loadReadOnlyGroundingRuntime}.
 */
export async function loadGroundingRuntime(config: MexConfig): Promise<GroundingRuntime | null> {
  const dbPath = resolve(config.projectRoot, ".mex", "graph.db");
  if (!existsSync(dbPath)) return null;
  const graph = createGraphEngine({ rootDir: config.projectRoot, dbPath });
  let db: SqliteDatabase | null = null;
  try {
    db = openGraphDatabase(dbPath);
    const fingerprints = new FingerprintStore(db);
    const anchorFingerprints = snapshotAnchorFingerprints(config, fingerprints);
    // This is an explicitly mutating maintenance path. Rebuild from securely
    // staged bytes so source/config/semantic-input drift cannot be hidden by
    // restored mtimes, equal sizes, or an incomplete changed-file hint.
    await graph.build();
    return assembleGroundingRuntime(graph, db, fingerprints, anchorFingerprints);
  } catch (error) {
    graph.close();
    db?.close();
    throw error;
  }
}

/** Capture authored grounding against the current graph, shared by setup/migrate/sync. */
export async function captureGroundingBaselines(
  config: MexConfig,
  options: GroundingBaselineCaptureOptions = {},
): Promise<GroundingBaselineCaptureResult> {
  const runtime = await loadGroundingRuntime(config);
  if (!runtime) {
    options.warn?.("Code graph unavailable; grounding baselines were not captured.");
    return { captured: 0, skipped: 0 };
  }
  try {
    const scaffoldFiles = globSync("**/*.md", {
      cwd: config.scaffoldRoot,
      absolute: true,
      nodir: true,
    });
    return refreshGroundingBaselines(config, scaffoldFiles, runtime, {
      ...options,
      updateFingerprints: options.updateFingerprints ?? false,
    });
  } finally {
    runtime.close();
  }
}

/** Compare graph file metadata to disk; includes additions, edits, and deletions. */
export function findChangedSourceFiles(projectRoot: string, db: SqliteDatabase): string[] {
  const rows = db.prepare("SELECT path, size, modified_at FROM files").all() as Array<{
    path: string; size: number; modified_at: number;
  }>;
  const tracked = new Map(rows.map((row) => [row.path, row]));
  const current = globSync(GRAPH_SUPPORTED_SOURCE_GLOB, {
    ...GRAPH_CORPUS_GLOB_OPTIONS,
    cwd: projectRoot,
    ignore: [...GRAPH_CORPUS_IGNORE_GLOBS],
  })
    .map((path) => path.replaceAll("\\", "/"));
  const changed: string[] = [];
  for (const path of current) {
    const row = tracked.get(path);
    const stat = statSync(resolve(projectRoot, path));
    if (!row || row.size !== stat.size || row.modified_at !== stat.mtimeMs) changed.push(path);
    tracked.delete(path);
  }
  changed.push(...tracked.keys());
  return [...new Set(changed)].sort();
}

/** Persist only high-confidence MOVED repairs. AMBIGUOUS/GONE remain for the agent. */
export function persistMovedGroundings(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
): number {
  let moved = 0;
  for (const filePath of scaffoldFiles) {
    const content = readFileSync(filePath, "utf-8");
    const groundings = extractGroundings(content);
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    for (const grounding of groundings) {
      const aliasedNode = runtime.graph.getNode(grounding.node);
      if (aliasedNode) {
        if (aliasedNode.id === grounding.node) continue;
        const oldId = grounding.node;
        grounding.node = aliasedNode.id;
        const fingerprint = runtime.reconciler.getFingerprint(aliasedNode.id);
        if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
        saveCurrentBaseline(config, scaffoldFile, grounding.node, grounding.fingerprint, runtime);
        runtime.fingerprints.deleteGroundedSource(scaffoldFile, oldId);
        dirty = true;
        moved += 1;
        continue;
      }
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, grounding.node);
      const baseline = deserializeFingerprint(grounding.fingerprint)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(grounding.node, baseline);
      if (resolution.kind !== "MOVED") continue;
      const oldId = grounding.node;
      grounding.node = resolution.nodeId;
      const fingerprint = runtime.reconciler.getFingerprint(resolution.nodeId);
      if (fingerprint) grounding.fingerprint = serializeFingerprint(fingerprint);
      saveCurrentBaseline(config, scaffoldFile, grounding.node, grounding.fingerprint, runtime);
      runtime.fingerprints.deleteGroundedSource(scaffoldFile, oldId);
      dirty = true;
      moved += 1;
    }
    const groundedContent = dirty ? writeGroundings(content, groundings) : content;
    let anchoredContent = groundedContent;
    const anchors = findMexAnchors(anchoredContent);
    for (const anchor of [...anchors].reverse()) {
      const aliasedNode = runtime.graph.getNode(anchor.nodeId);
      if (aliasedNode) {
        if (aliasedNode.id === anchor.nodeId) continue;
        anchoredContent = rewriteMexAnchor(anchoredContent, anchor, aliasedNode.id);
        moved += 1;
        continue;
      }
      const baselineSource = runtime.reconciler.getGroundedSource(scaffoldFile, anchor.nodeId);
      const baseline = runtime.anchorFingerprints.get(anchor.nodeId)
        ?? (baselineSource ? deserializeFingerprint(baselineSource.fingerprint) : null);
      if (!baseline) continue;
      const resolution = runtime.reconciler.reconcile(anchor.nodeId, baseline);
      if (resolution.kind !== "MOVED") continue;
      anchoredContent = rewriteMexAnchor(anchoredContent, anchor, resolution.nodeId);
      moved += 1;
    }
    if (anchoredContent !== content) writeFileSync(filePath, anchoredContent, "utf-8");
  }
  return moved;
}

interface GroundingReconcilerCapabilities {
  getGroundedSource(scaffoldFile: string, nodeId: string): GroundedSource | null;
  getFingerprint(nodeId: string): Fingerprint | null;
}

interface GroundingRuntimeGuard {
  validate(): boolean;
  invalidate(): void;
}

function assembleGroundingRuntime(
  graph: GraphEngine,
  database: SqliteDatabase | null,
  fingerprints: FingerprintStore,
  anchorFingerprints: ReadonlyMap<string, Fingerprint>,
  guard?: GroundingRuntimeGuard,
): GroundingRuntime {
  const reconciler = new MinHashReconciler(fingerprints);
  const checkerReconciler: Reconciler & GroundingReconcilerCapabilities = {
    reconcile: (nodeId, baseline) => reconciler.reconcile(nodeId, baseline),
    getFingerprint: (nodeId) => anchorFingerprints.get(nodeId) ?? reconciler.getFingerprint(nodeId),
    getGroundedSource: (file, nodeId) => reconciler.getGroundedSource(file, nodeId),
  };
  const rawChecker = createGroundingChecker(graph, checkerReconciler);
  const checker: GroundingChecker = guard
    ? (...args) => {
        if (!guard.validate()) {
          guard.invalidate();
          return [];
        }
        let issues;
        try {
          issues = rawChecker(...args);
        } catch (error) {
          if (!guard.validate()) {
            guard.invalidate();
            return [];
          }
          throw error;
        }
        if (!guard.validate()) {
          guard.invalidate();
          return [];
        }
        return issues;
      }
    : rawChecker;
  let db: SqliteDatabase | null = database;
  return {
    graph,
    reconciler,
    checker,
    fingerprints,
    anchorFingerprints,
    close: () => { graph.close(); db?.close(); db = null; },
  };
}

function snapshotAnchorFingerprints(config: MexConfig, store: FingerprintStore): Map<string, Fingerprint> {
  const snapshots = new Map<string, Fingerprint>();
  const files = [
    ...globSync("**/*.md", { cwd: config.scaffoldRoot, absolute: true, nodir: true }),
    ...["CLAUDE.md", ".cursorrules", ".windsurfrules"]
      .map((file) => resolve(config.projectRoot, file))
      .filter(existsSync),
  ];
  for (const file of files) {
    let content: string;
    try { content = readFileSync(file, "utf-8"); } catch { continue; }
    for (const anchor of findMexAnchors(content)) {
      const fingerprint = store.get(anchor.nodeId);
      if (fingerprint) snapshots.set(anchor.nodeId, fingerprint);
    }
  }
  return snapshots;
}

/** Close the sync loop after an agent pass by refreshing ids' fingerprints and snapshots. */
export function refreshGroundingBaselines(
  config: MexConfig,
  scaffoldFiles: readonly string[],
  runtime: GroundingRuntime,
  options: GroundingBaselineCaptureOptions = {},
): GroundingBaselineCaptureResult {
  let captured = 0;
  let skipped = 0;
  for (const filePath of scaffoldFiles) {
    const content = readFileSync(filePath, "utf-8");
    const groundings = extractGroundings(content);
    const anchors = findMexAnchors(content);
    if (groundings.length === 0 && anchors.length === 0) continue;
    const scaffoldFile = relative(config.projectRoot, filePath).replaceAll("\\", "/");
    let dirty = false;
    const groundingByNode = new Map(groundings.map((grounding) => [grounding.node, grounding]));
    const nodeIds = new Set([
      ...groundingByNode.keys(),
      ...anchors.map((anchor) => anchor.nodeId),
    ]);
    for (const nodeId of nodeIds) {
      const grounding = groundingByNode.get(nodeId);
      const fingerprint = runtime.reconciler.getFingerprint(nodeId);
      if (!fingerprint || !runtime.graph.getNode(nodeId)) {
        skipped += 1;
        options.warn?.(`Skipped grounding baseline for unavailable node ${nodeId} in ${scaffoldFile}.`);
        continue;
      }
      const serialized = serializeFingerprint(fingerprint);
      if (grounding && grounding.fingerprint !== serialized) {
        if (options.updateFingerprints === false) {
          skipped += 1;
          options.warn?.(`Skipped grounding baseline for changed node ${nodeId} in ${scaffoldFile}.`);
          continue;
        }
        grounding.fingerprint = serialized;
        dirty = true;
      }
      if (saveCurrentBaseline(config, scaffoldFile, nodeId, serialized, runtime)) {
        captured += 1;
      } else {
        skipped += 1;
        options.warn?.(`Skipped grounding baseline for non-body node ${nodeId} in ${scaffoldFile}.`);
      }
    }
    if (dirty) writeFileSync(filePath, writeGroundings(content, groundings), "utf-8");
  }
  return { captured, skipped };
}

export function groundingPromptContext(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  runtime: GroundingRuntime,
  candidateId?: string,
): { nodeId: string; oldBody: string; newBody: string; candidateId?: string } | null {
  const baseline = runtime.reconciler.getGroundedSource(scaffoldFile, nodeId);
  const current = runtime.graph.getNode(candidateId ?? nodeId);
  if (!baseline || !current) return null;
  return {
    nodeId,
    oldBody: baseline.source,
    newBody: readNodeBody(config.projectRoot, current.filePath, current.startLine, current.endLine),
    candidateId,
  };
}

function saveCurrentBaseline(
  config: MexConfig,
  scaffoldFile: string,
  nodeId: string,
  fingerprint: string,
  runtime: GroundingRuntime,
): boolean {
  const node = runtime.graph.getNode(nodeId);
  if (!node?.bodyHash) return false;
  const source: GroundedSource = {
    scaffoldFile,
    nodeId: node.id,
    source: readNodeBody(config.projectRoot, node.filePath, node.startLine, node.endLine),
    bodyHash: node.bodyHash,
    fingerprint,
  };
  runtime.fingerprints.saveGroundedSource(source);
  return true;
}

function readNodeBody(root: string, filePath: string, startLine: number, endLine: number): string {
  return readFileSync(resolve(root, filePath), "utf-8").split("\n").slice(startLine - 1, endLine).join("\n");
}
