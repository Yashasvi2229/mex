# Relay Handoff Contract

Status: Checkpoints F0-F3 implemented and registered; F4 release calibration remains gated

This brief freezes the smallest repository-native Relay product: a local draft
becomes one canonical handoff, one eligible recipient claims it, and the
original sender or claimant closes it. Relay carries structured project state;
it does not deliver messages, start agents, notify external systems, or execute
work.

## Lifecycle and authority

The only lifecycle is `local draft -> published -> acknowledged -> closed`.
Published content is immutable. There is no decline, withdraw, reassignment,
reopen, administrative override, or direct close from `published`.

Draft reads and save/update/delete are checkout-local and do not require a
current Member, Git identity, Wiki index, recipient lookup, or Workstream
lookup. A draft names between one and 32 unique canonical Member recipients;
the sender may also be a recipient. References to Decisions, code, files, and
evidence are historical context and are not freshness dependencies.

Publication resolves the current actor to one active canonical Member, either
through the explicit checkout-local selection or one unique active Git alias.
It also proves that every recipient is active and that the Workstream is
`planned`, `active`, or `blocked`. The exact expectation set contains the local
draft, Workstream, and every recipient Member revision, with no duplicates,
omissions, semantic revisions, or unrelated targets. These facts are checked
again under the repository workflow lease immediately before publication and
when an unpublished intent is recovered.

Any listed active recipient may acknowledge. Exact Relay revision conflict
semantics make the first successful acknowledgement the sole claimant. Close
requires `acknowledged`; the active recorded sender or active recorded
claimant may close, and both recorded principals must still be active. Every
authorization comparison uses `memberId`, never display name or whole actor
object equality. Legacy Git/unknown/inactive principals remain readable but
cannot act; reactivation is the only recovery for a stranded Relay.

## Canonical artifacts and activity

New publications use strict Relay artifact schema v2 and service-owned
`published_at`. It equals the `relay.published` Activity timestamp and the
signed authority timestamp. Lifecycle timestamps satisfy
`published_at <= acknowledged_at <= closed_at`.

Strict schema-v1 Relays remain readable and byte-preserving. Their public
projection exposes `publishedAt: null` and a page or detail returns one bounded
aggregate warning. Acknowledging or closing a v1 Relay retains schema v1; there
is no migration or opportunistic rewrite.

Publication writes the Relay and exactly one `relay.published` Activity before
deleting the exact local draft. Acknowledge and close each write exactly one
Activity. Every event has the Relay as subject and retains the Relay's
Workstream association. Authority time, actor, branch, HEAD, dirty state, IDs,
and Activity bytes are service-owned.

## Signed portable operations

The internal facade exposes `getRelayDraft`, `listRelayDrafts`, `getRelay`,
`listRelays`, `previewRelay`, and `applyRelay`. Its closed action union contains
only draft save/delete, publish, acknowledge, and close.

Relay receipts use the independent signing domain
`mex.team.relay.receipt.v1`. The aggregate envelope is limited to 64 KiB; the
receipt to 8 KiB, depth eight, 128 nodes, two generated purposes, 30 minutes of
age, and five seconds of future clock skew. A valid stored draft can therefore
still receive a typed envelope-too-large preview failure.

Generated purposes are exact and canonically sorted:

- new draft: `relay-draft`;
- draft update/delete: none;
- publish: `activity`, `relay`;
- acknowledge/close: `activity`.

Apply accepts only the complete signed envelope, revalidates its presentation,
purpose IDs, authority, root, repository state, and exact dependencies, and
retains generic workflow journaling, lease, containment, recovery, replay, and
privacy guarantees. A signer lost before intent requires a new preview; once
intent exists, bounded journal effects authenticate exact recovery.

## CLI and agent discovery

The registered machine tree is `mex relay contract --json`, `mex relay draft
list|show|save|delete`, `mex relay list|show`, `mex relay publish`, `mex relay
acknowledge`, and `mex relay close`. Mutations preview a caller-authored JSON
request and apply only the complete successful wrapper through
`--apply <preview-envelope>`; request fragments, altered wrappers, reconstructed
receipts, and mismatched action commands are rejected before a repository
service is opened.

The static resolver publishes the strict roots
`https://mex.dev/contracts/team-relay-request-v1.json` and
`https://mex.dev/contracts/team-relay-preview-envelope-v1.json`, the full
command inventory, examples, runtime-only invariants, and Team exit codes. It
works without Git, Home state, or `.mex`, is capped at 64 KiB, and is included
in packed installs. Ordinary `mex capabilities --json` advertises only the
`team_relay` availability record and compact `relay.contract` resolver
descriptor so every lifecycle manifest remains within 32 KiB. Existing Team,
Inbox, Wiki, Code Graph, and Graph repair descriptors remain unchanged.

## Reads and perspectives

Canonical reads accept `mine | sent | all`, lifecycle states, Workstream,
limit, and a revision/filter-bound cursor. The service default is `all`.
`mine` includes a published Relay addressed to the current Member and an
acknowledged or closed Relay claimed by that Member. `sent` compares recorded
sender `memberId`. Without an active current Member, `mine` and `sent` return
`UNAUTHORIZED`; `all` and local draft operations continue to work.

Filters run before pagination. Timestamped Relays sort by `publishedAt`
descending and ID descending; legacy null timestamps follow, ID descending.
Drafts sort by `updatedAt` and ID descending. Cursors bind perspective, state,
Workstream, current Member, filter, and corpus revision.

## Bounds, errors, and exclusions

Relay retains the workflow foundation's 64 KiB artifact, 2,048 record,
32 MiB corpus, 4,096 directory-entry, 100-result, 100-diagnostic, 4 KiB cursor,
512 local-draft, 8 KiB summary, 4 KiB item, and 64-entry structured collection
bounds. The product recipient bound is 32.
Local draft identifiers use the checkout-local ASCII identifier grammar and
are limited to 128 bytes.

Malformed lifecycle or dependency sets use `VALIDATION_FAILED`; absent targets
use `NOT_FOUND`; changed authority or revision uses `REVISION_CONFLICT`; absent
Member authority or the wrong principal uses `UNAUTHORIZED`. Reads never
initialize or migrate local state, rebuild Wiki/Graph data, invoke a model, or
make outbound requests.

F adds no package-root export, new public semver commitment, version bump,
release, deployment, Playbook, Catch Up, notification, external transport,
automatic delivery, or agent execution surface.
