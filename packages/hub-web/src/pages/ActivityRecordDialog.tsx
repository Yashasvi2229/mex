import { useMutation, useQueryClient } from "@tanstack/react-query";
import { FilePlus2, ShieldCheck } from "lucide-react";
import { useRef, useState } from "react";
import { useHubApi } from "../api/context";
import type {
  TeamActivitySubjectInput,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
} from "../api/types";
import { ApplyTeamOperationDialog, TeamOperationPreviewPanel } from "../components/TeamOperationReview";
import { Button } from "../components/primitives/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../components/primitives/dialog";
import { Input } from "../components/primitives/input";
import { Textarea } from "../components/primitives/textarea";
import { ErrorState } from "../components/ui";
import styles from "../styles/activity-record.module.css";

function parseSubjects(value: string): {
  subjects: TeamActivitySubjectInput[];
  error: string | null;
} {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 64) return { subjects: [], error: "Use no more than 64 subject references." };
  const subjects: TeamActivitySubjectInput[] = [];
  for (const line of lines) {
    const separator = line.indexOf(":");
    if (separator <= 0 || separator === line.length - 1) {
      return { subjects: [], error: `Subject needs a supported prefix: ${line}` };
    }
    const kind = line.slice(0, separator);
    const body = line.slice(separator + 1).trim();
    if (kind === "file") subjects.push({ kind: "file", path: body });
    else if (kind === "symbol") {
      subjects.push({ kind: "code", code: { kind: "symbol", symbolId: body } });
    } else if (kind === "commit" && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(body)) {
      subjects.push({ kind: "commit", hash: body });
    } else if (kind === "entity") {
      const [entityKind, id, ...titleParts] = body.split(":");
      if (!entityKind || !id) {
        return { subjects: [], error: "Entity subjects use entity:kind:id[:title]." };
      }
      const title = titleParts.join(":").trim();
      subjects.push({
        kind: "entity",
        entity: { id, kind: entityKind, ...(title ? { title } : {}) },
      });
    } else {
      return { subjects: [], error: `Unsupported or invalid subject: ${line}` };
    }
  }
  return { subjects, error: null };
}

