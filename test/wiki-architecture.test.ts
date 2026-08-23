import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, relative, dirname, resolve } from "node:path";

/**
 * Architectural lint for the wiki engine.
 *
 * These three rules exist in phase one rather than in the phases that need
 * them, because each protects a guarantee that dies quietly. A single careless
 * line breaks it, the code still compiles and every test still passes, and the
 * damage only surfaces much later as an acceptance criterion about unrelated
 * bytes. The bans have to precede the code that could violate them.
 *
 * Each rule is a pure function over (path, source) so it can be tested against
 * a planted violation without writing files. A lint test that has never failed
 * is not a test, so every rule below has a negative case.
 */

const REPO_ROOT = resolve(__dirname, "..");
const SRC = join(REPO_ROOT, "src");

/** Repo-relative POSIX paths of every TypeScript file under src/, tests excluded. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "__tests__" || entry.name === "fixtures" || entry.name === "wasm") continue;
        walk(full);
        continue;
      }
      if (!entry.name.endsWith(".ts") || entry.name.endsWith(".d.ts")) continue;
      found.push(relative(REPO_ROOT, full).replace(/\\/g, "/"));
    }
  };
  walk(SRC);
  return found.sort();
}

const FILES = sourceFiles();

function read(path: string): string {
  return readFileSync(join(REPO_ROOT, path), "utf-8");
}

// -- Rule (a): dependency direction ------------------------------------------

/**
 * Layering rules, as a table so a later phase extends it by adding a row.
 *
 * The model layer is pure data and validation. Keeping the filesystem, SQLite
 * and the code graph out of it is what lets the same definitions serve the
 * index, operations, migration, synthesis and the Hub — and what lets wiki
 * reads work in a checkout with no graph at all.
 */
interface LayerRule {
  /** Repo-relative directory the rule applies to. */
  layer: string;
  /** Import prefixes this layer may not reach for. */
  forbids: string[];
  reason: string;
}

const LAYER_RULES: LayerRule[] = [
  {
    layer: "src/wiki/model/",
    forbids: [
      "src/wiki/markdown/",
      "src/wiki/index/",
      "src/wiki/grounding/",
      "src/wiki/operations/",
      "src/wiki/query/",
      "src/wiki/synthesis/",
      "src/wiki/migration/",
      "src/wiki/validation/",
      "src/wiki/cli/",
      "src/graph/",
      "node:fs",
      "node:sqlite",
      "node:child_process",
    ],
    reason: "the model layer is pure data and validation; it must not reach for I/O, the code graph, or any layer above it",
  },
  {
    layer: "src/wiki/query/",
    forbids: ["src/wiki/operations/"],
    reason: "reads must not depend on writes; a query that can mutate is a query nobody can cache or parallelize",
  },
];

/** Import specifiers in a source file: static, type-only, re-export and dynamic. */
export function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const match of source.matchAll(/\bfrom\s*["']([^"']+)["']/g)) found.push(match[1]!);
  for (const match of source.matchAll(/\bimport\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  for (const match of source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/g)) found.push(match[1]!);
  return found;
}

/** Resolve an import specifier to a repo-relative path, or return it unchanged. */
function resolveSpecifier(fromFile: string, specifier: string): string {
  if (!specifier.startsWith(".")) return specifier;
  const resolved = join(dirname(fromFile), specifier).replace(/\\/g, "/");
  // `.js` in ESM source refers to the `.ts` beside it; the prefix match below
  // only cares about the directory, so the extension is left as-is.
  return resolved;
}

export function findLayeringViolations(
  path: string,
  source: string,
  rules: readonly LayerRule[] = LAYER_RULES,
): string[] {
  const violations: string[] = [];
  for (const rule of rules) {
    if (!path.startsWith(rule.layer)) continue;
    for (const specifier of importSpecifiers(source)) {
      const resolved = resolveSpecifier(path, specifier);
      for (const forbidden of rule.forbids) {
        if (resolved === forbidden || resolved.startsWith(forbidden)) {
          violations.push(`${path} imports "${specifier}" — ${rule.reason}`);
        }
      }
    }
  }
  return violations;
}

// -- Rule (b): no re-serialization -------------------------------------------

/**
 * The two primitives permitted to write Markdown text.
 *
 * Forward-looking: neither file exists yet. They are named now so that when the
 * codec is built, the only place a serializer could legally live is already
 * fixed, rather than being argued about under deadline pressure.
 */
const SERIALIZATION_ALLOWLIST = ["src/wiki/markdown/patch.ts", "src/wiki/markdown/frontmatter.ts"];

/**
 * The one violation that exists in the shipped tree.
 *
 * `writeGroundings` rewrites the whole frontmatter block through
 * `YAML.stringify`, losing comment placement, quoting style and key order. It
 * is on a shipped code path with its own tests, so it is not fixed here; P2
 * refactors it onto the scoped `spliceTopLevelKey` primitive and this entry
 * goes away. Listing it explicitly means the count can only go down.
 *
 * TODO(P2): remove once `writeGroundings` moves onto src/wiki/markdown/frontmatter.ts.
 */
const KNOWN_SERIALIZATION_EXCEPTIONS = ["src/markdown.ts"];

