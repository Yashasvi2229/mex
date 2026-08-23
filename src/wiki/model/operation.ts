import type { WikiDiagnostic } from "./diagnostic.js";
import { normalizeEntityId, type EntityId } from "./ids.js";
import { validateGrounding, type WikiGrounding } from "./grounding.js";
import { validateRelationRef, type WikiRelationRef } from "./relation.js";
import { validateSource, type WikiSource } from "./source.js";
import { isContentHash } from "./hash.js";
import { WIKI_ENTITY_TYPES, WIKI_LIFECYCLE_STATES, type WikiEntityType, type WikiLifecycleState } from "./entity.js";
import {
  contextDiagnostic,
  isPlainObject,
  optional,
  reject,
  succeed,
  validateArray,
  validateEnum,
  validateInteger,
  validateShape,
  validateString,
  type ValidationContext,
  type Validator,
} from "./validate.js";

/**
 * Operations — the only way anything mutates the wiki.
 *
 * Agents propose; MEX validates and applies. Every mutation travels in a typed
 * envelope carrying preconditions, so a proposal built against a checkout that
 * has since moved is rejected rather than silently clobbering someone's edit.
 *
 * This module is types, payload validators and the *pure* precondition check.
 * Planning, byte-range patching, atomic write and audit are the operations
 * layer's job — they need the filesystem, and keeping them out of the model is
 * what lets these validators run anywhere.
 *
 * There is no hard-delete operation, by design: `archive-entry` is the terminal
 * state. Knowledge that turned out to be wrong is still the record of what the
 * team believed, and inbound relations to a deleted entity would dangle.
 */

export const WIKI_OPERATION_TYPES = [
  "create-entry",
  "update-entry",
  "set-property",
  "add-relation",
  "remove-relation",
  "add-source",
  "remove-source",
  "set-grounding",
  "supersede-entry",
  "move-entry",
  "archive-entry",
] as const;

export type WikiOperationType = (typeof WIKI_OPERATION_TYPES)[number];

export type WikiActorKind = "human" | "agent" | "system";

export interface WikiActor {
  kind: WikiActorKind;
  id: string;
  sessionId?: string;
}

export interface WikiOperationEnvelope<TPayload = unknown> {
  /** Caller-supplied unique id. Replaying the same opId is idempotent. */
  opId: string;
  type: WikiOperationType;
  entityId?: EntityId;
  /** Precondition: the revision the proposal was built against. */
  baseRevision?: number;
  /** Precondition: the entity's own content hash when the proposal was built. */
  baseContentHash?: string;
  actor: WikiActor;
  reason?: string;
  /** ISO 8601. */
  timestamp: string;
  payload: TPayload;
}

/**
 * Where a new or moved entity goes.
 *
 * Explicit rather than inferred: the build spec requires that insertion never
 * overwrites existing prose, which means the planner needs an unambiguous
 * anchor it can turn into a byte range without guessing. "After the entity with
 * this id" and "at the end of this file" are the two anchors that survive the
 * file being edited between planning and applying.
 */
export type InsertionPoint =
  | { at: "end-of-file" }
  | { at: "before-entity"; entityId: EntityId }
  | { at: "after-entity"; entityId: EntityId }
  | { at: "start-of-file" };

export interface CreateEntryPayload {
  /** Scaffold-relative path of the file to write into. */
  file: string;
  insertAt: InsertionPoint;
  type: WikiEntityType;
  title: string;
  body: string;
  summary?: string;
  status?: WikiLifecycleState;
  topics?: EntityId[];
  relations?: WikiRelationRef[];
  sources?: WikiSource[];
  groundsTo?: WikiGrounding[];
  /** Heading depth for a block-level entity; omit for a file-level entity. */
  headingDepth?: number;
}

export interface UpdateEntryPayload {
  title?: string;
  summary?: string;
  body?: string;
}

/**
 * Properties `set-property` may change.
 *
 * An explicit allowlist rather than an arbitrary path: `id`, `revision` and
 * `location` are MEX's to maintain, and letting an operation set them would let
 * an agent forge identity or defeat the precondition system.
 */
export const SETTABLE_PROPERTIES = ["type", "status", "title", "summary", "topics", "metadata"] as const;

export type SettableProperty = (typeof SETTABLE_PROPERTIES)[number];

export interface SetPropertyPayload {
  property: SettableProperty;
  value: unknown;
}

export interface AddRelationPayload {
  relation: WikiRelationRef;
}

export interface RemoveRelationPayload {
  type: string;
  target: EntityId;
}

