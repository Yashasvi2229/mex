import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { createRequire } from "node:module";
import type { DatabaseSync as NodeDatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import {
  HUB_JOB_INTERRUPTION_REASONS,
  HUB_JOB_KINDS,
  HUB_JOB_PHASES,
  HUB_JOB_PROGRESS_PHASES,
} from "../../hub/jobs/types.js";
import type {
  HubJobInterruptionReason,
  HubJobKind,
  HubJobListRequest,
  HubJobPage,
  HubJobPhase,
  HubJobProblem,
  HubJobProgress,
  HubJobSnapshot,
} from "../../hub/jobs/types.js";
import type { ActorRef, Revision } from "../contracts/shared.js";
import { isRevision, JOB_STATES, MexPortError } from "../contracts/shared.js";
import type { CatchUpCursor } from "../contracts/workflow.js";

const { DatabaseSync } = createRequire(import.meta.url)("node:sqlite") as {
  DatabaseSync: typeof import("node:sqlite").DatabaseSync;
};
type DatabaseSync = NodeDatabaseSync;

const LOCAL_STATE_SCHEMA_VERSION = 3 as const;
const LOCAL_STATE_RECORD_REVISION_VERSION = 1 as const;
const LOCAL_STATE_RELATIVE_PATH = ".mex/local/team.db";
const MEMBER_ID = /^member_[0-9A-HJKMNP-TV-Z]{26}$/;
const HUB_JOB_ID = /^job_[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;
const MAX_JOB_PROBLEM_JSON_BYTES = 4_096;
const DEFAULT_JOB_PAGE_SIZE = 25;
const MAX_JOB_PAGE_SIZE = 100;
const TERMINAL_JOB_RETENTION = 200;
const HUB_LEASE_TOKEN = /^[a-f0-9]{64}$/;

const HUB_JOB_SELECT_COLUMNS = `
  id, scaffold_id, kind, generation, phase,
  progress_completed, progress_total, progress_message, cancel_requested,
  state, created_at, started_at, finished_at, interrupted_reason,
  problem_json, summary, revision
`;

const V1_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS local_state_schema (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    applied_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS configured_member_selections (
    scaffold_id TEXT NOT NULL PRIMARY KEY,
    member_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    revision TEXT NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS catch_up_cursors (
    scaffold_id TEXT NOT NULL,
    actor_key TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    head TEXT,
    branch TEXT,
    timestamp TEXT NOT NULL,
    revision TEXT NOT NULL,
    PRIMARY KEY (scaffold_id, actor_key)
  ) STRICT;
`;

const V2_SCHEMA_SQL = `
  CREATE TABLE hub_runtime_lease (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid >= 1),
    token TEXT NOT NULL CHECK (length(token) = 64),
    acquired_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE hub_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    scaffold_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('graph_refresh', 'graph_rebuild', 'wiki_refresh', 'wiki_rebuild')),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    phase TEXT NOT NULL CHECK (
      phase IN ('queued', 'running', 'refreshing', 'rebuilding', 'finalizing', 'complete', 'failed', 'interrupted')
    ),
    progress_completed INTEGER CHECK (progress_completed IS NULL OR progress_completed >= 0),
    progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 1),
    progress_message TEXT CHECK (progress_message IS NULL),
    cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    interrupted_reason TEXT CHECK (
      interrupted_reason IS NULL
      OR interrupted_reason IN ('user_cancelled', 'process_restart', 'process_shutdown')
    ),
    problem_json TEXT CHECK (problem_json IS NULL OR length(CAST(problem_json AS BLOB)) <= ${MAX_JOB_PROBLEM_JSON_BYTES}),
    summary TEXT CHECK (summary IS NULL),
    revision TEXT NOT NULL,
    CHECK (
      (progress_completed IS NULL AND progress_total IS NULL AND progress_message IS NULL)
      OR progress_completed IS NOT NULL
    ),
    CHECK (progress_total IS NULL OR progress_completed <= progress_total),
    CHECK (state <> 'running' OR started_at IS NOT NULL),
    CHECK (state IN ('queued', 'running') OR finished_at IS NOT NULL),
    CHECK (state <> 'interrupted' OR interrupted_reason IS NOT NULL)
  ) STRICT;

  CREATE UNIQUE INDEX hub_jobs_one_active_index_job_per_scaffold
    ON hub_jobs (scaffold_id)
    WHERE state IN ('queued', 'running');

  CREATE UNIQUE INDEX hub_jobs_generation_per_kind
    ON hub_jobs (scaffold_id, kind, generation);

  CREATE INDEX hub_jobs_scaffold_created
    ON hub_jobs (scaffold_id, created_at DESC, id DESC);
`;

const V3_SCHEMA_SQL = `
  CREATE TABLE hub_runtime_lease (
    singleton INTEGER NOT NULL PRIMARY KEY CHECK (singleton = 1),
    pid INTEGER NOT NULL CHECK (pid >= 1),
    token TEXT NOT NULL CHECK (length(token) = 64),
    acquired_at TEXT NOT NULL
  ) STRICT;

  CREATE TABLE hub_jobs (
    id TEXT NOT NULL PRIMARY KEY,
    scaffold_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('graph_refresh', 'graph_rebuild', 'wiki_refresh', 'wiki_rebuild')),
    generation INTEGER NOT NULL CHECK (generation >= 1),
    phase TEXT NOT NULL CHECK (
      phase IN (
        'queued', 'running', 'refreshing', 'rebuilding', 'finalizing',
        'discover', 'stage', 'parse', 'resolve', 'validate', 'publish',
        'complete', 'failed', 'interrupted'
      )
    ),
    progress_completed INTEGER CHECK (progress_completed IS NULL OR progress_completed >= 0),
    progress_total INTEGER CHECK (progress_total IS NULL OR progress_total >= 1),
    progress_message TEXT CHECK (progress_message IS NULL),
    cancel_requested INTEGER NOT NULL CHECK (cancel_requested IN (0, 1)),
    state TEXT NOT NULL CHECK (state IN ('queued', 'running', 'succeeded', 'failed', 'interrupted')),
    created_at TEXT NOT NULL,
    started_at TEXT,
    finished_at TEXT,
    interrupted_reason TEXT CHECK (
      interrupted_reason IS NULL
      OR interrupted_reason IN ('user_cancelled', 'process_restart', 'process_shutdown')
    ),
    problem_json TEXT CHECK (problem_json IS NULL OR length(CAST(problem_json AS BLOB)) <= ${MAX_JOB_PROBLEM_JSON_BYTES}),
    summary TEXT CHECK (summary IS NULL),
    revision TEXT NOT NULL,
    CHECK (
      (progress_completed IS NULL AND progress_total IS NULL AND progress_message IS NULL)
      OR progress_completed IS NOT NULL
    ),
    CHECK (progress_total IS NULL OR progress_completed <= progress_total),
    CHECK (state <> 'running' OR started_at IS NOT NULL),
    CHECK (state IN ('queued', 'running') OR finished_at IS NOT NULL),
    CHECK (state <> 'interrupted' OR interrupted_reason IS NOT NULL)
  ) STRICT;

  CREATE UNIQUE INDEX hub_jobs_one_active_index_job_per_scaffold
    ON hub_jobs (scaffold_id)
    WHERE state IN ('queued', 'running');

  CREATE UNIQUE INDEX hub_jobs_generation_per_kind
    ON hub_jobs (scaffold_id, kind, generation);

  CREATE INDEX hub_jobs_scaffold_created
    ON hub_jobs (scaffold_id, created_at DESC, id DESC);
