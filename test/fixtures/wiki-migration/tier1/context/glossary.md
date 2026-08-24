---
name: glossary
description: "Terms used throughout Harbour, defined once so they are not redefined."
edges:
  - target: context/performance.md
    condition: when latency or volume is the concern
  - target: patterns/INDEX.md
    condition: at the start of a task, to find a matching pattern
  - target: context/architecture.md
    condition: when the boundary between two services matters
last_updated: 2026-03-14
---
# Glossary

Operators reassign rather than share. Cross-team tickets move between
queues, which means reassignment has to be one action and has to leave a
trail that answers who moved it and when.

## Ticket

Every test names the behaviour it protects in its title. A test that
cannot fail is deleted rather than kept for coverage, and one that needs
two fixtures to explain itself is usually testing two things.

## Thread

Retention is the open question. The raw store keeps every message and has
no expiry, so the volume fills on a schedule nobody has written down and
ingest starts refusing when it does.

## Queue

Rules are data and are reloaded without a restart, which took the deploy
out of the loop and put validation on the critical path. A malformed rule
set now reaches production with only the loader standing in front of it.

## Raw message

The bootstrap target is safe to re-run. It drops and recreates the local
database only, applies every migration in order, and loads a fixture set
with three queues and a handful of threads.
