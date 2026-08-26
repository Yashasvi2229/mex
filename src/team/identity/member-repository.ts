import { readdirSync } from "node:fs";
import type { FileChange, RepoRelativePath, Revision } from "../contracts/shared.js";
import { isRevision } from "../contracts/shared.js";
import type { MemberGitAlias, TeamMember } from "../contracts/workflow.js";
import {
  MEMBER_ARTIFACT_MAX_BYTES,
  memberArtifactPath,
  parseMemberArtifact,
  serializeMemberArtifact,
} from "../artifacts/codecs.js";
import { artifactError } from "../artifacts/errors.js";
import {
  assertContainedArtifactDirectory,
  atomicCreateArtifact,
  atomicReplaceArtifact,
  tryReadContainedArtifact,
  withContainedArtifactLock,
} from "../artifacts/filesystem.js";
import { generateArtifactId } from "../artifacts/ulid.js";
import { revisionOf } from "../artifacts/revision.js";
import { canonicalFileDiff } from "../artifacts/unified-diff.js";
import { normalizeGitEmail } from "./aliases.js";

const MEMBERS_DIRECTORY = ".mex/team/members" as RepoRelativePath;

export interface MemberCreateInput {
  id?: string;
  displayName: string;
  gitAliases?: readonly MemberGitAlias[];
  active?: boolean;
}

export interface MemberUpdatePatch {
  displayName?: string;
  gitAliases?: readonly MemberGitAlias[];
  active?: boolean;
}

export interface MemberRepositoryOptions {
  idFactory?: () => string;
}

export interface MemberReader {
  get(memberId: string): Promise<TeamMember | null>;
  list(): Promise<readonly TeamMember[]>;
}

interface MemberWritePlanBase {
  previewRevision: Revision;
  member: TeamMember;
  change: FileChange;
  /** Canonical bytes bound into previewRevision; apply revalidates before writing. */
  document: string;
  /** Exact prior canonical bytes for an update; null for a create. */
  beforeDocument: string | null;
}

export type MemberWritePlan =
  | (MemberWritePlanBase & {
      kind: "create";
      beforeRevision: null;
      beforeDocument: null;
    })
  | (MemberWritePlanBase & {
      kind: "update";
      beforeRevision: Revision;
      beforeDocument: string;
    });

export interface MemberWriteResult {
  previewRevision: Revision;
  member: TeamMember;
  change: FileChange;
}

/** Strict canonical repository for one-file-per-human member artifacts. */
export class MemberRepository implements MemberReader {
  readonly #projectRoot: string;
  readonly #idFactory: () => string;

  constructor(projectRoot: string, options: MemberRepositoryOptions = {}) {
    this.#projectRoot = projectRoot;
    this.#idFactory = options.idFactory ?? (() => generateArtifactId("member"));
  }