`;

const EXPECTED_V1_TABLES = {
  local_state_schema: [
    { name: "singleton", type: "INTEGER", notNull: 1, primaryKeyPosition: 1 },
    { name: "version", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
    { name: "applied_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  ],
  configured_member_selections: [
    { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
    { name: "member_id", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "updated_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  ],
  catch_up_cursors: [
    { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
    { name: "actor_key", type: "TEXT", notNull: 1, primaryKeyPosition: 2 },
    { name: "actor_json", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "head", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
    { name: "branch", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
    { name: "timestamp", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
    { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  ],
} as const;

const EXPECTED_HUB_JOB_COLUMNS = [
  { name: "id", type: "TEXT", notNull: 1, primaryKeyPosition: 1 },
  { name: "scaffold_id", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "kind", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "generation", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "phase", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "progress_completed", type: "INTEGER", notNull: 0, primaryKeyPosition: 0 },
  { name: "progress_total", type: "INTEGER", notNull: 0, primaryKeyPosition: 0 },
  { name: "progress_message", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "cancel_requested", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "state", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "created_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "started_at", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "finished_at", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "interrupted_reason", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "problem_json", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "summary", type: "TEXT", notNull: 0, primaryKeyPosition: 0 },
  { name: "revision", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

const EXPECTED_HUB_LEASE_COLUMNS = [
  { name: "singleton", type: "INTEGER", notNull: 1, primaryKeyPosition: 1 },
  { name: "pid", type: "INTEGER", notNull: 1, primaryKeyPosition: 0 },
  { name: "token", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
  { name: "acquired_at", type: "TEXT", notNull: 1, primaryKeyPosition: 0 },
] as const;

type V1LocalStateTable = keyof typeof EXPECTED_V1_TABLES;
type LocalStateTable = V1LocalStateTable | "hub_jobs" | "hub_runtime_lease";

interface DatabaseFileIdentity {
  device: bigint;
  inode: bigint;
  size: bigint;
  modifiedAt: bigint;
  changedAt: bigint;
}

interface ConfiguredMemberRow {
  scaffold_id: unknown;
  member_id: unknown;
  updated_at: unknown;
  revision: unknown;
}

interface CatchUpCursorRow {
  scaffold_id: unknown;
  actor_key: unknown;
  actor_json: unknown;
  head: unknown;
  branch: unknown;
  timestamp: unknown;
  revision: unknown;
}

interface HubJobRow {
  id: unknown;
  scaffold_id: unknown;
  kind: unknown;
  generation: unknown;
  phase: unknown;
  progress_completed: unknown;
  progress_total: unknown;
  progress_message: unknown;
  cancel_requested: unknown;
  state: unknown;
  created_at: unknown;
  started_at: unknown;
  finished_at: unknown;
  interrupted_reason: unknown;
  problem_json: unknown;
  summary: unknown;
  revision: unknown;
}

interface HubLeaseRow {
  singleton: unknown;
  pid: unknown;
  token: unknown;
  acquired_at: unknown;
}

export interface ConfiguredMemberSelection {
  scaffoldId: string;
  memberId: string;
  updatedAt: string;
  revision: Revision;
}

export interface ConfigureMemberRequest {
  memberId: string;
  expectedRevision: Revision | null;
  updatedAt?: string;
}

export interface ClearConfiguredMemberRequest {
  expectedRevision: Revision;
}

/** Internal cursor projection. The provisional shared contract does not yet carry branch. */
export interface StoredCatchUpCursor extends CatchUpCursor {
  branch: string | null;
}

export interface WriteCatchUpCursorRequest {
  actor: ActorRef;
  head: string | null;
  branch: string | null;
  expectedRevision: Revision | null;
  timestamp?: string;
}

export interface TeamLocalStateOptions {
  projectRoot: string;
  scaffoldId: string;
  now?: () => string;
  processStatus?: (pid: number) => HubLeaseProcessStatus;
}

export type HubLeaseProcessStatus = "alive" | "dead" | "ambiguous";

export interface HubJobLease {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface AcquireHubJobLeaseRequest {
  pid: number;
  token: string;
  acquiredAt: string;
}

export interface CreateHubJobRecordRequest {
  leaseToken: string;
  id: string;
  kind: HubJobKind;
  phase: HubJobPhase;
  createdAt: string;
}

export interface UpdateHubJobRecordRequest {
  leaseToken: string;
  id: string;
  generation: number;
  expectedRevision: Revision;
  phase: HubJobPhase;
  progress: HubJobProgress | null;
  cancelRequested: boolean;
  state: HubJobSnapshot["state"];
  startedAt?: string;
  finishedAt?: string;
  interruptedReason?: HubJobInterruptionReason;
  problem?: HubJobProblem;
}

export interface ReconcileHubJobsResult {
  interrupted: readonly HubJobSnapshot[];
  pruned: number;
}

/**
 * Schema-versioned, repository-local state for team identity and Catch Up.
 *
 * Every read is side-effect free: a missing database is represented as absent
 * state, while an old schema asks the caller to perform an explicit write-side
 * migration. All mutations use BEGIN IMMEDIATE and exact optimistic revisions.
 */
export class TeamLocalState {
  readonly databasePath: string;

  private readonly projectRoot: string;
  private readonly scaffoldId: string;
  private readonly now: () => string;
  private readonly processStatus: (pid: number) => HubLeaseProcessStatus;

  constructor(options: TeamLocalStateOptions) {
    this.projectRoot = canonicalProjectRoot(options.projectRoot);
    this.scaffoldId = validateScaffoldId(options.scaffoldId);
    this.databasePath = join(this.projectRoot, LOCAL_STATE_RELATIVE_PATH);
    this.now = options.now ?? (() => new Date().toISOString());
    this.processStatus = options.processStatus ?? probeProcessStatus;
  }

  getConfiguredMember(): ConfiguredMemberSelection | null {
    return this.read((db) => {
      const row = db.prepare(`
        SELECT scaffold_id, member_id, updated_at, revision
        FROM configured_member_selections
        WHERE scaffold_id = ?
      `).get(this.scaffoldId) as ConfiguredMemberRow | undefined;
      return row ? decodeConfiguredMember(row, this.scaffoldId) : null;
    });
  }

  configureMember(request: ConfigureMemberRequest): ConfiguredMemberSelection {
    const memberId = validateMemberId(request.memberId);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const updatedAt = validateTimestamp(request.updatedAt ?? this.now(), "updatedAt");
    this.assertExistingRevisionCanMatch(expectedRevision, "configured member");

    return this.write((db) => {
      const current = readConfiguredMember(db, this.scaffoldId);
      assertExpectedRevision(current?.revision ?? null, expectedRevision, "configured member");

      const selection: ConfiguredMemberSelection = {
        scaffoldId: this.scaffoldId,
        memberId,
        updatedAt,
        revision: configuredMemberRevision(this.scaffoldId, memberId, updatedAt),
      };
      db.prepare(`
        INSERT INTO configured_member_selections (
          scaffold_id, member_id, updated_at, revision
        ) VALUES (?, ?, ?, ?)
        ON CONFLICT(scaffold_id) DO UPDATE SET
          member_id = excluded.member_id,
          updated_at = excluded.updated_at,
          revision = excluded.revision
      `).run(
        selection.scaffoldId,
        selection.memberId,
        selection.updatedAt,
        selection.revision,
      );
      return selection;
    });
  }

  clearConfiguredMember(request: ClearConfiguredMemberRequest): void {
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    if (expectedRevision === null) {
      throw validationError("Clearing a configured member requires its current revision.");
    }
    this.assertExistingRevisionCanMatch(expectedRevision, "configured member");

    this.write((db) => {
      const current = readConfiguredMember(db, this.scaffoldId);
      assertExpectedRevision(current?.revision ?? null, expectedRevision, "configured member");
      db.prepare(
        "DELETE FROM configured_member_selections WHERE scaffold_id = ?",
      ).run(this.scaffoldId);
    });
  }

  getCatchUpCursor(actor: ActorRef): StoredCatchUpCursor | null {
    const actorKey = canonicalActorKey(actor);
    if (actorKey === null) return null;

    return this.read((db) => {
      const row = db.prepare(`
        SELECT scaffold_id, actor_key, actor_json, head, branch, timestamp, revision
        FROM catch_up_cursors
        WHERE scaffold_id = ? AND actor_key = ?
      `).get(this.scaffoldId, actorKey) as CatchUpCursorRow | undefined;
      return row ? decodeCatchUpCursor(row, this.scaffoldId, actorKey) : null;
    });
  }

  /** Mark on the current branch. A branch change must use resetCatchUpCursor. */
  markCatchUpCursor(request: WriteCatchUpCursorRequest): StoredCatchUpCursor {
    return this.writeCursor(request, false);
  }

  /** Explicitly confirms replacement of a cursor, including across branches. */
  resetCatchUpCursor(request: WriteCatchUpCursorRequest): StoredCatchUpCursor {
    return this.writeCursor(request, true);
  }

  /** Explicit write-side initialization/migration used by `mex hub` startup. */
  initializeHubState(): void {
    this.write(() => undefined);
  }

  /** Acquire the repository-singleton Hub job lease before reconciliation. */
  acquireHubJobLease(request: AcquireHubJobLeaseRequest): HubJobLease {
    const pid = requireSafeInteger(request.pid, "lease pid", 1);
    const token = validateLeaseToken(request.token);
    const acquiredAt = validateTimestamp(request.acquiredAt, "lease acquiredAt");
    return this.write((db) => {
      const current = readHubJobLease(db);
      if (current?.pid === pid && current.token === token) return current;
      if (current) {
        const status = safeProcessStatus(this.processStatus, current.pid);
        if (status !== "dead") throw hubLeaseHeldError(current.pid, status);
        const replaced = db.prepare(`
          UPDATE hub_runtime_lease
          SET pid = ?, token = ?, acquired_at = ?
          WHERE singleton = 1 AND pid = ? AND token = ?
        `).run(pid, token, acquiredAt, current.pid, current.token);
        if (Number(replaced.changes) !== 1) {
          throw revisionConflict("The Hub job lease changed during dead-holder recovery.");
        }
      } else {
        db.prepare(`
          INSERT INTO hub_runtime_lease (singleton, pid, token, acquired_at)
          VALUES (1, ?, ?, ?)
        `).run(pid, token, acquiredAt);
      }
      return { pid, token, acquiredAt };
    });
  }

  /** Token-checked release. Call only after every executor has settled. */
  releaseHubJobLease(token: string): void {
    const leaseToken = validateLeaseToken(token);
    this.write((db) => {
      const current = readHubJobLease(db);
      if (!current || current.token !== leaseToken) {
        throw revisionConflict("The Hub job lease is absent or belongs to another process.");
      }
      const activeCountRow = db.prepare(`
        SELECT COUNT(*) AS count
        FROM hub_jobs
        WHERE state IN ('queued', 'running')
      `).get() as { count: unknown };
      const activeCount = sqliteInteger(activeCountRow.count);
      if (activeCount === null || activeCount < 0) {
        throw corruptError("The Hub job active-row count is invalid.");
      }
      if (activeCount > 0) {
        throw revisionConflict("The Hub job lease cannot be released while a job is active.");
      }
      const deleted = db.prepare(`
        DELETE FROM hub_runtime_lease
        WHERE singleton = 1 AND token = ?
      `).run(leaseToken);
      if (Number(deleted.changes) !== 1) {
        throw revisionConflict("The Hub job lease changed before release.");
      }
    });
  }

  listHubJobs(request: HubJobListRequest = {}): HubJobPage {
    const limit = validateJobPageLimit(request.limit);
    const cursor = decodeJobCursor(request.cursor);
    return this.read((db) => {
      const rows = cursor === null
        ? db.prepare(`
            SELECT ${HUB_JOB_SELECT_COLUMNS}
            FROM hub_jobs
            WHERE scaffold_id = ?
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).all(this.scaffoldId, limit + 1) as unknown as HubJobRow[]
        : db.prepare(`
            SELECT ${HUB_JOB_SELECT_COLUMNS}
            FROM hub_jobs
            WHERE scaffold_id = ?
              AND (created_at < ? OR (created_at = ? AND id < ?))
            ORDER BY created_at DESC, id DESC
            LIMIT ?
          `).all(
            this.scaffoldId,
            cursor.createdAt,
            cursor.createdAt,
            cursor.id,
            limit + 1,
          ) as unknown as HubJobRow[];
      const decoded = rows.map((row) => decodeHubJob(row, this.scaffoldId));
      const hasMore = decoded.length > limit;
      const items = hasMore ? decoded.slice(0, limit) : decoded;
      const last = items.at(-1);
      return {
        items,
        ...(hasMore && last
          ? { nextCursor: encodeJobCursor(last.createdAt, last.id) }
          : {}),
      };
    }) ?? { items: [] };
  }

  getHubJob(id: string): HubJobSnapshot | null {
    const jobId = validateHubJobId(id);
    return this.read((db) => readHubJob(db, this.scaffoldId, jobId));
  }

  getActiveHubJob(): HubJobSnapshot | null {
    return this.read((db) => readActiveHubJob(db, this.scaffoldId));
  }

  createHubJobRecord(request: CreateHubJobRecordRequest): HubJobSnapshot {
    const leaseToken = validateLeaseToken(request.leaseToken);
    const id = validateHubJobId(request.id);
    const kind = validateHubJobKind(request.kind);
    const phase = validateJobPhase(request.phase);
    const createdAt = validateTimestamp(request.createdAt, "createdAt");

    return this.write((db) => {
      assertHubJobLease(db, leaseToken);
      const active = readActiveHubJob(db, this.scaffoldId);
      if (active) throw jobAlreadyRunningError(active.id);

      const generationRow = db.prepare(`
        SELECT MAX(generation) AS generation
        FROM hub_jobs
        WHERE scaffold_id = ? AND kind = ?
      `).get(this.scaffoldId, kind) as { generation: unknown };
      const priorGeneration = generationRow.generation === null
        ? 0
        : requireSafeInteger(generationRow.generation, "Hub job generation", 1);
      const generation = priorGeneration + 1;
      if (!Number.isSafeInteger(generation)) {
        throw corruptError("Hub job generation is exhausted.");
      }

      const draft: Omit<HubJobSnapshot, "revision"> = {
        id,
        scaffoldId: this.scaffoldId,
        kind,
        generation,
        phase,
        progress: null,
        cancelRequested: false,
        state: "queued",
        createdAt,
      };
      validateJobLifecycle(draft);
      const job: HubJobSnapshot = {
        ...draft,
        revision: hubJobRevision(draft),
      };
      insertHubJob(db, job);
      return job;
    });
  }

  updateHubJobRecord(request: UpdateHubJobRecordRequest): HubJobSnapshot {
    const leaseToken = validateLeaseToken(request.leaseToken);
    const id = validateHubJobId(request.id);
    const generation = requireSafeInteger(request.generation, "generation", 1);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    if (expectedRevision === null) {
      throw validationError("Updating a Hub job requires its current revision.");
    }
    const phase = validateJobPhase(request.phase);
    const progress = validateJobProgress(request.progress);
    const cancelRequested = validateBoolean(request.cancelRequested, "cancelRequested");
    const state = validateJobState(request.state);
    const startedAt = optionalTimestamp(request.startedAt, "startedAt");
    const finishedAt = optionalTimestamp(request.finishedAt, "finishedAt");
    const interruptedReason = validateInterruptionReason(request.interruptedReason);
    const problem = validateJobProblem(request.problem);

    return this.write((db) => {
      assertHubJobLease(db, leaseToken);
      const current = readHubJob(db, this.scaffoldId, id);
      if (!current) throw jobNotFoundError(id);
      if (current.generation !== generation) {
        throw revisionConflict("The Hub job generation changed; discard the stale update.");
      }
      assertExpectedRevision(current.revision, expectedRevision, "Hub job");
      assertJobTransition(current, state, progress, startedAt, cancelRequested);

      const draft: Omit<HubJobSnapshot, "revision"> = {
        id: current.id,
        scaffoldId: current.scaffoldId,
        kind: current.kind,
        generation: current.generation,
        phase,
        progress,
        cancelRequested,
        state,
        createdAt: current.createdAt,
        ...(startedAt === undefined ? {} : { startedAt }),
        ...(finishedAt === undefined ? {} : { finishedAt }),
        ...(interruptedReason === undefined ? {} : { interruptedReason }),
        ...(problem === undefined ? {} : { problem }),
      };
      validateJobLifecycle(draft);
      const job: HubJobSnapshot = {
        ...draft,
        revision: hubJobRevision(draft),
      };
      replaceHubJob(db, job, expectedRevision);
      if (isTerminalJobState(job.state)) pruneTerminalHubJobs(db, this.scaffoldId);
      return job;
    });
  }

  reconcileHubJobs(finishedAt: string, leaseTokenValue: string): ReconcileHubJobsResult {
    const timestamp = validateTimestamp(finishedAt, "finishedAt");
    const leaseToken = validateLeaseToken(leaseTokenValue);
    return this.write((db) => {
      assertHubJobLease(db, leaseToken);
      const activeRows = db.prepare(`
        SELECT ${HUB_JOB_SELECT_COLUMNS}
        FROM hub_jobs
        WHERE state IN ('queued', 'running')
        ORDER BY scaffold_id ASC, created_at ASC, id ASC
      `).all() as unknown as HubJobRow[];
      const touchedScaffolds = new Set<string>([this.scaffoldId]);
      const interrupted = activeRows.map((row) => {
        const scaffoldId = validateStoredScaffoldId(row.scaffold_id);
        touchedScaffolds.add(scaffoldId);
        const current = decodeHubJob(row, scaffoldId);
        const draft: Omit<HubJobSnapshot, "revision"> = {
          ...withoutRevision(current),
          phase: "interrupted",
          state: "interrupted",
          finishedAt: timestamp,
          interruptedReason: "process_restart",
        };
        validateJobLifecycle(draft);
        const job: HubJobSnapshot = {
          ...draft,
          revision: hubJobRevision(draft),
        };
        replaceHubJob(db, job, current.revision);
        return job;
      });
      let pruned = 0;
      for (const scaffoldId of touchedScaffolds) {
        pruned += pruneTerminalHubJobs(db, scaffoldId);
      }
      return { interrupted, pruned };
    });
  }

  private writeCursor(
    request: WriteCatchUpCursorRequest,
    allowBranchChange: boolean,
  ): StoredCatchUpCursor {
    const actor = normalizeWritableActor(request.actor);
    const actorKey = canonicalActorKey(actor);
    if (actorKey === null) {
      throw validationError("Unknown actors cannot mark or reset a Catch Up cursor.");
    }
    const head = validateHead(request.head);
    const branch = validateBranch(request.branch);
    const expectedRevision = validateExpectedRevision(request.expectedRevision);
    const timestamp = validateTimestamp(request.timestamp ?? this.now(), "timestamp");
    this.assertExistingRevisionCanMatch(expectedRevision, "Catch Up cursor");

    return this.write((db) => {
      const current = readCatchUpCursor(db, this.scaffoldId, actorKey);
      if (current && !allowBranchChange && current.branch !== branch) {
        throw revisionConflict(
          `Catch Up cursor belongs to ${describeBranch(current.branch)}; `
            + `explicitly reset it before using ${describeBranch(branch)}.`,
        );
      }
      assertExpectedRevision(current?.revision ?? null, expectedRevision, "Catch Up cursor");

      const cursor: StoredCatchUpCursor = {
        scaffoldId: this.scaffoldId,
        actor,
        head,
        branch,
        timestamp,
        revision: cursorRevision({
          scaffoldId: this.scaffoldId,
          actor,
          head,
          branch,
          timestamp,
        }),
      };
      db.prepare(`
        INSERT INTO catch_up_cursors (
          scaffold_id, actor_key, actor_json, head, branch, timestamp, revision
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scaffold_id, actor_key) DO UPDATE SET
          actor_json = excluded.actor_json,
          head = excluded.head,
          branch = excluded.branch,
          timestamp = excluded.timestamp,
          revision = excluded.revision
      `).run(
        cursor.scaffoldId,
        actorKey,
        canonicalActorJson(actor),
        cursor.head,
        cursor.branch,
        cursor.timestamp,
        cursor.revision,
      );
      return cursor;
    });
  }

  private read<T>(operation: (db: DatabaseSync) => T): T | null {
    this.assertDatabasePathSafe();
    const observedIdentity = beginImmutableObservation(this.databasePath);
    if (observedIdentity === null) return null;

    let db: DatabaseSync | undefined;
    let result: T | undefined;
    let operationError: unknown;
    try {
      const location = `${pathToFileURL(this.databasePath).href}?mode=ro&immutable=1`;
      db = new DatabaseSync(location, { readOnly: true });
      validateReadableSchema(db);
      result = operation(db);
    } catch (error) {
      operationError = error;
    } finally {
      closeQuietly(db);
    }

    try {
      finishImmutableObservation(this.databasePath, observedIdentity);
    } catch (error) {
      throw normalizeStorageError(error);
    }
    if (operationError !== undefined) throw normalizeStorageError(operationError);
    return result as T;
  }

  private write<T>(operation: (db: DatabaseSync) => T): T {
    this.assertDatabasePathSafe();
    mkdirSync(dirname(this.databasePath), { recursive: true });
    this.assertDatabasePathSafe();

    let db: DatabaseSync | undefined;
    let transactionOpen = false;
    try {
      db = new DatabaseSync(this.databasePath);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA foreign_keys = ON");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("BEGIN IMMEDIATE");
      transactionOpen = true;
      ensureWritableSchema(db, this.now);
      const result = operation(db);
      db.exec("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (db && transactionOpen) {
        try {
          db.exec("ROLLBACK");
        } catch {
          // Preserve the actionable failure from the operation/schema check.
        }
      }
      throw normalizeStorageError(error);
    } finally {
      closeQuietly(db);
    }
  }

  private assertDatabasePathSafe(): void {
    const containedPrefix = `${this.projectRoot}${sep}`;
    if (!this.databasePath.startsWith(containedPrefix)) {
      throw pathError("The local team database resolves outside the project root.");
    }

    for (const path of [
      join(this.projectRoot, ".mex"),
      join(this.projectRoot, ".mex/local"),
      this.databasePath,
    ]) {
      if (!existsSync(path)) continue;
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) {
        throw pathError(`Refusing local state through symbolic link ${path}.`);
      }
      const canonical = realpathSync(path);
      if (canonical !== this.projectRoot && !canonical.startsWith(containedPrefix)) {
        throw pathError("The local team database resolves outside the project root.");
      }
    }
  }

  private assertExistingRevisionCanMatch(
    expectedRevision: Revision | null,
    label: string,
  ): void {
    this.assertDatabasePathSafe();
    if (expectedRevision !== null && !existsSync(this.databasePath)) {
      throw revisionConflict(`The ${label} does not exist; reload it and retry.`);
    }
  }
}

