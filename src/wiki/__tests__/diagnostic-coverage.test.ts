/**
 * Diagnostic code coverage, for the whole engine.
 *
 * Lives here rather than beside one layer's tests because the emitters now come
 * from three layers — the model (P0/P1), the Markdown codec (P2b), and the
 * index and query layers (P3). §3c finding 27 accepted keeping this in
 * `model/__tests__/diagnostic.test.ts` while there were two, and named the
 * condition that would flip the decision: emitters from a third layer. This is
 * that third layer, so it moved.
 *
 * The property is unchanged, and is the reason the file exists: the emitted set
 * and the deferred set are **disjoint and together cover the registry exactly**.
 * A code cannot be parked as "not yet emitted" once its check lands, a newly
 * added code cannot be forgotten, and a code cannot be quietly dropped. The
 * deferred list may only shrink.
 */

import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WIKI_DIAGNOSTIC_CODES,
  isWikiDiagnosticCode,
  type WikiDiagnostic,
  type WikiDiagnosticCode,
} from "../model/diagnostic.js";
import {
  createEntityValidator,
  detectRevisionDivergence,
  validateEntity,
  validateEntitySetIdentity,
  type WikiLifecycleState,
} from "../model/entity.js";
import { validateRelationGraph, type RelationSubject, type WikiRelationRef, type WikiRelationType } from "../model/relation.js";
import {
  buildTopicIndex,
  resolveTopicOrDiagnose,
  validateTopicHierarchy,
  validateTopicMembership,
  PARENT_TOPIC_RELATION,
  type TopicSubject,
} from "../model/topic.js";
import { findDuplicateSources, reportUnresolvedSources, validateSource } from "../model/source.js";
import { validateGrounding, verifyGroundingProvenance } from "../model/grounding.js";
import { checkOperationPreconditions, validateOperation, type WikiOperationType } from "../model/operation.js";
import { entityContentHash } from "../model/hash.js";
import { rootContext } from "../model/validate.js";
import { generateEntityId, type EntityId } from "../model/ids.js";
import { entity, grounding, location, ids } from "../model/__tests__/helpers.js";
import { parseWikiMarkdown } from "../markdown/codec.js";
import type { ParsedEntity } from "../markdown/contract.js";
import { detectRangeOverlaps } from "../index/write.js";
import { openWikiIndex } from "../index/open.js";
import { rebuildWikiIndex } from "../index/rebuild.js";
import { getEntity } from "../query/get.js";
import { escapedSymlinkDiagnostic } from "../index/discover.js";

