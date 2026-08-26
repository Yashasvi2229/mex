# Release performance baseline

Status: Checkpoint A benchmark contract. Built-asset and runtime budgets are
frozen. Runtime budgets were characterized by pinned CI run
[`33005876613`](https://github.com/mex-memory/mex/actions/runs/33005876613).

## Runner contract

`npm run benchmark:release` builds the package and writes the bounded JSON
report to `test-results/release-benchmark/report.json`. The report and budget
contracts are versioned by
`scripts/release-benchmark/report.schema.json` and
`scripts/release-benchmark/budgets.schema.json`.

The benchmark generates three fixed Git repositories. Small contains four
source files, four Wiki entities, and four canonical Activity events; medium
contains sixteen of each; large contains forty-eight of each. IDs, contents,
timestamps, Git identity, commit timestamp, and repository shape are
deterministic. Graph and Wiki indexes are built only by explicit setup in the
benchmark. Reads never initialize storage or maintain either index.

Each profile records:

- ten cold Hub readiness timings;
- five idle server RSS and CPU samples over a two-second quiet window;
- ten exact Hub API timings for Search, Code, Knowledge, and Activity;
- ten timings for each Graph/Wiki refresh and rebuild, with five peak-RSS
  samples for each operation;
- Graph and Wiki SQLite-family bytes relative to their indexed input bytes.

Every profile additionally records five Chromium heap samples after every
registered Hub route: Home, Search, Knowledge browse/detail, Code search/symbol,
the five honest unavailable capability routes, Activity, Jobs, Health, and the
wildcard not-found route. Every browser context begins empty. Its request audit
fails if a route contacts any origin other than the exact loopback Hub origin.

Production asset accounting starts from Vite's manifest. It records the
initial static import closure and the incremental JavaScript, CSS, and font
bytes for every registered route. Fonts referenced from global CSS are counted
as initial assets even when Vite does not attach them to a manifest entry.
Home must not statically close over Code, Knowledge, Activity, or setup code,
and the largest JavaScript chunk is checked explicitly.

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

The dedicated `release-performance` CI job installs Chromium on the pinned
runner, enforces the budgets, and retains the report. Runtime candidates in
that report are `ceil(p95 * 1.15)` independently for each fixture profile,
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

The installed-capability inventory includes the secure Project Hub and
canonical Activity read surface alongside Graph and Wiki. The command catalog
advertises only registered structured Graph and Wiki commands because Activity
does not yet have a structured CLI. Read, preview, and apply invocations are
separate fixed arrays, Graph's existing protocol-v3 commands remain JSONL
byte-compatible, and unavailable states carry static safe reasons plus the next
initialization action. Synthesis commands whose current adapters can open
writable storage are deliberately omitted. Workstreams, Inbox, Relays,
Playbooks, Catch Up, and Activity creation remain absent until their application
services and structured CLI contracts exist.

Generated agent anchors direct supported tools to discover this manifest,
prefer its structured reads, preview mutations, and wait for explicit human
approval before an advertised apply command.
