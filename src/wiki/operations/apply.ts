/**
 * §11.3 steps 8–11. **The only module under `src/wiki/` that writes Markdown.**
 *
 * Its lint exemption carries a runtime guard, following `dbfile.ts`'s pattern:
 * every mutation goes through {@link assertWritablePath}, which rejects
 * anything that is not a Markdown file (or the temp file about to become one)
 * inside the scaffold root, and fails closed. A lint rule cannot tell that
 * `writeFileSync(p, t)` is safe; the guard can.
 *
 * ## Apply re-plans. It does not replay bytes.
 *
 * The plan carries offsets computed against one parse. Trusting them after a
 * revalidation boundary is exactly the failure `applyEdits`' complement check
 * exists to catch — an edit whose range was computed against a stale parse
 * lands in the wrong place and still produces plausible text. So apply plans
 * again from the current tree and compares:
 *
 * - the **preconditions** must still hold, entity by entity, on the normalized
 *   hash the codec computes;
 * - if the caller supplies a `previewHash`, the whole tree must still be the
 *   one the preview was produced against — that is what an approval binds to.
 *
 * A concurrent edit to an *unrelated* entity in the same file therefore does
 * not block an unbound apply, and is carried through, because the re-plan is
 * built on it. A concurrent edit to the subject does block, as
 * `CONTENT_HASH_CONFLICT`.
 *
 * ## Multi-file operations cannot be atomic, so the question is which bad state
 *
 * There is no two-file rename and rollback code does not run under `SIGKILL`.
 * The constraint (HARD 7) is absolute in one direction only: **a process killed
 * at any point must leave the entity present somewhere.** So files are written
 * **largest gain first** — the file that receives content before the file that
 * loses it. A crash between the two renames leaves a duplicate id, which is a
 * state the index is built to hold and report: both claimants are stored,
 * `DUPLICATE_ENTITY_ID` is emitted, and `MIN(entity_key)` shadows one
 * deterministically. Replaying the `opId` finishes the move. Source-first would
 * leave the entity nowhere, and no probability of that is acceptable.
 *
 * ## The index is a cache and is treated like one
 *
 * If the post-write refresh fails — or there is no `wiki.db` at all, which is
 * the *normal* case, since nothing in production builds one — the result
 * carries `INDEX_REFRESH_REQUIRED` and **the Markdown write stands**. Never
 * undo a valid write because a disposable cache broke, and never rebuild one
 * behind the user's back in the middle of an apply.
 */

import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { EntityId } from "../model/ids.js";
import { entityContentHash, fileContentHash } from "../model/hash.js";
import { entityTextOf } from "../markdown/codec.js";
import type { GroundingResolver } from "../index/write.js";
import { refreshWikiIndex } from "../index/refresh.js";
import { defaultIndexPath } from "../index/rebuild.js";
import { assertWritablePath, checkContainment, isReadOnlyPath, readOnlyDiagnostic } from "./paths.js";
import { locateEntity } from "./locate.js";
import { applyEdits } from "../markdown/patch.js";
import { payloadHashOf, planOperation, writeScopeDiagnostic, type PlanOptions, type PlannedFileEdit, type RevisionChange, type WikiPatchPlan } from "./plan.js";
import { previewHashOf, previewPlan, type WikiPreview } from "./preview.js";
import { appendAudit, auditRecord, readAuditLog, recordFor, type AuditEntry } from "./audit.js";

export interface ApplyOptions extends PlanOptions {
  /** Where `wiki.db` lives. Absent is normal, not an error. */
  indexPath?: string;
  /** Bind this apply to the exact tree a preview was produced against. */
  previewHash?: string;
  /** Grounding health for the post-write refresh, when a graph is available. */
  resolveGrounding?: GroundingResolver;
  now?: () => string;
  /**
   * Called after each file is renamed into place.
   *
   * The crash seam. There is no portable way to `SIGKILL` a process mid-apply
   * inside a test runner, so the kill is injected here: a hook that throws
   * after the first rename leaves precisely the on-disk state a real crash
   * would, and the recovery path is then exercised against real bytes rather
   * than against a mock.
   */
  onFileWritten?: (path: string) => void;
}

export interface ApplyResult {
  ok: boolean;
  opId: string;
  /** Scaffold-relative paths actually written. Empty on a replayed no-op. */
  changedFiles: string[];
  revisions: RevisionChange[];
  createdIds: string[];
  /** True when the log already held a completion for this `opId`. */
  replayed: boolean;
  preview: WikiPreview | null;
  diagnostics: WikiDiagnostic[];
}

function failure(opId: string, diagnostics: WikiDiagnostic[]): ApplyResult {
  return {
    ok: false,
    opId,
    changedFiles: [],
    revisions: [],
    createdIds: [],
    replayed: false,
    preview: null,
    diagnostics,
  };
}

