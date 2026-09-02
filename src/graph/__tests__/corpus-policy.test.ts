import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  GRAPH_CORPUS_GLOB_OPTIONS,
  GRAPH_CORPUS_LIMITS,
  GraphCorpusLimitError,
  addGraphCompilerSourceBytes,
  addGraphCorpusBytes,
  addGraphSemanticInput,
  createGraphSemanticInputLedger,
  discoverBoundedGraphPaths,
} from "../corpus-policy.js";

const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function fixture(files: readonly string[]): string {
  const root = mkdtempSync(join(tmpdir(), "mex-graph-corpus-policy-"));
  roots.push(root);
  for (const path of files) {
    const absolute = join(root, path);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, "export const value = true;\n", "utf8");
  }
  return root;
}

describe("graph corpus policy", () => {
  it("discovers deterministically without materializing beyond the file ceiling", () => {
    const root = fixture(["src/z.ts", "src/a.ts"]);
    const options = { ...GRAPH_CORPUS_GLOB_OPTIONS, cwd: root };

    expect(discoverBoundedGraphPaths("src/**/*.ts", options, 2)).toEqual([
      "src/a.ts",
      "src/z.ts",
    ]);
    expect(() => discoverBoundedGraphPaths("src/**/*.ts", options, 1))
      .toThrow(GraphCorpusLimitError);
  });

  it("rejects per-file and aggregate byte overflows", () => {
    expect(() => addGraphCorpusBytes(
      0,
      GRAPH_CORPUS_LIMITS.maxSourceFileBytes + 1,
      "source",
    )).toThrow(GraphCorpusLimitError);
    expect(() => addGraphCorpusBytes(
      GRAPH_CORPUS_LIMITS.maxSourceBytes,
      1,
      "source",
    )).toThrow(GraphCorpusLimitError);
    expect(() => addGraphCompilerSourceBytes(
      GRAPH_CORPUS_LIMITS.maxCompilerSourceBytes,
      1,
    )).toThrow("maxCompilerSourceBytes");
  });

  it("shares hard path and byte ceilings for indirect compiler inputs", () => {
    const byteLedger = createGraphSemanticInputLedger();
    const fullFiles = GRAPH_CORPUS_LIMITS.maxSemanticInputBytes
      / GRAPH_CORPUS_LIMITS.maxSourceFileBytes;
    for (let index = 0; index < fullFiles; index += 1) {
      addGraphSemanticInput(
        byteLedger,
        `config/${index}.json`,
        GRAPH_CORPUS_LIMITS.maxSourceFileBytes,
      );
    }
    expect(() => addGraphSemanticInput(byteLedger, "config/next.json", 1))
      .toThrow("maxSemanticInputBytes");

    const pathLedger = createGraphSemanticInputLedger();
    for (let index = 0; index < GRAPH_CORPUS_LIMITS.maxSemanticInputFiles; index += 1) {
      addGraphSemanticInput(pathLedger, `missing/${index}.json`, null);
    }
    expect(() => addGraphSemanticInput(pathLedger, "missing/overflow.json", null))
      .toThrow("maxSemanticInputFiles");

    const coveredProbeLedger = createGraphSemanticInputLedger();
    for (let index = 0; index <= GRAPH_CORPUS_LIMITS.maxSemanticInputFiles; index += 1) {
      addGraphSemanticInput(coveredProbeLedger, `missing/${index}.ts`, null, false);
    }
    expect(coveredProbeLedger.semanticPaths.size).toBe(0);
  });
});