export interface AddSourcePayload {
  source: WikiSource;
}

export interface RemoveSourcePayload {
  /** Normalized source identity, from `sourceIdentity`. */
  sourceIdentity: string;
}

export interface SetGroundingPayload {
  groundsTo: WikiGrounding[];
  /**
   * Rewrite inline `mex://` anchors in the body to match.
   *
   * Off unless asked: anchors are visible prose, and silently rewriting them is
   * a change the author did not request.
   */
  updateAnchors?: boolean;
}

export interface SupersedeEntryPayload {
  /** Supersede with an existing entity... */
  replacementId?: EntityId;
  /** ...or create one. Exactly one of the two. */
  replacement?: CreateEntryPayload;
  note?: string;
}

export interface MoveEntryPayload {
  /** Destination file, scaffold-relative. */
  file: string;
  insertAt: InsertionPoint;
}

export interface ArchiveEntryPayload {
  note?: string;
}

/** Payload type for each operation type. */
export interface WikiOperationPayloads {
  "create-entry": CreateEntryPayload;
  "update-entry": UpdateEntryPayload;
  "set-property": SetPropertyPayload;
  "add-relation": AddRelationPayload;
  "remove-relation": RemoveRelationPayload;
  "add-source": AddSourcePayload;
  "remove-source": RemoveSourcePayload;
  "set-grounding": SetGroundingPayload;
  "supersede-entry": SupersedeEntryPayload;
  "move-entry": MoveEntryPayload;
  "archive-entry": ArchiveEntryPayload;
}

/** A fully typed operation: the envelope narrowed to one type's payload. */
export type WikiOperation = {
  [K in WikiOperationType]: WikiOperationEnvelope<WikiOperationPayloads[K]> & { type: K };
}[WikiOperationType];

/** Operations that require an existing entity to act on. */
const REQUIRES_ENTITY_ID = new Set<WikiOperationType>([
  "update-entry",
  "set-property",
  "add-relation",
  "remove-relation",
  "add-source",
  "remove-source",
  "set-grounding",
  "supersede-entry",
  "move-entry",
  "archive-entry",
]);

export function isWikiOperationType(value: unknown): value is WikiOperationType {
  return typeof value === "string" && (WIKI_OPERATION_TYPES as readonly string[]).includes(value);
}

const entityIdValidator: Validator<EntityId> = (value, context) => {
  const normalized = normalizeEntityId(value);
  if (normalized === null) {
    return reject(context, "INVALID_ENTITY_ID", `Expected an entity id, got ${typeof value === "string" ? JSON.stringify(value) : typeof value}.`);
  }
  return succeed(normalized);
};

const actorValidator: Validator<WikiActor> = validateShape<WikiActor>({
  kind: validateEnum(["human", "agent", "system"] as const, "INVALID_OPERATION_ENVELOPE", "actor kind"),
  id: validateString(),
  sessionId: optional(validateString()),
});

const insertionPointValidator: Validator<InsertionPoint> = (value, context) => {
  if (!isPlainObject(value)) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "Expected an insertion point object.");
  }
  const at = value.at;
  if (at === "end-of-file" || at === "start-of-file") return succeed({ at } as InsertionPoint);
  if (at === "before-entity" || at === "after-entity") {
    const target = normalizeEntityId(value.entityId);
    if (target === null) {
      return reject(context, "INVALID_OPERATION_PAYLOAD", `"${at}" requires an \`entityId\` to anchor against.`);
    }
    return succeed({ at, entityId: target } as InsertionPoint);
  }
  return reject(
    context,
    "INVALID_OPERATION_PAYLOAD",
    `Unknown insertion point "${String(at)}". Expected start-of-file, end-of-file, before-entity or after-entity.`,
  );
};

/**
 * A scaffold-relative path with no escape.
 *
 * Rejected here rather than only at write time so a malformed operation is
 * caught in `plan` and never reaches the filesystem. This is a *lexical* check;
 * the operations layer additionally resolves the real path, because a symlink
 * inside the scaffold can point outside it and no amount of string inspection
 * can see that.
 */
const scaffoldPathValidator: Validator<string> = (value, context) => {
  if (typeof value !== "string" || value.trim() === "") {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "Expected a scaffold-relative file path.");
  }
  const path = value.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-zA-Z]:/.test(path)) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", `File path must be scaffold-relative, got "${value}".`);
  }
  if (path.split("/").includes("..")) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", `File path must not escape the scaffold root, got "${value}".`);
  }
  return succeed(path);
};