/** Stable cursor key. Git identity data is hashed and never appears in the key. */
export function canonicalActorKey(actor: ActorRef): string | null {
  if (actor.kind === "unknown") return null;
  if (actor.kind === "member") return validateMemberId(actor.memberId);

  const name = normalizeIdentityKeyPart(actor.name);
  const email = normalizeIdentityKeyPart(actor.email);
  if (name === null && email === null) return null;
  const digest = sha256(JSON.stringify({ name, email }));
  return `git:${digest}`;
}

function canonicalProjectRoot(projectRoot: string): string {
  if (typeof projectRoot !== "string" || projectRoot.length === 0) {
    throw validationError("projectRoot must be a non-empty path.");
  }
  const absolute = resolve(projectRoot);
  try {
    const canonical = realpathSync(absolute);
    if (!statSync(canonical).isDirectory()) {
      throw validationError("projectRoot must identify an existing directory.");
    }
    return canonical;
  } catch {
    throw validationError("projectRoot must identify an existing directory.");
  }
}

function validateScaffoldId(value: string): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw validationError("scaffoldId must be a non-empty, bounded identifier.");
  }
  return value;
}

function validateStoredScaffoldId(value: unknown): string {
  if (
    typeof value !== "string"
    || value.length === 0
    || value.length > 512
    || /[\0-\x1f\x7f]/.test(value)
  ) {
    throw corruptError("A persisted Hub job contains an invalid scaffold identifier.");
  }
  return value;
}

