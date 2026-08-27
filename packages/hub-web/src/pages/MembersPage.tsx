import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  Check,
  ChevronRight,
  CircleUserRound,
  GitCommitHorizontal,
  Plus,
  ShieldCheck,
  UserMinus,
  UserPen,
  UsersRound,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type MouseEvent } from "react";
import { useOutletContext } from "react-router-dom";
import { useHubApi } from "../api/context";
import type {
  CapabilitiesResponse,
  TeamCurrentActorResponse,
  TeamGitAlias,
  TeamMember,
  TeamOperationApplyResponse,
  TeamOperationPreviewRequest,
  TeamOperationPreviewResponse,
} from "../api/types";
import { ApplyTeamOperationDialog, TeamOperationPreviewPanel } from "../components/TeamOperationReview";
import { Button } from "../components/primitives/button";
import { Card } from "../components/primitives/card";
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
import { ErrorState, PageHeader, StatePanel, StatusPill, formatDate } from "../components/ui";
import { boundedNextCursor, MAX_WORKBENCH_PAGES } from "../lib/bounds";
import styles from "../styles/members.module.css";

const MEMBER_PAGE_SIZE = 50;
type MemberFilter = "all" | "active" | "inactive";
type MemberOperation =
  | { kind: "add" }
  | { kind: "update"; member: TeamMember }
  | { kind: "deactivate"; member: TeamMember }
  | { kind: "select"; member: TeamMember }
  | { kind: "clear" };

function actorLabel(actor: TeamCurrentActorResponse["actor"]): string {
  if (actor.kind === "member") return actor.displayName ?? actor.memberId;
  if (actor.kind === "git") return actor.name ?? actor.email ?? "Git identity";
  return "Unknown actor";
}

function sourceLabel(source: TeamCurrentActorResponse["source"]): string {
  if (source === "configured-member") return "Selected for this checkout";
  if (source === "git-alias") return "Resolved from a member Git alias";
  if (source === "git-fallback") return "Git identity fallback";
  return "No identity available";
}

function operationTitle(operation: MemberOperation): string {
  if (operation.kind === "add") return "Add member";
  if (operation.kind === "update") return `Update ${operation.member.displayName}`;
  if (operation.kind === "deactivate") return `Deactivate ${operation.member.displayName}`;
  if (operation.kind === "select") return `Select ${operation.member.displayName}`;
  return "Clear current member";
}

function operationConsequence(operation: MemberOperation): string {
  if (operation.kind === "select") return "This changes only the local identity selection and emits no Activity event.";
  if (operation.kind === "clear") return "This clears only the local identity selection and emits no Activity event.";
  if (operation.kind === "deactivate") return "This publishes a canonical member update and one immutable Activity event.";
  return "This publishes the reviewed canonical member bytes and one immutable Activity event.";
}

function operationId(kind: MemberOperation["kind"]): string {
  return `hub_member_${kind}_${crypto.randomUUID().replaceAll("-", "")}`;
}

function aliasesText(aliases: readonly TeamGitAlias[]): string {
  return aliases.map((alias) => `${alias.name ?? ""} | ${alias.email ?? ""}`).join("\n");
}

function parseAliases(value: string): { aliases: TeamGitAlias[]; error: string | null } {
  const lines = value.split("\n").map((line) => line.trim()).filter(Boolean);
  if (lines.length > 32) return { aliases: [], error: "Use no more than 32 Git aliases." };
  const aliases: TeamGitAlias[] = [];
  for (const line of lines) {
    const parts = line.split("|");
    if (parts.length > 2) return { aliases: [], error: "Each alias must use `Name | email` format." };
    const name = parts[0]?.trim() || null;
    const email = parts[1]?.trim() || null;
    if (name === null && email === null) continue;
    if (email !== null && (!email.includes("@") || /\s/.test(email))) {
      return { aliases: [], error: `Invalid alias email: ${email}` };
    }
    aliases.push({ name, email });
  }
  return { aliases, error: null };
}

function memberExpectation(member: TeamMember) {
  return { target: { kind: "artifact" as const, path: member.sourcePath }, revision: member.revision };
}

function selectionExpectation(current: TeamCurrentActorResponse | undefined) {
  return {
    target: { kind: "local" as const, namespace: "member-selection" as const, id: "current" as const },
    revision: current?.selection?.revision ?? null,
  };
}