const createEntryValidator: Validator<CreateEntryPayload> = validateShape<CreateEntryPayload>({
  file: scaffoldPathValidator,
  insertAt: insertionPointValidator,
  type: validateEnum(WIKI_ENTITY_TYPES, "INVALID_ENTITY_TYPE", "entity type"),
  title: validateString(),
  body: validateString({ allowEmpty: true }),
  summary: optional(validateString()),
  status: optional(validateEnum(WIKI_LIFECYCLE_STATES, "INVALID_LIFECYCLE_STATE", "lifecycle state")),
  topics: optional(validateArray(entityIdValidator)),
  relations: optional(validateArray(validateRelationRef)),
  sources: optional(validateArray(validateSource)),
  groundsTo: optional(validateArray(validateGrounding)),
  headingDepth: optional(validateInteger({ min: 1, max: 6 })),
});

const updateEntryValidator: Validator<UpdateEntryPayload> = (value, context) => {
  const shape = validateShape<UpdateEntryPayload>({
    title: optional(validateString()),
    summary: optional(validateString()),
    body: optional(validateString({ allowEmpty: true })),
  });
  const result = shape(value, context);
  if (!result.ok) return result;
  if (result.value.title === undefined && result.value.summary === undefined && result.value.body === undefined) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "update-entry must change at least one of title, summary or body.");
  }
  return result;
};

const setPropertyValidator: Validator<SetPropertyPayload> = (value, context) => {
  if (!isPlainObject(value)) return reject(context, "INVALID_OPERATION_PAYLOAD", "Expected a set-property payload.");
  if (typeof value.property !== "string" || !(SETTABLE_PROPERTIES as readonly string[]).includes(value.property)) {
    return reject(
      context,
      "INVALID_OPERATION_PAYLOAD",
      `Property "${String(value.property)}" is not settable. Settable: ${SETTABLE_PROPERTIES.join(", ")}. (id, revision and location are maintained by MEX.)`,
    );
  }
  if (!("value" in value)) {
    return reject(context, "INVALID_OPERATION_PAYLOAD", "set-property requires a `value`.");
  }
  return succeed({ property: value.property as SettableProperty, value: value.value });
};

const supersedeValidator: Validator<SupersedeEntryPayload> = (value, context) => {
  if (!isPlainObject(value)) return reject(context, "INVALID_OPERATION_PAYLOAD", "Expected a supersede-entry payload.");
  const hasId = value.replacementId !== undefined;
  const hasInline = value.replacement !== undefined;
  if (hasId === hasInline) {
    return reject(
      context,
      "INVALID_OPERATION_PAYLOAD",
      "supersede-entry needs exactly one of `replacementId` (an existing entity) or `replacement` (one to create).",
    );
  }
  const payload: SupersedeEntryPayload = {};
  if (typeof value.note === "string") payload.note = value.note;
  if (hasId) {
    const id = normalizeEntityId(value.replacementId);
    if (id === null) return reject(context, "INVALID_ENTITY_ID", "`replacementId` is not an entity id.");
    payload.replacementId = id;
    return succeed(payload);
  }
  const inner = createEntryValidator(value.replacement, { ...context, path: `${context.path}.replacement` });
  if (!inner.ok) return inner;
  payload.replacement = inner.value;
  return succeed(payload, inner.diagnostics);
};

const PAYLOAD_VALIDATORS: { [K in WikiOperationType]: Validator<WikiOperationPayloads[K]> } = {
  "create-entry": createEntryValidator,
  "update-entry": updateEntryValidator,
  "set-property": setPropertyValidator,
  "add-relation": validateShape<AddRelationPayload>({ relation: validateRelationRef }),
  "remove-relation": validateShape<RemoveRelationPayload>({
    type: validateString(),
    target: entityIdValidator,
  }),
  "add-source": validateShape<AddSourcePayload>({ source: validateSource }),
  "remove-source": validateShape<RemoveSourcePayload>({ sourceIdentity: validateString() }),
  "set-grounding": validateShape<SetGroundingPayload>({
    groundsTo: validateArray(validateGrounding),
    updateAnchors: optional((value, context) =>
      typeof value === "boolean"
        ? succeed(value)
        : reject(context, "INVALID_OPERATION_PAYLOAD", "`updateAnchors` must be a boolean."),
    ),
  }),
  "supersede-entry": supersedeValidator,
  "move-entry": validateShape<MoveEntryPayload>({
    file: scaffoldPathValidator,
    insertAt: insertionPointValidator,
  }),
  "archive-entry": validateShape<ArchiveEntryPayload>({ note: optional(validateString()) }),
};

