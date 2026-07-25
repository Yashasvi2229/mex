# mex 0.7.0 — Code-aware project memory

mex 0.7.0 adds a deterministic code knowledge graph beneath the existing markdown scaffold. Memory can now ground itself to exact code nodes instead of relying only on file paths, so mex can tell an agent precisely which symbol changed and which surrounding code or scaffold memory is affected.

The graph is local, zero-AI infrastructure: tree-sitter extraction writes SQLite in `.mex/graph.db`, body hashes detect edits, and MinHash fingerprints reconcile confident renames and moves.

## What is included

- TypeScript, TSX, JavaScript, JSX, Python, and Rust extraction.
- Cross-file calls, imports, inheritance, containment, and reference edges.
- An Express reference resolver linking route registrations to handler nodes.
- Grounding checker #12 for changed, moved, ambiguous, or removed code nodes.
- Compact, scored task neighborhoods through `mex graph scope`, with deterministic ordering, explicit selection reasons, and hard estimated-token budgets.
- Targeted source expansion through `mex graph get`, with source remaining opt-in for scope, query, and impact commands.
- Setup-time grounding plus an idempotent migration path for existing scaffolds.
- Durable re-grounding of frontmatter and inline anchors during `mex sync`.
- A contributor-facing extractor test pattern in the source repository.

## New commands

```bash
mex graph
mex graph --json
mex graph scope <task>
mex graph get <node-id>
mex graph ground
mex graph query where-defined <symbol>
mex graph query who-calls <symbol>
mex graph query what-calls <symbol>
mex impact <symbol-or-file>
```

`mex graph scope`, `mex graph query`, `mex graph get`, and `mex impact` emit a framed JSONL protocol intended for coding agents to call during setup, repair, and implementation tasks. The default `minimal` detail returns compact structural facts and relationship counts. Use `--detail standard` for returned-node edges, `--detail source` for inline source, or `mex graph get <node-id>` to expand only the exact nodes needed.

## Retrieval results

The release harness measured `mex graph scope` against a grep top-3 baseline on six symbol tasks in this repository:

- The median grep-top-3-to-scope output ratio was **10.74×** by the documented `ceil(chars/4)` estimate.
- Expected-symbol recall remained **1.0**.
- The former `runDriftCheck` over-expansion case improved from 32 source-bearing facts and 0.26× grep efficiency to 9 compact facts and 5.90× grep efficiency.

In a five-task real-agent comparison, both `minimal` and `source` modes answered 5/5 correctly. `minimal` used targeted `graph get` calls and never fell back to Read/Grep; `source` needed Read/Grep fallback on four tasks. That is why `minimal` is the default.

These measurements are intentionally narrow: one mid-size repository, six symbol tasks, five natural-language tasks, and one model. They compare graph output with a synthetic grep baseline and compare two graph detail modes; they do **not** measure end-to-end graph-versus-no-graph token savings.

## Grounded scaffold memory

Setup now authors grounding as it populates memory. It follows **read broad, ground tight**: read the relevant scope neighborhood, then ground only prose claims that depend on specific behavior. Broad architecture, stack, and convention files remain sparse; pattern and deep-domain files ground tightly.

Behavioral assertions use frontmatter with both a node id and fingerprint:

```yaml
grounds_to:
  - node: "function:a3f8...c21"
    fingerprint: "mh:64:9f2a..."
```

Load-bearing symbol mentions use readable inline navigation anchors containing only the node id:

```markdown
[`calculateCheckoutTotal()`](mex://function:a3f8...c21)
```

An unchanged node is clean. A body edit produces a grounding warning with old/new source for sync. Sync repairs the prose when needed, refreshes the frontmatter fingerprint, and updates or removes stale anchors. A high-confidence rename is rebound automatically; an uncertain candidate is surfaced for agent adjudication. Broken inline navigation remains warning-only.

## Installation and upgrades

mex 0.7.0 requires Node.js 22.5 or newer because the graph uses Node's built-in SQLite module.

```bash
npx mex-agent@0.7.0 setup
```

Fresh `mex setup` runs build the graph before population, and the setup agent consumes it through the hydrated retrieval commands while authoring grounding.

Existing populated scaffolds remain valid, but need a one-time pointer migration to participate in graph drift detection:

```bash
mex graph
mex graph ground
```

`mex graph ground` preserves the existing prose and adds tight `grounds_to` entries plus load-bearing `mex://` anchors. It is safe to rerun. Scaffolds that have not migrated continue to behave as before under the original eleven checkers.

## Graceful degradation

The graph is additive. If no graph exists, a grammar is unavailable, or SQLite cannot load on a platform, mex skips graph grounding and continues running the rest of `mex check`. Unsupported-language files are skipped rather than crashing graph construction.

## What comes next

The 0.7.x series will broaden language and framework coverage through bounded extractor and resolver contributions, tune reconciliation and retrieval on larger repositories, and add a controlled graph-vs-no-graph agent benchmark.
