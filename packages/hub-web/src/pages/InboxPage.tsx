import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  BookOpen,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FileDiff,
  FileText,
  FilePenLine,
  GitCommitHorizontal,
  GitPullRequestArrow,
  Inbox,
  MapPin,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  ShieldCheck,
  Trash2,
  Wrench,
  XCircle,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { flushSync } from "react-dom";
import { Link, useOutletContext, useSearchParams } from "react-router-dom";
import {
  GraphSymbolIdSchema,
  InboxDraftIdSchema,
  InboxProposalIdSchema,
  WikiEntityIdSchema,
} from "@mex/hub-contracts";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  InboxDraftDetail,
  InboxDraftInput,
  InboxDraftSummary,
  InboxEvidenceRef,
  InboxOperationApplyResponse,
  InboxOperationPreviewRequest,
  InboxOperationPreviewResponse,
  InboxProposalDetail,
  InboxProposalState,
  InboxProposalSummary,
  InboxSpecKind,
  HomeResponse,
  TeamActorRef,
  TeamCurrentActorResponse,
  Tone,
  WikiEntityDetailResponse,
} from "../api/types";
import { Alert, AlertDescription, AlertTitle } from "../components/primitives/alert";
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
import { Badge } from "../components/primitives/badge";
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "../components/primitives/collapsible";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../components/primitives/empty";
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from "../components/primitives/item";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Skeleton } from "../components/primitives/skeleton";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "../components/primitives/tabs";
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
  if (actor.kind === "member") return actor.displayName ?? "Team member";
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown identity";
}

export function inboxActorMatches(current: TeamActorRef, author: TeamActorRef): boolean {
  if (current.kind === "unknown" || author.kind === "unknown" || current.kind !== author.kind) {
    return false;
  }
  if (current.kind === "member" && author.kind === "member") {
    return current.memberId === author.memberId;
  }
  return current.kind === "git"
    && author.kind === "git"
    && current.name === author.name
    && current.email === author.email;
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

function safeExternalEvidenceUri(value: string): string | null {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:")
      && parsed.username === ""
      && parsed.password === ""
      ? parsed.href
      : null;
  } catch {
    return null;
  }
}

function EvidenceValue({ item }: { item: InboxEvidenceRef }) {
  if (item.kind === "entity") {
    const validId = WikiEntityIdSchema.safeParse(item.entity.id);
    const label = item.entity.title ?? `Referenced ${sentenceCase(item.entity.kind)}`;
    return validId.success
      ? <Link to={`/knowledge/${encodeURIComponent(validId.data)}`}>{label}</Link>
      : <span>{label}</span>;
  }
  if (item.kind === "code") {
    if (item.code.kind === "file") return <code>{item.code.path}</code>;
    const validId = GraphSymbolIdSchema.safeParse(item.code.symbolId);
    return validId.success
      ? <Link to={`/code/symbols/${encodeURIComponent(validId.data)}`}><code>{item.code.symbolId}</code></Link>
      : <code>{item.code.symbolId}</code>;
  }
  if (item.kind === "external") {
    const href = safeExternalEvidenceUri(item.uri);
    return href === null
      ? <span>{item.label ?? "External evidence"}</span>
      : (
          <a href={href} rel="noopener noreferrer" target="_blank">
            {item.label ?? item.uri}
            <ExternalLink aria-hidden="true" />
          </a>
        );
  }
  if (item.kind === "commit") return <code>{item.hash}</code>;
  if (item.kind === "file") return <code>{item.path}</code>;
  return <p>{item.note}</p>;
}

function EvidenceIcon({ item }: { item: InboxEvidenceRef }) {
  if (item.kind === "entity") return <BookOpen aria-hidden="true" />;
  if (item.kind === "code") return <Code2 aria-hidden="true" />;
  if (item.kind === "commit") return <GitCommitHorizontal aria-hidden="true" />;
  if (item.kind === "file") return <FileText aria-hidden="true" />;
  if (item.kind === "external") return <ExternalLink aria-hidden="true" />;
  return <FilePenLine aria-hidden="true" />;
}

function evidenceLabel(item: InboxEvidenceRef): string {
  if (item.kind === "entity") return "Knowledge";
  if (item.kind === "code") return item.code.kind === "symbol" ? "Code symbol" : "Code file";
  if (item.kind === "commit") return "Commit";
  if (item.kind === "file") return "File";
  if (item.kind === "external") return "External source";
  return "Review note";
}

function EvidenceList({ evidence }: { evidence: InboxDraftInput["evidence"] }) {
  if (evidence.length === 0) {
    return <p className={styles.mutedCopy}>No supporting evidence was included.</p>;
  }
  return (
    <ul className={styles.semanticEvidenceList}>
      {evidence.map((item, index) => (
        <li key={`${item.kind}:${index}`}>
          <span className={styles.evidenceIcon}><EvidenceIcon item={item} /></span>
          <div>
            <small>{evidenceLabel(item)}</small>
            <EvidenceValue item={item} />
          </div>
        </li>
      ))}
    </ul>
  );
}

