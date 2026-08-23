/**
 * The only module under `src/wiki/` that mutates the filesystem.
 *
 * Rule (c) in `test/wiki-architecture.test.ts` bans direct writes from the wiki
 * engine so that every change to a `.mex` file goes through the one
 * plan/preview/apply pipeline. Publishing an index still has to rename a
 * database and delete a temp file, which is not a Markdown write — but "not a
 * Markdown write" is exactly what every second writer has claimed, so the
 * exemption is made as narrow as it can be:
 *
 * - it is **one file**, and the lint's allowlist names it;
 * - every mutation goes through {@link assertIndexPath}, which rejects any path
 *   that is not a SQLite index or one of its WAL siblings, so a `.md` path
 *   cannot reach a delete even through a caller's bug;
 * - the guard has its own negative tests.
 *
 * A lint rule cannot see that `unlinkSync(path)` is safe; this guard can, and it
 * fails closed.
 */

import { existsSync, renameSync, rmSync } from "node:fs";
import { basename } from "node:path";

/**
 * Names this module will touch: a SQLite database, one of its WAL/SHM/journal
 * siblings, or a temp database awaiting publish.
 *
 * Deliberately restrictive. Widening it is the same decision as adding a second
 * writer, and should be argued for in a review rather than typed in passing.
 */
const INDEX_FILE_PATTERN = /^[A-Za-z0-9._-]+\.db(?:\.tmp-[0-9a-z]+)?(?:-wal|-shm|-journal)?$/;

export class IndexPathError extends Error {
  constructor(path: string) {
    super(
      `Refusing to touch ${JSON.stringify(path)}: the wiki index may only delete or rename a database file. ` +
        `Everything else in a scaffold is written by the operation pipeline.`,
    );
    this.name = "IndexPathError";
  }
}

/** Throw unless `path` names a database file or one of its siblings. */
export function assertIndexPath(path: string): void {
  if (!INDEX_FILE_PATTERN.test(basename(path))) throw new IndexPathError(path);
}

/**
 * The sidecar files SQLite creates beside a database.
 *
 * A published database whose `-wal` belongs to the *previous* database is a
 * corruption vector, which is why these are enumerated rather than assumed
 * absent.
 */
export function indexSiblingPaths(dbPath: string): string[] {
  return [`${dbPath}-wal`, `${dbPath}-shm`, `${dbPath}-journal`];
}

/** Delete a database and its siblings if they exist. Missing files are fine. */
export function removeIndexFiles(dbPath: string): void {
  for (const path of [dbPath, ...indexSiblingPaths(dbPath)]) {
    assertIndexPath(path);
    rmSync(path, { force: true });
  }
}

/**
 * Move a fully-built database over the live one.
 *
 * The stale siblings of the *target* go first: `rename(2)` replaces `wiki.db`
 * but leaves `wiki.db-wal` behind, and SQLite would then try to recover a WAL
 * belonging to a database that no longer exists. The source's own siblings are
 * cleared before this is called, by checkpointing and closing it.
 *
 * Same-directory renames only — a cross-device rename is a copy, and a copy is
 * not atomic. Callers build the temp database beside the target, and this
 * asserts they did.
 */
export function publishIndexFile(tempPath: string, targetPath: string): void {
  assertIndexPath(tempPath);
  assertIndexPath(targetPath);

  for (const sibling of indexSiblingPaths(targetPath)) rmSync(sibling, { force: true });
  renameSync(tempPath, targetPath);
}

/** True when a database file exists at `path`. */
export function indexExists(path: string): boolean {
  return existsSync(path);
}
