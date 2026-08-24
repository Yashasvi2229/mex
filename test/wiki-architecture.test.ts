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
    forbids: [
      "src/wiki/operations/",
      "src/wiki/index/rebuild",
      "src/wiki/index/refresh",
      "src/wiki/index/publish",
      "src/wiki/index/dbfile",
    ],
    reason:
      "reads must not depend on writes; a query that can mutate is a query nobody can cache or parallelize, and a read path that can rebuild turns a 10 ms query into a 5 s one at random while hiding that the index was broken",
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
 * Files exempt from the no-re-serialization rule.
 *
 * **Empty, and it stays empty.** `writeGroundings` in `src/markdown.ts` was the
 * one recorded exception: it rewrote the whole frontmatter block through
 * `YAML.stringify`, losing comment placement, quoting style and key order on
 * every grounding write. P2b refactored it onto the scoped
 * `spliceTopLevelKey` primitive, so the exception is gone.
 *
 * A new entry here is not a fix. It is a second writer with different fidelity,
 * which is how byte preservation dies.
 */
const KNOWN_SERIALIZATION_EXCEPTIONS: string[] = [];

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
const WRITE_ALLOWLIST = ["src/wiki/operations/apply.ts", "src/wiki/operations/audit.ts", "src/wiki/index/dbfile.ts"];