/** Run `body` against a fresh scratch directory, cleaning up afterwards. */
function inScratch<T>(body: (directory: string) => T): T {
  const directory = mkdtempSync(join(tmpdir(), "mex-wiki-coverage-"));
  try {
    return body(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

/**
 * Codes declared in the registry but not yet emitted by any check.
 *
 * They belong to phases that are not built: the Markdown codec, the SQLite
 * index, the grounding adapter, the operations pipeline and migration. They are
 * declared now because the code vocabulary is a published contract and a
 * consumer should be able to match on a code before the check that emits it
 * ships.
 *
 * **This list may only shrink.** The test below asserts it and the emitted set
 * are disjoint and together cover the registry, so a code cannot be quietly
 * parked here after its phase lands, and a newly added code cannot be forgotten.
 */
const NOT_YET_EMITTED: Record<string, string> = {
  GROUNDING_UNRESOLVED: "P4 — grounding resolution against a live graph",
  GROUNDING_STALE: "P4 — grounding resolution against a live graph",
  GROUNDING_MISSING: "P4 — grounding resolution against a live graph",
  SOURCE_FILE_MISSING: "P9 — source validation against the filesystem",
  // P2b associates anchors with entities but cannot compare them against a
  // grounding: the mismatch is only observable once a declared equivalence
  // exists and a live graph can resolve it. That is P9's check, not the
  // codec's, and no corpus fixture asks for it.
  ANCHOR_GROUNDING_MISMATCH: "P9 — anchor/grounding equivalence check",
  AMBIGUOUS_MIGRATION: "P6 — migration classification",
  WRITE_SCOPE_VIOLATION: "P5 — write-scope enforcement",
  INDEX_REFRESH_REQUIRED: "P5 — post-write index refresh",
  MALFORMED_OPERATION_LOG: "P5 — operation audit log",
  GENERATED_VIEW_DRIFT: "P6 — generated views",

};

function codesOf(diagnostics: readonly WikiDiagnostic[]): WikiDiagnosticCode[] {
  return diagnostics.map((entry) => entry.code);
}

function relate(type: WikiRelationType, target: EntityId): WikiRelationRef {
  return { type, target };
}

function subject(id: EntityId, relations: WikiRelationRef[] = [], overrides: Partial<RelationSubject> = {}): RelationSubject {
  return { id, type: "decision", status: "promoted", relations, ...overrides };
}

function topic(id: EntityId, title: string, parents: EntityId[] = []): TopicSubject {
  return { id, type: "topic", title, relations: parents.map((target) => ({ type: PARENT_TOPIC_RELATION, target })) };
}

/**
 * Every code this phase's checks can produce, each paired with an input that
 * actually produces it.
 *
 * Written as data rather than as one test per code so the coverage assertion
 * below is exhaustive by construction: a new code with no way to trigger it
 * fails the disjoint-and-covering test rather than passing unnoticed.
 */
/**
 * Parse a small inline document and return its diagnostics.
 *
 * The codec's codes are emitted here rather than in a separate coverage file so
 * that "disjoint and covering" stays a single provable fact in one place. The
 * alternative — hoisting both maps into a shared module so a third file can
 * assert over them — moves 130 lines of test data to buy layering purity that
 * the lint rule does not ask for, since it exempts `__tests__` by design.
 */
function codecDiagnostics(text: string): readonly WikiDiagnostic[] {
  return parseWikiMarkdown({ path: "inline.md", text }).diagnostics;
}

const CODEC_ID = "mx_01K4FAM7W8N9R3T5Y6Q2ZBCHJD";

const EMITTERS: Record<string, () => readonly WikiDiagnostic[]> = {
  INVALID_ENTITY_ID: () => validateEntity(entity({ id: "not-an-id" as unknown as EntityId }), rootContext()).diagnostics,
  DUPLICATE_ENTITY_ID: () => {
    const id = generateEntityId();
    return validateEntitySetIdentity([
      { id, location: location({ file: "a.md" }) },
      { id, location: location({ file: "b.md" }) },
    ]);
  },
  INVALID_ENTITY_TYPE: () => validateEntity(entity({ type: "runbook" }), rootContext()).diagnostics,
  INVALID_LIFECYCLE_STATE: () =>
    validateEntity(entity({ status: "stale" as unknown as WikiLifecycleState }), rootContext()).diagnostics,
  INVALID_REVISION: () => validateEntity(entity({ revision: 0 }), rootContext()).diagnostics,
  MISSING_ENTITY_TITLE: () => validateEntity(entity({ title: "" }), rootContext()).diagnostics,
  MISSING_REQUIRED_FIELD: () =>
    createEntityValidator({ requireLocation: true })(
      entity({ location: location({ file: "" }) }),
      rootContext(),
    ).diagnostics,
  INVALID_FIELD_TYPE: () => validateEntity(entity({ metadata: "not an object" as never }), rootContext()).diagnostics,
  REVISION_DIVERGED: () => detectRevisionDivergence(entity(), entityContentHash("edited by hand")),

  INVALID_RELATION_TYPE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [{ type: "sort_of" as WikiRelationType, target: b }]), subject(b)]);
  },
  INVALID_RELATION_TARGET: () => {
    const [a, missing] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("depends_on", missing)])]);
  },
  DUPLICATE_RELATION: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("affects", b), relate("affects", b)]), subject(b)]);
  },
  SELF_RELATION: () => {
    const [a] = ids(1) as [EntityId];
    return validateRelationGraph([subject(a, [relate("related_to", a)])]);
  },
  SUPERSESSION_CYCLE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("supersedes", b)]), subject(b, [relate("supersedes", a)])]);
  },
  CONTRADICTORY_ACTIVE_DECISIONS: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("contradicts", b)]), subject(b)]);
  },
  INACTIVE_RELATION_TARGET: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateRelationGraph([subject(a, [relate("depends_on", b)]), subject(b, [], { status: "archived" })]);
  },
  ORPHANED_ENTITY: () => {
    const [a] = ids(1) as [EntityId];
    return validateRelationGraph([subject(a)], { reportOrphans: true });
  },

  UNKNOWN_TOPIC: () => resolveTopicOrDiagnose(buildTopicIndex([]), "authentication", "topics[0]").diagnostics,
  AMBIGUOUS_TOPIC_REFERENCE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    const index = buildTopicIndex([topic(a, "Auth"), topic(b, "Auth")]);
    return resolveTopicOrDiagnose(index, "auth", "topics[0]").diagnostics;
  },
  INVALID_TOPIC_MEMBER: () => {
    const [member, decision] = ids(2) as [EntityId, EntityId];
    return validateTopicMembership([{ id: member, topics: [decision] }], new Map([[decision, { type: "decision" }]]));
  },
  TOPIC_CYCLE: () => {
    const [a, b] = ids(2) as [EntityId, EntityId];
    return validateTopicHierarchy(buildTopicIndex([topic(a, "A", [b]), topic(b, "B", [a])]));
  },

  MALFORMED_SOURCE: () => validateSource({ type: "manual" }, rootContext()).diagnostics,
  INVALID_COMMIT_FORMAT: () => validateSource({ type: "commit", ref: "yesterday" }, rootContext()).diagnostics,
  DUPLICATE_SOURCE: () =>
    findDuplicateSources([
      { type: "file", ref: "src/a.ts" },
      { type: "file", ref: "src/a.ts" },
    ]),
  UNRESOLVED_EXTERNAL_SOURCE: () => reportUnresolvedSources([{ type: "url", ref: "https://example.com" }]),

  MALFORMED_GROUNDING: () => validateGrounding({ node: "rotateToken", fingerprint: "x" }, rootContext()).diagnostics,
  GROUNDING_UNVERIFIED: () => verifyGroundingProvenance([grounding()], () => false),

  INVALID_OPERATION_ENVELOPE: () =>
    validateOperation(
      { opId: "op_1", type: "archive-entry", actor: { kind: "agent", id: "x" }, timestamp: "this morning", payload: {} },
      rootContext(),
    ).diagnostics,
  UNKNOWN_OPERATION_TYPE: () =>
    validateOperation({ opId: "op_1", type: "delete-entry" as WikiOperationType, actor: { kind: "agent", id: "x" }, timestamp: "2026-08-23T10:00:00Z", payload: {} }, rootContext())
      .diagnostics,
  INVALID_OPERATION_PAYLOAD: () =>
    validateOperation(
      {
        opId: "op_1",
        type: "set-property",
        entityId: generateEntityId(),
        actor: { kind: "agent", id: "x" },
        timestamp: "2026-08-23T10:00:00Z",
        payload: { property: "id", value: "forged" },
      },
      rootContext(),
    ).diagnostics,
  REVISION_CONFLICT: () =>
    checkOperationPreconditions({ baseRevision: 1 }, { revision: 4, entityContentHash: entityContentHash("x") }),
  CONTENT_HASH_CONFLICT: () =>
    checkOperationPreconditions(
      { baseContentHash: entityContentHash("old") },
      { revision: 1, entityContentHash: entityContentHash("new") },
    ),

  // -- P2b, the Markdown codec ----------------------------------------------

  WIKI_PARSE_ERROR: () =>
    codecDiagnostics(`<!-- mex:entity
id: "unterminated
type: decision
-->
## Heading
`),

  UNBOUND_ENTITY_METADATA: () =>
    codecDiagnostics(`<!-- mex:entity
id: ${CODEC_ID}
type: decision
status: promoted
-->

Prose, and no heading after it.
`),

  DUPLICATE_ENTITY_METADATA: () =>
    codecDiagnostics(
      `<!-- mex:entity
id: ${CODEC_ID}
type: decision
status: promoted
-->
` +
        `<!-- mex:entity
id: mx_01BX5ZZKBKACTAV9WEVGEMMVRZ
type: decision
status: promoted
-->
` +
        `## One heading, two claimants
`,
    ),

  // -- P3, the disposable index and the query layer --------------------------

  WIKI_INDEX_MISSING: () =>
    inScratch((directory) => {
      const opened = openWikiIndex(join(directory, "wiki.db"));
      return opened.ok ? [] : [opened.diagnostic];
    }),

  WIKI_INDEX_REBUILD_REQUIRED: () =>
    inScratch((directory) => {
      const path = join(directory, "wiki.db");
      // A file that is not a database at all. Same remedy as a version
      // mismatch, and the same typed diagnostic rather than a throw from deep
      // inside an open.
      writeFileSync(path, "this is not a database", "utf-8");
      const opened = openWikiIndex(path);
      return opened.ok ? [] : [opened.diagnostic];
    }),

  ENTITY_RANGE_OVERLAP: () => {
    // Built by hand, because the codec's partition property means it cannot
    // produce an overlap — which is exactly why the index checks for one
    // anyway, before P5 computes a patch plan from two locations claiming the
    // same bytes and writes one over the other.
    const [first, second] = ids(2) as [EntityId, EntityId];
    const overlapping: ParsedEntity[] = [
      {
        entity: entity({ id: first, location: location({ file: "a.md", metadataStart: 0, bodyEnd: 100 }) }),
        metadataKind: "comment",
      },
      {
        entity: entity({ id: second, location: location({ file: "a.md", metadataStart: 50, bodyEnd: 150 }) }),
        metadataKind: "comment",
      },
    ];
    return detectRangeOverlaps("a.md", overlapping);
  },

  ENTITY_NOT_FOUND: () =>
    inScratch((directory) => {
      const scaffoldRoot = join(directory, "scaffold");
      mkdirSync(scaffoldRoot, { recursive: true });
      writeFileSync(join(scaffoldRoot, "notes.md"), "# Prose, and no entity\n", "utf-8");
      const built = rebuildWikiIndex({ scaffoldRoot, indexPath: join(directory, "wiki.db") });
      const result = getEntity(built.indexPath, generateEntityId());
      return result.ok ? [] : [result.diagnostic];
    }),

  // Called directly rather than through a real symlink: Windows refuses those
  // without developer mode, and an emitter that fires only on some machines
  // makes a coverage assertion depend on the environment. The walk that calls
  // it is exercised in discover.test.ts.
  PATH_OUTSIDE_SCAFFOLD: () => [escapedSymlinkDiagnostic("linked.md", "/elsewhere/outside.md")],
};

