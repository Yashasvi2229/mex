import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowRight,
  CheckCircle2,
  ChevronRight,
  CircleDot,
  FileDiff,
  FilePenLine,
  GitBranch,
  Handshake,
  Plus,
  Send,
  ShieldCheck,
  Trash2,
  TriangleAlert,
  UserCheck,
  X,
} from "lucide-react";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type MouseEvent,
} from "react";
import { flushSync } from "react-dom";
import { useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import { strictRelayPreviewEnvelope } from "../api/relay-client";
import type {
  CapabilitiesResponse,
  RelayDetail,
  RelayDraftDetail,
  RelayDraftInput,
  RelayDraftSummary,
  RelayEvidenceRef,
  RelayListRequest,
  RelayOperationApplyResponse,
  RelayOperationPreviewRequest,
  RelayOperationPreviewResponse,
  RelayState,
  RelaySummary,
  TeamActorRef,
  TeamMember,
  TeamWorkstream,
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
import { Badge } from "../components/primitives/badge";
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
  FieldLegend,
  FieldSet,
} from "../components/primitives/field";
import { Input } from "../components/primitives/input";
import { NativeSelect, NativeSelectOption } from "../components/primitives/native-select";
import { Separator } from "../components/primitives/separator";
import { Tabs, TabsList, TabsTrigger } from "../components/primitives/tabs";
import {
  ErrorState,
  formatDate,
  PageHeader,
  sentenceCase,
  StatePanel,
  StatusPill,
} from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/relay.module.css";

const PAGE_SIZE = 25;
const OPEN_STATES: readonly RelayState[] = ["published", "acknowledged"];

type Selection = { kind: "draft"; id: string } | { kind: "relay"; id: string };
type ReviewSnapshot =
  | { kind: "draft"; input: RelayDraftInput }
  | { kind: "relay"; relay: RelayDetail };
type ReviewSource =
  | { kind: "save"; request: RelayOperationPreviewRequest; snapshot: ReviewSnapshot }
  | { kind: "delete"; request: RelayOperationPreviewRequest; snapshot: ReviewSnapshot }
  | { kind: "publish"; request: RelayOperationPreviewRequest; snapshot: ReviewSnapshot }
  | { kind: "acknowledge"; request: RelayOperationPreviewRequest; snapshot: ReviewSnapshot }
  | { kind: "close"; request: RelayOperationPreviewRequest; snapshot: ReviewSnapshot };
type ReferenceRow = { kind: string; value: string; title: string };
type CodeRow = { kind: "file" | "symbol"; value: string; fingerprint: string };
type EvidenceRow = {
  kind: "entity" | "code" | "file" | "commit" | "external" | "manual";
  value: string;
  label: string;
  detail: string;
};
type PreviewAcceptance = "accepted" | "stale" | "mismatched";

const PREVIEW_IDENTITY_ERROR = "The signed Relay preview did not exactly match the submitted request. Prepare a fresh preview before applying.";

function canonicalRequestJson(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return `[${value.map(canonicalRequestJson).join(",")}]`;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalRequestJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function canonicalRelaySet<T>(values: readonly T[]): T[] {
  return [...values].sort((left, right) => {
    const leftKey = canonicalRequestJson(left);
    const rightKey = canonicalRequestJson(right);
    return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
  });
}

function canonicalRelayRequest(request: RelayOperationPreviewRequest): RelayOperationPreviewRequest {
  if (request.action.kind !== "relay.draft.save") return request;
  return {
    ...request,
    action: {
      ...request.action,
      draft: {
        ...request.action.draft,
        recipients: canonicalRelaySet(request.action.draft.recipients),
        decisions: canonicalRelaySet(request.action.draft.decisions),
        changedFiles: canonicalRelaySet(request.action.draft.changedFiles),
        code: canonicalRelaySet(request.action.draft.code),
      },
    },
  };
}

function previewAcceptance(
  currentAttempt: number,
  expectedAttempt: number,
  expectedRequest: RelayOperationPreviewRequest,
  envelope: RelayOperationPreviewResponse,
): PreviewAcceptance {
  if (currentAttempt !== expectedAttempt) return "stale";
  const strictEnvelope = strictRelayPreviewEnvelope(envelope);
  if (!strictEnvelope) return "mismatched";
  if (strictEnvelope.request.operationId !== expectedRequest.operationId
    || canonicalRequestJson(canonicalRelayRequest(strictEnvelope.request))
      !== canonicalRequestJson(canonicalRelayRequest(expectedRequest))) {
    return "mismatched";
  }
  return "accepted";
}

function operationId(label: string): string {
  return `hub_relay_${label}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function draftInputFromEnvelope(envelope: RelayOperationPreviewResponse): RelayDraftInput {
  if (envelope.request.action.kind !== "relay.draft.save") {
    throw new Error("The draft review envelope does not contain a draft save action.");
  }
  return envelope.request.action.draft;
}

function actorLabel(actor: TeamActorRef | null | undefined): string {
  if (actor?.kind === "member") return actor.displayName ?? actor.memberId;
  if (actor?.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function relayTone(state: RelayState): Tone {
  if (state === "published") return "info";
  if (state === "acknowledged") return "warning";
  return "success";
}

function viewRequest(view: "mine" | "sent" | "all" | "closed"): Omit<RelayListRequest, "cursor" | "limit"> {
  if (view === "closed") return { perspective: "all", states: ["closed"] };
  if (view === "sent") return { perspective: "sent" };
  return { perspective: view, states: [...OPEN_STATES] };
}

function artifactExpectation(path: string, revision: string) {
  return { target: { kind: "artifact" as const, path }, revision };
}

function draftExpectation(draft: RelayDraftDetail) {
  return {
    target: { kind: "local" as const, namespace: "relay-draft" as const, id: draft.id },
    revision: draft.revision,
  };
}

function StringRows({
  id,
  label,
  values,
  onChange,
}: {
  id: string;
  label: string;
  values: string[];
  onChange(values: string[]): void;
}) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>{label}</FieldLegend>
      <div className={styles.repeatableRows}>
        {values.map((value, index) => (
          <div className={styles.repeatableRow} key={`${id}-${index}`}>
            <Input
              aria-label={`${label} ${index + 1}`}
              id={`${id}-${index}`}
              onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? event.target.value : item))}
              value={value}
            />
            <Button
              aria-label={`Remove ${label} ${index + 1}`}
              onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))}
              size="icon-sm"
              type="button"
              variant="ghost"
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
        <Button onClick={() => onChange([...values, ""])} size="sm" type="button" variant="outline">
          <Plus data-icon="inline-start" aria-hidden="true" /> Add {label.toLowerCase()}
        </Button>
      </div>
    </FieldSet>
  );
}

function ReferenceRows({ values, onChange }: { values: ReferenceRow[]; onChange(values: ReferenceRow[]): void }) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>Decision references</FieldLegend>
      <FieldDescription>Optional canonical entity references; their current Wiki state is not consulted.</FieldDescription>
      <div className={styles.repeatableRows}>
        {values.map((row, index) => (
          <div className={styles.referenceRow} key={`decision-${index}`}>
            <Input aria-label={`Decision kind ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value } : item))} placeholder="decision" value={row.kind} />
            <Input aria-label={`Decision ID ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder="entity ID" value={row.value} />
            <Input aria-label={`Decision title ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, title: event.target.value } : item))} placeholder="Title (optional)" value={row.title} />
            <Button aria-label={`Remove decision ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        ))}
        <Button onClick={() => onChange([...values, { kind: "decision", value: "", title: "" }])} size="sm" type="button" variant="outline"><Plus data-icon="inline-start" /> Add decision</Button>
      </div>
    </FieldSet>
  );
}

function CodeRows({ values, onChange }: { values: CodeRow[]; onChange(values: CodeRow[]): void }) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>Code references</FieldLegend>
      <div className={styles.repeatableRows}>
        {values.map((row, index) => (
          <div className={styles.referenceRow} key={`code-${index}`}>
            <NativeSelect aria-label={`Code type ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, kind: event.target.value as CodeRow["kind"] } : item))} value={row.kind}>
              <NativeSelectOption value="file">File</NativeSelectOption>
              <NativeSelectOption value="symbol">Symbol</NativeSelectOption>
            </NativeSelect>
            <Input aria-label={`Code reference ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={row.kind === "file" ? "src/path.ts" : "Symbol.name"} value={row.value} />
            <Input aria-label={`Code fingerprint ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, fingerprint: event.target.value } : item))} placeholder="Fingerprint (optional)" value={row.fingerprint} />
            <Button aria-label={`Remove code reference ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        ))}
        <Button onClick={() => onChange([...values, { kind: "file", value: "", fingerprint: "" }])} size="sm" type="button" variant="outline"><Plus data-icon="inline-start" /> Add code reference</Button>
      </div>
    </FieldSet>
  );
}

function EvidenceRows({ values, onChange }: { values: EvidenceRow[]; onChange(values: EvidenceRow[]): void }) {
  return (
    <FieldSet className={styles.fieldSet}>
      <FieldLegend>Evidence</FieldLegend>
      <div className={styles.repeatableRows}>
        {values.map((row, index) => (
          <div className={styles.referenceRow} key={`evidence-${index}`}>
            <NativeSelect aria-label={`Evidence type ${index + 1}`} onChange={(event) => {
              const kind = event.target.value as EvidenceRow["kind"];
              onChange(values.map((item, itemIndex) => itemIndex === index
                ? {
                    ...item,
                    kind,
                    detail: kind === "code"
                      ? (item.detail === "symbol" ? "symbol" : "file")
                      : kind === "entity" ? item.detail : "",
                  }
                : item));
            }} value={row.kind}>
              <NativeSelectOption value="entity">Entity</NativeSelectOption>
              <NativeSelectOption value="code">Code</NativeSelectOption>
              <NativeSelectOption value="file">File</NativeSelectOption>
              <NativeSelectOption value="commit">Commit</NativeSelectOption>
              <NativeSelectOption value="external">External URL</NativeSelectOption>
              <NativeSelectOption value="manual">Manual note</NativeSelectOption>
            </NativeSelect>
            {row.kind === "code" ? (
              <NativeSelect aria-label={`Evidence code type ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, detail: event.target.value } : item))} value={row.detail || "file"}>
                <NativeSelectOption value="file">File</NativeSelectOption>
                <NativeSelectOption value="symbol">Symbol</NativeSelectOption>
              </NativeSelect>
            ) : (
              <Input aria-label={`Evidence entity kind ${index + 1}`} disabled={row.kind !== "entity"} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, detail: event.target.value } : item))} placeholder="Entity kind" value={row.detail} />
            )}
            <Input aria-label={`Evidence value ${index + 1}`} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, value: event.target.value } : item))} placeholder={row.kind === "external" ? "https://…" : row.kind === "file" || (row.kind === "code" && row.detail === "file") ? "path/to/file" : row.kind === "commit" ? "Git hash" : row.kind === "manual" ? "Evidence note" : "Reference ID"} value={row.value} />
            <Input aria-label={`Evidence label ${index + 1}`} disabled={row.kind !== "external" && row.kind !== "entity" && row.kind !== "code"} onChange={(event) => onChange(values.map((item, itemIndex) => itemIndex === index ? { ...item, label: event.target.value } : item))} placeholder={row.kind === "code" ? "Fingerprint (optional)" : "Label (optional)"} value={row.label} />
            <Button aria-label={`Remove evidence ${index + 1}`} onClick={() => onChange(values.filter((_, itemIndex) => itemIndex !== index))} size="icon-sm" type="button" variant="ghost"><X aria-hidden="true" /></Button>
          </div>
        ))}
        <Button onClick={() => onChange([...values, { kind: "file", value: "", label: "", detail: "" }])} size="sm" type="button" variant="outline"><Plus data-icon="inline-start" /> Add evidence</Button>
      </div>
    </FieldSet>
  );
}

