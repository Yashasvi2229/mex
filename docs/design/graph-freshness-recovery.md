# Graph freshness and recovery

Status inspection and graph maintenance are intentionally separate. Ordinary
reads call the immutable inspector and never create, migrate, checkpoint,
refresh, or rebuild `.mex/graph.db`. Maintenance happens only after a user runs
an explicit graph command or another already-mutating workflow such as setup or
grounding sync acquires the same maintenance lease.

## Commands

- `mex graph status` inspects repository, corpus, compiler inputs, schema,
  snapshot provenance, graph invariants, fingerprints, and SQLite sidecars.
- `mex graph refresh` restages the semantic corpus through the existing
  correctness-first sync path. “Refresh” is not a claim of incremental speed.
- `mex graph rebuild` builds a same-directory candidate, validates it, and
  atomically publishes it. Bare `mex graph` is a compatibility alias.

Refresh accepts only a compatible, inspectable live index. Rebuild also handles
missing, incompatible, and corrupt indexes. A per-project owner-token lock spans
staging, publication, and any subsequent grounding writes. Candidates and
rollback copies use uniquely owned ignored paths. Before publication, MEX
revalidates the live database, candidate identity, exact snapshot bytes, and
absence of authoritative WAL or rollback-journal data. A failed operation leaves
the prior trustworthy graph byte-identical; a replaced corrupt or incompatible
database is retained locally as `.mex/graph.db.recovery-*`.

## Targeted retrieval handshake

`graph get`, `graph query`, and `impact` first require a stable `fresh` status
observation. They then adopt one immutable SQLite connection for graph and
grounding reads, bind it to the inspected inode and exact `graph_snapshot_v1`
bytes, and buffer the complete JSONL response. Source ranges come from one
contained, fd-stable byte buffer whose UTF-8 decoded hash matches the indexed
file row. Immediately before output, MEX repeats freshness and database identity
validation; any mismatch discards the whole response and emits one bounded
`GRAPH_UNAVAILABLE` record.

`graph scope` deliberately retains its existing stale-file text-only fallback.
It now uses a single stable immutable database snapshot, but it does not claim
that stale live text is an indexed graph fact. Retrieval ranking and successful
protocol-v3 records remain unchanged.

## Evaluator identity

The normalized evaluator hash includes all semantic snapshot fields: schema,
compiler/extractor/resolver versions, grammar/config/manifest hashes, source
corpus identity, semantic positive and negative inputs, and parse health. It
excludes only indexing timestamps, Git branch/HEAD, and the metadata row
timestamp. Malformed, unknown, or future snapshot shapes fail closed.

## Performance characterization

Run the non-gating benchmark after a build:

```bash
npm run benchmark:graph-status
```

The harness creates deterministic committed TypeScript repositories, performs
an explicit rebuild, warms the CLI, and reports fresh `graph status --json`
latency plus source/database sizes and the full Node/SQLite/OS/CPU environment.
It never applies a wall-clock pass/fail threshold.

An Apple M4 / Node 22.17.1 / SQLite 3.50.0 characterization on 2026-08-23 used
two warmups and seven measured fresh-status processes per fixture:

| Sources | Source bytes | Graph DB | Status median | Status p95 | Rebuild |
|---:|---:|---:|---:|---:|---:|
| 100 | 81,329 | 9,715,712 B | 579 ms | 656 ms | 1,211 ms |
| 400 | 326,129 | 38,195,200 B | 714 ms | 1,035 ms | 4,037 ms |

These numbers include CLI process startup and are a local trend reference, not a
release claim. The 400-file graph was roughly four times the stored graph size;
fresh status remained sub-second at the median on this machine. Larger source
corpora and graphs still require ongoing measurement.
