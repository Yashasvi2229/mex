---
name: risks
description: "Known risks in Harbour, what triggers each one, and what would reduce it."
triggers:
  - "risk"
  - "what could break"
  - "failure mode"
  - "incident"
  - "capacity"
  - "retention"
edges:
  - target: context/architecture.md
    condition: when a risk sits at a boundary
  - target: context/decisions.md
    condition: when a risk was accepted deliberately
  - target: context/setup.md
    condition: when reproducing a failure locally
last_updated: 2026-03-14
---
# Risks

Written down so they are chosen rather than discovered.

## Raw store growth

The raw store keeps every inbound message and has no retention policy. At the
current rate it outgrows its volume within a year. Nothing breaks quietly: the
volume fills and ingest starts refusing, which is loud but sudden.

## Single outbound sender

Every reply goes through one module. If it stops, replies stop, and the failure
is invisible from the operator's side because tickets continue to look answered.
A health check that sends and reads back a message would catch it.

## Rule reload without validation

Queue rules are reloaded from configuration at runtime. A malformed rule set
reaches production without a compiler between it and the queue engine, so the
validation at load time is the only thing standing there.