function referenceLabel(reference: RelayDraftInput["decisions"][number]): string {
  return `${reference.kind} · ${reference.title ?? reference.id} · ${reference.id}`;
}

function codeLabel(reference: RelayDraftInput["code"][number]): string {
  const target = reference.kind === "file" ? reference.path : reference.symbolId;
  return `${reference.kind} · ${target}${reference.fingerprint ? ` · ${reference.fingerprint}` : ""}`;
}

function evidenceLabel(reference: RelayEvidenceRef): string {
  if (reference.kind === "entity") return `entity · ${referenceLabel(reference.entity)}`;
  if (reference.kind === "code") return `code · ${codeLabel(reference.code)}`;
  if (reference.kind === "file") return `file · ${reference.path}`;
  if (reference.kind === "commit") return `commit · ${reference.hash}`;
  if (reference.kind === "external") return `external · ${reference.label ?? reference.uri} · ${reference.uri}`;
  return `manual · ${reference.note}`;
}

function SnapshotList({ title, items }: { title: string; items: readonly string[] }) {
  return (
    <section>
      <h4>{title}</h4>
      {items.length ? <ul>{items.map((item, index) => <li key={`${title}-${index}`}>{item}</li>)}</ul> : <p>None recorded.</p>}
    </section>
  );
}

function HandoffSnapshot({
  snapshot,
  proposedSender,
}: {
  snapshot: ReviewSnapshot;
  proposedSender?: TeamActorRef;
}) {
  const relay = snapshot.kind === "relay" ? snapshot.relay : null;
  const input = snapshot.kind === "relay" ? snapshot.relay : snapshot.input;
  const sender = relay?.sender ?? proposedSender;
  return (
    <section className={styles.snapshot} aria-labelledby="relay-snapshot-heading">
      <div className={styles.snapshotHeader}>
        <div><p>Immutable proposal fields</p><h3 id="relay-snapshot-heading">Full handoff snapshot</h3></div>
        {relay ? <StatusPill tone={relayTone(relay.state)}>{sentenceCase(relay.state)}</StatusPill> : <StatusPill>Draft</StatusPill>}
      </div>
      <dl className={styles.authorityGrid}>
        {sender ? <div><dt>Sender</dt><dd>{actorLabel(sender)}</dd></div> : null}
        <div><dt>Recipients</dt><dd>{input.recipients.map(actorLabel).join(", ")}</dd></div>
        <div><dt>Workstream</dt><dd>{input.workstream.title ?? input.workstream.id}</dd></div>
        {relay ? <div><dt>Published</dt><dd>{relay.publishedAt ? formatDate(relay.publishedAt) : "Legacy timestamp unavailable"}</dd></div> : null}
        {relay ? <div><dt>Acknowledged</dt><dd>{relay.acknowledgedAt ? `${actorLabel(relay.acknowledgedBy)} · ${formatDate(relay.acknowledgedAt)}` : "Not acknowledged"}</dd></div> : null}
        {relay ? <div><dt>Closed</dt><dd>{relay.closedAt ? `${actorLabel(relay.closedBy)} · ${formatDate(relay.closedAt)}` : "Open"}</dd></div> : null}
      </dl>
      {relay ? <RelayWarnings diagnostics={relay.diagnostics} truncated={relay.diagnosticsTruncated} /> : null}
      <div className={styles.snapshotSummary}><span>Summary</span><strong>{input.summary}</strong></div>
      <div className={styles.snapshotGrid}>
        <SnapshotList items={input.completed} title="Completed" />
        <SnapshotList items={input.inProgress} title="In progress" />
        <SnapshotList items={input.blockers} title="Blockers" />
        <SnapshotList items={input.unresolvedQuestions} title="Unresolved questions" />
        <SnapshotList items={input.nextActions} title="Next actions" />
        <SnapshotList items={input.changedFiles} title="Changed files" />
        <SnapshotList items={input.decisions.map(referenceLabel)} title="Decisions" />
        <SnapshotList items={input.code.map(codeLabel)} title="Code" />
        <SnapshotList items={input.evidence.map(evidenceLabel)} title="Evidence" />
      </div>
    </section>
  );
}

