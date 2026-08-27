import type {
  ActorRef,
  Diagnostic,
  FileChange,
  JsonValue,
  RepoState,
  Revision,
} from "../contracts/shared.js";
import type {
  ActivityEvent,
  ActivitySubjectRef,
  LocalStateChange,
  MemberGitAlias,
  StoredActivityEvent,
  TeamCurrentActor,
  TeamIdentityActivityPreviewEnvelope,
  TeamMember,
  TeamPage,
  TeamWorkflowResult,
} from "../contracts/workflow.js";

export interface TeamMemberProjection {
  schemaVersion: 1;
  id: string;
  displayName: string;
  gitAliases: readonly MemberGitAlias[];
  active: boolean;
  sourcePath: string;
  revision: Revision;
}

export interface TeamActivityProjection {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  actor: ActorRef;
  action: string;
  subjects: readonly ActivitySubjectRef[];
  workstream: ActivityEvent["workstream"] | null;
  repoState: RepoState;
  metadata: ActivityEvent["metadata"] | null;
  sourcePath: string | null;
  revision: Revision | null;
}

export interface TeamPageProjection<T> {
  items: readonly T[];
  nextCursor: string | null;
  truncated: boolean;
  sourceTruncated: boolean;
  deterministicRevision: Revision;
}

export interface TeamCurrentActorProjection {
  actor: ActorRef;
  source: TeamCurrentActor["source"];
  selection: TeamCurrentActor["selection"];
}

export interface TeamApplyProjection {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  members: readonly TeamMemberProjection[];
  events: readonly TeamActivityProjection[];
}

export function projectMember(member: TeamMember): TeamMemberProjection {
  return {
    schemaVersion: 1,
    id: member.ref.id,
    displayName: member.displayName,
    gitAliases: member.gitAliases.map((alias) => ({ name: alias.name, email: alias.email })),
    active: member.active,
    sourcePath: member.sourcePath,
    revision: member.revision,
  };
}

export function projectMemberPage(
  page: TeamPage<TeamMember>,
): { data: TeamPageProjection<TeamMemberProjection>; diagnostics: readonly Diagnostic[] } {
  return {
    data: projectPage(page, page.items.map(projectMember)),
    diagnostics: page.diagnostics,
  };
}

export function projectActivity(
  activity: ActivityEvent | StoredActivityEvent,
): TeamActivityProjection {
  const stored = activity as Partial<StoredActivityEvent>;
  return {
    schemaVersion: 1,
    id: activity.id,
    timestamp: activity.timestamp,
    actor: structuredClone(activity.actor),
    action: activity.action,
    subjects: structuredClone(activity.subjects),
    workstream: activity.workstream === undefined ? null : structuredClone(activity.workstream),
    repoState: structuredClone(activity.repoState),
    metadata: activity.metadata === undefined ? null : structuredClone(activity.metadata),
    sourcePath: stored.sourcePath ?? null,
    revision: stored.revision ?? null,
  };
}

export function projectActivityPage(
  page: TeamPage<StoredActivityEvent>,
): { data: TeamPageProjection<TeamActivityProjection>; diagnostics: readonly Diagnostic[] } {
  return {
    data: projectPage(page, page.items.map(projectActivity)),
    diagnostics: page.diagnostics,
  };
}

export function projectCurrentActor(
  current: TeamCurrentActor,
): { data: TeamCurrentActorProjection; diagnostics: readonly Diagnostic[] } {
  return {
    data: {
      actor: structuredClone(current.actor),
      source: current.source,
      selection: current.selection === null ? null : { ...current.selection },
    },
    diagnostics: current.diagnostics,
  };
}

/** The C0 service already stripped prepared handles and private command state. */
export function projectPreview(
  preview: TeamIdentityActivityPreviewEnvelope,
): TeamIdentityActivityPreviewEnvelope {
  return structuredClone(preview);
}

export function projectApply<TWikiPayload extends JsonValue>(
  result: TeamWorkflowResult<TWikiPayload>,
): TeamApplyProjection {
  return {
    operationId: result.operationId,
    previewRevision: result.previewRevision,
    applied: true,
    idempotentReplay: result.idempotentReplay,
    changes: structuredClone(result.changes),
    localChanges: structuredClone(result.localChanges),
    members: result.artifacts
      .filter((artifact): artifact is TeamMember => artifact.kind === "member")
      .map(projectMember),
    events: result.events.map(projectActivity),
  };
}

function projectPage<TSource, TProjection>(
  page: TeamPage<TSource>,
  items: readonly TProjection[],
): TeamPageProjection<TProjection> {
  return {
    items,
    nextCursor: page.nextCursor,
    truncated: page.truncated,
    sourceTruncated: page.sourceTruncated,
    deterministicRevision: page.deterministicRevision,
  };
}