  async get(memberId: string): Promise<TeamMember | null> {
    const path = memberArtifactPath(memberId);
    const stored = tryReadContainedArtifact(this.#projectRoot, path, MEMBER_ARTIFACT_MAX_BYTES);
    return stored === null ? null : parseMemberArtifact(stored.bytes, path);
  }

  async list(): Promise<readonly TeamMember[]> {
    const directory = assertContainedArtifactDirectory(this.#projectRoot, MEMBERS_DIRECTORY);
    if (directory === null) return [];

    const paths = readdirSync(directory, { withFileTypes: true })
      .filter((entry) => entry.name.endsWith(".md"))
      .map((entry) => {
        if (!entry.isFile()) {
          throw artifactError(
            "PATH_OUTSIDE_PROJECT",
            "Unsafe member artifact",
            `Member entry ${entry.name} must be a regular file.`,
          );
        }
        return `${MEMBERS_DIRECTORY}/${entry.name}` as RepoRelativePath;
      })
      .sort(compareCodePoints);

    return paths.map((path) => {
      const stored = tryReadContainedArtifact(this.#projectRoot, path, MEMBER_ARTIFACT_MAX_BYTES);
      if (stored === null) {
        throw artifactError(
          "REVISION_CONFLICT",
          "Member changed during listing",
          `Member ${path} disappeared while members were being listed.`,
          path,
        );
      }
      return parseMemberArtifact(stored.bytes, path);
    });
  }

  async create(input: MemberCreateInput): Promise<TeamMember> {
    const preview = await this.previewCreate(input);
    return (await this.apply(preview, preview.previewRevision)).member;
  }

  async previewCreate(input: MemberCreateInput): Promise<MemberWritePlan> {
    const id = input.id ?? this.#idFactory();
    const path = memberArtifactPath(id);
    const document = serializeMemberArtifact({
      id,
      displayName: input.displayName,
      gitAliases: input.gitAliases ?? [],
      active: input.active ?? true,
    });
    const candidate = parseMemberArtifact(document, path);
    if (await this.get(id) !== null) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Member already exists",
        `Member ${id} already exists.`,
        path,
      );
    }
    await this.#assertUniqueEmails(candidate, null);
    const change: FileChange = {
      kind: "create",
      path,
      beforeRevision: null,
      afterRevision: candidate.revision,
      diff: canonicalFileDiff(path, null, document),
    };
    return freezePlan({
      kind: "create",
      beforeRevision: null,
      member: candidate,
      change,
      document,
      beforeDocument: null,
      previewRevision: previewRevision("create", null, change, document),
    });
  }

  async update(
    memberId: string,
    patch: MemberUpdatePatch,
    expectedRevision: Revision,
  ): Promise<TeamMember> {
    const preview = await this.previewUpdate(memberId, patch, expectedRevision);
    return (await this.apply(preview, preview.previewRevision)).member;
  }

  async previewUpdate(
    memberId: string,
    patch: MemberUpdatePatch,
    expectedRevision: Revision,
  ): Promise<MemberWritePlan> {
    if (!isRevision(expectedRevision)) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid member revision",
        "Expected member revision must be a lower-case SHA-256 digest.",
      );
    }
    const current = await this.get(memberId);
    if (current === null) {
      throw artifactError("NOT_FOUND", "Member not found", `Member ${memberId} does not exist.`);
    }
    if (current.revision !== expectedRevision) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Member revision conflict",
        `Member ${memberId} no longer matches the expected revision.`,
        current.sourcePath,
      );
    }

    const document = serializeMemberArtifact({
      id: memberId,
      displayName: patch.displayName ?? current.displayName,
      gitAliases: patch.gitAliases ?? current.gitAliases,
      active: patch.active ?? current.active,
    });
    const candidate = parseMemberArtifact(document, current.sourcePath);
    await this.#assertUniqueEmails(candidate, memberId);
    const beforeRead = tryReadContainedArtifact(
      this.#projectRoot,
      current.sourcePath,
      MEMBER_ARTIFACT_MAX_BYTES,
    );
    if (beforeRead === null || beforeRead.revision !== current.revision) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Member changed during preview",
        `Member ${memberId} changed while its preview was being prepared.`,
        current.sourcePath,
      );
    }
    const before = new TextDecoder("utf-8", { fatal: true }).decode(beforeRead.bytes);
    const change: FileChange = {
      kind: "update",
      path: current.sourcePath,
      beforeRevision: current.revision,
      afterRevision: candidate.revision,
      diff: canonicalFileDiff(current.sourcePath, before, document),
    };
    return freezePlan({
      kind: "update",
      beforeRevision: current.revision,
      member: candidate,
      change,
      document,
      beforeDocument: before,
      previewRevision: previewRevision("update", current.revision, change, document, before),
    });
  }

  async apply(
    plan: MemberWritePlan,
    expectedPreviewRevision: Revision,
  ): Promise<MemberWriteResult> {
    this.#assertPlanIntegrity(plan, expectedPreviewRevision);
    return withContainedArtifactLock(
      this.#projectRoot,
      MEMBERS_DIRECTORY,
      ".members.mex-lock",
      async () => {
        const candidate = this.#assertPlanIntegrity(plan, expectedPreviewRevision);
        if (plan.kind === "create") {
          if (await this.get(candidate.ref.id) !== null) {
            throw artifactError(
              "REVISION_CONFLICT",
              "Member preview is stale",
              `Member ${candidate.ref.id} was created after this preview.`,
              candidate.sourcePath,
            );
          }
          await this.#assertUniqueEmails(candidate, null);
          atomicCreateArtifact(this.#projectRoot, candidate.sourcePath, plan.document);
        } else {
          const current = await this.get(candidate.ref.id);
          if (current === null || current.revision !== plan.beforeRevision) {
            throw artifactError(
              "REVISION_CONFLICT",
              "Member preview is stale",
              `Member ${candidate.ref.id} changed after this preview.`,
              candidate.sourcePath,
            );
          }
          await this.#assertUniqueEmails(candidate, candidate.ref.id);
          if (candidate.revision !== current.revision) {
            atomicReplaceArtifact(
              this.#projectRoot,
              candidate.sourcePath,
              plan.beforeRevision,
              plan.document,
            );
          }
        }
        return {
          previewRevision: plan.previewRevision,
          member: candidate,
          change: plan.change,
        };
      },
    );
  }

  #assertPlanIntegrity(plan: MemberWritePlan, expectedPreviewRevision: Revision): TeamMember {
    if (!isRevision(expectedPreviewRevision) || expectedPreviewRevision !== plan.previewRevision) {
      throw artifactError(
        "REVISION_CONFLICT",
        "Member preview revision conflict",
        "The member preview does not match the revision approved by the caller.",
      );
    }
    const member = parseMemberArtifact(plan.document, plan.member.sourcePath);
    if (plan.kind === "create" && plan.beforeDocument !== null) {
      throw artifactError("VALIDATION_FAILED", "Invalid member preview", "Create preview contains prior bytes.");
    }
    if (plan.kind === "update") {
      const before = parseMemberArtifact(plan.beforeDocument, plan.member.sourcePath);
      if (before.revision !== plan.beforeRevision || before.ref.id !== member.ref.id) {
        throw artifactError("VALIDATION_FAILED", "Invalid member preview", "Update preview prior bytes are invalid.");
      }
    }
    const expectedChange: FileChange = plan.kind === "create"
      ? {
          kind: "create",
          path: member.sourcePath,
          beforeRevision: null,
          afterRevision: member.revision,
          diff: canonicalFileDiff(member.sourcePath, null, plan.document),
        }
      : {
          kind: "update",
          path: member.sourcePath,
          beforeRevision: plan.beforeRevision,
          afterRevision: member.revision,
          diff: canonicalFileDiff(member.sourcePath, plan.beforeDocument, plan.document),
        };
    const recomputed = previewRevision(
      plan.kind,
      plan.beforeRevision,
      expectedChange,
      plan.document,
      plan.beforeDocument,
    );
    if (
      recomputed !== plan.previewRevision
      || plan.change.kind !== expectedChange.kind
      || plan.change.path !== expectedChange.path
      || plan.change.beforeRevision !== expectedChange.beforeRevision
      || plan.change.afterRevision !== expectedChange.afterRevision
      || plan.change.diff !== expectedChange.diff
      || !sameMember(plan.member, member)
    ) {
      throw artifactError(
        "VALIDATION_FAILED",
        "Invalid member preview",
        "The member preview payload was modified after it was produced.",
      );
    }
    return member;
  }

  async #assertUniqueEmails(candidate: TeamMember, excludedMemberId: string | null): Promise<void> {
    const candidateEmails = new Set(
      candidate.gitAliases
        .map((alias) => normalizeGitEmail(alias.email))
        .filter((email): email is string => email !== null),
    );
    if (candidateEmails.size === 0) return;

    for (const member of await this.list()) {
      if (member.ref.id === excludedMemberId) continue;
      const collision = member.gitAliases.some((alias) => {
        const email = normalizeGitEmail(alias.email);
        return email !== null && candidateEmails.has(email);
      });
      if (collision) {
        throw artifactError(
          "VALIDATION_FAILED",
          "Duplicate Git identity",
          `Member ${candidate.ref.id} reuses an email already assigned to ${member.ref.id}.`,
          candidate.sourcePath,
        );
      }
    }
  }
}

function previewRevision(
  kind: "create" | "update",
  beforeRevision: Revision | null,
  change: FileChange,
  document: string,
  beforeDocument: string | null = null,
): Revision {
  return revisionOf(JSON.stringify({
    kind,
    beforeRevision,
    path: change.path,
    afterRevision: change.afterRevision,
    diff: change.diff,
    beforeDocument,
    document,
  }));
}

function freezePlan<T extends MemberWritePlan>(plan: T): T {
  for (const alias of plan.member.gitAliases) Object.freeze(alias);
  Object.freeze(plan.member.gitAliases);
  Object.freeze(plan.member.ref);
  Object.freeze(plan.member);
  Object.freeze(plan.change);
  return Object.freeze(plan);
}

function sameMember(left: TeamMember, right: TeamMember): boolean {
  return left.schemaVersion === right.schemaVersion
    && left.kind === right.kind
    && left.sourcePath === right.sourcePath
    && left.revision === right.revision
    && left.ref.id === right.ref.id
    && left.ref.kind === right.ref.kind
    && left.ref.title === right.ref.title
    && left.displayName === right.displayName
    && left.active === right.active
    && JSON.stringify(left.gitAliases) === JSON.stringify(right.gitAliases);
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