/** The envelope's opId, without trusting the envelope's shape. */
function opIdOf(envelope: unknown): string {
  const raw = envelope as { opId?: unknown };
  return typeof raw?.opId === "string" ? raw.opId : "";
}

function payloadOf(envelope: unknown): unknown {
  return (envelope as { payload?: unknown })?.payload;
}

function typeOf(envelope: unknown): string {
  const raw = envelope as { type?: unknown };
  return typeof raw?.type === "string" ? raw.type : "";
}

/**
 * Apply one operation, or say why not.
 *
 * Idempotent by `opId`: a replayed operation is a no-op that reports what the
 * original did. **The same `opId` with a different payload is a validation
 * failure**, not a retry — accepting it would make the audit log a work of
 * fiction, since one line would then describe two different changes.
 */
export function applyOperation(envelope: unknown, options: ApplyOptions): ApplyResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const opId = opIdOf(envelope);
  const log = readAuditLog(scaffoldRoot);
  const carried = [...log.diagnostics];

  if (opId === "") {
    return failure(opId, [...carried, diagnostic("INVALID_OPERATION_ENVELOPE", "An operation needs an `opId`.")]);
  }

  const record = recordFor(log, opId);
  const proposed = payloadHashOf(typeOf(envelope) as never, payloadOf(envelope));

  const priorHash = record.complete?.payloadHash ?? record.intent?.payloadHash ?? null;
  if (priorHash !== null && priorHash !== proposed) {
    return failure(opId, [
      ...carried,
      diagnostic(
        "INVALID_OPERATION_ENVELOPE",
        `Operation ${opId} has already been recorded with a different payload. Reusing an opId for a different change is a caller bug, not a retry.`,
      ),
    ]);
  }

  if (record.complete !== null) {
    return {
      ok: true,
      opId,
      changedFiles: [...record.complete.files],
      revisions: record.complete.revisions.map((change) => ({ ...change })),
      createdIds: [...record.complete.createdIds],
      replayed: true,
      preview: null,
      diagnostics: carried,
    };
  }

  // An intent with no completion is work that was interrupted. Resume it with
  // the ids it already minted and the file it started from, so a resumed
  // `create-entry` re-uses its id rather than minting a second entity and a
  // resumed `move-entry` finishes in the direction it began.
  const resuming = record.intent;
  const planOptions: PlanOptions = resuming === null
    ? options
    : {
        ...options,
        ...(resuming.createdIds.length > 0 ? { generateId: mintFrom(resuming.createdIds) } : {}),
        ...(resuming.files.length > 0 && resuming.type === "move-entry"
          ? { preferFile: sourceFileOf(resuming, options) }
          : {}),
      };

  const planned = planOperation(envelope, planOptions);
  if (!planned.ok) {
    if (resuming !== null && alreadySettled(resuming, options)) {
      // The interrupted work had in fact landed; the process died before it
      // could say so. Record the completion rather than reporting a failure
      // for an operation that succeeded.
      appendAudit(scaffoldRoot, { ...resuming, phase: "complete", ...(options.now ? { timestamp: options.now() } : {}) });
      return {
        ok: true,
        opId,
        changedFiles: [...resuming.files],
        revisions: resuming.revisions.map((change) => ({ ...change })),
        createdIds: [...resuming.createdIds],
        replayed: true,
        preview: null,
        diagnostics: carried,
      };
    }
    return failure(opId, [...carried, ...planned.diagnostics]);
  }

  const plan = planned.plan;

  if (options.previewHash !== undefined && previewHashOf(plan) !== options.previewHash) {
    return failure(opId, [
      ...carried,
      diagnostic(
        "CONTENT_HASH_CONFLICT",
        "The tree changed since this operation was previewed. Re-plan, re-review and retry.",
      ),
    ]);
  }

  const stale = revalidate(plan, options);
  if (stale.length > 0) return failure(opId, [...carried, ...stale]);

  // -- step 10, first half: say what is about to happen ---------------------
  if (resuming === null) appendAudit(scaffoldRoot, auditRecord(plan, "intent"));

  // -- step 8: write, gains before losses -----------------------------------
  const ordered = [...plan.files].sort((left, right) => gain(right) - gain(left));
  const changedFiles: string[] = [];
  for (const file of ordered) {
    if (file.proposedText === file.baseText && file.existed) continue;
    writeAtomically(scaffoldRoot, file);
    changedFiles.push(file.path);
    options.onFileWritten?.(file.path);
  }

  // -- step 10, second half -------------------------------------------------
  appendAudit(scaffoldRoot, auditRecord(plan, "complete"));

  // -- step 9: the cache, which may fail without undoing anything -----------
  const diagnostics = [...carried, ...plan.diagnostics, ...refreshIndex(scaffoldRoot, changedFiles, options)];

  return {
    ok: true,
    opId,
    changedFiles,
    revisions: plan.revisions,
    createdIds: [...plan.createdIds],
    replayed: false,
    preview: previewPlan(plan),
    diagnostics,
  };
}

