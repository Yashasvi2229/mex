# MEX Graph Eval Harness

Black-box evaluation of the `mex graph` agent surface. Every measurement shells
out to the built CLI (`dist/cli.js`) exactly as an agent would — no internals are
imported.

## Run

```bash
npm run build      # harness runs against dist/cli.js, so build first
npm run eval
```

Flags (pass after `--`, e.g. `npm run eval -- --no-rebuild`):

- `--root <dir>` — evaluate a different subject repo (default: this repo).
- `--no-rebuild` — reuse the existing `.mex/graph.db` instead of rebuilding.
- `--no-gate` — report only; don't exit non-zero on gate failure.

Results are written to `evaluate/results/` (gitignored): `efficiency.{json,csv}`
and `search-quality.{json,csv}`.

## Categories

**Category 1 — retrieval efficiency** (`efficiency.mjs`). For each task, compares
`graph scope` output size against the grep top-3 baseline and the whole source
corpus, and checks expected-symbol recall. The grep baseline, corpus enumeration,
recall rule, and `ceil(chars/4)` token count are reproduced bit-for-bit from the
prior ad-hoc benchmark so numbers stay comparable (see
`claude-talks/graph/EVAL_HARNESS_BUILD_PLAN.md` §3).

**Category 2 — search quality** (`search-quality.mjs`). `where-defined` foundRate
and rank (the committed gate); who-calls / what-calls fan-out counts for
visibility. Labeled caller/callee recall + MRR are a documented follow-up.

**Category 3 — end-to-end agent** (`agent-e2e.mjs`, `npm run eval:e2e`). Runs each
variant against the natural-language tasks and estimates accumulated CLI-output
tokens across scope and follow-up `graph get` calls. It also records fallback
calls exposed by a driver and rubric correctness. Reduced from the plan's A–D:
variant A (old all-source scope) was removed in the M2 redesign, and C/D
(flow-spine source, skeletonization) were deferred — so the buildable comparison
is `minimal` vs `source`, which sets the shipped default `--detail`.

Model-agnostic: the default **scripted reference driver** is a perfectly
disciplined agent (scope first; expand ids via `graph get`; never grep). It gives
an idealized token baseline but cannot reveal Read/Grep fallback — plug a real
model with `--driver <module>` (default-exports `(variant) => driver`) for a
correctness/fallback verdict.

**Real-model runner** (`agent-e2e-model.mjs`, `node evaluate/agent-e2e-model.mjs`):
drives a real headless agent (`claude -p`) per variant×task using the actual graph
CLI, and parses the stream-json transcript for tool calls, fallbacks, reported
cost, turns, and rubric correctness. It does not currently aggregate raw transcript
tokens. Requires the `claude` CLI on PATH. Flags: `--root`, `--limit <n>`,
`--model <name>`.

Real-model result (opus-4-8, 5 NL tasks, this repo):

| variant | correct | mean cost | mean turns | mean get | mean Read/Grep fallback |
|---|---|---|---|---|---|
| minimal | 5/5 | $0.20 | 4.4 | 2.2 | 0.0 |
| source  | 5/5 | $0.17 | 3.0 | 0.0 | 1.0 |

Both variants answered every task correctly — the real model navigates the compact
manifest fine (the scripted driver's ~0.6 NL "recall" was a grading artifact, not a
real recall gap). `source` is answer-ready (fewer turns, marginally cheaper) but
falls back to Read/Grep ~once/task when its inline source is insufficient;
`minimal` is self-sufficient (zero fallback) at the cost of extra `get` round-trips.
Cost numbers are cache-dominated and noisy at N=5, so correctness and fallback are
the robust signals. `minimal` is the v0.7.0 default; `source` remains available for
one-shot use.

The scripted driver reports `minimal` at about 1,871 estimated output tokens per
task with one `get` round-trip and `source` at about 1,433 in one shot. Its 0.6
correctness score is a grading artifact: it grades retrieved text without model
reasoning. The real-agent run answered all five tasks correctly with both modes
and is the correctness source of truth.

The current harness does **not** compare an agent with the graph against the same
agent using only Read/Grep/Glob. Therefore these results do not support an
end-to-end graph-vs-no-graph token-savings claim. That requires a controlled
three-arm experiment with raw usage aggregation, wider task coverage, and repeated
runs.

## Current release result

On the mex repository (six symbol tasks), the post-M2 compact retrieval surface
measured:

- median grep-top-3-to-scope ratio: **10.74×**;
- median whole-corpus-to-scope ratio: **916.38×**;
- expected-symbol recall: **1.0**;
- `runDriftCheck`: **5.90×** grep efficiency with 9 facts, improved from 0.26×
  and 32 source-bearing facts.

See [RESULTS.md](RESULTS.md) for the dated run, per-task table, real-agent
transcript summary, and caveats.

## Gates

`thresholds.json` holds the hard CI gates (floors, not exact-match assertions,
since numbers drift as the code evolves):

- `medianGrepTop3ToScope >= 1.0`
- `scopeExpectedRecall >= 0.85` (per task)
- `whereDefinedFoundRate >= 0.95`

Historical baseline (prior benchmark on `cg-main`): median grep-top3 ratio 1.35,
median corpus ratio 120.55, mean recall 1.0, `runDriftCheck` = 32 facts (the
known over-expansion case).

## Determinism

Graph reads are ordered deterministically (stable `ORDER BY` in
`src/graph/db/store.ts`), so a rebuilt graph yields byte-identical query output.
Unit coverage: `src/graph/__tests__/store-determinism.test.ts`.
