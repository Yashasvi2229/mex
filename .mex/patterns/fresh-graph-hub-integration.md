---
name: fresh-graph-hub-integration
description: Connect graph reads and maintenance to the Project Hub without mixed snapshots, implicit writes, reranking, or private-data leakage.
triggers:
  - "Hub graph integration"
  - "Code workspace"
  - "graph Search"
  - "graph Hub job"
edges:
  - target: "safe-graph-snapshot-evolution.md"
    condition: "when changing freshness, graph storage, source binding, or recovery"
  - target: "secure-local-project-hub.md"
    condition: "when changing Hub routes, sessions, safe projections, SSE, or jobs"
  - target: "../../docs/design/hub-graph-integration.md"
    condition: "when reviewing the current Graph-to-Hub architecture and bounds"
grounds_to: []
last_updated: 2026-08-24
---

# Fresh Graph Hub Integration

## Context

The Hub is a consumer of the internal `GraphPort`, not another graph engine.
Graph reads may return source only after proving that indexed facts, the
published snapshot, and the exact live source bytes describe one repository
observation. Graph maintenance is a separate, explicit user action. The Hub
must not open graph SQLite directly, shell out to `mex graph`, fuse rankings,
or make Wiki availability appear real.

## Steps

1. Bind one package-private repository adapter to the Hub process. Implement the
   frozen `GraphPort` by calling Lane A modules directly; do not add a package-
   root export, raw SQLite callback, command escape hatch, or subprocess.
2. Route every graph-derived response through the complete freshness handshake:
   inspect a stable `fresh` graph, adopt one inode-bound immutable SQLite
   session, read graph facts and hash-matched contained source, build the whole
   bounded response in memory, revalidate database/snapshot/source freshness,
   and only then release it. Discard the complete response on any final mismatch.
3. Batch facts that must agree. Search symbols and sources through one
   `searchBundle()` session; assemble symbol identity, source, and the selected
   callers/callees/impact view through one `readSymbolWorkspace()` session.
4. Preserve engine order and scores. Keep Wiki, symbol, and source groups
   separate, with independent cursors and group-local cursor failures. Never
   rerank graph output or fuse scores across domains.
5. Bind each canonical base64url cursor to its operation, snapshot hash,
   normalized request (including limits and workspace view), and offset. Treat
   a request mismatch as `VALIDATION_FAILED` and a snapshot mismatch as
   `REVISION_CONFLICT`. Keep normal pagination separate from safety truncation.
6. Project only allowlisted fields into private Hub contracts. Bound source,
   paths, diagnostics, matched terms, relations, impact, and the serialized
   response. Map internal failures to stable MEX Problem Details without raw
   SQLite, Git, filesystem, recovery-path, stderr, or stack information.
7. Derive graph job eligibility from the current structured Health observation,
   then revalidate it immediately before durable job creation. For a non-fresh
   graph, a missing or unsafe remediation command is not an enabled control; a
   structurally fresh graph may explicitly allow both operations.
8. Run refresh/rebuild only through injected executors. Pass the job
   `AbortSignal` into Lane A, persist only fixed phases and trustworthy numeric
   counts, retain the Hub generation/lease checks, and let Lane A's cross-process
   maintenance lock arbitrate Hub and CLI writers. Rebuild requires the browser
   confirmation step; neither operation runs during an ordinary read.
9. Keep Wiki explicitly unavailable until its real adapter passes the frozen
   conformance boundary. Do not fill Graph or Wiki gaps with production fixtures.

## Gotchas

- A fresh status observed before a request is not a freshness proof for its
  response. Final revalidation is mandatory, including after source reads.
- An immutable SQLite handle still needs inode, sidecar, and snapshot binding.
  Atomic database replacement and WAL activity must fail visibly.
- Source must come from one contained, fd-stable buffer whose decoded hash
  matches the indexed row. Never pair an old declaration with newly read text.
- A group-specific bad cursor may fail only that Search group, but final
  freshness invalidation invalidates both graph groups and returns no partial data.
- `nextCursor` means another normal page exists; `truncated` means a safety or
  content bound omitted data. They are not interchangeable.
- Health capability is structural. A missing index can still expose a safe
  rebuild operation, while writer activity or an observation race exposes no
  repair control.
- Job progress messages can contain paths or source details. Persist phase and
  numeric counts only; discard the message.
- Successful graph maintenance invalidates cached Search, Code, Health, Jobs,
  and capability queries. It does not authorize automatic maintenance later.

## Verify

- [ ] Search and Code use one initial and one final freshness observation and
      return no partial response after database, snapshot, source, WAL, or ABA races
- [ ] Symbol/source ranking and relation ordering match the engine exactly
- [ ] Cursor operation, request, limit, view, and snapshot binding are covered
- [ ] Missing, stale, rebuild-required, corrupt, degraded, and interrupted
      states map to stable safe errors
- [ ] Source, relation, impact, diagnostic, cursor, and 1 MiB response bounds pass
- [ ] Host/session protection covers reads; Origin, JSON, and CSRF protect jobs
- [ ] Refresh/rebuild contention, cancellation, late progress, restart, and
      shutdown preserve the last trustworthy graph and never mutate source
- [ ] Read-only endpoints leave Graph/Wiki files, Git, worktree, Activity, and
      local state byte- and mtime-identical
- [ ] Packed Search/Code/Health and real refresh/rebuild jobs pass without public
      declaration leaks or production fixtures
- [ ] Graph protocol goldens, evaluator tests, TUI regressions, typechecks,
      browser accessibility, package smoke, and `git diff --check` pass

## Debug

First classify the failing boundary: request validation, current graph status,
immutable-session adoption, indexed source binding, final freshness, safe Hub
projection, durable job ownership, or Lane A maintenance. Preserve the stable
MEX code and reproduce the exact boundary. Do not fix freshness failures by
retrying inside an ordinary read or by returning the already-buffered subset.

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when Graph or Wiki Checkpoint 2 capability changes
- [ ] Update `docs/design/hub-graph-integration.md` when a bound, error, or
      freshness/job invariant changes
- [ ] Keep `src/index.ts`, graph protocol output, ranking, and `mex tui` unchanged
      unless a separate public-boundary change explicitly owns them
