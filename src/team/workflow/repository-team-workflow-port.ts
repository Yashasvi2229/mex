import { createHash, randomBytes } from "node:crypto";
import {
  createRepositoryWikiPort,
  type RepositoryWikiOperationPayload,
  type RepositoryWikiOperationPlan,
} from "../../wiki/application-adapter.js";
import type { GitPort } from "../contracts/git.js";
import type {
  ActorRef,
  Diagnostic,
  EntityRef,
  FileChange,
  JsonValue,
  RepoRelativePath,
  RepoState,
  Revision,
  RevisionExpectation,
} from "../contracts/shared.js";
import { isRevision, MexPortError } from "../contracts/shared.js";
import type {
  ActivityEvent,
  InboxDraft,
  InboxDraftInput,
  InboxProposal,
  LocalDraft,
  LocalDraftListRequest,
  LocalStateChange,
  Playbook,
  PlaybookRun,
  PreparedTeamWorkflowCommand,
  Relay,
  RelayDraft,
  RelayDraftInput,
  TeamArtifact,
  TeamArtifactKind,
  TeamArtifactListRequest,
  TeamArtifactState,
  TeamPage,
  TeamWorkflowAction,
  TeamWorkflowApplyRequest,
  TeamWorkflowCommand,
  TeamWorkflowPort,
  TeamWorkflowPreview,
  TeamWorkflowResult,
  Workstream,
} from "../contracts/workflow.js";
import { TEAM_READ_LIMITS } from "../contracts/workflow.js";
import type {
  WikiOperationActor,
  WikiOperationPreview,
  WikiOperationRecoveryInspection,
  WikiOperationRecoveryManifest,
  WikiOperationRequest,
  WikiOperationResult,
  WikiPort,
  WikiRevisionExpectation,
} from "../contracts/wiki.js";
import {
  ActivityRepository,
  type ActivityCreatePreview,
  type PreparedActivityPublication,
} from "../activity/repository.js";
import {
  ACTIVITY_ARTIFACT_MAX_BYTES,
  memberArtifactPath,
} from "../artifacts/codecs.js";
import { artifactError } from "../artifacts/errors.js";
import { readContainedArtifact, tryReadContainedArtifact } from "../artifacts/filesystem.js";
import { revisionOf } from "../artifacts/revision.js";
import { generateArtifactId } from "../artifacts/ulid.js";
import {
  InboxProposalRepository,
  PlaybookRepository,
  PlaybookRunRepository,
  RelayRepository,
  WorkstreamRepository,
  type WorkflowArtifactWritePlan,
  type WorkflowRepositoryPage,
} from "../artifacts/workflow-repositories.js";
import {
  inboxProposalArtifactPath,
  normalizeInboxDraftInput,
  normalizeRelayDraftInput,
  normalizeWorkflowRevisionExpectations,
  playbookArtifactPath,
  playbookRunArtifactPath,
  relayArtifactPath,
  workstreamArtifactPath,
} from "../artifacts/workflow-codecs.js";
import { createRepositoryGitPort } from "../git/git-port.js";
import { ActorResolver } from "../identity/actor-resolver.js";
import {
  MemberRepository,
  type MemberWritePlan,
} from "../identity/member-repository.js";
import {
  TEAM_LOCAL_STATE_LIMITS,
  TeamLocalState,
  normalizeTeamWorkflowJournalEffects,
  type ActivityWorkflowEffect,
  type CanonicalWorkflowEffect,
  type HubLeaseProcessStatus,
  type LocalCleanupWorkflowEffect,
  type LocalWorkflowEffect,
  type StoredLocalDraft,
  type TeamWorkflowJournalEffect,
  type TeamWorkflowJournalEntry,
  type WikiRecoveryWorkflowEffect,
} from "../local-state/index.js";
import { RepositoryRootGuard } from "./repository-root.js";

const MAX_ISSUED_PREVIEWS = 256;
const MAX_CURSOR_BYTES = 4 * 1024;
const MAX_WIKI_RECOVERY_FILE_BYTES = 8 * 1024 * 1024;
const MAX_WIKI_OPERATION_LOG_BYTES = 2 * 1024 * 1024;
const MAX_PREPARED_COMMAND_BYTES = 256 * 1024;
const MAX_PREPARED_COMMAND_DEPTH = 32;
const MAX_PREPARED_COMMAND_NODES = 8_192;
const OPERATION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

const ARTIFACT_KIND_ORDER = [
  "member",
  "workstream",
  "proposal",
  "relay",
  "playbook",
  "playbook_run",
] as const satisfies readonly TeamArtifactKind[];

const ARTIFACT_STATES = new Set<string>([
  "planned", "active", "blocked", "done", "archived",
  "pending", "approved", "rejected", "withdrawn", "stale",
  "published", "acknowledged", "closed", "completed",
]);

export type TeamWorkflowPhaseBoundary =
  | "before-canonical-publication"
  | "after-canonical-publication"
  | "after-activity-publication"
  | "after-local-cleanup";

export interface RepositoryTeamWorkflowPortOptions<
  TWikiPayload extends JsonValue,
  TWikiPlan = unknown,
> {
  scaffoldId: string;
  wiki: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>;
  git?: GitPort;
  now?: () => Date;
  pid?: number;
  processStatus?: (pid: number) => HubLeaseProcessStatus;
  phaseHook?: (boundary: TeamWorkflowPhaseBoundary) => void | Promise<void>;
  idFactories?: {
    member?: () => string;
    workstream?: () => string;
    proposal?: () => string;
    relay?: () => string;
    playbook?: () => string;
    playbookRun?: () => string;
    activity?: (timestampMs: number) => string;
    localDraft?: (kind: "inbox" | "relay") => string;
    leaseToken?: () => string;
  };
}

interface PreparedOperation<TWikiPayload extends JsonValue, TWikiPlan> {
  callerCommandRevision: Revision;
  commandRevision: Revision;
  preview: TeamWorkflowPreview<TWikiPayload>;
  effects: readonly TeamWorkflowJournalEffect[];
  activity: ActivityCreatePreview | null;
  applyPrimary(): Promise<PrimaryResult<TWikiPayload>>;
  cleanup: readonly LocalCleanupWorkflowEffect[];
  wiki?: {
    request: WikiOperationRequest<TWikiPayload>;
    preview: WikiOperationPreview<TWikiPlan>;
  };
}

interface PrimaryResult<TWikiPayload extends JsonValue> {
  artifacts: readonly TeamArtifact<TWikiPayload>[];
  changes: readonly FileChange[];
  localChanges: readonly LocalStateChange[];
  wikiResult?: WikiOperationResult;
}

interface RecoverableWikiPort<TWikiPayload extends JsonValue, TWikiPlan>
  extends WikiPort<unknown, TWikiPayload, TWikiPlan, unknown> {
  inspectOperationRecovery(
    request: WikiOperationRequest<TWikiPayload>,
  ): WikiOperationRecoveryInspection;
  resumeOperations(
    request: WikiOperationRequest<TWikiPayload>,
    manifest: WikiOperationRecoveryManifest,
  ): Promise<WikiOperationPreview<TWikiPlan>>;
}

interface WikiRecoveryContext<TWikiPayload extends JsonValue, TWikiPlan> {
  port: RecoverableWikiPort<TWikiPayload, TWikiPlan>;
  request: WikiOperationRequest<TWikiPayload>;
  manifest: WikiOperationRecoveryManifest;
  inspection: WikiOperationRecoveryInspection;
}

interface ArtifactCursor {
  v: 1;
  kindIndex: number;
  innerCursor: string | null;
  memberOffset: number;
  corpusRevision: Revision;
  filterRevision: Revision;
}

/** Internal repository-bound implementation; intentionally absent from package-root exports. */
export class RepositoryTeamWorkflowPort<
  TWikiPayload extends JsonValue,
  TWikiPlan = unknown,