const WRITE_CALLS =
  /\b(writeFileSync|appendFileSync|createWriteStream|writeFile|appendFile|rmSync|unlinkSync|renameSync|truncateSync)\s*\(/g;

/** Source with comments removed, so a rule reads code and not prose about it. */
function withoutComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/**
 * The database module's exemption, narrowed to what it is actually for.
 *
 * `src/wiki/index/dbfile.ts` renames a rebuilt index into place and deletes the
 * temp file a crashed build left behind. Neither is a Markdown write — but "it
 * is not really a Markdown write" is what every second writer has claimed, so
 * the exemption carries its own rule: the module routes every mutation through
 * a runtime guard that rejects any path which is not a database file, and it
 * may not name a Markdown path at all.
 *
 * A lint rule cannot tell that `rmSync(path)` is safe. The guard can, and it
 * fails closed. This asserts the guard is still there, and still in front of
 * everything.
 */
export function findGuardedDatabaseWriteViolations(path: string, source: string): string[] {
  if (!WRITE_ALLOWLIST.includes(path) || !path.startsWith("src/wiki/index/")) return [];

  const violations: string[] = [];
  const code = withoutComments(source);
  const mutations = [...code.matchAll(WRITE_CALLS)].length;
  const guards = [...code.matchAll(/\bassertIndexPath\s*\(/gu)].length;
  if (mutations > 0 && guards < mutations) {
    violations.push(
      `${path} performs ${mutations} filesystem mutations but calls assertIndexPath ${guards} times — every mutation must be guarded`,
    );
  }
  if (/["'`][^"'`]*\.mdx?["'`]/.test(code)) {
    violations.push(`${path} names a Markdown path — the database module may only touch database files`);
  }
  return violations;
}

export function findScaffoldWriteViolations(path: string, source: string): string[] {
  if (!path.startsWith("src/wiki/") || WRITE_ALLOWLIST.includes(path)) return [];
  return [...source.matchAll(WRITE_CALLS)].map(
    (match) =>
      `${path} calls ${match[1]} — all writes go through the operation pipeline so write-scope enforcement and the audit log cannot be bypassed`,
  );
}

// -- Rule (d): one door onto the code graph ----------------------------------

/**
 * The wiki reaches the code graph through exactly one module.
 *
 * `src/wiki/grounding/adapter.ts` binds `GraphEngine`, the `Reconciler` and
 * `FingerprintStore` into an interface, and everything else works against that
 * interface. The reason is the rule the adapter's callers have to obey and
 * cannot be reminded of at every call site: the drift oracle is the reference
 * committed in Markdown, and `graph.db`'s cached `body_hash` is never the
 * primary signal, because a graph rebuild re-captures it and the comparison
 * silently becomes current-against-current.
 *
 * That rule is enforceable while there is one door and unenforceable once there
 * are several. This is the same discipline P2b's `createPositionMap` has for
 * AST offsets, and for the same reason: the second implementation is where the
 * correction gets forgotten.
 *
 * `src/graph/db/sqlite.ts` is exempt because it is not the graph — it is the
 * SQLite adapter D8 says the wiki index shares, and `wiki.db` is opened with
 * it. Importing a database driver tells you nothing about code.
 */
const GRAPH_DOOR = "src/wiki/grounding/adapter.ts";

/**
 * What each file under `src/wiki/` may reach for, beyond the door.
 *
 * Stated per file rather than per directory on purpose. A rule that exempted
 * `src/wiki/grounding/` wholesale would let the next module in that directory
 * bind the engine directly, which is the thing being prevented.
 *
 * - Every wiki file may import the shared SQLite adapter (D8) and the
 *   baseline's value types. Neither carries any knowledge of code: one is a
 *   database driver, the other is two interfaces and a string union.
 * - `query/budget.ts` composes with the graph's own token estimator and budget
 *   ledger, which D10 requires rather than permits — a second budget system is
 *   the failure it avoids.
 * - `grounding/baseline.ts` wraps `FingerprintStore`, the code that has always
 *   owned the one baseline table. D1's whole point is that it stays the only
 *   one, so wrapping it is the compliance, not the violation. It may reach for
 *   that and nothing else.
 */
const GRAPH_IMPORT_ALLOWANCES: ReadonlyArray<{ file: string | null; allows: string }> = [
  { file: null, allows: "src/graph/db/sqlite" },
  { file: null, allows: "src/graph/grounding" },
  { file: "src/wiki/query/budget.ts", allows: "src/graph/agent-protocol" },
  { file: "src/wiki/grounding/baseline.ts", allows: "src/graph/fingerprint-store" },
];

export function findGraphSeamViolations(path: string, source: string): string[] {
  if (!path.startsWith("src/wiki/")) return [];
  if (path === GRAPH_DOOR) return [];
  const allowed = (resolved: string): boolean =>
    GRAPH_IMPORT_ALLOWANCES.some(
      (allowance) => (allowance.file === null || allowance.file === path) && resolved.startsWith(allowance.allows),
    );
  return importSpecifiers(source)
    .map((specifier) => resolveSpecifier(path, specifier))
    .filter((resolved) => resolved.startsWith("src/graph/"))
    .filter((resolved) => !allowed(resolved))
    .map((resolved) => `${path} imports ${resolved}; the code graph is reached through ${GRAPH_DOOR}`);
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

describe("one door onto the code graph", () => {
  it("holds across src/wiki/", () => {
    expect(FILES.flatMap((path) => findGraphSeamViolations(path, read(path)))).toEqual([]);
  });

  it("checks a file list that actually contains the door", () => {
    // Vacuity guard with teeth: renaming the adapter away must fail this rule
    // rather than satisfy it by leaving nothing to check.
    expect(FILES).toContain(GRAPH_DOOR);
    expect(read(GRAPH_DOOR)).toContain("from \"../../graph/engine.js\"");
  });

  it("catches a second seam, and permits the shared SQLite adapter", () => {
    expect(
      findGraphSeamViolations("src/wiki/query/for-code.ts", 'import { createGraphEngine } from "../../graph/engine-impl.js";'),
    ).toHaveLength(1);
    expect(
      findGraphSeamViolations("src/wiki/index/write.ts", 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toHaveLength(1);
    // The type-only import of the row shapes is still a graph import and still
    // banned; only the database driver and the baseline's own value types pass.
    expect(
      findGraphSeamViolations("src/wiki/index/write.ts", 'import type { SqliteDatabase } from "../../graph/db/sqlite.js";'),
    ).toEqual([]);
    expect(
      findGraphSeamViolations("src/wiki/grounding/baseline.ts", 'import type { GroundingSubject } from "../../graph/grounding.js";'),
    ).toEqual([]);
    // The door itself may import whatever it needs.
    expect(
      findGraphSeamViolations(GRAPH_DOOR, 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toEqual([]);
    // A per-file allowance is exactly that: baseline.ts may wrap the store and
    // may not bind the engine, and no other file inherits its allowance.
    expect(
      findGraphSeamViolations("src/wiki/grounding/baseline.ts", 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toEqual([]);
    expect(
      findGraphSeamViolations("src/wiki/grounding/baseline.ts", 'import type { GraphEngine } from "../../graph/engine.js";'),
    ).toHaveLength(1);
    expect(
      findGraphSeamViolations("src/wiki/grounding/resolve.ts", 'import { FingerprintStore } from "../../graph/fingerprint-store.js";'),
    ).toHaveLength(1);
  });

  it("does not constrain code outside the wiki engine", () => {
    expect(
      findGraphSeamViolations("src/drift/checkers/grounding.ts", 'import type { GraphEngine } from "../../graph/engine.js";'),
    ).toEqual([]);
  });
});

describe("no Markdown re-serialization", () => {
  it("holds across the tree apart from the one recorded exception", () => {
    const violations = FILES.flatMap((path) => findSerializationViolations(path, read(path)));
    expect(violations).toEqual([]);
  });

  it("has no recorded exceptions left, and may not grow new ones", () => {
    // The count reached zero when P2b moved `writeGroundings` onto the scoped
    // splice. It may only stay there: a new entry means a second writer that
    // reformats, which is the failure this whole rule exists to prevent.
    expect(KNOWN_SERIALIZATION_EXCEPTIONS).toEqual([]);
    expect(read("src/markdown.ts")).not.toContain("YAML.stringify(");
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

  it("keeps the database module's exemption guarded", () => {
    const violations = FILES.flatMap((path) => findGuardedDatabaseWriteViolations(path, read(path)));
    expect(violations).toEqual([]);
    // The rule needs a subject: if the file is renamed away, this notices
    // rather than passing over nothing.
    expect(FILES).toContain("src/wiki/index/dbfile.ts");
    expect(read("src/wiki/index/dbfile.ts")).toContain("assertIndexPath");
  });

  it("catches an unguarded database write, and a Markdown path in the database module", () => {
    expect(
      findGuardedDatabaseWriteViolations("src/wiki/index/dbfile.ts", "export function f() { rmSync(path); }"),
    ).toHaveLength(1);
    expect(
      findGuardedDatabaseWriteViolations(
        "src/wiki/index/dbfile.ts",
        'export function f() { assertIndexPath(p); rmSync(p); const doc = "ROUTER.md"; }',
      ),
    ).toHaveLength(1);
    expect(
      findGuardedDatabaseWriteViolations(
        "src/wiki/index/dbfile.ts",
        "export function f() { assertIndexPath(p); rmSync(p); }",
      ),
    ).toEqual([]);
    // A word boundary, not an identity escape. `/ssertIndexPath/` matches a
    // literal "assertIndexPath" anywhere, so `xassertIndexPath(` counted as a
    // guard and inflated the count — a rule weakened in the direction that
    // hides violations rather than inventing them.
    expect(
      findGuardedDatabaseWriteViolations("src/wiki/index/dbfile.ts", "export function f() { xassertIndexPath(p); rmSync(p); }"),
    ).toHaveLength(1);
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
