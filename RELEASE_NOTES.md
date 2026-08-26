# mex 0.7.3 — Graph performance and recovery

mex 0.7.3 makes the code graph affordable to keep. 0.7.2 traded memory, build time, and disk for a compiler-backed graph and deferred the cleanup to a follow-up release. This is that release: `mex check` no longer rebuilds anything, graph builds hold one compiler program at a time, stores are roughly 36-40% smaller, and a graph left behind by an interrupted command can be repaired instead of rebuilt.

It is a maintenance release. Retrieval behavior, the JSONL protocol, scaffold formats, and grounding anchors are unchanged.

## What changed

- **`mex check` never stages the graph.** The grounding pass previously synchronized the graph whenever any source file's timestamp had moved, which in an actively edited repository meant nearly every run. Because a synchronize re-stages the whole corpus, a routine drift check silently paid a full rebuild's memory and wall-clock cost. `mex check` now opens the last published graph read-only and reports how far behind it is, leaving rebuilds to `mex graph`.
- **One compiler program alive at a time.** TypeScript extraction held every discovered project's program and type checker simultaneously, so peak memory was the sum of all of them. Extraction is now a capture pass per project followed by a compiler-free finishing pass. Cross-project resolution already flowed through declaration locations that are stable across programs, so each program can be released as soon as its own files are captured.
- **Smaller stores (schema v3).** The fingerprint and locality-sensitive-hashing tables were 40-50% of a typical store: a JSON text MinHash sketch per node, plus 32 index rows per node each repeating the full node id and a 64-character hexadecimal band hash, plus a secondary index over all of it. v3 stores the sketch as a 256-byte binary value, keys index rows on an integer reference, truncates band hashes to 64-bit integers, and uses the composite primary key as the only index.
- **The semantic type-check pass is opt-in.** Parser health has always been computed from syntactic diagnostics, and reference resolution queries the type checker directly, so the full per-file semantic pass contributed diagnostic detail only. Its cost scales with how much of the dependency tree the compiler can resolve, which is why two checkouts of one repository on one machine could differ enormously in build time. Discovered projects are also configured with `skipLibCheck` and `noEmit`.
- **`mex graph repair`.** An interrupted writer can leave a large uncheckpointed write-ahead log, which read-only commands then refuse to open, and the only previous remedy was a full rebuild. `mex graph repair` checkpoints the log and runs an integrity check in place, in seconds.
- **A build survives a hostile file.** A source file that trips an internal assertion in the TypeScript compiler used to abort the entire build with nothing written. The affected project is now isolated and its files fall back to Tree-sitter extraction. Two same-identity declarations in one file are ordinal-disambiguated instead of aborting corpus staging.
- **A real memory leak is fixed.** Tree-sitter parse trees live in the WebAssembly heap and are not reclaimed by the JavaScript garbage collector. They were never released, so every parsed file leaked for the lifetime of the process, and each file was parsed twice.

## Measurements

Paired builds of the same repositories before and after, producing identical node, edge, and fingerprint counts:

| Repository | Peak build memory | Build wall clock | Store size |
|---|---|---|---|
| 3,254 files, 92 TypeScript projects | 5.17 GB → 2.11 GB | 448 s → 309 s | 700.1 MB → 451.1 MB |
| 494 files, single project | unchanged (~1.2 GB) | 195 s → 189 s | 269.8 MB → 162.9 MB |

Memory reduction scales with the number of TypeScript projects in a repository, because that is what was being held concurrently. Single-project repositories keep their previous peak and still get the smaller store. The fingerprint and LSH tables shrank by roughly 86% and are no longer the largest consumer in a store; `unresolved_refs` and the source-chunk full-text index now are.

Separately, a 39,312-file repository with 205 TypeScript projects and several thousand deliberately malformed fixture files now builds to completion for the first time, at 3.1 GB peak memory. Previous releases aborted on the first fixture that tripped a compiler assertion.

## Upgrade and compatibility

mex 0.7.3 requires Node.js 22.5 or newer, unchanged from 0.7.2.

```bash
npm install -g mex-agent@0.7.3
```

Existing Markdown scaffolds remain valid, and serialized `mh:64:` grounding anchors are unchanged.

A schema-v2 store migrates to v3 losslessly the next time a writing command runs — `mex graph`, `mex sync`, or `mex graph ground`. No rebuild is required for the migration itself and existing groundings continue to resolve immediately. Read-only commands report the usual rebuild guidance until a writing command has run. Schema-v1 stores still need a one-time rebuild, unchanged from 0.7.2.

The compiler extractor version advances in this release, so the first `mex graph` after upgrading performs a full rebuild. After that rebuild, graph content is unchanged apart from nodes and edges that previously aborted the build or were missing entirely.

To recover a graph left behind by an interrupted build or check:

```bash
mex graph repair
```

## Known tradeoff

Peak build memory is now bounded by the largest single TypeScript project rather than by the whole repository, which is a floor rather than a ceiling: a repository whose one project covers tens of thousands of files still needs that project in memory at once. Streaming extraction below that floor remains future work, as does incremental synchronization — `mex graph` still re-stages the full corpus for a single changed file, though `mex check` no longer triggers it. Within a store, `unresolved_refs` and the source-chunk full-text index are the remaining storage targets.
