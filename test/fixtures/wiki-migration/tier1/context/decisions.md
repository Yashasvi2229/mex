---
name: decisions
description: "The choices Harbour has made and the reasoning behind each one."
triggers:
  - "why do we"
  - "decision"
  - "alternative"
  - "we chose"
  - "rationale"
edges:
  - target: context/architecture.md
    condition: when a decision shaped a boundary
  - target: context/stack.md
    condition: when a decision was about a dependency
last_updated: 2026-03-14
---
# Decisions

Kept in one place, oldest at the bottom. A superseded decision is never deleted.

## Decision Log

### Store raw mail before parsing it

**Date:** 2026-01-12
**Status:** Active
**Decision:** Inbound mail is written to the raw store and acknowledged before
any parsing runs.
**Reasoning:** A parser bug that rejects a message loses a customer's mail with
no record it ever arrived. Storing first makes every parser failure recoverable
by replay.
**Consequences:** The raw store grows without bound and needs its own retention
policy, which is tracked as a risk.

### One queue owns a ticket

**Date:** 2026-01-30
**Status:** Active
**Decision:** A ticket is assigned to exactly one queue, with an explicit
catch-all rule last.
**Reasoning:** Shared ownership produced tickets nobody answered. A single owner
with a visible fallback is worse for edge cases and much better for the common
one.
**Consequences:** Cross-team tickets are handled by reassignment rather than by
membership, and reassignment has to be cheap.

### Queue rules are data, not code

**Date:** 2026-02-09
**Status:** Active
**Decision:** Routing rules are loaded from configuration and reloaded without a
restart.
**Reasoning:** Rules change weekly and a deploy per change made operators wait on
engineers.
**Consequences:** Rule validation has to be strict at load time, because a bad
rule now reaches production without passing a compiler.

### Use a single outbound sender

**Date:** 2026-02-27
**Status:** Superseded by "One queue owns a ticket"
**Decision:** All outbound mail is sent through one module that owns rate
limiting.
**Reasoning:** Two senders drifted on retry behaviour and produced duplicate
replies.
**Consequences:** The sender is a single point of failure and needs its own
health check.
