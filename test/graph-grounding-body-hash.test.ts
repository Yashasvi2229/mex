/**
 * The grounding change signal has to survive `mex graph rebuild`.
 *
 * `.mex/graph.db` is gitignored and disposable by invariant, and the product
 * offers a rebuild as a routine repair. A drift baseline held only in that file
 * is therefore gone whenever a user takes the repair the product recommends,
 * and it never existed at all for a teammate who cloned. These tests delete the
 * index and rebuild it — the exact thing that used to destroy the baseline —
 * and assert that drift is still detected afterwards.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { MexConfig } from "../src/types.js";
import { runDriftCheckWithGraphStatus } from "../src/drift/index.js";
import { createGraphEngine } from "../src/graph/engine-impl.js";
import { loadGroundingRuntime, refreshGroundingBaselines } from "../src/graph/runtime.js";
import { extractGroundings, writeGroundings } from "../src/markdown.js";
import { serializeFingerprint } from "../src/graph/fingerprint.js";

const roots: string[] = [];

/** The body an agent grounds to, and the one-constant edit that drifts it. */
const ORIGINAL = `export function calculateOrderTotal(items: number[]): number {
  const subtotal = items.reduce((sum, item) => sum + item, 0);
  const tax = subtotal * 0.18;
  const shipping = subtotal > 1000 ? 0 : 75;
  const discount = items.length > 5 ? subtotal * 0.05 : 0;
  return subtotal + tax + shipping - discount;
}
`;
const EDITED = ORIGINAL.replace("subtotal * 0.18", "subtotal * 0.21");

function fixture(): { root: string; source: string; scaffold: string; config: MexConfig } {
  const root = mkdtempSync(join(tmpdir(), "mex-grounding-body-hash-"));
  roots.push(root);
  const source = join(root, "src", "service.ts");
  const scaffold = join(root, ".mex", "context", "architecture.md");
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".mex", "context"), { recursive: true });
  writeFileSync(join(root, ".mex", "ROUTER.md"), "# Router\n");
  writeFileSync(scaffold, "---\nname: architecture\n---\n\n# Architecture\n");
  writeFileSync(source, ORIGINAL);
  return { root, source, scaffold, config: { projectRoot: root, scaffoldRoot: join(root, ".mex"), aiTools: [] } };
}

async function buildGraph(root: string): Promise<void> {
  const engine = createGraphEngine({ rootDir: root });
  await engine.build();
  engine.close();
}

/**
 * Author a grounding the way `mex ground` does: an agent copies the node id and
 * the fingerprint out of graph output and writes nothing else. There is no body
 * hash at this point, because the agent was never given one — which is why the
 * capture pass below is the thing that has to supply it.
 */
async function authorGrounding(
  config: MexConfig,
  scaffold: string,
  symbol: string,
  extra: { bodyHash?: string } = {},
): Promise<string> {
  const runtime = await loadGroundingRuntime(config);
  try {
    const node = runtime!.graph.searchNodes(symbol).find((entry) => entry.kind === "function")!;
    const fingerprint = runtime!.reconciler.getFingerprint(node.id)!;
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), [{
      node: node.id,
      fingerprint: serializeFingerprint(fingerprint),
      ...extra,
    }]));
    return node.id;
  } finally {
    runtime!.close();
  }
}

/**
 * Capture in the posture `mex ground` and setup use.
 *
 * `captureGroundingBaselines` normalizes a missing `updateFingerprints` to
 * `false` before it reaches `refreshGroundingBaselines`, so passing it
 * explicitly is what makes these tests exercise the real command path rather
 * than the looser default a direct caller gets. It matters: `false` is the
 * read-only posture that must never overwrite a hash that has drifted, while
 * `mex sync` passes `true` after an agent pass and re-baselines deliberately.
 */
async function captureBaselines(config: MexConfig, scaffold: string): Promise<void> {
  const runtime = await loadGroundingRuntime(config);
  try {
    refreshGroundingBaselines(config, [scaffold], runtime!, { updateFingerprints: false });
  } finally {
    runtime!.close();
  }
}

/** Delete the disposable index and rebuild it, as `mex graph rebuild` does. */
async function rebuildGraphFromScratch(root: string): Promise<void> {
  rmSync(join(root, ".mex", "graph.db"), { force: true });
  rmSync(join(root, ".mex", "graph.db-wal"), { force: true });
  rmSync(join(root, ".mex", "graph.db-shm"), { force: true });
  await buildGraph(root);
}

