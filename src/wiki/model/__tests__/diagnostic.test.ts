import { describe, it, expect } from "vitest";
import {
  SPEC_MINIMUM_DIAGNOSTIC_CODES,
  WIKI_DIAGNOSTICS,
  WIKI_DIAGNOSTIC_CODES,
  defaultSeverity,
  diagnostic,
  hasBlockingDiagnostic,
  isWikiDiagnosticCode,
  sortDiagnostics,
  type WikiDiagnostic,
  type WikiDiagnosticCode,
} from "../diagnostic.js";
import { createEntityValidator, detectRevisionDivergence, validateEntity, validateEntitySetIdentity, type WikiLifecycleState } from "../entity.js";
import { validateRelationGraph, type RelationSubject, type WikiRelationRef, type WikiRelationType } from "../relation.js";
import {
  buildTopicIndex,
  resolveTopicOrDiagnose,
  validateTopicHierarchy,
  validateTopicMembership,
  PARENT_TOPIC_RELATION,
  type TopicSubject,
} from "../topic.js";
import { findDuplicateSources, reportUnresolvedSources, validateSource } from "../source.js";
import { validateGrounding, verifyGroundingProvenance } from "../grounding.js";
import { checkOperationPreconditions, validateOperation, type WikiOperationType } from "../operation.js";
import { entityContentHash } from "../hash.js";
import { rootContext } from "../validate.js";
import { generateEntityId, type EntityId } from "../ids.js";
import { entity, grounding, location, ids } from "./helpers.js";

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
  WIKI_INDEX_MISSING: "P3 — index open",
  WIKI_INDEX_REBUILD_REQUIRED: "P3 — index schema version check",
  WIKI_PARSE_ERROR: "P2 — Markdown codec",
  UNBOUND_ENTITY_METADATA: "P2 — metadata-to-heading binding",
  DUPLICATE_ENTITY_METADATA: "P2 — metadata-to-heading binding",
  ENTITY_RANGE_OVERLAP: "P3 — rebuild, once entities carry real ranges",
  ENTITY_NOT_FOUND: "P3 — query layer",
  GROUNDING_UNRESOLVED: "P4 — grounding resolution against a live graph",
  GROUNDING_STALE: "P4 — grounding resolution against a live graph",
  GROUNDING_MISSING: "P4 — grounding resolution against a live graph",
  SOURCE_FILE_MISSING: "P9 — source validation against the filesystem",
  ANCHOR_GROUNDING_MISMATCH: "P2/P9 — inline anchor association",
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
};

describe("diagnostic registry", () => {
  it("contains every code the build spec lists as a minimum", () => {
    // A code being dropped is a contract break that would otherwise only
    // surface in whatever consumer was matching on it.
    for (const code of SPEC_MINIMUM_DIAGNOSTIC_CODES) {
      expect(isWikiDiagnosticCode(code), `${code} is missing from the registry`).toBe(true);
    }
  });

  it("gives every code a severity and a remediation", () => {
    for (const code of WIKI_DIAGNOSTIC_CODES) {
      const definition = WIKI_DIAGNOSTICS[code];
      expect(["error", "warning", "info"]).toContain(definition.severity);
      expect(definition.remediation.trim().length, `${code} has no remediation`).toBeGreaterThan(0);
    }
  });

  it("lists its codes deterministically", () => {
    expect(WIKI_DIAGNOSTIC_CODES).toEqual([...WIKI_DIAGNOSTIC_CODES].sort());
  });

  it("recognizes its own codes and nothing else", () => {
    expect(isWikiDiagnosticCode("DUPLICATE_ENTITY_ID")).toBe(true);
    expect(isWikiDiagnosticCode("MADE_UP_CODE")).toBe(false);
    expect(isWikiDiagnosticCode(undefined)).toBe(false);
    // Object.hasOwn, not `in`, so inherited members are not mistaken for codes.
    expect(isWikiDiagnosticCode("toString")).toBe(false);
  });
});

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

describe("diagnostic()", () => {
  it("defaults severity and remediation from the registry", () => {
    const built = diagnostic("DUPLICATE_ENTITY_ID", "Two entities claim one id.");
    expect(built.severity).toBe(defaultSeverity("DUPLICATE_ENTITY_ID"));
    expect(built.remediation).toBe(WIKI_DIAGNOSTICS.DUPLICATE_ENTITY_ID.remediation);
  });

  it("allows an override where context changes how bad the problem is", () => {
    const built = diagnostic("ORPHANED_ENTITY", "x", { severity: "warning", remediation: "custom" });
    expect(built.severity).toBe("warning");
    expect(built.remediation).toBe("custom");
  });

  it("omits optional fields rather than setting them to undefined", () => {
    const built = diagnostic("WIKI_PARSE_ERROR", "x");
    expect(Object.hasOwn(built, "file")).toBe(false);
    expect(Object.hasOwn(built, "entityId")).toBe(false);
    expect(Object.hasOwn(built, "location")).toBe(false);
  });
});

describe("hasBlockingDiagnostic", () => {
  it("blocks on an error and not on a warning or info", () => {
    expect(hasBlockingDiagnostic([diagnostic("DUPLICATE_ENTITY_ID", "x")])).toBe(true);
    expect(hasBlockingDiagnostic([diagnostic("DUPLICATE_SOURCE", "x")])).toBe(false);
    expect(hasBlockingDiagnostic([diagnostic("REVISION_DIVERGED", "x")])).toBe(false);
    expect(hasBlockingDiagnostic([])).toBe(false);
  });
});

describe("sortDiagnostics", () => {
  it("orders worst first, then by file, position and code", () => {
    const input: WikiDiagnostic[] = [
      diagnostic("REVISION_DIVERGED", "info", { file: "a.md" }),
      diagnostic("DUPLICATE_SOURCE", "warning", { file: "a.md" }),
      diagnostic("DUPLICATE_ENTITY_ID", "error in b", { file: "b.md" }),
      diagnostic("DUPLICATE_ENTITY_ID", "error in a", { file: "a.md", location: { startOffset: 40 } }),
      diagnostic("SELF_RELATION", "error in a, earlier", { file: "a.md", location: { startOffset: 10 } }),
    ];
    expect(sortDiagnostics(input).map((entry) => entry.message)).toEqual([
      "error in a, earlier",
      "error in a",
      "error in b",
      "warning",
      "info",
    ]);
  });

  it("is deterministic and does not mutate its input", () => {
    const input = [diagnostic("DUPLICATE_SOURCE", "b"), diagnostic("DUPLICATE_ENTITY_ID", "a")];
    const snapshot = input.map((entry) => entry.message);
    expect(sortDiagnostics(input)).toEqual(sortDiagnostics(input));
    expect(input.map((entry) => entry.message)).toEqual(snapshot);
  });
});
