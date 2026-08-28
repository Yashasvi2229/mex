---
name: safe-graph-snapshot-evolution
description: Evolve graph indexing or freshness checks without publishing mixed facts, mutating reads, or losing the last trustworthy snapshot.
triggers:
  - "graph freshness"
  - "graph snapshot"
  - "graph indexing"
  - "graph recovery"
  - "SQLite graph"
edges:
  - target: "../context/architecture.md"
    condition: "when changing the graph data plane or its consumers"
  - target: "../context/conventions.md"
    condition: "when verifying a graph implementation change"
grounds_to: []
last_updated: 2026-08-28
---

# Safe Graph Snapshot Evolution

## Context

The graph database is both a query surface and the grounding baseline for drift
checks. A graph that is internally valid but represents mixed source, config,
Git, or compiler observations is not trustworthy. Ordinary inspection must also
remain read-only: SQLite recovery, schema repair, indexing, and grounding writes
belong only to explicit maintenance workflows.

## Steps

1. Define source extensions, ignore rules, config inputs, grammar identity, and
   extractor/resolver versions in one corpus policy shared by indexing and
   freshness inspection.
2. Discover source and config inputs through repository-contained canonical
   paths. Bind each read to a regular-file descriptor and verify the original
   path still resolves to the same inode after the read.
3. Make parsers and compiler extraction consume the captured bytes. Do not let
   a downstream compiler host silently re-read live source or config files.
4. Revalidate Git coordinates, the exact source corpus, config inputs, and any
   additional semantic inputs at the final boundary before publication.
5. Persist a versioned provenance snapshot in the same transaction as graph
   facts. A failed stage, parse, invariant check, or publication race must not
   advance snapshot metadata.
6. Inspect with raw read-only/immutable SQLite access only after checking WAL,
   rollback-journal, containment, and file identity. Validate every schema
   object and data shape required by graph readers before reporting `fresh`.
7. Preserve the prior trustworthy graph when an explicit rebuild candidate is
   incomplete or failed. Build under a repository-scoped owner-token lock,
   validate a same-directory candidate, revalidate the live database, and only
   then publish by atomic rename. Surface failure rather than printing a
   successful no-op summary.
8. Guard graph-derived reads for their complete use window. If the database or
   selected path changes, discard the whole batch of derived findings. Bind any
   returned live source to one contained fd-stable byte buffer whose decoded
   hash matches the indexed row, so an A→B→A edit cannot escape validation.
9. Keep retrieval ranking and protocol-v3 record shapes untouched unless the
   task explicitly changes that public boundary; rerun the exact JSONL goldens.
10. Normalize evaluator provenance field-by-field. Exclude only explicitly
    operational snapshot fields; malformed or future snapshot shapes must fail
    closed instead of disappearing from the semantic graph hash.

## Gotchas

- Size and mtime are hints, not content identity. Same-size edits can restore an
  mtime and still require reindexing.
- An immutable SQLite connection assumes its file never changes. A clean probe
  before opening is insufficient; revalidate around and after graph use.
- A live WAL may contain the current schema while the main file looks stale or
  corrupt. Treat writer activity as transient/degraded, never durable damage.
- `PRAGMA quick_check` does not prove application compatibility. FTS shadow
  tables, fingerprint JSON, LSH bands, ownership, and dangling references need
  explicit invariants.
- A schema version integer is not lineage proof. When independently developed
  stores reused version 3, migration had to inspect the complete compact
  fingerprint/LSH and generalized-grounding shapes before choosing a lossless
  v4 path. Partial or ambiguous shapes require rebuild rather than inference.
- Source bytes can change A→B→A while a compiler runs. Final source hashing alone
  cannot detect facts extracted from B; extraction must be bound to A.
- Graph diagnostics and remediation commands must be truthful. Do not recommend
  a command for a state it cannot safely repair.
- Wall-clock status timings vary by machine and process-start overhead. Keep
  the benchmark non-gating, record its environment, and protect correctness
  with deterministic race, non-mutation, and bounded-work tests.

## Verify

- [ ] Added, modified, deleted, same-size/restored-mtime, branch, config,
      grammar, extractor, and policy drift cases are deterministic.
- [ ] Active/unreadable WAL and rollback journals never produce `fresh` or a
      false corruption diagnosis.
- [ ] Missing, legacy, newer, malformed, and structurally corrupt schemas have
      accurate diagnostics and safe remediation.
- [ ] Every recognized historical lineage and complete hybrid migrates through
      a locked candidate; partial hybrids fail without changing prior bytes.
- [ ] Source/config symlink escape, retarget, atomic replacement, and ABA tests
      preserve the prior snapshot.
- [ ] Failed parse/stage/publication tests preserve prior facts and metadata.
- [ ] Candidate replacement, candidate WAL, rollback, maintenance-lock, and
      first-publication failure tests leave either the prior graph or no graph.
- [ ] Ordinary check, doctor, dashboard, and status paths do not change graph
      bytes, sidecars, metadata, or directory mtimes.
- [ ] `get`, `query`, and `impact` return no partial records when freshness,
      source identity, sidecars, or the selected database change mid-read.
- [ ] `npm run typecheck`, `npm test`, `npm run eval:test`, and `npm run build`
      pass, along with protocol-v3 goldens and `git diff --check`.
- [ ] Only intended paths are staged; generated graph databases and unrelated
      working-tree files remain excluded.

## Debug

First separate transient writer activity from durable corruption. Compare the
persisted snapshot, exact `files(path, content_hash)` rows, current corpus and
config hashes, Git observations, and required reader invariants. When a race
test fails, verify which layer re-read the filesystem after secure discovery;
fix that boundary instead of adding timing delays.

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when freshness, refresh, or recovery capabilities
      move from "Not Built" to "Working".
- [ ] Add new graph failure modes to this pattern after they are reproduced and
      covered by a deterministic regression.