/**
 * Validate an operation envelope and its payload together.
 *
 * The two cannot be checked apart: the payload's shape is determined by the
 * envelope's `type`, and whether `entityId` is required is too.
 */
export const validateOperation: Validator<WikiOperation> = (value, context) => {
  if (!isPlainObject(value)) {
    return reject(context, "INVALID_OPERATION_ENVELOPE", "Expected an operation envelope object.");
  }

  if (!isWikiOperationType(value.type)) {
    return reject(
      context,
      "UNKNOWN_OPERATION_TYPE",
      `Unknown operation type ${typeof value.type === "string" ? JSON.stringify(value.type) : typeof value.type}. Expected one of ${WIKI_OPERATION_TYPES.join(", ")}.`,
    );
  }
  const type = value.type;

  const diagnostics: WikiDiagnostic[] = [];
  const envelopeShape = validateShape<Omit<WikiOperationEnvelope, "type" | "payload">>({
    opId: validateString(),
    entityId: optional(entityIdValidator),
    baseRevision: optional(validateInteger({ min: 1 })),
    baseContentHash: optional(validateString()),
    actor: actorValidator,
    reason: optional(validateString()),
    timestamp: validateString(),
  });

  const envelope = envelopeShape(value, context);
  diagnostics.push(...envelope.diagnostics);

  if (envelope.ok && Number.isNaN(Date.parse(envelope.value.timestamp))) {
    diagnostics.push(
      contextDiagnostic({ ...context, path: `${context.path === "" ? "" : `${context.path}.`}timestamp` }, "INVALID_OPERATION_ENVELOPE", `"${envelope.value.timestamp}" is not an ISO 8601 timestamp.`),
    );
  }

  if (envelope.ok && envelope.value.baseContentHash !== undefined && !isContentHash(envelope.value.baseContentHash)) {
    diagnostics.push(
      contextDiagnostic(
        { ...context, path: `${context.path === "" ? "" : `${context.path}.`}baseContentHash` },
        "INVALID_OPERATION_ENVELOPE",
        "`baseContentHash` must be a 64-character lowercase hex SHA-256 digest.",
      ),
    );
  }

  if (REQUIRES_ENTITY_ID.has(type) && (!envelope.ok || envelope.value.entityId === undefined)) {
    diagnostics.push(
      contextDiagnostic(context, "INVALID_OPERATION_ENVELOPE", `A "${type}" operation must name the entity it acts on.`),
    );
  }

  const payloadResult = PAYLOAD_VALIDATORS[type](
    value.payload,
    { ...context, path: context.path === "" ? "payload" : `${context.path}.payload` },
  );
  diagnostics.push(...payloadResult.diagnostics);

  if (!envelope.ok || !payloadResult.ok || diagnostics.some((entry) => entry.severity === "error")) {
    return { ok: false, diagnostics };
  }

  const operation = { ...envelope.value, type, payload: payloadResult.value } as WikiOperation;
  return succeed(operation, diagnostics);
};

/**
 * Check an operation's preconditions against the entity as it is right now.
 *
 * Pure, and separate from the envelope validator, because the two answer
 * different questions at different times: "is this a well-formed operation" can
 * be answered offline, while "is the checkout still where the proposal thought
 * it was" can only be answered against current state, and must be re-answered
 * at apply time even if it passed at plan time.
 *
 * Both preconditions are optional. Omitting them is legal — a first-write or a
 * deliberately unconditional operation — and means the caller accepts whatever
 * is on disk.
 */
export function checkOperationPreconditions(
  envelope: Pick<WikiOperationEnvelope, "baseRevision" | "baseContentHash" | "entityId">,
  current: { revision: number; entityContentHash: string },
  context: ValidationContext = { path: "" },
): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  const withEntity: ValidationContext = { ...context, entityId: envelope.entityId };

  if (envelope.baseRevision !== undefined && envelope.baseRevision !== current.revision) {
    diagnostics.push(
      contextDiagnostic(
        withEntity,
        "REVISION_CONFLICT",
        `Operation was built against revision ${envelope.baseRevision}, but the entity is at revision ${current.revision}.`,
      ),
    );
  }

  if (envelope.baseContentHash !== undefined && envelope.baseContentHash !== current.entityContentHash) {
    diagnostics.push(
      contextDiagnostic(
        withEntity,
        "CONTENT_HASH_CONFLICT",
        "The entity's text changed since this operation was planned.",
      ),
    );
  }

  return diagnostics;
}