function MemberOperationDialog({
  operation,
  currentActor,
  onClose,
  onApplied,
}: {
  operation: MemberOperation;
  currentActor: TeamCurrentActorResponse | undefined;
  onClose(): void;
  onApplied(result: TeamOperationApplyResponse, operation: MemberOperation): Promise<void>;
}) {
  const api = useHubApi();
  const id = useRef(operationId(operation.kind));
  const [displayName, setDisplayName] = useState(
    operation.kind === "update" ? operation.member.displayName : "",
  );
  const [aliases, setAliases] = useState(
    operation.kind === "update" ? aliasesText(operation.member.gitAliases) : "",
  );
  const [envelope, setEnvelope] = useState<TeamOperationPreviewResponse | null>(null);
  const [applyOpen, setApplyOpen] = useState(false);
  const parsedAliases = parseAliases(aliases);
  const hasForm = operation.kind === "add" || operation.kind === "update";
  const cleanName = displayName.trim();
  const canPreview = !hasForm || (
    cleanName.length > 0
    && cleanName.length <= 200
    && parsedAliases.error === null
  );

  const request = (): TeamOperationPreviewRequest => {
    if (operation.kind === "add") {
      return {
        operationId: id.current,
        action: {
          kind: "member.add",
          member: { displayName: cleanName, gitAliases: parsedAliases.aliases },
        },
        expectedRevisions: [],
      };
    }
    if (operation.kind === "update") {
      return {
        operationId: id.current,
        action: {
          kind: "member.update",
          memberId: operation.member.id,
          patch: { displayName: cleanName, gitAliases: parsedAliases.aliases },
        },
        expectedRevisions: [memberExpectation(operation.member)],
      };
    }
    if (operation.kind === "deactivate") {
      return {
        operationId: id.current,
        action: { kind: "member.deactivate", memberId: operation.member.id },
        expectedRevisions: [memberExpectation(operation.member)],
      };
    }
    if (operation.kind === "select") {
      return {
        operationId: id.current,
        action: { kind: "member.select", memberId: operation.member.id },
        expectedRevisions: [
          memberExpectation(operation.member),
          selectionExpectation(currentActor),
        ],
      };
    }
    return {
      operationId: id.current,
      action: { kind: "member.clear" },
      expectedRevisions: [selectionExpectation(currentActor)],
    };
  };

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
      await onApplied(result, operation);
      onClose();
    },
  });
  const invalidatePreview = () => {
    setEnvelope(null);
    setApplyOpen(false);
    preview.reset();
    apply.reset();
  };

  return (
    <Dialog open onOpenChange={(open) => { if (!open && !apply.isPending) onClose(); }}>
      <DialogContent className={styles.operationDialog}>
        <DialogHeader>
          <DialogTitle>{operationTitle(operation)}</DialogTitle>
          <DialogDescription>{operationConsequence(operation)} Previewing does not write.</DialogDescription>
        </DialogHeader>

        {hasForm ? (
          <div className={styles.formGrid}>
            <label>
              <span>Display name</span>
              <Input
                autoFocus
                maxLength={200}
                onChange={(event) => {
                  setDisplayName(event.currentTarget.value);
                  invalidatePreview();
                }}
                placeholder="Ada Lovelace"
                value={displayName}
              />
            </label>
            <label>
              <span>Git aliases <small>one per line: Name | email</small></span>
              <Textarea
                aria-invalid={parsedAliases.error !== null || undefined}
                onChange={(event) => {
                  setAliases(event.currentTarget.value);
                  invalidatePreview();
                }}
                placeholder={"Ada | ada@example.test\nA. Lovelace |"}
                rows={4}
                value={aliases}
              />
            </label>
            {parsedAliases.error ? <p className={styles.formError} role="alert">{parsedAliases.error}</p> : null}
          </div>
        ) : (
          <div className={styles.operationNotice}>
            {operation.kind === "select" || operation.kind === "clear"
              ? <CircleUserRound aria-hidden="true" />
              : <UserMinus aria-hidden="true" />}
            <span>{operationConsequence(operation)}</span>
          </div>
        )}

        {preview.isError ? <ErrorState error={preview.error} retry={() => preview.mutate()} /> : null}
        {envelope ? <TeamOperationPreviewPanel envelope={envelope} /> : null}
        <div className="sr-only" aria-live="polite" role="status">
          {preview.isPending ? "Preparing preview" : envelope ? "Preview ready for approval" : ""}
          {apply.isPending ? "Applying approved preview" : ""}
        </div>

        <DialogFooter className={styles.operationFooter}>
          <DialogClose render={<Button disabled={preview.isPending || apply.isPending} variant="outline" />}>
            Cancel
          </DialogClose>
          {envelope ? (
            <Button disabled={!envelope.preview.valid || apply.isPending} onClick={() => setApplyOpen(true)}>
              Review apply
            </Button>
          ) : (
            <Button disabled={!canPreview || preview.isPending} onClick={() => preview.mutate()}>
              {preview.isPending ? "Previewing…" : "Preview change"}
            </Button>
          )}
        </DialogFooter>

        {envelope ? (
          <ApplyTeamOperationDialog
            consequence={operationConsequence(operation)}
            envelope={envelope}
            error={apply.isError ? apply.error : undefined}
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

function CurrentActorCard({
  current,
  canSelect,
  onClear,
}: {
  current: TeamCurrentActorResponse;
  canSelect: boolean;
  onClear(event: MouseEvent<HTMLButtonElement>): void;
}) {
  const staleSelection = current.selection !== null && current.source !== "configured-member";
  return (
    <Card aria-label="Current actor identity" className={styles.actorCard} role="region">
      <div className={styles.actorGlyph}><CircleUserRound aria-hidden="true" /></div>
      <div className={styles.actorCopy}>
        <p>Current actor</p>
        <h2 id="current-actor-heading">{actorLabel(current.actor)}</h2>
        <span>{sourceLabel(current.source)}</span>
      </div>
      <div className={styles.actorMeta}>
        <StatusPill tone={staleSelection ? "warning" : current.selection ? "success" : "neutral"}>
          {staleSelection ? "Stale local selection" : current.selection ? "Local selection" : "Fallback"}
        </StatusPill>
        {current.selection && canSelect ? (
          <Button onClick={onClear} size="sm" type="button" variant="ghost">
            <X aria-hidden="true" /> Clear selection
          </Button>
        ) : null}
      </div>
      {staleSelection && current.diagnostics[0] ? (
        <p className={styles.actorWarning} role="status">
          <AlertTriangle aria-hidden="true" /> {current.diagnostics[0].message}
        </p>
      ) : null}
    </Card>
  );
}

export function MembersPage() {
  const api = useHubApi();
  const queryClient = useQueryClient();
  const { capabilities } = useOutletContext<{ capabilities?: CapabilitiesResponse }>();
  const [filter, setFilter] = useState<MemberFilter>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [operation, setOperation] = useState<MemberOperation | null>(null);
  const [status, setStatus] = useState("");
  const operationTrigger = useRef<HTMLButtonElement | null>(null);
  const operationWasOpen = useRef(false);
  const readAvailable = capabilities?.members.read.availability === "available";
  const canonicalMutation = capabilities?.members.canonicalMutation.availability === "available";
  const localSelection = capabilities?.members.localSelection.availability === "available";

  useEffect(() => {
    if (operationWasOpen.current && operation === null) {
      operationTrigger.current?.focus({ preventScroll: true });
    }
    operationWasOpen.current = operation !== null;
  }, [operation]);

  const openOperation = (
    next: MemberOperation,
    event: MouseEvent<HTMLButtonElement>,
  ) => {
    operationTrigger.current = event.currentTarget;
    setOperation(next);
  };

  const current = useQuery({
    queryKey: ["actor", "current"],
    queryFn: () => api.getCurrentActor(),
    enabled: readAvailable,
    retry: false,
  });
  const members = useInfiniteQuery({
    queryKey: ["members", filter],
    queryFn: ({ pageParam }) => api.getMembers({
      limit: MEMBER_PAGE_SIZE,
      ...(filter === "active" ? { active: true } : filter === "inactive" ? { active: false } : {}),
      ...(pageParam ? { cursor: pageParam } : {}),
    }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (lastPage, pages) => boundedNextCursor(lastPage.nextCursor, pages.length),
    enabled: readAvailable,
    retry: false,
  });
  const rows = useMemo(() => {
    const unique = new Map<string, TeamMember>();
    for (const page of members.data?.pages ?? []) {
      for (const member of page.items) unique.set(member.id, member);
    }
    return [...unique.values()];
  }, [members.data?.pages]);
  const detailId = selectedId ?? rows[0]?.id ?? null;
  const detail = useQuery({
    queryKey: ["member", detailId],
    queryFn: () => api.getMember(detailId!),
    enabled: readAvailable && detailId !== null,
    retry: false,
  });

  const onApplied = async (
    result: TeamOperationApplyResponse,
    appliedOperation: MemberOperation,
  ) => {
    const localOnly = appliedOperation.kind === "select" || appliedOperation.kind === "clear";
    if (localOnly) {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["actor", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
      ]);
    } else {
      const affectedId = result.members[0]?.id
        ?? ("member" in appliedOperation ? appliedOperation.member.id : null);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["members"] }),
        ...(affectedId === null ? [] : [queryClient.invalidateQueries({ queryKey: ["member", affectedId] })]),
        queryClient.invalidateQueries({ queryKey: ["actor", "current"] }),
        queryClient.invalidateQueries({ queryKey: ["activity"] }),
        queryClient.invalidateQueries({ queryKey: ["home"] }),
      ]);
      if (result.members[0]) setSelectedId(result.members[0].id);
    }
    setStatus(localOnly
      ? "Local member selection updated. No Activity event was created."
      : "Canonical member change applied with one immutable Activity event.");
  };

  return (
    <div className={styles.page}>
      <PageHeader
        eyebrow="Team identity"
        title="Members"
        description="Canonical member records travel with Git. Your current actor selection stays private to this checkout."
        actions={canonicalMutation ? (
          <Button onClick={(event) => openOperation({ kind: "add" }, event)} type="button">
            <Plus aria-hidden="true" /> Add member
          </Button>
        ) : undefined}
      />

      <div className={styles.liveStatus} aria-live="polite" role="status">{status}</div>

      {capabilities === undefined ? (
        <StatePanel state="loading" title="Checking member capability" detail="Confirming the local Team workflow connection." />
      ) : !readAvailable ? (
        <StatePanel state="unavailable" title="Members are unavailable" detail={capabilities.members.read.reason ?? "Member reads are not connected in this Hub process."} />
      ) : current.isPending ? (
        <StatePanel state="loading" title="Resolving current actor" detail="Reading checkout-local selection and Git identity." />
      ) : current.isError ? (
        <ErrorState error={current.error} retry={() => void current.refetch()} />
      ) : (
        <CurrentActorCard
          canSelect={Boolean(localSelection)}
          current={current.data}
          onClear={(event) => openOperation({ kind: "clear" }, event)}
        />
      )}

      {readAvailable ? (
        <div className={styles.workbench}>
          <Card className={styles.memberRail} role="region" aria-labelledby="member-directory-heading">
            <header className={styles.railHeader}>
              <div><p>Canonical directory</p><h2 id="member-directory-heading">Team roster</h2></div>
              <StatusPill>{rows.length} loaded</StatusPill>
            </header>
            <div className={styles.filterBar} aria-label="Filter members" role="group">
              {(["all", "active", "inactive"] as const).map((value) => (
                <Button
                  aria-pressed={filter === value}
                  key={value}
                  onClick={() => {
                    setFilter(value);
                    setSelectedId(null);
                  }}
                  size="sm"
                  type="button"
                  variant="ghost"
                >
                  {value === "all" ? "All" : value === "active" ? "Active" : "Inactive"}
                </Button>
              ))}
            </div>
            {members.isPending ? (
              <StatePanel compact state="loading" title="Reading members" detail="Scanning the bounded canonical directory." />
            ) : members.isError ? (
              <ErrorState error={members.error} retry={() => void members.refetch()} />
            ) : rows.length === 0 ? (
              <StatePanel compact state="empty" title="No matching members" detail="Adjust the active filter or add a canonical member." />
            ) : (
              <ul className={styles.memberList}>
                {rows.map((member) => (
                  <li key={member.id}>
                    <button
                      aria-current={detailId === member.id ? "true" : undefined}
                      onClick={() => setSelectedId(member.id)}
                      type="button"
                    >
                      <span className={styles.avatar} aria-hidden="true">{member.displayName.slice(0, 2).toUpperCase()}</span>
                      <span><strong>{member.displayName}</strong><small>{member.gitAliases[0]?.email ?? "No Git email alias"}</small></span>
                      <StatusPill tone={member.active ? "success" : "neutral"}>{member.active ? "Active" : "Inactive"}</StatusPill>
                      <ChevronRight aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {members.hasNextPage ? (
              <Button
                className={styles.loadMore}
                disabled={members.isFetchingNextPage}
                onClick={() => void members.fetchNextPage()}
                type="button"
                variant="outline"
              >
                {members.isFetchingNextPage ? "Loading…" : "Load more members"}
              </Button>
            ) : members.data && members.data.pages.length >= MAX_WORKBENCH_PAGES ? (
              <p className={styles.boundNote}>Browser page limit reached.</p>
            ) : null}
          </Card>

          <Card aria-label="Selected member detail" className={styles.detail} role="region">
            {detailId === null ? (
              <StatePanel compact state="empty" title="No member selected" detail="Choose a member from the canonical directory." />
            ) : detail.isPending ? (
              <StatePanel compact state="loading" title="Reading member detail" detail="Verifying the exact canonical revision." />
            ) : detail.isError ? (
              <ErrorState error={detail.error} retry={() => void detail.refetch()} />
            ) : (
              <>
                <header className={styles.detailHeader}>
                  <div className={styles.detailIdentity}>
                    <span className={styles.detailAvatar} aria-hidden="true">{detail.data.displayName.slice(0, 2).toUpperCase()}</span>
                    <div><p>Canonical member</p><h2 id="member-detail-heading">{detail.data.displayName}</h2><code>{detail.data.id}</code></div>
                  </div>
                  <StatusPill tone={detail.data.active ? "success" : "neutral"}>{detail.data.active ? "Active" : "Inactive"}</StatusPill>
                </header>
                <dl className={styles.detailFacts}>
                  <div><dt>Revision</dt><dd><GitCommitHorizontal aria-hidden="true" /> <code>{detail.data.revision.slice(0, 12)}</code></dd></div>
                  <div><dt>Source</dt><dd><code>{detail.data.sourcePath}</code></dd></div>
                  <div><dt>Current here</dt><dd>{current.data?.selection?.memberId === detail.data.id ? "Selected in this checkout" : "Not selected"}</dd></div>
                  <div><dt>Last resolved</dt><dd>{current.data?.selection?.memberId === detail.data.id ? formatDate(current.data.selection.updatedAt) : "Not recorded locally"}</dd></div>
                </dl>
                <section className={styles.aliases} aria-labelledby="member-aliases-heading">
                  <header><h3 id="member-aliases-heading">Git aliases</h3><span>{detail.data.gitAliases.length}</span></header>
                  {detail.data.gitAliases.length ? (
                    <ul>{detail.data.gitAliases.map((alias, index) => <li key={`${alias.name ?? ""}:${alias.email ?? ""}:${index}`}><strong>{alias.name ?? "No name"}</strong><code>{alias.email ?? "No email"}</code></li>)}</ul>
                  ) : <p>No Git aliases are recorded.</p>}
                </section>
                <footer className={styles.detailActions}>
                  {localSelection && detail.data.active && current.data?.selection?.memberId !== detail.data.id ? (
                    <Button onClick={(event) => openOperation({ kind: "select", member: detail.data }, event)} type="button" variant="outline">
                      <Check aria-hidden="true" /> Select locally
                    </Button>
                  ) : null}
                  {canonicalMutation ? (
                    <Button onClick={(event) => openOperation({ kind: "update", member: detail.data }, event)} type="button" variant="outline">
                      <UserPen aria-hidden="true" /> Update
                    </Button>
                  ) : null}
                  {canonicalMutation && detail.data.active && current.data?.selection?.memberId !== detail.data.id ? (
                    <Button onClick={(event) => openOperation({ kind: "deactivate", member: detail.data }, event)} type="button" variant="destructive">
                      <UserMinus aria-hidden="true" /> Deactivate
                    </Button>
                  ) : null}
                </footer>
              </>
            )}
          </Card>
        </div>
      ) : null}

      <aside className={styles.privacyNote}>
        <ShieldCheck aria-hidden="true" />
        <span><strong>Local means local.</strong> Selecting or clearing an actor updates only checkout-local state and never emits Activity.</span>
      </aside>

      {operation ? (
        <MemberOperationDialog
          currentActor={current.data}
          onApplied={onApplied}
          onClose={() => setOperation(null)}
          operation={operation}
        />
      ) : null}
    </div>
  );
}
