# Release performance baseline

Status: Checkpoint A benchmark contract. Built-asset and runtime budgets are
frozen. Runtime budgets were characterized by pinned CI run
[`33005876613`](https://github.com/mex-memory/mex/actions/runs/33005876613).
Checkpoint C's bundle and route assets, including Members and Activity, were
characterized by pinned CI run
[`33083122092`](https://github.com/mex-memory/mex/actions/runs/33083122092),
then copied from that retained report using the same formulas before the
enforcing rerun. The retained `release-performance-1` artifact (ID
`9651219193`, report SHA-256
`f83a69133fa916bfd15deed8c107a561b885c0170abb1d44d8820825a76c7c83`)
measured PR head `76cbd154def06dec29325a2ed67687aee0fc7805` through GitHub's synthetic
merge commit `e50116100c9461032e77ba47704248bdb4923df2`. Its request audit recorded
zero outbound requests for every fixture. The exact asset candidates and the
Home, Members, and Activity heap candidates were copied; unrelated runtime
budgets remain calibrated from the original pinned run.

Checkpoint D's Workstreams and Specs list/detail routes were characterized by
pinned CI run
[`33117048710`](https://github.com/mex-memory/mex/actions/runs/33117048710).
The retained `release-performance-1` artifact (ID `9665147644`, report SHA-256
`edb9f14f73f8de8ebda15407362fe57e591075b4dd93686d6a273089d280e997`)
measured PR head `fa2cc3b95242063ac76e0241a2ca72bd098ee302` through GitHub's
synthetic merge commit `4d78fbc141c4a79ee4f076283eb5865b22954ee7`. The
report was produced on Ubuntu 24.04 with Node 22.22.0, validated against the
versioned report schema, and recorded zero outbound browser requests for all
three fixtures. Only the exact Workstreams and Specs list/detail asset
candidates and their per-profile browser-heap candidates were copied; every
pre-Checkpoint-D budget remains frozen.

Checkpoint E's release-gate implementation now measures the real Inbox route,
draft/proposal list reads, and Inbox heap, but its numeric limits are not yet
calibrated. No local macOS measurement is eligible for a committed budget. The
first retained Ubuntu 24.04/Node 22 characterization report must measure only
`assets.routes.inbox`, each profile's
`apiLatencyMs.inboxDrafts`/`apiLatencyMs.inboxProposals`, and each profile's
`browserHeapBytes.inbox`. Missing Inbox API budgets fail closed with a bounded
`budget_missing` violation while the report still retains their candidates.
After those exact values are copied with the existing formulas, an enforcing
pinned rerun must pass; every unrelated budget remains frozen.

## Runner contract

`npm run benchmark:release` builds the package and writes the bounded JSON
report to `test-results/release-benchmark/report.json`. The report and budget
contracts are versioned by
`scripts/release-benchmark/report.schema.json` and
`scripts/release-benchmark/budgets.schema.json`.

The benchmark generates three fixed Git repositories. Small contains four
source files, four Wiki entities, one Workstream, one checkout-local Inbox
draft, one pending canonical proposal, and four canonical Activity events;
medium contains sixteen source files, Wiki entities, and Activity events plus
the same one Workstream/draft/proposal shape; large contains forty-eight source
files, Wiki entities, and Activity events plus that same bounded shape. The
first four existing Wiki entity IDs form a root
Spec/requirement/constraint/acceptance-criterion slice under `.mex/specs/**`;
no extra Wiki entities are added. IDs, contents, timestamps, Git identity,
commit timestamp, and repository shape are deterministic. Graph and Wiki
indexes are built only by explicit setup in the benchmark. Reads never
initialize storage or maintain either index.

Each profile records:

- ten cold Hub readiness timings;
- five idle server RSS and CPU samples over a two-second quiet window;
- ten exact Hub API timings for Search, Code, Knowledge, Activity, Inbox draft
  listing, and pending/stale Inbox proposal listing;
- ten timings for each Graph/Wiki refresh and rebuild, with five peak-RSS
  samples for each operation;
- Graph and Wiki SQLite-family bytes relative to their indexed input bytes.

Every profile additionally records five Chromium heap samples after every
registered Hub route: Home, Search, Knowledge browse/detail, Code search/symbol,
Workstreams, Specs browse/detail, Inbox, the two honest unavailable capability
routes, Members, Activity, Jobs, Health, and the wildcard not-found route.
Every browser context begins empty. Its request audit fails if a route contacts
any origin other than the exact loopback Hub origin.

Production asset accounting starts from Vite's manifest. It records the
initial static import closure and the incremental JavaScript, CSS, and font
bytes for every registered route. Fonts referenced from global CSS are counted
as initial assets even when Vite does not attach them to a manifest entry.
The initial shell and Home must not statically close over Code, Knowledge,
Workstreams, Specs, Inbox, the Inbox editor, Members, Activity, its nested
recorder, or setup code, and the largest JavaScript chunk is checked explicitly.
Production assets are also scanned for exact development-fixture sentinels.

## Enforcement

Deterministic asset limits are checked on every benchmark invocation. Their
committed values are the measured production bytes plus five percent, rounded
up. Asset-only local verification is available after a build:

```sh
node scripts/release-benchmark/run.mjs --assets-only
```

Wall-clock and memory budgets are enforced only when
`MEX_ENFORCE_RELEASE_BUDGETS=1`. In that mode the runner first proves the exact
budget environment: Ubuntu 24.04, x64, and the pinned Node 22 patch release in
`budgets.json`. This prevents a laptop or a floating CI image from turning
machine variance into a release failure. Node 24 remains in the ordinary CI
compatibility matrix, outside performance enforcement.

Deterministic failures remain immediate: built-asset bytes, outbound requests,
database-to-input ratios, and any unknown runtime metric never receive a retry.
The read and maintenance nonmutation contracts likewise remain ordinary hard
tests. A first pass containing only wall-clock, RSS, CPU, or browser-heap
breaches triggers one independent full benchmark pass on the same pinned
runner and exact repository HEAD only when at least one crossing could still
become material. A crossing is potentially material when its p95 is strictly
above the material threshold and at least two of its raw samples are also
strictly above that threshold. If every first-pass crossing is below the
threshold or has fewer than two supporting samples, enforcement records the
advisories and passes without spending another full benchmark run. CI fails a
noisy metric only when that exact metric breaches again, both p95 measurements
exceed its material threshold, and both attempts have at least two supporting
raw samples. This avoids treating the single maximum selected by nearest-rank
p95 over either ten timing samples or five memory samples as
distribution-level evidence. The committed p95 budgets remain the raw
alert/crossing line and are not recalibrated. For each exact metric key, the
blocking threshold is
`budget + max(15% of budget, minimum excess)`:

| Runtime category | Minimum excess |
| --- | ---: |
| API latency | 15 ms |
| Cold readiness | 100 ms |
| Maintenance elapsed time | 50 ms |
| Idle CPU | 25 ms |
| Idle and maintenance peak RSS | 32 MiB |
| Browser heap | 2 MiB |

Crossings from both attempts remain bounded in `firstPassViolations` and
`secondPassViolations`. Repeated exact keys remain in `confirmedViolations`.
`advisoryAssessments` records one-off crossings, threshold misses, and
crossings with insufficient raw-sample support. Each generated assessment
records the required support count and the bounded sample/support counts for
the attempts that observed the metric; raw sample arrays remain in the
retained attempt reports. `materialAssessments` records only repeated crossings
where both measurements and both raw-sample distributions satisfy the rule.
The final `runtimeViolations` list contains only those material crossings plus
immediate hard failures. Operational benchmark failures, including missing or
inconsistent raw sample evidence, are never retried as budget noise.
Enforcement exits 0 for a pass, 1 for a budget failure, and 2 when a pass cannot
produce a valid bounded report.

The dedicated `release-performance` CI job installs Chromium on the pinned
runner, enforces the budgets, and retains the final report plus both attempt
reports when confirmation was required. It also retains the first raw attempt
when advisory sample support makes a second pass unnecessary. Runtime
candidates in that report are `ceil(p95 * 1.15)` independently for each fixture profile,
route, read, and maintenance operation. The committed values are copied exactly
from the first healthy retained pinned report; its enforcing rerun must pass
before Checkpoint A is considered green. Future recalibration uses the same
retained-report workflow. Do not derive runtime limits from an unpinned local
run or collapse fixture profiles into one worst-case envelope.

The report is capped at 2 MiB. Response bodies, child-process diagnostics,
recorded request paths, asset lists, and violation lists also have explicit
bounds so benchmark failures cannot produce unbounded CI artifacts.

## Agent capability discovery

Checkpoint A also freezes `mex capabilities --json` at schema version 1. The
command performs only bounded, read-only repository and disposable-index
inspection. It bypasses first-run and telemetry hooks, never backfills scaffold
identity, initializes storage, invokes a model, or opens a network connection.
Expected missing/stale/migration and corpus-policy states are successful
discovery results; unexpected inspection failures use one redacted problem and
exit 2.

The installed-capability inventory includes the secure Project Hub, Team
identity, canonical Activity read/record, Graph, and Wiki surfaces. Checkpoint C
adds registered structured Member and Activity commands; Checkpoint D adds
registered Workstream reads/mutations and read-only Spec reads; Checkpoint E
adds registered Inbox draft/proposal reads and governed Spec-authoring preview/
apply commands. Every Team
mutation advertises distinct preview and apply invocations plus a bounded
machine-readable request schema, complete examples, the exact preview-envelope
apply rule, and the typed process-exit table. Read, preview, and apply
invocations remain separate fixed arrays, Graph's existing protocol-v3 commands
remain JSONL byte-compatible, and unavailable states carry static safe reasons
plus the next initialization action. Writable legacy Wiki synthesis commands
remain omitted from the governed agent surface. Relays, Playbooks, Catch Up,
and future team actions remain absent until their application services and
structured CLI contracts exist.

Generated agent anchors direct supported tools to discover this manifest,
prefer its structured reads, preview mutations, and wait for explicit human
approval before an advertised apply command.
