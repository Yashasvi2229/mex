import type {
  ActorRef,
  CodeRef,
  Diagnostic,
  EntityRef,
  FileChange,
  JsonValue,
  Page,
  PageRequest,
  RepoRelativePath,
  RepoState,
  Revision,
  RevisionExpectation,
} from "./shared.js";
import type {
  WikiOperationType,
  WikiRevisionExpectation,
} from "./wiki.js";

export const TEAM_READ_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 100,
  maxActivityMetadataEntries: 32,
  maxActivityMetadataBytes: 8 * 1024,
} as const;

export const TEAM_IDENTITY_ACTIVITY_LIMITS = {
  maxEnvelopeBytes: 64 * 1024,
  maxReceiptBytes: 8 * 1024,
  maxReceiptDepth: 8,
  maxReceiptNodes: 128,
  maxPurposeIds: 2,
  maxPreviewAgeMs: 30 * 60 * 1_000,
  maxFutureClockSkewMs: 5_000,
} as const;

export const WORKSTREAM_STATES = [
  "planned",
  "active",
  "blocked",
  "done",
  "archived",
] as const;

export const PROPOSAL_STATES = [
  "pending",
  "approved",
  "rejected",
  "withdrawn",
  "stale",
] as const;

export const RELAY_STATES = ["published", "acknowledged", "closed"] as const;
export const PLAYBOOK_STATES = ["active", "archived"] as const;
export const PLAYBOOK_RUN_STATES = ["active", "completed"] as const;

export type WorkstreamState = (typeof WORKSTREAM_STATES)[number];
export type ProposalState = (typeof PROPOSAL_STATES)[number];
export type RelayState = (typeof RELAY_STATES)[number];
export type PlaybookState = (typeof PLAYBOOK_STATES)[number];
export type PlaybookRunState = (typeof PLAYBOOK_RUN_STATES)[number];

export type TeamArtifactKind =
  | "member"
  | "workstream"
  | "proposal"
  | "relay"
  | "playbook"
  | "playbook_run";

export type TeamArtifactState =
  | WorkstreamState
  | ProposalState
  | RelayState
  | PlaybookState
  | PlaybookRunState;

export interface TeamPage<T> extends Page<T> {
  truncated: boolean;
  /** True only when a bounded source scan could not prove a complete corpus. */
  sourceTruncated: boolean;
  /** Hash of the bounded ordered source revisions used for this page. */
  deterministicRevision: Revision;
  /** Bounded source/validation diagnostics; never an unbounded error corpus. */
  diagnostics: readonly Diagnostic[];
}

export interface TeamArtifactBase<TKind extends TeamArtifactKind> {
  schemaVersion: 1;
  ref: EntityRef;
  kind: TKind;
  sourcePath: RepoRelativePath;
  revision: Revision;
}

export interface MemberGitAlias {
  name: string | null;
  email: string | null;
}

export interface TeamMember extends TeamArtifactBase<"member"> {
  displayName: string;
  gitAliases: readonly MemberGitAlias[];
  active: boolean;
}

export interface Workstream extends TeamArtifactBase<"workstream"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  title: string;
  goal: string;
  summary: string;
  state: WorkstreamState;
  owners: readonly ActorRef[];
  contributors: readonly ActorRef[];
  paths: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  topics: readonly EntityRef[];
  components: readonly EntityRef[];
  related: readonly EntityRef[];
  blockers: readonly string[];
  currentState: string;
  nextMilestone: string;
  createdBy: ActorRef;
  createdAt: string;
  updatedBy: ActorRef;
  updatedAt: string;
}

export type TeamEvidenceRef =
  | { kind: "entity"; entity: EntityRef }
  | { kind: "code"; code: CodeRef }
  | { kind: "commit"; hash: string }
  | { kind: "file"; path: RepoRelativePath }
  | { kind: "external"; uri: string; label?: string }
  | { kind: "manual"; note: string };

export interface InboxProposal<TWikiOperationPlan>
  extends TeamArtifactBase<"proposal"> {
  state: ProposalState;
  author: ActorRef;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  request: PortableWikiOperationRequest<TWikiOperationPlan>;
  targetRevisions: readonly RevisionExpectation[];
  reviewer?: ActorRef;
  reviewRationale?: string;
  reviewedAt?: string;
}