/** Net bytes a file gains. Gains are written first; see the module comment. */
function gain(file: PlannedFileEdit): number {
  return file.proposedText.length - file.baseText.length;
}

/** Hand back recorded ids in order, then fall back to minting. */
function mintFrom(ids: readonly string[]): NonNullable<PlanOptions["generateId"]> {
  let index = 0;
  return () => {
    const next = ids[index];
    index += 1;
    if (next === undefined) throw new Error("resumed operation minted more ids than its intent recorded");
    return next as EntityId;
  };
}

/** Where a recorded `move-entry` started: the file the entity is still in. */
function sourceFileOf(intent: AuditEntry, options: ApplyOptions): string | undefined {
  for (const id of intent.entityIds) {
    for (const path of intent.files) {
      const located = locateEntity(id, { ...options, preferFile: path });
      if (located !== null && located.path === path) return path;
    }
  }
  return undefined;
}

/**
 * Did the interrupted work already land?
 *
 * Checked against the filesystem, not inferred: every entity the intent named
 * or minted has to be findable. That is the question the intent line exists to
 * let a resume ask.
 */
function alreadySettled(intent: AuditEntry, options: ApplyOptions): boolean {
  const ids = [...intent.entityIds, ...intent.createdIds];
  if (ids.length === 0) return false;
  return ids.every((id) => locateEntity(id, options) !== null);
}

/**
 * Re-check every precondition against the tree as it is *now*.
 *
 * The plan was just re-derived from disk, so its own recorded preconditions
 * describe current state; what this adds is the comparison against what the
 * *envelope* asked for, which `planOperation` also made — deliberately twice,
 * because the two run at different moments in a concurrent world and the
 * second is the one that matters.
 */
function revalidate(plan: WikiPatchPlan, options: ApplyOptions): WikiDiagnostic[] {
  const diagnostics: WikiDiagnostic[] = [];
  for (const precondition of plan.preconditions) {
    const located = locateEntity(precondition.entityId, options);
    if (located === null) {
      diagnostics.push(
        diagnostic("ENTITY_NOT_FOUND", `Entity ${precondition.entityId} vanished between planning and applying.`, {
          entityId: precondition.entityId,
        }),
      );
      continue;
    }
    const current = entityContentHash(entityTextOf(located.text, located.entity.location));
    if (current !== precondition.entityContentHash) {
      diagnostics.push(
        diagnostic("CONTENT_HASH_CONFLICT", `Entity ${precondition.entityId} changed between planning and applying.`, {
          entityId: precondition.entityId,
          file: located.path,
        }),
      );
    }
  }
  return diagnostics;
}

/**
 * Temp file in the **same directory**, then rename.
 *
 * Same directory because a cross-device rename is a copy, and a copy is not
 * atomic. The temp name is deliberately not `*.md`: discovery walks for
 * Markdown, and a concurrent rebuild would index a half-written file as a real
 * one — which for an entity block means indexing a truncated body, or a second
 * copy of an entity that is about to exist once.
 */
function writeAtomically(scaffoldRoot: string, file: PlannedFileEdit): void {
  const target = resolve(file.absolutePath);
  assertWritablePath(scaffoldRoot, target);
  mkdirSync(dirname(target), { recursive: true });

  const temp = `${target}.tmp-${randomBytes(6).toString("hex")}`;
  assertWritablePath(scaffoldRoot, temp);
  try {
    writeFileSync(temp, file.proposedText, "utf-8");
    assertWritablePath(scaffoldRoot, target);
    renameSync(temp, target);
  } catch (error) {
    if (existsSync(temp)) {
      assertWritablePath(scaffoldRoot, temp);
      rmSync(temp, { force: true });
    }
    throw error;
  }
}

/**
 * Refresh the rows the write touched — and never build an index that is absent.
 *
 * An absent `wiki.db` is the ordinary state of a production scaffold, so it is
 * reported as `INDEX_REFRESH_REQUIRED` rather than as an error, and rebuilding
 * one here would turn a millisecond write into a five-second surprise in the
 * middle of an operation.
 */
