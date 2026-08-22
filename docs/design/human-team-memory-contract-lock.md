# Human-Team Memory Contract Lock

Status: provisional consumer contract and mock verified; teammate adapter pending

This brief records the proposed application boundary for the MEX OSS human-team
memory program. It remains provisional until the teammate implementation is
pinned and passes the same suite. It is an implementation aid, not authorization to widen the
product scope described in the user-approved build program.

## Source authority and pins

Sources are applied in this order:

1. The user's request and explicit scope decisions.
2. `wiki-engine-build-spec.md`, supplied by the user, SHA-256
   `4a79b2d679a35bda1243ac736edb320da16e8ca54129dac3186df93bf12aa0b8`.
3. `PLAN.md`, the human-team delivery program and its exclusions.
4. The OSS roadmap for Markdown-canonical, deterministic, migration,
   evaluation, and privacy principles. Its versions and timeline are not part
   of this implementation contract.
5. Reference implementations, only within the limits below.

Reference revisions:

- MEX base: `48da30ceea54c8716b561c7ba08541df99024e9b` (`v0.7.2`).
- TencentDB-Agent-Memory `feat/server_team`:
  `97f94654280b2932c35ba4806a491999ed244cc9`.
- Local `mex-mono` knowledge-graph reference:
  `fa64878f05a4dde85a02c3da9e39a336cd2e2646`.

The Tencent source is control-panel, backend-for-frontend, explicit-job, and
health/error UX inspiration only. No Tencent service topology, central database,
repository cloning, scheduled synchronization, agent hierarchy, proxy, or
business-response envelope is adopted.

The teammate Wiki implementation branch and commit do not currently exist or
are not yet available. The supplied Wiki build spec is authoritative for design,
but it is not proof of implementation identity. Consequently:

- the consumer contracts, behavioral mock, fixture, and conformance suite may
  progress;
- no real Wiki adapter is claimed;
- no parity assertion against teammate types is claimed;
- the real adapter test remains blocked until an exact branch and commit are
  provided.

## Integration ownership

This feature branch is the integration owner for shared conflict hotspots:
root manifests and lockfile, CLI registration, root exports, `.gitignore`,
templates, compatibility documentation, and final cross-workstream wiring.
Checkpoint 0 intentionally changes none of those hotspots.

The internal contract surface is under `src/team/contracts`. It is not exported
from the package root yet; doing so would create a public semver commitment
before the real adapter passes the suite.

## Provisional consumer boundary

The contract files define:

- shared entity, code, actor, repository, revision, lifecycle, grounding,
  job, diagnostic, pagination, diff, and problem types;
- canonical, derived, local, and ephemeral ownership rules;
- `WikiPort`, `GraphPort`, `GitPort`, `TeamWorkflowPort`, and `HealthPort`;
- strictly explicit index mutation methods;
- no database handle, SQL row, generic shell command, Git mutation, or
  unrestricted file-write escape hatch.

The Wiki read projection exposes the stable fields needed by consumers: body,
summary, exact source location, lifecycle, semantic revision and content hash,
topics, relations and backlinks, sources, provenance, canonical groundings,
checkout-local grounding resolution, and diagnostics. Engine-only extensions,
operation-specific payloads, patch plans, and migration plans remain generic.
Consumer code must not reproduce the engine's Markdown AST or SQLite schema, or
open `.mex/wiki.db` directly.

Canonical mutation ownership is path-partitioned. The Wiki adapter owns its
context, pattern, Spec, topic, and accepted-operation paths. It may parse and
index team-workflow Markdown, but `TeamWorkflowPort` remains the only canonical
writer for member, Workstream, Inbox, Relay, activity, and Playbook paths.

### Required adapter normalization

The real Wiki adapter must normalize these differences without leaking them to
Hub or workflow consumers:

- Wiki `entity.type` becomes `EntityRef.kind`.
- Entity versions retain both the Wiki engine's numeric semantic revision and a
  lower-case SHA-256 hash of the exact containing canonical file bytes.
  Operation preconditions revalidate both values for an existing entity.
- Wiki grounding health maps as follows:
  - `fresh` -> `fresh`;
  - `stale` -> `changed`;
  - `missing` -> `missing`;
  - unresolved with multiple candidates -> `ambiguous`;
  - unresolved, ungrounded, or unavailable graph -> `unverified`;
  - a successfully reconciled rename or move -> `fresh`.
- Entity lifecycle is never derived from grounding health.
- Canonical groundings remain separate from checkout-local resolution. The
  shared application health mapping is retained for filtering while the
  authoritative `fresh | stale | missing | unresolved | ungrounded` resolution
  state remains visible per grounding.
