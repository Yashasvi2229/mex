---
name: local-first-team-state
description: Safe workflow for canonical team Markdown, immutable activity, read-only Git observations, and local SQLite state.
triggers:
  - "team member"
  - "activity event"
  - "Catch Up cursor"
  - "local team state"
edges:
  - target: "context/architecture.md"
    condition: "when connecting team state to Hub, Wiki, or graph consumers"
  - target: "context/conventions.md"
    condition: "when changing canonical serialization or validation"
grounds_to: []
last_updated: 2026-08-28
---

# Local-First Team State

## Context

Lane C is an internal boundary. Canonical members and activity are one-file-per-record,
Git-tracked Markdown; configured identity and Catch Up cursors are per-user SQLite
under `.mex/local/`. Legacy `events/decisions.jsonl` stays byte-for-byte compatible.

## Steps

1. Validate IDs, paths, schema, bounds, and privacy before preparing bytes.
2. Produce deterministic UTF-8/LF frontmatter and SHA-256 revisions.
3. Preview canonical mutations without writes; apply only the exact reviewed plan
   after optimistic and containment revalidation.
4. Capture repository facts through the fixed read-only Git port. Never expose a
   raw Git command, stage, commit, or silently repair state during a read.
5. Keep local SQLite reads immutable. Create or migrate only inside an explicit
   write transaction, and require exact revisions plus explicit branch resets.
6. Preserve recorded actors/events. Resolve current display identity as a separate
   projection and surface ambiguity instead of guessing.
7. Serialize mixed canonical/local workflows behind one repository workflow
   lease. Journal only bounded IDs, revisions, paths, hashes, authority, and
   phase state; publish canonical bytes before local cleanup.
8. Treat exact replay as a bounded retained window. A completed journal row is
   terminal proof; incomplete replay must prove branch/HEAD and every durable
   effect before writing, cleaning up, or advancing a phase.

## Gotchas

- SQLite read-only mode can still create WAL/SHM sidecars; use the validated
  immutable read path and refuse active sidecars.
- A page-size limit does not bound a filesystem scan. Cap corpus bytes, rows,
  directory entries, diagnostics, and cursor size as well as returned items.
- Symlink checks must cover every path component immediately before I/O.
- Do not copy the permissive legacy event writer or the process-global Git helper
  into team-state code.
- Production code writes files only. Git publication belongs to the human or test
  harness.
- A page cursor must bind both its filter and the complete bounded corpus
  revision; a position-only cursor can silently skip records after mutation.
- Filesystem collection locks need bounded owner metadata and proven-dead
  recovery. Never remove a live, malformed, foreign-root, or symlinked lock.
- A process-local Wiki patch handle is not recovery state. Persist a body-free
  manifest before apply, require a new preview when nothing landed, and resume
  only an exact operation-specific audit prefix when canonical bytes landed.
- A signed preview that must survive a process restart cannot re-plan a create
  with fresh random identifiers. Bind every engine-minted identifier in the
  receipt, force those exact identifiers during re-plan, and compare the whole
  reviewed presentation before journal intent. Reject hidden batch containers
  as well as disallowed top-level operations when a product facade promises a
  narrower write scope.

## Verify

- [ ] Golden bytes, revisions, preview no-write, stale-plan, and containment tests pass
- [ ] Git reads leave HEAD, index, worktree, and hooks untouched
- [ ] Local-state reads leave database bytes, mtimes, and directory entries untouched
- [ ] Legacy JSONL bytes and mtime remain unchanged
- [ ] Two independent clones merge unique records without same-file conflicts
- [ ] Typecheck, full tests, eval tests, build, package dry-run, declarations, and diff check pass

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when internal capabilities become working or public
- [ ] Update this pattern when a new persistence/concurrency gotcha is discovered
