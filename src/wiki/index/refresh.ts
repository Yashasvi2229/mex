/**
 * Incremental refresh — reparse what changed, re-resolve everything.
 *
 * The update is the easy half. The hard half is **invalidation**, and it is
 * where an incremental index normally starts lying: deleting a file leaves the
 * relations that pointed into it dangling, and adding a file can *resolve* a
 * reference that has been dangling for weeks. Neither shows up as a crash. It
 * shows up as a confidently wrong answer, months later, to a question nobody
 * thinks to check.
 *
 * So this refreshes exactly one thing incrementally — **parsing** — and derives
 * everything else from scratch. `resolveIndexState` is the same function the
 * rebuild calls, over the same rows, so a dangling reference and a resolved one
 * are recomputed on every refresh whether or not the file involved was in the
 * changed set. There is no second resolver to disagree with the first, which is
 * why the determinism test can be expected to hold rather than hoped to.
 *
 * `fileContentHash` decides *whether* to reparse and nothing else (D6). It is a
 * staleness signal, never a correctness precondition: a hash that matches skips
 * work, and a hash that does not match costs a parse. Neither answer can make a
 * wrong row survive, because the row is replaced either way when it is written.
 */

import { resolve } from "node:path";
import { relative } from "node:path";
import { toPosix } from "../../paths.js";
import type { WikiDiagnostic } from "../model/diagnostic.js";
import { fileContentHash } from "../model/hash.js";
import type { EntityTypeRegistry } from "../model/entity.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import { discoverMarkdownFiles, type DiscoveredFile } from "./discover.js";
import { openWikiIndexForWrite } from "./open.js";
import { defaultIndexPath, readText, unreadableFileDiagnostic } from "./rebuild.js";
import {
  deleteFileRows,
  resolveIndexState,
  writeFileDiagnostics,
  writeParsedFile,
  type GroundingResolver,
} from "./write.js";

export interface RefreshOptions {
  scaffoldRoot: string;
  indexPath?: string;
  exclude?: readonly string[];
  /**
   * Paths that changed, absolute or scaffold-relative. A path that no longer
   * exists, or that the exclusions now cover, is removed from the index —
   * "changed" includes "gone".
   */
  changed: readonly string[];
  registry?: EntityTypeRegistry;
  now?: () => string;
  /** Injectable file reader. See `RebuildOptions.readFile` for why it exists. */
  readFile?: (absolutePath: string) => string;
  /**
   * How to resolve grounding health, when the caller has a code graph.
   *
   * Optional because the index must build in a checkout that has none — a
   * fresh clone, CI before `mex graph`, a sandbox. Absent, every grounding's
   * verdict column stays NULL, which is what "nothing looked" is stored as.
   *
   * **A rebuild and a refresh must be given the same resolver or neither**, or
   * their dumps differ for a reason that is not a refresh bug: health depends
   * on code, and code changes without the scaffold changing at all.
   */
  resolveGrounding?: GroundingResolver;
}

export type RefreshResult =
  | {
      ok: true;
      reparsed: string[];
      removed: string[];
      /** Present, indexed, and identical to what is already stored. */
      unchanged: string[];
      diagnostics: WikiDiagnostic[];
    }
  | { ok: false; diagnostic: WikiDiagnostic };

/** Normalize a caller's path to the scaffold-relative POSIX form used as a key. */
export function toScaffoldPath(scaffoldRoot: string, path: string): string {
  const asRelative = toPosix(relative(scaffoldRoot, resolve(scaffoldRoot, path)));
  return asRelative;
}

export function refreshWikiIndex(options: RefreshOptions): RefreshResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  const now = options.now ?? (() => new Date().toISOString());

  const opened = openWikiIndexForWrite(indexPath);
  if (!opened.ok) return { ok: false, diagnostic: opened.diagnostic };
  const { index } = opened;

  try {
    // Re-walk. It costs a readdir per directory and no parsing, and it is what
    // makes the refresh's answer to "what is in this scaffold" identical to the
    // rebuild's — including which files are excluded and which symlinks escape.
    const discovery = discoverMarkdownFiles({ root: scaffoldRoot, exclude: options.exclude });
    const indexable = new Map<string, DiscoveredFile>(discovery.files.map((file) => [file.path, file]));

    const targets = [...new Set(options.changed.map((path) => toScaffoldPath(scaffoldRoot, path)))].sort();

    const reparsed: string[] = [];
    const removed: string[] = [];
    const unchanged: string[] = [];
    const unreadable: WikiDiagnostic[] = [];
    const readFile = options.readFile ?? readText;

    index.db.transaction(() => {
      const storedHash = index.db.prepare(`SELECT content_hash FROM wiki_files WHERE path = ?`);

      for (const path of targets) {
        const file = indexable.get(path);
        if (file === undefined) {
          // Deleted, excluded, or never Markdown. The rows go; the references
          // into them are left to dangle and be reported, not cascaded away.
          deleteFileRows(index.db, path);
          removed.push(path);
          continue;
        }

        let text: string;
        try {
          text = readFile(file.absolutePath);
        } catch (error) {
          // The rows go, and the report stays — attached to this file, so it
          // survives a later refresh of an unrelated one and is cleared by the
          // refresh that finally reads this file successfully. A rebuild
          // derives exactly the same row.
          deleteFileRows(index.db, path);
          const entry = unreadableFileDiagnostic(path, error);
          writeFileDiagnostics(index.db, path, [entry]);
          unreadable.push(entry);
          removed.push(path);
          continue;
        }

        const previous = storedHash.get(path) as { content_hash?: string } | undefined;
        if (previous?.content_hash === fileContentHash(text)) {
          unchanged.push(path);
          continue;
        }

        deleteFileRows(index.db, path);
        writeParsedFile(
          index.db,
          parseWikiMarkdown(
            options.registry === undefined ? { path, text } : { path, text, registry: options.registry },
          ),
          { now: now() },
        );
        reparsed.push(path);
      }

      resolveIndexState(index.db, {
        scaffoldRoot,
        buildKind: "refresh",
        now: now(),
        scaffoldDiagnostics: discovery.diagnostics,
        resolveGrounding: options.resolveGrounding,
      });
    });

    return { ok: true, reparsed, removed, unchanged, diagnostics: [...discovery.diagnostics, ...unreadable] };
  } finally {
    index.close();
  }
}
