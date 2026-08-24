import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { inventoryScaffold, fileAt, type InventoryFile } from "../inventory.js";
import {
  classifyFile,
  isSubstantial,
  orderForAdoption,
  proseWeight,
  roleFor,
  sectionTextOf,
  SUBSTANTIAL_SECTION_LINES,
  SUBSTANTIAL_SECTION_WORDS,
  type Candidate,
} from "../classify.js";
import { parseWikiMarkdown } from "../../markdown/codec.js";
import { parseDocument } from "../../markdown/parse.js";

const CORPUS = resolve(__dirname, "..", "..", "..", "..", "test", "fixtures", "wiki-migration", "tier1");

const inventory = inventoryScaffold({ scaffoldRoot: CORPUS });

function classified(path: string) {
  const file = fileAt(inventory, path);
  if (file === undefined) throw new Error(`${path} not in the inventory`);
  return classifyFile(file);
}

function inline(text: string, path = "context/architecture.md"): InventoryFile {
  return { path, absolutePath: path, text, parsed: parseWikiMarkdown({ path, text }), headings: parseDocument(text).headings };
}

describe("inventory", () => {
  it("reads every corpus file exactly once, in a deterministic order", () => {
    expect(inventory.files.length).toBe(25);
    expect(inventory.diagnostics).toEqual([]);
    const again = inventoryScaffold({ scaffoldRoot: CORPUS });
    expect(again.files.map((file) => file.path)).toEqual(inventory.files.map((file) => file.path));
  });

  it("carries headings from the codec's own AST seam, not a regex", () => {
    const decisions = fileAt(inventory, "context/decisions.md");
    expect(decisions?.headings.map((heading) => heading.depth)).toEqual([1, 2, 3, 3, 3, 3]);
  });

  it("reports an unreadable file rather than throwing", () => {
    const result = inventoryScaffold({
      scaffoldRoot: CORPUS,
      readFile: (path) => {
        if (path.endsWith("SYNC.md")) throw new Error("EACCES");
        return "";
      },
    });
    expect(result.files.length).toBe(24);
    expect(result.diagnostics.map((entry) => entry.code)).toEqual(["WIKI_PARSE_ERROR"]);
  });
});

describe("the substantiality threshold", () => {
  it("is exported, and both sides of it are real", () => {
    const thin = "\nOne short line.\n";
    const thick = `\n${"Words enough to make a claim that stands on its own and reads as a claim. ".repeat(2)}\nA second line here.\nAnd a third line here.\n`;
    expect(isSubstantial(thin)).toBe(false);
    expect(isSubstantial(thick)).toBe(true);
    expect(proseWeight(thin).lines).toBeLessThan(SUBSTANTIAL_SECTION_LINES);
    expect(proseWeight(thick).words).toBeGreaterThanOrEqual(SUBSTANTIAL_SECTION_WORDS);
  });

  it("does not count headings or fenced code as prose", () => {
    const section = "\n```\nlots of code words here and here and here and here and here and here\nmore code lines\nand more\n```\n";
    expect(proseWeight(section)).toEqual({ lines: 0, words: 0 });
  });

  it("abstains on a thin section rather than making an entity of it", () => {
    const file = inline(`---\nname: architecture\n---\n\n# A\n\n## Thin\n\nOne line.\n`);
    const result = classifyFile(file);
    expect(result.candidates.map((candidate) => candidate.target)).toEqual([{ at: "file" }]);
    expect(result.abstentions.map((entry) => entry.target)).toEqual([
      { at: "heading", ordinal: 1, text: "Thin", depth: 2, start: file.text.indexOf("## Thin") },
    ]);
    expect(result.abstentions[0]?.reason).toContain("not to create an entity for every paragraph");
  });
});

