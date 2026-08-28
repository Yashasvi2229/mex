import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  CheckCircle2,
  ChevronRight,
  FileDiff,
  FilePenLine,
  GitPullRequestArrow,
  Inbox,
  MapPin,
  Pencil,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  InboxDraftDetail,
  InboxDraftInput,
  InboxDraftSummary,
  InboxOperationApplyResponse,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalDetail,
  InboxProposalState,
  InboxProposalSummary,
  InboxSpecKind,
  TeamActorRef,
  Tone,
} from "../api/types";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogMedia,
  AlertDialogTitle,
} from "../components/primitives/alert-dialog";
import { Button } from "../components/primitives/button";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "../components/primitives/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
} from "../components/primitives/field";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Textarea } from "../components/primitives/textarea";
import { ErrorState, PageHeader, StatePanel, StatusPill, formatDate, sentenceCase } from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/inbox.module.css";

const INBOX_PAGE_SIZE = 25;
const specKinds: readonly InboxSpecKind[] = [
  "spec",
  "requirement",
  "constraint",
  "acceptance_criterion",
];
const actionableProposalStates: readonly InboxProposalState[] = ["pending", "stale"];

type Selection = { kind: "draft"; id: string } | { kind: "proposal"; id: string };
type CreateChange = Extract<InboxDraftInput["change"], { kind: "spec.create" }>;
type CreateRelation = NonNullable<CreateChange["relation"]>;
type RelationType = CreateRelation["type"] | "none";
interface TopicAttestation {
  id: string;
  revision: string;
  semanticRevision: number;
}
type ReviewAction =
  | { kind: "inbox.publish"; draft: InboxDraftDetail }
  | { kind: "inbox.draft.delete"; draft: InboxDraftDetail }
  | { kind: "inbox.approve"; proposal: InboxProposalDetail }
  | { kind: "inbox.reject"; proposal: InboxProposalDetail }
  | { kind: "inbox.withdraw"; proposal: InboxProposalDetail }
  | { kind: "inbox.mark-stale"; proposal: InboxProposalDetail }
  | { kind: "inbox.repair"; proposal: InboxProposalDetail };
type SimpleReviewAction = Exclude<ReviewAction, { kind: "inbox.repair" }>;

function afterDialogUnmount(callback: () => void): void {
  queueMicrotask(() => queueMicrotask(callback));
}

function actorLabel(actor: TeamActorRef): string {
  if (actor.kind === "member") return actor.displayName ?? actor.memberId;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function proposalTone(state: InboxProposalState): Tone {
  if (state === "pending") return "info";
  if (state === "stale") return "warning";
  if (state === "approved") return "success";
  if (state === "rejected") return "danger";
  return "neutral";
}

function hasLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return true;
    }
  }
  return false;
}

function canonicalText(value: string, maximumBytes: number, required: boolean): boolean {
  return new TextEncoder().encode(value).byteLength <= maximumBytes
    && value.normalize("NFC") === value
    && !hasLoneSurrogate(value)
    && !/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u2028\u2029]/u.test(value)
    && (!required || value.trim().length > 0);
}