function relationPhrase(relation: CreateRelation): string {
  if (relation.type === "derived_from") return "Derived from";
  if (relation.type === "constrained_by") return "Constrained by";
  if (relation.type === "verified_by") return "Verified by";
  return "Refines";
}

function RelatedKnowledge({ change }: { change: InboxDraftInput["change"] }) {
  if (change.kind !== "spec.create") return null;
  const relation = change.relation;
  if (relation === undefined) return null;
  return (
    <section>
      <h3>Related knowledge</h3>
      <ul className={styles.relationshipList}>
        <li>
          <span>{relationPhrase(relation)}</span>
          <Link to={`/knowledge/${encodeURIComponent(relation.target.id)}`}>
            {relation.target.title ?? `Related ${sentenceCase(relation.target.kind)}`}
          </Link>
        </li>
      </ul>
    </section>
  );
}

function ComparisonValue({
  children,
  empty = "Not set",
}: {
  children: string | null | undefined;
  empty?: string;
}) {
  return <p>{children === null || children === undefined || children === "" ? empty : children}</p>;
}

function UpdateComparison({
  change,
  current,
  currentError,
  currentPending,
}: {
  change: Extract<InboxDraftInput["change"], { kind: "spec.update" }>;
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
}) {
  const fields = [
    ...Object.hasOwn(change.patch, "title")
      ? [{ name: "Title", current: current?.entity.title, proposed: change.patch.title }]
      : [],
    ...Object.hasOwn(change.patch, "summary")
      ? [{ name: "Summary", current: current?.entity.summary, proposed: change.patch.summary, empty: "No summary" }]
      : [],
    ...Object.hasOwn(change.patch, "body")
      ? [{ name: "Body", current: current?.body.content, proposed: change.patch.body }]
      : [],
  ];
  return (
    <div className={styles.updatePresentation}>
      <p className={styles.targetCopy}>
        Updates <strong>{change.target.title ?? current?.entity.title ?? sentenceCase(change.target.kind)}</strong>
      </p>
      {currentPending ? (
        <div className={styles.comparisonLoading}>
          <Skeleton /><Skeleton /><Skeleton />
        </div>
      ) : null}
      {currentError ? (
        <Alert className={styles.readWarning}>
          <AlertTriangle aria-hidden="true" />
          <AlertTitle>Current Spec content could not be read</AlertTitle>
          <AlertDescription>
            Proposed values remain available below. The approval preview is still the final freshness authority. {currentError}
          </AlertDescription>
        </Alert>
      ) : null}
      <div className={styles.comparisonStack}>
        {fields.map((field) => (
          <section key={field.name} aria-label={`${field.name} comparison`}>
            <h4>{field.name}</h4>
            <div>
              <article>
                <span>Current</span>
                {current ? <ComparisonValue empty={field.empty} children={field.current} /> : <p className={styles.unavailableValue}>Unavailable</p>}
              </article>
              <article>
                <span>Proposed</span>
                <ComparisonValue empty={field.empty} children={field.proposed} />
              </article>
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}

function ChangeDetail({
  current,
  currentError,
  currentPending,
  input,
}: {
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
  input: InboxDraftInput;
}) {
  const change = input.change;
  return (
    <div className={styles.semanticSections}>
      <section>
        <h3>What will change</h3>
        {change.kind === "spec.create" ? (
          <div className={styles.createPresentation}>
            <dl className={styles.humanFacts}>
              <div><dt>Entity type</dt><dd>{sentenceCase(change.entityKind)}</dd></div>
              <div><dt>Lifecycle</dt><dd>{sentenceCase(change.status)}</dd></div>
            </dl>
            <h4>{change.title}</h4>
            {change.summary !== undefined && change.summary !== "" ? <p className={styles.summaryCopy}>{change.summary}</p> : null}
            <div className={styles.bodyProse}>{change.body}</div>
          </div>
        ) : (
          <UpdateComparison
            change={change}
            current={current}
            currentError={currentError}
            currentPending={currentPending}
          />
        )}
      </section>
      <section>
        <h3>Why this change</h3>
        <p className={styles.prose}>{input.rationale}</p>
      </section>
      <section>
        <h3>Evidence</h3>
        <EvidenceList evidence={input.evidence} />
      </section>
      <RelatedKnowledge change={change} />
    </div>
  );
}

function TechnicalDetails({
  draft,
  input,
  proposal,
}: {
  draft?: InboxDraftDetail;
  input: InboxDraftInput;
  proposal?: InboxProposalDetail;
}) {
  const rawEvidence = input.evidence.filter(
    (item): item is Extract<InboxEvidenceRef, { kind: "entity" | "code" }> => (
      item.kind === "entity" || item.kind === "code"
    ),
  );
  return (
    <Collapsible className={styles.technicalDetails}>
      <CollapsibleTrigger render={<Button size="sm" type="button" variant="ghost" />}>
        <ChevronDown data-icon="inline-start" /> Technical details
      </CollapsibleTrigger>
      <CollapsibleContent className={styles.technicalContent}>
        <dl>
          {proposal ? <div><dt>Proposal ID</dt><dd><code>{proposal.ref.id}</code></dd></div> : null}
          {proposal ? <div><dt>Source path</dt><dd><code>{proposal.sourcePath}</code></dd></div> : null}
          {proposal ? <div><dt>Proposal revision</dt><dd><code>{proposal.revision}</code></dd></div> : null}
          {draft ? <div><dt>Draft ID</dt><dd><code>{draft.id}</code></dd></div> : null}
          {draft ? <div><dt>Draft revision</dt><dd><code>{draft.revision}</code></dd></div> : null}
        </dl>
        {input.targetRevisions.length > 0 ? (
          <section>
            <h4>Exact dependency revisions</h4>
            <ul className={styles.revisionList}>
              {input.targetRevisions.map((item) => (
                <li key={item.target.id}>
                  <code>{item.target.id}</code>
                  <span>Semantic revision {item.semanticRevision}</span>
                  <code>{item.revision}</code>
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        {input.change.kind === "spec.create" && (input.change.topics?.length || input.change.relation) ? (
          <section>
            <h4>Stored relationships</h4>
            <ul className={styles.technicalList}>
              {(input.change.topics ?? []).map((id) => <li key={id}>Topic <code>{id}</code></li>)}
              {input.change.relation ? (
                <li>{input.change.relation.type} <code>{input.change.relation.target.id}</code></li>
              ) : null}
            </ul>
          </section>
        ) : null}
        {rawEvidence.length > 0 ? (
          <section>
            <h4>Raw evidence identifiers</h4>
            <ul className={styles.technicalList}>
              {rawEvidence.map((item, index) => (
                <li key={index}>
                  {item.kind === "entity" ? <code>{item.entity.id}</code>
                    : item.code.kind === "symbol" ? <code>{item.code.symbolId}</code>
                      : <code>{item.code.path}</code>}
                  {item.kind === "code" && item.code.fingerprint ? <code>{item.code.fingerprint}</code> : null}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
      </CollapsibleContent>
    </Collapsible>
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
          <div className={styles.detailBadges}>
            <Badge variant="outline">Private draft</Badge>
            <Badge variant="secondary">{changeLabel(draft.changeKind, draft.entityKind)}</Badge>
          </div>
          <CardTitle><h2>{draft.title}</h2></CardTitle>
          <CardDescription>Only available in this checkout.</CardDescription>
        </div>
        <CardAction><Badge variant="outline">Local only</Badge></CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        <div className={styles.detailActions}>
          <Button disabled={!canPublish} onClick={(event) => onAction({ kind: "inbox.publish", draft }, event)} size="sm" type="button">
            <Send data-icon="inline-start" /> Publish draft
          </Button>
          <Button disabled={!canMutate} onClick={onEdit} size="sm" type="button" variant="outline">
            <Pencil data-icon="inline-start" /> Edit local draft
          </Button>
          <Button disabled={!canMutate} onClick={(event) => onAction({ kind: "inbox.draft.delete", draft }, event)} size="sm" type="button" variant="destructive">
            <Trash2 data-icon="inline-start" /> Delete draft
          </Button>
        </div>
        <ChangeDetail input={draft.input} />
        <TechnicalDetails draft={draft} input={draft.input} />
      </CardContent>
    </>
  );
}

function ProposalDetail({
  canReview,
  canSpecMutate,
  current,
  currentError,
  currentPending,
  identity,
  identityError,
  onAction,
  proposal,
}: {
  canReview: boolean;
  canSpecMutate: boolean;
  current?: WikiEntityDetailResponse;
  currentError?: string;
  currentPending?: boolean;
  identity?: TeamCurrentActorResponse;
  identityError?: boolean;
  onAction(action: ReviewAction, event: MouseEvent<HTMLButtonElement>): void;
  proposal: InboxProposalDetail;
}) {
  const terminal = proposal.state === "approved" || proposal.state === "rejected" || proposal.state === "withdrawn";
  const identityUnknown = identityError || identity?.actor.kind === "unknown";
  return (
    <>
      <CardHeader className={styles.detailHeader}>
        <div>
          <div className={styles.detailBadges}>
            <Badge variant="outline">Spec change</Badge>
            <Badge variant="secondary">{changeLabel(proposal.changeKind, proposal.entityKind)}</Badge>
          </div>
          <CardTitle><h2>{proposal.title}</h2></CardTitle>
          <CardDescription>Published by {actorLabel(proposal.author)}</CardDescription>
        </div>
        <CardAction>
          <Badge variant={proposal.state === "stale" ? "outline" : "secondary"}>
            {proposalStateLabel(proposal.state)}
          </Badge>
        </CardAction>
      </CardHeader>
      <CardContent className={styles.detailContent}>
        {identityUnknown ? (
          <Alert className={styles.identityWarning}>
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Team identity is not set</AlertTitle>
            <AlertDescription>
              MEX cannot reliably tell which proposals are yours. You can still review this change, or <Link to="/members">set your identity in Team</Link>.
            </AlertDescription>
          </Alert>
        ) : null}
        {proposal.state === "stale" ? (
          <Alert className={styles.staleWarning}>
            <AlertTriangle aria-hidden="true" />
            <AlertTitle>Needs refresh</AlertTitle>
            <AlertDescription>The referenced Spec content changed after this proposal was published.</AlertDescription>
          </Alert>
        ) : null}
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
        <ChangeDetail
          current={current}
          currentError={currentError}
          currentPending={currentPending}
          input={{
            change: proposal.change,
            rationale: proposal.rationale,
            evidence: proposal.evidence,
            targetRevisions: proposal.targetRevisions,
          }}
        />
        <TechnicalDetails
          input={{
            change: proposal.change,
            rationale: proposal.rationale,
            evidence: proposal.evidence,
            targetRevisions: proposal.targetRevisions,
          }}
          proposal={proposal}
        />
      </CardContent>
    </>
  );
}
type InboxView = "review" | "drafts";

function inboxView(value: string | null): InboxView {
  return value === "drafts" ? "drafts" : "review";
}

function changeLabel(
  changeKind: InboxDraftSummary["changeKind"],
  entityKind: InboxSpecKind,
): string {
  return `${changeKind === "spec.create" ? "New" : "Update"} ${sentenceCase(entityKind)}`;
}

function proposalStateLabel(state: InboxProposalState): string {
  return state === "pending" ? "Needs review"
    : state === "stale" ? "Needs refresh"
      : sentenceCase(state);
}

interface ProposalGroup {
  key: "needs-review" | "waiting" | "needs-refresh";
  title: string;
  rows: InboxProposalSummary[];
}

export function groupInboxProposals(
  rows: InboxProposalSummary[],
  current: TeamActorRef | undefined,
): ProposalGroup[] {
  const identityResolved = current !== undefined && current.kind !== "unknown";
  const groups: ProposalGroup[] = identityResolved ? [
    {
      key: "needs-review",
      title: "Needs your review",
      rows: rows.filter((row) => row.state === "pending" && !inboxActorMatches(current, row.author)),
    },
    {
      key: "waiting",
      title: "Waiting for teammate",
      rows: rows.filter((row) => row.state === "pending" && inboxActorMatches(current, row.author)),
    },
    {
      key: "needs-refresh",
      title: "Needs refresh",
      rows: rows.filter((row) => row.state === "stale"),
    },
  ] : [
    {
      key: "needs-review",
      title: "Needs review",
      rows: rows.filter((row) => row.state === "pending"),
    },
    {
      key: "needs-refresh",
      title: "Needs refresh",
      rows: rows.filter((row) => row.state === "stale"),
    },
  ];
  return groups.filter((group) => group.rows.length > 0);
}

function QueueSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className={styles.queueSkeleton} aria-label="Loading Inbox queue">
      {Array.from({ length: rows }, (_, index) => (
        <div key={index}>
          <Skeleton className={styles.skeletonIcon} />
          <span>
            <Skeleton className={styles.skeletonLabel} />
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonMeta} />
          </span>
        </div>
      ))}
    </div>
  );
}

function ProposalQueue({
  error,
  groups,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  onLoadMore,
  onSelect,
  selectedId,
  sourceBounded,
}: {
  error: unknown;
  groups: ProposalGroup[];
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  onLoadMore(): void;
  onSelect(id: string): void;
  selectedId: string | null;
  sourceBounded: boolean;
}) {
  const rowCount = groups.reduce((count, group) => count + group.rows.length, 0);
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="proposal-queue-heading">
      <CardHeader className={styles.queuePaneHeader}>
        <div>
          <CardTitle><h2 id="proposal-queue-heading">Spec changes</h2></CardTitle>
          <CardDescription>Select a change to review its meaningful content.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className={styles.queuePaneContent}>
        {isPending ? (
          <QueueSkeleton />
        ) : error && rowCount === 0 ? (
          <ErrorState error={error} />
        ) : rowCount === 0 ? (
          <Empty className={styles.emptyQueue}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><CheckCircle2 aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>You’re all caught up</EmptyTitle>
              <EmptyDescription>No Spec changes currently need review.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button render={<Link to="/activity" />} size="sm" variant="outline">Open Activity</Button>
            </EmptyContent>
          </Empty>
        ) : (
          <>
            {groups.map((group) => (
              <section className={styles.queueGroup} aria-labelledby={`proposal-group-${group.key}`} key={group.key}>
                <h3 id={`proposal-group-${group.key}`}>{group.title}</h3>
                <ItemGroup className={styles.queueItems}>
                  {group.rows.map((proposal) => (
                    <Item
                      aria-current={selectedId === proposal.ref.id ? "true" : undefined}
                      className={styles.queueItem}
                      data-inbox-proposal-id={proposal.ref.id}
                      data-selected={selectedId === proposal.ref.id ? "true" : undefined}
                      key={proposal.ref.id}
                      onClick={() => onSelect(proposal.ref.id)}
                      render={<button type="button" />}
                      size="sm"
                      variant="default"
                    >
                      <ItemMedia className={styles.queueItemIcon} variant="icon">
                        <GitPullRequestArrow aria-hidden="true" />
                      </ItemMedia>
                      <ItemContent>
                        <span className={styles.changeLabel}>{changeLabel(proposal.changeKind, proposal.entityKind)}</span>
                        <ItemTitle>{proposal.title}</ItemTitle>
                        <ItemDescription>
                          Published by {actorLabel(proposal.author)}
                          <span className={styles.narrowQueueState}> · {proposalStateLabel(proposal.state)}</span>
                        </ItemDescription>
                      </ItemContent>
                      <ItemActions>
                        <Badge className={styles.queueStateBadge} variant={proposal.state === "stale" ? "outline" : "secondary"}>
                          {proposalStateLabel(proposal.state)}
                        </Badge>
                        <ChevronRight aria-hidden="true" />
                      </ItemActions>
                    </Item>
                  ))}
                </ItemGroup>
              </section>
            ))}
            {error ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
            {hasNextPage ? (
              <Button disabled={isFetchingNextPage} onClick={onLoadMore} size="sm" type="button" variant="outline">
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : sourceBounded ? (
              <p className={styles.boundNote}>The bounded review queue limit was reached.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function DraftQueue({
  canCreate,
  error,
  hasNextPage,
  isFetchingNextPage,
  isPending,
  onCreate,
  onLoadMore,
  onSelect,
  rows,
  selectedId,
  sourceBounded,
}: {
  canCreate: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  isPending: boolean;
  onCreate(event: MouseEvent<HTMLButtonElement>): void;
  onLoadMore(): void;
  onSelect(id: string): void;
  rows: InboxDraftSummary[];
  selectedId: string | null;
  sourceBounded: boolean;
}) {
  return (
    <Card className={styles.queuePane} role="region" aria-labelledby="draft-queue-heading">
      <CardHeader className={styles.queuePaneHeader}>
        <div>
          <CardTitle><h2 id="draft-queue-heading">On this device</h2></CardTitle>
          <CardDescription>Private drafts in this checkout.</CardDescription>
        </div>
        {canCreate ? (
          <CardAction>
            <Button onClick={onCreate} size="sm" type="button" variant="ghost">
              <Plus data-icon="inline-start" /> Create manually
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className={styles.queuePaneContent}>
        {isPending ? (
          <QueueSkeleton rows={3} />
        ) : error && rows.length === 0 ? (
          <ErrorState error={error} />
        ) : rows.length === 0 ? (
          <Empty className={styles.emptyQueue}>
            <EmptyHeader>
              <EmptyMedia variant="icon"><FilePenLine aria-hidden="true" /></EmptyMedia>
              <EmptyTitle>No drafts on this device</EmptyTitle>
              <EmptyDescription>Coding agents can prepare private MEX drafts for you to review here.</EmptyDescription>
            </EmptyHeader>
            {canCreate ? (
              <EmptyContent>
                <Button onClick={onCreate} size="sm" type="button" variant="ghost">
                  <Plus data-icon="inline-start" /> Create manually
                </Button>
              </EmptyContent>
            ) : null}
          </Empty>
        ) : (
          <>
            <ItemGroup className={styles.queueItems}>
              {rows.map((draft) => (
                <Item
                  aria-current={selectedId === draft.id ? "true" : undefined}
                  className={styles.queueItem}
                  data-inbox-draft-id={draft.id}
                  data-selected={selectedId === draft.id ? "true" : undefined}
                  key={draft.id}
                  onClick={() => onSelect(draft.id)}
                  render={<button type="button" />}
                  size="sm"
                  variant="default"
                >
                  <ItemMedia className={styles.queueItemIcon} variant="icon">
                    <FilePenLine aria-hidden="true" />
                  </ItemMedia>
                  <ItemContent>
                    <span className={styles.changeLabel}>{changeLabel(draft.changeKind, draft.entityKind)}</span>
                    <ItemTitle>{draft.title}</ItemTitle>
                    <ItemDescription>Private draft · {formatDate(draft.updatedAt)}</ItemDescription>
                  </ItemContent>
                  <ItemActions><ChevronRight aria-hidden="true" /></ItemActions>
                </Item>
              ))}
            </ItemGroup>
            {error ? <div className={styles.paginationError}><ErrorState error={error} /></div> : null}
            {hasNextPage ? (
              <Button disabled={isFetchingNextPage} onClick={onLoadMore} size="sm" type="button" variant="outline">
                {isFetchingNextPage ? "Loading…" : "Load more"}
              </Button>
            ) : sourceBounded ? (
              <p className={styles.boundNote}>The bounded draft list limit was reached.</p>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

export function InboxPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities, home } = useOutletContext<{
    capabilities?: CapabilitiesResponse;
    home?: HomeResponse;
  }>();
  const [searchParams, setSearchParams] = useSearchParams();
  const view = inboxView(searchParams.get("view"));
  const proposalParam = view === "review" ? searchParams.get("proposal") : null;
  const draftParam = view === "drafts" ? searchParams.get("draft") : null;
  const parsedProposal = proposalParam === null ? null : InboxProposalIdSchema.safeParse(proposalParam);
  const parsedDraft = draftParam === null ? null : InboxDraftIdSchema.safeParse(draftParam);
  const selectedProposalId = parsedProposal?.success ? parsedProposal.data : null;
  const selectedDraftId = parsedDraft?.success ? parsedDraft.data : null;
  const invalidProposalSelection = proposalParam !== null && parsedProposal?.success === false;
  const invalidDraftSelection = draftParam !== null && parsedDraft?.success === false;
  const [editor, setEditor] = useState<{ draft: InboxDraftDetail | null } | null>(null);
  const [reviewAction, setReviewAction] = useState<ReviewAction | null>(null);
  const [status, setStatus] = useState("");
  const [refreshing, setRefreshing] = useState(false);
  const [selectionNotice, setSelectionNotice] = useState("");
  const [refreshGeneration, setRefreshGeneration] = useState(0);
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement | null>(null);
  const readAvailable = capabilities?.inbox.read.availability === "available";
  const canEditDrafts = capabilities?.inbox.draftMutation.availability === "available";
  const canReviewProposals = capabilities?.inbox.proposalMutation.availability === "available";
  const canApproveSpecs = capabilities?.inbox.specApproval.availability === "available";
  const currentActor = useQuery({
    queryKey: ["actor", "current"],
    queryFn: () => api.getCurrentActor(),
    enabled: readAvailable,
    retry: false,
  });
  const exactReviewCount = home?.sections.inbox.availability === "available"
    ? home.sections.inbox.count
    : null;
  const searchKey = searchParams.toString();
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
    enabled: Boolean(readAvailable && view === "drafts"),
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
    enabled: Boolean(readAvailable && view === "review"),
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
  const proposalGroups = useMemo(
    () => groupInboxProposals(proposalRows, currentActor.data?.actor),
    [currentActor.data?.actor, proposalRows],
  );
  const orderedProposalRows = useMemo(
    () => proposalGroups.flatMap((group) => group.rows),
    [proposalGroups],
  );

  useEffect(() => {
    if (
      view !== "review"
      || proposalParam !== null
      || proposals.isPending
      || currentActor.isPending
      || orderedProposalRows.length === 0
    ) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", "review");
    next.set("proposal", orderedProposalRows[0]!.ref.id);
    next.delete("draft");
    setSearchParams(next, { replace: true });
  }, [
    currentActor.isPending,
    orderedProposalRows,
    proposalParam,
    proposals.isPending,
    searchKey,
    setSearchParams,
    view,
  ]);

  useEffect(() => {
    if (
      view !== "drafts"
      || draftParam !== null
      || drafts.isPending
      || draftRows.length === 0
    ) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", "drafts");
    next.set("draft", draftRows[0]!.id);
    next.delete("proposal");
    setSearchParams(next, { replace: true });
  }, [draftParam, draftRows, drafts.isPending, searchKey, setSearchParams, view]);

  const draftDetail = useQuery({
    queryKey: ["inbox", "draft", selectedDraftId],
    queryFn: () => api.getInboxDraft(selectedDraftId!),
    enabled: Boolean(readAvailable && view === "drafts" && selectedDraftId),
    retry: false,
  });
  const proposalDetail = useQuery({
    queryKey: ["inbox", "proposal", selectedProposalId],
    queryFn: () => api.getInboxProposal(selectedProposalId!),
    enabled: Boolean(readAvailable && view === "review" && selectedProposalId),
    retry: false,
  });
  const selectedUpdateTargetId = proposalDetail.data?.change.kind === "spec.update"
    ? proposalDetail.data.change.target.id
    : null;
  const wikiReadAvailable = capabilities?.wiki.read.availability === "available";
  const currentWikiEntity = useQuery({
    queryKey: ["wiki-entity", selectedUpdateTargetId],
    queryFn: () => api.getWikiEntity(selectedUpdateTargetId!),
    enabled: Boolean(selectedUpdateTargetId && wikiReadAvailable),
    retry: false,
  });
  const currentWikiError = selectedUpdateTargetId === null
    ? undefined
    : capabilities?.wiki.read.availability === "unavailable"
      ? capabilities.wiki.read.reason
      : currentWikiEntity.isError
        ? "Current content is temporarily unavailable."
        : undefined;

  const clearModeSelection = (replace = true) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", view);
    next.delete(view === "review" ? "proposal" : "draft");
    setSearchParams(next, { replace });
  };

  useEffect(() => {
    if (refreshGeneration === 0) return;
    const selectedError = view === "review"
      ? selectedProposalId !== null && proposalDetail.isError
      : selectedDraftId !== null && draftDetail.isError;
    const noLongerActionable = view === "review"
      && proposalDetail.data !== undefined
      && !actionableProposalStates.includes(proposalDetail.data.state);
    if (!selectedError && !noLongerActionable) return;
    const next = new URLSearchParams(searchKey);
    next.set("view", view);
    next.delete(view === "review" ? "proposal" : "draft");
    setSearchParams(next, { replace: true });
    setSelectionNotice(view === "review"
      ? "That proposal is no longer in the review queue. Choose another Spec change."
      : "That draft is no longer on this device. Choose another draft.");
  }, [
    draftDetail.isError,
    proposalDetail.data,
    proposalDetail.isError,
    refreshGeneration,
    searchKey,
    selectedDraftId,
    selectedProposalId,
    setSearchParams,
    view,
  ]);

  const selectView = (nextValue: string) => {
    const nextView = inboxView(nextValue);
    const next = new URLSearchParams(searchParams);
    next.set("view", nextView);
    next.delete(nextView === "review" ? "draft" : "proposal");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectProposal = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", "review");
    next.set("proposal", id);
    next.delete("draft");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const selectDraft = (id: string) => {
    const next = new URLSearchParams(searchParams);
    next.set("view", "drafts");
    next.set("draft", id);
    next.delete("proposal");
    setSelectionNotice("");
    setSearchParams(next);
  };
  const returnToQueue = () => {
    setSelectionNotice("");
    clearModeSelection();
  };
  const refreshInbox = async () => {
    setRefreshing(true);
    setSelectionNotice("");
    try {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["inbox"] }),
        queryClient.invalidateQueries({ queryKey: ["actor", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
      ]);
      setRefreshGeneration((generation) => generation + 1);
      setStatus("Inbox refreshed.");
    } finally {
      setRefreshing(false);
    }
  };

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
    clearModeSelection();
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

  const proposalDetailState = invalidProposalSelection ? (
    <div className={styles.recoverableState}>
      <StatePanel
        compact
        state="empty"
        title="This proposal link is invalid"
        detail="Return to the queue and choose an available Spec change."
      />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to queue</Button>
    </div>
  ) : selectedProposalId === null ? (
    <StatePanel compact state="empty" title="Choose a Spec change" detail="Select an item from the queue to start reviewing." />
  ) : proposalDetail.isPending ? (
    <StatePanel compact state="loading" title="Opening Spec change" detail="Loading its meaningful content only after selection." />
  ) : proposalDetail.isError ? (
    <div className={styles.recoverableState}>
      <ErrorState error={proposalDetail.error} retry={() => void proposalDetail.refetch()} />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to queue</Button>
    </div>
  ) : (
    <ProposalDetail
      canSpecMutate={Boolean(canApproveSpecs)}
      canReview={Boolean(canReviewProposals)}
      current={currentWikiEntity.data}
      currentError={currentWikiError}
      currentPending={Boolean(selectedUpdateTargetId && wikiReadAvailable && currentWikiEntity.isPending)}
      identity={currentActor.data}
      identityError={currentActor.isError}
      onAction={openReview}
      proposal={proposalDetail.data}
    />
  );

  const draftDetailState = invalidDraftSelection ? (
    <div className={styles.recoverableState}>
      <StatePanel
        compact
        state="empty"
        title="This draft link is invalid"
        detail="Return to the list and choose a draft on this device."
      />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to drafts</Button>
    </div>
  ) : selectedDraftId === null ? (
    <StatePanel compact state="empty" title="Choose a draft" detail="Select a private draft to review it." />
  ) : draftDetail.isPending ? (
    <StatePanel compact state="loading" title="Opening private draft" detail="Loading its content only after selection." />
  ) : draftDetail.isError ? (
    <div className={styles.recoverableState}>
      <ErrorState error={draftDetail.error} retry={() => void draftDetail.refetch()} />
      <Button onClick={returnToQueue} size="sm" type="button" variant="outline">Return to drafts</Button>
    </div>
  ) : (
    <DraftDetail
      canMutate={Boolean(canEditDrafts)}
      canPublish={Boolean(canApproveSpecs)}
      draft={draftDetail.data}
      onAction={openReview}
      onEdit={(event) => openEditor(draftDetail.data, event)}
    />
  );

  return (
    <div
      className={styles.page}
      data-inbox-actor={currentActor.data?.actor.kind ?? (currentActor.isError ? "unavailable" : "loading")}
      data-inbox-workbench={readAvailable ? "ready" : "unavailable"}
    >
      <PageHeader
        title="Inbox"
        description="Review proposed changes before they become shared project memory."
        actions={(
          <Button
            className={styles.refreshAction}
            disabled={!readAvailable || refreshing}
            onClick={() => void refreshInbox()}
            size="sm"
            type="button"
            variant="outline"
          >
            <RefreshCw className={refreshing ? styles.refreshingIcon : undefined} data-icon="inline-start" />
            {refreshing ? "Refreshing…" : "Refresh"}
          </Button>
        )}
      />
      {status === "" ? (
        <div className={styles.liveStatus} aria-live="polite" role="status" />
      ) : (
        <div className={styles.statusBanner} ref={statusRef} role="status" tabIndex={-1}>
          <CheckCircle2 aria-hidden="true" /> {status}
        </div>
      )}
      {selectionNotice ? (
        <div className={styles.selectionNotice} role="status">{selectionNotice}</div>
      ) : null}

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking Inbox capability" detail="Confirming which Inbox reads and actions are available." />
      ) : !readAvailable ? (
        <StatePanel
          state="unavailable"
          title="Inbox is unavailable"
          detail={capabilities.inbox.read.reason ?? "Inbox reads are not connected in this Hub process."}
        />
      ) : (
        <Tabs className={styles.modeTabs} onValueChange={selectView} value={view}>
          <TabsList aria-label="Inbox views" className={styles.modeTabList} variant="line">
            <TabsTrigger value="review">
              For review
              {exactReviewCount !== null ? <Badge className={styles.tabCount} variant="secondary">{exactReviewCount}</Badge> : null}
            </TabsTrigger>
            <TabsTrigger value="drafts">Drafts on this device</TabsTrigger>
          </TabsList>
          <TabsContent className={styles.modePanel} value="review">
            <div className={styles.workbench}>
              <ProposalQueue
                error={proposals.isError ? proposals.error : null}
                groups={proposalGroups}
                hasNextPage={Boolean(proposals.hasNextPage)}
                isFetchingNextPage={proposals.isFetchingNextPage}
                isPending={proposals.isPending}
                onLoadMore={() => void proposals.fetchNextPage()}
                onSelect={selectProposal}
                selectedId={selectedProposalId}
                sourceBounded={Boolean(
                  proposals.data
                  && (proposals.data.pages.length >= MAX_WORKBENCH_PAGES
                    || proposals.data.pages.some((page) => page.sourceTruncated)),
                )}
              />
              <Card className={styles.detailCard} role="region" aria-label="Selected Inbox review detail">
                {proposalDetailState}
              </Card>
            </div>
          </TabsContent>
          <TabsContent className={styles.modePanel} value="drafts">
            <div className={styles.workbench}>
              <DraftQueue
                canCreate={Boolean(canEditDrafts)}
                error={drafts.isError ? drafts.error : null}
                hasNextPage={Boolean(drafts.hasNextPage)}
                isFetchingNextPage={drafts.isFetchingNextPage}
                isPending={drafts.isPending}
                onCreate={(event) => openEditor(null, event)}
                onLoadMore={() => void drafts.fetchNextPage()}
                onSelect={selectDraft}
                rows={draftRows}
                selectedId={selectedDraftId}
                sourceBounded={Boolean(
                  drafts.data
                  && (drafts.data.pages.length >= MAX_WORKBENCH_PAGES
                    || drafts.data.pages.some((page) => page.sourceTruncated)),
                )}
              />
              <Card className={styles.detailCard} role="region" aria-label="Selected Inbox draft detail">
                {draftDetailState}
              </Card>
            </div>
          </TabsContent>
        </Tabs>
      )}

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
