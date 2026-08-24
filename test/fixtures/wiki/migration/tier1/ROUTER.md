---
name: router
description: "Session bootstrap and navigation hub for the Harbour ticketing service."
triggers:
  - "start of session"
  - "where do I look"
  - "routing"
  - "bootstrap"
  - "navigation"
edges:
  - target: context/architecture.md
    condition: when working on service boundaries or request flow
  - target: context/stack.md
    condition: when choosing or upgrading a library
  - target: context/conventions.md
    condition: when writing new handlers or reviewing a change
  - target: context/decisions.md
    condition: when a design choice needs its reasoning
  - target: context/setup.md
    condition: when preparing a development machine
  - target: patterns/INDEX.md
    condition: at the start of a task, to find a matching pattern
last_updated: 2026-03-14
---
# Session Bootstrap

Read this file before touching anything in Harbour. It says where knowledge lives
and in what order to read it.

## Reading order

Start with the routing table below, then open only the files a task actually
needs. Reading everything costs more than it returns and buries the parts that
matter for the change in front of you.

## Routing table

The edges in this file's frontmatter are the routing table. Each one names a
destination and the condition under which it is worth opening.

## Working agreement

Leave the scaffold in a state the next session can use. If a decision was made
during a session, it belongs in the decision log before the session ends.