export function ActivityRecordDialog({
  open,
  onOpenChange,
  onApplied,
}: {
  open: boolean;
  onOpenChange(open: boolean): void;
  onApplied(message: string): void;
}) {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const operationId = useRef(`hub_activity_record_${crypto.randomUUID().replaceAll("-", "")}`);
  const [action, setAction] = useState("");
  const [subjectsText, setSubjectsText] = useState("");
  const [workstreamId, setWorkstreamId] = useState("");
  const [envelope, setEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const subjects = parseSubjects(subjectsText);
  const cleanAction = action.trim();
  const cleanWorkstream = workstreamId.trim();
  const actionValid = /^[a-z][a-z0-9]*(?:[._-][a-z0-9]+)*$/.test(cleanAction)
    && cleanAction.length <= 128;
  const workstreamValid = cleanWorkstream === ""
    || /^ws_[0-7][0-9A-HJKMNP-TV-Z]{25}$/.test(cleanWorkstream);
  const canPreview = actionValid && workstreamValid && subjects.error === null;

  const request = (): TeamOperationPreviewRequest => ({
    operationId: operationId.current,
    action: {
      kind: "activity.record",
      activity: {
        action: cleanAction,
        subjects: subjects.subjects,
        ...(cleanWorkstream ? {
          workstream: { id: cleanWorkstream, kind: "workstream" as const },
        } : {}),
      },
    },
    expectedRevisions: [],
  });
  const preview = useMutation({
    mutationFn: () => api.previewTeamOperation(request()),
    onSuccess: setEnvelope,
  });
  const apply = useMutation({
    mutationFn: () => {
      if (envelope === null) throw new Error("Preview is unavailable.");
      return api.applyTeamOperation(envelope);
    },
    onSuccess: async (result) => {
      setApplyOpen(false);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
      ]);
      onApplied(`Activity ${result.events[0]?.id ?? "event"} was appended as an immutable canonical record.`);
      onOpenChange(false);
    },
  });
  const invalidatePreview = () => {
    setEnvelope(null);
    setApplyOpen(false);
    preview.reset();
    apply.reset();
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!apply.isPending) onOpenChange(next); }}>
      <DialogContent className={styles.dialog}>
        <DialogHeader>
          <DialogTitle>Record Activity</DialogTitle>
          <DialogDescription>
            Append one immutable canonical event. The service captures actor, timestamp, branch, HEAD, and dirty state.
          </DialogDescription>
        </DialogHeader>

        <div className={styles.appendOnly}>
          <ShieldCheck aria-hidden="true" />
          <span><strong>Append only</strong> Existing Activity is never edited or deleted here.</span>
        </div>

        <div className={styles.form}>
          <label>
            <span>Action <small>lower-case namespaced identifier</small></span>
            <Input
              aria-invalid={(cleanAction.length > 0 && !actionValid) || undefined}
              autoFocus
              maxLength={128}
              onChange={(event) => {
                setAction(event.currentTarget.value);
                invalidatePreview();
              }}
              placeholder="review.completed"
              value={action}
            />
          </label>
          <label>
            <span>Subject references <small>optional, one per line</small></span>
            <Textarea
              aria-describedby="activity-subject-help"
              aria-invalid={subjects.error !== null || undefined}
              onChange={(event) => {
                setSubjectsText(event.currentTarget.value);
                invalidatePreview();
              }}
              placeholder={"file:src/review.ts\nsymbol:sym.review\ncommit:0123456789abcdef0123456789abcdef01234567\nentity:spec:mx_example:Review contract"}
              rows={5}
              value={subjectsText}
            />
            <small id="activity-subject-help">Prefixes: file, symbol, commit, or entity:kind:id[:title].</small>
          </label>
          <label>
            <span>Workstream ID <small>optional</small></span>
            <Input
              aria-invalid={!workstreamValid || undefined}
              onChange={(event) => {
                setWorkstreamId(event.currentTarget.value);
                invalidatePreview();
              }}
              placeholder="ws_01…"
              value={workstreamId}
            />
          </label>
          {subjects.error ? <p className={styles.formError} role="alert">{subjects.error}</p> : null}
          {!workstreamValid ? <p className={styles.formError} role="alert">Workstream ID must be a canonical ws_ ULID.</p> : null}
        </div>

        {preview.isError ? <ErrorState error={preview.error} retry={() => preview.mutate()} /> : null}
        {envelope ? <TeamOperationPreviewPanel envelope={envelope} /> : null}
        {apply.isError ? <ErrorState error={apply.error} /> : null}
        <div className="sr-only" aria-live="polite" role="status">
          {preview.isPending ? "Preparing Activity preview" : envelope ? "Activity preview ready for approval" : ""}
          {apply.isPending ? "Appending approved Activity" : ""}
        </div>

        <DialogFooter>
          <DialogClose render={<Button disabled={preview.isPending || apply.isPending} variant="outline" />}>
            Cancel
          </DialogClose>
          {envelope ? (
            <Button disabled={!envelope.preview.valid} onClick={() => setApplyOpen(true)}>
              Review apply
            </Button>
          ) : (
            <Button disabled={!canPreview || preview.isPending} onClick={() => preview.mutate()}>
              <FilePlus2 aria-hidden="true" /> {preview.isPending ? "Previewing…" : "Preview append"}
            </Button>
          )}
        </DialogFooter>

        {envelope ? (
          <ApplyTeamOperationDialog
            consequence="This appends one immutable canonical Activity event."
            envelope={envelope}
            onApply={() => apply.mutate()}
            onOpenChange={setApplyOpen}
            open={applyOpen}
            pending={apply.isPending}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

export default ActivityRecordDialog;