async function groundingIssueCodes(config: MexConfig): Promise<string[]> {
  const report = await runDriftCheckWithGraphStatus(config, { graphWarning: () => {} });
  expect(report.graphStatus?.status).toBe("fresh");
  return report.issues.filter((issue) => issue.code.startsWith("GROUNDING_")).map((issue) => issue.code);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("the grounding body hash is committed to Markdown", () => {
  it("captures it into the scaffold, so drift survives deleting and rebuilding graph.db", async () => {
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");

    // What the agent wrote: identity only, no change signal anywhere in Git.
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBeUndefined();

    await captureBaselines(config, scaffold);
    const committed = extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash;
    expect(committed).toBeTypeOf("string");
    expect(committed!.length).toBeGreaterThan(0);

    // The value is the graph's, not an invention of the writer.
    const runtime = await loadGroundingRuntime(config);
    const node = runtime!.graph.getNode(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.node)!;
    expect(committed).toBe(node.bodyHash);
    runtime!.close();

    // The move that used to destroy the baseline, and is offered as a repair.
    writeFileSync(source, EDITED);
    await rebuildGraphFromScratch(root);

    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("reports nothing after the same rebuild when the scaffold carries no hash", async () => {
    // The pre-fix world, reproduced deliberately: this is the defect, and it is
    // also the backward-compatibility case. A grounding with no committed hash
    // parses, resolves and stays silent — no crash, no false drift, and no
    // detection either, which is precisely why the field had to be added.
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBeUndefined();

    writeFileSync(source, EDITED);
    await rebuildGraphFromScratch(root);

    expect(await groundingIssueCodes(config)).toEqual([]);
  }, 60_000);

  it("still detects drift from the graph.db cache for an old grounding with a live index", async () => {
    // The other half of backward compatibility: a scaffold authored before this
    // field existed, whose index was never deleted, must behave exactly as it
    // did. The cache is still consulted when Markdown has nothing to say.
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    await captureBaselines(config, scaffold);

    // Strip the field back out, leaving the graph.db row in place.
    const stripped = extractGroundings(readFileSync(scaffold, "utf-8"))
      .map(({ node, fingerprint }) => ({ node, fingerprint }));
    writeFileSync(scaffold, writeGroundings(readFileSync(scaffold, "utf-8"), stripped));
    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBeUndefined();

    writeFileSync(source, EDITED);
    await buildGraph(root);

    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("backfills a migrated file-level entity, whose grounding lives under the mex map", async () => {
    // The population that surfaced this: a scaffold `wiki migrate` has adopted
    // keeps its groundings under `mex.grounds_to` rather than at the root, and
    // migration's own `backfill` only adds a body hash when it is handed a
    // graph — which the wiki CLI does not do. So the capture pass has to reach
    // this shape too, and it has to splice the one key without disturbing the
    // rest of the map.
    const { root, source, scaffold, config } = fixture();
    writeFileSync(
      scaffold,
      "---\nname: architecture\nmex:\n  id: mx_01ARZ3NDEKTSV4RRFFQ69G5FAA\n  type: pattern\n---\n\n# Architecture\n",
    );
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    await captureBaselines(config, scaffold);

    const after = readFileSync(scaffold, "utf-8");
    expect(after).toContain("mex:");
    expect(after).toContain("id: mx_01ARZ3NDEKTSV4RRFFQ69G5FAA");
    expect(extractGroundings(after)[0]!.bodyHash).toBeTypeOf("string");

    writeFileSync(source, EDITED);
    await rebuildGraphFromScratch(root);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);

  it("does not overwrite a committed hash that has drifted, which would erase the finding", async () => {
    const { root, source, scaffold, config } = fixture();
    await buildGraph(root);
    await authorGrounding(config, scaffold, "calculateOrderTotal");
    await captureBaselines(config, scaffold);
    const baseline = extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash!;

    // Edit the body without touching its structure enough to move the
    // fingerprint, then run the capture pass again. A pass that re-baselined
    // unconditionally would silently adopt the new body as the truth.
    writeFileSync(source, EDITED);
    await buildGraph(root);
    await captureBaselines(config, scaffold);

    expect(extractGroundings(readFileSync(scaffold, "utf-8"))[0]!.bodyHash).toBe(baseline);
    expect(await groundingIssueCodes(config)).toEqual(["GROUNDING_DRIFT"]);
  }, 60_000);
});
