---
name: architecture
description: "How Harbour's pieces connect and how a message becomes a ticket."
triggers:
  - "architecture"
  - "request flow"
  - "how does X reach Y"
  - "boundaries"
  - "queues"
edges:
  - target: context/stack.md
    condition: when a specific library's behaviour matters
  - target: context/decisions.md
    condition: when the reasoning behind a boundary is needed
  - target: context/conventions.md
    condition: when adding a handler to an existing service
grounds_to:
  - node: "function:1c9d4b7e2f5a8036c4e1b9d7a2f60358"
    fingerprint: "mh:64:4b1c7e29"
  - node: "class:7e2a1f4c8b09d3e65a17c4f2b8d09e13"
    fingerprint: "mh:64:c08a3f7d"
last_updated: 2026-03-14
---
# Architecture

An overview of the moving parts, written for someone who has not read the code.

## Ingest

Inbound mail arrives over SMTP and is written to the raw store before anything
parses it. Parsing happens afterwards, from the stored copy, so a parser bug
never loses a message. The ingest worker is deliberately dumb: it accepts,
stores, acknowledges, and enqueues. Everything that can fail interestingly
happens downstream of that acknowledgement, where a retry is cheap and a failure
is visible in the triage queue rather than in a mail server's logs.

## Threading

A stored message is matched to an existing thread by its reply headers, and falls
back to a subject-and-participant match when those headers are missing. The
fallback is generous on purpose. A thread joined wrongly can be split by an
operator in one action; a thread that is never joined produces two tickets nobody
notices are the same conversation, and the second is usually answered twice. See
[`threadFor()`](mex://function:1c9d4b7e2f5a8036c4e1b9d7a2f60358) for the matcher.

## Routing

Each ticket is assigned to exactly one queue. Assignment runs the queue rules in
declaration order and takes the first match, with an explicit catch-all last, so
there is always an owner. Rules are data, not code, and are reloaded without a
restart. The ordering rule matters more than it looks: two overlapping rules are
common, and resolving them by declaration order gives an operator something they
can reason about without reading the engine.

## Delivery

Outbound replies go through a single sender that owns rate limiting and bounce
handling. Nothing else in the system talks to the mail provider, so a change of
provider touches one module and the credentials it reads.