function operationId(label: string): string {
  return `hub_inbox_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function draftExpectation(draft: InboxDraftDetail) {
  return {
    target: { kind: "local" as const, namespace: "inbox-draft" as const, id: draft.id },
    revision: draft.revision,
  };
}

function proposalExpectation(proposal: InboxProposalDetail) {
  return {
    target: { kind: "artifact" as const, path: proposal.sourcePath },
    revision: proposal.revision,
  };
}

function parseTopicAttestations(value: string): {
  items: TopicAttestation[];
  error: string | null;
} {
  if (value.trim() === "") return { items: [], error: null };
  const rows = value.split("\n").filter((row) => row.trim() !== "");
  if (rows.length > 64) return { items: [], error: "Use no more than 64 topic attestations." };
  const items: TopicAttestation[] = [];
  for (const row of rows) {
    const [id, revision, semantic, ...extra] = row.split("|").map((item) => item.trim());
    const semanticRevision = Number(semantic);
    if (
      extra.length > 0
      || !id
      || !/^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(id)
      || !revision
      || !/^[a-f0-9]{64}$/.test(revision)
      || !Number.isInteger(semanticRevision)
      || semanticRevision <= 0
    ) {
      return { items: [], error: "Each topic line must be: mx ID | 64-character file revision | positive semantic revision." };
    }
    items.push({ id, revision, semanticRevision });
  }
  if (new Set(items.map((item) => item.id)).size !== items.length) {
    return { items: [], error: "Each topic endpoint must appear once." };
  }
  return { items, error: null };
}

function relationAccepted(
  sourceKind: InboxSpecKind,
  relationType: RelationType,
  targetKind: InboxSpecKind,
): boolean {
  if (relationType === "none") return true;
  if (relationType === "derived_from") return sourceKind === "requirement" && targetKind === "spec";
  if (relationType === "verified_by") {
    return sourceKind === "acceptance_criterion"
      && (targetKind === "spec" || targetKind === "requirement");
  }
  if (relationType === "refines") return sourceKind === "requirement" && targetKind === "requirement";
  return targetKind === "constraint";
}

function buildCreateRelation(
  relationType: RelationType,
  targetId: string,
  targetKind: InboxSpecKind,
  targetTitle: string,
): CreateRelation | undefined {
  if (relationType === "none") return undefined;
  const title = targetTitle === "" ? {} : { title: targetTitle };
  if (relationType === "derived_from" && targetKind === "spec") {
    return { type: "derived_from", target: { id: targetId, kind: "spec", ...title } };
  }
  if (relationType === "verified_by" && (targetKind === "spec" || targetKind === "requirement")) {
    return { type: "verified_by", target: { id: targetId, kind: targetKind, ...title } };
  }
  if (relationType === "constrained_by" && targetKind === "constraint") {
    return { type: "constrained_by", target: { id: targetId, kind: "constraint", ...title } };
  }
  if (relationType === "refines" && targetKind === "requirement") {
    return { type: "refines", target: { id: targetId, kind: "requirement", ...title } };
  }
  return undefined;
}

function PreviewDocket({ envelope }: { envelope: InboxOperationPreviewResponse }) {
  return (
    <section className={styles.previewDocket} aria-labelledby="inbox-preview-heading">
      <header className={styles.previewHeader}>
        <div>
          <p>Exact review envelope</p>
          <h3 id="inbox-preview-heading">Evidence docket</h3>
        </div>
        <StatusPill tone={envelope.preview.valid ? "success" : "danger"}>
          {envelope.preview.valid ? "Ready for review" : "Invalid"}
        </StatusPill>
      </header>
      <dl className={styles.authorityGrid}>
        <div><dt>Actor</dt><dd>{actorLabel(envelope.receipt.authority.actor)}</dd></div>
        <div><dt>Captured</dt><dd>{formatDate(envelope.receipt.authority.occurredAt)}</dd></div>
        <div><dt>Branch</dt><dd>{envelope.receipt.authority.repoState.branch ?? "Detached HEAD"}</dd></div>
        <div>
          <dt>HEAD</dt>
          <dd><code>{envelope.receipt.authority.repoState.head ?? "Unborn HEAD"}</code></dd>
        </div>
        <div><dt>Worktree</dt><dd>{envelope.receipt.authority.repoState.dirty ? "Dirty · local changes" : "Clean"}</dd></div>
        <div><dt>Repository observed</dt><dd>{formatDate(envelope.receipt.authority.repoState.observedAt)}</dd></div>
        <div><dt>Scope</dt><dd>{sentenceCase(envelope.preview.scope)}</dd></div>
      </dl>
      <div className={styles.digestStrip}>
        <span>Preview digest</span>
        <code>{envelope.receipt.previewRevision}</code>
      </div>
      {envelope.preview.changes.map((change) => (
        <article className={styles.fileChange} key={`${change.kind}:${change.path}`}>
          <header>
            <FileDiff aria-hidden="true" />
            <strong>{change.path}</strong>
            <StatusPill>{change.kind}</StatusPill>
          </header>
          <pre aria-label={`Exact diff for ${change.path}`}><code>{change.diff}</code></pre>
          <footer>
            <code>{change.beforeRevision?.slice(0, 10) ?? "new"}</code>
            <span aria-hidden="true">→</span>
            <code>{change.afterRevision?.slice(0, 10) ?? "removed"}</code>
          </footer>
        </article>
      ))}
      {envelope.preview.localChanges.map((change) => (
        <article className={styles.localChange} key={`${change.namespace}:${change.id}`}>
          <MapPin aria-hidden="true" />
          <div><strong>Checkout-local only</strong><p>{change.summary}</p><code>{change.id}</code></div>
        </article>
      ))}
      {envelope.preview.diagnostics.length > 0 ? (
        <div className={styles.diagnostics} role="status">
          <AlertTriangle aria-hidden="true" />
          <span>{envelope.preview.diagnostics.map((item) => item.message).join(" ")}</span>
        </div>
      ) : (
        <p className={styles.boundEnvelope}><ShieldCheck aria-hidden="true" /> Apply accepts only this complete signed envelope.</p>
      )}
    </section>
  );
}

function DraftEditorDialog({
  draft,
  repair,
  finalFocus,
  focusAppliedStatus,
  onClose,
  onApplied,
}: {
  draft: InboxDraftDetail | null;
  repair: InboxProposalDetail | null;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onClose(): void;
  onApplied(result: InboxOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const changeTypeRef = useRef<HTMLSelectElement>(null);
  const entityKindRef = useRef<HTMLSelectElement>(null);
  const isRepair = repair !== null;
  const sourceInput: InboxDraftInput | undefined = draft?.input ?? (repair === null
    ? undefined
    : {
        change: repair.change,
        rationale: repair.rationale,
        evidence: repair.evidence,
        targetRevisions: repair.targetRevisions,
      });
  const existingChange = sourceInput?.change;
  const existingExpectations = new Map(
    (sourceInput?.targetRevisions ?? []).map((item) => [item.target.id, item]),
  );
  const existingRelation = existingChange?.kind === "spec.create"
    ? existingChange.relation
    : undefined;
  const existingRelationExpectation = existingRelation === undefined
    ? undefined
    : existingExpectations.get(existingRelation.target.id);
  const [mode, setMode] = useState<"create" | "update">(
    existingChange?.kind === "spec.update" ? "update" : "create",
  );
  const [includeTitle, setIncludeTitle] = useState(
    existingChange?.kind === "spec.update"
      ? Object.hasOwn(existingChange.patch, "title")
      : false,
  );
  const [includeSummary, setIncludeSummary] = useState(
    existingChange?.kind === "spec.update"
      ? Object.hasOwn(existingChange.patch, "summary")
      : false,
  );
  const [includeBody, setIncludeBody] = useState(
    existingChange?.kind === "spec.update"
      ? Object.hasOwn(existingChange.patch, "body")
      : true,
  );
  const [entityKind, setEntityKind] = useState<InboxSpecKind>(
    existingChange?.kind === "spec.create" ? existingChange.entityKind : "requirement",
  );
  const [title, setTitle] = useState(
    existingChange?.kind === "spec.create"
      ? existingChange.title
      : existingChange?.patch.title ?? "",
  );
  const [summary, setSummary] = useState(
    existingChange?.kind === "spec.create"
      ? existingChange.summary ?? ""
      : existingChange?.patch.summary ?? "",
  );
  const [body, setBody] = useState(
    existingChange?.kind === "spec.create"
      ? existingChange.body
      : existingChange?.patch.body ?? "",
  );
  const [status, setStatus] = useState<"in_flight" | "promoted">(
    existingChange?.kind === "spec.create" ? existingChange.status : "in_flight",
  );
  const [topicsText, setTopicsText] = useState(
    existingChange?.kind === "spec.create"
      ? (existingChange.topics ?? []).map((id) => {
          const expectation = existingExpectations.get(id);
          return expectation === undefined
            ? `${id} | |`
            : `${id} | ${expectation.revision} | ${expectation.semanticRevision}`;
        }).join("\n")
      : "",
  );
  const [relationType, setRelationType] = useState<RelationType>(
    existingRelation?.type ?? "none",
  );
  const [relationTargetId, setRelationTargetId] = useState(existingRelation?.target.id ?? "");
  const [relationTargetKind, setRelationTargetKind] = useState<InboxSpecKind>(
    existingRelation?.target.kind ?? "spec",
  );
  const [relationTargetTitle, setRelationTargetTitle] = useState(existingRelation?.target.title ?? "");
  const [relationRevision, setRelationRevision] = useState(existingRelationExpectation?.revision ?? "");
  const [relationSemanticRevision, setRelationSemanticRevision] = useState(
    existingRelationExpectation ? String(existingRelationExpectation.semanticRevision) : "",
  );
  const [targetId, setTargetId] = useState(
    existingChange?.kind === "spec.update" ? existingChange.target.id : "",
  );
  const [targetKind, setTargetKind] = useState<InboxSpecKind>(
    existingChange?.kind === "spec.update" ? existingChange.target.kind : "spec",
  );
  const [targetTitle, setTargetTitle] = useState(
    existingChange?.kind === "spec.update" ? existingChange.target.title ?? "" : "",
  );
  const existingTarget = existingChange?.kind === "spec.update"
    ? existingExpectations.get(existingChange.target.id)
    : undefined;
  const [targetRevision, setTargetRevision] = useState(existingTarget?.revision ?? "");
  const [semanticRevision, setSemanticRevision] = useState(
    existingTarget ? String(existingTarget.semanticRevision) : "",
  );
  const [rationale, setRationale] = useState(sourceInput?.rationale ?? "");
  const preservedEvidence = sourceInput?.evidence ?? [];
  const [evidenceNote, setEvidenceNote] = useState("");
  const [envelope, setEnvelope] = useState<InboxOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const applySucceeded = useRef(false);
  const previewGeneration = useRef(0);
  const preview = useMutation({
    mutationFn: ({ request }: { request: InboxOperationPreviewRequest; generation: number }) => (
      api.previewInboxOperation(request)
    ),
    onSuccess: (nextEnvelope, { generation }) => {
      if (generation === previewGeneration.current) setEnvelope(nextEnvelope);
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null) throw new Error("Preview is unavailable.");
      return api.applyInboxOperation(envelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      setConfirmOpen(false);
      await onApplied(result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });

  const invalidate = () => {
    previewGeneration.current += 1;
    setEnvelope(null);
    setConfirmOpen(false);
    preview.reset();
    apply.reset();
  };
  const startPreview = () => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    setEnvelope(null);
    setConfirmOpen(false);
    apply.reset();
    preview.mutate({ request: request(), generation });
  };
  const change = <T,>(setter: (value: T) => void, value: T) => {
    setter(value);
    invalidate();
  };
  const targetRevisionValid = /^[a-f0-9]{64}$/.test(targetRevision);
  const semanticRevisionNumber = Number(semanticRevision);
  const topicAttestations = parseTopicAttestations(topicsText);
  const relationSemanticRevisionNumber = Number(relationSemanticRevision);
  const relationIsValid = relationType === "none" || (
    /^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(relationTargetId)
    && /^[a-f0-9]{64}$/.test(relationRevision)
    && Number.isInteger(relationSemanticRevisionNumber)
    && relationSemanticRevisionNumber > 0
    && canonicalText(relationTargetTitle, 512, false)
    && relationAccepted(entityKind, relationType, relationTargetKind)
  );
  const createExpectationById = new Map<string, TopicAttestation>();
  let createExpectationConflict = false;
  for (const item of topicAttestations.items) createExpectationById.set(item.id, item);
  if (relationType !== "none" && relationIsValid) {
    const current = createExpectationById.get(relationTargetId);
    if (current !== undefined && (
      current.revision !== relationRevision
      || current.semanticRevision !== relationSemanticRevisionNumber
    )) {
      createExpectationConflict = true;
    } else {
      createExpectationById.set(relationTargetId, {
        id: relationTargetId,
        revision: relationRevision,
        semanticRevision: relationSemanticRevisionNumber,
      });
    }
  }
  const createTargetRevisions = [...createExpectationById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((item) => ({
      target: { kind: "entity" as const, id: item.id },
      revision: item.revision,
      semanticRevision: item.semanticRevision,
    }));
  const updateHasPatch = includeTitle || includeSummary || includeBody;
  const canPreview = canonicalText(rationale, 8 * 1024, true)
    && (mode === "create"
      ? canonicalText(body, 16 * 1024, true) && canonicalText(title, 512, true)
      : (!includeBody || canonicalText(body, 16 * 1024, true))
        && (!includeTitle || canonicalText(title, 512, true)))
    && (mode === "create" || includeSummary ? canonicalText(summary, 2 * 1024, false) : true)
    && canonicalText(evidenceNote, 4 * 1024, false)
    && (mode === "create" ? (
      topicAttestations.error === null
      && relationIsValid
      && !createExpectationConflict
    ) : (
      /^mx_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(targetId)
      && targetRevisionValid
      && Number.isInteger(semanticRevisionNumber)
      && semanticRevisionNumber > 0
      && canonicalText(targetTitle, 512, false)
      && updateHasPatch
    ));

  const draftInput = (): InboxDraftInput => ({
    change: mode === "create"
      ? {
          kind: "spec.create",
          entityKind,
          title,
          body,
          ...(summary === "" ? {} : { summary }),
          status,
          ...(topicAttestations.items.length === 0
            ? {}
            : { topics: topicAttestations.items.map((item) => item.id) }),
          ...(relationType === "none"
            ? {}
            : {
                relation: buildCreateRelation(
                  relationType,
                  relationTargetId,
                  relationTargetKind,
                  relationTargetTitle,
                )!,
              }),
        }
      : {
          kind: "spec.update",
          target: {
            id: targetId,
            kind: targetKind,
            ...(targetTitle === "" ? {} : { title: targetTitle }),
          },
          patch: {
            ...(includeTitle ? { title } : {}),
            ...(includeSummary ? { summary } : {}),
            ...(includeBody ? { body } : {}),
          },
        },
    rationale,
    evidence: [
      ...preservedEvidence,
      ...(evidenceNote === "" ? [] : [{ kind: "manual" as const, note: evidenceNote }]),
    ],
    targetRevisions: mode === "create" ? createTargetRevisions : [{
      target: { kind: "entity", id: targetId },
      revision: targetRevision,
      semanticRevision: semanticRevisionNumber,
    }],
  });

  const request = (): InboxOperationPreviewRequest => repair === null
    ? {
        operationId: operationId(draft === null ? "draft_create" : "draft_update"),
        action: {
          kind: "inbox.draft.save",
          ...(draft === null ? {} : { draftId: draft.id }),
          draft: draftInput(),
        },
        expectedRevisions: draft === null ? [] : [draftExpectation(draft)],
      }
    : {
        operationId: operationId("proposal_repair"),
        action: {
          kind: "inbox.repair",
          proposalId: repair.ref.id,
          replacement: draftInput(),
        },
        expectedRevisions: [proposalExpectation(repair)],
      };

  const editorTitle = isRepair
    ? "Repair stale proposal"
    : draft === null ? "Create local Spec draft" : "Edit local Spec draft";
  const previewLabel = isRepair ? "Preview proposal repair" : "Preview local draft";

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !apply.isPending) {
        onClose();
        afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
      }
    }}>
      <DialogContent
        className={styles.editorDialog}
        finalFocus={false}
        initialFocus={draft === null && !isRepair ? changeTypeRef : entityKindRef}
      >
        <DialogHeader>
          <DialogTitle>{editorTitle}</DialogTitle>
          <DialogDescription>
            {isRepair
              ? "Replace the stale request with freshly attested target, topic, and relation revisions. Repair returns it to pending without writing a Spec."
              : "This draft stays private to this checkout. Previewing and saving it does not publish canonical project memory."}
          </DialogDescription>
        </DialogHeader>
        <div className={styles.dialogScroll}>
          <FieldGroup>
            <div className={styles.formPair}>
              <Field>
                <FieldLabel htmlFor="draft-change-kind">Change type</FieldLabel>
                <NativeSelect
                  className={styles.select}
                  disabled={draft !== null || isRepair}
                  id="draft-change-kind"
                  onChange={(event) => change(setMode, event.currentTarget.value as "create" | "update")}
                  ref={changeTypeRef}
                  value={mode}
                >
                  <NativeSelectOption value="create">Create a Spec entity</NativeSelectOption>
                  <NativeSelectOption value="update">Update a Spec entity</NativeSelectOption>
                </NativeSelect>
              </Field>
              <Field>
                <FieldLabel htmlFor="draft-entity-kind">Spec kind</FieldLabel>
                <NativeSelect
                  className={styles.select}
                  id="draft-entity-kind"
                  onChange={(event) => change(
                    mode === "create" ? setEntityKind : setTargetKind,
                    event.currentTarget.value as InboxSpecKind,
                  )}
                  ref={entityKindRef}
                  value={mode === "create" ? entityKind : targetKind}
                >
                  {specKinds.map((kind) => (
                    <NativeSelectOption key={kind} value={kind}>{sentenceCase(kind)}</NativeSelectOption>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            {mode === "update" ? (
              <>
                <Field>
                  <FieldLabel htmlFor="draft-target-id">Canonical Spec ID</FieldLabel>
                  <Input id="draft-target-id" onChange={(event) => change(setTargetId, event.currentTarget.value)} value={targetId} />
                  <FieldDescription>The exact mx ID being updated.</FieldDescription>
                </Field>
                <Field>
                  <FieldLabel htmlFor="draft-target-title">Current title (optional)</FieldLabel>
                  <Input id="draft-target-title" maxLength={512} onChange={(event) => change(setTargetTitle, event.currentTarget.value)} value={targetTitle} />
                </Field>
                <div className={styles.formPair}>
                  <Field>
                    <FieldLabel htmlFor="draft-content-revision">Exact file revision</FieldLabel>
                    <Input className={styles.monoInput} id="draft-content-revision" onChange={(event) => change(setTargetRevision, event.currentTarget.value)} value={targetRevision} />
                  </Field>
                  <Field>
                    <FieldLabel htmlFor="draft-semantic-revision">Semantic revision</FieldLabel>
                    <Input id="draft-semantic-revision" min={1} onChange={(event) => change(setSemanticRevision, event.currentTarget.value)} type="number" value={semanticRevision} />
                  </Field>
                </div>
              </>
            ) : (
              <>
                <Field>
                  <FieldLabel htmlFor="draft-status">Initial lifecycle</FieldLabel>
                  <NativeSelect className={styles.select} id="draft-status" onChange={(event) => change(setStatus, event.currentTarget.value as "in_flight" | "promoted")} value={status}>
                    <NativeSelectOption value="in_flight">In flight</NativeSelectOption>
                    <NativeSelectOption value="promoted">Promoted</NativeSelectOption>
                  </NativeSelect>
                </Field>
                <Field data-invalid={topicAttestations.error !== null || undefined}>
                  <FieldLabel htmlFor="draft-topics">Topic endpoint attestations (optional)</FieldLabel>
                  <Textarea
                    className={styles.monoInput}
                    id="draft-topics"
                    onChange={(event) => change(setTopicsText, event.currentTarget.value)}
                    placeholder="mx_… | 64-character file revision | semantic revision"
                    rows={3}
                    value={topicsText}
                  />
                  <FieldDescription>One typed topic per line. Every endpoint carries its exact file and semantic revision.</FieldDescription>
                  {topicAttestations.error ? <FieldError>{topicAttestations.error}</FieldError> : null}
                </Field>
                <Field>
                  <FieldLabel htmlFor="draft-relation-type">One hierarchy relation (optional)</FieldLabel>
                  <NativeSelect
                    className={styles.select}
                    id="draft-relation-type"
                    onChange={(event) => {
                      const next = event.currentTarget.value as RelationType;
                      setRelationType(next);
                      if (next === "derived_from") setRelationTargetKind("spec");
                      if (next === "verified_by") setRelationTargetKind("requirement");
                      if (next === "constrained_by") setRelationTargetKind("constraint");
                      if (next === "refines") setRelationTargetKind("requirement");
                      invalidate();
                    }}
                    value={relationType}
                  >
                    <NativeSelectOption value="none">No relation</NativeSelectOption>
                    <NativeSelectOption value="derived_from">Derived from</NativeSelectOption>
                    <NativeSelectOption value="verified_by">Verified by</NativeSelectOption>
                    <NativeSelectOption value="constrained_by">Constrained by</NativeSelectOption>
                    <NativeSelectOption value="refines">Refines</NativeSelectOption>
                  </NativeSelect>
                </Field>
                {relationType !== "none" ? (
                  <div className={styles.attestationBlock}>
                    <div className={styles.formPair}>
                      <Field>
                        <FieldLabel htmlFor="draft-relation-target-id">Relation endpoint ID</FieldLabel>
                        <Input id="draft-relation-target-id" onChange={(event) => change(setRelationTargetId, event.currentTarget.value)} value={relationTargetId} />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="draft-relation-target-kind">Endpoint kind</FieldLabel>
                        <NativeSelect className={styles.select} id="draft-relation-target-kind" onChange={(event) => change(setRelationTargetKind, event.currentTarget.value as InboxSpecKind)} value={relationTargetKind}>
                          {specKinds.map((kind) => <NativeSelectOption key={kind} value={kind}>{sentenceCase(kind)}</NativeSelectOption>)}
                        </NativeSelect>
                      </Field>
                    </div>
                    <Field>
                      <FieldLabel htmlFor="draft-relation-target-title">Endpoint title (optional)</FieldLabel>
                      <Input id="draft-relation-target-title" maxLength={512} onChange={(event) => change(setRelationTargetTitle, event.currentTarget.value)} value={relationTargetTitle} />
                    </Field>
                    <div className={styles.formPair}>
                      <Field>
                        <FieldLabel htmlFor="draft-relation-revision">Endpoint file revision</FieldLabel>
                        <Input className={styles.monoInput} id="draft-relation-revision" onChange={(event) => change(setRelationRevision, event.currentTarget.value)} value={relationRevision} />
                      </Field>
                      <Field>
                        <FieldLabel htmlFor="draft-relation-semantic-revision">Endpoint semantic revision</FieldLabel>
                        <Input id="draft-relation-semantic-revision" min={1} onChange={(event) => change(setRelationSemanticRevision, event.currentTarget.value)} type="number" value={relationSemanticRevision} />
                      </Field>
                    </div>
                    {!relationIsValid ? <FieldError>The hierarchy direction, endpoint kind, ID, and exact revisions must form one valid typed relation.</FieldError> : null}
                    {createExpectationConflict ? <FieldError>A topic and relation may share an endpoint only when their exact revisions agree.</FieldError> : null}
                  </div>
                ) : null}
              </>
            )}
            {mode === "update" ? (
              <Field>
                <FieldLabel>Included patch fields</FieldLabel>
                <div aria-label="Included Spec update fields" className={styles.patchToggles} role="group">
                  <Button
                    aria-pressed={includeTitle}
                    onClick={() => change(setIncludeTitle, !includeTitle)}
                    size="sm"
                    type="button"
                    variant={includeTitle ? "secondary" : "outline"}
                  >
                    Title
                  </Button>
                  <Button
                    aria-pressed={includeSummary}
                    onClick={() => change(setIncludeSummary, !includeSummary)}
                    size="sm"
                    type="button"
                    variant={includeSummary ? "secondary" : "outline"}
                  >
                    Summary
                  </Button>
                  <Button
                    aria-pressed={includeBody}
                    onClick={() => change(setIncludeBody, !includeBody)}
                    size="sm"
                    type="button"
                    variant={includeBody ? "secondary" : "outline"}
                  >
                    Body
                  </Button>
                </div>
                <FieldDescription>Select at least one exact field. A selected empty summary explicitly clears it.</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="draft-title">{mode === "create" ? "Title" : "Replacement title (optional)"}</FieldLabel>
              <Input disabled={mode === "update" && !includeTitle} id="draft-title" maxLength={512} onChange={(event) => change(setTitle, event.currentTarget.value)} value={title} />
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-summary">{mode === "create" ? "Summary (optional)" : "Replacement summary"}</FieldLabel>
              <Textarea disabled={mode === "update" && !includeSummary} id="draft-summary" maxLength={2 * 1024} onChange={(event) => change(setSummary, event.currentTarget.value)} rows={3} value={summary} />
              {mode === "update" && includeSummary ? <FieldDescription>Leave empty to clear the canonical summary.</FieldDescription> : null}
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-body">{mode === "create" ? "Spec body" : "Replacement body"}</FieldLabel>
              <Textarea disabled={mode === "update" && !includeBody} id="draft-body" maxLength={16 * 1024} onChange={(event) => change(setBody, event.currentTarget.value)} rows={8} value={body} />
              <FieldDescription>Tabs and line breaks are preserved in the exact canonical preview.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="draft-rationale">Rationale</FieldLabel>
              <Textarea id="draft-rationale" maxLength={8 * 1024} onChange={(event) => change(setRationale, event.currentTarget.value)} rows={4} value={rationale} />
            </Field>
            {preservedEvidence.length > 0 ? (
              <Field>
                <FieldLabel>Existing evidence (preserved)</FieldLabel>
                <EvidenceList evidence={preservedEvidence} />
                <FieldDescription>{isRepair
                  ? "The replacement preserves every existing typed reference; add fresh manual evidence below."
                  : "Editing this draft keeps every typed evidence reference unchanged."}</FieldDescription>
              </Field>
            ) : null}
            <Field>
              <FieldLabel htmlFor="draft-evidence">Additional manual evidence (optional)</FieldLabel>
              <Textarea id="draft-evidence" maxLength={4 * 1024} onChange={(event) => change(setEvidenceNote, event.currentTarget.value)} rows={3} value={evidenceNote} />
            </Field>
            {!canPreview ? <FieldError>Complete the required fields and exact revision attestation before previewing.</FieldError> : null}
          </FieldGroup>
          {preview.isError ? <ErrorState error={preview.error} /> : null}
          {envelope ? <PreviewDocket envelope={envelope} /> : null}
        </div>
        <DialogFooter>
          <Button
            disabled={apply.isPending}
            onClick={() => {
              onClose();
              afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {envelope === null ? (
            <Button disabled={!canPreview || preview.isPending} onClick={startPreview} type="button">
              <FileDiff data-icon="inline-start" /> {preview.isPending ? "Preparing…" : previewLabel}
            </Button>
          ) : (
            <Button ref={confirmTriggerRef} disabled={!envelope.preview.valid} onClick={() => setConfirmOpen(true)} type="button">
              <ShieldCheck data-icon="inline-start" /> {isRepair ? "Review repaired proposal" : "Review draft save"}
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {envelope ? (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent finalFocus={() => applySucceeded.current ? false : confirmTriggerRef.current}>
            <AlertDialogHeader>
              <AlertDialogMedia><MapPin aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>{isRepair ? "Repair this stale proposal?" : "Save this private draft?"}</AlertDialogTitle>
              <AlertDialogDescription>
                {isRepair
                  ? "The exact replacement request and fresh dependency attestations will become the proposal's pending revision. No Spec is written."
                  : "This writes checkout-local draft state only. It does not add proposal prose to Git or modify a canonical Spec."}
              </AlertDialogDescription>
            </AlertDialogHeader>
            {apply.isError ? <ErrorState error={apply.error} /> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
              <AlertDialogAction disabled={apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? "Saving…" : isRepair ? "Repair proposal" : "Save local draft"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}

function reviewCopy(action: ReviewAction) {
  switch (action.kind) {
    case "inbox.publish":
      return {
        title: "Publish private draft",
        description: "Publishing crosses the privacy boundary: checkout-local prose becomes a canonical pending proposal under .mex/inbox. No Spec is changed yet.",
        preview: "Preview publication",
        confirmTitle: "Publish this private draft?",
        confirm: "The reviewed proposal bytes will enter Git-owned team memory and the local draft will be removed.",
        apply: "Publish proposal",
      };
    case "inbox.draft.delete":
      return {
        title: "Delete local draft",
        description: "This operation affects checkout-local draft state only. Canonical proposals and Specs are unchanged.",
        preview: "Preview draft deletion",
        confirmTitle: "Delete this local draft?",
        confirm: "The checkout-local draft will be removed after exact revision revalidation.",
        apply: "Delete local draft",
      };
    case "inbox.approve":
      return {
        title: "Review proposal for approval",
        description: "Approval writes the exact reviewed Spec diff, records the proposal decision, and may add immutable Activity. The private proposal body does not become the Spec body unless shown in the diff.",
        preview: "Preview Spec approval",
        confirmTitle: "Approve this exact Spec change?",
        confirm: "The signed preview will write canonical Spec bytes and close the proposal as approved.",
        apply: "Approve proposal and write Spec",
      };
    case "inbox.reject":
      return {
        title: "Reject proposal",
        description: "Rejection records a canonical review decision without writing a Spec.",
        preview: "Preview rejection",
        confirmTitle: "Reject this proposal?",
        confirm: "The proposal becomes immutable rejected history with the reviewed rationale.",
        apply: "Reject proposal",
      };
    case "inbox.withdraw":
      return {
        title: "Withdraw proposal",
        description: "Withdrawal closes the proposal without writing a Spec. An optional rationale remains in canonical review history.",
        preview: "Preview withdrawal",
        confirmTitle: "Withdraw this proposal?",
        confirm: "The proposal becomes immutable withdrawn history; the target Spec remains unchanged.",
        apply: "Withdraw proposal",
      };
    case "inbox.mark-stale":
      return {
        title: "Mark proposal stale",
        description: "Stale is accepted only when fresh Wiki attestation proves target drift. This does not write a Spec.",
        preview: "Preview stale transition",
        confirmTitle: "Mark this proposal stale?",
        confirm: "The proposal will require repair against fresh exact revisions before approval.",
        apply: "Mark proposal stale",
      };
    case "inbox.repair":
      return {
        title: "Repair stale proposal",
        description: "Repair keeps the proposal pending while replacing its typed request and exact dependency attestations. It does not write a Spec.",
        preview: "Preview proposal repair",
        confirmTitle: "Repair this stale proposal?",
        confirm: "The reviewed replacement request will become the proposal's new pending revision.",
        apply: "Repair proposal",
      };
  }
}

function ReviewActionDialog({
  action,
  finalFocus,
  focusAppliedStatus,
  onClose,
  onApplied,
}: {
  action: SimpleReviewAction;
  finalFocus(): HTMLElement | null;
  focusAppliedStatus(): void;
  onClose(): void;
  onApplied(result: InboxOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const copy = reviewCopy(action);
  const operation = useRef(operationId(action.kind.replaceAll(".", "_")));
  const [rationale, setRationale] = useState("");
  const [envelope, setEnvelope] = useState<InboxOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const confirmTriggerRef = useRef<HTMLButtonElement>(null);
  const applySucceeded = useRef(false);
  const previewGeneration = useRef(0);
  const preview = useMutation({
    mutationFn: ({ request }: { request: InboxOperationPreviewRequest; generation: number }) => (
      api.previewInboxOperation(request)
    ),
    onSuccess: (nextEnvelope, { generation }) => {
      if (generation === previewGeneration.current) setEnvelope(nextEnvelope);
    },
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null) throw new Error("Preview is unavailable.");
      return api.applyInboxOperation(envelope);
    },
    onSuccess: async (result) => {
      applySucceeded.current = true;
      setConfirmOpen(false);
      await onApplied(result);
      onClose();
      afterDialogUnmount(focusAppliedStatus);
    },
  });
  const rationaleRequired = action.kind === "inbox.reject" || action.kind === "inbox.mark-stale";
  const rationaleAccepted = canonicalText(rationale, 8 * 1024, rationaleRequired);

  const request = (): InboxOperationPreviewRequest => {
    if (action.kind === "inbox.publish" || action.kind === "inbox.draft.delete") {
      return {
        operationId: operation.current,
        action: {
          kind: action.kind,
          draftId: action.draft.id,
        },
        expectedRevisions: [draftExpectation(action.draft)],
      };
    }
    const expectedRevisions = [proposalExpectation(action.proposal)];
    if (action.kind === "inbox.approve") {
      return {
        operationId: operation.current,
        action: { kind: "inbox.approve", proposalId: action.proposal.ref.id },
        expectedRevisions,
      };
    }
    if (action.kind === "inbox.reject" || action.kind === "inbox.mark-stale") {
      return {
        operationId: operation.current,
        action: {
          kind: action.kind,
          proposalId: action.proposal.ref.id,
          rationale,
        },
        expectedRevisions,
      };
    }
    if (action.kind === "inbox.withdraw") {
      return {
        operationId: operation.current,
        action: {
          kind: "inbox.withdraw",
          proposalId: action.proposal.ref.id,
          ...(rationale === "" ? {} : { rationale }),
        },
        expectedRevisions,
      };
    }
    throw new Error("Unsupported Inbox review action.");
  };

  const updateRationale = (value: string) => {
    setRationale(value);
    operation.current = operationId(action.kind.replaceAll(".", "_"));
    previewGeneration.current += 1;
    setEnvelope(null);
    setConfirmOpen(false);
    preview.reset();
    apply.reset();
  };
  const startPreview = () => {
    const generation = previewGeneration.current + 1;
    previewGeneration.current = generation;
    setEnvelope(null);
    setConfirmOpen(false);
    apply.reset();
    preview.mutate({ request: request(), generation });
  };

  return (
    <Dialog open onOpenChange={(open) => {
      if (!open && !apply.isPending) {
        onClose();
        afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
      }
    }}>
      <DialogContent className={styles.reviewDialog} finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{copy.title}</DialogTitle>
          <DialogDescription>{copy.description}</DialogDescription>
        </DialogHeader>
        <div className={styles.dialogScroll}>
          <div className={styles.reviewSubject}>
            <span>{"draft" in action ? "Local draft" : "Canonical proposal"}</span>
            <strong>{"draft" in action ? action.draft.title : action.proposal.title}</strong>
            <code>{"draft" in action ? action.draft.id : action.proposal.ref.id}</code>
          </div>
          {action.kind === "inbox.approve" ? (
            <section aria-labelledby="approval-proposal-snapshot" className={styles.proposalSnapshot}>
              <h3 id="approval-proposal-snapshot">Immutable proposal snapshot</h3>
              <ChangeDetail input={{
                change: action.proposal.change,
                rationale: action.proposal.rationale,
                evidence: action.proposal.evidence,
                targetRevisions: action.proposal.targetRevisions,
              }} />
            </section>
          ) : null}
          {action.kind === "inbox.reject" || action.kind === "inbox.withdraw" || action.kind === "inbox.mark-stale" ? (
            <Field data-invalid={!rationaleAccepted || undefined}>
              <FieldLabel htmlFor="proposal-review-rationale">Review rationale</FieldLabel>
              <Textarea
                autoFocus
                id="proposal-review-rationale"
                maxLength={8 * 1024}
                onChange={(event) => updateRationale(event.currentTarget.value)}
                rows={5}
                value={rationale}
              />
              <FieldDescription>
                {rationaleRequired ? "Required for this review transition." : "Optional for withdrawal."}
              </FieldDescription>
              {!rationaleAccepted ? <FieldError>Enter valid bounded review rationale.</FieldError> : null}
            </Field>
          ) : null}
          {preview.isError ? <ErrorState error={preview.error} /> : null}
          {envelope ? <PreviewDocket envelope={envelope} /> : null}
        </div>
        <DialogFooter>
          <Button
            disabled={apply.isPending}
            onClick={() => {
              onClose();
              afterDialogUnmount(() => finalFocus()?.focus({ preventScroll: true }));
            }}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          {envelope === null ? (
            <Button disabled={!rationaleAccepted || preview.isPending} onClick={startPreview} type="button">
              <FileDiff data-icon="inline-start" /> {preview.isPending ? "Preparing…" : copy.preview}
            </Button>
          ) : (
            <Button ref={confirmTriggerRef} disabled={!envelope.preview.valid} onClick={() => setConfirmOpen(true)} type="button">
              <ShieldCheck data-icon="inline-start" /> Review exact preview
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
      {envelope ? (
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <AlertDialogContent finalFocus={() => applySucceeded.current ? false : confirmTriggerRef.current}>
            <AlertDialogHeader>
              <AlertDialogMedia><CheckCircle2 aria-hidden="true" /></AlertDialogMedia>
              <AlertDialogTitle>{copy.confirmTitle}</AlertDialogTitle>
              <AlertDialogDescription>
                {copy.confirm} Exact preview <code>{envelope.receipt.previewRevision.slice(0, 12)}</code> will be revalidated.
              </AlertDialogDescription>
            </AlertDialogHeader>
            {apply.isError ? <ErrorState error={apply.error} /> : null}
            <AlertDialogFooter>
              <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
              <AlertDialogAction disabled={apply.isPending} onClick={() => apply.mutate()}>
                {apply.isPending ? "Applying…" : copy.apply}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      ) : null}
    </Dialog>
  );
}

function EvidenceList({ evidence }: { evidence: InboxDraftInput["evidence"] }) {
  if (evidence.length === 0) return <p className={styles.mutedCopy}>No evidence references recorded.</p>;
  return (
    <ul className={styles.evidenceList}>
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${index}`}>
          <span>{sentenceCase(item.kind)}</span>
          <code>
            {item.kind === "entity" ? item.entity.title ?? item.entity.id
              : item.kind === "code" ? (item.code.kind === "file" ? item.code.path : item.code.symbolId)
                : item.kind === "commit" ? item.hash
                  : item.kind === "file" ? item.path
                    : item.kind === "external" ? item.label ?? item.uri
                      : item.note}
          </code>
        </li>
      ))}
    </ul>
  );
}

