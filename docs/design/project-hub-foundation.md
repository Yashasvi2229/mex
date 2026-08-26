# Project Hub Foundation

Status: Lane B foundation complete; Graph and Wiki integrations recorded separately

This document records the Lane B foundation as it originally landed. Its
Graph- and Wiki-unavailable statements are historical slice boundaries,
superseded by [`hub-graph-integration.md`](hub-graph-integration.md) and
[`hub-wiki-readonly.md`](hub-wiki-readonly.md).

Functional reference: TencentDB-Agent-Memory commit
`97f94654280b2932c35ba4806a491999ed244cc9`, limited to explicit asynchronous
status/progress, bounded workbench summaries, and partial-failure visibility.
Its visuals, remote topology, credentials, response envelope, and product
taxonomy are not adopted.

The Project Hub is a desktop-oriented, local control room for one repository.
It adds a browser surface without changing the public library API, terminal UI,
or code-graph retrieval behavior. At the Lane B boundary, production data
remained truthful: repository context, local job history, and repository-backed
team activity could be shown, while unavailable Graph and Wiki capabilities
were labelled rather than simulated.

## Runtime flow

```text
mex hub
  -> acquire repository Hub lease and reconcile local jobs
  -> bind 127.0.0.1 on an assigned or explicit port
  -> create one-use five-minute bootstrap token
  -> browser fragment posts token to /api/v1/session/bootstrap
  -> HttpOnly process-memory session + in-memory CSRF token
  -> authenticated same-origin API and bounded job SSE
```

The fragment keeps the bootstrap secret out of HTTP request targets and server
logs. It is accepted once, exchanged for a 12-hour absolute session, and removed
from the visible URL. The server trusts neither forwarded-host headers nor CORS.
Mutation routes additionally require the exact loopback Origin, JSON media type,
and `X-MEX-CSRF` value.

## Components and ownership

- `packages/hub-contracts` owns the private, runtime-validated wire schemas. It
  is bundled into the CLI and does not become a package-root export.
- `src/hub` owns the Hono application, native loopback listener, security,
  manifest-only static serving, honest read projections, and job orchestration.
- `packages/hub-web` owns the React shell, route states, shared-contract client,
  and development-only visual fixture.
- `.mex/local/team.db` owns per-user job summaries and the repository Hub lease.
  Its schema v2 transactionally preserves Lane C member selection and Catch Up
  cursor rows. Canonical Markdown is never written by the Hub foundation.

The browser receives direct resource bodies. Failures use RFC-style
`application/problem+json` with stable MEX codes and request IDs. Adapter error
details are projected through a safe allowlist so local paths, stderr, and stack
traces cannot cross the HTTP boundary.

The Activity read model combines Lane C's canonical event artifacts with the
legacy decision JSONL without rewriting either source. Its cursor is bound to a
deterministic timeline revision. Pagination and source safety truncation remain
separate, canonical metadata and legacy cwd/trace/origin fields are omitted,
and recorded actors are returned alongside—not replaced by—their current alias
resolution. Home reports only the exact trusted canonical-event count.

## Job lifecycle

Jobs use the frozen states:

```text
queued -> running -> succeeded | failed | interrupted
```

Graph refresh/rebuild and Wiki refresh/rebuild kinds are registered, but Lane B
ships no production executors for them. Starting an unavailable kind returns
`CAPABILITY_UNAVAILABLE`. A transactional partial unique index permits one
active index mutation per scaffold. A token-bound process lease prevents a
second live Hub from reconciling or releasing the first process's work.

Executors receive an `AbortSignal` and emit allowlisted phases with monotonic
numeric counts. Unknown totals remain indeterminate. User cancellation requests
abort but keep the active slot until the executor settles; restart and shutdown
interruptions have distinct reasons. Late callbacks are generation-checked and
ignored. Persisted records are bounded and never contain source bodies, prompts,
transcripts, diffs, arbitrary commands, or secrets.

## Browser experience

The shell represents every planned route, with complete Home, Search, Health,
Jobs, and read-only Activity states. Activity is a date-grouped canonical and
legacy feed with bounded provenance, revision-safe pagination, and explicit
partial-read diagnostics. Knowledge, Code, Workstreams, Specs, Playbooks,
Inbox, and Relays remain capability-aware foundations rather than fake CRUD.
Search keeps Wiki, symbol, and source groups independent, including independent
partial failure, and never fuses their scores.

The UI is desktop-only at 1024 pixels and wider. It uses a persistent sidebar,
compact repository context, a balanced dashboard grid, self-hosted fonts, CSS
Modules, semantic design tokens, keyboard/focus handling, and reduced-motion
support. Fixture data is compile-time development/test input and is absent from
the production bundle.

## Original Lane B boundaries

- No remote bind, proxy trust, hosted authentication, telemetry, or outbound assets.
- Graph status and maintenance were deferred to the later Graph integration.
- Wiki read, search, health, and maintenance were deferred to the later Wiki
  integration.
- No Workstream, Inbox, Relay, Spec, or Playbook mutation in Lane B.
- No Activity creation or Catch Up cursor advancement in the read-only Hub slice.
- No change to `src/index.ts`, graph retrieval/ranking, protocol-v3 JSONL, or `mex tui`.

## Verification

The release gates cover API contracts and limits, security expiry and rejection,
static-path containment, job leases and lifecycle, schema migration/rollback,
browser routes and accessibility, deterministic visual baselines, production
fixture absence, packed-install bootstrap, public declaration leaks, existing
graph protocol goldens, TUI regressions, evaluator tests, and diff hygiene.