export function findSerializationViolations(path: string, source: string): string[] {
  if (SERIALIZATION_ALLOWLIST.includes(path) || KNOWN_SERIALIZATION_EXCEPTIONS.includes(path)) return [];

  const violations: string[] = [];
  if (importSpecifiers(source).some((specifier) => specifier === "remark-stringify")) {
    violations.push(
      `${path} imports remark-stringify — re-serializing an AST reformats unrelated content; splice ranges in the original text instead`,
    );
  }
  // Matches `YAML.stringify(`, `yaml.stringify(` and `stringifyDocument(` style
  // aliases of the same operation over a whole map.
  for (const match of source.matchAll(/\b(?:YAML|yaml)\s*\.\s*stringify\s*\(/g)) {
    violations.push(
      `${path} calls ${match[0].trim()} — rewriting a whole YAML map loses comments, quoting and key order; splice the one key's range instead`,
    );
  }
  return violations;
}

// -- Rule (c): no unscoped scaffold writes -----------------------------------

/**
 * Nothing under `src/wiki/` writes a file directly.
 *
 * Every path that modifies a `.mex` file — operations, migration apply,
 * generated-view regeneration, anchor reconciliation — goes through the one
 * plan/preview/apply pipeline, so that write-scope enforcement and the audit
 * log cannot be bypassed. A second writer is exactly how byte preservation
 * dies.
 */
const WRITE_ALLOWLIST = ["src/wiki/operations/apply.ts", "src/wiki/operations/audit.ts"];

const WRITE_CALLS = /\b(writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|rmSync|unlinkSync)\s*\(/g;

export function findScaffoldWriteViolations(path: string, source: string): string[] {
  if (!path.startsWith("src/wiki/") || WRITE_ALLOWLIST.includes(path)) return [];
  return [...source.matchAll(WRITE_CALLS)].map(
    (match) =>
      `${path} calls ${match[1]} — all writes go through the operation pipeline so write-scope enforcement and the audit log cannot be bypassed`,
  );
}

// -- The rules, applied to the tree ------------------------------------------

describe("wiki layering", () => {
  it("finds source files to check", () => {
    // Guards against the walk silently matching nothing, which would make every
    // assertion below vacuously true.
    expect(FILES.length).toBeGreaterThan(20);
    expect(FILES.filter((path) => path.startsWith("src/wiki/")).length).toBeGreaterThan(5);
  });

  it("keeps the model layer free of I/O, the code graph and higher layers", () => {
    const violations = FILES.flatMap((path) => findLayeringViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("catches a planted layering violation", () => {
    expect(
      findLayeringViolations("src/wiki/model/entity.ts", 'import { openGraphDatabase } from "../../graph/db/database.js";'),
    ).toHaveLength(1);
    expect(findLayeringViolations("src/wiki/model/entity.ts", 'import { readFileSync } from "node:fs";')).toHaveLength(1);
    expect(
      findLayeringViolations("src/wiki/model/entity.ts", 'const mod = await import("../index/rebuild.js");'),
    ).toHaveLength(1);
    expect(findLayeringViolations("src/wiki/query/list.ts", 'import { plan } from "../operations/plan.js";')).toHaveLength(1);
  });

  it("allows what the model layer legitimately needs", () => {
    expect(findLayeringViolations("src/wiki/model/ulid.ts", 'import { randomFillSync } from "node:crypto";')).toEqual([]);
    expect(findLayeringViolations("src/wiki/model/entity.ts", 'import { type EntityId } from "./ids.js";')).toEqual([]);
    // Layers above the model may reach for I/O and the graph.
    expect(findLayeringViolations("src/wiki/index/open.ts", 'import { readFileSync } from "node:fs";')).toEqual([]);
  });
});

describe("no Markdown re-serialization", () => {
  it("holds across the tree apart from the one recorded exception", () => {
    const violations = FILES.flatMap((path) => findSerializationViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("still has exactly one recorded exception, and it is the one we know about", () => {
    // The count may only go down. If P2 has landed and this fails, delete the
    // entry rather than adding another.
    expect(KNOWN_SERIALIZATION_EXCEPTIONS).toEqual(["src/markdown.ts"]);
    expect(read("src/markdown.ts")).toContain("YAML.stringify(frontmatter)");
  });

  it("keeps remark-stringify out of the dependency list entirely", () => {
    const manifest = JSON.parse(read("package.json")) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    expect(Object.keys(manifest.dependencies ?? {})).not.toContain("remark-stringify");
    expect(Object.keys(manifest.devDependencies ?? {})).not.toContain("remark-stringify");
  });

  it("catches a planted re-serialization", () => {
    expect(findSerializationViolations("src/wiki/index/rebuild.ts", 'import remarkStringify from "remark-stringify";')).toHaveLength(1);
    expect(findSerializationViolations("src/wiki/operations/apply.ts", "const text = YAML.stringify(frontmatter);")).toHaveLength(1);
    expect(findSerializationViolations("src/wiki/operations/apply.ts", "const text = yaml.stringify(doc);")).toHaveLength(1);
  });

  it("permits the two primitives that legitimately write Markdown text", () => {
    for (const path of SERIALIZATION_ALLOWLIST) {
      expect(findSerializationViolations(path, "const text = YAML.stringify(value);")).toEqual([]);
    }
  });

  it("does not flag ordinary JSON serialization", () => {
    expect(findSerializationViolations("src/wiki/cli/json.ts", "return JSON.stringify(envelope);")).toEqual([]);
  });
});

describe("no unscoped scaffold writes", () => {
  it("holds across src/wiki/", () => {
    const violations = FILES.flatMap((path) => findScaffoldWriteViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("catches a planted write", () => {
    expect(findScaffoldWriteViolations("src/wiki/migration/apply.ts", 'writeFileSync(path, text);')).toHaveLength(1);
    expect(findScaffoldWriteViolations("src/wiki/migration/generated.ts", 'await writeFile(path, text);')).toHaveLength(1);
    expect(findScaffoldWriteViolations("src/wiki/operations/audit.ts", "appendFileSync(log, line);")).toEqual([]);
  });

  it("does not constrain code outside the wiki engine", () => {
    // The rest of mex has its own writers and is not in scope for this rule.
    expect(findScaffoldWriteViolations("src/setup/scaffold.ts", "writeFileSync(path, text);")).toEqual([]);
  });
});