describe("classification over the corpus", () => {
  it("adopts the architecture file and its four components", () => {
    const result = classified("context/architecture.md");
    expect(result.candidates.map((candidate) => `${candidate.type}:${candidate.title}`)).toEqual([
      "component:Ingest",
      "component:Threading",
      "component:Routing",
      "component:Delivery",
      "architecture:architecture",
    ]);
    expect(result.abstentions).toEqual([]);
  });

  it("makes a decision of a log entry, and abstains on the log itself", () => {
    const result = classified("context/decisions.md");
    expect(result.candidates.map((candidate) => candidate.title)).toEqual([
      "Store raw mail before parsing it",
      "One queue owns a ticket",
      "Queue rules are data, not code",
      "Use a single outbound sender",
    ]);
    expect(result.candidates.every((candidate) => candidate.type === "decision")).toBe(true);
    expect(result.abstentions.map((entry) => (entry.target?.at === "heading" ? entry.target.text : null))).toEqual([
      "Decision Log",
    ]);
  });

  it("abstains on a decision-log entry with no decision marker", () => {
    const file = inline(
      `---\nname: decisions\n---\n\n# D\n\n## Decision Log\n\n### A real one\n\n**Decision:** we did the thing.\n**Reasoning:** because.\n\n### Just a note\n\nSome prose that expresses no decision at all, at some length.\n`,
      "context/decisions.md",
    );
    const result = classifyFile(file);
    expect(result.candidates.map((candidate) => candidate.title)).toEqual(["A real one"]);
    expect(result.abstentions.map((entry) => (entry.target?.at === "heading" ? entry.target.text : null))).toEqual([
      "Decision Log",
      "Just a note",
    ]);
  });

  it("makes a pattern file one entity and leaves its sections alone", () => {
    const result = classified("patterns/add-queue-rule.md");
    expect(result.candidates.map((candidate) => candidate.target.at)).toEqual(["file"]);
    expect(result.candidates[0]?.type).toBe("pattern");
    expect(result.abstentions).toEqual([]);
  });

  it("gives a risk register no file-level entity, only its risks", () => {
    const result = classified("context/risks.md");
    expect(result.candidates.map((candidate) => candidate.target.at)).toEqual(["heading", "heading", "heading"]);
    expect(result.candidates.every((candidate) => candidate.type === "risk")).toBe(true);
  });

  it("abstains on a file no rule covers, and says why", () => {
    const result = classified("context/stack.md");
    expect(result.candidates).toEqual([]);
    expect(result.abstentions).toEqual([
      expect.objectContaining({ file: "context/stack.md", target: null }),
    ]);
    expect(result.abstentions[0]?.reason).toContain("No classification rule covers");
    expect(roleFor("context/stack.md")).toBeNull();
  });

  it("skips navigation and generated files", () => {
    for (const path of ["ROUTER.md", "AGENTS.md", "SETUP.md", "SYNC.md", "patterns/README.md", "patterns/INDEX.md"]) {
      const result = classified(path);
      expect(result.skipped, path).toBe(true);
      expect(result.candidates, path).toEqual([]);
    }
  });

  it("skips a file that already carries entity metadata", () => {
    const file = inline(`---\nname: architecture\nmex:\n  id: mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD\n  type: architecture\n  status: promoted\n  revision: 1\n  title: A\n---\n\n# A\n\nProse.\n`);
    const result = classifyFile(file);
    expect(result.skipped).toBe(true);
    expect(result.skipReason).toBe("already carries entity metadata");
  });

  it("classifies the whole corpus into a stable, non-empty set", () => {
    const all = inventory.files.map((file) => classifyFile(file));
    const candidates = all.flatMap((entry) => entry.candidates);
    const abstentions = all.flatMap((entry) => entry.abstentions);
    // A "prose unchanged" property over a corpus nothing was written to would
    // pass for the wrong reason, so the count is pinned here.
    expect(candidates.length).toBe(4 + 1 + 4 + 4 + 1 + 4 + 1 + 3 + 13);
    expect(abstentions.length).toBeGreaterThan(0);
    expect(all.filter((entry) => entry.skipped).length).toBe(6);
  });
});

describe("adoption order", () => {
  it("puts the deepest, latest heading first and the file-level entity last", () => {
    const candidates = classified("context/architecture.md").candidates;
    const ordered = orderForAdoption(candidates);
    expect(ordered.map((candidate) => candidate.title)).toEqual([
      "Delivery",
      "Routing",
      "Threading",
      "Ingest",
      "architecture",
    ]);
  });

  it("adopts a nested `###` before the `##` that contains it", () => {
    const file = inline(
      `---\nname: decisions\n---\n\n# D\n\n## Decision Log\n\n### One\n\n**Decision:** a.\n**Reasoning:** b.\n`,
      "context/decisions.md",
    );
    const container: Candidate = {
      file: "context/decisions.md",
      target: { at: "heading", ordinal: 1, text: "Decision Log", depth: 2, start: file.text.indexOf("## Decision Log") },
      type: "architecture",
      title: "Decision Log",
      rule: "hypothetical",
    };
    const ordered = orderForAdoption([container, ...classifyFile(file).candidates]);
    expect(ordered.map((candidate) => candidate.title)).toEqual(["One", "Decision Log"]);
  });
});

describe("scaffold walking", () => {
  it("honours wiki.exclude rather than walking around it", () => {
    const root = mkdtempSync(join(tmpdir(), "mig-exclude-"));
    for (const path of ["context/architecture.md", "vendor/thing.md"]) {
      const absolute = join(root, path);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileSync(absolute, "# x\n", "utf-8");
    }
    const result = inventoryScaffold({ scaffoldRoot: root, exclude: ["vendor/**"] });
    expect(result.files.map((file) => file.path)).toEqual(["context/architecture.md"]);
  });
});

describe("section extents", () => {
  it("stops a section at the next heading of equal or shallower depth", () => {
    const file = inline(`# A\n\nintro\n\n## One\n\nalpha\n\n### Deep\n\nbeta\n\n## Two\n\ngamma\n`);
    expect(sectionTextOf(file, 1)).toContain("alpha");
    expect(sectionTextOf(file, 1)).toContain("beta");
    expect(sectionTextOf(file, 1)).not.toContain("gamma");
    expect(sectionTextOf(file, 2)).toContain("beta");
    expect(sectionTextOf(file, 2)).not.toContain("gamma");
  });
});