export interface Relay extends TeamArtifactBase<"relay"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  state: RelayState;
  sender: ActorRef;
  recipients: readonly ActorRef[];
  workstream: EntityRef;
  summary: string;
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
  acknowledgedBy?: ActorRef;
  acknowledgedAt?: string;
  closedBy?: ActorRef;
  closedAt?: string;
}

export interface PlaybookStepDefinition {
  id: string;
  title: string;
  instructions: string;
  requiredChecks: readonly string[];
  expectedOutputs: readonly string[];
}

export interface Playbook extends TeamArtifactBase<"playbook"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  state: PlaybookState;
  title: string;
  purpose: string;
  trigger: string;
  owners: readonly ActorRef[];
  prerequisites: readonly string[];
  steps: readonly PlaybookStepDefinition[];
  related: readonly EntityRef[];
}

export interface PlaybookRunStep {
  stepId: string;
  completedBy?: ActorRef;
  completedAt?: string;
}

export interface PlaybookRun extends TeamArtifactBase<"playbook_run"> {
  /** Wiki semantic revision; distinct from the exact-byte artifact revision. */
  entityRevision: number;
  state: PlaybookRunState;
  playbook: EntityRef;
  workstream: EntityRef;
  steps: readonly PlaybookRunStep[];
  startedBy: ActorRef;
  startedAt: string;
}

export type TeamArtifact<TWikiOperationPlan> =
  | TeamMember
  | Workstream
  | InboxProposal<TWikiOperationPlan>
  | Relay
  | Playbook
  | PlaybookRun;

export interface TeamArtifactListRequest extends PageRequest {
  kinds?: readonly TeamArtifactKind[];
  states?: readonly TeamArtifactState[];
  includeArchived?: boolean;
}

export type LocalDraftKind = "inbox" | "relay";

export interface LocalDraftBase<TKind extends LocalDraftKind> {
  id: string;
  kind: TKind;
  revision: Revision;
  updatedAt: string;
}

export interface InboxDraft<TWikiOperationPlan>
  extends LocalDraftBase<"inbox"> {
  request: PortableWikiOperationRequest<TWikiOperationPlan>;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
}

export interface RelayDraft extends LocalDraftBase<"relay"> {
  recipients: readonly ActorRef[];
  workstream: EntityRef;
  summary: string;
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
}

export type LocalDraft<TWikiOperationPlan> =
  | InboxDraft<TWikiOperationPlan>
  | RelayDraft;

export interface LocalDraftListRequest extends PageRequest {
  kind?: LocalDraftKind;
}

export interface LocalStateChange {
  namespace: "inbox-draft" | "relay-draft" | "cursor" | "member-selection";
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
  summary: string;
}

/** Stable references that an immutable activity event may point at. */
export type ActivitySubjectRef =
  | { kind: "entity"; entity: EntityRef }
  | { kind: "code"; code: CodeRef }
  | { kind: "file"; path: RepoRelativePath }
  | { kind: "commit"; hash: string };

export interface ActivityEvent {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  actor: ActorRef;
  action: string;
  subjects: readonly ActivitySubjectRef[];
  workstream?: EntityRef;
  repoState: RepoState;
  metadata?: Readonly<Record<string, JsonValue>>;
}

/** Canonical activity event plus its storage identity. */
export interface StoredActivityEvent extends ActivityEvent {
  sourcePath: RepoRelativePath;
  revision: Revision;
}

export interface TeamMemberListRequest extends PageRequest {
  active?: boolean;
}

export interface TeamActivityListRequest extends PageRequest {
  since?: string;
}

export interface TeamWorkstreamListRequest extends PageRequest {
  states?: readonly WorkstreamState[];
  includeArchived?: boolean;
}

export type TeamActorResolutionSource =
  | "configured-member"
  | "git-alias"
  | "git-fallback"
  | "unknown";

export interface TeamMemberSelection {
  memberId: string;
  updatedAt: string;
  revision: Revision;
}

export interface TeamCurrentActor {
  actor: ActorRef;
  source: TeamActorResolutionSource;
  selection: TeamMemberSelection | null;
  diagnostics: readonly Diagnostic[];
}

export interface WorkstreamCreateInput {
  title: string;
  goal: string;
  summary: string;
  owners: readonly ActorRef[];
  contributors?: readonly ActorRef[];
  paths?: readonly RepoRelativePath[];
  code?: readonly CodeRef[];
  topics?: readonly EntityRef[];
  components?: readonly EntityRef[];
  related?: readonly EntityRef[];
  nextMilestone: string;
}

