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

export const TEAM_READ_LIMITS = {
  defaultPageSize: 50,
  maxPageSize: 100,
  maxActivityMetadataEntries: 32,
  maxActivityMetadataBytes: 8 * 1024,
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
  plan: TWikiOperationPlan;
  targetRevisions: readonly RevisionExpectation[];
  reviewer?: ActorRef;
  reviewRationale?: string;
  reviewedAt?: string;
}

export interface Relay extends TeamArtifactBase<"relay"> {
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
  plan: TWikiOperationPlan;
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
  namespace: "inbox-draft" | "relay-draft" | "cursor";
  id: string;
  beforeRevision: Revision | null;
  afterRevision: Revision | null;
  summary: string;
}

export interface ActivityEvent {
  schemaVersion: 1;
  id: string;
  timestamp: string;
  actor: ActorRef;
  action: string;
  subjects: readonly EntityRef[];
  workstream?: EntityRef;
  repoState: RepoState;
  metadata?: Readonly<Record<string, JsonValue>>;
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
  plan: TWikiOperationPlan;
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
      playbook: Omit<Playbook, keyof TeamArtifactBase<"playbook"> | "state">;
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
      patch: { displayName?: string; gitAliases?: readonly MemberGitAlias[]; active?: boolean };
    }
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
      patch: Partial<Omit<Playbook, keyof TeamArtifactBase<"playbook">>>;
    }
  | { kind: "playbook.archive"; playbookId: string }
  | { kind: "playbook.run.start"; playbook: EntityRef; workstream: EntityRef }
  | { kind: "playbook.run.complete-step"; runId: string; stepId: string }
  /** Adapter records the current repository state; callers cannot forge HEAD/time. */
  | { kind: "catch-up.mark" };

export type TeamWorkflowAction<TWikiOperationPlan> =
  | TeamWorkflowCreateAction<TWikiOperationPlan>
  | TeamWorkflowRevisionBoundAction<TWikiOperationPlan>;

export type NonEmptyRevisionExpectations = readonly [
  RevisionExpectation,
  ...RevisionExpectation[],
];

interface TeamWorkflowCommandBase {
  operationId: string;
  actor: ActorRef;
  occurredAt: string;
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

export interface TeamWorkflowPreview {
  operationId: string;
  previewRevision: Revision;
  valid: boolean;
  scope: "canonical" | "local" | "mixed";
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  diagnostics: readonly Diagnostic[];
}

export interface TeamWorkflowApplyRequest<TWikiOperationPlan> {
  command: TeamWorkflowCommand<TWikiOperationPlan>;
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

export type CatchUpGroup =
  | "needs_attention"
  | "workstreams"
  | "relays"
  | "knowledge_specs"
  | "code_changes"
  | "health";

export interface CatchUpItem {
  id: string;
  group: CatchUpGroup;
  occurredAt: string;
  title: string;
  summary: string;
  actor?: ActorRef;
  subjects: readonly EntityRef[];
}

export interface CatchUpRequest extends PageRequest {
  since?: string;
  workstreamId?: string;
  actor?: ActorRef;
}

export interface CatchUpDigest {
  baseline: string | null;
  repoState: RepoState;
  items: readonly CatchUpItem[];
  nextCursor: string | null;
  truncated: boolean;
  deterministicRevision: Revision;
}

export interface CatchUpCursor {
  scaffoldId: string;
  actor: ActorRef;
  head: string | null;
  timestamp: string;
  revision: Revision;
}

export interface ActorResolutionRequest {
  configuredMemberId?: string;
  gitIdentity?: MemberGitAlias;
}

/** Typed facade for members, Workstreams, Inbox, Relays, Catch Up, and Playbooks. */
export interface TeamWorkflowPort<TWikiOperationPlan> {
  resolveActor(request: ActorResolutionRequest): Promise<ActorRef>;
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
  ): Promise<TeamWorkflowPreview>;
  apply(
    request: TeamWorkflowApplyRequest<TWikiOperationPlan>,
  ): Promise<TeamWorkflowResult<TWikiOperationPlan>>;
  catchUp(request?: CatchUpRequest): Promise<CatchUpDigest>;
  getCatchUpCursor(actor: ActorRef): Promise<CatchUpCursor | null>;
}