function validateMemberId(value: string): string {
  if (typeof value !== "string" || !MEMBER_ID.test(value)) {
    throw validationError("Member IDs must use the member_<ULID> format.");
  }
  return value;
}

function validateTimestamp(value: string, label: string): string {
  if (typeof value !== "string") throw validationError(`${label} must be a UTC timestamp.`);
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw validationError(`${label} must be an exact ISO 8601 UTC timestamp.`);
  }
  return value;
}

function validateExpectedRevision(value: Revision | null): Revision | null {
  if (value !== null && (typeof value !== "string" || !isRevision(value))) {
    throw validationError("expectedRevision must be null or a lower-case SHA-256 revision.");
  }
  return value;
}

function validateHead(value: string | null): string | null {
  if (value !== null && (typeof value !== "string" || !GIT_HEAD.test(value))) {
    throw validationError("head must be null or a complete lower-case Git object ID.");
  }
  return value;
}

function validateBranch(value: string | null): string | null {
  if (
    value !== null
    && (
      typeof value !== "string"
      || value.length === 0
      || value.length > 1024
      || /[\0-\x1f\x7f]/.test(value)
    )
  ) {
    throw validationError("branch must be null or a bounded Git branch name.");
  }
  return value;
}

function normalizeWritableActor(actor: ActorRef): Exclude<ActorRef, { kind: "unknown" }> {
  if (!actor || typeof actor !== "object") {
    throw validationError("A valid member or Git actor is required.");
  }
  if (actor.kind === "unknown") {
    throw validationError("Unknown actors cannot mark or reset a Catch Up cursor.");
  }
  if (actor.kind === "member") {
    const memberId = validateMemberId(actor.memberId);
    const displayName = normalizeDisplayValue(actor.displayName);
    return displayName === undefined
      ? { kind: "member", memberId }
      : { kind: "member", memberId, displayName };
  }
  if (actor.kind !== "git") throw validationError("Unsupported actor kind.");

  const name = normalizeDisplayValue(actor.name) ?? null;
  const email = normalizeEmail(actor.email);
  if (name === null && email === null) {
    throw validationError("A Git actor requires a name or email.");
  }
  return { kind: "git", name, email };
}

function normalizeDisplayValue(value: string | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  if (typeof value !== "string") throw validationError("Actor identity fields must be strings.");
  const normalized = value.normalize("NFKC").trim().replace(/\s+/gu, " ");
  return normalized.length === 0 ? undefined : normalized;
}

function normalizeEmail(value: string | null): string | null {
  const normalized = normalizeDisplayValue(value);
  return normalized?.toLowerCase() ?? null;
}

function normalizeIdentityKeyPart(value: string | null): string | null {
  const normalized = normalizeDisplayValue(value);
  return normalized?.toLowerCase() ?? null;
}

function configuredMemberRevision(
  scaffoldId: string,
  memberId: string,
  updatedAt: string,
): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_RECORD_REVISION_VERSION,
    scaffoldId,
    memberId,
    updatedAt,
  }));
}

function cursorRevision(cursor: Omit<StoredCatchUpCursor, "revision">): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_RECORD_REVISION_VERSION,
    scaffoldId: cursor.scaffoldId,
    actor: cursor.actor,
    head: cursor.head,
    branch: cursor.branch,
    timestamp: cursor.timestamp,
  }));
}

function sha256(value: string): Revision {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function canonicalActorJson(actor: Exclude<ActorRef, { kind: "unknown" }>): string {
  if (actor.kind === "git") {
    return JSON.stringify({ kind: "git", name: actor.name, email: actor.email });
  }
  return actor.displayName === undefined
    ? JSON.stringify({ kind: "member", memberId: actor.memberId })
    : JSON.stringify({
        kind: "member",
        memberId: actor.memberId,
        displayName: actor.displayName,
      });
}

function readConfiguredMember(
  db: DatabaseSync,
  scaffoldId: string,
): ConfiguredMemberSelection | null {
  const row = db.prepare(`
    SELECT scaffold_id, member_id, updated_at, revision
    FROM configured_member_selections
    WHERE scaffold_id = ?
  `).get(scaffoldId) as ConfiguredMemberRow | undefined;
  return row ? decodeConfiguredMember(row, scaffoldId) : null;
}

function decodeConfiguredMember(
  row: ConfiguredMemberRow,
  expectedScaffoldId: string,
): ConfiguredMemberSelection {
  if (row.scaffold_id !== expectedScaffoldId) throw corruptError("Configured-member scaffold mismatch.");
  if (typeof row.member_id !== "string" || !MEMBER_ID.test(row.member_id)) {
    throw corruptError("Configured-member row contains an invalid member ID.");
  }
  if (typeof row.updated_at !== "string" || !isCanonicalTimestamp(row.updated_at)) {
    throw corruptError("Configured-member row contains an invalid timestamp.");
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("Configured-member row contains an invalid revision.");
  }
  const expectedRevision = configuredMemberRevision(
    expectedScaffoldId,
    row.member_id,
    row.updated_at,
  );
  if (row.revision !== expectedRevision) {
    throw corruptError("Configured-member row failed its revision check.");
  }
  return {
    scaffoldId: expectedScaffoldId,
    memberId: row.member_id,
    updatedAt: row.updated_at,
    revision: row.revision,
  };
}

function readCatchUpCursor(
  db: DatabaseSync,
  scaffoldId: string,
  actorKey: string,
): StoredCatchUpCursor | null {
  const row = db.prepare(`
    SELECT scaffold_id, actor_key, actor_json, head, branch, timestamp, revision
    FROM catch_up_cursors
    WHERE scaffold_id = ? AND actor_key = ?
  `).get(scaffoldId, actorKey) as CatchUpCursorRow | undefined;
  return row ? decodeCatchUpCursor(row, scaffoldId, actorKey) : null;
}

function decodeCatchUpCursor(
  row: CatchUpCursorRow,
  expectedScaffoldId: string,
  expectedActorKey: string,
): StoredCatchUpCursor {
  if (row.scaffold_id !== expectedScaffoldId || row.actor_key !== expectedActorKey) {
    throw corruptError("Catch Up cursor key does not match its stored identity.");
  }
  if (typeof row.actor_json !== "string") throw corruptError("Catch Up actor is not valid JSON.");
  const actor = parseStoredActor(row.actor_json);
  if (canonicalActorKey(actor) !== expectedActorKey) {
    throw corruptError("Catch Up actor does not match its privacy-preserving key.");
  }
  if (row.head !== null && (typeof row.head !== "string" || !GIT_HEAD.test(row.head))) {
    throw corruptError("Catch Up cursor contains an invalid Git HEAD.");
  }
  if (row.branch !== null && !isValidStoredBranch(row.branch)) {
    throw corruptError("Catch Up cursor contains an invalid branch.");
  }
  if (typeof row.timestamp !== "string" || !isCanonicalTimestamp(row.timestamp)) {
    throw corruptError("Catch Up cursor contains an invalid timestamp.");
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("Catch Up cursor contains an invalid revision.");
  }

  const cursor: StoredCatchUpCursor = {
    scaffoldId: expectedScaffoldId,
    actor,
    head: row.head,
    branch: row.branch,
    timestamp: row.timestamp,
    revision: row.revision,
  };
  if (cursorRevision(cursor) !== cursor.revision) {
    throw corruptError("Catch Up cursor failed its revision check.");
  }
  return cursor;
}

function readHubJob(
  db: DatabaseSync,
  scaffoldId: string,
  id: string,
): HubJobSnapshot | null {
  const row = db.prepare(`
    SELECT ${HUB_JOB_SELECT_COLUMNS}
    FROM hub_jobs
    WHERE scaffold_id = ? AND id = ?
  `).get(scaffoldId, id) as HubJobRow | undefined;
  return row ? decodeHubJob(row, scaffoldId) : null;
}

function readHubJobLease(db: DatabaseSync): HubJobLease | null {
  const rows = db.prepare(`
    SELECT singleton, pid, token, acquired_at
    FROM hub_runtime_lease
  `).all() as unknown as HubLeaseRow[];
  if (rows.length === 0) return null;
  if (rows.length !== 1 || sqliteInteger(rows[0]?.singleton) !== 1) {
    throw corruptError("The Hub job lease row is invalid.");
  }
  const row = rows[0]!;
  const pid = sqliteInteger(row.pid);
  if (pid === null || pid < 1) {
    throw corruptError("The Hub job lease PID is invalid.");
  }
  if (typeof row.token !== "string" || !HUB_LEASE_TOKEN.test(row.token)) {
    throw corruptError("The Hub job lease token is invalid.");
  }
  if (typeof row.acquired_at !== "string" || !isCanonicalTimestamp(row.acquired_at)) {
    throw corruptError("The Hub job lease timestamp is invalid.");
  }
  return { pid, token: row.token, acquiredAt: row.acquired_at };
}

function assertHubJobLease(db: DatabaseSync, token: string): void {
  const current = readHubJobLease(db);
  if (!current || current.token !== token) {
    throw revisionConflict("The repository Hub job lease is absent or no longer owned.");
  }
}

function readActiveHubJob(
  db: DatabaseSync,
  scaffoldId: string,
): HubJobSnapshot | null {
  const rows = db.prepare(`
    SELECT ${HUB_JOB_SELECT_COLUMNS}
    FROM hub_jobs
    WHERE scaffold_id = ? AND state IN ('queued', 'running')
    ORDER BY created_at ASC, id ASC
    LIMIT 2
  `).all(scaffoldId) as unknown as HubJobRow[];
  if (rows.length > 1) {
    throw corruptError("More than one active index-mutating Hub job exists for this scaffold.");
  }
  return rows[0] ? decodeHubJob(rows[0], scaffoldId) : null;
}

function decodeHubJob(row: HubJobRow, expectedScaffoldId: string): HubJobSnapshot {
  if (row.scaffold_id !== expectedScaffoldId) {
    throw corruptError("Hub job scaffold does not match its storage partition.");
  }
  let id: string;
  let kind: HubJobKind;
  let generation: number;
  let phase: HubJobPhase;
  let progress: HubJobProgress | null;
  let cancelRequested: boolean;
  let state: HubJobSnapshot["state"];
  let createdAt: string;
  let startedAt: string | undefined;
  let finishedAt: string | undefined;
  let interruptedReason: HubJobInterruptionReason | undefined;
  let problem: HubJobProblem | undefined;
  let summary: string | undefined;
  try {
    id = validateHubJobId(row.id);
    kind = validateHubJobKind(row.kind);
    generation = requireSafeInteger(row.generation, "generation", 1);
    phase = validateJobPhase(row.phase);
    progress = decodeStoredJobProgress(row);
    cancelRequested = decodeSqliteBoolean(row.cancel_requested, "cancelRequested");
    state = validateJobState(row.state);
    createdAt = validateTimestamp(row.created_at as string, "createdAt");
    startedAt = optionalStoredTimestamp(row.started_at, "startedAt");
    finishedAt = optionalStoredTimestamp(row.finished_at, "finishedAt");
    interruptedReason = validateStoredInterruptionReason(row.interrupted_reason);
    problem = decodeStoredJobProblem(row.problem_json);
    if (row.summary !== null) {
      throw corruptError("Hub jobs must not persist executor-provided summaries.");
    }
    summary = undefined;
  } catch (error) {
    if (error instanceof MexPortError && error.problem.code === "VALIDATION_FAILED") {
      throw corruptError(`Hub job ${String(row.id)} contains invalid persisted fields.`);
    }
    throw error;
  }
  if (typeof row.revision !== "string" || !isRevision(row.revision)) {
    throw corruptError("Hub job contains an invalid revision.");
  }
  const draft: Omit<HubJobSnapshot, "revision"> = {
    id,
    scaffoldId: expectedScaffoldId,
    kind,
    generation,
    phase,
    progress,
    cancelRequested,
    state,
    createdAt,
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(finishedAt === undefined ? {} : { finishedAt }),
    ...(interruptedReason === undefined ? {} : { interruptedReason }),
    ...(problem === undefined ? {} : { problem }),
    ...(summary === undefined ? {} : { summary }),
  };
  try {
    validateJobLifecycle(draft);
  } catch (error) {
    if (error instanceof MexPortError) {
      throw corruptError("Hub job contains an invalid lifecycle projection.");
    }
    throw error;
  }
  if (hubJobRevision(draft) !== row.revision) {
    throw corruptError("Hub job failed its optimistic revision check.");
  }
  return { ...draft, revision: row.revision };
}

function decodeStoredJobProgress(row: HubJobRow): HubJobProgress | null {
  if (
    row.progress_completed === null
    && row.progress_total === null
    && row.progress_message === null
  ) {
    return null;
  }
  if (row.progress_completed === null) {
    throw corruptError("Hub job progress is missing its completed count.");
  }
  if (row.progress_message !== null) {
    throw corruptError("Hub jobs must not persist executor-provided progress messages.");
  }
  return validateJobProgress({
    completed: requireSafeInteger(row.progress_completed, "progress.completed", 0),
    ...(row.progress_total === null
      ? {}
      : { total: requireSafeInteger(row.progress_total, "progress.total", 1) }),
  });
}

function decodeStoredJobProblem(value: unknown): HubJobProblem | undefined {
  if (value === null) return undefined;
  if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_JOB_PROBLEM_JSON_BYTES) {
    throw corruptError("Hub job problem is invalid or oversized.");
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw corruptError("Hub job problem is not valid JSON.");
  }
  const problem = validateJobProblem(decoded);
  if (!problem || JSON.stringify(problem) !== value) {
    throw corruptError("Hub job problem is not canonical JSON.");
  }
  return problem;
}