export interface WorkstreamUpdatePatch {
  title?: string;
  goal?: string;
  summary?: string;
  state?: WorkstreamState;
  owners?: readonly ActorRef[];
  contributors?: readonly ActorRef[];
  paths?: readonly RepoRelativePath[];
  code?: readonly CodeRef[];
  topics?: readonly EntityRef[];
  components?: readonly EntityRef[];
  related?: readonly EntityRef[];
  blockers?: readonly string[];
  currentState?: string;
  nextMilestone?: string;
}

export interface InboxDraftInput<TWikiOperationPlan> {
  request: PortableWikiOperationRequest<TWikiOperationPlan>;
  rationale: string;
  evidence: readonly TeamEvidenceRef[];
  targetRevisions: readonly RevisionExpectation[];
}

export interface RelayDraftInput {
  recipients: readonly ActorRef[];
  workstream: EntityRef;
  summary: string;
  completed: readonly string[];
  inProgress: readonly string[];
  decisions: readonly EntityRef[];
  blockers: readonly string[];
  unresolvedQuestions: readonly string[];
  changedFiles: readonly RepoRelativePath[];
  code: readonly CodeRef[];
  evidence: readonly TeamEvidenceRef[];
  nextActions: readonly string[];
}

/** Actions whose primary artifact does not exist yet. */
export type TeamWorkflowCreateAction<TWikiOperationPlan> =
  | {
      kind: "member.add";
      member: { displayName: string; gitAliases: readonly MemberGitAlias[]; active?: boolean };
    }
  | { kind: "workstream.create"; workstream: WorkstreamCreateInput }
  | {
      kind: "inbox.draft.save";
      draftId?: never;
      draft: InboxDraftInput<TWikiOperationPlan>;
    }
  | { kind: "relay.draft.save"; draftId?: never; draft: RelayDraftInput }
  | {
      kind: "playbook.create";
      playbook: Omit<
        Playbook,
        keyof TeamArtifactBase<"playbook"> | "state" | "entityRevision"
      >;
    }
  | {
      kind: "activity.record";
      activity: {
        action: string;
        subjects: readonly ActivitySubjectRef[];
        workstream?: EntityRef;
      };
    };

/** Actions that mutate or depend on an existing revisioned target. */
export type TeamWorkflowRevisionBoundAction<TWikiOperationPlan> =
  | {
      kind: "inbox.draft.save";
      draftId: string;
      draft: InboxDraftInput<TWikiOperationPlan>;
    }
  | { kind: "relay.draft.save"; draftId: string; draft: RelayDraftInput }
  | {
      kind: "member.update";
      memberId: string;
      patch: { displayName?: string; gitAliases?: readonly MemberGitAlias[] };
    }
  | { kind: "member.deactivate"; memberId: string }
  | { kind: "member.select"; memberId: string }
  | { kind: "member.clear" }
  | { kind: "workstream.update"; workstreamId: string; patch: WorkstreamUpdatePatch }
  | { kind: "workstream.archive"; workstreamId: string }
  | { kind: "inbox.draft.delete"; draftId: string }
  | { kind: "inbox.publish"; draftId: string }
  | { kind: "inbox.approve"; proposalId: string }
  | { kind: "inbox.reject"; proposalId: string; rationale: string }
  | { kind: "inbox.withdraw"; proposalId: string; rationale?: string }
  | {
      kind: "inbox.repair";
      proposalId: string;
      replacement: InboxDraftInput<TWikiOperationPlan>;
    }
  | { kind: "relay.draft.delete"; draftId: string }
  | { kind: "relay.publish"; draftId: string }
  | { kind: "relay.acknowledge"; relayId: string }
  | { kind: "relay.close"; relayId: string }
  | {
      kind: "playbook.update";
      playbookId: string;
      patch: Partial<
        Omit<
          Playbook,
          keyof TeamArtifactBase<"playbook"> | "entityRevision"
        >
      >;
    }
  | { kind: "playbook.archive"; playbookId: string }
  | { kind: "playbook.run.start"; playbook: EntityRef; workstream: EntityRef }
  | { kind: "playbook.run.complete-step"; runId: string; stepId: string };

