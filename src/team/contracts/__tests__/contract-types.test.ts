import { describe, expect, it } from "vitest";
import type { HealthComponent } from "../index.js";
import type { GitHealth, MigrationHealth } from "../health.js";
import type { FileChange } from "../shared.js";
import type { ActivityEvent, TeamWorkflowCommand } from "../workflow.js";

type IsAssignable<TValue, TTarget> = [TValue] extends [TTarget] ? true : false;
type AssertTrue<TValue extends true> = TValue;
type AssertFalse<TValue extends false> = TValue;

type ValidCreateChange = {
  kind: "create";
  path: "docs/new.md";
  beforeRevision: null;
  afterRevision: string;
  diff: string;
};

type ImpossibleCreateChange = Omit<ValidCreateChange, "beforeRevision"> & {
  beforeRevision: string;
};

type RevisionBoundCommandWithoutExpectation = {
  operationId: "op-update";
  actor: { kind: "unknown" };
  occurredAt: "2026-08-22T00:00:00.000Z";
  expectedRevisions: readonly [];
  action: {
    kind: "workstream.update";
    workstreamId: "ws_contract";
    patch: { summary: "updated" };
  };
};

type RevisionBoundCommandWithExpectation = Omit<
  RevisionBoundCommandWithoutExpectation,
  "expectedRevisions"
> & {
  expectedRevisions: readonly [{
    target: { kind: "entity"; id: "ws_contract" };
    revision: string;
    semanticRevision: 1;
  }];
};

type ImpossibleHealthyGit = {
  status: "healthy";
  summary: "clean";
  diagnostics: readonly [];
  repo: null;
};

type ImpossibleReadyMigration = {
  status: "unavailable";
  summary: "ready";
  diagnostics: readonly [];
  state: "ready";
  fromVersion: null;
  toVersion: null;
};

type ActivityWithFileAndCommitSubjects = Omit<ActivityEvent, "subjects"> & {
  subjects: readonly [
    { kind: "file"; path: "src/index.ts" },
    { kind: "commit"; hash: "48da30c" },
  ];
};

type _CreateShapeAccepted = AssertTrue<IsAssignable<ValidCreateChange, FileChange>>;
type _ImpossibleCreateRejected = AssertFalse<
  IsAssignable<ImpossibleCreateChange, FileChange>
>;
type _UpdateWithExpectationAccepted = AssertTrue<
  IsAssignable<RevisionBoundCommandWithExpectation, TeamWorkflowCommand<unknown>>
>;
type _UpdateWithoutExpectationRejected = AssertFalse<
  IsAssignable<RevisionBoundCommandWithoutExpectation, TeamWorkflowCommand<unknown>>
>;
type _HealthyGitRequiresRepo = AssertFalse<IsAssignable<ImpossibleHealthyGit, GitHealth>>;
type _UnavailableMigrationCannotBeReady = AssertFalse<
  IsAssignable<ImpossibleReadyMigration, MigrationHealth>
>;
type _ActivitySupportsRepositorySubjects = AssertTrue<
  IsAssignable<ActivityWithFileAndCommitSubjects, ActivityEvent>
>;
type _HealthComponentIsBarrelExported = AssertTrue<IsAssignable<GitHealth, HealthComponent>>;

describe("compiled team contract invariants", () => {
  it("is included in both TypeScript and Vitest verification", () => {
    expect(true).toBe(true);
  });
});