function insertHubJob(db: DatabaseSync, job: HubJobSnapshot): void {
  db.prepare(`
    INSERT INTO hub_jobs (
      id, scaffold_id, kind, generation, phase,
      progress_completed, progress_total, progress_message, cancel_requested,
      state, created_at, started_at, finished_at, interrupted_reason,
      problem_json, summary, revision
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(...hubJobSqlValues(job));
}

function replaceHubJob(
  db: DatabaseSync,
  job: HubJobSnapshot,
  expectedRevision: Revision,
): void {
  const values = hubJobSqlValues(job);
  const result = db.prepare(`
    UPDATE hub_jobs SET
      scaffold_id = ?, kind = ?, generation = ?, phase = ?,
      progress_completed = ?, progress_total = ?, progress_message = ?, cancel_requested = ?,
      state = ?, created_at = ?, started_at = ?, finished_at = ?,
      interrupted_reason = ?, problem_json = ?, summary = ?, revision = ?
    WHERE id = ? AND scaffold_id = ? AND revision = ?
  `).run(
    ...values.slice(1),
    job.id,
    job.scaffoldId,
    expectedRevision,
  );
  if (Number(result.changes) !== 1) {
    throw revisionConflict("The Hub job revision changed; reload it and retry.");
  }
}

function hubJobSqlValues(job: HubJobSnapshot): Array<string | number | null> {
  return [
    job.id,
    job.scaffoldId,
    job.kind,
    job.generation,
    job.phase,
    job.progress?.completed ?? null,
    job.progress?.total ?? null,
    job.progress?.message ?? null,
    job.cancelRequested ? 1 : 0,
    job.state,
    job.createdAt,
    job.startedAt ?? null,
    job.finishedAt ?? null,
    job.interruptedReason ?? null,
    job.problem ? JSON.stringify(job.problem) : null,
    job.summary ?? null,
    job.revision,
  ];
}

function pruneTerminalHubJobs(db: DatabaseSync, scaffoldId: string): number {
  const result = db.prepare(`
    DELETE FROM hub_jobs
    WHERE scaffold_id = ?
      AND state IN ('succeeded', 'failed', 'interrupted')
      AND id IN (
        SELECT id
        FROM hub_jobs
        WHERE scaffold_id = ?
          AND state IN ('succeeded', 'failed', 'interrupted')
        ORDER BY finished_at DESC, id DESC
        LIMIT -1 OFFSET ${TERMINAL_JOB_RETENTION}
      )
  `).run(scaffoldId, scaffoldId);
  return Number(result.changes);
}

function hubJobRevision(job: Omit<HubJobSnapshot, "revision">): Revision {
  return sha256(JSON.stringify({
    schemaVersion: 2,
    id: job.id,
    scaffoldId: job.scaffoldId,
    kind: job.kind,
    generation: job.generation,
    phase: job.phase,
    progress: job.progress,
    cancelRequested: job.cancelRequested,
    state: job.state,
    createdAt: job.createdAt,
    startedAt: job.startedAt ?? null,
    finishedAt: job.finishedAt ?? null,
    interruptedReason: job.interruptedReason ?? null,
    problem: job.problem ?? null,
    summary: job.summary ?? null,
  }));
}

function withoutRevision(job: HubJobSnapshot): Omit<HubJobSnapshot, "revision"> {
  const { revision: _revision, ...draft } = job;
  return draft;
}

function validateHubJobId(value: unknown): string {
  if (typeof value !== "string" || !HUB_JOB_ID.test(value)) {
    throw validationError("Hub job IDs must use the job_<ULID> format.");
  }
  return value;
}

function validateHubJobKind(value: unknown): HubJobKind {
  if (typeof value !== "string" || !HUB_JOB_KINDS.includes(value as HubJobKind)) {
    throw validationError("Hub job kind is not registered.");
  }
  return value as HubJobKind;
}

function validateJobState(value: unknown): HubJobSnapshot["state"] {
  if (typeof value !== "string" || !JOB_STATES.includes(value as HubJobSnapshot["state"])) {
    throw validationError("Hub job state is invalid.");
  }
  return value as HubJobSnapshot["state"];
}

function validateJobPhase(value: unknown): HubJobPhase {
  if (
    typeof value !== "string"
    || !HUB_JOB_PHASES.includes(value as HubJobPhase)
  ) {
    throw validationError("Hub job phase is not in the fixed internal allowlist.");
  }
  return value as HubJobPhase;
}

function validateJobProgress(value: HubJobProgress | null): HubJobProgress | null {
  if (value === null) return null;
  if (!isPlainObject(value)) throw validationError("Hub job progress has an invalid shape.");
  assertOnlyKeys(value, ["completed", "total", "message"], "Hub job progress");
  if (value.message !== undefined) {
    throw validationError("Hub jobs persist numeric progress only.");
  }
  const completed = requireSafeInteger(value.completed, "progress.completed", 0);
  const total = value.total === undefined
    ? undefined
    : requireSafeInteger(value.total, "progress.total", 1);
  if (total !== undefined && completed > total) {
    throw validationError("Hub job completed progress cannot exceed its total.");
  }
  return {
    completed,
    ...(total === undefined ? {} : { total }),
  };
}

function validateJobProblem(value: unknown): HubJobProblem | undefined {
  if (value === undefined) return undefined;
  if (!isPlainObject(value)) throw validationError("Hub job problem has an invalid shape.");
  assertOnlyKeys(value, ["type", "status", "code", "title", "detail"], "Hub job problem");
  if (value.type !== "about:blank" || value.status !== 500 || value.code !== "JOB_FAILED") {
    throw validationError("Hub job problem must use the bounded JOB_FAILED projection.");
  }
  if (
    value.title !== "Hub job failed"
    || value.detail !== "The job did not complete. Retry it or inspect repository health."
  ) {
    throw validationError("Hub job failures must use the generic non-sensitive projection.");
  }
  const problem: HubJobProblem = {
    type: "about:blank",
    status: 500,
    code: "JOB_FAILED",
    title: value.title,
    detail: value.detail,
  };
  if (Buffer.byteLength(JSON.stringify(problem), "utf8") > MAX_JOB_PROBLEM_JSON_BYTES) {
    throw validationError("Hub job problem is oversized.");
  }
  return problem;
}

function validateInterruptionReason(
  value: unknown,
): HubJobInterruptionReason | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "string"
    || !HUB_JOB_INTERRUPTION_REASONS.includes(value as HubJobInterruptionReason)
  ) {
    throw validationError("Hub job interruption reason is invalid.");
  }
  return value as HubJobInterruptionReason;
}

function validateStoredInterruptionReason(
  value: unknown,
): HubJobInterruptionReason | undefined {
  if (value === null) return undefined;
  return validateInterruptionReason(value);
}

function optionalTimestamp(value: unknown, label: string): string | undefined {
  if (value === undefined) return undefined;
  return validateTimestamp(value as string, label);
}

function optionalStoredTimestamp(value: unknown, label: string): string | undefined {
  if (value === null) return undefined;
  return validateTimestamp(value as string, label);
}

function requireSafeInteger(value: unknown, label: string, minimum: number): number {
  const numeric = sqliteInteger(value);
  if (numeric === null || numeric < minimum) {
    throw validationError(`${label} must be a safe integer greater than or equal to ${minimum}.`);
  }
  return numeric;
}

function validateBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") {
    throw validationError(`${label} must be a boolean.`);
  }
  return value;
}

function validateLeaseToken(value: unknown): string {
  if (typeof value !== "string" || !HUB_LEASE_TOKEN.test(value)) {
    throw validationError("Hub job lease tokens must be lower-case 256-bit hex values.");
  }
  return value;
}

function safeProcessStatus(
  probe: (pid: number) => HubLeaseProcessStatus,
  pid: number,
): HubLeaseProcessStatus {
  try {
    const status = probe(pid);
    return status === "alive" || status === "dead" || status === "ambiguous"
      ? status
      : "ambiguous";
  } catch {
    return "ambiguous";
  }
}

function probeProcessStatus(pid: number): HubLeaseProcessStatus {
  try {
    process.kill(pid, 0);
    return "alive";
  } catch (error) {
    return isFilesystemError(error, "ESRCH") ? "dead" : "ambiguous";
  }
}

function decodeSqliteBoolean(value: unknown, label: string): boolean {
  const numeric = sqliteInteger(value);
  if (numeric !== 0 && numeric !== 1) {
    throw corruptError(`Hub job ${label} is not a SQLite boolean.`);
  }
  return numeric === 1;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  label: string,
): void {
  const allowedKeys = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedKeys.has(key))) {
    throw validationError(`${label} contains unknown fields.`);
  }
}

function assertJobTransition(
  current: HubJobSnapshot,
  nextState: HubJobSnapshot["state"],
  nextProgress: HubJobProgress | null,
  nextStartedAt: string | undefined,
  nextCancelRequested: boolean,
): void {
  const allowed = current.state === "queued"
    ? new Set<HubJobSnapshot["state"]>(["running", "failed", "interrupted"])
    : current.state === "running"
      ? new Set<HubJobSnapshot["state"]>(["running", "succeeded", "failed", "interrupted"])
      : new Set<HubJobSnapshot["state"]>();
  if (!allowed.has(nextState)) {
    throw revisionConflict(`Hub job cannot transition from ${current.state} to ${nextState}.`);
  }
  if (current.startedAt !== undefined && nextStartedAt !== current.startedAt) {
    throw validationError("Hub job start time is immutable once observed.");
  }
  if (current.cancelRequested && !nextCancelRequested) {
    throw validationError("A Hub job cancellation request cannot be cleared.");
  }
  if (current.progress) {
    if (!nextProgress || nextProgress.completed < current.progress.completed) {
      throw validationError("Hub job progress must be monotonic.");
    }
    if (
      current.progress.total !== undefined
      && nextProgress.total !== current.progress.total
    ) {
      throw validationError("Hub job progress total cannot change once observed.");
    }
  }
}

function validateJobLifecycle(job: Omit<HubJobSnapshot, "revision">): void {
  if (job.startedAt !== undefined && job.startedAt < job.createdAt) {
    throw validationError("Hub job start time cannot precede creation.");
  }
  if (
    job.finishedAt !== undefined
    && (job.finishedAt < job.createdAt || (job.startedAt !== undefined && job.finishedAt < job.startedAt))
  ) {
    throw validationError("Hub job finish time cannot precede creation or start.");
  }
  if (job.state === "queued") {
    if (
      job.phase !== "queued"
      || job.progress !== null
      || job.cancelRequested
      || job.startedAt !== undefined
      || job.finishedAt !== undefined
      || job.interruptedReason !== undefined
      || job.problem !== undefined
      || job.summary !== undefined
    ) {
      throw validationError("Queued Hub jobs cannot contain terminal or start fields.");
    }
    return;
  }
  if (job.state === "running") {
    if (
      !HUB_JOB_PROGRESS_PHASES.includes(job.phase as (typeof HUB_JOB_PROGRESS_PHASES)[number])
      || job.startedAt === undefined
      || job.finishedAt !== undefined
      || job.interruptedReason !== undefined
      || job.problem !== undefined
      || job.summary !== undefined
    ) {
      throw validationError("Running Hub jobs require only a start time.");
    }
    return;
  }
  if (job.finishedAt === undefined) {
    throw validationError("Terminal Hub jobs require a finish time.");
  }
  if (job.state === "interrupted") {
    if (
      job.phase !== "interrupted"
      || job.interruptedReason === undefined
      || job.problem !== undefined
      || job.summary !== undefined
    ) {
      throw validationError("Interrupted Hub jobs require only an interruption reason.");
    }
    if (job.interruptedReason === "user_cancelled" && !job.cancelRequested) {
      throw validationError("User-cancelled Hub jobs must retain their cancellation request.");
    }
    return;
  }
  if (job.cancelRequested) {
    throw validationError("Successful or failed Hub jobs cannot retain a cancellation request.");
  }
  if (job.startedAt === undefined || job.interruptedReason !== undefined) {
    throw validationError("Completed Hub jobs require a start time and no interruption reason.");
  }
  if (job.state === "failed" && job.problem === undefined) {
    throw validationError("Failed Hub jobs require a bounded problem.");
  }
  if (job.state === "succeeded" && job.problem !== undefined) {
    throw validationError("Successful Hub jobs cannot contain a problem.");
  }
  if (job.state === "failed" && job.summary !== undefined) {
    throw validationError("Failed Hub jobs cannot contain a success summary.");
  }
  if (
    (job.state === "failed" && job.phase !== "failed")
    || (job.state === "succeeded" && job.phase !== "complete")
  ) {
    throw validationError("Completed Hub job state and phase do not match.");
  }
}

function isTerminalJobState(state: HubJobSnapshot["state"]): boolean {
  return state === "succeeded" || state === "failed" || state === "interrupted";
}

interface DecodedJobCursor {
  createdAt: string;
  id: string;
}

function encodeJobCursor(createdAt: string, id: string): string {
  return Buffer.from(`${createdAt}\n${id}`, "utf8").toString("base64url");
}

function decodeJobCursor(value: string | undefined): DecodedJobCursor | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 4_096) {
    throw validationError("Hub job cursor is invalid or oversized.");
  }
  let bytes: Buffer;
  try {
    bytes = Buffer.from(value, "base64url");
  } catch {
    throw validationError("Hub job cursor is invalid.");
  }
  if (bytes.toString("base64url") !== value) {
    throw validationError("Hub job cursor is not canonical.");
  }
  const decoded = bytes.toString("utf8");
  const separator = decoded.indexOf("\n");
  if (separator < 0 || decoded.indexOf("\n", separator + 1) >= 0) {
    throw validationError("Hub job cursor is invalid.");
  }
  return {
    createdAt: validateTimestamp(decoded.slice(0, separator), "cursor timestamp"),
    id: validateHubJobId(decoded.slice(separator + 1)),
  };
}

function validateJobPageLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_JOB_PAGE_SIZE;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_JOB_PAGE_SIZE) {
    throw validationError(`Hub job page limit must be between 1 and ${MAX_JOB_PAGE_SIZE}.`);
  }
  return value;
}

function parseStoredActor(json: string): Exclude<ActorRef, { kind: "unknown" }> {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw corruptError("Catch Up actor is not valid JSON.");
  }
  if (!isPlainObject(value) || typeof value.kind !== "string") {
    throw corruptError("Catch Up actor has an invalid shape.");
  }

  try {
    if (value.kind === "member") {
      assertExactKeys(value, ["kind", "memberId", "displayName"]);
      return normalizeWritableActor({
        kind: "member",
        memberId: value.memberId as string,
        ...(value.displayName === undefined
          ? {}
          : { displayName: value.displayName as string }),
      });
    }
    if (value.kind === "git") {
      assertExactKeys(value, ["kind", "name", "email"]);
      return normalizeWritableActor({
        kind: "git",
        name: value.name as string | null,
        email: value.email as string | null,
      });
    }
  } catch (error) {
    if (error instanceof MexPortError) {
      throw corruptError("Catch Up actor contains invalid identity fields.");
    }
    throw error;
  }
  throw corruptError("Catch Up actor has an unsupported kind.");
}

function assertExactKeys(value: Record<string, unknown>, allowed: readonly string[]): void {
  const allowedSet = new Set(allowed);
  if (Object.keys(value).some((key) => !allowedSet.has(key))) {
    throw corruptError("Catch Up actor contains unknown fields.");
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCanonicalTimestamp(value: string): boolean {
  const parsed = new Date(value);
  return Number.isFinite(parsed.valueOf()) && parsed.toISOString() === value;
}

function isValidStoredBranch(value: unknown): value is string {
  return typeof value === "string"
    && value.length > 0
    && value.length <= 1024
    && !/[\0-\x1f\x7f]/.test(value);
}

function assertExpectedRevision(
  current: Revision | null,
  expected: Revision | null,
  label: string,
): void {
  if (current !== expected) {
    throw revisionConflict(`The ${label} revision changed; reload it and retry.`);
  }
}

function describeBranch(branch: string | null): string {
  return branch === null ? "detached HEAD" : `branch ${branch}`;
}

function beginImmutableObservation(databasePath: string): DatabaseFileIdentity | null {
  assertNoActiveSidecars(databasePath);
  const first = readDatabaseFileIdentity(databasePath, true);
  if (first === null) return null;
  assertNoActiveSidecars(databasePath);
  const second = readDatabaseFileIdentity(databasePath, false);
  assertSameDatabaseIdentity(first, second);
  return second;
}

function finishImmutableObservation(
  databasePath: string,
  expected: DatabaseFileIdentity,
): void {
  assertNoActiveSidecars(databasePath);
  const current = readDatabaseFileIdentity(databasePath, false);
  assertSameDatabaseIdentity(expected, current);
  assertNoActiveSidecars(databasePath);
}

function assertNoActiveSidecars(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"] as const) {
    const sidecarPath = `${databasePath}${suffix}`;
    try {
      lstatSync(sidecarPath);
    } catch (error) {
      if (isFilesystemError(error, "ENOENT")) continue;
      throw observationError(
        `Cannot safely inspect the local database ${suffix} sidecar; retry after local writes finish.`,
      );
    }
    throw observationError(
      `The local database has an active ${suffix} sidecar; retry after local writes finish.`,
    );
  }
}

function readDatabaseFileIdentity(
  databasePath: string,
  allowMissing: boolean,
): DatabaseFileIdentity | null {
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(databasePath, { bigint: true });
  } catch (error) {
    if (allowMissing && isFilesystemError(error, "ENOENT")) return null;
    throw observationError(
      "The local database changed or became unreadable during a side-effect-free read.",
    );
  }
  if (stat.isSymbolicLink()) {
    throw pathError("Refusing local state through a symbolic-link database.");
  }
  if (!stat.isFile()) {
    throw corruptError("The local team database is not a regular file.");
  }
  return {
    device: stat.dev,
    inode: stat.ino,
    size: stat.size,
    modifiedAt: stat.mtimeNs,
    changedAt: stat.ctimeNs,
  };
}

function assertSameDatabaseIdentity(
  expected: DatabaseFileIdentity,
  actual: DatabaseFileIdentity | null,
): void {
  if (
    actual === null
    || expected.device !== actual.device
    || expected.inode !== actual.inode
    || expected.size !== actual.size
    || expected.modifiedAt !== actual.modifiedAt
    || expected.changedAt !== actual.changedAt
  ) {
    throw observationError(
      "The local database changed during a side-effect-free read; retry against a stable snapshot.",
    );
  }
}

function isFilesystemError(error: unknown, code: string): boolean {
  return error instanceof Error
    && "code" in error
    && (error as NodeJS.ErrnoException).code === code;
}

function validateReadableSchema(db: DatabaseSync): void {
  const tables = listUserTables(db);
  if (tables.length === 0) {
    throw migrationError("The local team database has not been initialized.");
  }
  if (!tables.includes("local_state_schema")) {
    throw corruptError("The local team database has no schema metadata.");
  }
  validateSchemaTableColumns(db);
  const version = readSchemaVersion(db);
  if (version === 0) {
    throw migrationError(
      `Local team schema ${version} requires an explicit write-side migration.`,
    );
  }
  if (version === 1) {
    validateV1Tables(db);
    throw migrationError(
      "Local team schema 1 requires the explicit Hub schema v2 migration.",
    );
  }
  if (version === 2) {
    validateV2Tables(db);
    throw migrationError(
      "Local team schema 2 requires the explicit Hub schema v3 migration.",
    );
  }
  if (version > LOCAL_STATE_SCHEMA_VERSION) {
    throw migrationError(
      `Local team schema ${version} is newer than supported schema ${LOCAL_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (version !== LOCAL_STATE_SCHEMA_VERSION) {
    throw corruptError("The local team schema version is invalid.");
  }
  validateV3Tables(db);
}

function ensureWritableSchema(db: DatabaseSync, now: () => string): void {
  const tables = listUserTables(db);
  if (tables.length === 0) {
    createV3Schema(db, now());
    validateV3Tables(db);
    return;
  }
  if (!tables.includes("local_state_schema")) {
    throw corruptError("The local team database has no schema metadata.");
  }
  validateSchemaTableColumns(db);
  const version = readSchemaVersion(db);
  if (version > LOCAL_STATE_SCHEMA_VERSION) {
    throw migrationError(
      `Local team schema ${version} is newer than supported schema ${LOCAL_STATE_SCHEMA_VERSION}.`,
    );
  }
  if (version < 0) throw corruptError("The local team schema version is invalid.");
  if (version === 0) {
    validateV0Tables(db);
    db.exec("DROP TABLE local_state_schema");
    db.exec(V1_SCHEMA_SQL);
    validateV1Tables(db);
    db.prepare(`
      INSERT INTO local_state_schema (singleton, version, applied_at)
      VALUES (1, ?, ?)
    `).run(1, validateTimestamp(now(), "migration timestamp"));
  }
  if (version <= 1) {
    validateV1Tables(db);
    db.exec(V2_SCHEMA_SQL);
    db.prepare(`
      UPDATE local_state_schema
      SET version = ?, applied_at = ?
      WHERE singleton = 1
    `).run(2, validateTimestamp(now(), "migration timestamp"));
  }
  if (version <= 2) {
    validateV2Tables(db);
    migrateV2ToV3(db);
    db.prepare(`
      UPDATE local_state_schema
      SET version = ?, applied_at = ?
      WHERE singleton = 1
    `).run(LOCAL_STATE_SCHEMA_VERSION, validateTimestamp(now(), "migration timestamp"));
  }
  validateV3Tables(db);
}

function createV3Schema(db: DatabaseSync, timestamp: string): void {
  db.exec(V1_SCHEMA_SQL);
  db.exec(V3_SCHEMA_SQL);
  db.prepare(`
    INSERT INTO local_state_schema (singleton, version, applied_at)
    VALUES (1, ?, ?)
  `).run(
    LOCAL_STATE_SCHEMA_VERSION,
    validateTimestamp(timestamp, "schema timestamp"),
  );
}

function migrateV2ToV3(db: DatabaseSync): void {
  db.exec(`
    DROP INDEX hub_jobs_generation_per_kind;
    DROP INDEX hub_jobs_one_active_index_job_per_scaffold;
    DROP INDEX hub_jobs_scaffold_created;
    ALTER TABLE hub_jobs RENAME TO hub_jobs_v2;
  `);
  const currentStatements = V3_SCHEMA_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => (
      statement.startsWith("CREATE TABLE hub_jobs")
      || statement.includes("INDEX hub_jobs_")
    ));
  db.exec(`${currentStatements.join(";\n")};`);
  db.exec(`
    INSERT INTO hub_jobs (
      id, scaffold_id, kind, generation, phase,
      progress_completed, progress_total, progress_message, cancel_requested,
      state, created_at, started_at, finished_at, interrupted_reason,
      problem_json, summary, revision
    )
    SELECT
      id, scaffold_id, kind, generation, phase,
      progress_completed, progress_total, progress_message, cancel_requested,
      state, created_at, started_at, finished_at, interrupted_reason,
      problem_json, summary, revision
    FROM hub_jobs_v2;
    DROP TABLE hub_jobs_v2;
  `);
}

function listUserTables(db: DatabaseSync): string[] {
  return (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
    ORDER BY name
  `).all() as Array<{ name: unknown }>).map((row) => {
    if (typeof row.name !== "string") throw corruptError("Invalid SQLite table metadata.");
    return row.name;
  });
}

function validateSchemaTableColumns(db: DatabaseSync): void {
  validateTableSemantics(db, "local_state_schema");
}

function validateV0Tables(db: DatabaseSync): void {
  const actualTables = listUserTables(db);
  if (actualTables.length !== 1 || actualTables[0] !== "local_state_schema") {
    throw corruptError("The local team database contains an invalid v0 table set.");
  }
  validateTableSemantics(db, "local_state_schema");
}

function validateV1Tables(db: DatabaseSync): void {
  const actualTables = listUserTables(db);
  const expectedTables = (Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]).sort();
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw corruptError("The local team database contains an invalid v1 table set.");
  }
  for (const table of expectedTables) {
    validateTableSemantics(db, table);
  }
  validateV1TableSql(db);
  validateNamedSchemaObjects(db, []);
}

function validateV2Tables(db: DatabaseSync): void {
  validateHubTables(db, V2_SCHEMA_SQL, "v2");
}

function validateV3Tables(db: DatabaseSync): void {
  validateHubTables(db, V3_SCHEMA_SQL, "v3");
}

function validateHubTables(
  db: DatabaseSync,
  schemaSql: string,
  versionLabel: "v2" | "v3",
): void {
  const actualTables = listUserTables(db);
  const expectedTables = [
    ...(Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]),
    "hub_jobs" as const,
    "hub_runtime_lease" as const,
  ].sort();
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw corruptError(`The local team database contains an invalid ${versionLabel} table set.`);
  }
  for (const table of expectedTables) validateTableSemantics(db, table);
  validateV1TableSql(db);
  validateHubJobIndexes(db, versionLabel);
  validateHubJobSchemaSql(db, schemaSql, versionLabel);
  validateNamedSchemaObjects(db, [
    "hub_jobs_generation_per_kind",
    "hub_jobs_one_active_index_job_per_scaffold",
    "hub_jobs_scaffold_created",
  ]);
}

function validateTableSemantics(
  db: DatabaseSync,
  table: LocalStateTable,
): void {
  const expectedColumns = table === "hub_jobs"
    ? EXPECTED_HUB_JOB_COLUMNS
    : table === "hub_runtime_lease"
      ? EXPECTED_HUB_LEASE_COLUMNS
      : EXPECTED_V1_TABLES[table];
  const tableRows = (db.prepare("PRAGMA table_list").all() as Array<{
    schema: unknown;
    name: unknown;
    type: unknown;
    ncol: unknown;
    wr: unknown;
    strict: unknown;
  }>).filter((row) => row.schema === "main" && row.name === table);
  if (tableRows.length !== 1) {
    throw corruptError(`Local team table ${table} is missing or ambiguous.`);
  }
  const tableRow = tableRows[0]!;
  if (
    tableRow.type !== "table"
    || sqliteInteger(tableRow.ncol) !== expectedColumns.length
    || sqliteInteger(tableRow.wr) !== 0
    || sqliteInteger(tableRow.strict) !== 1
  ) {
    throw corruptError(`Local team table ${table} is not the required STRICT rowid table.`);
  }

  const actualColumns = db.prepare(`PRAGMA table_xinfo(${table})`).all() as Array<{
    cid: unknown;
    name: unknown;
    type: unknown;
    notnull: unknown;
    dflt_value: unknown;
    pk: unknown;
    hidden: unknown;
  }>;
  if (actualColumns.length !== expectedColumns.length) {
    throw corruptError(`Local team table ${table} has an invalid column count.`);
  }

  for (const [index, expected] of expectedColumns.entries()) {
    const actual = actualColumns[index];
    const declaredType = typeof actual?.type === "string"
      ? actual.type.trim().toUpperCase()
      : null;
    if (
      actual === undefined
      || sqliteInteger(actual.cid) !== index
      || actual.name !== expected.name
      || declaredType !== expected.type
      || sqliteInteger(actual.notnull) !== expected.notNull
      || actual.dflt_value !== null
      || sqliteInteger(actual.pk) !== expected.primaryKeyPosition
      || sqliteInteger(actual.hidden) !== 0
    ) {
      throw corruptError(
        `Local team table ${table} column ${expected.name} has invalid semantics.`,
      );
    }
  }
}

function validateHubJobIndexes(db: DatabaseSync, versionLabel: "v2" | "v3"): void {
  const indexes = db.prepare("PRAGMA index_list(hub_jobs)").all() as Array<{
    name: unknown;
    unique: unknown;
    origin: unknown;
    partial: unknown;
  }>;
  const named = indexes
    .filter((row) => row.origin === "c")
    .sort((left, right) => compareCodeUnits(String(left.name), String(right.name)));
  const expected = [
    {
      name: "hub_jobs_generation_per_kind",
      unique: 1,
      partial: 0,
      columns: ["scaffold_id", "kind", "generation"],
    },
    {
      name: "hub_jobs_one_active_index_job_per_scaffold",
      unique: 1,
      partial: 1,
      columns: ["scaffold_id"],
    },
    {
      name: "hub_jobs_scaffold_created",
      unique: 0,
      partial: 0,
      columns: ["scaffold_id", "created_at", "id"],
    },
  ] as const;
  if (named.length !== expected.length) {
    throw corruptError(`The local team database contains an invalid ${versionLabel} Hub job index set.`);
  }
  for (const [index, wanted] of expected.entries()) {
    const actual = named[index];
    if (
      actual?.name !== wanted.name
      || sqliteInteger(actual.unique) !== wanted.unique
      || sqliteInteger(actual.partial) !== wanted.partial
    ) {
      throw corruptError(`Hub job index ${wanted.name} has invalid semantics.`);
    }
    const columns = db.prepare(`PRAGMA index_info(${wanted.name})`).all() as Array<{
      seqno: unknown;
      name: unknown;
    }>;
    if (
      columns.length !== wanted.columns.length
      || columns.some((column, columnIndex) => (
        sqliteInteger(column.seqno) !== columnIndex
        || column.name !== wanted.columns[columnIndex]
      ))
    ) {
      throw corruptError(`Hub job index ${wanted.name} has invalid columns.`);
    }
  }
}

function validateHubJobSchemaSql(
  db: DatabaseSync,
  schemaSql: string,
  versionLabel: "v2" | "v3",
): void {
  const expectedStatements = schemaSql
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  const expectedNames = [
    "hub_runtime_lease",
    "hub_jobs",
    "hub_jobs_one_active_index_job_per_scaffold",
    "hub_jobs_generation_per_kind",
    "hub_jobs_scaffold_created",
  ] as const;
  for (const name of expectedNames) {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE name = ? AND type IN ('table', 'index')
    `).get(name) as { sql: unknown } | undefined;
    const expected = expectedStatements.find((statement) => (
      statement.startsWith(`CREATE TABLE ${name}`)
      || statement.includes(`INDEX ${name}\n`)
    ));
    if (
      !row
      || typeof row.sql !== "string"
      || expected === undefined
      || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)
    ) {
      throw corruptError(`Hub job schema object ${name} does not match schema ${versionLabel}.`);
    }
  }
}

