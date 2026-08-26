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
import { parseDocument, type RawDocument } from "../markdown/parse.js";
import type { WikiEntity, EntityTypeRegistry } from "../model/entity.js";
import { discoverMarkdownFiles } from "../index/discover.js";
import { entityKeyOf } from "../index/write.js";
import { openWikiIndex } from "../index/open.js";
import { defaultIndexPath } from "../index/rebuild.js";
import { readContainedSource } from "../index/source-read.js";

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

/**
 * A parse cache for one batch run — **keyed on the bytes, never on time.**
 *
 * `locateEntity` walks and re-parses the scaffold for every operation whose id
 * the index cannot place, which is every operation in a migration (a pre-wiki
 * scaffold has no index at all). Sixty-five operations over twenty-five files
 * is sixteen hundred parses of the same unchanged prose, and it is why five
 * migration tests time out at vitest's default five seconds.
 *
 * The obvious cache — remember a file until something writes it — buys the
 * speed by taking on an invalidation policy, and an invalidation policy is a
 * thing that can be wrong. P5's guarantee is that locate's answer is identical
 * with a fresh index, a stale index and no index at all, because every fact
 * comes from the current bytes; a cache that hands back yesterday's parse after
 * a write turns that into a lie, silently, in the layer that decides what gets
 * written into a user's files.
 *
 * So this one still reads the file every time and caches only the **parse**,
 * under the exact text it was parsed from. A hit requires the bytes on disk to
 * be byte-for-byte what produced the cached tree, so there is no invalidation
 * to get wrong: a write changes the text, the text no longer matches, and the
 * file is re-parsed. Reading is a `readFileSync` of a few kilobytes; parsing is
 * remark plus binding plus model validation, and it is the cost that matters.
 *
 * Passing no cache leaves the behaviour exactly as it was.
 */
export interface ParseCache {
  entries: Map<string, Map<string, ParsedFile>>;
  /**
   * Raw-AST parses, under the same byte-equality rule.
   *
   * `parseDocument` is a second remark pass over the same text — migration's
   * inventory takes one of each per file — and it is worth remembering for the
   * same reason and on the same terms.
   */
  documents: Map<string, Map<string, RawDocument>>;
  /** Parses avoided. Reported by the migration run and asserted by its tests. */
  hits: number;
  /** Parses performed through this cache. */
  misses: number;
}

/** A fresh cache. One per run; never shared between runs, and never global. */
export function createParseCache(): ParseCache {
  return { entries: new Map(), documents: new Map(), hits: 0, misses: 0 };
}

export interface LocateOptions {
  scaffoldRoot: string;
  indexPath?: string;
  exclude?: readonly string[];
  registry?: EntityTypeRegistry;
  readFile?: (absolutePath: string) => string;
  /**
   * Reuse a parse when the file's bytes are unchanged. See {@link ParseCache}.
   *
   * Scoped to one batch run by the caller that creates it. There is no module
   * state here on purpose: a cache that outlived its run would be a cache
   * nobody could reason about from a call site.
   */
  parseCache?: ParseCache;
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
  let text: string;
  try {
    text = readContainedSource(
      options.scaffoldRoot,
      absolutePath,
      options.readFile === undefined ? {} : { readFile: options.readFile },
    );
  } catch {
    return null;
  }
  return { text, parsed: parseCached(options, path, absolutePath, text) };
}

/**
 * Parse `text` as the file at `absolutePath`, reusing a cached tree when the
 * text is byte-for-byte the text that tree was parsed from.
 *
 * Provenance of the cached tree is deliberately irrelevant: `parseWikiMarkdown`
 * is a pure function of `(path, text, registry)`, so a hit on all three returns
 * the tree the caller would have computed. That is what lets `verifyPlan` store
 * its parse of a plan's *proposed* text — which becomes the file's bytes a
 * moment later, so the next operation to read that file gets a hit instead of
 * re-parsing what this process just parsed.
 */
export function parseCached(
  options: LocateOptions,
  path: string,
  absolutePath: string,
  text: string,
): ParsedFile {
  const cache = options.parseCache;
  let byText: Map<string, ParsedFile> | undefined;
  if (cache !== undefined) {
    const key = cacheKey(absolutePath, path, options.registry);
    byText = cache.entries.get(key);
    if (byText === undefined) {
      byText = new Map();
      cache.entries.set(key, byText);
    }
    const hit = byText.get(text);
    if (hit !== undefined) {
      cache.hits += 1;
      return hit;
    }
  }

  const parsed = parseWikiMarkdown(
    options.registry === undefined ? { path, text } : { path, text, registry: options.registry },
  );
  if (byText !== undefined && cache !== undefined) {
    cache.misses += 1;
    byText.set(text, parsed);
  }
  return parsed;
}

/**
 * Registries are compared by identity, which is enough and is deliberate: two
 * different registry objects may describe the same types, and treating them as
 * interchangeable would be a judgement about equality that nothing else here
 * makes. A duplicate parse is the cost of being wrong in the safe direction.
 */
const registryIds = new WeakMap<object, number>();
let nextRegistryId = 0;

function registryKey(registry: EntityTypeRegistry | undefined): string {
  if (registry === undefined) return "-";
  let id = registryIds.get(registry as unknown as object);
  if (id === undefined) {
    id = (nextRegistryId += 1);
    registryIds.set(registry as unknown as object, id);
  }
  return String(id);
}

/**
 * The whole identity of a parse: where the file is, what it is called, what it
 * held, and which registry read it.
 *
 * The text is part of the key rather than a field compared against one
 * remembered entry, and that is the correction that made the cache worth
 * having. A one-entry-per-path cache thrashes on exactly this pipeline's
 * access pattern: `verifyPlan` parses the proposed text, `revalidate` then
 * re-reads the base text still on disk and evicts it, and the write that lands
 * a moment later leaves the next operation re-parsing the very tree this
 * process built. Keyed by content, both live side by side and neither evicts
 * the other.
 *
 * The separator is U+0000, escaped rather than written literally — a literal
 * one makes the file binary to Git (finding 45). It cannot occur in a path and
 * cannot be produced by a Markdown decode, so no two distinct parses collide.
 */
function cacheKey(absolutePath: string, path: string, registry: EntityTypeRegistry | undefined): string {
  return `${absolutePath}\u0000${path}\u0000${registryKey(registry)}`;
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

/** {@link parseDocument}, memoized on the file's own bytes. See {@link ParseCache}. */
export function parseDocumentCached(cache: ParseCache | undefined, absolutePath: string, text: string): RawDocument {
  let byText: Map<string, RawDocument> | undefined;
  if (cache !== undefined) {
    byText = cache.documents.get(absolutePath);
    if (byText === undefined) {
      byText = new Map();
      cache.documents.set(absolutePath, byText);
    }
    const hit = byText.get(text);
    if (hit !== undefined) {
      cache.hits += 1;
      return hit;
    }
  }
  const document = parseDocument(text);
  if (byText !== undefined && cache !== undefined) {
    cache.misses += 1;
    byText.set(text, document);
  }
  return document;
}
