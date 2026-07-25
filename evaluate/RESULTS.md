# Graph retrieval benchmark results

Scripted harness run: 2026-07-25

Real-agent run: 2026-07-22

Subject: mex repository on the `code-graph-preview` line

Harness: `evaluate/` (`npm run eval`, `npm run eval:e2e`, and
`node evaluate/agent-e2e-model.mjs`)

## Subject graph

| Metric | Value |
|---|---:|
| Files indexed | 154 |
| Nodes | 1,867 |
| Edges | 2,892 |
| Graph build time | 7.2 s |
| Harness corpus | 252 source files |
| Harness corpus size | 733,605 estimated tokens |

The harness uses `ceil(chars/4)` as a deterministic, model-agnostic token
estimate for retrieval output. It is not a tokenizer measurement.

## Retrieval efficiency

`mex graph scope <task>` was compared with the top three files returned by the
committed grep baseline.

| Task | Grep top-3 tokens | Scope tokens | Returned facts | Grep/scope ratio |
|---|---:|---:|---:|---:|
| `computeScore` | 2,915 | 345 | 2 | 8.45× |
| `runScan` | 11,023 | 782 | 6 | 14.10× |
| `runGraphScope` | 9,714 | 820 | 6 | 11.85× |
| `runImpact` | 9,714 | 821 | 6 | 11.83× |
| `buildSyncBrief` | 4,786 | 496 | 3 | 9.65× |
| `runDriftCheck` | 7,042 | 1,194 | 9 | 5.90× |

| Aggregate | Result |
|---|---:|
| Median grep-top-3-to-scope ratio | **10.74×** |
| Median whole-corpus-to-scope ratio | **916.38×** |
| Expected-symbol recall | **1.0** |
| `where-defined` found rate | **1.0** |
| Exact-match rank | **1 for every task** |

Before compact, budgeted retrieval, the median grep-top-3-to-scope ratio was
1.34×. The `runDriftCheck` case was an over-expansion outlier at 0.26× with 32
source-bearing facts; it now returns 9 compact facts at 5.90×.

## Real-agent detail-mode comparison

A headless Claude run used five natural-language tasks to compare the default
two-stage `minimal` mode with one-shot inline `source` mode.

| Variant | Correct | Mean reported cost | Mean turns | Mean `graph get` calls | Mean Read/Grep fallback |
|---|---:|---:|---:|---:|---:|
| `minimal` | 5/5 | $0.20 | 4.4 | 2.2 | 0.0 |
| `source` | 5/5 | $0.17 | 3.0 | 0.0 | 1.0 |

Both modes answered every task correctly. `minimal` never fell back to Read/Grep
and instead followed precise `graph get` expansion handles. `source` used fewer
turns but fell back on four of five tasks when the inline source did not cover the
answer. This result supports `minimal` as the predictable default while keeping
`--detail source` available.

## Limits on interpretation

- The sample is small: six symbol tasks and five natural-language tasks.
- It covers one mid-size repository and one model.
- Reported model cost is prompt-cache dominated and varied by roughly 35%;
  correctness and fallback behavior are the stronger signals.
- The retrieval ratio compares one graph response with a synthetic grep baseline.
- The agent comparison tests two graph detail modes. It does not include a
  no-graph arm and does not aggregate raw transcript tokens.

These results therefore validate retrieval compactness, recall, determinism, and
agent navigation behavior. They do not establish an end-to-end
graph-versus-no-graph token-savings claim.

## Reproduce

```bash
npm run build
npm run eval
npm run eval:e2e
node evaluate/agent-e2e-model.mjs
```

The real-model runner requires the Claude CLI and incurs model usage. The first
three commands are local and deterministic.
