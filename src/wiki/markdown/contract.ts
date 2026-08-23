import type { WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import type { WikiEntity, EntityTypeRegistry } from "../model/entity.js";
import type { WikiGrounding } from "../model/grounding.js";
import type { LabeledRange, SourceRange } from "./ranges.js";

/**
 * The Markdown codec's read-side contract.
 *
 * Types and a throwing stub. The parser itself is the next phase; this file
 * exists so the oracle — the fixture corpus and its hand-derived expectations —
 * can be written against a fixed interface by someone who cannot shape that
 * interface around an implementation.
 *
 * ## Rules the implementation must satisfy
 *
 * **Positions.** Every offset is a UTF-16 code-unit index into the decoded text.
 * Files are read with `readFileSync(path, "utf-8")` and never as a Buffer.
 *
 * **Binding.** An entity's metadata is either a `mex` key in YAML frontmatter
 * (file-level) or a `<!-- mex:entity ... -->` HTML comment (block-level). A
 * comment binds to the *next* heading, with only blank lines permitted between
 * the two; anything else makes it unbound, which is a diagnostic rather than a
 * guess. Two metadata blocks binding to one heading is an error.
 *
 * **A `mex:entity` comment inside a fenced code block, an indented code block,
 * or an HTML block is content, not metadata.** This is the single most likely
 * parser bug.
 *
 * **Body extent.** A body runs from the end of its heading to whichever comes
 * first: the next heading of equal or shallower depth, the start of the next
 * entity's metadata, or end of file. Deeper headings belong to the body.
 *
 * The "next entity's metadata" clause is not in the original spec, which
 * mentions only heading depth. It is forced by the partition property: a
 * file-level entity's body would otherwise swallow the block entities inside it
 * and the ranges would overlap. See the mixed-entity fixture.
 *
 * **Identity.** Renaming a heading does not change an entity's id. Moving
 * metadata together with its heading preserves identity.
 */

/** Where an entity's metadata came from. */
export type EntityMetadataKind = "frontmatter" | "comment";

export interface ParsedEntity {
  /**
   * The entity, with `location` populated.
   *
   * `location.metadataStart/End` covers the `mex:` key's own range for a
   * file-level entity — not the whole frontmatter block, whose other keys belong
   * to a gap — and the whole comment including its delimiters for a block-level
   * entity.
   */
  entity: WikiEntity;
  metadataKind: EntityMetadataKind;
}

/** An inline `mex://<nodeId>` link. */
export interface ParsedAnchor {
  nodeId: string;
  /** Range of the complete Markdown link, so a rewrite can preserve link text. */
  range: SourceRange;
  /** The entity whose body contains it, or null when it sits outside every entity. */
  entityId: EntityId | null;
}

/** A legacy root-level `edges` entry, preserved verbatim for a later phase. */
export interface LegacyEdge {
  target: string;
  condition?: string;
}

export interface ParsedFrontmatter {
  /** The whole block including both `---` delimiters. */
  range: SourceRange;
  /** Top-level keys in document order, so a writer can preserve that order. */
  keys: string[];
  /** Range of the `mex` key and its value, or null when absent. */
  mexKeyRange: SourceRange | null;
}

/**
 * Legacy root-level fields.
 *
 * Read but not interpreted. On a multi-entity file a root `grounds_to` is
 * genuinely ambiguous — it cannot be attributed to a section without guessing —
 * so it is preserved here and reported, never assigned.
 */
export interface ParsedLegacy {
  groundsTo: WikiGrounding[];
  edges: LegacyEdge[];
}

export interface ParsedFile {
  /** Scaffold-relative path, POSIX separators. */
  path: string;
  /** The decoded text exactly as read, including any BOM and original line endings. */
  text: string;
  entities: ParsedEntity[];
  /**
   * Regions belonging to no entity: prose between entities, frontmatter keys
   * other than `mex`, and trailing content.
   *
   * Explicit rather than inferred so the partition property is checkable —
   * without it, "the rest of the file" is unverifiable.
   */
  gaps: LabeledRange[];
  anchors: ParsedAnchor[];
  frontmatter: ParsedFrontmatter | null;
  legacy: ParsedLegacy;
  diagnostics: WikiDiagnostic[];
}

export interface ParseOptions {
  /** Scaffold-relative path, used for diagnostics and `location.file`. */
  path: string;
  /** File text, read with `readFileSync(path, "utf-8")`. */
  text: string;
  /** Defaults to the model's default registry. */
  registry?: EntityTypeRegistry;
}

export class NotImplementedError extends Error {
  constructor(what: string) {
    super(`${what} is not implemented yet (P2b-codec).`);
    this.name = "NotImplementedError";
  }
}

/**
 * Parse one Markdown file into entities, gaps, anchors and diagnostics.
 *
 * Never throws on malformed input — a broken file yields diagnostics and
 * whatever could still be read. Throwing would take out a whole
 * `rebuild-index` run for one bad file, and prose must never be lost.
 */
export function parseWikiMarkdown(_options: ParseOptions): ParsedFile {
  throw new NotImplementedError("parseWikiMarkdown");
}

/**
 * Assemble every range in a parsed file, in position order, for the partition check.
 *
 * Implemented rather than stubbed: it is pure bookkeeping over the parse result,
 * it is what the fixture tests call, and having it fixed now means the next
 * builder cannot accidentally redefine what "covered" means.
 */
export function partitionRanges(file: ParsedFile): LabeledRange[] {
  const ranges: LabeledRange[] = [];

  for (let index = 0; index < file.entities.length; index += 1) {
    const { location } = file.entities[index]!.entity;
    if (location === undefined) continue;
    ranges.push({ label: `entities[${index}].metadata`, start: location.metadataStart, end: location.metadataEnd });
    ranges.push({ label: `entities[${index}].heading`, start: location.headingStart, end: location.headingEnd });
    ranges.push({ label: `entities[${index}].body`, start: location.bodyStart, end: location.bodyEnd });
  }

  ranges.push(...file.gaps);

  return ranges.sort((left, right) => (left.start === right.start ? left.end - right.end : left.start - right.start));
}