function validateV1TableSql(db: DatabaseSync): void {
  const expectedStatements = V1_SCHEMA_SQL
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
  for (const name of Object.keys(EXPECTED_V1_TABLES) as V1LocalStateTable[]) {
    const row = db.prepare(`
      SELECT sql
      FROM sqlite_master
      WHERE name = ? AND type = 'table'
    `).get(name) as { sql: unknown } | undefined;
    const expected = expectedStatements.find((statement) => statement.includes(name));
    if (
      !row
      || typeof row.sql !== "string"
      || expected === undefined
      || normalizeSchemaSql(row.sql) !== normalizeSchemaSql(expected)
    ) {
      throw corruptError(`Local team table ${name} does not match the exact v1 schema.`);
    }
  }
}

function validateNamedSchemaObjects(db: DatabaseSync, expectedNames: readonly string[]): void {
  const actualNames = (db.prepare(`
    SELECT name
    FROM sqlite_master
    WHERE name NOT LIKE 'sqlite_%' AND type IN ('index', 'trigger', 'view')
    ORDER BY name
  `).all() as Array<{ name: unknown }>).map((row) => {
    if (typeof row.name !== "string") throw corruptError("Invalid SQLite schema metadata.");
    return row.name;
  });
  const expected = [...expectedNames].sort(compareCodeUnits);
  if (
    actualNames.length !== expected.length
    || actualNames.some((name, index) => name !== expected[index])
  ) {
    throw corruptError("The local team database contains unexpected indexes, triggers, or views.");
  }
}

