/**
 * Finding the entity an operation is about — **index as hint, filesystem as truth.**
 *
 * §11.3 step 2 says "resolve the target index and source file", and §3.8 of the
 * brief says applying with no `wiki.db` is the normal case rather than an error.
 * Both are true, and together they say something the spec does not: **the index
 * cannot be the authority here.** Nothing in production builds one, so a
 * pipeline that needed one would be a pipeline that never runs; and a stale one
 * is worse than none, because it answers confidently and wrongly.
 *
 * So the index is used for exactly what it is good at — turning an id into a
 * *candidate file* in one query instead of a scaffold walk — and every fact the
 * plan is built from comes from re-reading and re-parsing that file. If the
 * candidate turns out not to hold the entity, the index was stale and the walk
 * runs anyway. The answer is therefore identical with a fresh index, a stale
 * index, and no index at all; only the cost differs.
 *
 * **The winner rule is shared, not re-derived.** A duplicate id is a state the
 * index is built to hold (finding 31): both claimants are stored and all but
 * `MIN(entity_key)` are flagged `shadowed`. `entity_key` is
 * `<file>#<zero-padded metadata_start>`, so the winner is the earliest position
 * in the earliest path. The filesystem scan orders candidates by the same key,
 * through the same `entityKeyOf`, because a locator that picked a different
 * claimant than the index reports would target the entity the user cannot see.
 */

import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { EntityMetadataKind, ParsedFile } from "../markdown/contract.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import type { WikiEntity, EntityTypeRegistry } from "../model/entity.js";
import { discoverMarkdownFiles } from "../index/discover.js";
import { entityKeyOf } from "../index/write.js";
import { openWikiIndex } from "../index/open.js";
import { defaultIndexPath, readText } from "../index/rebuild.js";

export interface LocatedEntity {
  /** Scaffold-relative POSIX path. */
  path: string;
  absolutePath: string;
  /** The file text exactly as read. */
  text: string;
  parsed: ParsedFile;
  entity: WikiEntity;
  metadataKind: EntityMetadataKind;
  /** `<file>#<padded metadata_start>`, the same key the index stores. */
  entityKey: string;
}

export interface LocateOptions {
  scaffoldRoot: string;
  indexPath?: string;
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  readFile?: (absolutePath: string) => string;
  /**
   * Look here first, ahead of the index and the walk.
   *
   * Replay's seam. A `move-entry` interrupted between its two renames leaves
   * the entity in **both** files, and the ordinary winner rule — the earliest
   * position in the earliest path — would then pick whichever of the two sorts
   * first, which is the destination about half the time. Resuming the move
   * would then read as "already in that file" and stop with the duplicate
   * still there. The intent line records where the entity started, so a resume
   * pins the locator to it and the move finishes the way it began.
   */
  preferFile?: string;
}

/** Read and parse one scaffold file, or null when it cannot be read. */
export function readParsed(
  options: LocateOptions,
  path: string,
  absolutePath: string,
): { text: string; parsed: ParsedFile } | null {
  const read = options.readFile ?? readText;
  let text: string;
  try {
    text = read(absolutePath);
  } catch {
    return null;
  }
  const parsed = parseWikiMarkdown(
    options.registry === undefined ? { path, text } : { path, text, registry: options.registry },
  );
  return { text, parsed };
}

/** Every claimant of `id` in one parsed file, in position order. */
function claimantsIn(parsed: ParsedFile, id: string): { entity: WikiEntity; kind: EntityMetadataKind }[] {
  return parsed.entities
    .filter((candidate) => candidate.entity.id === id)
    .map((candidate) => ({ entity: candidate.entity, kind: candidate.metadataKind }))
    .sort((left, right) => left.entity.location.metadataStart - right.entity.location.metadataStart);
}

function located(
  path: string,
  absolutePath: string,
  text: string,
  parsed: ParsedFile,
  claimant: { entity: WikiEntity; kind: EntityMetadataKind },
): LocatedEntity {
  return {
    path,
    absolutePath,
    text,
    parsed,
    entity: claimant.entity,
    metadataKind: claimant.kind,
    entityKey: entityKeyOf(path, claimant.entity.location.metadataStart),
  };
}

/** The index's candidate file for `id`, or null when there is no usable index. */
function candidateFromIndex(options: LocateOptions, id: string): string | null {
  const indexPath = options.indexPath ?? defaultIndexPath(resolve(options.scaffoldRoot));
  if (!existsSync(indexPath)) return null;

  // A read never builds one (P3's layering rule), and a failure to open is not
  // an error here: it means the hint is unavailable, and the walk answers.
  const opened = openWikiIndex(indexPath);
  if (!opened.ok) return null;
  try {
    const row = opened.index.db
      .prepare(`SELECT file FROM wiki_entities WHERE id = ? AND shadowed = 0 ORDER BY entity_key LIMIT 1`)
      .get(id) as { file?: string } | undefined;
    return typeof row?.file === "string" ? row.file : null;
  } finally {
    opened.index.close();
  }
}

/**
 * Locate the entity `id` names, or null when the scaffold does not hold it.
 *
 * Never throws, and never writes. An unreadable candidate file falls through to
 * the walk exactly as a stale hint does.
 */
export function locateEntity(id: string, options: LocateOptions): LocatedEntity | null {
  const root = resolve(options.scaffoldRoot);

  const hint = options.preferFile ?? candidateFromIndex(options, id);
  if (hint !== null) {
    const absolute = resolve(root, hint);
    const read = readParsed(options, hint, absolute);
    const claimants = read === null ? [] : claimantsIn(read.parsed, id);
    if (read !== null && claimants.length > 0) {
      return located(hint, absolute, read.text, read.parsed, claimants[0]!);
    }
    // The hint was stale. Fall through rather than reporting "not found": the
    // scaffold is the record, and the index is a cache that may be behind it.
  }

  const discovery = discoverMarkdownFiles({ root, exclude: options.exclude });
  let best: LocatedEntity | null = null;
  for (const file of discovery.files) {
    const read = readParsed(options, file.path, file.absolutePath);
    if (read === null) continue;
    for (const claimant of claimantsIn(read.parsed, id)) {
      const candidate = located(file.path, file.absolutePath, read.text, read.parsed, claimant);
      if (best === null || candidate.entityKey < best.entityKey) best = candidate;
    }
  }
  return best;
}

export interface LocatedFile {
  path: string;
  absolutePath: string;
  /** The file's text, or `""` when the operation is creating it. */
  text: string;
  parsed: ParsedFile;
  existed: boolean;
}

/**
 * Read and parse a target file for a write that may be creating it.
 *
 * Null means the file **exists and could not be read**, which is the one case
 * that must not be treated as "absent, so create it" — that would overwrite a
 * document whose contents nobody could see.
 */
export function locateFile(options: LocateOptions, path: string): LocatedFile | null {
  const absolutePath = resolve(resolve(options.scaffoldRoot), path);
  if (!existsSync(absolutePath)) {
    return { path, absolutePath, text: "", parsed: parseWikiMarkdown({ path, text: "" }), existed: false };
  }
  const read = readParsed(options, path, absolutePath);
  if (read === null) return null;
  return { path, absolutePath, text: read.text, parsed: read.parsed, existed: true };
}