function PreviewDocket({
  envelope,
  snapshot,
}: {
  envelope: RelayOperationPreviewResponse;
  snapshot: ReviewSnapshot;
}) {
  return (
    <section className={styles.previewDocket} aria-labelledby="relay-preview-heading">
      <div className={styles.previewHeading}>
        <div><p>Signed review envelope</p><h3 id="relay-preview-heading">Exact handoff docket</h3></div>
        <StatusPill tone={envelope.preview.valid ? "success" : "danger"}>{envelope.preview.valid ? "Ready" : "Invalid"}</StatusPill>
      </div>
      <dl className={styles.authorityGrid}>
        <div><dt>Operation</dt><dd>{envelope.request.action.kind}</dd></div>
        <div><dt>Actor</dt><dd>{actorLabel(envelope.receipt.authority.actor)}</dd></div>
        <div><dt>Captured</dt><dd>{formatDate(envelope.receipt.authority.occurredAt)}</dd></div>
        <div><dt>Branch</dt><dd>{envelope.receipt.authority.repoState.branch ?? "Detached HEAD"}</dd></div>
        <div><dt>HEAD</dt><dd><code>{envelope.receipt.authority.repoState.head ?? "Unborn HEAD"}</code></dd></div>
        <div><dt>Worktree</dt><dd>{envelope.receipt.authority.repoState.dirty ? "Dirty" : "Clean"}</dd></div>
        <div><dt>Scope</dt><dd>{sentenceCase(envelope.preview.scope)}</dd></div>
      </dl>
      <div className={styles.digest}><span>Preview digest</span><code>{envelope.receipt.previewRevision}</code></div>
      <div className={styles.purposeList} aria-label="Generated IDs">
        {envelope.receipt.purposeIds.map((purpose) => <Badge key={`${purpose.purpose}:${purpose.id}`} variant="outline">{purpose.purpose} · {purpose.id}</Badge>)}
      </div>
      <HandoffSnapshot
        proposedSender={envelope.request.action.kind === "relay.publish" ? envelope.receipt.authority.actor : undefined}
        snapshot={snapshot}
      />
      {envelope.preview.changes.map((change) => (
        <article className={styles.diff} key={`${change.kind}:${change.path}`}>
          <header><FileDiff aria-hidden="true" /><strong>{change.path}</strong><StatusPill>{change.kind}</StatusPill></header>
          <pre aria-label={`Exact diff for ${change.path}`}><code>{change.diff}</code></pre>
        </article>
      ))}
      {envelope.preview.localChanges.map((change) => (
        <p className={styles.localChange} key={change.id}><FilePenLine aria-hidden="true" /><span><strong>Checkout-local</strong>{change.summary}</span></p>
      ))}
      <p className={styles.boundNote}><ShieldCheck aria-hidden="true" /> Apply accepts only this complete envelope; no field is reconstructed in the browser.</p>
    </section>
  );
}

