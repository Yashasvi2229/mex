/**
 * The one seam between the wiki and the code graph.
 *
 * Everything the wiki needs to know about code goes through {@link GroundingGraph}:
 * is this node still there, what does it look like now, and if it is gone, did
 * it move. Three questions, one interface, one implementation that imports
 * `src/graph/`.
 *
 * **Why a single seam rather than importing the engine where it is needed.**
 * P2b learned this the expensive way with AST offsets: `createPositionMap` is
 * the only place a remark position becomes a file offset, because the second
 * place someone writes that conversion is the place the BOM correction is
 * forgotten. The same shape of hazard is here. Resolution has a rule — the
 * canonical reference is in Markdown, the graph's cached baseline is never the
 * oracle — and that rule is enforceable only while there is one door. A second
 * module reaching for `FingerprintStore.getGroundedSource` and comparing its
 * `bodyHash` would be the exact bug, written by someone who had read neither
 * this comment nor the spec.
 *
 * The interface is also what makes {@link resolveGrounding} testable without a
 * real graph, which matters because every row of the resolution table needs a
 * test and three of those rows are reconciliation outcomes that are awkward to
 * provoke in a real repository.
 */

import { serializeFingerprint, deserializeFingerprint } from "../../graph/fingerprint.js";
import { FingerprintStore } from "../../graph/fingerprint-store.js";
import type { GraphEngine } from "../../graph/engine.js";
import type { Reconciler, Resolution } from "../../graph/reconcile.js";
import type { SqliteDatabase } from "../../graph/db/sqlite.js";
import type { GroundingBaseline, GroundingSubject } from "../../graph/grounding.js";
import { asGraphDerived, type GraphDerivedGrounding, type WikiGrounding } from "../model/grounding.js";

/** What resolution knows about one code node, as the wiki sees it. */
export interface GroundedNode {
  id: string;
  /** sha256 of the node's body in *this* checkout, right now. */
  bodyHash: string | null;
  /** Repository-relative path, for display when a reviewer asks where. */
  filePath: string;
  startLine: number;
  endLine: number;
}

/**
 * The graph, reduced to what grounding resolution actually asks of it.
 *
 * Deliberately small and deliberately read-only. Nothing here can write to the
 * graph, so no resolution can turn into a re-grounding by accident — which is
 * what would make drift disappear behind a helpful-looking cache update.
 */
export interface GroundingGraph {
  /** The node under this id, or null when the graph has no such node. */
  getNode(nodeId: string): GroundedNode | null;
  /** The node's serialized fingerprint in this checkout, or null. */
  getFingerprint(nodeId: string): string | null;
  /**
   * Tier-1 miss: try to find where the symbol went, using the fingerprint the
   * entity committed to Markdown.
   *
   * Returns null when the committed fingerprint cannot be decoded, which is a
   * different situation from "we looked and found nothing" and resolves
   * differently.
   */
  reconcile(nodeId: string, committedFingerprint: string): Resolution | null;
  /**
   * The cached baseline for one (subject, node), **for rendering an old-vs-new
   * diff only**.
   *
   * Never consult this to decide whether something drifted. It is re-captured
   * by an ordinary graph rebuild, so a current-against-baseline comparison is a
   * current-against-current comparison and reports `fresh` for code that
   * changed — at exactly the moment the user did the most ordinary thing
   * available to them.
   */
  getBaselineSource(subject: GroundingSubject, nodeId: string): GroundingBaseline | null;
}

/** Build the graph-backed implementation. The only place `src/graph/` is bound in. */
export function createGroundingGraph(
  engine: Pick<GraphEngine, "getNode">,
  reconciler: Reconciler,
  db: SqliteDatabase,
): GroundingGraph {
  const store = new FingerprintStore(db);
  return {
    getNode(nodeId) {
      const node = engine.getNode(nodeId);
      return node === null ? null : {
        id: node.id,
        bodyHash: node.bodyHash ?? null,
        filePath: node.filePath,
        startLine: node.startLine,
        endLine: node.endLine,
      };
    },
    getFingerprint(nodeId) {
      const fingerprint = store.get(nodeId);
      return fingerprint === null ? null : serializeFingerprint(fingerprint);
    },
    reconcile(nodeId, committedFingerprint) {
      const decoded = deserializeFingerprint(committedFingerprint);
      return decoded === null ? null : reconciler.reconcile(nodeId, decoded);
    },
    getBaselineSource(subject, nodeId) {
      return store.getBaseline(subject, nodeId);
    },
  };
}

/**
 * Mint a grounding from live graph output — the only way one is ever created.
 *
 * §12.4: an agent may not invent a node id or a fingerprint. The brand on the
 * return type is the type-level half of that (P0/P1 made a parsed grounding
 * un-assignable to it); this function is the runtime half, and it takes the
 * node id rather than a caller-supplied pair so there is nothing to launder.
 * A node the graph does not have yields null, not a plausible-looking record.
 *
 * `bodyHash` is captured here, always. It is the value drift is later measured
 * against, and a grounding written without it can only ever be checked by the
 * coarser structural comparator.
 */
export function deriveGrounding(
  graph: GroundingGraph,
  nodeId: string,
  extra: Omit<WikiGrounding, "node" | "fingerprint" | "bodyHash"> = {},
): GraphDerivedGrounding | null {
  const node = graph.getNode(nodeId);
  if (node === null) return null;
  const fingerprint = graph.getFingerprint(nodeId);
  if (fingerprint === null) return null;

  const grounding: WikiGrounding = {
    ...extra,
    node: node.id,
    fingerprint,
    ...(node.bodyHash === null ? {} : { bodyHash: node.bodyHash }),
    ...(extra.file === undefined ? { file: node.filePath } : {}),
  };
  return asGraphDerived(grounding, { derivedFromLiveGraph: true });
}