> implements TeamWorkflowPort<TWikiPayload> {
  readonly #root: RepositoryRootGuard;
  readonly #git: GitPort;
  readonly #wiki: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>;
  readonly #now: () => Date;
  readonly #pid: number;
  readonly #phaseHook: (boundary: TeamWorkflowPhaseBoundary) => void | Promise<void>;
  readonly #members: MemberRepository;
  readonly #workstreams: WorkstreamRepository;
  readonly #proposals: InboxProposalRepository<TWikiPayload>;
  readonly #relays: RelayRepository;
  readonly #playbooks: PlaybookRepository;
  readonly #runs: PlaybookRunRepository;
  readonly #local: TeamLocalState;
  readonly #actors: ActorResolver;
  readonly #activity: ActivityRepository;
  readonly #localDraftId: (kind: "inbox" | "relay") => string;
  readonly #leaseToken: () => string;
  readonly #issued = new Map<Revision, PreparedOperation<TWikiPayload, TWikiPlan>>();
  readonly #issuedByCommand = new Map<Revision, Revision>();
  #heldLeaseToken: string | null = null;

  constructor(
    projectRoot: string,
    options: RepositoryTeamWorkflowPortOptions<TWikiPayload, TWikiPlan>,
  ) {
    this.#root = new RepositoryRootGuard(projectRoot);
    this.#git = options.git ?? createRepositoryGitPort(this.#root.path, { now: options.now });
    this.#wiki = options.wiki;
    this.#now = options.now ?? (() => new Date());
    this.#pid = options.pid ?? process.pid;
    this.#phaseHook = options.phaseHook ?? (() => undefined);
    this.#members = new MemberRepository(this.#root.path, {
      ...(options.idFactories?.member === undefined ? {} : { idFactory: options.idFactories.member }),
    });
    this.#workstreams = new WorkstreamRepository(this.#root.path, {
      ...(options.idFactories?.workstream === undefined ? {} : { idFactory: options.idFactories.workstream }),
    });
    this.#proposals = new InboxProposalRepository<TWikiPayload>(this.#root.path, {
      ...(options.idFactories?.proposal === undefined ? {} : { idFactory: options.idFactories.proposal }),
    });
    this.#relays = new RelayRepository(this.#root.path, {
      ...(options.idFactories?.relay === undefined ? {} : { idFactory: options.idFactories.relay }),
    });
    this.#playbooks = new PlaybookRepository(this.#root.path, {
      ...(options.idFactories?.playbook === undefined ? {} : { idFactory: options.idFactories.playbook }),
    });
    this.#runs = new PlaybookRunRepository(this.#root.path, {
      ...(options.idFactories?.playbookRun === undefined ? {} : { idFactory: options.idFactories.playbookRun }),
    });
    this.#local = new TeamLocalState({
      projectRoot: this.#root.path,
      scaffoldId: options.scaffoldId,
      now: () => this.#nowIso(),
      ...(options.processStatus === undefined ? {} : { processStatus: options.processStatus }),
    });
    this.#actors = new ActorResolver(this.#members, this.#git);
    this.#activity = new ActivityRepository({
      projectRoot: this.#root.path,
      git: this.#git,
      now: this.#now,
      ...(options.idFactories?.activity === undefined
        ? {}
        : { generateId: options.idFactories.activity }),
    });
    this.#localDraftId = options.idFactories?.localDraft
      ?? ((kind) => `${kind}_${randomBytes(16).toString("hex")}`);
    this.#leaseToken = options.idFactories?.leaseToken
      ?? (() => randomBytes(32).toString("hex"));
  }

  async resolveActor(): Promise<ActorRef> {
    this.#root.assertCurrent();
    const configured = this.#local.getConfiguredMember();
    return this.#actors.resolve(configured === null ? {} : { configuredMemberId: configured.memberId });
  }

  async getArtifact(ref: EntityRef): Promise<TeamArtifact<TWikiPayload> | null> {
    this.#root.assertCurrent();
    switch (ref.kind) {
      case "member": return this.#members.get(ref.id);
      case "workstream": return this.#workstreams.get(ref.id);
      case "proposal": return this.#proposals.get(ref.id);
      case "relay": return this.#relays.get(ref.id);
      case "playbook": return this.#playbooks.get(ref.id);
      case "playbook_run": return this.#runs.get(ref.id);
      default: return null;
    }
  }

  async listArtifacts(
    request: TeamArtifactListRequest = {},
  ): Promise<TeamPage<TeamArtifact<TWikiPayload>>> {
    this.#root.assertCurrent();
    return this.#listArtifacts(request);
  }

  async getLocalDraft(id: string): Promise<LocalDraft<TWikiPayload> | null> {
    this.#root.assertCurrent();
    const stored = this.#local.getLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput>(id);
    return stored === null ? null : localDraftProjection(stored);
  }

  async listLocalDrafts(
    request: LocalDraftListRequest = {},
  ): Promise<TeamPage<LocalDraft<TWikiPayload>>> {
    this.#root.assertCurrent();
    if (request.kind !== undefined && request.kind !== "inbox" && request.kind !== "relay") {
      throw invalidLocalDraftList();
    }
    if (
      request.cursor !== undefined
      && (typeof request.cursor !== "string"
        || Buffer.byteLength(request.cursor, "utf8") > MAX_CURSOR_BYTES)
    ) {
      throw invalidLocalDraftList();
    }
    const limit = normalizeLimit(request.limit);
    let page;
    try {
      page = this.#local.listLocalDrafts<InboxDraftInput<TWikiPayload> | RelayDraftInput>({
        ...(request.kind === undefined ? {} : { kind: request.kind }),
        ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
        limit,
      });
    } catch (error) {
      if (error instanceof MexPortError && error.problem.code === "VALIDATION_FAILED") {
        throw invalidLocalDraftList();
      }
      throw error;
    }
    const items = page.items.map(localDraftProjection);
    return {
      items,
      nextCursor: page.nextCursor,
      truncated: page.truncated,
      sourceTruncated: false,
      deterministicRevision: revisionOf(stableJson(items.map((item) => ({
        id: item.id,
        kind: item.kind,
        revision: item.revision,
      })))),
      diagnostics: [],
    };
  }

  async preview(
    command: TeamWorkflowCommand<TWikiPayload>,
  ): Promise<TeamWorkflowPreview<TWikiPayload>> {
    this.#root.assertCurrent();
    assertCommandShape(command);
    assertOperationId(command.operationId);
    assertNoCallerAuthority(command);
    boundedStableJson(command);
    const callerCommand = cloneCommand(command);
    callerCommand.expectedRevisions = normalizeWorkflowRevisionExpectations(
      command.expectedRevisions,
    ) as typeof callerCommand.expectedRevisions;
    const commandRevision = hashText(boundedStableJson(callerCommand));
    const cachedRevision = this.#issuedByCommand.get(commandRevision);
    const cached = cachedRevision === undefined
      ? undefined
      : this.#issued.get(cachedRevision);
    if (cached !== undefined) {
      await this.#assertAuthorityCurrent(cached.preview.command.authority);
      return cached.preview;
    }
    const actor = await this.resolveActor();
    const occurredAt = this.#nowIso();
    const repoState = await this.#git.getRepoState();
    const preparedCommand = deepFreeze({
      ...callerCommand,
      authority: { actor, occurredAt, repoState },
    }) as PreparedTeamWorkflowCommand<TWikiPayload>;
    const prepared = await this.#plan(preparedCommand, commandRevision);
    this.#issued.set(prepared.preview.previewRevision, prepared);
    this.#issuedByCommand.set(commandRevision, prepared.preview.previewRevision);
    if (this.#issued.size > MAX_ISSUED_PREVIEWS) {
      const oldest = this.#issued.keys().next().value as Revision | undefined;
      if (oldest !== undefined) {
        const removed = this.#issued.get(oldest);
        this.#issued.delete(oldest);
        if (removed !== undefined) {
          this.#issuedByCommand.delete(removed.callerCommandRevision);
        }
      }
    }
    return prepared.preview;
  }

  async apply(
    request: TeamWorkflowApplyRequest<TWikiPayload>,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    this.#root.assertCurrent();
    if (!isPlainObject(request)) invalidApplyRequest();
    exactObjectKeys(request, ["command", "expectedPreviewRevision"]);
    if (!isRevision(request.expectedPreviewRevision)) throw previewConflict();
    assertPreparedCommandShape(request.command);
    const serializedCommand = boundedStableJson(request.command);
    const commandRevision = hashText(serializedCommand);
    let requiresMigration = false;
    let existing: TeamWorkflowJournalEntry | null;
    try {
      existing = this.#local.getWorkflowOperation(request.command.operationId);
    } catch (error) {
      if (!(error instanceof MexPortError)) {
        throw error;
      }
      if (error.problem.code === "MIGRATION_REQUIRED") {
        requiresMigration = true;
        existing = null;
      } else if (error.problem.code === "OPERATION_INTERRUPTED") {
        // This is an explicit write request, so opening the database writable
        // may complete SQLite's own rollback-journal recovery. Re-read the
        // operation only after that bounded recovery; immutable reads never do
        // this and continue to fail closed on every sidecar.
        this.#local.initializeForMutation();
        existing = this.#local.getWorkflowOperation(request.command.operationId);
      } else {
        throw error;
      }
    }
    if (existing !== null) {
      if (
        existing.commandRevision !== commandRevision
        || existing.previewRevision !== request.expectedPreviewRevision
      ) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Workflow operation replay changed",
          "The operation ID is bound to a different prepared command or preview.",
        );
      }
      return this.#recoverExisting(existing, request.command);
    }

    const prepared = this.#issued.get(request.expectedPreviewRevision);
    if (
      prepared === undefined
      || prepared.preview.previewRevision !== request.expectedPreviewRevision
      || stableJson(prepared.preview.command) !== stableJson(request.command)
    ) {
      throw previewConflict();
    }
    // First pass is immutable, so already-stale or escaping inputs fail with
    // byte-identical project/local state. The same pass is repeated while the
    // Team writer lease is held to close the inter-port race.
    await this.#preflightPrepared(prepared, false);
    // Apply is the first caller-authorized local write. Preview and every read
    // above remain immutable, including against legacy v1-v3 databases.
    if (requiresMigration || existing === null) this.#local.initializeForMutation();
    const leaseToken = this.#acquireLease();
    let activityPublication: PreparedActivityPublication | null;
    try {
      activityPublication = await this.#preflightPrepared(prepared, true);
    } catch (error) {
      this.#local.releaseTeamWorkflowLease(leaseToken);
      this.#heldLeaseToken = null;
      throw error;
    }
    let journal: TeamWorkflowJournalEntry;
    try {
      journal = this.#local.beginWorkflowOperation({
        leaseToken,
        operationId: request.command.operationId,
        commandRevision: prepared.commandRevision,
        previewRevision: prepared.preview.previewRevision,
        effects: prepared.effects,
      }).entry;
    } catch (error) {
      if (this.#local.getIncompleteWorkflowOperation() === null) {
        this.#local.releaseTeamWorkflowLease(leaseToken);
        this.#heldLeaseToken = null;
      }
      throw error;
    }
    let primaryReturned = false;
    try {
      await this.#runPhaseHook("before-canonical-publication");
      this.#root.assertCurrent();
      const primary = await prepared.applyPrimary();
      primaryReturned = true;
      await this.#runPhaseHook("after-canonical-publication");
      await this.#assertPostPrimaryRepository(prepared.preview.command.authority.repoState);
      const event = activityPublication === null ? null : activityPublication.publish();
      await this.#runPhaseHook("after-activity-publication");
      journal = this.#advanceJournal(journal, leaseToken, "canonical_published");
      journal = this.#advanceJournal(
        journal,
        leaseToken,
        "local_finalized",
        prepared.cleanup.map((effect) => ({
          kind: effect.draftKind,
          id: effect.draftId,
          expectedRevision: effect.expectedRevision,
        })),
      );
      await this.#runPhaseHook("after-local-cleanup");
      journal = this.#advanceJournal(journal, leaseToken, "complete");
      this.#local.releaseTeamWorkflowLease(leaseToken);
      this.#heldLeaseToken = null;
      this.#issued.delete(request.expectedPreviewRevision);
      this.#issuedByCommand.delete(prepared.callerCommandRevision);
      return {
        operationId: request.command.operationId,
        previewRevision: request.expectedPreviewRevision,
        applied: true,
        idempotentReplay: false,
        changes: prepared.preview.changes,
        localChanges: prepared.preview.localChanges,
        artifacts: primary.artifacts,
        events: event === null ? [] : [event],
      };
    } catch (error) {
      // A simulated/process interruption deliberately leaves the durable lease
      // and journal in place. A new instance must prove every effect on replay.
      if (error instanceof WorkflowPhaseInterruption) throw error;
      try {
        const current = this.#local.getWorkflowOperation(journal.operationId);
        let mayAbandon = current?.phase === "intent"
          && prepared.wiki === undefined
          && !primaryReturned;
        const recovery = current?.effects.find(
          (effect): effect is WikiRecoveryWorkflowEffect => effect.kind === "wiki_recovery",
        );
        if (current?.phase === "intent" && prepared.wiki !== undefined && recovery !== undefined) {
          const port = asRecoverableWikiPort(this.#wiki);
          if (port !== null) {
            mayAbandon = port.inspectOperationRecovery(prepared.wiki.request).state === "none";
          }
        } else if (current?.phase === "intent" && prepared.wiki === undefined) {
          mayAbandon = !primaryReturned || !this.#anyPrimaryEffectPublished(current.effects);
        } else if (current?.phase === "intent" && recovery === undefined) {
          mayAbandon = !this.#anyPrimaryEffectPublished(current.effects);
        }
        if (
          current?.phase === "intent"
          && mayAbandon
        ) {
          this.#local.abandonWorkflowOperation({
            leaseToken,
            operationId: current.operationId,
            commandRevision: current.commandRevision,
            previewRevision: current.previewRevision,
            expectedRevision: current.revision,
          });
          this.#local.releaseTeamWorkflowLease(leaseToken);
          this.#heldLeaseToken = null;
        }
      } catch {
        // Preserve the original actionable error and the durable recovery state.
      }
      throw error;
    }
  }

  async #plan(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    callerCommandRevision: Revision,
  ): Promise<PreparedOperation<TWikiPayload, TWikiPlan>> {
    const planned = await this.#planPrimary(command);
    if (planned.wiki?.preview.recoveryManifest !== undefined) {
      assertWikiRecoveryManifestMatchesChanges(
        planned.wiki.preview.recoveryManifest,
        planned.wiki.preview.changes,
      );
    }
    const activity = planned.activityInput === null
      ? null
      : await this.#activity.previewCreateWithAuthority({
          ...planned.activityInput,
          actor: command.authority.actor,
        }, {
          timestamp: command.authority.occurredAt,
          repoState: command.authority.repoState,
        });
    const changes = [
      ...planned.changes,
      ...(activity?.changes ?? []),
    ];
    const effects = normalizeTeamWorkflowJournalEffects([
      ...planned.effects,
      ...(planned.wiki?.preview.recoveryManifest === undefined
        ? []
        : [{
            kind: "wiki_recovery" as const,
            manifest: planned.wiki.preview.recoveryManifest,
          }]),
      ...(activity === null ? [] : [activityEffect(activity)]),
      ...planned.cleanup,
    ]);
    if (
      effects.length > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffects
      || Buffer.byteLength(stableJson(effects), "utf8") > TEAM_LOCAL_STATE_LIMITS.maxWorkflowEffectBytes
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Workflow recovery plan is too large",
        "The bounded workflow recovery plan exceeds its effect or byte limit.",
      );
    }
    const scope = changes.length === 0 ? "local"
      : planned.localChanges.length === 0 ? "canonical" : "mixed";
    const previewRevision = hashJson({
      v: 1,
      command,
      callerCommandRevision,
      changes,
      localChanges: planned.localChanges,
      innerRevisions: [...planned.innerRevisions, activity?.previewRevision ?? null],
    });
    const preview = deepFreeze({
      operationId: command.operationId,
      previewRevision,
      valid: true,
      scope,
      changes,
      localChanges: planned.localChanges,
      diagnostics: planned.diagnostics,
      command,
    }) satisfies TeamWorkflowPreview<TWikiPayload>;
    return {
      callerCommandRevision,
      commandRevision: hashJson(command),
      preview,
      effects,
      activity,
      applyPrimary: planned.applyPrimary,
      cleanup: planned.cleanup,
      ...(planned.wiki === undefined ? {} : { wiki: planned.wiki }),
    };
  }

  async #planPrimary(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    recoveryEffects?: readonly TeamWorkflowJournalEffect[],
  ): Promise<{
    changes: readonly FileChange[];
    localChanges: readonly LocalStateChange[];
    diagnostics: readonly Diagnostic[];
    effects: readonly (CanonicalWorkflowEffect | LocalWorkflowEffect)[];
    cleanup: readonly LocalCleanupWorkflowEffect[];
    innerRevisions: readonly (Revision | null)[];
    activityInput: Omit<Parameters<ActivityRepository["previewCreate"]>[0], "actor"> | null;
    applyPrimary(): Promise<PrimaryResult<TWikiPayload>>;
    wiki?: { request: WikiOperationRequest<TWikiPayload>; preview: WikiOperationPreview<TWikiPlan> };
  }> {
    const { action, expectedRevisions, authority } = command;
    switch (action.kind) {
      case "member.add": {
        const recoveryId = recoveryCanonicalId(recoveryEffects, "member");
        const plan = await this.#members.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          displayName: action.member.displayName,
          gitAliases: action.member.gitAliases,
          active: action.member.active ?? true,
        });
        return canonicalPlan<TWikiPayload>(plan, "member", plan.member.ref.id, {
          action: "member.added",
          subjects: [entitySubject(plan.member.ref)],
        }, async () => {
          const applied = await this.#members.apply(plan, plan.previewRevision);
          return primary([applied.member], [applied.change]);
        });
      }
      case "member.update": {
        const current = await required(this.#members.get(action.memberId), "Member");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const plan = await this.#members.previewUpdate(action.memberId, action.patch, current.revision);
        return canonicalPlan<TWikiPayload>(plan, "member", action.memberId, {
          action: "member.updated",
          subjects: [entitySubject(plan.member.ref)],
        }, async () => {
          const applied = await this.#members.apply(plan, plan.previewRevision);
          return primary([applied.member], [applied.change]);
        });
      }
      case "workstream.create": {
        const recoveryId = recoveryCanonicalId(recoveryEffects, "workstream");
        const plan = await this.#workstreams.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          ...action.workstream,
          contributors: action.workstream.contributors ?? [],
          paths: action.workstream.paths ?? [],
          code: action.workstream.code ?? [],
          topics: action.workstream.topics ?? [],
          components: action.workstream.components ?? [],
          related: action.workstream.related ?? [],
          blockers: [],
          currentState: "Planned",
          createdBy: authority.actor,
          createdAt: authority.occurredAt,
          updatedBy: authority.actor,
          updatedAt: authority.occurredAt,
        });
        return canonicalWorkflowPlan(plan, "workstream", plan.artifact.ref.id, {
          action: "workstream.created",
          subjects: [entitySubject(plan.artifact.ref)],
          workstream: plan.artifact.ref,
        }, this.#workstreams);
      }
      case "workstream.update":
      case "workstream.archive": {
        const current = await required(this.#workstreams.get(action.workstreamId), "Workstream");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const patch = action.kind === "workstream.archive" ? { state: "archived" as const } : action.patch;
        const plan = await this.#workstreams.previewUpdate(action.workstreamId, {
          ...withoutStored(current),
          ...patch,
          updatedBy: authority.actor,
          updatedAt: authority.occurredAt,
        }, current.revision);
        return canonicalWorkflowPlan(plan, "workstream", action.workstreamId, {
          action: action.kind === "workstream.archive" ? "workstream.archived" : "workstream.updated",
          subjects: [entitySubject(plan.artifact.ref)],
          workstream: plan.artifact.ref,
        }, this.#workstreams);
      }
      case "inbox.draft.save":
      case "relay.draft.save": {
        const kind = action.kind === "inbox.draft.save" ? "inbox" as const : "relay" as const;
        const normalizedDraft = action.kind === "inbox.draft.save"
          ? normalizeInboxDraftInput<TWikiPayload>(action.draft)
          : normalizeRelayDraftInput(action.draft);
        const draftId = action.draftId
          ?? recoveryLocalId(recoveryEffects, `${kind}-draft`)
          ?? this.#localDraftId(kind);
        const current = action.draftId === undefined
          ? null
          : this.#local.getLocalDraft(draftId);
        if (action.draftId !== undefined) {
          requireLocalExpectation(expectedRevisions, `${kind}-draft`, draftId, current?.revision ?? null);
        }
        const stored = this.#local.previewSaveLocalDraft({
          id: draftId,
          kind,
          payload: normalizedDraft,
          expectedRevision: current?.revision ?? null,
          updatedAt: authority.occurredAt,
        });
        const change = localChange(kind, draftId, current?.revision ?? null, stored.revision, "Save local draft");
        const effect: LocalWorkflowEffect = {
          kind: "local",
          namespace: `${kind}-draft`,
          id: draftId,
          beforeRevision: current?.revision ?? null,
          afterRevision: stored.revision,
        };
        return {
          changes: [], localChanges: [change], diagnostics: [], effects: [effect], cleanup: [],
          innerRevisions: [stored.revision], activityInput: null,
          applyPrimary: async () => {
            const applied = this.#local.saveLocalDraft({
              id: draftId,
              kind,
              payload: normalizedDraft,
              expectedRevision: current?.revision ?? null,
              updatedAt: authority.occurredAt,
            });
            return primary([], [], [localChange(kind, draftId, current?.revision ?? null, applied.revision, "Save local draft")]);
          },
        };
      }
      case "inbox.draft.delete":
      case "relay.draft.delete": {
        const kind = action.kind === "inbox.draft.delete" ? "inbox" as const : "relay" as const;
        const current = this.#local.previewDeleteLocalDraft({
          id: action.draftId,
          kind,
          expectedRevision: requiredLocalRevision(expectedRevisions, `${kind}-draft`, action.draftId),
        });
        const change = localChange(kind, action.draftId, current.revision, null, "Delete local draft");
        return {
          changes: [], localChanges: [change], diagnostics: [], cleanup: [],
          effects: [{ kind: "local", namespace: `${kind}-draft`, id: action.draftId, beforeRevision: current.revision, afterRevision: null }],
          innerRevisions: [current.revision], activityInput: null,
          applyPrimary: async () => {
            this.#local.deleteLocalDraft({ id: action.draftId, kind, expectedRevision: current.revision });
            return primary([], [], [change]);
          },
        };
      }
      case "inbox.publish": {
        const draft = requiredDraft<TWikiPayload>(this.#local.getLocalDraft(action.draftId), "inbox");
        requireLocalExpectation(expectedRevisions, "inbox-draft", action.draftId, draft.revision);
        const payload = draft.payload as InboxDraftInput<TWikiPayload>;
        const recoveryId = recoveryCanonicalId(recoveryEffects, "proposal");
        const plan = await this.#proposals.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          author: authority.actor,
          rationale: payload.rationale,
          evidence: payload.evidence,
          request: payload.request,
          targetRevisions: payload.targetRevisions,
        });
        return withCleanup(canonicalWorkflowPlan<TWikiPayload, typeof plan.artifact>(plan, "proposal", plan.artifact.ref.id, {
          action: "inbox.published",
          subjects: [entitySubject(plan.artifact.ref)],
        }, this.#proposals), "inbox", action.draftId, draft.revision);
      }
      case "relay.publish": {
        const draft = requiredDraft<TWikiPayload>(this.#local.getLocalDraft(action.draftId), "relay");
        requireLocalExpectation(expectedRevisions, "relay-draft", action.draftId, draft.revision);
        const payload = draft.payload as RelayDraftInput;
        await this.#requireWorkstreamDependency(payload.workstream, expectedRevisions);
        const recoveryId = recoveryCanonicalId(recoveryEffects, "relay");
        const plan = await this.#relays.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          ...payload,
          sender: authority.actor,
        });
        return withCleanup(canonicalWorkflowPlan<TWikiPayload, typeof plan.artifact>(plan, "relay", plan.artifact.ref.id, {
          action: "relay.published",
          subjects: [entitySubject(plan.artifact.ref)],
          workstream: payload.workstream,
        }, this.#relays), "relay", action.draftId, draft.revision);
      }
      case "relay.acknowledge":
      case "relay.close": {
        const current = await required(this.#relays.get(action.relayId), "Relay");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const plan = await this.#relays.previewUpdate(action.relayId, {
          ...withoutStored(current),
          ...(action.kind === "relay.acknowledge"
            ? { state: "acknowledged" as const, acknowledgedBy: authority.actor, acknowledgedAt: authority.occurredAt }
            : { state: "closed" as const, closedBy: authority.actor, closedAt: authority.occurredAt }),
        }, current.revision);
        return canonicalWorkflowPlan(plan, "relay", action.relayId, {
          action: action.kind === "relay.acknowledge" ? "relay.acknowledged" : "relay.closed",
          subjects: [entitySubject(plan.artifact.ref)],
          workstream: current.workstream,
        }, this.#relays);
      }
      case "playbook.create": {
        const recoveryId = recoveryCanonicalId(recoveryEffects, "playbook");
        const plan = await this.#playbooks.previewCreate({
          ...action.playbook,
          ...(recoveryId === null ? {} : { id: recoveryId }),
        });
        return canonicalWorkflowPlan(plan, "playbook", plan.artifact.ref.id, {
          action: "playbook.created", subjects: [entitySubject(plan.artifact.ref)],
        }, this.#playbooks);
      }
      case "playbook.update":
      case "playbook.archive": {
        const current = await required(this.#playbooks.get(action.playbookId), "Playbook");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const patch = action.kind === "playbook.archive" ? { state: "archived" as const } : action.patch;
        const plan = await this.#playbooks.previewUpdate(action.playbookId, {
          ...withoutStored(current), ...patch,
        }, current.revision);
        return canonicalWorkflowPlan(plan, "playbook", action.playbookId, {
          action: action.kind === "playbook.archive" ? "playbook.archived" : "playbook.updated",
          subjects: [entitySubject(plan.artifact.ref)],
        }, this.#playbooks);
      }
      case "playbook.run.start": {
        const playbook = await this.#requirePlaybookDependency(action.playbook, expectedRevisions);
        const workstream = await this.#requireWorkstreamDependency(action.workstream, expectedRevisions);
        const recoveryId = recoveryCanonicalId(recoveryEffects, "playbook-run");
        const plan = await this.#runs.previewCreate({
          ...(recoveryId === null ? {} : { id: recoveryId }),
          playbook: playbook.ref,
          workstream: workstream.ref,
          steps: playbook.steps.map((step) => ({ stepId: step.id })),
          startedBy: authority.actor,
          startedAt: authority.occurredAt,
        });
        return canonicalWorkflowPlan(plan, "playbook-run", plan.artifact.ref.id, {
          action: "playbook.run.started", subjects: [entitySubject(plan.artifact.ref)], workstream: workstream.ref,
        }, this.#runs);
      }
      case "playbook.run.complete-step": {
        const current = await required(this.#runs.get(action.runId), "Playbook run");
        requireArtifactExpectation(expectedRevisions, current.sourcePath, current.revision);
        const matched = current.steps.some((step) => step.stepId === action.stepId && step.completedBy === undefined);
        if (!matched) throw artifactError("VALIDATION_FAILED", "Invalid Playbook step", "The requested Playbook run step is missing or already complete.");
        const steps = current.steps.map((step) => step.stepId === action.stepId
          ? { ...step, completedBy: authority.actor, completedAt: authority.occurredAt }
          : step);
        const plan = await this.#runs.previewUpdate(action.runId, {
          ...withoutStored(current),
          steps,
          state: steps.every((step) => step.completedBy !== undefined) ? "completed" : "active",
        }, current.revision);
        return canonicalWorkflowPlan(plan, "playbook-run", action.runId, {
          action: "playbook.run.step-completed", subjects: [entitySubject(plan.artifact.ref)], workstream: current.workstream,
        }, this.#runs);
      }
      case "inbox.reject":
      case "inbox.withdraw":
      case "inbox.repair":
      case "inbox.approve":
        return this.#planProposalAction(command);
      default:
        return assertNever(action);
    }
  }

  async #planProposalAction(command: PreparedTeamWorkflowCommand<TWikiPayload>): Promise<any> {
    const action = command.action;
    if (!("proposalId" in action)) return assertNever(action as never);
    const current = await required(this.#proposals.get(action.proposalId), "Inbox proposal");
    requireArtifactExpectation(command.expectedRevisions, current.sourcePath, current.revision);
    if (action.kind === "inbox.approve") {
      await this.#assertExpectationsCurrent(current.targetRevisions);
      const wikiRequest = portableWikiRequest(current, command.authority.actor, command.authority.occurredAt);
      const wikiPreview = await this.#wiki.previewOperations(wikiRequest);
      if (!wikiPreview.valid) {
        throw artifactError("VALIDATION_FAILED", "Wiki proposal is not valid", "The Inbox proposal must be repaired and previewed again before approval.", current.sourcePath);
      }
      const plan = await this.#proposals.previewUpdate(current.ref.id, {
        ...withoutStored(current), state: "approved", reviewer: command.authority.actor,
        reviewedAt: command.authority.occurredAt,
      }, current.revision);
      const base = canonicalWorkflowPlan(plan, "proposal", current.ref.id, {
        action: "inbox.approved",
        subjects: [entitySubject(current.ref), ...wikiPreview.affectedEntities.map(entitySubject)],
      }, this.#proposals);
      const wikiEffects = wikiPreview.changes.map((change, index): CanonicalWorkflowEffect => ({
        kind: "canonical", namespace: "wiki", id: `${current.ref.id}:${index}`,
        path: change.path, beforeRevision: change.beforeRevision, afterRevision: change.afterRevision,
      }));
      return {
        ...base,
        changes: [...wikiPreview.changes, ...base.changes],
        effects: [...wikiEffects, ...base.effects],
        innerRevisions: [wikiPreview.previewRevision, ...base.innerRevisions],
        wiki: { request: wikiRequest, preview: wikiPreview },
        applyPrimary: async () => {
          const wikiResult = await this.#wiki.applyOperations({
            ...wikiRequest,
            plan: wikiPreview.plan,
            expectedPreviewRevision: wikiPreview.previewRevision,
          });
          const applied = await this.#proposals.apply(plan, plan.previewRevision);
          return { ...primary([applied.artifact], [...wikiResult.changes, applied.change]), wikiResult };
        },
      };
    }
    const next = action.kind === "inbox.reject"
      ? { state: "rejected" as const, reviewer: command.authority.actor, reviewedAt: command.authority.occurredAt, reviewRationale: action.rationale }
      : action.kind === "inbox.withdraw"
        ? { state: "withdrawn" as const, reviewer: command.authority.actor, reviewedAt: command.authority.occurredAt, ...(action.rationale === undefined ? {} : { reviewRationale: action.rationale }) }
        : { state: "pending" as const, reviewer: undefined, reviewedAt: undefined, reviewRationale: undefined, ...action.replacement };
    const plan = await this.#proposals.previewUpdate(current.ref.id, {
      ...withoutStored(current), ...next,
    }, current.revision);
    return canonicalWorkflowPlan(plan, "proposal", current.ref.id, {
      action: action.kind === "inbox.reject" ? "inbox.rejected" : action.kind === "inbox.withdraw" ? "inbox.withdrawn" : "inbox.repaired",
      subjects: [entitySubject(plan.artifact.ref)],
    }, this.#proposals);
  }

  async #assertExpectationsCurrent(
    expectations: readonly RevisionExpectation[],
  ): Promise<void> {
    const wikiEntityExpectations: WikiRevisionExpectation[] = [];
    for (const expectation of expectations) {
      if (expectation.target.kind !== "entity") continue;
      if (
        expectation.revision !== null
        && (!Number.isSafeInteger(expectation.semanticRevision)
          || (expectation.semanticRevision as number) < 1)
      ) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Wiki entity revision is incomplete",
          "An existing Wiki entity target requires its exact semantic and file revision.",
        );
      }
      wikiEntityExpectations.push({
        target: { kind: "entity", id: expectation.target.id },
        version: expectation.revision === null
          ? null
          : {
              semanticRevision: expectation.semanticRevision as number,
              contentHash: expectation.revision,
            },
      });
    }
    if (wikiEntityExpectations.length > 0) {
      await this.#wiki.validateCurrentRevisionExpectations(wikiEntityExpectations);
    }
    for (const expectation of expectations) {
      if (expectation.target.kind === "entity") {
        continue;
      }
      if (expectation.target.kind === "artifact") {
        const artifact = tryReadContainedArtifact(
          this.#root.path,
          expectation.target.path,
          recoveryFileByteLimit(expectation.target.path),
        );
        if ((artifact?.revision ?? null) !== expectation.revision) {
          throw targetRevisionChanged(expectation.target.path);
        }
        continue;
      }
      if (
        expectation.target.namespace !== "inbox-draft"
        && expectation.target.namespace !== "relay-draft"
      ) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Unsupported proposal target",
          "Inbox approval cannot safely validate this local target namespace.",
        );
      }
      const draft = this.#local.getLocalDraft(expectation.target.id);
      const expectedKind = expectation.target.namespace === "inbox-draft"
        ? "inbox"
        : "relay";
      if (
        draft?.kind !== expectedKind
        || (draft?.revision ?? null) !== expectation.revision
      ) {
        throw targetRevisionChanged(
          `${expectation.target.namespace}:${expectation.target.id}`,
        );
      }
    }
  }

  async #requireWorkstreamDependency(
    ref: EntityRef,
    expectations: readonly RevisionExpectation[],
  ): Promise<Workstream> {
    if (ref.kind !== "workstream") throw artifactError("VALIDATION_FAILED", "Invalid Workstream reference", "A real Workstream reference is required.");
    const workstream = await required(this.#workstreams.get(ref.id), "Workstream");
    requireArtifactExpectation(expectations, workstream.sourcePath, workstream.revision);
    return workstream;
  }

  async #requirePlaybookDependency(
    ref: EntityRef,
    expectations: readonly RevisionExpectation[],
  ): Promise<Playbook> {
    if (ref.kind !== "playbook") throw artifactError("VALIDATION_FAILED", "Invalid Playbook reference", "A real Playbook reference is required.");
    const playbook = await required(this.#playbooks.get(ref.id), "Playbook");
    requireArtifactExpectation(expectations, playbook.sourcePath, playbook.revision);
    return playbook;
  }

  async #assertAuthorityCurrent(authority: { actor: ActorRef; repoState: RepoState }): Promise<void> {
    if (stableJson(await this.resolveActor()) !== stableJson(authority.actor)) {
      throw artifactError("REVISION_CONFLICT", "Workflow actor changed", "The resolved actor changed after preview. Preview the workflow again.");
    }
    const current = await this.#git.getRepoState();
    if (!sameRepoCheckpoint(current, authority.repoState)) throw repositoryChanged();
  }

  async #assertPostPrimaryRepository(before: RepoState): Promise<void> {
    this.#root.assertCurrent();
    const current = await this.#git.getRepoState();
    if (current.branch !== before.branch || current.head !== before.head) throw repositoryChanged();
  }

  async #revalidatePreparedWiki(
    prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
  ): Promise<void> {
    if (prepared.wiki === undefined) return;
    // Revalidate canonical truth without minting a second set of IDs for
    // create/supersede operations. The reviewed opaque plan performs its own
    // exact base-byte check immediately before publication.
    await this.#wiki.validateCurrentRevisionExpectations(
      prepared.wiki.request.expectedRevisions,
    );
    const recovery = prepared.wiki.preview.recoveryManifest;
    const recoverable = recovery === undefined ? null : asRecoverableWikiPort(this.#wiki);
    if (
      recoverable !== null
      && recoverable.inspectOperationRecovery(prepared.wiki.request).state !== "none"
    ) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Wiki proposal changed",
        "The reviewed Wiki operation ID already has durable audit state. Preview the Inbox approval again.",
      );
    }
  }

  async #preflightPrepared(
    prepared: PreparedOperation<TWikiPayload, TWikiPlan>,
    prepareActivity: boolean,
  ): Promise<PreparedActivityPublication | null> {
    await this.#assertAuthorityCurrent(prepared.preview.command.authority);
    await this.#assertExpectationsCurrent(
      prepared.preview.command.expectedRevisions,
    );
    if (prepared.preview.command.action.kind === "inbox.approve") {
      const proposal = await required(
        this.#proposals.get(prepared.preview.command.action.proposalId),
        "Inbox proposal",
      );
      await this.#assertExpectationsCurrent(proposal.targetRevisions);
    }
    this.#assertCleanupPending(prepared.effects);
    await this.#revalidatePreparedWiki(prepared);
    for (const effect of prepared.effects) {
      if (
        (effect.kind === "canonical" || effect.kind === "local")
        && this.#effectState(effect) !== "before"
      ) {
        throw targetRevisionChanged(
          effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
        );
      }
    }
    for (const change of prepared.preview.changes) {
      const observed = tryReadContainedArtifact(
        this.#root.path,
        change.path,
        recoveryFileByteLimit(change.path),
      );
      if ((observed?.revision ?? null) !== change.beforeRevision) {
        throw targetRevisionChanged(change.path);
      }
    }
    if (prepared.activity === null) return null;
    const observedActivity = tryReadContainedArtifact(
      this.#root.path,
      prepared.activity.sourcePath,
      ACTIVITY_ARTIFACT_MAX_BYTES,
    );
    if (observedActivity !== null) {
      throw targetRevisionChanged(prepared.activity.sourcePath);
    }
    return prepareActivity
      ? this.#activity.prepareApplyCreate(
          prepared.activity,
          prepared.activity.previewRevision,
        )
      : null;
  }

  async #runPhaseHook(boundary: TeamWorkflowPhaseBoundary): Promise<void> {
    try {
      await this.#phaseHook(boundary);
    } catch (error) {
      if (error instanceof WorkflowPhaseInterruption) throw error;
      throw new WorkflowPhaseInterruption(boundary, { cause: error });
    }
  }

  #acquireLease(): string {
    const token = this.#heldLeaseToken ?? this.#leaseToken();
    this.#local.acquireTeamWorkflowLease({ pid: this.#pid, token, acquiredAt: this.#nowIso() });
    this.#heldLeaseToken = token;
    return token;
  }

  #advanceJournal(
    entry: TeamWorkflowJournalEntry,
    leaseToken: string,
    phase: "canonical_published" | "local_finalized" | "complete",
    deleteDrafts: readonly { kind: "inbox" | "relay"; id: string; expectedRevision: Revision }[] = [],
  ): TeamWorkflowJournalEntry {
    return this.#local.advanceWorkflowOperation({
      leaseToken,
      operationId: entry.operationId,
      commandRevision: entry.commandRevision,
      previewRevision: entry.previewRevision,
      expectedRevision: entry.revision,
      phase,
      effects: entry.effects,
      ...(deleteDrafts.length === 0 ? {} : { deleteDrafts }),
    });
  }

  async #recoverExisting(
    entry: TeamWorkflowJournalEntry,
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    if (entry.phase === "complete") {
      return this.#resultFromEffects(entry, true);
    }
    const wikiRecovery = entry.effects.find(
      (effect): effect is WikiRecoveryWorkflowEffect => effect.kind === "wiki_recovery",
    );
    if (wikiRecovery !== undefined) {
      return this.#recoverWikiExisting(entry, command, wikiRecovery);
    }
    if (entry.phase !== "intent" || this.#primaryEffectState(entry.effects) !== "none") {
      await this.#assertRecoveryCheckpoint(entry.effects);
    }
    // An interrupted journal can legitimately contain a bounded prefix of
    // exact before/after effects. A third revision is not an incomplete prefix:
    // it is external alteration of a recovery target and must terminate as a
    // conflict before lease takeover or any cleanup advances the journal.
    this.#assertNoDivergentPrimaryEffects(entry.effects);
    const leaseToken = this.#acquireLease();
    let current = this.#local.getWorkflowOperation(entry.operationId) ?? entry;
    if (current.phase === "intent") {
      let primary = this.#primaryEffectState(current.effects);
      if (primary === "none") {
        if (current.effects.some((effect) => effect.kind === "canonical" && effect.namespace === "wiki")) {
          this.#abandonUnpublished(current, leaseToken);
          throw artifactError(
            "OPERATION_INTERRUPTED",
            "Wiki approval requires a new preview",
            "The process-local Wiki plan was not applied. Preview the Inbox approval again before applying it.",
          );
        }
        try {
          await this.#publishUnpublished(command, current.effects);
        } catch (error) {
          if (error instanceof WorkflowPhaseInterruption) throw error;
          if (this.#primaryEffectState(current.effects) === "none") {
            this.#abandonUnpublished(current, leaseToken);
          }
          throw error;
        }
        primary = this.#primaryEffectState(current.effects);
      }
      await this.#assertRecoveryCheckpoint(current.effects);
      await this.#completeInterruptedProposalApproval(current.effects);
      primary = this.#primaryEffectState(current.effects);
      if (primary !== "all") {
        throw incompleteRecovery();
      }
      this.#recoverActivity(current.effects);
      this.#assertActivityPublished(current.effects);
      current = this.#advanceJournal(current, leaseToken, "canonical_published");
    }
    if (current.phase === "canonical_published") {
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupPending(current.effects);
      const cleanups = current.effects.filter((effect): effect is LocalCleanupWorkflowEffect => effect.kind === "local_cleanup");
      current = this.#advanceJournal(current, leaseToken, "local_finalized", cleanups.map((effect) => ({
        kind: effect.draftKind, id: effect.draftId, expectedRevision: effect.expectedRevision,
      })));
    }
    if (current.phase === "local_finalized") {
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupApplied(current.effects);
      current = this.#advanceJournal(current, leaseToken, "complete");
    }
    this.#local.releaseTeamWorkflowLease(leaseToken);
    this.#heldLeaseToken = null;
    return this.#resultFromEffects(current, true);
  }

  async #recoverWikiExisting(
    entry: TeamWorkflowJournalEntry,
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    recovery: WikiRecoveryWorkflowEffect,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    await this.#assertRecoveryCheckpoint(entry.effects);
    this.#assertNoDivergentNonWikiPrimaryEffects(entry.effects);
    const leaseToken = this.#acquireLease();
    let current = this.#local.getWorkflowOperation(entry.operationId) ?? entry;
    let context = await this.#wikiRecoveryContext(command, current.effects, recovery);

    if (current.phase === "intent") {
      if (context.inspection.state === "mismatch") {
        throw wikiRecoveryMismatch(context.inspection.reason);
      }
      if (context.inspection.state === "none") {
        const changed = current.effects.find(
          (effect): effect is CanonicalWorkflowEffect | LocalWorkflowEffect =>
            (effect.kind === "canonical" || effect.kind === "local")
            && this.#effectState(effect) !== "before",
        );
        this.#abandonUnpublished(current, leaseToken);
        if (changed !== undefined) {
          throw targetRevisionChanged(
            changed.kind === "canonical" ? changed.path : `${changed.namespace}:${changed.id}`,
          );
        }
        throw artifactError(
          "OPERATION_INTERRUPTED",
          "Wiki approval requires a new preview",
          "No reviewed Wiki operation was published. Preview the Inbox approval again before applying it.",
        );
      }
      if (context.inspection.state === "prefix") {
        const resumed = await context.port.resumeOperations(
          context.request,
          context.manifest,
        );
        if (!resumed.valid || resumed.recoveryManifest === undefined) {
          throw wikiRecoveryConflict(
            "The interrupted Wiki operation no longer has an exact valid recovery preview.",
          );
        }
        if (stableJson(resumed.recoveryManifest) !== stableJson(context.manifest)) {
          throw wikiRecoveryConflict(
            "The interrupted Wiki recovery manifest changed after publication began.",
          );
        }
        this.#assertResumedWikiChanges(current.effects, resumed.changes);
        await context.port.applyOperations({
          ...context.request,
          plan: resumed.plan,
          expectedPreviewRevision: resumed.previewRevision,
        });
        context = await this.#wikiRecoveryContext(command, current.effects, recovery);
      }
      if (context.inspection.state !== "complete") {
        throw context.inspection.state === "mismatch"
          ? wikiRecoveryMismatch(context.inspection.reason)
          : incompleteRecovery();
      }
      this.#assertWikiPrimaryEffectsPublished(current.effects);
      await this.#refreshRecoveredWikiIndex(current.effects);
      await this.#completeInterruptedProposalApproval(current.effects, true);
      this.#assertNonAuditPrimaryEffectsPublished(current.effects);
      this.#recoverActivity(current.effects);
      this.#assertActivityPublished(current.effects);
      current = this.#advanceJournal(current, leaseToken, "canonical_published");
    }

    if (current.phase === "canonical_published") {
      context = await this.#wikiRecoveryContext(command, current.effects, recovery);
      if (context.inspection.state !== "complete") {
        throw context.inspection.state === "mismatch"
          ? wikiRecoveryMismatch(context.inspection.reason)
          : incompleteRecovery();
      }
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertNonAuditPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupPending(current.effects);
      const cleanups = current.effects.filter(
        (effect): effect is LocalCleanupWorkflowEffect => effect.kind === "local_cleanup",
      );
      current = this.#advanceJournal(
        current,
        leaseToken,
        "local_finalized",
        cleanups.map((effect) => ({
          kind: effect.draftKind,
          id: effect.draftId,
          expectedRevision: effect.expectedRevision,
        })),
      );
    }

    if (current.phase === "local_finalized") {
      context = await this.#wikiRecoveryContext(command, current.effects, recovery);
      if (context.inspection.state !== "complete") {
        throw context.inspection.state === "mismatch"
          ? wikiRecoveryMismatch(context.inspection.reason)
          : incompleteRecovery();
      }
      await this.#assertRecoveryCheckpoint(current.effects);
      this.#assertNonAuditPrimaryEffectsPublished(current.effects);
      this.#assertActivityPublished(current.effects);
      this.#assertCleanupApplied(current.effects);
      current = this.#advanceJournal(current, leaseToken, "complete");
    }

    this.#local.releaseTeamWorkflowLease(leaseToken);
    this.#heldLeaseToken = null;
    return this.#resultFromEffects(current, true);
  }

  #abandonUnpublished(entry: TeamWorkflowJournalEntry, leaseToken: string): void {
    this.#local.abandonWorkflowOperation({
      leaseToken,
      operationId: entry.operationId,
      commandRevision: entry.commandRevision,
      previewRevision: entry.previewRevision,
      expectedRevision: entry.revision,
    });
    this.#local.releaseTeamWorkflowLease(leaseToken);
    this.#heldLeaseToken = null;
  }

  async #publishUnpublished(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    effects: readonly TeamWorkflowJournalEffect[],
  ): Promise<void> {
    await this.#assertAuthorityCurrent(command.authority);
    await this.#assertExpectationsCurrent(command.expectedRevisions);
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activity !== undefined) {
      const occupied = tryReadContainedArtifact(
        this.#root.path,
        activity.path,
        ACTIVITY_ARTIFACT_MAX_BYTES,
      );
      if (occupied !== null) throw targetRevisionChanged(activity.path);
    }
    const planned = await this.#planPrimary(command, effects);
    const expectedPrimary = effects.filter(
      (effect) =>
        effect.kind === "canonical"
        || effect.kind === "local"
        || effect.kind === "local_cleanup",
    );
    if (stableJson([...planned.effects, ...planned.cleanup]) !== stableJson(expectedPrimary)) {
      throw incompleteRecovery();
    }
    assertRecoveryActivityIntent(planned.activityInput, command.authority, activity);
    await this.#runPhaseHook("before-canonical-publication");
    this.#root.assertCurrent();
    await planned.applyPrimary();
    await this.#runPhaseHook("after-canonical-publication");
    await this.#assertPostPrimaryRepository(command.authority.repoState);
    this.#recoverActivity(effects);
    await this.#runPhaseHook("after-activity-publication");
  }

  /**
   * Wiki publication intentionally precedes the proposal state transition. If
   * the process stops in that narrow gap, the journal contains enough bounded
   * audit state to recreate only the exact reviewed proposal bytes. It never
   * replays or reconstructs a Wiki operation plan.
   */
  async #completeInterruptedProposalApproval(
    effects: readonly TeamWorkflowJournalEffect[],
    durableWikiComplete = false,
  ): Promise<void> {
    const wikiEffects = effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "wiki",
    );
    const requiredWikiEffects = durableWikiComplete
      ? wikiEffects.filter((effect) => !isWikiOperationLogEffect(effect))
      : wikiEffects;
    const proposal = effects.find(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "proposal",
    );
    if (
      wikiEffects.length === 0
      || proposal === undefined
      || this.#effectApplied(proposal)
      || !requiredWikiEffects.every((effect) => this.#effectApplied(effect))
    ) {
      return;
    }
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (
      activity === undefined
      || activity.action !== "inbox.approved"
      || proposal.beforeRevision === null
      || proposal.afterRevision === null
    ) {
      throw incompleteRecovery();
    }
    const current = await this.#proposals.get(proposal.id);
    if (
      current === null
      || current.revision !== proposal.beforeRevision
      || current.sourcePath !== proposal.path
    ) {
      throw incompleteRecovery();
    }
    const plan = await this.#proposals.previewUpdate(current.ref.id, {
      ...withoutStored(current),
      state: "approved",
      reviewer: activity.actor,
      reviewedAt: activity.occurredAt,
    }, current.revision);
    if (
      plan.change.path !== proposal.path
      || plan.change.beforeRevision !== proposal.beforeRevision
      || plan.change.afterRevision !== proposal.afterRevision
    ) {
      throw incompleteRecovery();
    }
    await this.#proposals.apply(plan, plan.previewRevision);
  }

  async #wikiRecoveryContext(
    command: PreparedTeamWorkflowCommand<TWikiPayload>,
    effects: readonly TeamWorkflowJournalEffect[],
    recovery: WikiRecoveryWorkflowEffect,
  ): Promise<WikiRecoveryContext<TWikiPayload, TWikiPlan>> {
    if (command.action.kind !== "inbox.approve") {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery metadata is not bound to an Inbox approval.",
      );
    }
    const proposalEffect = effects.find(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "proposal",
    );
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (
      proposalEffect === undefined
      || activity === undefined
      || activity.action !== "inbox.approved"
      || proposalEffect.id !== command.action.proposalId
    ) {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery metadata does not match the reviewed proposal.",
      );
    }
    const proposal = await this.#proposals.get(proposalEffect.id);
    if (
      proposal === null
      || proposal.sourcePath !== proposalEffect.path
      || (proposal.revision !== proposalEffect.beforeRevision
        && proposal.revision !== proposalEffect.afterRevision)
    ) {
      throw targetRevisionChanged(proposalEffect.path);
    }
    const request = portableWikiRequest(
      proposal,
      activity.actor,
      activity.occurredAt,
    );
    if (recovery.manifest.operationId !== request.operation.opId) {
      throw wikiRecoveryConflict(
        "The durable Wiki recovery manifest identifies a different operation.",
      );
    }
    const port = asRecoverableWikiPort(this.#wiki);
    if (port === null) {
      throw artifactError(
        "OPERATION_INTERRUPTED",
        "Wiki recovery adapter is unavailable",
        "The reviewed Wiki adapter cannot resume this bounded operation. Restore the compatible adapter and retry.",
      );
    }
    return {
      port,
      request,
      manifest: recovery.manifest,
      inspection: port.inspectOperationRecovery(request),
    };
  }

  #wikiPrimaryEffects(
    effects: readonly TeamWorkflowJournalEffect[],
  ): readonly CanonicalWorkflowEffect[] {
    return effects.filter(
      (effect): effect is CanonicalWorkflowEffect =>
        effect.kind === "canonical" && effect.namespace === "wiki",
    );
  }

  #assertResumedWikiChanges(
    effects: readonly TeamWorkflowJournalEffect[],
    changes: readonly FileChange[],
  ): void {
    const expected = new Map(
      this.#wikiPrimaryEffects(effects).map((effect) => [effect.path, effect]),
    );
    const seen = new Set<RepoRelativePath>();
    for (const change of changes) {
      const effect = expected.get(change.path);
      if (
        effect === undefined
        || seen.has(change.path)
        || change.afterRevision !== effect.afterRevision
      ) {
        throw wikiRecoveryConflict(
          "The resumed Wiki preview does not match the journaled canonical effects.",
        );
      }
      const observed = tryReadContainedArtifact(
        this.#root.path,
        change.path,
        recoveryFileByteLimit(change.path),
      );
      if ((observed?.revision ?? null) !== change.beforeRevision) {
        throw targetRevisionChanged(change.path);
      }
      seen.add(change.path);
    }
    for (const effect of expected.values()) {
      if (this.#effectState(effect) !== "after" && !seen.has(effect.path)) {
        throw wikiRecoveryConflict(
          "The resumed Wiki preview omits an unfinished canonical effect.",
        );
      }
    }
  }

  #assertWikiPrimaryEffectsPublished(
    effects: readonly TeamWorkflowJournalEffect[],
  ): void {
    for (const effect of this.#wikiPrimaryEffects(effects)) {
      if (isWikiOperationLogEffect(effect)) continue;
      if (this.#effectState(effect) !== "after") {
        throw targetRevisionChanged(effect.path);
      }
    }
  }

  async #refreshRecoveredWikiIndex(
    effects: readonly TeamWorkflowJournalEffect[],
  ): Promise<void> {
    const paths = [...new Set(
      this.#wikiPrimaryEffects(effects)
        .filter((effect) => !isWikiOperationLogEffect(effect))
        .map((effect) => effect.path),
    )].sort(compareCodePoints);
    if (paths.length > 0) await this.#wiki.refreshFiles(paths);
  }

  #assertNonAuditPrimaryEffectsPublished(
    effects: readonly TeamWorkflowJournalEffect[],
  ): void {
    for (const effect of effects) {
      if (effect.kind !== "canonical" && effect.kind !== "local") continue;
      if (effect.kind === "canonical" && isWikiOperationLogEffect(effect)) continue;
      if (this.#effectState(effect) !== "after") {
        throw targetRevisionChanged(
          effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
        );
      }
    }
  }

  #assertNoDivergentNonWikiPrimaryEffects(
    effects: readonly TeamWorkflowJournalEffect[],
  ): void {
    for (const effect of effects) {
      if (effect.kind !== "canonical" && effect.kind !== "local") continue;
      if (effect.kind === "canonical" && effect.namespace === "wiki") continue;
      if (this.#effectState(effect) !== "divergent") continue;
      throw targetRevisionChanged(
        effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
      );
    }
  }

  async #assertRecoveryCheckpoint(effects: readonly TeamWorkflowJournalEffect[]): Promise<void> {
    this.#root.assertCurrent();
    const activity = effects.find((effect): effect is ActivityWorkflowEffect => effect.kind === "activity");
    if (activity === undefined) return;
    const current = await this.#git.getRepoState();
    if (current.branch !== activity.repoState.branch || current.head !== activity.repoState.head) {
      throw repositoryChanged();
    }
  }

  #assertPrimaryEffectsPublished(effects: readonly TeamWorkflowJournalEffect[]): void {
    if (this.#primaryEffectState(effects) !== "all") {
      throw incompleteRecovery();
    }
  }

  #assertNoDivergentPrimaryEffects(effects: readonly TeamWorkflowJournalEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== "canonical" && effect.kind !== "local") continue;
      if (this.#effectState(effect) !== "divergent") continue;
      throw targetRevisionChanged(
        effect.kind === "canonical" ? effect.path : `${effect.namespace}:${effect.id}`,
      );
    }
  }

  #assertActivityPublished(effects: readonly TeamWorkflowJournalEffect[]): void {
    const activity = effects.find(
      (effect): effect is ActivityWorkflowEffect => effect.kind === "activity",
    );
    if (activity === undefined) return;
    const stored = tryReadContainedArtifact(
      this.#root.path,
      activity.path,
      ACTIVITY_ARTIFACT_MAX_BYTES,
    );
    if (stored?.revision !== activity.revision) throw incompleteRecovery();
  }

  #assertCleanupPending(effects: readonly TeamWorkflowJournalEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== "local_cleanup") continue;
      const draft = this.#local.getLocalDraft(effect.draftId);
      if (draft?.kind !== effect.draftKind || draft.revision !== effect.expectedRevision) {
        throw incompleteRecovery();
      }
    }
  }

  #assertCleanupApplied(effects: readonly TeamWorkflowJournalEffect[]): void {
    for (const effect of effects) {
      if (effect.kind !== "local_cleanup") continue;
      if (this.#local.getLocalDraft(effect.draftId) !== null) {
        throw incompleteRecovery();
      }
    }
  }

  #recoverActivity(effects: readonly TeamWorkflowJournalEffect[]): void {
    const effect = effects.find((item): item is ActivityWorkflowEffect => item.kind === "activity");
    if (effect === undefined) return;
    this.#activity.recoverJournaledCreate({
      schemaVersion: 1,
      id: effect.id,
      timestamp: effect.occurredAt,
      actor: effect.actor,
      action: effect.action,
      subjects: effect.subjects,
      ...(effect.workstream === undefined ? {} : { workstream: effect.workstream }),
      repoState: effect.repoState,
      ...(effect.metadata === undefined ? {} : { metadata: effect.metadata }),
    }, effect.revision);
  }

  #primaryEffectState(effects: readonly TeamWorkflowJournalEffect[]): "none" | "some" | "all" {
    const primaryEffects = effects.filter((effect) => effect.kind === "canonical" || effect.kind === "local");
    if (primaryEffects.length === 0) return "all";
    const states = primaryEffects.map((effect) => this.#effectState(effect));
    if (states.every((state) => state === "after")) return "all";
    if (states.every((state) => state === "before")) return "none";
    return "some";
  }

  #anyPrimaryEffectPublished(effects: readonly TeamWorkflowJournalEffect[]): boolean {
    return effects.some(
      (effect) =>
        (effect.kind === "canonical" || effect.kind === "local")
        && this.#effectState(effect) !== "before",
    );
  }

  #effectApplied(effect: CanonicalWorkflowEffect | LocalWorkflowEffect): boolean {
    return this.#effectState(effect) === "after";
  }

  #effectState(
    effect: CanonicalWorkflowEffect | LocalWorkflowEffect,
  ): "before" | "after" | "divergent" {
    if (effect.kind === "canonical") {
      const read = tryReadContainedArtifact(
        this.#root.path,
        effect.path,
        recoveryFileByteLimit(effect.path),
      );
      const revision = read?.revision ?? null;
      if (revision === effect.afterRevision) return "after";
      if (revision === effect.beforeRevision) return "before";
      return "divergent";
    }
    if (effect.namespace !== "inbox-draft" && effect.namespace !== "relay-draft") return "divergent";
    let current: StoredLocalDraft<unknown> | null;
    try {
      current = this.#local.getLocalDraft(effect.id);
    } catch (error) {
      // Schemas v1-v3 predate local drafts. A create preview whose expected
      // before revision is null can therefore prove absence without writing;
      // the explicit apply migrates before the under-lease revalidation.
      if (
        error instanceof MexPortError
        && error.problem.code === "MIGRATION_REQUIRED"
        && effect.beforeRevision === null
      ) {
        return "before";
      }
      throw error;
    }
    const expectedKind = effect.namespace === "inbox-draft" ? "inbox" : "relay";
    const revision = current === null || current.kind !== expectedKind
      ? null
      : current.revision;
    if (revision === effect.afterRevision) return "after";
    if (revision === effect.beforeRevision) return "before";
    return "divergent";
  }

  async #resultFromEffects(
    entry: TeamWorkflowJournalEntry,
    idempotentReplay: boolean,
  ): Promise<TeamWorkflowResult<TWikiPayload>> {
    const artifacts: TeamArtifact<TWikiPayload>[] = [];
    for (const effect of entry.effects) {
      if (effect.kind !== "canonical" || effect.namespace === "wiki") continue;
      const kind = namespaceToArtifactKind(effect.namespace);
      if (kind === null) continue;
      const artifact = await this.getArtifact({ id: effect.id, kind });
      if (artifact !== null && artifact.revision === effect.afterRevision) {
        artifacts.push(artifact);
      }
    }
    const activityEffectValue = entry.effects.find((effect): effect is ActivityWorkflowEffect => effect.kind === "activity");
    const event = activityEffectValue === undefined
      ? null
      : activityEventFromEffect(activityEffectValue);
    return {
      operationId: entry.operationId,
      previewRevision: entry.previewRevision,
      applied: true,
      idempotentReplay,
      changes: [],
      localChanges: entry.effects.flatMap(effectToLocalChange),
      artifacts,
      events: event === null ? [] : [event],
    };
  }

  async #listArtifacts(request: TeamArtifactListRequest): Promise<TeamPage<TeamArtifact<TWikiPayload>>> {
    if (request.includeArchived !== undefined && typeof request.includeArchived !== "boolean") {
      throw artifactError(
        "INVALID_REQUEST",
        "Invalid artifact archive filter",
        "includeArchived must be a boolean.",
      );
    }
    const limit = normalizeLimit(request.limit);
    const kinds = normalizeKinds(request.kinds);
    const states = normalizeStates(request.states);
    const filterRevision = hashJson({ kinds, states, includeArchived: request.includeArchived ?? false });
    const memberItems = kinds.includes("member") ? await this.#members.list() : [];
    const nonMemberKinds = kinds.filter((kind) => kind !== "member");
    const probes = await Promise.all(nonMemberKinds.map((kind) => this.#listKind(kind, {
      limit: 1,
      states,
      includeArchived: request.includeArchived,
    })));
    const repositoryRevisions = new Map(
      nonMemberKinds.map((kind, index) => [kind, probes[index]!.deterministicRevision]),
    );
    const corpusRevision = hashJson({
      members: memberItems.map((member) => [member.sourcePath, member.revision]),
      repositories: probes.map((page, index) => [nonMemberKinds[index], page.deterministicRevision]),
    });
    const cursor = decodeArtifactCursor(request.cursor, corpusRevision, filterRevision, kinds.length);
    const items: TeamArtifact<TWikiPayload>[] = [];
    let kindIndex = cursor?.kindIndex ?? 0;
    let innerCursor = cursor?.innerCursor ?? null;
    let memberOffset = cursor?.memberOffset ?? 0;

    while (kindIndex < kinds.length && items.length < limit) {
      const kind = kinds[kindIndex]!;
      if (kind === "member") {
        // Member activation is not a TeamArtifactState. A cross-kind state
        // filter therefore excludes members instead of inventing a state.
        const available = states === null ? memberItems : [];
        const take = Math.min(limit - items.length, available.length - memberOffset);
        items.push(...available.slice(memberOffset, memberOffset + take));
        memberOffset += take;
        if (memberOffset < available.length) break;
        kindIndex += 1; memberOffset = 0; innerCursor = null; continue;
      }
      const page = await this.#listKind(kind, {
        limit: limit - items.length,
        ...(innerCursor === null ? {} : { cursor: innerCursor }),
        states,
        includeArchived: request.includeArchived,
      });
      if (page.deterministicRevision !== repositoryRevisions.get(kind)) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Workflow artifact collection changed",
          "The artifact collection changed while the combined page was assembled. Restart listing.",
        );
      }
      items.push(...page.items);
      if (page.nextCursor !== null) { innerCursor = page.nextCursor; break; }
      kindIndex += 1; innerCursor = null;
    }
    const hasMore = kindIndex < kinds.length;
    return {
      items,
      nextCursor: hasMore ? encodeArtifactCursor({ v: 1, kindIndex, innerCursor, memberOffset, corpusRevision, filterRevision }) : null,
      truncated: hasMore,
      sourceTruncated: false,
      deterministicRevision: corpusRevision,
      diagnostics: probes.flatMap((page) => page.diagnostics).slice(0, 100),
    };
  }

  #listKind(kind: Exclude<TeamArtifactKind, "member">, request: { limit: number; cursor?: string; states: readonly TeamArtifactState[] | null; includeArchived?: boolean }): Promise<WorkflowRepositoryPage<any>> {
    const base = { limit: request.limit, ...(request.cursor === undefined ? {} : { cursor: request.cursor }), ...(request.includeArchived === undefined ? {} : { includeArchived: request.includeArchived }) };
    switch (kind) {
      case "workstream": return listRepositoryPage(this.#workstreams, base, request.states?.filter(isWorkstreamState) ?? null);
      case "proposal": return listRepositoryPage(this.#proposals, base, request.states?.filter(isProposalState) ?? null);
      case "relay": return listRepositoryPage(this.#relays, base, request.states?.filter(isRelayState) ?? null);
      case "playbook": return listRepositoryPage(this.#playbooks, base, request.states?.filter(isPlaybookState) ?? null);
      case "playbook_run": return listRepositoryPage(this.#runs, base, request.states?.filter(isRunState) ?? null);
    }
  }

  #nowIso(): string {
    const value = this.#now();
    if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
      throw artifactError("VALIDATION_FAILED", "Invalid workflow clock", "The Team workflow clock is invalid.");
    }
    return value.toISOString();
  }
}

/**
 * Production composition. The checkout supplies its one tracked scaffold
 * identity and both Git/Wiki adapters are constructed against the same
 * physically-bound root. Dependency injection is intentionally unavailable
 * on this path so two callers cannot select different local-state namespaces
 * or mutate a different checkout.
 */
export async function createRepositoryTeamWorkflowPort(
  projectRoot: string,
): Promise<RepositoryTeamWorkflowPort<RepositoryWikiOperationPayload, RepositoryWikiOperationPlan>> {
  const root = new RepositoryRootGuard(projectRoot);
  const git = createRepositoryGitPort(root.path);
  const config = tryReadContainedArtifact(
    root.path,
    ".mex/config.json",
    64 * 1024,
  );
  if (config === null) {
    throw missingScaffoldIdentity();
  }

  const authority = await git.getRepoState();
  if (authority.head === null) {
    throw missingScaffoldIdentity();
  }
  const trackedConfig = await git.readFileAtRevision({
    revision: authority.head,
    path: ".mex/config.json",
    maxBytes: 64 * 1024,
  });
  if (
    trackedConfig === null
    || trackedConfig.truncated
    || !Buffer.from(trackedConfig.content).equals(Buffer.from(config.bytes))
  ) {
    throw missingScaffoldIdentity();
  }

  root.assertCurrent();
  const confirmedConfig = tryReadContainedArtifact(
    root.path,
    ".mex/config.json",
    64 * 1024,
  );
  const confirmedAuthority = await git.getRepoState();
  if (
    confirmedConfig === null
    || confirmedConfig.revision !== config.revision
    || !sameRepoCheckpoint(authority, confirmedAuthority)
  ) {
    throw repositoryChanged();
  }
  let scaffoldId: unknown;
  try {
    const parsed = JSON.parse(Buffer.from(confirmedConfig.bytes).toString("utf8")) as unknown;
    scaffoldId = isPlainObject(parsed) ? parsed.scaffold_id : undefined;
  } catch {
    throw missingScaffoldIdentity();
  }
  if (
    typeof scaffoldId !== "string"
    || scaffoldId.length === 0
    || scaffoldId.length > 512
    || /[\0-\x1f\x7f]/u.test(scaffoldId)
  ) {
    throw missingScaffoldIdentity();
  }
  return new RepositoryTeamWorkflowPort(root.path, {
    scaffoldId,
    git,
    wiki: createRepositoryWikiPort(root.path),
  });
}

/** @internal Test/conformance seam; never export from the workflow barrel. */
export function createRepositoryTeamWorkflowPortWithDependencies<
  TWikiPayload extends JsonValue,
  TWikiPlan = unknown,
>(
  projectRoot: string,
  options: RepositoryTeamWorkflowPortOptions<TWikiPayload, TWikiPlan>,
): RepositoryTeamWorkflowPort<TWikiPayload, TWikiPlan> {
  return new RepositoryTeamWorkflowPort(projectRoot, options);
}

export class WorkflowPhaseInterruption extends MexPortError {
  constructor(
    readonly boundary: TeamWorkflowPhaseBoundary,
    options: ErrorOptions = {},
  ) {
    super({
      title: "Team workflow interrupted",
      status: 409,
      code: "OPERATION_INTERRUPTED",
      detail: `The Team workflow was interrupted at ${boundary} and must be recovered by exact replay.`,
    });
    this.name = "WorkflowPhaseInterruption";
    if (options.cause !== undefined) {
      Object.defineProperty(this, "cause", {
        value: options.cause,
        configurable: true,
      });
    }
  }
}

function canonicalPlan<TWikiPayload extends JsonValue>(
  plan: MemberWritePlan,
  namespace: string,
  id: string,
  activityInput: Omit<Parameters<ActivityRepository["previewCreate"]>[0], "actor">,
  applyPrimary: () => Promise<PrimaryResult<TWikiPayload>>,
) {
  return {
    changes: [plan.change], localChanges: [], diagnostics: [], cleanup: [],
    effects: [canonicalEffect(namespace, id, plan.change)], innerRevisions: [plan.previewRevision],
    activityInput, applyPrimary,
  };
}

function canonicalWorkflowPlan<TWikiPayload extends JsonValue, TArtifact extends TeamArtifact<TWikiPayload>>(
  plan: WorkflowArtifactWritePlan<TArtifact>,
  namespace: string,
  id: string,
  activityInput: Omit<Parameters<ActivityRepository["previewCreate"]>[0], "actor">,
  repository: { apply(plan: WorkflowArtifactWritePlan<TArtifact>, revision: Revision): Promise<{ artifact: TArtifact; change: FileChange }> },
) {
  return {
    changes: [plan.change], localChanges: [], diagnostics: [], cleanup: [],
    effects: [canonicalEffect(namespace, id, plan.change)], innerRevisions: [plan.previewRevision],
    activityInput,
    applyPrimary: async () => {
      const applied = await repository.apply(plan, plan.previewRevision);
      return primary([applied.artifact], [applied.change]);
    },
  };
}

function withCleanup<T extends { cleanup: readonly LocalCleanupWorkflowEffect[]; localChanges: readonly LocalStateChange[]; effects: readonly TeamWorkflowJournalEffect[] }>(
  plan: T,
  kind: "inbox" | "relay",
  id: string,
  revision: Revision,
): T {
  const cleanup: LocalCleanupWorkflowEffect = { kind: "local_cleanup", draftKind: kind, draftId: id, expectedRevision: revision };
  return {
    ...plan,
    cleanup: [...plan.cleanup, cleanup],
    effects: [...plan.effects],
    localChanges: [...plan.localChanges, localChange(kind, id, revision, null, "Publish local draft")],
  };
}

async function listRepositoryPage<TArtifact, TState extends string>(
  repository: {
    list(request: {
      limit: number;
      cursor?: string;
      states?: readonly TState[];
      includeArchived?: boolean;
    }): Promise<WorkflowRepositoryPage<TArtifact>>;
  },
  base: { limit: number; cursor?: string; includeArchived?: boolean },
  states: readonly TState[] | null,
): Promise<WorkflowRepositoryPage<TArtifact>> {
  if (states !== null && states.length === 0) {
    const probe = await repository.list({ limit: 1, includeArchived: true });
    return {
      ...probe,
      items: [],
      nextCursor: null,
      truncated: false,
    };
  }
  return repository.list({
    ...base,
    ...(states === null ? {} : { states }),
  });
}

function canonicalEffect(namespace: string, id: string, change: FileChange): CanonicalWorkflowEffect {
  return { kind: "canonical", namespace, id, path: change.path, beforeRevision: change.beforeRevision, afterRevision: change.afterRevision };
}

function recoveryCanonicalId(
  effects: readonly TeamWorkflowJournalEffect[] | undefined,
  namespace: string,
): string | null {
  if (effects === undefined) return null;
  const matches = effects.filter(
    (effect): effect is CanonicalWorkflowEffect =>
      effect.kind === "canonical" && effect.namespace === namespace,
  );
  if (matches.length !== 1) throw incompleteRecovery();
  return matches[0]!.id;
}

function recoveryLocalId(
  effects: readonly TeamWorkflowJournalEffect[] | undefined,
  namespace: "inbox-draft" | "relay-draft",
): string | null {
  if (effects === undefined) return null;
  const matches = effects.filter(
    (effect): effect is LocalWorkflowEffect =>
      effect.kind === "local" && effect.namespace === namespace,
  );
  if (matches.length !== 1) throw incompleteRecovery();
  return matches[0]!.id;
}

function activityEffect(preview: ActivityCreatePreview): ActivityWorkflowEffect {
  return {
    kind: "activity", id: preview.event.id, path: preview.sourcePath, revision: preview.revision,
    action: preview.event.action, actor: preview.event.actor, occurredAt: preview.event.timestamp,
    repoState: preview.event.repoState, subjects: preview.event.subjects,
    ...(preview.event.workstream === undefined ? {} : { workstream: preview.event.workstream }),
    ...(preview.event.metadata === undefined ? {} : { metadata: preview.event.metadata }),
  };
}

function activityEventFromEffect(effect: ActivityWorkflowEffect): ActivityEvent {
  return {
    schemaVersion: 1,
    id: effect.id,
    timestamp: effect.occurredAt,
    actor: effect.actor,
    action: effect.action,
    subjects: effect.subjects,
    ...(effect.workstream === undefined ? {} : { workstream: effect.workstream }),
    repoState: effect.repoState,
    ...(effect.metadata === undefined ? {} : { metadata: effect.metadata }),
  };
}

function assertRecoveryActivityIntent(
  input: Omit<Parameters<ActivityRepository["previewCreate"]>[0], "actor"> | null,
  authority: PreparedTeamWorkflowCommand<JsonValue>["authority"],
  effect: ActivityWorkflowEffect | undefined,
): void {
  if (input === null || effect === undefined) {
    if (input !== null || effect !== undefined) throw incompleteRecovery();
    return;
  }
  const expected = {
    action: input.action,
    actor: authority.actor,
    occurredAt: authority.occurredAt,
    repoState: authority.repoState,
    subjects: input.subjects,
    ...(input.workstream === undefined ? {} : { workstream: input.workstream }),
    ...(input.metadata === undefined ? {} : { metadata: input.metadata }),
  };
  const actual = {
    action: effect.action,
    actor: effect.actor,
    occurredAt: effect.occurredAt,
    repoState: effect.repoState,
    subjects: effect.subjects,
    ...(effect.workstream === undefined ? {} : { workstream: effect.workstream }),
    ...(effect.metadata === undefined ? {} : { metadata: effect.metadata }),
  };
  if (stableJson(expected) !== stableJson(actual)) throw incompleteRecovery();
}

function primary<TWikiPayload extends JsonValue>(
  artifacts: readonly TeamArtifact<TWikiPayload>[],
  changes: readonly FileChange[],
  localChanges: readonly LocalStateChange[] = [],
): PrimaryResult<TWikiPayload> {
  return { artifacts, changes, localChanges };
}

function localDraftProjection<TWikiPayload extends JsonValue>(stored: StoredLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput>): LocalDraft<TWikiPayload> {
  if (stored.kind === "inbox") {
    const payload = normalizeInboxDraftInput<TWikiPayload>(
      stored.payload as InboxDraftInput<TWikiPayload>,
    );
    return {
      ...payload,
      id: stored.id,
      kind: "inbox",
      revision: stored.revision,
      updatedAt: stored.updatedAt,
    };
  }
  const payload = normalizeRelayDraftInput(stored.payload as RelayDraftInput);
  return {
    ...payload,
    id: stored.id,
    kind: "relay",
    revision: stored.revision,
    updatedAt: stored.updatedAt,
  };
}

function localChange(kind: "inbox" | "relay", id: string, beforeRevision: Revision | null, afterRevision: Revision | null, summary: string): LocalStateChange {
  return { namespace: `${kind}-draft`, id, beforeRevision, afterRevision, summary };
}

function recoveryFileByteLimit(path: RepoRelativePath): number {
  return path === ".mex/events/operations.jsonl"
    ? MAX_WIKI_OPERATION_LOG_BYTES
    : MAX_WIKI_RECOVERY_FILE_BYTES;
}

function isWikiOperationLogEffect(effect: CanonicalWorkflowEffect): boolean {
  return effect.namespace === "wiki"
    && effect.path === ".mex/events/operations.jsonl";
}

function asRecoverableWikiPort<
  TWikiPayload extends JsonValue,
  TWikiPlan,
>(
  port: WikiPort<unknown, TWikiPayload, TWikiPlan, unknown>,
): RecoverableWikiPort<TWikiPayload, TWikiPlan> | null {
  const candidate = port as Partial<RecoverableWikiPort<TWikiPayload, TWikiPlan>>;
  return typeof candidate.inspectOperationRecovery === "function"
    && typeof candidate.resumeOperations === "function"
    ? candidate as RecoverableWikiPort<TWikiPayload, TWikiPlan>
    : null;
}

function wikiRecoveryMismatch(
  reason: Extract<WikiOperationRecoveryInspection, { state: "mismatch" }>["reason"],
): MexPortError {
  return reason === "audit_unsafe"
    ? artifactError(
        "INDEX_CORRUPT",
        "Wiki recovery audit is unsafe",
        "The bounded Wiki operation audit cannot prove this interrupted approval. Repair the canonical audit before retrying.",
      )
    : wikiRecoveryConflict(
        "The Wiki operation audit does not match the exact interrupted approval.",
      );
}

function wikiRecoveryConflict(detail: string): MexPortError {
  return artifactError(
    "REVISION_CONFLICT",
    "Wiki recovery changed",
    detail,
  );
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertWikiRecoveryManifestMatchesChanges(
  manifest: WikiOperationRecoveryManifest,
  changes: readonly FileChange[],
): void {
  const expected = new Map<RepoRelativePath, {
    beforeRevision: Revision | null;
    afterRevision: Revision;
  }>();
  for (const item of manifest.items) {
    for (const file of item.files) {
      const previous = expected.get(file.path);
      if (previous !== undefined && previous.afterRevision !== file.beforeRevision) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Wiki recovery manifest is discontinuous",
          "The Wiki recovery manifest does not describe one ordered file revision chain.",
        );
      }
      expected.set(file.path, {
        beforeRevision: previous?.beforeRevision ?? file.beforeRevision,
        afterRevision: file.afterRevision,
      });
    }
  }
  const first = manifest.items[0];
  const last = manifest.items.at(-1);
  if (first === undefined || last === undefined) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Wiki recovery manifest is empty",
      "A Wiki recovery manifest must describe at least one reviewed operation.",
    );
  }
  expected.set(".mex/events/operations.jsonl", {
    beforeRevision: first.audit.beforeRevision,
    afterRevision: last.audit.afterRevision,
  });
  const expectedProjection = [...expected]
    .filter(([, revisions]) => revisions.beforeRevision !== revisions.afterRevision)
    .map(([path, revisions]) => ({ path, ...revisions }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  const actualProjection = changes
    .map((change) => ({
      path: change.path,
      beforeRevision: change.beforeRevision,
      afterRevision: change.afterRevision,
    }))
    .sort((left, right) => compareCodePoints(left.path, right.path));
  if (stableJson(expectedProjection) !== stableJson(actualProjection)) {
    throw artifactError(
      "VALIDATION_FAILED",
      "Wiki recovery manifest does not match preview",
      "The bounded Wiki recovery metadata must cover the exact reviewed file revisions.",
    );
  }
}

function entitySubject(entity: EntityRef) {
  return { kind: "entity" as const, entity };
}

function portableWikiRequest<TWikiPayload extends JsonValue>(proposal: InboxProposal<TWikiPayload>, actor: ActorRef, timestamp: string): WikiOperationRequest<TWikiPayload> {
  return {
    operation: { ...proposal.request.operation, actor: wikiActor(actor), timestamp },
    expectedRevisions: proposal.request.expectedRevisions,
  };
}

function wikiActor(actor: ActorRef): WikiOperationActor {
  if (actor.kind === "member") return { kind: "human", id: actor.memberId };
  if (actor.kind === "git") return { kind: "human", id: `git:${hashJson(actor).slice(0, 32)}` };
  return { kind: "system", id: "mex:unknown-actor" };
}

function requireArtifactExpectation(expectations: readonly RevisionExpectation[], path: RepoRelativePath, revision: Revision): void {
  const matches = expectations.filter((item) => item.target.kind === "artifact" && item.target.path === path);
  if (matches.length !== 1) throw missingExpectation(path);
  if (matches[0]!.revision !== revision) throw targetRevisionChanged(path);
}

function requireLocalExpectation(expectations: readonly RevisionExpectation[], namespace: "inbox-draft" | "relay-draft", id: string, revision: Revision | null): void {
  const matches = expectations.filter((item) => item.target.kind === "local" && item.target.namespace === namespace && item.target.id === id);
  if (matches.length !== 1) throw missingExpectation(`${namespace}:${id}`);
  if (matches[0]!.revision !== revision) throw targetRevisionChanged(`${namespace}:${id}`);
}

function requiredLocalRevision(expectations: readonly RevisionExpectation[], namespace: "inbox-draft" | "relay-draft", id: string): Revision {
  const match = expectations.find((item) => item.target.kind === "local" && item.target.namespace === namespace && item.target.id === id);
  if (match === undefined || match.revision === null) throw missingExpectation(`${namespace}:${id}`);
  return match.revision;
}

function missingExpectation(target: string) {
  return artifactError("VALIDATION_FAILED", "Workflow revision expectation is missing", `An exact revision expectation is required for ${target}.`);
}

function targetRevisionChanged(target: string) {
  return artifactError(
    "REVISION_CONFLICT",
    "Workflow target changed",
    `The exact expected revision for ${target} is no longer current.`,
  );
}

async function required<T>(value: Promise<T | null>, label: string): Promise<T> {
  const result = await value;
  if (result === null) throw artifactError("NOT_FOUND", `${label} not found`, `${label} does not exist.`);
  return result;
}

function requiredDraft<TWikiPayload extends JsonValue>(value: StoredLocalDraft | null, kind: "inbox" | "relay"): StoredLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput> {
  if (value === null || value.kind !== kind) throw artifactError("NOT_FOUND", "Local draft not found", `The ${kind} draft does not exist.`);
  return value as StoredLocalDraft<InboxDraftInput<TWikiPayload> | RelayDraftInput>;
}

function withoutStored<T extends { schemaVersion: 1; ref: EntityRef; kind: string; sourcePath: RepoRelativePath; revision: Revision; entityRevision?: number }>(value: T): Omit<T, "schemaVersion" | "ref" | "kind" | "sourcePath" | "revision" | "entityRevision"> {
  const { schemaVersion: _schema, ref: _ref, kind: _kind, sourcePath: _path, revision: _revision, entityRevision: _entityRevision, ...rest } = value;
  return rest;
}

function assertNoCallerAuthority(command: TeamWorkflowCommand<JsonValue>): void {
  for (const field of ["actor", "occurredAt", "repoState", "authority"] as const) {
    if (Object.hasOwn(command, field)) throw artifactError("INVALID_REQUEST", "Caller authority is forbidden", "Actor, time, branch, HEAD, and dirty state are captured by the workflow service.");
  }
}

function assertCommandShape(command: unknown): asserts command is TeamWorkflowCommand<JsonValue> {
  if (!isPlainObject(command)) invalidCommandShape();
  exactObjectKeys(command, ["operationId", "action", "expectedRevisions"]);
  assertActionShape(command.action);
}

function assertPreparedCommandShape(
  command: unknown,
): asserts command is PreparedTeamWorkflowCommand<JsonValue> {
  if (!isPlainObject(command)) invalidApplyRequest();
  exactObjectKeys(command, ["operationId", "action", "expectedRevisions", "authority"]);
  assertOperationId(command.operationId as string);
  assertActionShape(command.action);
  // Parsing the complete expectation set here gives malformed apply requests
  // the same stable, bounded semantics as preview before any hash or lookup.
  normalizeWorkflowRevisionExpectations(command.expectedRevisions);
  if (!isPlainObject(command.authority)) invalidApplyRequest();
  exactObjectKeys(command.authority, ["actor", "occurredAt", "repoState"]);
}

function assertActionShape(action: unknown): void {
  if (!isPlainObject(action) || typeof action.kind !== "string") {
    invalidCommandShape();
  }
  const actionKeys: Readonly<Record<string, readonly [readonly string[], readonly string[]]>> = {
    "member.add": [["kind", "member"], []],
    "member.update": [["kind", "memberId", "patch"], []],
    "workstream.create": [["kind", "workstream"], []],
    "workstream.update": [["kind", "workstreamId", "patch"], []],
    "workstream.archive": [["kind", "workstreamId"], []],
    "inbox.draft.save": [["kind", "draft"], ["draftId"]],
    "inbox.draft.delete": [["kind", "draftId"], []],
    "inbox.publish": [["kind", "draftId"], []],
    "inbox.approve": [["kind", "proposalId"], []],
    "inbox.reject": [["kind", "proposalId", "rationale"], []],
    "inbox.withdraw": [["kind", "proposalId"], ["rationale"]],
    "inbox.repair": [["kind", "proposalId", "replacement"], []],
    "relay.draft.save": [["kind", "draft"], ["draftId"]],
    "relay.draft.delete": [["kind", "draftId"], []],
    "relay.publish": [["kind", "draftId"], []],
    "relay.acknowledge": [["kind", "relayId"], []],
    "relay.close": [["kind", "relayId"], []],
    "playbook.create": [["kind", "playbook"], []],
    "playbook.update": [["kind", "playbookId", "patch"], []],
    "playbook.archive": [["kind", "playbookId"], []],
    "playbook.run.start": [["kind", "playbook", "workstream"], []],
    "playbook.run.complete-step": [["kind", "runId", "stepId"], []],
  };
  const keys = actionKeys[action.kind];
  if (keys === undefined) invalidCommandShape();
  exactObjectKeys(action, keys[0], keys[1]);
}

function exactObjectKeys(
  value: Record<string, unknown>,
  required: readonly string[],
  optional: readonly string[] = [],
): void {
  const actual = Object.keys(value).sort();
  const allowed = [...required, ...optional];
  if (
    required.some((key) => !Object.hasOwn(value, key))
    || actual.some((key) => !allowed.includes(key))
  ) {
    invalidCommandShape();
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function invalidCommandShape(): never {
  throw artifactError(
    "VALIDATION_FAILED",
    "Invalid workflow command",
    "The workflow command contains missing, unsupported, or extra fields.",
  );
}

function invalidApplyRequest(): never {
  throw artifactError(
    "INVALID_REQUEST",
    "Invalid workflow apply request",
    "The prepared workflow command must be bounded structured data returned by preview.",
  );
}

function cloneCommand<TWikiPayload extends JsonValue>(
  command: TeamWorkflowCommand<TWikiPayload>,
): TeamWorkflowCommand<TWikiPayload> {
  try {
    return structuredClone(command);
  } catch {
    invalidCommandShape();
  }
}

function assertOperationId(value: string): void {
  if (typeof value !== "string" || !OPERATION_ID.test(value)) throw artifactError("INVALID_REQUEST", "Invalid operation ID", "Operation ID must be bounded ASCII without paths or whitespace.");
}

function sameRepoCheckpoint(left: RepoState, right: RepoState): boolean {
  return left.branch === right.branch && left.head === right.head && left.dirty === right.dirty;
}

function repositoryChanged() {
  return artifactError("REVISION_CONFLICT", "Repository changed", "Repository branch, HEAD, or dirty state changed after workflow preview.");
}

function previewConflict() {
  return artifactError("REVISION_CONFLICT", "Workflow preview is unavailable", "The exact workflow preview is unavailable or no longer matches the approved command.");
}

function missingScaffoldIdentity() {
  return artifactError(
    "MIGRATION_REQUIRED",
    "Team workflow initialization is required",
    "The repository must have one bounded tracked scaffold identity before Team workflows can be opened.",
  );
}

function invalidLocalDraftList() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid local draft list request",
    "Local draft kind, page size, or cursor is invalid.",
  );
}

function incompleteRecovery() {
  return artifactError(
    "OPERATION_INTERRUPTED",
    "Workflow recovery is incomplete",
    "Canonical workflow effects are only partially present; restore the matching checkout and retry.",
  );
}

function hashJson(value: unknown): Revision {
  return createHash("sha256").update(stableJson(value)).digest("hex") as Revision;
}

function hashText(value: string): Revision {
  return createHash("sha256").update(value).digest("hex") as Revision;
}

/**
 * Stable JSON for untrusted apply input. Unlike the internal serializer this
 * rejects cycles, exotic prototypes, excessive depth/node count, and
 * oversized commands before hashing them.
 */
function boundedStableJson(value: unknown): string {
  const active = new Set<object>();
  let nodes = 0;
  const visit = (current: unknown, depth: number): unknown => {
    nodes += 1;
    if (nodes > MAX_PREPARED_COMMAND_NODES || depth > MAX_PREPARED_COMMAND_DEPTH) {
      invalidApplyRequest();
    }
    if (
      current === null
      || typeof current === "string"
      || typeof current === "boolean"
    ) {
      return current;
    }
    if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidApplyRequest();
      return current;
    }
    if (typeof current !== "object") invalidApplyRequest();
    if (active.has(current)) invalidApplyRequest();
    active.add(current);
    let result: unknown;
    if (Array.isArray(current)) {
      result = current.map((item) => visit(item, depth + 1));
    } else {
      if (!isPlainObject(current)) invalidApplyRequest();
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(current).sort()) {
        const entry = current[key];
        if (entry === undefined) invalidApplyRequest();
        sorted[key] = visit(entry, depth + 1);
      }
      result = sorted;
    }
    active.delete(current);
    return result;
  };
  const serialized = JSON.stringify(visit(value, 0));
  if (Buffer.byteLength(serialized, "utf8") > MAX_PREPARED_COMMAND_BYTES) {
    invalidApplyRequest();
  }
  return serialized;
}

