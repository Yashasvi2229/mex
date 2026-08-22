import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { ActorRef, Revision } from "../contracts/shared.js";
import { isRevision, MexPortError } from "../contracts/shared.js";
import type { CatchUpCursor } from "../contracts/workflow.js";

const LOCAL_STATE_SCHEMA_VERSION = 1 as const;
const LOCAL_STATE_RELATIVE_PATH = ".mex/local/team.db";
const MEMBER_ID = /^member_[0-9A-HJKMNP-TV-Z]{26}$/;
const GIT_HEAD = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

const SCHEMA_SQL = `
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

const EXPECTED_TABLES = {
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

type LocalStateTable = keyof typeof EXPECTED_TABLES;

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

  constructor(options: TeamLocalStateOptions) {
    this.projectRoot = canonicalProjectRoot(options.projectRoot);
    this.scaffoldId = validateScaffoldId(options.scaffoldId);
    this.databasePath = join(this.projectRoot, LOCAL_STATE_RELATIVE_PATH);
    this.now = options.now ?? (() => new Date().toISOString());
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
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
    scaffoldId,
    memberId,
    updatedAt,
  }));
}

function cursorRevision(cursor: Omit<StoredCatchUpCursor, "revision">): Revision {
  return sha256(JSON.stringify({
    schemaVersion: LOCAL_STATE_SCHEMA_VERSION,
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
  if (version < LOCAL_STATE_SCHEMA_VERSION) {
    throw migrationError(
      `Local team schema ${version} requires an explicit write-side migration.`,
    );
  }
  if (version > LOCAL_STATE_SCHEMA_VERSION) {
    throw migrationError(
      `Local team schema ${version} is newer than supported schema ${LOCAL_STATE_SCHEMA_VERSION}.`,
    );
  }
  validateV1Tables(db);
}

function ensureWritableSchema(db: DatabaseSync, now: () => string): void {
  const tables = listUserTables(db);
  if (tables.length === 0) {
    createV1Schema(db, now());
    validateV1Tables(db);
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
    db.exec(SCHEMA_SQL);
    validateV1Tables(db);
    db.prepare(`
      UPDATE local_state_schema
      SET version = ?, applied_at = ?
      WHERE singleton = 1
    `).run(LOCAL_STATE_SCHEMA_VERSION, validateTimestamp(now(), "migration timestamp"));
    return;
  }
  validateV1Tables(db);
}

function createV1Schema(db: DatabaseSync, timestamp: string): void {
  db.exec(SCHEMA_SQL);
  db.prepare(`
    INSERT INTO local_state_schema (singleton, version, applied_at)
    VALUES (1, ?, ?)
  `).run(
    LOCAL_STATE_SCHEMA_VERSION,
    validateTimestamp(timestamp, "schema timestamp"),
  );
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

function validateV1Tables(db: DatabaseSync): void {
  const actualTables = listUserTables(db);
  const expectedTables = (Object.keys(EXPECTED_TABLES) as LocalStateTable[]).sort();
  if (
    actualTables.length !== expectedTables.length
    || actualTables.some((table, index) => table !== expectedTables[index])
  ) {
    throw corruptError("The local team database contains an invalid v1 table set.");
  }
  for (const table of expectedTables) {
    validateTableSemantics(db, table);
  }
}

function validateTableSemantics(
  db: DatabaseSync,
  table: LocalStateTable,
): void {
  const expectedColumns = EXPECTED_TABLES[table];
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
        `Local team table ${table} column ${expected.name} has invalid v1 semantics.`,
      );
    }
  }
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