describe("diagnostic code coverage", () => {
  it("emits every code this phase owns", () => {
    for (const [code, emit] of Object.entries(EMITTERS)) {
      expect(codesOf(emit()), `${code} was not emitted by its own example`).toContain(code);
    }
  });

  it("accounts for every registered code exactly once", () => {
    // Disjoint and covering: a code cannot be parked in NOT_YET_EMITTED once
    // its check lands, and a newly added code cannot be forgotten.
    const emitted = new Set(Object.keys(EMITTERS));
    const deferred = new Set(Object.keys(NOT_YET_EMITTED));

    const overlap = [...emitted].filter((code) => deferred.has(code));
    expect(overlap, "these codes are emitted, so remove them from NOT_YET_EMITTED").toEqual([]);

    const unaccounted = WIKI_DIAGNOSTIC_CODES.filter((code) => !emitted.has(code) && !deferred.has(code));
    expect(unaccounted, "add an emitter, or record the phase that will emit it").toEqual([]);

    const stale = [...emitted, ...deferred].filter((code) => !isWikiDiagnosticCode(code));
    expect(stale, "these names are not registry codes").toEqual([]);
  });

  it("names a real phase for every deferred code", () => {
    for (const [code, phase] of Object.entries(NOT_YET_EMITTED)) {
      expect(phase, `${code} needs the phase that will emit it`).toMatch(/^P\d/);
    }
  });
});
