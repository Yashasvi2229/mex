/**
 * Scoped frontmatter writes: locate one top-level YAML key's own range and
 * splice only that.
 *
 * This replaces the whole-map rewrite that shipped in `src/markdown.ts`, which
 * ran the parsed frontmatter back through `YAML.stringify` and so lost comment
 * placement, quoting style and key order on every grounding write. Losing a
 * contributor's comments because MEX recorded a code fingerprint is not a
 * cosmetic problem — it makes the diff unreviewable, which is the one thing the
 * Markdown-canonical design exists to protect.
 *
 * Ranges come from `YAML.parseDocument`, whose nodes carry `.range` as
 * `[start, valueEnd, nodeEnd]` into the parsed string. Hand-rolled scanning
 * loses to block scalars, flow collections, anchors and comments; the parser
 * already knows where everything is.
 *
 * This module and `patch.ts` are the only files permitted to render YAML, and
 * even here it is rendering **one key's value**, never a whole map.
 */

import YAML from "yaml";
import { applyEdits, type PatchResult } from "./patch.js";
import { parseDocument, type RawFrontmatter } from "./parse.js";
import { terminatorLengthAt } from "./positions.js";

/** Absolute range of a top-level key and its value, in file offsets. */
export interface KeyRange {
  /** Start of the key token. */
  keyStart: number;
  /** End of the value, with trailing line terminators trimmed off. */
  valueEnd: number;
  /** End including the terminator that closes the key's last line. */
  nodeEnd: number;
}

function trimTrailingBlank(text: string, end: number, floor: number): number {
  let cursor = end;
  while (cursor > floor && /[ \t\r\n]/.test(text.charAt(cursor - 1))) cursor -= 1;
  return cursor;
}

/**
 * Locate a top-level key inside an already-located frontmatter block.
 *
 * The trailing trim matters and is not cosmetic. For a *block* value `yaml`
 * reports `valueEnd` past the closing newline, while for a scalar it stops
 * before it. Left alone, a `mex:` range would swallow the newline separating it
 * from the closing `---`, and the contract's convention — the metadata range
 * covers the key and its value, delimiters are gaps — would quietly break, as
 * would the partition property that depends on it.
 */
export function findTopLevelKeyRange(text: string, frontmatter: RawFrontmatter, key: string): KeyRange | null {
  let document: YAML.Document.Parsed;
  try {
    document = YAML.parseDocument(frontmatter.text);
  } catch {
    return null;
  }
  const contents = document.contents;
  if (!YAML.isMap(contents)) return null;

  for (const item of contents.items) {
    if (!YAML.isScalar(item.key) || item.key.value !== key) continue;
    const keyRange = item.key.range;
    const valueRange = item.value && "range" in item.value ? (item.value.range as [number, number, number]) : null;
    if (!keyRange) return null;

    const keyStart = frontmatter.innerStart + keyRange[0];
    const rawEnd = frontmatter.innerStart + (valueRange ? valueRange[1] : keyRange[1]);
    const valueEnd = trimTrailingBlank(text, Math.min(rawEnd, frontmatter.innerEnd), keyStart);
    return { keyStart, valueEnd, nodeEnd: valueEnd + terminatorLengthAt(text, valueEnd) };
  }
  return null;
}

/** Top-level keys in document order, so a writer can preserve that order. */
export function topLevelKeys(frontmatter: RawFrontmatter): string[] {
  try {
    const contents = YAML.parseDocument(frontmatter.text).contents;
    if (!YAML.isMap(contents)) return [];
    return contents.items
      .map((item) => (YAML.isScalar(item.key) ? String(item.key.value) : null))
      .filter((name): name is string => name !== null);
  } catch {
    return [];
  }
}

/**
 * Render one key and its value as YAML text.
 *
 * Scoped deliberately: this serializes a single-entry map, so the output is the
 * key and its value and nothing else. It can never reformat a neighbour,
 * because a neighbour is never passed in.
 */
export function renderKeyValue(key: string, value: unknown): string {
  return YAML.stringify({ [key]: value }).replace(/\n$/, "");
}

/** The line ending this text uses, so inserted text matches it. */
function dominantTerminator(text: string): string {
  return /\r\n/.test(text) ? "\r\n" : "\n";
}

/**
 * Set a top-level frontmatter key to `valueYaml`, touching nothing else.
 *
 * Three cases, all tested: the key exists and its value range is replaced; the
 * key is absent and is appended inside the existing block; there is no
 * frontmatter block at all and one is created above a byte-identical body.
 */
export function spliceTopLevelKey(content: string, key: string, valueYaml: string): PatchResult {
  const frontmatter = parseDocument(content).frontmatter;
  const eol = dominantTerminator(content);

  if (frontmatter === null) {
    const block = `---${eol}${valueYaml}${eol}---${eol}${content.length > 0 ? eol : ""}`;
    return applyEdits(content, [{ start: 0, end: 0, text: block, label: `create frontmatter for ${key}` }]);
  }

  const existing = findTopLevelKeyRange(content, frontmatter, key);
  if (existing !== null) {
    return applyEdits(content, [
      { start: existing.keyStart, end: existing.valueEnd, text: valueYaml, label: `frontmatter key ${key}` },
    ]);
  }

  // Absent: append at the end of the block. Inserting at `innerEnd` keeps every
  // existing key — and every comment attached to one — exactly where it was.
  const insertAtOffset = frontmatter.innerEnd;
  const needsLeadingBreak = insertAtOffset > frontmatter.innerStart;
  const text = `${needsLeadingBreak ? eol : ""}${valueYaml}`;
  return applyEdits(content, [
    { start: insertAtOffset, end: insertAtOffset, text, label: `insert frontmatter key ${key}` },
  ]);
}

/**
 * Remove a top-level key entirely, leaving no blank-line residue.
 *
 * The removal takes the key's line terminator with it, so neighbours close up
 * without being reflowed.
 */
export function removeTopLevelKey(content: string, key: string): PatchResult {
  const frontmatter = parseDocument(content).frontmatter;
  if (frontmatter === null) return { text: content, declared: [] };

  const existing = findTopLevelKeyRange(content, frontmatter, key);
  if (existing === null) return { text: content, declared: [] };

  // Take the preceding terminator when this is the block's last key, so the
  // block does not end with a stray blank line.
  const isLast = existing.nodeEnd >= frontmatter.innerEnd;
  let start = existing.keyStart;
  if (isLast && start > frontmatter.innerStart) {
    if (content.charCodeAt(start - 1) === 0x0a) start -= 1;
    if (content.charCodeAt(start - 1) === 0x0d) start -= 1;
  }
  const end = isLast ? existing.valueEnd : existing.nodeEnd;

  return applyEdits(content, [{ start, end, text: "", label: `remove frontmatter key ${key}` }]);
}