function stableJson(value: unknown): string {
  return JSON.stringify(sortJson(value));
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  if (typeof value !== "object" || value === null) return value;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(value as Record<string, unknown>).sort()) {
    sorted[key] = sortJson((value as Record<string, unknown>)[key]);
  }
  return sorted;
}

function deepFreeze<T>(value: T): T {
  if (typeof value !== "object" || value === null || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

function normalizeLimit(value: number | undefined): number {
  const limit = value ?? TEAM_READ_LIMITS.defaultPageSize;
  if (!Number.isInteger(limit) || limit < 1 || limit > TEAM_READ_LIMITS.maxPageSize) throw artifactError("INVALID_REQUEST", "Invalid page size", `Page size must be between 1 and ${TEAM_READ_LIMITS.maxPageSize}.`);
  return limit;
}

function normalizeKinds(value: readonly TeamArtifactKind[] | undefined): readonly TeamArtifactKind[] {
  if (value === undefined) return ARTIFACT_KIND_ORDER;
  if (!Array.isArray(value) || value.length === 0 || value.length > ARTIFACT_KIND_ORDER.length || new Set(value).size !== value.length || value.some((kind) => !ARTIFACT_KIND_ORDER.includes(kind))) throw artifactError("INVALID_REQUEST", "Invalid artifact kinds", "Artifact kinds must be a non-empty unique supported list.");
  return ARTIFACT_KIND_ORDER.filter((kind) => value.includes(kind));
}

function normalizeStates(value: readonly TeamArtifactState[] | undefined): readonly TeamArtifactState[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length === 0 || value.length > 16 || new Set(value).size !== value.length || value.some((state) => !ARTIFACT_STATES.has(state))) throw artifactError("INVALID_REQUEST", "Invalid artifact states", "Artifact states must be a non-empty unique bounded supported list.");
  return [...value].sort();
}

function encodeArtifactCursor(cursor: ArtifactCursor): string {
  const encoded = Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
  if (Buffer.byteLength(encoded, "utf8") > MAX_CURSOR_BYTES) throw artifactError("INTERNAL_ERROR", "Workflow cursor is too large", "The bounded workflow cursor exceeded its limit.");
  return encoded;
}

function decodeArtifactCursor(value: string | undefined, corpusRevision: Revision, filterRevision: Revision, kindCount: number): ArtifactCursor | null {
  if (value === undefined) return null;
  if (Buffer.byteLength(value, "utf8") > MAX_CURSOR_BYTES) throw invalidArtifactCursor();
  let parsed: ArtifactCursor;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value || bytes.byteLength > MAX_CURSOR_BYTES) throw new Error();
    parsed = JSON.parse(new TextDecoder("utf8", { fatal: true }).decode(bytes)) as ArtifactCursor;
    if (parsed.v !== 1 || !Number.isInteger(parsed.kindIndex) || parsed.kindIndex < 0 || parsed.kindIndex >= kindCount || !Number.isInteger(parsed.memberOffset) || parsed.memberOffset < 0 || (parsed.innerCursor !== null && typeof parsed.innerCursor !== "string") || typeof parsed.corpusRevision !== "string" || typeof parsed.filterRevision !== "string") throw new Error();
  } catch {
    throw invalidArtifactCursor();
  }
  if (parsed.corpusRevision !== corpusRevision || parsed.filterRevision !== filterRevision) {
    throw artifactError("REVISION_CONFLICT", "Workflow cursor is stale", "The workflow artifact corpus or filter changed. Restart pagination.");
  }
  return parsed;
}

