---
name: stack
description: "The technologies Harbour runs on and the constraints on changing them."
triggers:
  - "stack"
  - "library"
  - "dependency"
  - "version"
  - "what do we use"
edges:
  - target: context/decisions.md
    condition: when a dependency choice needs its reasoning
  - target: context/architecture.md
    condition: when a library choice is shaped by a boundary
last_updated: 2026-03-14
---
# Stack

What Harbour is built from, and what is deliberately absent.

## Core

A single service process, Postgres for everything durable, and a work queue that
is a table in the same database rather than a separate broker.

## Deliberately absent

There is no cache tier, no message broker and no search cluster. Each was
considered and rejected as an operational cost the current volume does not
justify.

## Version constraints

The runtime is pinned to a major version and upgraded deliberately. Postgres is
pinned to the version the managed instance runs, so a local run cannot pass on a
feature production does not have.
