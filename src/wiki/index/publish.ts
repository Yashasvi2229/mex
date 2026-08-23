/**
 * Making a rebuilt index live, without a reader ever seeing half of one.
 *
 * The rule is one `rename(2)` in one directory. A reader either opens the old
 * database or the new one; there is no moment at which `wiki.db` is a database
 * with some of its rows. Building in place would give exactly that moment, and
 * it would last the whole rebuild.
 *
 * Three details are load-bearing and none of them are obvious:
 *
 * **Same directory.** A rename across devices is a copy plus a delete, and a
 * copy is not atomic. The temp database is created beside its target, and
 * `dbfile.ts` refuses paths that are not database files at all.
 *
 * **Checkpoint before close.** A WAL database's committed rows live partly in
 * `wiki.db-wal`. Renaming the database alone would publish a file missing its
 * most recent transactions, and leave a `-wal` beside it belonging to a
 * database that no longer exists — which SQLite may try to recover into the
 * new one. `wal_checkpoint(TRUNCATE)` folds the WAL back in first, and the
 * target's stale siblings are removed as part of the rename.
 *
 * **Temp files never outlive a run.** A crashed build leaves `wiki.db.tmp-…`
 * behind; the next build sweeps them before starting, so a half-built database
 * can never be mistaken for a real one and disk usage cannot grow without
 * bound.
 */

import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { readdirSync } from "node:fs";
import type { WikiIndexHandle } from "./open.js";
import { createWikiIndex } from "./open.js";
import { publishIndexFile, removeIndexFiles } from "./dbfile.js";

/** A temp database beside `targetPath`, ready to be built into. */
export function createPendingIndex(targetPath: string): { handle: WikiIndexHandle; tempPath: string } {
  const tempPath = `${targetPath}.tmp-${randomBytes(6).toString("hex")}`;
  return { handle: createWikiIndex(tempPath), tempPath };
}

/**
 * Fold the WAL back into the database, close it, and rename it into place.
 *
 * After this the handle is closed whether it succeeded or not — a caller
 * holding an open handle to a file that has been renamed is a subtle way to
 * keep a deleted database alive on Windows.
 */
export function publishPendingIndex(handle: WikiIndexHandle, tempPath: string, targetPath: string): void {
  try {
    handle.db.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    handle.close();
  }
  publishIndexFile(tempPath, targetPath);
}

/** Drop a temp database that will not be published. */
export function discardPendingIndex(handle: WikiIndexHandle, tempPath: string): void {
  try {
    handle.close();
  } finally {
    removeIndexFiles(tempPath);
  }
}

/**
 * Remove temp databases left behind by a crashed build.
 *
 * Matched by name against the target, so a sweep for `wiki.db` cannot delete
 * something belonging to another database in the same directory.
 */
export function sweepPendingIndexes(targetPath: string): string[] {
  const directory = dirname(targetPath);
  const prefix = `${basename(targetPath)}.tmp-`;
  let entries: string[];
  try {
    entries = readdirSync(directory);
  } catch {
    return [];
  }

  const swept: string[] = [];
  for (const entry of entries.sort()) {
    if (!entry.startsWith(prefix)) continue;
    // Skip the WAL/SHM siblings; removeIndexFiles takes them with the database.
    if (/-(wal|shm|journal)$/.test(entry)) continue;
    removeIndexFiles(join(directory, entry));
    swept.push(entry);
  }
  return swept;
}