export type TeamWorkflowAction<TWikiOperationPlan> =
  | TeamWorkflowCreateAction<TWikiOperationPlan>
  | TeamWorkflowRevisionBoundAction<TWikiOperationPlan>;

export type NonEmptyRevisionExpectations = readonly [
  RevisionExpectation,
  ...RevisionExpectation[],
];

interface TeamWorkflowCommandBase {
  /**
   * Globally unique caller-generated ID. Exact replay and altered-reuse
   * rejection are retained for the bounded 256-operation local journal
   * window; callers must never intentionally recycle an older ID.
   */
  operationId: string;
  /** Service-owned authority must never be accepted at the caller boundary. */
  actor?: never;
  occurredAt?: never;
  repoState?: never;
}

/**
 * Existing-target actions cannot be previewed without optimistic preconditions.
 * Implementations must also prove that every existing target touched by the
 * action is covered; an unrelated expectation does not satisfy this contract.
 */
export type TeamWorkflowCommand<TWikiOperationPlan> =
  | (TeamWorkflowCommandBase & {
      action: TeamWorkflowCreateAction<TWikiOperationPlan>;
      expectedRevisions: readonly RevisionExpectation[];
    })
  | (TeamWorkflowCommandBase & {
      action: TeamWorkflowRevisionBoundAction<TWikiOperationPlan>;
      expectedRevisions: NonEmptyRevisionExpectations;
    });

type TeamIdentityActivityMemberAddAction = Omit<
  Extract<TeamWorkflowCreateAction<never>, { kind: "member.add" }>,
  "member"
> & {
  member: Omit<
    Extract<TeamWorkflowCreateAction<never>, { kind: "member.add" }>["member"],
    "active"
  > & {
    /** C members always begin active; callers must use member.deactivate later. */
    active?: never;
  };
};

export type TeamIdentityActivityCreateAction =
  | TeamIdentityActivityMemberAddAction
  | Extract<TeamWorkflowCreateAction<never>, { kind: "activity.record" }>;

export type TeamIdentityActivityRevisionBoundAction = Extract<
  TeamWorkflowRevisionBoundAction<never>,
  { kind: "member.update" | "member.deactivate" | "member.select" | "member.clear" }
>;

export type TeamIdentityActivityAction =
  | TeamIdentityActivityCreateAction
  | TeamIdentityActivityRevisionBoundAction;

export type TeamIdentityActivityCommand =
  | (TeamWorkflowCommandBase & {
      action: TeamIdentityActivityCreateAction;
      expectedRevisions: readonly RevisionExpectation[];
    })
  | (TeamWorkflowCommandBase & {
      action: TeamIdentityActivityRevisionBoundAction;
      expectedRevisions: NonEmptyRevisionExpectations;
    });

export type TeamWorkstreamCreateAction = Extract<
  TeamWorkflowCreateAction<never>,
  { kind: "workstream.create" }
>;

export type TeamWorkstreamRevisionBoundAction =
  | {
      kind: "workstream.update";
      workstreamId: string;
      patch: Omit<WorkstreamUpdatePatch, "state"> & {
        state?: Exclude<WorkstreamState, "archived">;
      };
    }
  | Extract<
      TeamWorkflowRevisionBoundAction<never>,
      { kind: "workstream.archive" }
    >;

export type TeamWorkstreamAction =
  | TeamWorkstreamCreateAction
  | TeamWorkstreamRevisionBoundAction;

/** Portable caller boundary restricted to Checkpoint D Workstream actions. */
export type TeamWorkstreamCommand =
  | (TeamWorkflowCommandBase & {
      action: TeamWorkstreamCreateAction;
      expectedRevisions: readonly RevisionExpectation[];
    })
  | (TeamWorkflowCommandBase & {
      action: TeamWorkstreamRevisionBoundAction;
      expectedRevisions: NonEmptyRevisionExpectations;
    });

/** Authority captured by the service while preparing an exact preview. */
export interface TeamWorkflowAuthority {
  actor: ActorRef;
  occurredAt: string;
  repoState: RepoState;
}

/** Caller intent bound to service-owned identity, time, and repository state. */
export type PreparedTeamWorkflowCommand<TWikiOperationPlan> =
  TeamWorkflowCommand<TWikiOperationPlan> & {
    authority: TeamWorkflowAuthority;
  };

