/**
 * `wiki.exclude` and `wiki.readOnly` — D10's indexing scope, as config.
 *
 * These load on the path of *every* mex command, including the many that have
 * nothing to do with the wiki. So the interesting cases are not the happy ones:
 * they are the absent key and the hand-edited nonsense, both of which must cost
 * the user a wiki setting rather than the whole CLI.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createConfig,
  findConfig,
  normalizeWikiConfig,
  DEFAULT_WIKI_EXCLUDE,
  DEFAULT_WIKI_READ_ONLY,
} from "../src/config.js";

let root: string;

function scaffoldWith(persisted: string | null): string {
  const mex = join(root, ".mex");
  mkdirSync(mex, { recursive: true });
  mkdirSync(join(root, ".git"), { recursive: true });
  writeFileSync(join(mex, "ROUTER.md"), "# Router\n", "utf-8");
  if (persisted !== null) writeFileSync(join(mex, "config.json"), persisted, "utf-8");
  return root;
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "mex-wiki-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("wiki config", () => {
  it("applies D10's defaults when config.json has no wiki key", () => {
    const config = findConfig(scaffoldWith(JSON.stringify({ aiTools: ["claude"] })));
    expect(config.wiki?.exclude).toEqual([...DEFAULT_WIKI_EXCLUDE]);
    expect(config.wiki?.readOnly).toEqual([...DEFAULT_WIKI_READ_ONLY]);
    // The defaults are the real ones, not an empty list that would exclude and
    // reserve nothing while looking populated.
    expect(config.wiki?.exclude).toEqual(["**/node_modules/**"]);
    expect(config.wiki?.readOnly).toEqual(["team/**", "workstreams/**", "inbox/**", "relays/**"]);
  });

  it("reads both lists when they are present", () => {
    const config = findConfig(
      scaffoldWith(JSON.stringify({ wiki: { exclude: ["drafts/**"], readOnly: ["imported/**"] } })),
    );
    expect(config.wiki?.exclude).toEqual(["drafts/**"]);
    expect(config.wiki?.readOnly).toEqual(["imported/**"]);
  });

  it("degrades to defaults for every malformed shape rather than throwing", () => {
    for (const wiki of ['"yes"', "42", "null", "[]", '{"exclude": "drafts/**"}', '{"exclude": [7, ""]}']) {
      const directory = mkdtempSync(join(tmpdir(), "mex-wiki-config-bad-"));
      try {
        const previous = root;
        root = directory;
        const config = findConfig(scaffoldWith(`{"wiki": ${wiki}}`));
        expect(config.wiki?.exclude, wiki).toEqual([...DEFAULT_WIKI_EXCLUDE]);
        expect(config.wiki?.readOnly, wiki).toEqual([...DEFAULT_WIKI_READ_ONLY]);
        root = previous;
      } finally {
        rmSync(directory, { recursive: true, force: true });
      }
    }
  });

  it("keeps a valid half when the other half is nonsense", () => {
    const config = findConfig(scaffoldWith(JSON.stringify({ wiki: { exclude: ["drafts/**"], readOnly: "team" } })));
    expect(config.wiki?.exclude).toEqual(["drafts/**"]);
    expect(config.wiki?.readOnly).toEqual([...DEFAULT_WIKI_READ_ONLY]);
  });

  it("leaves createConfig backward-compatible, and additive", () => {
    const minimal = createConfig({ projectRoot: root, scaffoldRoot: join(root, ".mex") });
    expect(minimal.projectRoot).toBe(root);
    expect(minimal.aiTools).toEqual([]);
    // Not required of the caller, but always present on the result, so no
    // consumer has to remember what the default was.
    expect(minimal.wiki).toEqual({
      exclude: [...DEFAULT_WIKI_EXCLUDE],
      readOnly: [...DEFAULT_WIKI_READ_ONLY],
    });

    const explicit = createConfig({
      projectRoot: root,
      scaffoldRoot: join(root, ".mex"),
      wiki: { exclude: ["x/**"], readOnly: [] },
    });
    expect(explicit.wiki?.exclude).toEqual(["x/**"]);
    // An empty list is not a way to erase a default: D10 fixes the read-only
    // set deliberately, and P5 rejects writes to it.
    expect(explicit.wiki?.readOnly).toEqual([...DEFAULT_WIKI_READ_ONLY]);
  });

  it("normalizes a partial input without inventing entries", () => {
    expect(normalizeWikiConfig(undefined)).toEqual({
      exclude: [...DEFAULT_WIKI_EXCLUDE],
      readOnly: [...DEFAULT_WIKI_READ_ONLY],
    });
    expect(normalizeWikiConfig({ exclude: ["a/**"] }).exclude).toEqual(["a/**"]);
  });
});
