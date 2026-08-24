/**
 * §11.4 — the append-only record, and the only legal replay oracle.
 *
 * ## Why the log, and not the index
 *
 * `wiki.db` is disposable by invariant: delete it and a rebuild reproduces
 * every row from Markdown. An index-resident record of applied `opId`s would
 * therefore evaporate on a rebuild, and idempotency would evaporate with it —
 * a replayed `create-entry` would mint a second entity, silently, because there
 * is no precondition that can catch a create. `.mex/events/operations.jsonl` is
 * committed and is where replay looks.
 *
 * ## Two lines, and why that is not a violation of "append one line"
 *
 * §11.3 appends the audit entry at step 10, *after* the write at step 8. A
 * process killed in between leaves a completed operation that looks
 * un-replayed. For `create-entry` a replay then mints a **second entity with a
 * new id** — silent knowledge duplication, produced by implementing the spec
 * exactly as written.
 *
 * So an operation writes an **intent** line before the first rename and a
 * **completion** line after the last one. The completion line is §11.4's "one
 * line per accepted operation" and is what {@link readAuditLog} reports as the
 * audit; the intent line is a journal record of work in flight, and an intent
 * with no completion is the signal to check the filesystem and finish or redo.
 * Crucially the intent line **carries the ids the operation is about to mint**,
 * so a resumed `create-entry` re-uses the id rather than inventing another.
 *
 * ## What may not be in it
 *
 * **HARD: never full prompts, transcripts, source-code payloads or entity
 * bodies.** Git is the content diff and history; this is a privacy boundary,
 * not a size optimization. The entry is built field by field from a fixed list
 * in {@link auditRecord} rather than by spreading anything, so a body cannot
 * arrive by accident, and a test asserts a body-carrying operation leaves no
 * trace of its body in the log.
 *
 * Manual Markdown edits stay valid with no entry here, and MEX does not
 * fabricate an actor for them.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { diagnostic, type WikiDiagnostic } from "../model/diagnostic.js";
import type { WikiActor } from "../model/operation.js";
import { insideRoot } from "../index/discover.js";
import type { RevisionChange, WikiPatchPlan } from "./plan.js";

/** Fixed by `MALFORMED_OPERATION_LOG`'s remediation text. */
export const OPERATION_LOG_FILE = "events/operations.jsonl";

export function operationLogPath(scaffoldRoot: string): string {
  return resolve(scaffoldRoot, OPERATION_LOG_FILE);
}

export type AuditPhase = "intent" | "complete";

/** One line of the log. Every field is named; nothing is spread in. */
export interface AuditEntry {
  /** Format version, so a later phase can change the shape without guessing. */
  v: 1;
  phase: AuditPhase;
  opId: string;
  type: string;
  entityIds: string[];
  /** Ids the operation mints. Present on the intent line so a resume reuses them. */
  createdIds: string[];
  actor: WikiActor;
  timestamp: string;
  reason?: string;
  files: string[];
  /** Hash of the proposal, never the proposal. */
  payloadHash: string;
  revisions: RevisionChange[];
  sessionId?: string;
}

export class OperationLogPathError extends Error {
  constructor(path: string) {
    super(`Refusing to touch ${JSON.stringify(path)}: the audit writer appends to ${OPERATION_LOG_FILE} and nothing else.`);
    this.name = "OperationLogPathError";
  }
}

/**
 * The runtime write guard, in the shape `dbfile.ts` established.
 *
 * Being on the lint's allowlist is an exemption with nothing behind it; this is
 * what is behind it. A lint rule cannot tell that `appendFileSync(p, line)` is
 * safe. This can, and it fails closed.
 */
export function assertOperationLogPath(scaffoldRoot: string, path: string): void {
  const root = resolve(scaffoldRoot);
  const target = resolve(path);
  if (basename(target) !== basename(OPERATION_LOG_FILE)) throw new OperationLogPathError(target);
  if (!insideRoot(root, target)) throw new OperationLogPathError(target);
  if (target !== operationLogPath(root)) throw new OperationLogPathError(target);
}