- Aggregate grounding health uses deterministic worst-first precedence:
  `missing`, `ambiguous`, `changed`, `unverified`, then `fresh`; an entity with
  no canonical grounding is `unverified`.
- Engine-specific failures normalize to stable MEX error codes while retaining
  detailed diagnostics.
- Auto-rebuild is disabled at the adapter boundary. Reads, search, validation,
  health, doctor, and Hub page loads never rebuild or launch an agent.
- Filesystem adapters must validate lexical repository-relative paths and then
  verify realpath containment; a symlink must not escape the repository or
  scaffold root.

Operation proposal and patch plan are separate types. The caller provides the
authoritative typed envelope with an engine-owned payload; preview returns the
engine-produced opaque patch plan plus exact diff. Apply requires that plan and
preview hash, immediately revalidates revisions, and either applies the complete
operation or performs no canonical write. An exact retry of an accepted
operation ID is idempotent; reuse with a different payload is a validation
failure.

## Consumer-owned verification

`test/contracts/wiki-port.contract.ts` is a reusable Vitest conformance suite.
The current registration uses the in-memory behavioral mock. A teammate adapter
must register the same suite rather than replacing it with adapter-owned tests.

The mock proves consumer-facing ordering, filtering, bounds, read non-mutation,
preview/apply conflicts, idempotency, scoped refresh behavior, typed failures,
and abstract migration behavior. It does not prove the future engine's Markdown
parser, byte-range patcher, SQLite publication/recovery, filesystem atomicity,
symlink defense, graph-produced grounding provenance, or apply-time ULID
generation. Those claims require the pinned real adapter and its integration
fixtures.

The populated fixture exercises a payment-reliability knowledge slice with
topics, Specs, requirements, acceptance criteria, current and deprecated
decisions, patterns, risks, evidence, typed relations, backlinks, and every
consumer grounding-health state. A separate legacy scaffold preserves existing
prose, frontmatter, `edges`, `grounds_to`, `mex://` links, paths, and the legacy
decision event stream during migration testing.

The graph protocol goldens independently freeze the exact protocol-v3 JSONL
emitted by the graph command handlers for:

- default source-bearing `mex graph scope`;
- `mex graph get` with found and missing IDs;
- `mex graph query who-calls`;
- meta-first, summary-last framing and canonical single-line JSON encoding.

These tests exercise the serializer/handler boundary through injected graph
dependencies. Commander registration and process-level CLI wiring remain covered
by the existing CLI suites; they are not represented as full-process goldens.
The new tests do not change graph retrieval, ranking, token budgets, or existing
CLI serialization.

## Explicit exclusions

Do not implement as part of this program:

- Context Compiler, Context Plans, Context Packets, delta packets, or Task State;
- agent context injection;
- changes to code-graph retrieval or ranking;
- automatic knowledge promotion;
- background semantic reconciliation or dreaming;
- scheduled agents or continuous model work;
- automatic contradiction claims;
- centralized team code graphs;
- authentication, permissions, SSO, or multi-tenancy;
- CRDT or multiplayer editing;
- raw transcript storage;
- executable Playbooks;
- new team MCP tools;
- Docker, Compose, remote Hub exposure, or hosted MEX behavior;
- Git staging, commits, pushes, checkouts, or branch creation by the MEX product.

The last item constrains runtime product behavior. It does not prevent normal
developer branching and commits explicitly requested for this implementation.

## Checkpoint status

Implemented as a provisional consumer draft:

- source revision pins and ownership record;
- shared application contracts and stable required error codes;
- complete Wiki read projections, bounded relation APIs, and explicit index
  refresh/rebuild methods;
- typed operation metadata with engine-owned operation and migration payloads;
- populated behavior mock and legacy fixture;
- reusable Wiki conformance suite;
- protocol-v3 graph golden regressions;
- explicit exclusions and integration-owner assignment.

Pending before Checkpoint 0 can be fully closed:

- exact teammate implementation branch and commit;
- confirmation that the teammate parser accepts the final canonical team paths;
- real Wiki adapter implementation;
- contract-suite and type-parity results against that pinned implementation.

Downstream lanes may compile against the mock for interface development, but
must treat it as a test double rather than proof of parser, index, patcher,
grounding, or migration compliance. They must not invent alternate
Wiki storage, entity, relationship, operation, migration, or grounding behavior
while the real adapter is pending.

## Verification commands

```bash
npx vitest run test/wiki-port-mock.contract.test.ts
npx vitest run src/graph/__tests__/protocol-v3-golden.test.ts
npm run typecheck
npm test
npm run build
```
