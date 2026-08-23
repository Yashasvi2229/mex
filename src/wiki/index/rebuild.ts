/**
 * The clean rebuild — §10.3's ten steps, and the reference implementation for
 * everything the index claims to know (D5).
 *
 * **Two passes, always.** Every file is parsed and every entity collected
 * before a single reference is resolved. A one-pass resolver would answer
 * "does this relation target exist" differently depending on whether the target
 * happened to be parsed first, which makes the index a function of directory
 * order rather than of content. The two-pass shape is not an optimization to be
 * traded away later; it is what the determinism test is testing.
 *
 * **Grounding is stored, not resolved.** Step 8 says "resolve code grounding
 * when the graph is available". In this phase the graph is never available:
 * `wiki_groundings` records what Markdown declares and leaves health NULL. P4
 * owns resolution, and a resolver invented here would be a second one to
 * reconcile.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import { diagnostic } from "../model/diagnostic.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import type { ParsedFile } from "../markdown/contract.js";
import { discoverMarkdownFiles } from "./discover.js";
import { createPendingIndex, discardPendingIndex, publishPendingIndex, sweepPendingIndexes } from "./publish.js";
import { resolveIndexState, writeParsedFile } from "./write.js";

/** Default index location: `.mex/wiki.db`, beside the scaffold it indexes. */
export function defaultIndexPath(scaffoldRoot: string): string {
  return resolve(scaffoldRoot, "wiki.db");
}

export interface RebuildOptions {
  /** Absolute path to the scaffold root. */
  scaffoldRoot: string;
  /** Defaults to `<scaffoldRoot>/wiki.db`. */
  indexPath?: string;
  /** Ordered exclusion globs, from `config.wiki.exclude`. */
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  /** Injectable clock, so tests can prove the excluded columns are the only volatile ones. */
  now?: () => string;
}

export interface RebuildResult {
  indexPath: string;
  fileCount: number;
  entityCount: number;
  /** Discovery-level problems only; per-file and set-level ones are in the index. */
  diagnostics: WikiDiagnostic[];
  /** Temp databases left by an earlier crashed build, removed before this one. */
  sweptTempFiles: string[];
}

/** Read a file as text. Never as a Buffer — offsets are UTF-16 units (D2a). */
function readText(absolutePath: string): string {
  return readFileSync(absolutePath, "utf-8");
}

/**
 * Parse every discovered file.
 *
 * The codec never throws, so a malformed file costs its own diagnostics and
 * nothing else. A file that cannot even be *read* is reported and skipped
 * rather than taking the run down: one unreadable file must not cost a user
 * their whole index.
 */
export function parseAll(
  files: readonly { path: string; absolutePath: string }[],
  registry: EntityTypeRegistry | undefined,
): { parsed: ParsedFile[]; diagnostics: WikiDiagnostic[] } {
  const parsed: ParsedFile[] = [];
  const diagnostics: WikiDiagnostic[] = [];

  for (const file of files) {
    let text: string;
    try {
      text = readText(file.absolutePath);
    } catch (error) {
      diagnostics.push(
        diagnostic("WIKI_PARSE_ERROR", `Could not read ${file.path}: ${error instanceof Error ? error.message : String(error)}`, {
          file: file.path,
        }),
      );
      continue;
    }
    parsed.push(parseWikiMarkdown(registry === undefined ? { path: file.path, text } : { path: file.path, text, registry }));
  }

  return { parsed, diagnostics };
}

/**
 * Rebuild the index from Markdown alone and publish it atomically.
 *
 * Delete `wiki.db`, run this, and everything comes back. Nothing is read out of
 * the old index on the way — a rebuild that consulted the thing it is replacing
 * would let a stale row survive forever.
 */
export function rebuildWikiIndex(options: RebuildOptions): RebuildResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const now = options.now ?? (() => new Date().toISOString());

  const sweptTempFiles = sweepPendingIndexes(indexPath);

  // 1-2. Discover, applying exclusions.
  const discovery = discoverMarkdownFiles({ root: scaffoldRoot, exclude: options.exclude });

  // 3. Parse every file.
  const { parsed, diagnostics: readDiagnostics } = parseAll(discovery.files, options.registry);

  const { handle, tempPath } = createPendingIndex(indexPath);
  try {
    handle.db.transaction(() => {
      // 4-5, 7, 9. Per-file projection: entities, relations as written, topics,
      // sources, groundings, full text, and this file's own diagnostics.
      for (const file of parsed) writeParsedFile(handle.db, file, { now: now() });

      // 4-6. The second pass. Every reference is resolved here, over the
      // complete set, never while files are still arriving. Discovery problems
      // go in with it: a symlink that escapes the scaffold is a property of the
      // scaffold, not of any file's row, and re-walking is what clears it.
      resolveIndexState(handle.db, {
        scaffoldRoot,
        buildKind: "rebuild",
        now: now(),
        scaffoldDiagnostics: [...discovery.diagnostics, ...readDiagnostics],
      });
    });

    const fileCount = parsed.length;
    const entityCount = parsed.reduce((total, file) => total + file.entities.length, 0);

    // 10. Make it active.
    publishPendingIndex(handle, tempPath, indexPath);
    return { indexPath, fileCount, entityCount, diagnostics: [...discovery.diagnostics, ...readDiagnostics], sweptTempFiles };
  } catch (error) {
    discardPendingIndex(handle, tempPath);
    throw error;
  }
}