/** Build the record for one phase of a plan. Field by field, deliberately. */
export function auditRecord(plan: WikiPatchPlan, phase: AuditPhase): AuditEntry {
  const entry: AuditEntry = {
    v: 1,
    phase,
    opId: plan.opId,
    type: plan.type,
    entityIds: [...plan.entityIds],
    createdIds: [...plan.createdIds],
    actor: { kind: plan.actor.kind, id: plan.actor.id },
    timestamp: plan.timestamp,
    files: plan.files.map((file) => file.path).sort(),
    payloadHash: plan.payloadHash,
    revisions: plan.revisions.map((change) => ({ ...change })),
  };
  if (plan.reason !== undefined) entry.reason = plan.reason;
  if (plan.actor.sessionId !== undefined) entry.sessionId = plan.actor.sessionId;
  return entry;
}

/** Append one line. Creates `events/` if it is not there yet. */
export function appendAudit(scaffoldRoot: string, entry: AuditEntry): void {
  const path = operationLogPath(scaffoldRoot);
  assertOperationLogPath(scaffoldRoot, path);
  mkdirSync(dirname(path), { recursive: true });
  assertOperationLogPath(scaffoldRoot, path);
  appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf-8");
}

export interface AuditLog {
  entries: AuditEntry[];
  diagnostics: WikiDiagnostic[];
}

/** True when `value` has the shape this reader will act on. */
function isAuditEntry(value: unknown): value is AuditEntry {
  if (value === null || typeof value !== "object") return false;
  const raw = value as Record<string, unknown>;
  return (
    raw["v"] === 1 &&
    (raw["phase"] === "intent" || raw["phase"] === "complete") &&
    typeof raw["opId"] === "string" &&
    typeof raw["type"] === "string" &&
    typeof raw["payloadHash"] === "string" &&
    Array.isArray(raw["entityIds"]) &&
    Array.isArray(raw["createdIds"])
  );
}

/**
 * Read the log, degrading a bad line to a diagnostic.
 *
 * A single unparseable line must never take out the run, and must never touch
 * the Markdown — that is what `MALFORMED_OPERATION_LOG`'s remediation promises.
 * The consequence is stated rather than hidden: a line that cannot be read is a
 * line replay cannot consult, so the diagnostic is what tells a caller their
 * idempotency guarantee has a hole in it at that point.
 */
export function readAuditLog(scaffoldRoot: string): AuditLog {
  const path = operationLogPath(scaffoldRoot);
  if (!existsSync(path)) return { entries: [], diagnostics: [] };

  let text: string;
  try {
    text = readFileSync(path, "utf-8");
  } catch (error) {
    return {
      entries: [],
      diagnostics: [
        diagnostic("MALFORMED_OPERATION_LOG", `Could not read ${OPERATION_LOG_FILE}: ${String(error)}`, {
          file: OPERATION_LOG_FILE,
        }),
      ],
    };
  }

  const entries: AuditEntry[] = [];
  const diagnostics: WikiDiagnostic[] = [];
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!.trim();
    if (line === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      diagnostics.push(
        diagnostic("MALFORMED_OPERATION_LOG", `${OPERATION_LOG_FILE} line ${index + 1} is not valid JSON.`, {
          file: OPERATION_LOG_FILE,
          location: { file: OPERATION_LOG_FILE, startLine: index + 1, endLine: index + 1 },
        }),
      );
      continue;
    }
    if (!isAuditEntry(parsed)) {
      diagnostics.push(
        diagnostic("MALFORMED_OPERATION_LOG", `${OPERATION_LOG_FILE} line ${index + 1} is not an operation record.`, {
          file: OPERATION_LOG_FILE,
          location: { file: OPERATION_LOG_FILE, startLine: index + 1, endLine: index + 1 },
        }),
      );
      continue;
    }
    entries.push(parsed);
  }
  return { entries, diagnostics };
}

/** What the log says about one `opId`. */
export interface OperationRecord {
  intent: AuditEntry | null;
  complete: AuditEntry | null;
}

export function recordFor(log: AuditLog, opId: string): OperationRecord {
  const mine = log.entries.filter((entry) => entry.opId === opId);
  return {
    intent: mine.filter((entry) => entry.phase === "intent").at(-1) ?? null,
    complete: mine.filter((entry) => entry.phase === "complete").at(-1) ?? null,
  };
}

/** The accepted operations, which is what §11.4's "one line each" means. */
export function acceptedOperations(log: AuditLog): AuditEntry[] {
  return log.entries.filter((entry) => entry.phase === "complete");
}