function refreshIndex(scaffoldRoot: string, changedFiles: readonly string[], options: ApplyOptions): WikiDiagnostic[] {
  if (changedFiles.length === 0) return [];
  const indexPath = options.indexPath ?? defaultIndexPath(scaffoldRoot);
  if (!existsSync(indexPath)) {
    return [
      diagnostic("INDEX_REFRESH_REQUIRED", "The Markdown write succeeded; there is no wiki index to refresh.", {}),
    ];
  }

  try {
    const refreshed = refreshWikiIndex({
      scaffoldRoot,
      indexPath,
      changed: [...changedFiles],
      ...(options.exclude === undefined ? {} : { exclude: options.exclude }),
      ...(options.registry === undefined ? {} : { registry: options.registry }),
      ...(options.now === undefined ? {} : { now: options.now }),
      ...(options.resolveGrounding === undefined ? {} : { resolveGrounding: options.resolveGrounding }),
    });
    if (refreshed.ok) return refreshed.diagnostics;
    return [
      diagnostic(
        "INDEX_REFRESH_REQUIRED",
        `The Markdown write succeeded but the index did not refresh: ${refreshed.diagnostic.message}`,
        {},
      ),
    ];
  } catch (error) {
    return [
      diagnostic(
        "INDEX_REFRESH_REQUIRED",
        `The Markdown write succeeded but the index did not refresh: ${error instanceof Error ? error.message : String(error)}`,
        {},
      ),
    ];
  }
}

/**
 * Regenerate a file's generated section — the one Markdown write that is not an
 * operation, and why it is not one.
 *
 * P6 shipped detection, deterministic rendering and a marker-bounded edit, and
 * left applying it as a stated seam with two candidate homes: a twelfth
 * operation type, or a command. Building it settles the question, because a
 * `WikiPatchPlan` carries a `WikiOperationType` and that field is not
 * decoration — it is what the audit log records and what `acceptedOperations()`
 * reports as having changed this wiki. So the choice is really:
 *
 * - **a twelfth type**, which puts a *rendering* act into the vocabulary of
 *   knowledge changes and makes §11.4's ledger report cosmetic regenerations
 *   alongside the decisions people actually made; or
 * - **a plan carrying one of the eleven**, which is a lie in the audit log; or
 * - **a write that is not an operation.**
 *
 * The third, because a generated section is *derived state*, exactly like
 * `wiki.db`: it contains no knowledge that is not already recorded in the
 * entities it lists, it is re-derivable from the scaffold at any moment, it
 * mints no id, bumps no revision and has no precondition worth taking. There is
 * nothing for replay to protect and nothing for a reviewer to review, so there
 * is no audit line — the audit log is the ledger of knowledge operations, and
 * padding it with regenerations would make the thing it exists to answer harder
 * to read.
 *
 * **It is not a second writer.** The bytes go through `applyEdits`, which
 * verifies that nothing outside the declared range moved, and through
 * `writeAtomically` in this module — the single guarded writer D9 names, with
 * `assertWritablePath` in front of every mutation exactly as before. What is
 * new is a second *caller*, not a second writer.
 *
 * Opt-in at the command line, never a side effect of a read.
 */
export function applyGeneratedViews(options: GeneratedViewApplyOptions): GeneratedViewApplyResult {
  const scaffoldRoot = resolve(options.scaffoldRoot);
  const diagnostics: WikiDiagnostic[] = [];
  const changedFiles: string[] = [];
  const readOnly = options.readOnly ?? [];

  for (const candidate of options.views) {
    if (!candidate.stale) continue;

    if (isReadOnlyPath(candidate.file, readOnly)) {
      diagnostics.push(readOnlyDiagnostic(candidate.file));
      continue;
    }
    const containment = checkContainment(scaffoldRoot, candidate.file);
    if (containment.diagnostic !== null) {
      diagnostics.push(containment.diagnostic);
      continue;
    }

    const absolutePath = resolve(scaffoldRoot, candidate.file);
    let patched;
    try {
      patched = applyEdits(candidate.baseText, [
        { start: candidate.region.start, end: candidate.region.end, text: candidate.rendered, label: `generated view in ${candidate.file}` },
      ]);
    } catch (error) {
      diagnostics.push(writeScopeDiagnostic(error, candidate.file));
      continue;
    }

    if (patched.text === candidate.baseText) continue;
    writeAtomically(scaffoldRoot, {
      path: candidate.file,
      absolutePath,
      baseText: candidate.baseText,
      baseFileHash: fileContentHash(candidate.baseText),
      existed: true,
      declared: patched.declared,
      edits: [],
      proposedText: patched.text,
    });
    changedFiles.push(candidate.file);
    options.onFileWritten?.(candidate.file);
  }

  diagnostics.push(...refreshIndex(scaffoldRoot, changedFiles, options));
  return { changedFiles, diagnostics };
}

/** One file's generated section, as the caller measured it. */
export interface GeneratedViewCandidate {
  file: string;
  baseText: string;
  region: { start: number; end: number };
  rendered: string;
  stale: boolean;
}

export interface GeneratedViewApplyOptions extends ApplyOptions {
  views: readonly GeneratedViewCandidate[];
}

export interface GeneratedViewApplyResult {
  changedFiles: string[];
  diagnostics: WikiDiagnostic[];
}