function ChangeDetail({ input }: { input: InboxDraftInput }) {
  const change = input.change;
  return (
    <div className={styles.detailSections}>
      <section>
        <p className={styles.sectionEyebrow}>Typed change</p>
        <dl className={styles.factGrid}>
          <div><dt>Operation</dt><dd>{sentenceCase(change.kind)}</dd></div>
          <div><dt>Entity kind</dt><dd>{sentenceCase(change.kind === "spec.create" ? change.entityKind : change.target.kind)}</dd></div>
          {change.kind === "spec.update" ? <div><dt>Target</dt><dd><code>{change.target.id}</code></dd></div> : null}
          {change.kind === "spec.create" ? <div><dt>Lifecycle</dt><dd>{sentenceCase(change.status)}</dd></div> : null}
        </dl>
        {change.kind === "spec.create" ? (
          <>
            {change.summary !== undefined ? <p className={styles.summaryCopy}>{change.summary}</p> : null}
            <pre aria-label="Draft Spec body"><code>{change.body}</code></pre>
          </>
        ) : (
          <div className={styles.patchStack}>
            {change.patch.title !== undefined ? <div><span>Title</span><p>{change.patch.title}</p></div> : null}
            {change.patch.summary !== undefined ? <div><span>Summary</span><p>{change.patch.summary}</p></div> : null}
            {change.patch.body !== undefined ? <div><span>Body</span><pre aria-label="Proposed replacement Spec body"><code>{change.patch.body}</code></pre></div> : null}
          </div>
        )}
      </section>
      <section>
        <p className={styles.sectionEyebrow}>Review rationale</p>
        <p className={styles.prose}>{input.rationale}</p>
      </section>
      <section>
        <p className={styles.sectionEyebrow}>Evidence</p>
        <EvidenceList evidence={input.evidence} />
      </section>
      <section>
        <p className={styles.sectionEyebrow}>Exact dependency attestations</p>
        {input.targetRevisions.length === 0 ? (
          <p className={styles.mutedCopy}>No existing Spec dependencies.</p>
        ) : (
          <ul className={styles.revisionList}>
            {input.targetRevisions.map((item) => (
              <li key={item.target.id}>
                <code>{item.target.id}</code>
                <span>semantic r{item.semanticRevision}</span>
                <code>{item.revision}</code>
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function DraftDetail({
  draft,
  canMutate,
  canPublish,
  onEdit,
  onAction,
}: {
  draft: InboxDraftDetail;
  canMutate: boolean;
  canPublish: boolean;
  onEdit(event: MouseEvent<HTMLButtonElement>): void;
  onAction(action: ReviewAction, event: MouseEvent<HTMLButtonElement>): void;
}) {
  return (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <CardDescription>Private checkout draft</CardDescription>
          <CardTitle><h2>{draft.title}</h2></CardTitle>
          <code>{draft.id}</code>
        </div>
        <CardAction><StatusPill tone="neutral">Local only</StatusPill></CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        <div className={styles.detailActions}>
          <Button disabled={!canMutate} onClick={onEdit} size="sm" type="button" variant="outline">
            <Pencil data-icon="inline-start" /> Edit local draft
          </Button>
          <Button disabled={!canPublish} onClick={(event) => onAction({ kind: "inbox.publish", draft }, event)} size="sm" type="button">
            <Send data-icon="inline-start" /> Publish draft
          </Button>
          <Button disabled={!canMutate} onClick={(event) => onAction({ kind: "inbox.draft.delete", draft }, event)} size="sm" type="button" variant="destructive">
            <Trash2 data-icon="inline-start" /> Delete draft
          </Button>
        </div>
        <div className={styles.privacyBoundary}>
          <ShieldCheck aria-hidden="true" />
          <p><strong>Privacy boundary intact.</strong> This prose remains outside Git and canonical team memory until you review and publish an exact proposal diff.</p>
        </div>
        <ChangeDetail input={draft.input} />
      </CardContent>
    </>
  );
}

function ProposalDetail({
  proposal,
  canReview,
  canSpecMutate,
  onAction,
}: {
  proposal: InboxProposalDetail;
  canReview: boolean;
  canSpecMutate: boolean;
  onAction(action: ReviewAction, event: MouseEvent<HTMLButtonElement>): void;
}) {
  const terminal = proposal.state === "approved" || proposal.state === "rejected" || proposal.state === "withdrawn";
  return (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <CardDescription>Canonical review proposal</CardDescription>
          <CardTitle><h2>{proposal.title}</h2></CardTitle>
          <code>{proposal.ref.id}</code>
        </div>
        <CardAction><StatusPill tone={proposalTone(proposal.state)}>{sentenceCase(proposal.state)}</StatusPill></CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        <dl className={styles.proposalMeta}>
          <div><dt>Author</dt><dd>{actorLabel(proposal.author)}</dd></div>
          <div><dt>Revision</dt><dd><code>{proposal.revision.slice(0, 12)}</code></dd></div>
          <div><dt>Source</dt><dd><code>{proposal.sourcePath}</code></dd></div>
        </dl>
        {!terminal ? (
          <div className={styles.detailActions} aria-label="Proposal review actions">
            {proposal.state === "pending" ? (
              <>
                <Button disabled={!canSpecMutate} onClick={(event) => onAction({ kind: "inbox.approve", proposal }, event)} size="sm" type="button">
                  <CheckCircle2 data-icon="inline-start" /> Review &amp; approve
                </Button>
                <Button disabled={!canReview} onClick={(event) => onAction({ kind: "inbox.reject", proposal }, event)} size="sm" type="button" variant="destructive">
                  <XCircle data-icon="inline-start" /> Reject proposal
                </Button>
                <Button disabled={!canSpecMutate} onClick={(event) => onAction({ kind: "inbox.mark-stale", proposal }, event)} size="sm" type="button" variant="outline">
                  <AlertTriangle data-icon="inline-start" /> Mark stale
                </Button>
              </>
            ) : (
              <Button disabled={!canSpecMutate} onClick={(event) => onAction({ kind: "inbox.repair", proposal }, event)} size="sm" type="button">
                <Wrench data-icon="inline-start" /> Repair proposal
              </Button>
            )}
            {proposal.state === "pending" ? (
              <Button disabled={!canReview} onClick={(event) => onAction({ kind: "inbox.withdraw", proposal }, event)} size="sm" type="button" variant="outline">
                Withdraw proposal
              </Button>
            ) : null}
          </div>
        ) : (
          <div className={styles.terminalNote}>
            <ShieldCheck aria-hidden="true" />
            <p><strong>Immutable review history.</strong> Terminal proposals cannot be edited or reviewed again.</p>
          </div>
        )}
        {proposal.reviewRationale ? (
          <section className={styles.reviewDecision}>
            <p className={styles.sectionEyebrow}>Recorded decision</p>
            <p>{proposal.reviewRationale}</p>
            <small>{proposal.reviewer ? actorLabel(proposal.reviewer) : "Reviewer unavailable"} · {formatDate(proposal.reviewedAt)}</small>
          </section>
        ) : null}
        <ChangeDetail input={{
          change: proposal.change,
          rationale: proposal.rationale,
          evidence: proposal.evidence,
          targetRevisions: proposal.targetRevisions,
        }} />
      </CardContent>
    </>
  );
}

export function InboxPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [selection, setSelection] = useState<Selection | null>(null);
  const [editor, setEditor] = useState<{ draft: InboxDraftDetail | null } | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [status, setStatus] = useState("");
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const readAvailable = capabilities?.inbox.read.availability === "available";
  const canEditDrafts = capabilities?.inbox.draftMutation.availability === "available";
  const canReviewProposals = capabilities?.inbox.proposalMutation.availability === "available";
  const canApproveSpecs = capabilities?.inbox.specApproval.availability === "available";
  const resolveOperationFinalFocus = () => operationTrigger.current;
  const focusAppliedStatus = () => {
    statusRef.current?.focus({ preventScroll: true });
    operationTrigger.current = null;
  };

  const drafts = useInfiniteQuery({
    queryKey: ["inbox", "drafts"],
    queryFn: ({ pageParam }) => api.getInboxDrafts({
      limit: INBOX_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const proposals = useInfiniteQuery({
    queryKey: ["inbox", "proposals", "actionable"],
    queryFn: ({ pageParam }) => api.getInboxProposals({
      states: [...actionableProposalStates],
      limit: INBOX_PAGE_SIZE,
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const draftRows = useMemo(() => {
    const unique = new Map<string, InboxDraftSummary>();
    for (const page of drafts.data?.pages ?? []) {
      for (const item of page.items) unique.set(item.id, item);
    }
    return [...unique.values()];
  }, [drafts.data?.pages]);
  const proposalRows = useMemo(() => {
    const unique = new Map<string, InboxProposalSummary>();
    for (const page of proposals.data?.pages ?? []) {
      for (const item of page.items) unique.set(item.ref.id, item);
    }
    return [...unique.values()];
  }, [proposals.data?.pages]);
  const activeSelection = selection
    ?? (proposalRows[0] ? { kind: "proposal" as const, id: proposalRows[0].ref.id }
      : draftRows[0] ? { kind: "draft" as const, id: draftRows[0].id }
        : null);
  const selectedDraftId = activeSelection?.kind === "draft" ? activeSelection.id : null;
  const selectedProposalId = activeSelection?.kind === "proposal" ? activeSelection.id : null;
  const draftDetail = useQuery({
    queryKey: ["inbox", "draft", selectedDraftId],
    queryFn: () => api.getInboxDraft(selectedDraftId!),
    enabled: Boolean(readAvailable && selectedDraftId),
    retry: false,
  });
  const proposalDetail = useQuery({
    queryKey: ["inbox", "proposal", selectedProposalId],
    queryFn: () => api.getInboxProposal(selectedProposalId!),
    enabled: Boolean(readAvailable && selectedProposalId),
    retry: false,
  });

  const rememberTrigger = (event: MouseEvent<HTMLButtonElement>) => {
    operationTrigger.current = event.currentTarget;
  };
  const openEditor = (draft: InboxDraftDetail | null, event: MouseEvent<HTMLButtonElement>) => {
    rememberTrigger(event);
    setEditor({ draft });
  };
  const openReview = (action: ReviewAction, event: MouseEvent<HTMLButtonElement>) => {
    rememberTrigger(event);
    setReviewAction(action);
  };
  const onApplied = async (result: InboxOperationApplyResponse) => {
    setSelection(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["inbox"] }),
      queryClient.invalidateQueries({ queryKey: ["home"] }),
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
      queryClient.invalidateQueries({ queryKey: ["specs"] }),
    ]);
    const consequence = result.changes.length > 0 && result.localChanges.length > 0
      ? "Canonical proposal bytes published and the private draft was removed."
      : result.changes.length > 0
        ? "Canonical Inbox review applied from the exact preview."
        : "Checkout-local draft state updated from the exact preview.";
    flushSync(() => setStatus(consequence));
  };

  return (
    <div className={styles.page} data-inbox-workbench={readAvailable ? "ready" : "unavailable"}>
      <PageHeader
        eyebrow="Spec authoring"
        title="Inbox"
        description="Shape private drafts, publish deliberate proposals, and approve only the exact canonical Spec diff."
        actions={canEditDrafts ? (
          <Button onClick={(event) => openEditor(null, event)} type="button">
            <Plus data-icon="inline-start" /> New local draft
          </Button>
        ) : undefined}
      />
      {status === "" ? (
        <div className={styles.liveStatus} aria-live="polite" role="status" />
      ) : (
        <div className={styles.statusBanner} ref={statusRef} role="status" tabIndex={-1}>
          <CheckCircle2 aria-hidden="true" /> {status}
        </div>
      )}

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Inbox capability" detail="Confirming the private Spec-authoring service connection." />
      ) : !readAvailable ? (
        <StatePanel
          state="unavailable"
          title="Inbox is unavailable"
          detail={capabilities.inbox.read.reason ?? "Inbox reads are not connected in this Hub process."}
        />
      ) : (
        <div className={styles.workbench}>
          <div className={styles.queues}>
            <Card className={styles.queueCard} role="region" aria-labelledby="draft-rail-heading">
              <CardHeader className={styles.queueHeader}>
                <div>
                  <CardDescription>Checkout-local</CardDescription>
                  <CardTitle><h2 id="draft-rail-heading">Private draft rail</h2></CardTitle>
                </div>
                <CardAction><StatusPill>{draftRows.length} loaded</StatusPill></CardAction>
              </CardHeader>
              <CardContent className={styles.queueContent}>
                {drafts.isPending ? (
                  <StatePanel compact state="loading" title="Reading local drafts" detail="Loading the first bounded page." />
                ) : drafts.isError ? (
                  <ErrorState error={drafts.error} retry={() => void drafts.refetch()} />
                ) : draftRows.length === 0 ? (
                  <StatePanel compact state="empty" title="No private drafts" detail="Create a typed Spec draft when an idea is ready for deliberate review." />
                ) : (
                  <ul className={styles.queueList}>
                    {draftRows.map((draft) => (
                      <li key={draft.id}>
                        <button
                          aria-current={selectedDraftId === draft.id ? "true" : undefined}
                          data-inbox-draft-id={draft.id}
                          data-selected={selectedDraftId === draft.id ? "true" : undefined}
                          onClick={() => setSelection({ kind: "draft", id: draft.id })}
                          type="button"
                        >
                          <span className={styles.queueGlyph}><FilePenLine aria-hidden="true" /></span>
                          <span><strong>{draft.title}</strong><small>{sentenceCase(draft.entityKind)} · {formatDate(draft.updatedAt)}</small></span>
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {drafts.hasNextPage ? (
                  <Button disabled={drafts.isFetchingNextPage} onClick={() => void drafts.fetchNextPage()} size="sm" type="button" variant="outline">
                    {drafts.isFetchingNextPage ? "Loading…" : "Load more drafts"}
                  </Button>
                ) : drafts.data && drafts.data.pages.length >= MAX_WORKBENCH_PAGES ? (
                  <p className={styles.boundNote}>Draft page limit reached.</p>
                ) : null}
              </CardContent>
            </Card>

            <Card className={styles.queueCard} role="region" aria-labelledby="proposal-queue-heading">
              <CardHeader className={styles.queueHeader}>
                <div>
                  <CardDescription>Canonical · pending &amp; stale</CardDescription>
                  <CardTitle><h2 id="proposal-queue-heading">Proposal review queue</h2></CardTitle>
                </div>
                <CardAction><StatusPill tone={proposalRows.length > 0 ? "warning" : "neutral"}>{proposalRows.length} actionable</StatusPill></CardAction>
              </CardHeader>
              <CardContent className={styles.queueContent}>
                {proposals.isPending ? (
                  <StatePanel compact state="loading" title="Reading proposal queue" detail="Loading the first bounded page." />
                ) : proposals.isError ? (
                  <ErrorState error={proposals.error} retry={() => void proposals.refetch()} />
                ) : proposalRows.length === 0 ? (
                  <StatePanel compact state="empty" title="Review queue is clear" detail="No pending or stale canonical proposals need attention." />
                ) : (
                  <ul className={styles.queueList}>
                    {proposalRows.map((proposal) => (
                      <li key={proposal.ref.id}>
                        <button
                          aria-current={selectedProposalId === proposal.ref.id ? "true" : undefined}
                          data-inbox-proposal-id={proposal.ref.id}
                          data-selected={selectedProposalId === proposal.ref.id ? "true" : undefined}
                          onClick={() => setSelection({ kind: "proposal", id: proposal.ref.id })}
                          type="button"
                        >
                          <span className={styles.queueGlyph} data-state={proposal.state}><GitPullRequestArrow aria-hidden="true" /></span>
                          <span><strong>{proposal.title}</strong><small>{actorLabel(proposal.author)} · {sentenceCase(proposal.entityKind)}</small></span>
                          <StatusPill tone={proposalTone(proposal.state)}>{sentenceCase(proposal.state)}</StatusPill>
                          <ChevronRight aria-hidden="true" />
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
                {proposals.hasNextPage ? (
                  <Button disabled={proposals.isFetchingNextPage} onClick={() => void proposals.fetchNextPage()} size="sm" type="button" variant="outline">
                    {proposals.isFetchingNextPage ? "Loading…" : "Load more proposals"}
                  </Button>
                ) : proposals.data && proposals.data.pages.length >= MAX_WORKBENCH_PAGES ? (
                  <p className={styles.boundNote}>Proposal page limit reached.</p>
                ) : null}
              </CardContent>
            </Card>
          </div>

          <Card className={styles.detailCard} role="region" aria-label="Selected Inbox review detail">
            {activeSelection === null ? (
              <StatePanel compact state="empty" title="No Inbox item selected" detail="Choose a private draft or actionable proposal from the review desk." />
            ) : activeSelection.kind === "draft" ? (
              draftDetail.isPending ? (
                <StatePanel compact state="loading" title="Reading private draft" detail="Loading the checkout-local body only after selection." />
              ) : draftDetail.isError ? (
                <ErrorState error={draftDetail.error} retry={() => void draftDetail.refetch()} />
              ) : (
                <DraftDetail
                  canMutate={Boolean(canEditDrafts)}
                  canPublish={Boolean(canApproveSpecs)}
                  draft={draftDetail.data}
                  onAction={openReview}
                  onEdit={(event) => openEditor(draftDetail.data, event)}
                />
              )
            ) : proposalDetail.isPending ? (
              <StatePanel compact state="loading" title="Reading proposal evidence" detail="Loading the canonical body only after selection." />
            ) : proposalDetail.isError ? (
              <ErrorState error={proposalDetail.error} retry={() => void proposalDetail.refetch()} />
            ) : (
              <ProposalDetail
                canSpecMutate={Boolean(canApproveSpecs)}
                canReview={Boolean(canReviewProposals)}
                onAction={openReview}
                proposal={proposalDetail.data}
              />
            )}
          </Card>
        </div>
      )}

      <aside className={styles.boundaryNote}>
        <Inbox aria-hidden="true" />
        <p><strong>Review desk, not a background worker.</strong> Lists begin at 25 summaries, details load on selection, and nothing polls or writes without an explicit preview and confirmation.</p>
      </aside>

      {editor ? (
        <DraftEditorDialog
          draft={editor.draft}
          repair={null}
          finalFocus={resolveOperationFinalFocus}
          focusAppliedStatus={focusAppliedStatus}
          onApplied={onApplied}
          onClose={() => setEditor(null)}
        />
      ) : null}
      {reviewAction?.kind === "inbox.repair" ? (
        <DraftEditorDialog
          draft={null}
          repair={reviewAction.proposal}
          finalFocus={resolveOperationFinalFocus}
          focusAppliedStatus={focusAppliedStatus}
          onApplied={onApplied}
          onClose={() => setReviewAction(null)}
        />
      ) : reviewAction ? (
        <ReviewActionDialog
          action={reviewAction}
          finalFocus={resolveOperationFinalFocus}
          focusAppliedStatus={focusAppliedStatus}
          onApplied={onApplied}
          onClose={() => setReviewAction(null)}
        />
      ) : null}
    </div>
  );
}
