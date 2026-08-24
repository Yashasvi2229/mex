/**
 * What is in this scaffold — read once, reasoned about many times.
 *
 * Migration touches every file in a scaffold and asks several different
 * questions of each one, so it reads and parses each exactly once and hands
 * the answers around. Nothing here writes, and nothing here decides: the
 * classifier and the planner both consume this.
 *
 * The walk is P3's `discoverMarkdownFiles`, not a second one. Discovery owns
 * `wiki.exclude`, symlink containment and the diagnostics that come with them
 * (finding 29.9), and a migration that walked the tree itself would disagree
 * with the index about what the scaffold contains.
 */
import { readFileSync } from "node:fs";

import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import { parseDocument, type RawHeading } from "../markdown/parse.js";
import type { ParsedFile } from "../markdown/contract.js";
import { discoverMarkdownFiles } from "../index/discover.js";
import type { EntityTypeRegistry } from "../model/entity.js";

/** One scaffold file, read and parsed. */
export interface InventoryFile {
  /** Scaffold-relative POSIX path. */
  path: string;
  absolutePath: string;
  /** Decoded text exactly as read: BOM, line endings and all. */
  text: string;
  parsed: ParsedFile;
  /**
   * Headings in document order, from the same AST seam the codec uses.
   *
   * Migration adopts *existing* headings, so it needs their offsets and their
   * text. `createPositionMap` is the only AST-to-file seam (finding 20) and
   * `parseDocument` is what goes through it — there is no second one here.
   */
  headings: RawHeading[];
}

export interface ScaffoldInventory {
  root: string;
  files: InventoryFile[];
  /** Discovery and read diagnostics. Parse diagnostics stay on their file. */
  diagnostics: WikiDiagnostic[];
}

export interface InventoryOptions {
  scaffoldRoot: string;
  /** `wiki.exclude` globs. */
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  /** Injectable so a test can make one file unreadable without touching disk. */
  readFile?: (absolutePath: string) => string;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Read and parse every Markdown file under the scaffold root.
 *
 * Deterministic in file order, because everything downstream inherits it: the
 * order operations are planned in decides the order ids are minted in, and an
 * id order that changed between runs would make two migrations of the same
 * tree produce different documents.
 */
export function inventoryScaffold(options: InventoryOptions): ScaffoldInventory {
  const root = options.scaffoldRoot;
  const read = options.readFile ?? ((absolutePath: string) => readFileSync(absolutePath, "utf-8"));
  const discovered = discoverMarkdownFiles(
    options.exclude === undefined ? { root } : { root, exclude: options.exclude },
  );

  const files: InventoryFile[] = [];
  const diagnostics: WikiDiagnostic[] = [...discovered.diagnostics];

  for (const entry of discovered.files) {
    const absolutePath = entry.absolutePath;
    let text: string;
    try {
      text = read(absolutePath);
    } catch (error) {
      diagnostics.push(
        diagnostic("WIKI_PARSE_ERROR", `Could not read ${entry.path}: ${message(error)}`, { file: entry.path }),
      );
      continue;
    }
    const parsed = parseWikiMarkdown(
      options.registry === undefined
        ? { path: entry.path, text }
        : { path: entry.path, text, registry: options.registry },
    );
    files.push({ path: entry.path, absolutePath, text, parsed, headings: parseDocument(text).headings });
  }

  return { root, files, diagnostics };
}

/** Look one file up by scaffold-relative path. */
export function fileAt(inventory: ScaffoldInventory, path: string): InventoryFile | undefined {
  return inventory.files.find((file) => file.path === path);
}