function invalidArtifactCursor() {
  return artifactError(
    "INVALID_REQUEST",
    "Invalid workflow cursor",
    "Workflow cursor is malformed or exceeds its bounded size.",
  );
}

function effectToLocalChange(effect: TeamWorkflowJournalEffect): LocalStateChange[] {
  if (effect.kind !== "local" || (effect.namespace !== "inbox-draft" && effect.namespace !== "relay-draft")) return [];
  return [{ namespace: effect.namespace, id: effect.id, beforeRevision: effect.beforeRevision, afterRevision: effect.afterRevision, summary: "Recovered local draft change" }];
}

function namespaceToArtifactKind(namespace: string): TeamArtifactKind | null {
  switch (namespace) {
    case "member": return "member";
    case "workstream": return "workstream";
    case "proposal": return "proposal";
    case "relay": return "relay";
    case "playbook": return "playbook";
    case "playbook-run": return "playbook_run";
    default: return null;
  }
}

function isWorkstreamState(value: TeamArtifactState): value is Workstream["state"] { return ["planned", "active", "blocked", "done", "archived"].includes(value); }
function isProposalState(value: TeamArtifactState): value is InboxProposal<JsonValue>["state"] { return ["pending", "approved", "rejected", "withdrawn", "stale"].includes(value); }
function isRelayState(value: TeamArtifactState): value is Relay["state"] { return ["published", "acknowledged", "closed"].includes(value); }
function isPlaybookState(value: TeamArtifactState): value is Playbook["state"] { return ["active", "archived"].includes(value); }
function isRunState(value: TeamArtifactState): value is PlaybookRun["state"] { return ["active", "completed"].includes(value); }

function assertNever(value: never): never {
  throw artifactError("INVALID_REQUEST", "Unsupported workflow action", `Unsupported workflow action ${String(value)}.`);
}