function normalizeSchemaSql(value: string): string {
  return value
    .replace(/\s+/g, "")
    .replace(/;+$/g, "")
    .replace(/ifnotexists/gi, "")
    .toLowerCase();
}

function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function sqliteInteger(value: unknown): number | null {
  if (typeof value === "number" && Number.isSafeInteger(value)) return value;
  if (
    typeof value === "bigint"
    && value >= BigInt(Number.MIN_SAFE_INTEGER)
    && value <= BigInt(Number.MAX_SAFE_INTEGER)
  ) {
    return Number(value);
  }
  return null;
}

function readSchemaVersion(db: DatabaseSync): number {
  const rows = db.prepare(`
    SELECT singleton, version, applied_at
    FROM local_state_schema
  `).all() as Array<{ singleton: unknown; version: unknown; applied_at: unknown }>;
  if (rows.length !== 1 || Number(rows[0]?.singleton) !== 1) {
    throw corruptError("The local team schema metadata is invalid.");
  }
  const version = Number(rows[0]?.version);
  if (!Number.isSafeInteger(version)) {
    throw corruptError("The local team schema version is invalid.");
  }
  if (typeof rows[0]?.applied_at !== "string" || !isCanonicalTimestamp(rows[0].applied_at)) {
    throw corruptError("The local team schema timestamp is invalid.");
  }
  return version;
}