export interface TeamWorkflowPreview<TWikiOperationPlan> {
  operationId: string;
  previewRevision: Revision;
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  diagnostics: readonly Diagnostic[];
  /** Exact prepared command that apply must bind and revalidate. */
  command: PreparedTeamWorkflowCommand<TWikiOperationPlan>;
}

export interface TeamIdentityActivityPublicPreview {
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  diagnostics: readonly Diagnostic[];
}

export interface TeamIdentityActivityPurposeId {
  purpose: "activity" | "member";
  id: string;
}

export interface TeamIdentityActivityReceipt {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamIdentityActivityPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

/** One portable, human-readable preview and the metadata that binds it. */
export interface TeamIdentityActivityPreviewEnvelope {
  schemaVersion: 1;
  request: TeamIdentityActivityCommand;
  preview: TeamIdentityActivityPublicPreview;
  receipt: TeamIdentityActivityReceipt;
}

export interface TeamWorkstreamPurposeId {
  purpose: "activity" | "workstream";
  id: string;
}

export interface TeamWorkstreamReceipt {
  schemaVersion: 1;
  authority: TeamWorkflowAuthority;
  purposeIds: readonly TeamWorkstreamPurposeId[];
  requestRevision: Revision;
  presentationRevision: Revision;
  previewRevision: Revision;
}

/** Signed exact preview that remains portable across service processes. */
export interface TeamWorkstreamPreviewEnvelope {
  schemaVersion: 1;
  request: TeamWorkstreamCommand;
  preview: TeamIdentityActivityPublicPreview;
  receipt: TeamWorkstreamReceipt;
}

export interface TeamWorkflowApplyRequest<TWikiOperationPlan> {
  command: PreparedTeamWorkflowCommand<TWikiOperationPlan>;
  expectedPreviewRevision: Revision;
}

/** Applies only successful commands; validation/conflict failures throw. */
export interface TeamWorkflowResult<TWikiOperationPlan> {
  operationId: string;
  previewRevision: Revision;
  applied: true;
  idempotentReplay: boolean;
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  artifacts: readonly TeamArtifact<TWikiOperationPlan>[];
  events: readonly ActivityEvent[];
}

export interface ActorResolutionRequest {
  configuredMemberId?: string;
  gitIdentity?: MemberGitAlias;
}

/**
 * Portable proposal shape. It contains declarative Wiki intent and immutable
 * preconditions only; executable plans, process handles, actor, and time are
 * deliberately absent.
 */
export interface PortableWikiOperation<TWikiOperationPlan> {
  opId: string;
  type: WikiOperationType;
  entityId?: string;
  baseRevision?: number;
  baseContentHash?: Revision;
  reason?: string;
  payload: TWikiOperationPlan;
  actor?: never;
  timestamp?: never;
  plan?: never;
  handle?: never;
}

export interface PortableWikiOperationRequest<TWikiOperationPlan> {
  operation: PortableWikiOperation<TWikiOperationPlan>;
  expectedRevisions: readonly WikiRevisionExpectation[];
}

/** Typed facade for members, Workstreams, Inbox, Relays, and Playbooks. */
export interface TeamWorkflowPort<TWikiOperationPlan> {
  /** Resolve configured-member/Git identity from service-owned configuration. */
  resolveActor(): Promise<ActorRef>;
  getArtifact(ref: EntityRef): Promise<TeamArtifact<TWikiOperationPlan> | null>;
  listArtifacts(
    request?: TeamArtifactListRequest,
  ): Promise<TeamPage<TeamArtifact<TWikiOperationPlan>>>;
  getLocalDraft(id: string): Promise<LocalDraft<TWikiOperationPlan> | null>;
  listLocalDrafts(
    request?: LocalDraftListRequest,
  ): Promise<TeamPage<LocalDraft<TWikiOperationPlan>>>;
  preview(
    command: TeamWorkflowCommand<TWikiOperationPlan>,
  ): Promise<TeamWorkflowPreview<TWikiOperationPlan>>;
  apply(
    request: TeamWorkflowApplyRequest<TWikiOperationPlan>,
  ): Promise<TeamWorkflowResult<TWikiOperationPlan>>;
}

// Compatibility re-exports keep existing internal imports stable while the
// future aggregation seam lives in its own module.
export type {
  CatchUpCursor,
  CatchUpDigest,
  CatchUpGroup,
  CatchUpItem,
  CatchUpPort,
  CatchUpRequest,
} from "./catch-up.js";
