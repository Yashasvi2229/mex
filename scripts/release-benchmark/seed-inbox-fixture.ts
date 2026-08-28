import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InboxProposalRepository } from "../../src/team/artifacts/workflow-repositories.js";
import {
  inboxDraftInputFromProduct,
  productDraftProjection,
  productProposalProjection,
} from "../../src/team/inbox/spec-authoring.js";
import { TeamLocalState } from "../../src/team/local-state/index.js";
import type { JsonValue } from "../../src/team/contracts/shared.js";
import type {
  TeamInboxSpecDraftInput,
} from "../../src/team/contracts/workflow.js";

const FIXED_TIME = "2026-08-01T00:00:00.000Z";
const FIXTURE_ACTOR = Object.freeze({
  kind: "git" as const,
  name: "MEX Release Benchmark",
  email: "release-benchmark@example.invalid",
});

const [mode, rootValue, scaffoldId, draftId, proposalId, specId, specPathValue] = process.argv.slice(2);
if (
  (mode !== "canonical" && mode !== "local")
  || !rootValue
  || !scaffoldId
  || !draftId
  || !proposalId
  || !specId
  || !specPathValue
) {
  throw new Error("Usage: seed-inbox-fixture <canonical|local> <root> <scaffold-id> <draft-id> <proposal-id> <spec-id> <spec-path>");
}

const root = resolve(rootValue);
if (specPathValue !== `.mex/specs/${specId}.md`) {
  throw new Error("The release Inbox fixture Spec path must match its fixed entity ID.");
}
const specPath = join(root, specPathValue);
const specRevision = createHash("sha256").update(readFileSync(specPath)).digest("hex");

const proposalInput: TeamInboxSpecDraftInput = {
  change: {
    kind: "spec.update",
    target: {
      id: specId,
      kind: "spec",
    },
    patch: {
      title: "Release benchmark pending Spec update",
      summary: "A deterministic pending proposal exercised by the release gate.",
      body: "This exact pending change remains reviewable and is never applied by the benchmark.",
    },
  },
  rationale: "Review the deterministic release benchmark Spec update before publication.",
  evidence: [{ kind: "manual", note: "Pinned release benchmark fixture" }],
  targetRevisions: [{
    target: { kind: "entity", id: specId },
    revision: specRevision,
    semanticRevision: 1,
  }],
};

const localDraftInput: TeamInboxSpecDraftInput = {
  change: {
    kind: "spec.create",
    entityKind: "requirement",
    title: "Release benchmark local draft Requirement",
    summary: "One deterministic checkout-local Inbox draft.",
    body: "The draft stays local until an explicit publish action creates canonical proposal content.",
    status: "in_flight",
  },
  rationale: "Keep one bounded local draft available for the Inbox release workbench.",
  evidence: [{ kind: "manual", note: "Pinned release benchmark fixture" }],
  targetRevisions: [],
};

if (mode === "canonical") {
  const stored = inboxDraftInputFromProduct(
    proposalInput,
    "release_benchmark_pending_proposal",
  );
  const proposals = new InboxProposalRepository<JsonValue>(root, {
    idFactory: () => proposalId,
  });
  const preview = await proposals.previewCreate({
    id: proposalId,
    author: FIXTURE_ACTOR,
    rationale: stored.rationale,
    evidence: stored.evidence,
    request: stored.request,
    targetRevisions: stored.targetRevisions,
  });
  const applied = await proposals.apply(preview, preview.previewRevision);
  const projection = productProposalProjection(
    applied.artifact,
  );
  const page = await proposals.list({ limit: 100, states: ["pending"] });
  if (
    page.items.length !== 1
    || page.nextCursor !== null
    || page.truncated !== false
    || page.sourceTruncated !== false
    || page.items[0]?.ref.id !== proposalId
    || page.items[0]?.state !== "pending"
    || page.items[0]?.sourcePath !== `.mex/inbox/${proposalId}.md`
    || projection === null
    || projection === undefined
    || projection.ref.id !== proposalId
    || projection.state !== "pending"
    || projection.title !== "Release benchmark pending Spec update"
  ) {
    throw new Error("The release proposal fixture does not round-trip through the production projection.");
  }
} else {
  const local = new TeamLocalState({
    projectRoot: root,
    scaffoldId,
    now: () => FIXED_TIME,
  });
  const stored = local.saveLocalDraft({
    id: draftId,
    kind: "inbox",
    payload: inboxDraftInputFromProduct(
      localDraftInput,
      "release_benchmark_local_draft",
    ),
    expectedRevision: null,
    updatedAt: FIXED_TIME,
  });
  const projection = productDraftProjection({
    id: stored.id,
    kind: "inbox",
    revision: stored.revision,
    updatedAt: stored.updatedAt,
    ...stored.payload,
  });
  const page = local.listLocalDrafts({ kind: "inbox", limit: 100 });
  if (
    page.items.length !== 1
    || page.nextCursor !== null
    || projection?.id !== draftId
    || projection.title !== "Release benchmark local draft Requirement"
  ) {
    throw new Error("The release draft fixture does not round-trip through the production projection.");
  }
}