function closeQuietly(db: DatabaseSync | undefined): void {
  if (!db?.isOpen) return;
  try {
    db.close();
  } catch {
    // A close failure must not mask a typed schema/operation failure.
  }
}

function normalizeStorageError(error: unknown): MexPortError {
  if (error instanceof MexPortError) return error;
  return corruptError(
    `The local team database could not be read safely: ${errorMessage(error)}`,
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validationError(detail: string): MexPortError {
  return new MexPortError({
    title: "Invalid local team state request",
    status: 422,
    code: "VALIDATION_FAILED",
    detail,
  });
}

function revisionConflict(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state revision conflict",
    status: 409,
    code: "REVISION_CONFLICT",
    detail,
  });
}

function jobAlreadyRunningError(activeJobId: string): MexPortError {
  return new MexPortError({
    title: "Hub index job already running",
    status: 409,
    code: "JOB_ALREADY_RUNNING",
    detail: `Index-mutating Hub job ${activeJobId} is already active for this scaffold.`,
    activeJobId,
  } as ConstructorParameters<typeof MexPortError>[0]);
}

function hubLeaseHeldError(pid: number, status: Exclude<HubLeaseProcessStatus, "dead">): MexPortError {
  return new MexPortError({
    title: "Project Hub job lease is already held",
    status: 409,
    code: "JOB_ALREADY_RUNNING",
    detail: status === "alive"
      ? `Another live Project Hub process (${pid}) owns this repository's job lease.`
      : `The Project Hub job lease holder (${pid}) could not be verified dead; refusing recovery.`,
  });
}

function jobNotFoundError(id: string): MexPortError {
  return new MexPortError({
    title: "Hub job not found",
    status: 404,
    code: "NOT_FOUND",
    detail: `Hub job ${id} does not exist in this scaffold.`,
  });
}

function migrationError(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state migration required",
    status: 409,
    code: "MIGRATION_REQUIRED",
    detail,
  });
}

function observationError(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state snapshot is not stable",
    status: 409,
    code: "OPERATION_INTERRUPTED",
    detail,
  });
}

function corruptError(detail: string): MexPortError {
  return new MexPortError({
    title: "Local team state is corrupt",
    status: 500,
    code: "INDEX_CORRUPT",
    detail,
  });
}

function pathError(detail: string): MexPortError {
  return new MexPortError({
    title: "Unsafe local team state path",
    status: 400,
    code: "PATH_OUTSIDE_PROJECT",
    detail,
  });
}
