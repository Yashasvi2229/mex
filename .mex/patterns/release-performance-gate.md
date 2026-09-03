---
name: release-performance-gate
description: Repeatable workflow for changing, calibrating, and enforcing MEX release resource budgets.
triggers:
  - "release benchmark"
  - "performance budget"
  - "bundle budget"
  - "idle polling"
edges:
  - target: "patterns/secure-local-project-hub.md"
    condition: "when the regression involves Hub routes, browser sessions, or jobs"
  - target: "patterns/safe-graph-snapshot-evolution.md"
    condition: "when changing Graph maintenance or corpus inspection"
grounds_to: []
last_updated: 2026-09-02
---

# Release Performance Gate

## Context

The release benchmark is a product contract, not a laptop speed test. Runtime,
RSS, CPU, and heap budgets are characterized and enforced only on the pinned
Ubuntu 24.04/Node 22 runner. Production asset bytes are deterministic and may
be checked anywhere. Node 24 remains compatibility coverage, not a second
calibration environment.

## Steps

1. Keep the small, medium, and large fixture profiles deterministic: fixed
   contents, IDs, Git identity, timestamps, and file counts. Indexes are built
   only by explicit fixture setup.
2. Run ten timing samples and five idle/memory samples. Preserve separate
   small, medium, and large candidates for every read, route, and maintenance
   operation. Bound child output, HTTP bodies, request inventories, diagnostics,
   and the JSON report itself.
3. Account every registered route from the Vite manifest's static closures,
   including detail, honest unavailable-state, and wildcard routes. Check the
   shell and Home closures independently so Home cannot pull another workbench
   through a transitive import. Count all emitted fonts as initial assets.
4. Prove a production browser remains exact-origin and quiet during an idle
   window. Snapshot canonical files, Git state, and Graph/Wiki SQLite families
   before and after ordinary reads.
5. Use the first healthy pinned report as characterization. Freeze runtime,
   time, RSS, and heap limits at `ceil(p95 * 1.15)` and built asset limits at
   `ceil(bytes * 1.05)`. During CI enforcement, collect a potentially material
   confirmation in a separately allocated pinned hosted job at the exact same
   repository HEAD; two child processes on one VM are not independent evidence.
6. Commit the budget file, its versioned schema/golden, and the retained runner
   identity together. Never copy wall-clock numbers from a local machine.
7. When a new deterministic team fixture adds canonical and checkout-local
   records, preserve every unrelated corpus total. Reuse an existing Activity
   slot when the new artifact requires an event, and record the new topology as
   additive optional report fields so historical reports remain valid.
8. Calibrate only the explicitly owned metric leaves. Diff the candidate budget
   file against its exact base and fail the review if any unrelated number,
   schema contract, or calibration formula changes.

## Gotchas

- Vitest sets `NODE_ENV=test`. Any test that invokes a production build can
  silently bundle React's development runtime unless the build wrapper sets the
  production condition before importing Vite.
- A route can be dynamically split from the application entry and still be
  statically imported by Home. Inspect Home's complete static closure.
- Removing a timer is insufficient if client collections, query pages, terminal
  job IDs, or observer subscriptions can grow forever. Bound both storage and
  pagination.
- Cross-tab job discovery must be event-driven. Do not restore continuous
  polling to repair cache invalidation.
- Corpus byte caps prevent runaway allocation, but maintenance should also
  release source bodies and parser state as each file or bounded compiler batch
  completes.
- Back-to-back confirmation processes on one hosted VM share CPU steal,
  throttling, and I/O contention. Keep the raw reports as artifacts, pass only
  a bounded retry decision between jobs, and make missing or same-allocation
  confirmation evidence fail operationally.
- An unavailable-route placeholder can already have a frozen asset or heap
  budget. Replacing it with a real lazy workbench should initially fail only
  that route's owned leaves; do not reinterpret the placeholder budget as a
  calibration result.

## Verify

- [ ] Production build emits no Vite large-chunk warning or React development sentinel
- [ ] Initial and Home closures exclude unrelated workbenches and setup code
- [ ] Asset-only budget check passes outside the pinned runner
- [ ] Production Playwright/axe and the idle exact-origin/nonmutation proof pass
- [ ] Pinned report has exactly ten timing and five idle/memory samples per metric
- [ ] Final budget file is non-provisional and matches the report candidates
- [ ] Node 22 and Node 24 compatibility jobs remain green
- [ ] Packed-install, declaration-leak, Graph/Wiki conformance, and protocol/ranking gates pass

## Debug

If asset hashes change unexpectedly, inspect the built chunks for React
development sentinels before recalibrating. If runtime enforcement is noisy,
confirm the exact OS/architecture/Node patch, fixture digest, repository HEAD,
and distinct hosted-job allocations; do not widen a budget until the retained
raw samples show a real regression or stable shift.

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when the benchmark surface or pinned runner changes
- [ ] Update `docs/design/release-performance-baseline.md` with the retained calibration
- [ ] Extend this pattern when a new resource class or bundler trap is discovered