function ReviewDialog({
  source,
  finalFocus,
  onClose,
  onApplied,
}: {
  source: ReviewSource;
  finalFocus(): HTMLElement | null;
  onClose(): void;
  onApplied(result: RelayOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const [envelope, setEnvelope] = useState<RelayOperationPreviewResponse | null>(null);
  const [identityError, setIdentityError] = useState<Error | null>(null);
  const generation = useRef(0);
  const preview = useMutation({ mutationFn: (request: RelayOperationPreviewRequest) => api.previewRelayOperation(request) });
  const apply = useMutation({ mutationFn: (request: RelayOperationPreviewResponse) => api.applyRelayOperation(request) });

  const requestPreview = () => {
    const current = ++generation.current;
    setEnvelope(null);
    setIdentityError(null);
    preview.mutate(source.request, {
      onSuccess: (result) => {
        const acceptance = previewAcceptance(generation.current, current, source.request, result);
        if (acceptance === "accepted") setEnvelope(result);
        if (acceptance === "mismatched") setIdentityError(new Error(PREVIEW_IDENTITY_ERROR));
      },
    });
  };

  useEffect(() => {
    requestPreview();
    return () => { generation.current += 1; };
  // The source is immutable for one mounted review dialog.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const close = () => {
    onClose();
    queueMicrotask(() => finalFocus()?.focus({ preventScroll: true }));
  };
  const applyEnvelope = () => {
    if (!envelope) return;
    apply.mutate(envelope, {
      onSuccess: (result) => void onApplied(result).then(close),
    });
  };

  return (
    <AlertDialog open onOpenChange={(open) => { if (!open && !apply.isPending) close(); }}>
      <AlertDialogContent className={styles.reviewDialog}>
        <AlertDialogHeader>
          <AlertDialogMedia><Handshake aria-hidden="true" /></AlertDialogMedia>
          <AlertDialogTitle>Review the exact Relay operation</AlertDialogTitle>
          <AlertDialogDescription>Authority and repository state are service-owned. Applying sends these signed bytes back unchanged.</AlertDialogDescription>
        </AlertDialogHeader>
        {preview.isPending ? <StatePanel compact state="loading" title="Preparing signed preview" detail="Rechecking the bounded Relay intent." /> : null}
        {preview.isError ? <ErrorState error={preview.error} retry={requestPreview} /> : null}
        {identityError ? (
          <StatePanel
            action={<Button onClick={requestPreview} size="sm" type="button" variant="outline">Try again</Button>}
            compact
            detail={PREVIEW_IDENTITY_ERROR}
            state="error"
            title="The signed Relay preview did not match"
          />
        ) : null}
        {envelope ? <PreviewDocket envelope={envelope} snapshot={source.snapshot} /> : null}
        {apply.isError ? <ErrorState error={apply.error} /> : null}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={apply.isPending}>Keep reviewing</AlertDialogCancel>
          <AlertDialogAction disabled={!envelope?.preview.valid || apply.isPending} onClick={applyEnvelope}>
            {apply.isPending ? "Applying…" : "Apply exact preview"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function evidenceToRows(evidence: readonly RelayEvidenceRef[]): EvidenceRow[] {
  const rows: EvidenceRow[] = [];
  for (const item of evidence) {
    if (item.kind === "entity") rows.push({ kind: "entity", value: item.entity.id, label: item.entity.title ?? "", detail: item.entity.kind });
    if (item.kind === "code") rows.push({ kind: "code", value: item.code.kind === "file" ? item.code.path : item.code.symbolId, label: item.code.fingerprint ?? "", detail: item.code.kind });
    if (item.kind === "file") rows.push({ kind: "file", value: item.path, label: "", detail: "" });
    if (item.kind === "commit") rows.push({ kind: "commit", value: item.hash, label: "", detail: "" });
    if (item.kind === "external") rows.push({ kind: "external", value: item.uri, label: item.label ?? "", detail: "" });
    if (item.kind === "manual") rows.push({ kind: "manual", value: item.note, label: "", detail: "" });
  }
  return rows;
}

function DraftComposer({
  draft,
  members,
  workstreams,
  finalFocus,
  onClose,
  onApplied,
}: {
  draft: RelayDraftDetail | null;
  members: readonly TeamMember[];
  workstreams: readonly TeamWorkstream[];
  finalFocus(): HTMLElement | null;
  onClose(): void;
  onApplied(result: RelayOperationApplyResponse): Promise<void>;
}) {
  const api = useHubApi();
  const draftWorkstreamKnown = draft !== null
    && workstreams.some((item) => item.id === draft.input.workstream.id);
  const [recipients, setRecipients] = useState<string[]>(draft?.input.recipients.map((item) => item.memberId) ?? []);
  const [manualWorkstream, setManualWorkstream] = useState(
    workstreams.length === 0 || (draft !== null && !draftWorkstreamKnown),
  );
  const [workstreamId, setWorkstreamId] = useState(
    draft?.input.workstream.id ?? workstreams[0]?.id ?? "",
  );
  const [workstreamTitle, setWorkstreamTitle] = useState(draft?.input.workstream.title ?? "");
  const [summary, setSummary] = useState(draft?.input.summary ?? "");
  const [completed, setCompleted] = useState<string[]>(draft?.input.completed ? [...draft.input.completed] : []);
  const [inProgress, setInProgress] = useState<string[]>(draft?.input.inProgress ? [...draft.input.inProgress] : []);
  const [blockers, setBlockers] = useState<string[]>(draft?.input.blockers ? [...draft.input.blockers] : []);
  const [questions, setQuestions] = useState<string[]>(draft?.input.unresolvedQuestions ? [...draft.input.unresolvedQuestions] : []);
  const [files, setFiles] = useState<string[]>(draft?.input.changedFiles ? [...draft.input.changedFiles] : []);
  const [nextActions, setNextActions] = useState<string[]>(draft?.input.nextActions ? [...draft.input.nextActions] : []);
  const [decisions, setDecisions] = useState<ReferenceRow[]>(draft?.input.decisions.map((item) => ({ kind: item.kind, value: item.id, title: item.title ?? "" })) ?? []);
  const [code, setCode] = useState<CodeRow[]>(draft?.input.code.map((item) => ({ kind: item.kind, value: item.kind === "file" ? item.path : item.symbolId, fingerprint: item.fingerprint ?? "" })) ?? []);
  const [evidence, setEvidence] = useState<EvidenceRow[]>(draft ? evidenceToRows(draft.input.evidence) : []);
  const recipientChoices = useMemo(() => {
    const choices = new Map<string, { memberId: string; displayName?: string }>();
    for (const member of members) choices.set(member.id, { memberId: member.id, displayName: member.displayName });
    for (const recipient of draft?.input.recipients ?? []) {
      if (!choices.has(recipient.memberId)) choices.set(recipient.memberId, recipient);
    }
    return [...choices.values()];
  }, [draft?.input.recipients, members]);
  const [envelope, setEnvelope] = useState<RelayOperationPreviewResponse | null>(null);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const generation = useRef(0);
  const preview = useMutation({ mutationFn: ({ request }: { request: RelayOperationPreviewRequest; generation: number }) => api.previewRelayOperation(request) });
  const apply = useMutation({ mutationFn: (request: RelayOperationPreviewResponse) => api.applyRelayOperation(request) });

  const invalidate = () => {
    generation.current += 1;
    setEnvelope(null);
    setConfirmOpen(false);
  };
  const change = <T,>(setter: (value: T) => void) => (value: T) => { invalidate(); setter(value); };
  const selectRecipients = (event: ChangeEvent<HTMLSelectElement>) => {
    invalidate();
    setRecipients([...event.target.selectedOptions].map((option) => option.value).slice(0, 32));
  };
  const buildInput = (): RelayDraftInput | null => {
    const recipientRefs = recipients.map((id) => recipientChoices.find((recipient) => recipient.memberId === id)).filter((recipient): recipient is { memberId: string; displayName?: string } => recipient !== undefined).map((recipient) => ({ kind: "member" as const, ...recipient }));
    const workstream = workstreams.find((item) => item.id === workstreamId);
    const clean = (values: string[]) => values.map((value) => value.trim()).filter(Boolean);
    const manualWorkstreamValid = /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(workstreamId);
    const invalidEvidence = evidence.some((row) => row.value.trim() && (
      (row.kind === "entity" && !row.detail.trim())
      || (row.kind === "code" && row.detail !== "file" && row.detail !== "symbol")
    ));
    if (
      !summary.trim()
      || recipientRefs.length !== recipients.length
      || recipientRefs.length === 0
      || (manualWorkstream ? !manualWorkstreamValid : !workstream)
      || invalidEvidence
    ) {
      setError("Choose active recipient Members, a valid structural Workstream reference, a summary, and complete evidence fields.");
      return null;
    }
    setError(null);
    return {
      recipients: recipientRefs,
      workstream: manualWorkstream
        ? { kind: "workstream", id: workstreamId, ...(workstreamTitle.trim() ? { title: workstreamTitle.trim() } : {}) }
        : { kind: "workstream", id: workstream!.id, title: workstream!.title },
      summary: summary.trim(),
      completed: clean(completed),
      inProgress: clean(inProgress),
      decisions: decisions.filter((row) => row.kind.trim() && row.value.trim()).map((row) => ({ id: row.value.trim(), kind: row.kind.trim(), ...(row.title.trim() ? { title: row.title.trim() } : {}) })),
      blockers: clean(blockers),
      unresolvedQuestions: clean(questions),
      changedFiles: clean(files),
      code: code.filter((row) => row.value.trim()).map((row) => row.kind === "file" ? { kind: "file" as const, path: row.value.trim(), ...(row.fingerprint.trim() ? { fingerprint: row.fingerprint.trim() } : {}) } : { kind: "symbol" as const, symbolId: row.value.trim(), ...(row.fingerprint.trim() ? { fingerprint: row.fingerprint.trim() } : {}) }),
      evidence: evidence.filter((row) => row.value.trim()).map((row) => {
        if (row.kind === "entity") {
          return { kind: "entity" as const, entity: { id: row.value.trim(), kind: row.detail.trim(), ...(row.label.trim() ? { title: row.label.trim() } : {}) } };
        }
        if (row.kind === "code") {
          return row.detail === "symbol"
            ? { kind: "code" as const, code: { kind: "symbol" as const, symbolId: row.value.trim(), ...(row.label.trim() ? { fingerprint: row.label.trim() } : {}) } }
            : { kind: "code" as const, code: { kind: "file" as const, path: row.value.trim(), ...(row.label.trim() ? { fingerprint: row.label.trim() } : {}) } };
        }
        if (row.kind === "file") return { kind: "file" as const, path: row.value.trim() };
        if (row.kind === "commit") return { kind: "commit" as const, hash: row.value.trim() };
        if (row.kind === "external") return { kind: "external" as const, uri: row.value.trim(), ...(row.label.trim() ? { label: row.label.trim() } : {}) };
        return { kind: "manual" as const, note: row.value.trim() };
      }),
      nextActions: clean(nextActions),
    };
  };
  const review = () => {
    const input = buildInput();
    if (!input) return;
    const current = ++generation.current;
    const request: RelayOperationPreviewRequest = {
      operationId: operationId("draft_save"),
      action: { kind: "relay.draft.save", ...(draft ? { draftId: draft.id } : {}), draft: input },
      expectedRevisions: draft ? [draftExpectation(draft)] : [],
    };
    preview.mutate({ request, generation: current }, {
      onSuccess: (result) => {
        const acceptance = previewAcceptance(generation.current, current, request, result);
        if (acceptance === "accepted") { setEnvelope(result); setConfirmOpen(true); }
        if (acceptance === "mismatched") setError(PREVIEW_IDENTITY_ERROR);
      },
    });
  };
  const close = () => {
    onClose();
    queueMicrotask(() => finalFocus()?.focus({ preventScroll: true }));
  };
  const applyEnvelope = () => {
    if (!envelope) return;
    apply.mutate(envelope, { onSuccess: (result) => void onApplied(result).then(close) });
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !apply.isPending) close(); }}>
      <DialogContent className={styles.composerDialog}>
        <DialogHeader>
          <DialogTitle>{draft ? "Edit local Relay draft" : "Compose a local Relay draft"}</DialogTitle>
          <DialogDescription>Structure the baton locally. Member and Workstream eligibility is enforced again only when publishing.</DialogDescription>
        </DialogHeader>
        <div className={styles.composerScroll}>
          <FieldGroup className={styles.fieldGroup}>
            <Field data-invalid={recipients.length === 0 || undefined}>
              <FieldLabel htmlFor="relay-recipients">Recipients</FieldLabel>
              <NativeSelect id="relay-recipients" multiple onChange={selectRecipients} size="default" value={recipients}>
                {recipientChoices.map((recipient) => <NativeSelectOption key={recipient.memberId} value={recipient.memberId}>{recipient.displayName ?? recipient.memberId}</NativeSelectOption>)}
              </NativeSelect>
              <FieldDescription>Select 1–32 Member references. Publication verifies that every recipient is currently active.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="relay-workstream">Workstream</FieldLabel>
              <NativeSelect id="relay-workstream" onChange={(event) => {
                invalidate();
                const value = event.target.value;
                setManualWorkstream(value === "__manual__");
                if (value !== "__manual__") {
                  setWorkstreamId(value);
                  setWorkstreamTitle(workstreams.find((item) => item.id === value)?.title ?? "");
                } else if (workstreamId === workstreams[0]?.id) {
                  setWorkstreamId("");
                  setWorkstreamTitle("");
                }
              }} value={manualWorkstream ? "__manual__" : workstreamId}>
                {workstreams.map((workstream) => <NativeSelectOption key={workstream.id} value={workstream.id}>{workstream.title} · {sentenceCase(workstream.state)}</NativeSelectOption>)}
                <NativeSelectOption value="__manual__">Enter a structural Workstream reference</NativeSelectOption>
              </NativeSelect>
              <FieldDescription>Drafts may retain an offline structural reference; publication verifies current eligibility.</FieldDescription>
            </Field>
            {manualWorkstream ? (
              <div className={styles.referenceRow}>
                <Input aria-label="Workstream ID" onChange={(event) => change(setWorkstreamId)(event.target.value)} placeholder="ws_…" value={workstreamId} />
                <Input aria-label="Workstream title" onChange={(event) => change(setWorkstreamTitle)(event.target.value)} placeholder="Title (optional)" value={workstreamTitle} />
              </div>
            ) : null}
            <Field data-invalid={!summary.trim() || undefined}>
              <FieldLabel htmlFor="relay-summary">Summary</FieldLabel>
              <Input aria-invalid={!summary.trim()} id="relay-summary" maxLength={8192} onChange={(event) => change(setSummary)(event.target.value)} placeholder="What should the next person understand first?" value={summary} />
            </Field>
          </FieldGroup>
          <Separator />
          <div className={styles.structuredGrid}>
            <StringRows id="relay-completed" label="Completed" onChange={change(setCompleted)} values={completed} />
            <StringRows id="relay-progress" label="In progress" onChange={change(setInProgress)} values={inProgress} />
            <StringRows id="relay-blockers" label="Blockers" onChange={change(setBlockers)} values={blockers} />
            <StringRows id="relay-questions" label="Unresolved questions" onChange={change(setQuestions)} values={questions} />
            <StringRows id="relay-files" label="Changed files" onChange={change(setFiles)} values={files} />
            <StringRows id="relay-actions" label="Next actions" onChange={change(setNextActions)} values={nextActions} />
          </div>
          <ReferenceRows onChange={change(setDecisions)} values={decisions} />
          <CodeRows onChange={change(setCode)} values={code} />
          <EvidenceRows onChange={change(setEvidence)} values={evidence} />
          {error ? <FieldError>{error}</FieldError> : null}
          {preview.isError ? <ErrorState error={preview.error} /> : null}
        </div>
        <DialogFooter>
          <Button disabled={preview.isPending || apply.isPending} onClick={close} type="button" variant="outline">Cancel</Button>
          <Button disabled={preview.isPending || recipientChoices.length === 0} onClick={review} type="button">
            {preview.isPending ? "Preparing…" : "Review local change"}<ArrowRight data-icon="inline-end" />
          </Button>
        </DialogFooter>
        {confirmOpen && envelope ? (
          <AlertDialog open onOpenChange={(open) => setConfirmOpen(open)}>
            <AlertDialogContent className={styles.reviewDialog}>
              <AlertDialogHeader>
                <AlertDialogMedia><FilePenLine aria-hidden="true" /></AlertDialogMedia>
                <AlertDialogTitle>Apply this exact local draft preview?</AlertDialogTitle>
                <AlertDialogDescription>Any composer edit invalidates this envelope and requires a fresh preview.</AlertDialogDescription>
              </AlertDialogHeader>
              <PreviewDocket
                envelope={envelope}
                snapshot={{
                  kind: "draft",
                  input: draftInputFromEnvelope(envelope),
                }}
              />
              {apply.isError ? <ErrorState error={apply.error} /> : null}
              <AlertDialogFooter>
                <AlertDialogCancel disabled={apply.isPending}>Keep editing</AlertDialogCancel>
                <AlertDialogAction disabled={apply.isPending || !envelope.preview.valid} onClick={applyEnvelope}>{apply.isPending ? "Applying…" : "Save exact draft"}</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function DetailSections({ relay }: { relay: RelayDetail }) {
  const groups: Array<[string, readonly string[]]> = [
    ["Completed", relay.completed],
    ["In progress", relay.inProgress],
    ["Blockers", relay.blockers],
    ["Unresolved questions", relay.unresolvedQuestions],
    ["Next actions", relay.nextActions],
  ];
  return (
    <div className={styles.detailSections}>
      <RelayWarnings diagnostics={relay.diagnostics} truncated={relay.diagnosticsTruncated} />
      {groups.map(([label, items]) => (
        <section key={label}><h3>{label}</h3>{items.length ? <ul>{items.map((item, index) => <li key={`${label}-${index}`}>{item}</li>)}</ul> : <p>None recorded.</p>}</section>
      ))}
      <section><h3>Changed files</h3>{relay.changedFiles.length ? <ul>{relay.changedFiles.map((path) => <li key={path}><code>{path}</code></li>)}</ul> : <p>None recorded.</p>}</section>
      <section><h3>Decisions</h3>{relay.decisions.length ? <ul>{relay.decisions.map((item, index) => <li key={`decision-${index}`}>{referenceLabel(item)}</li>)}</ul> : <p>None recorded.</p>}</section>
      <section><h3>Code</h3>{relay.code.length ? <ul>{relay.code.map((item, index) => <li key={`code-${index}`}>{codeLabel(item)}</li>)}</ul> : <p>None recorded.</p>}</section>
      <section><h3>Evidence</h3>{relay.evidence.length ? <ul>{relay.evidence.map((item, index) => <li key={`evidence-${index}`}>{evidenceLabel(item)}</li>)}</ul> : <p>None recorded.</p>}</section>
    </div>
  );
}

function RelayWarnings({
  diagnostics,
  truncated = false,
  sourceTruncated = false,
}: {
  diagnostics: readonly { code: string; message: string }[];
  truncated?: boolean;
  sourceTruncated?: boolean;
}) {
  const uniqueDiagnostics = [...new Map(
    diagnostics.map((diagnostic) => [`${diagnostic.code}\0${diagnostic.message}`, diagnostic]),
  ).values()];
  if (uniqueDiagnostics.length === 0 && !truncated && !sourceTruncated) return null;
  return (
    <aside className={styles.warning} role="status">
      <TriangleAlert aria-hidden="true" />
      <div>
        <strong>Relay compatibility warning</strong>
        {uniqueDiagnostics.map((diagnostic) => (
          <p key={`${diagnostic.code}:${diagnostic.message}`}>{diagnostic.message}</p>
        ))}
        {truncated ? <p>Additional bounded Relay diagnostics were omitted.</p> : null}
        {sourceTruncated ? <p>Relay results were bounded because the canonical source exceeded its safe read limit.</p> : null}
      </div>
    </aside>
  );
}

export function RelayPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [view, setView] = useState<"mine" | "sent" | "all" | "closed">("mine");
  const [selection, setSelection] = useState<Selection | null>(null);
  const [composer, setComposer] = useState<RelayDraftDetail | null | undefined>(undefined);
  const [review, setReview] = useState<ReviewSource | null>(null);
  const [status, setStatus] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const statusRef = useRef<HTMLDivElement>(null);
  const readAvailable = capabilities?.relays.read.availability === "available";
  const canDraft = capabilities?.relays.draftMutation.availability === "available";
  const lifecycleAvailable = capabilities?.relays.lifecycleMutation.availability === "available";

  const actor = useQuery({ queryKey: ["actor", "current"], queryFn: () => api.getCurrentActor(), enabled: readAvailable, retry: false });
  const members = useInfiniteQuery({
    queryKey: ["members", "relay", "active"],
    queryFn: ({ pageParam }) => api.getMembers({ active: true, limit: 100, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const workstreams = useQuery({ queryKey: ["workstreams", "relay", "eligible"], queryFn: () => api.getWorkstreams({ includeArchived: false, limit: 100 }), enabled: readAvailable, retry: false });
  const memberPageCount = members.data?.pages.length ?? 0;
  useEffect(() => {
    if (members.hasNextPage && !members.isFetchingNextPage && memberPageCount < MAX_WORKBENCH_PAGES) {
      void members.fetchNextPage();
    }
  }, [memberPageCount, members.fetchNextPage, members.hasNextPage, members.isFetchingNextPage]);
  const activeMembers = useMemo(() => {
    const items = new Map<string, TeamMember>();
    for (const page of members.data?.pages ?? []) for (const member of page.items) items.set(member.id, member);
    return [...items.values()];
  }, [members.data?.pages]);
  const eligibleWorkstreams = (workstreams.data?.items ?? []).filter((item) => item.state === "planned" || item.state === "active" || item.state === "blocked");
  const currentMemberId = actor.data?.actor.kind === "member" ? actor.data.actor.memberId : null;
  const currentMember = useQuery({
    queryKey: ["member", "relay-authority", currentMemberId],
    queryFn: () => api.getMember(currentMemberId!),
    enabled: Boolean(readAvailable && currentMemberId),
    retry: false,
  });
  const currentMemberActive = currentMember.data?.active === true;

  const drafts = useInfiniteQuery({
    queryKey: ["relays", "drafts"],
    queryFn: ({ pageParam }) => api.getRelayDrafts({ limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const request = viewRequest(view);
  const relays = useInfiniteQuery({
    queryKey: ["relays", "canonical", request.perspective, request.states, currentMemberId],
    queryFn: ({ pageParam }) => api.getRelays({ ...request, limit: PAGE_SIZE, ...(pageParam ? { cursor: pageParam } : {}) }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: Boolean(readAvailable && ((view !== "mine" && view !== "sent") || currentMemberActive)),
    retry: false,
  });
  const draftRows = useMemo(() => {
    const rows = new Map<string, RelayDraftSummary>();
    for (const page of drafts.data?.pages ?? []) for (const item of page.items) rows.set(item.id, item);
    return [...rows.values()];
  }, [drafts.data?.pages]);
  const relayRows = useMemo(() => {
    const rows = new Map<string, RelaySummary>();
    for (const page of relays.data?.pages ?? []) for (const item of page.items) rows.set(item.ref.id, item);
    return [...rows.values()];
  }, [relays.data?.pages]);
  const activeSelection = selection ?? (relayRows[0] ? { kind: "relay" as const, id: relayRows[0].ref.id } : draftRows[0] ? { kind: "draft" as const, id: draftRows[0].id } : null);
  const draftId = activeSelection?.kind === "draft" ? activeSelection.id : null;
  const relayId = activeSelection?.kind === "relay" ? activeSelection.id : null;
  const draftDetail = useQuery({ queryKey: ["relays", "draft", draftId], queryFn: () => api.getRelayDraft(draftId!), enabled: Boolean(readAvailable && draftId), retry: false });
  const relayDetail = useQuery({ queryKey: ["relays", "relay", relayId], queryFn: () => api.getRelay(relayId!), enabled: Boolean(readAvailable && relayId), retry: false });
  const selectedDraft = draftDetail.data;
  const publishDependencies = useQuery({
    queryKey: ["relays", "publish-dependencies", selectedDraft?.id, selectedDraft?.revision],
    queryFn: async () => {
      const draft = selectedDraft!;
      const [workstream, ...recipients] = await Promise.all([
        api.getWorkstream(draft.input.workstream.id),
        ...draft.input.recipients.map((recipient) => api.getMember(recipient.memberId)),
      ]);
      return { workstream, recipients };
    },
    enabled: Boolean(readAvailable && selectedDraft),
    retry: false,
  });
  const selectedRelay = relayDetail.data;
  const senderMemberId = selectedRelay?.sender.kind === "member" ? selectedRelay.sender.memberId : null;
  const ownerMemberId = selectedRelay?.acknowledgedBy?.kind === "member" ? selectedRelay.acknowledgedBy.memberId : null;
  const lifecycleDependencies = useQuery({
    queryKey: ["relays", "lifecycle-principals", selectedRelay?.ref.id, selectedRelay?.revision, senderMemberId, ownerMemberId],
    queryFn: async () => {
      const ids = [...new Set([senderMemberId, ownerMemberId].filter((id): id is string => id !== null))];
      return Promise.all(ids.map((id) => api.getMember(id)));
    },
    enabled: Boolean(readAvailable && selectedRelay && senderMemberId && (selectedRelay.state === "published" || ownerMemberId)),
    retry: false,
  });

  const remember = (event: MouseEvent<HTMLButtonElement>) => { trigger.current = event.currentTarget; };
  const openComposer = (draft: RelayDraftDetail | null, event: MouseEvent<HTMLButtonElement>) => { remember(event); setComposer(draft); };
  const startReview = (source: ReviewSource, event: MouseEvent<HTMLButtonElement>) => { remember(event); setReview(source); };
  const onApplied = async (result: RelayOperationApplyResponse) => {
    setSelection(null);
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["relays"] }),
      queryClient.invalidateQueries({ queryKey: ["home"] }),
      queryClient.invalidateQueries({ queryKey: ["activity"] }),
    ]);
    flushSync(() => setStatus(result.changes.length && result.localChanges.length ? "Relay published and its local draft was removed." : result.changes.length ? "Canonical Relay lifecycle updated." : "Local Relay draft updated."));
    queueMicrotask(() => statusRef.current?.focus({ preventScroll: true }));
  };
  const publish = (draft: RelayDraftDetail, event: MouseEvent<HTMLButtonElement>) => {
    const dependencies = publishDependencies.data;
    if (dependencies === undefined) {
      flushSync(() => setStatus("Relay dependencies are still being verified. Review publication after verification completes."));
      queueMicrotask(() => statusRef.current?.focus({ preventScroll: true }));
      return;
    }
    startReview({
      kind: "publish",
      snapshot: { kind: "draft", input: draft.input },
      request: {
        operationId: operationId("publish"),
        action: { kind: "relay.publish", draftId: draft.id },
        expectedRevisions: [
          draftExpectation(draft),
          artifactExpectation(dependencies.workstream.sourcePath, dependencies.workstream.revision),
          ...dependencies.recipients.map((member) => artifactExpectation(member.sourcePath, member.revision)),
        ],
      },
    }, event);
  };
  const draftAction = (draft: RelayDraftDetail, kind: "delete" | "publish", event: MouseEvent<HTMLButtonElement>) => {
    if (kind === "publish") { publish(draft, event); return; }
    startReview({ kind, snapshot: { kind: "draft", input: draft.input }, request: { operationId: operationId("draft_delete"), action: { kind: "relay.draft.delete", draftId: draft.id }, expectedRevisions: [draftExpectation(draft)] } }, event);
  };
  const relayAction = (relay: RelayDetail, kind: "acknowledge" | "close", event: MouseEvent<HTMLButtonElement>) => {
    startReview({ kind, snapshot: { kind: "relay", relay }, request: { operationId: operationId(kind), action: { kind: kind === "acknowledge" ? "relay.acknowledge" : "relay.close", relayId: relay.ref.id }, expectedRevisions: [artifactExpectation(relay.sourcePath, relay.revision)] } }, event);
  };

  const senderActive = senderMemberId !== null && lifecycleDependencies.data?.some((member) => member.id === senderMemberId && member.active) === true;
  const ownerActive = ownerMemberId !== null && lifecycleDependencies.data?.some((member) => member.id === ownerMemberId && member.active) === true;
  const canAcknowledge = Boolean(lifecycleAvailable && selectedRelay?.state === "published" && currentMemberActive && selectedRelay.recipients.some((recipient) => recipient.kind === "member" && recipient.memberId === currentMemberId));
  const canClose = Boolean(lifecycleAvailable && selectedRelay?.state === "acknowledged" && currentMemberActive && senderActive && ownerActive && ((selectedRelay.sender.kind === "member" && selectedRelay.sender.memberId === currentMemberId) || (selectedRelay.acknowledgedBy?.kind === "member" && selectedRelay.acknowledgedBy.memberId === currentMemberId)));

  const publishAvailable = capabilities?.relays.publish.availability === "available";
  const selectedDraftWorkstreamEligible = publishDependencies.data !== undefined
    && (publishDependencies.data.workstream.state === "planned"
      || publishDependencies.data.workstream.state === "active"
      || publishDependencies.data.workstream.state === "blocked");
  const selectedDraftRecipientsEligible = publishDependencies.data !== undefined
    && publishDependencies.data.recipients.length === selectedDraft?.input.recipients.length
    && publishDependencies.data.recipients.every((member) => member.active);
  const draftPublishReady = Boolean(
    currentMemberActive
    && publishAvailable
    && selectedDraftWorkstreamEligible
    && selectedDraftRecipientsEligible,
  );
  const draftPublishRecovery = !currentMemberActive
    ? "Select an active current Member before publishing."
    : publishDependencies.isPending
      ? "Verifying the exact Workstream and recipient Member revisions."
      : publishDependencies.isError
        ? "A recorded Workstream or recipient Member could not be resolved. Edit the draft before publishing."
        : !selectedDraftRecipientsEligible
          ? "Reactivate or replace every recorded recipient before publishing."
          : !selectedDraftWorkstreamEligible
            ? "Choose a Workstream in Planned, Active, or Blocked before publishing."
            : !publishAvailable
              ? "Relay publication is unavailable in this Hub process."
              : null;

  return (
    <div className={styles.page} data-relay-workbench={readAvailable ? "ready" : "unavailable"}>
      <PageHeader eyebrow="Team handoffs" title="Relays" description="Pass a precise repository baton, let one recipient claim it, and close it with immutable evidence." actions={canDraft ? <Button disabled={activeMembers.length === 0} onClick={(event) => openComposer(null, event)}><Plus data-icon="inline-start" /> New local draft</Button> : undefined} />
      <div className={styles.liveStatus} aria-live="polite" ref={statusRef} role="status" tabIndex={-1}>{status}</div>
      {capabilities === undefined ? <StatePanel state="loading" title="Checking Relay capability" detail="Confirming the private handoff service connection." /> : !readAvailable ? <StatePanel state="unavailable" title="Relays are unavailable" detail={capabilities.relays.read.reason ?? "Relay reads are not connected in this Hub process."} /> : (
        <div className={styles.workbench}>
          <aside aria-label="Relay draft navigation" className={styles.rail}>
            <Card className={styles.queueCard} role="region" aria-labelledby="relay-drafts-heading">
              <CardHeader className={styles.cardHeader}><div><CardDescription>Checkout-local</CardDescription><CardTitle><h2 id="relay-drafts-heading">Draft rail</h2></CardTitle></div><CardAction><Badge variant="outline">{draftRows.length}</Badge></CardAction></CardHeader>
              <CardContent className={styles.queueContent}>
                <RelayWarnings
                  diagnostics={(drafts.data?.pages ?? []).flatMap((page) => page.diagnostics)}
                  sourceTruncated={(drafts.data?.pages ?? []).some((page) => page.sourceTruncated)}
                  truncated={(drafts.data?.pages ?? []).some((page) => page.diagnosticsTruncated)}
                />
                {drafts.isPending ? <StatePanel compact state="loading" title="Reading local drafts" detail="Loading one bounded page." /> : drafts.isError ? <ErrorState error={drafts.error} retry={() => void drafts.refetch()} /> : draftRows.length === 0 ? <StatePanel compact state="empty" title="No local drafts" detail="Compose a structured baton before publishing." /> : <ul className={styles.queueList}>{draftRows.map((draft) => <li key={draft.id}><button aria-current={draftId === draft.id ? "true" : undefined} data-relay-draft-id={draft.id} onClick={() => setSelection({ kind: "draft", id: draft.id })} type="button"><FilePenLine aria-hidden="true" /><span><strong>{draft.summary}</strong><small>{draft.recipients.length} recipient{draft.recipients.length === 1 ? "" : "s"} · {formatDate(draft.updatedAt)}</small></span><ChevronRight aria-hidden="true" /></button></li>)}</ul>}
                {drafts.hasNextPage ? <Button disabled={drafts.isFetchingNextPage} onClick={() => void drafts.fetchNextPage()} size="sm" variant="outline">{drafts.isFetchingNextPage ? "Loading…" : "Load more drafts"}</Button> : drafts.data && drafts.data.pages.length >= MAX_WORKBENCH_PAGES ? <p className={styles.boundNote}>Draft page limit reached.</p> : null}
              </CardContent>
            </Card>
          </aside>
          <section className={styles.desk}>
            <Card className={styles.queueCard} role="region" aria-labelledby="relay-queue-heading">
              <CardHeader className={styles.queueHeader}><div><CardDescription>Canonical handoff queue</CardDescription><CardTitle><h2 id="relay-queue-heading">Relay desk</h2></CardTitle></div><CardAction><StatusPill>{relayRows.length} loaded</StatusPill></CardAction></CardHeader>
              <CardContent className={styles.canonicalContent}>
                <RelayWarnings
                  diagnostics={(relays.data?.pages ?? []).flatMap((page) => page.diagnostics)}
                  sourceTruncated={(relays.data?.pages ?? []).some((page) => page.sourceTruncated)}
                  truncated={(relays.data?.pages ?? []).some((page) => page.diagnosticsTruncated)}
                />
                <Tabs onValueChange={(value) => { setView(value as typeof view); setSelection(null); }} value={view}>
                  <TabsList aria-label="Relay views" variant="line"><TabsTrigger disabled={!currentMemberActive} value="mine">My open</TabsTrigger><TabsTrigger disabled={!currentMemberActive} value="sent">Sent</TabsTrigger><TabsTrigger value="all">All open</TabsTrigger><TabsTrigger value="closed">Closed</TabsTrigger></TabsList>
                </Tabs>
                {(view === "mine" || view === "sent") && !currentMemberActive ? <StatePanel compact state="unavailable" title="Select an active Member" detail="My open and Sent are available only when the current Git identity resolves to an active canonical Member." /> : relays.isPending ? <StatePanel compact state="loading" title="Reading Relay queue" detail="Loading one bounded canonical page." /> : relays.isError ? <ErrorState error={relays.error} retry={() => void relays.refetch()} /> : relayRows.length === 0 ? <StatePanel compact state="empty" title="No Relays in this view" detail="The bounded canonical queue is clear." /> : <ul className={styles.relayList}>{relayRows.map((relay) => <li key={relay.ref.id}><button aria-current={relayId === relay.ref.id ? "true" : undefined} data-relay-id={relay.ref.id} onClick={() => setSelection({ kind: "relay", id: relay.ref.id })} type="button"><span className={styles.stateGlyph}><CircleDot aria-hidden="true" /></span><span><strong>{relay.summary}</strong><small>{actorLabel(relay.sender)} → {relay.recipients.map(actorLabel).join(", ")}</small></span><StatusPill tone={relayTone(relay.state)}>{sentenceCase(relay.state)}</StatusPill><ChevronRight aria-hidden="true" /></button></li>)}</ul>}
                {relays.hasNextPage ? <Button disabled={relays.isFetchingNextPage} onClick={() => void relays.fetchNextPage()} size="sm" variant="outline">{relays.isFetchingNextPage ? "Loading…" : "Load more Relays"}</Button> : null}
              </CardContent>
            </Card>
            <Card className={styles.detailCard} role="region" aria-label="Selected Relay detail">
              {!activeSelection ? <StatePanel compact state="empty" title="No handoff selected" detail="Choose a draft or canonical Relay to inspect its full docket." /> : activeSelection.kind === "draft" ? draftDetail.isPending ? <StatePanel compact state="loading" title="Reading draft" detail="Loading checkout-local detail on selection." /> : draftDetail.isError ? <ErrorState error={draftDetail.error} retry={() => void draftDetail.refetch()} /> : <><CardHeader className={styles.detailHeader}><div><CardDescription>Private Relay draft</CardDescription><CardTitle><h2>{draftDetail.data.summary}</h2></CardTitle><code>{draftDetail.data.id}</code></div><CardAction><StatusPill>Local</StatusPill></CardAction></CardHeader><CardContent className={styles.detailContent}><dl className={styles.meta}><div><dt>Recipients</dt><dd>{draftDetail.data.recipients.map(actorLabel).join(", ")}</dd></div><div><dt>Workstream</dt><dd>{draftDetail.data.workstream.title ?? draftDetail.data.workstream.id}</dd></div><div><dt>Revision</dt><dd><code>{draftDetail.data.revision.slice(0, 12)}</code></dd></div></dl><div className={styles.actions}><Button disabled={!canDraft} onClick={(event) => openComposer(draftDetail.data, event)} size="sm" variant="outline"><FilePenLine data-icon="inline-start" /> Edit</Button><Button disabled={!draftPublishReady} onClick={(event) => draftAction(draftDetail.data, "publish", event)} size="sm"><Send data-icon="inline-start" /> Review &amp; publish</Button><Button disabled={!canDraft} onClick={(event) => draftAction(draftDetail.data, "delete", event)} size="sm" variant="destructive"><Trash2 data-icon="inline-start" /> Delete</Button></div>{draftPublishRecovery ? <p className={styles.recovery} role="status">{draftPublishRecovery}</p> : null}<p className={styles.boundNote}>Publication rechecks the draft, Workstream, all recipient Members, and current authority under the workflow lease.</p></CardContent></> : relayDetail.isPending ? <StatePanel compact state="loading" title="Reading Relay" detail="Loading the immutable handoff body on selection." /> : relayDetail.isError ? <ErrorState error={relayDetail.error} retry={() => void relayDetail.refetch()} /> : <><CardHeader className={styles.detailHeader}><div><CardDescription>Canonical Relay</CardDescription><CardTitle><h2>{relayDetail.data.summary}</h2></CardTitle><code>{relayDetail.data.ref.id}</code></div><CardAction><StatusPill tone={relayTone(relayDetail.data.state)}>{sentenceCase(relayDetail.data.state)}</StatusPill></CardAction></CardHeader><CardContent className={styles.detailContent}><dl className={styles.meta}><div><dt>Sender</dt><dd>{actorLabel(relayDetail.data.sender)}</dd></div><div><dt>Recipients</dt><dd>{relayDetail.data.recipients.map(actorLabel).join(", ")}</dd></div><div><dt>Workstream</dt><dd>{relayDetail.data.workstream.title ?? relayDetail.data.workstream.id}</dd></div><div><dt>Published</dt><dd>{relayDetail.data.publishedAt ? formatDate(relayDetail.data.publishedAt) : "Legacy timestamp unavailable"}</dd></div><div><dt>Claimed by</dt><dd>{relayDetail.data.acknowledgedBy ? actorLabel(relayDetail.data.acknowledgedBy) : "Unclaimed"}</dd></div><div><dt>Acknowledged at</dt><dd>{relayDetail.data.acknowledgedAt ? formatDate(relayDetail.data.acknowledgedAt) : "Not acknowledged"}</dd></div><div><dt>Closed by</dt><dd>{relayDetail.data.closedBy ? actorLabel(relayDetail.data.closedBy) : "Open"}</dd></div><div><dt>Closed at</dt><dd>{relayDetail.data.closedAt ? formatDate(relayDetail.data.closedAt) : "Open"}</dd></div></dl>{relayDetail.data.state !== "closed" ? <div className={styles.actions}>{canAcknowledge ? <Button onClick={(event) => relayAction(relayDetail.data, "acknowledge", event)} size="sm"><UserCheck data-icon="inline-start" /> Claim handoff</Button> : null}{canClose ? <Button onClick={(event) => relayAction(relayDetail.data, "close", event)} size="sm"><CheckCircle2 data-icon="inline-start" /> Close Relay</Button> : null}</div> : <p className={styles.terminal}><ShieldCheck aria-hidden="true" /><span><strong>Immutable closed handoff.</strong> No further Relay actions are available.</span></p>}{!currentMemberActive && relayDetail.data.state !== "closed" ? <p className={styles.recovery} role="status">Select an active current Member to claim or close this Relay.</p> : null}{currentMemberActive && !lifecycleAvailable && relayDetail.data.state !== "closed" ? <p className={styles.recovery} role="status">{capabilities?.relays.lifecycleMutation.reason ?? "Relay lifecycle actions are unavailable in this Hub process."}</p> : null}<DetailSections relay={relayDetail.data} /></CardContent></>}
            </Card>
          </section>
        </div>
      )}
      <aside aria-label="Relay delivery boundary" className={styles.boundary}><GitBranch aria-hidden="true" /><p><strong>Repository baton, not background delivery.</strong> Details load only after selection; nothing polls, spawns an agent, or sends data outside this Hub.</p></aside>
      {composer !== undefined ? <DraftComposer draft={composer} finalFocus={() => trigger.current} members={activeMembers} onApplied={onApplied} onClose={() => setComposer(undefined)} workstreams={eligibleWorkstreams} /> : null}
      {review ? <ReviewDialog finalFocus={() => trigger.current} onApplied={onApplied} onClose={() => setReview(null)} source={review} /> : null}
    </div>
  );
}
