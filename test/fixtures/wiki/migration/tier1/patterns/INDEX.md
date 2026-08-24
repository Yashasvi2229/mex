---
name: pattern-index
description: "Lookup table for Harbour's pattern files."
triggers:
  - "pattern"
  - "index"
  - "how do I"
  - "is there a pattern"
  - "lookup"
  - "recipe"
edges:
  - target: ROUTER.md
    condition: when the task does not match any pattern
  - target: context/conventions.md
    condition: when a pattern and a convention disagree
last_updated: 2026-03-14
---
# Pattern Index

Look here first. If a pattern matches the task, follow it rather than inventing a
second way to do the same thing.

The table below is maintained by hand today. Rows are added when a pattern file
lands and removed when one is deleted, and the sync check compares the two.

## Patterns

| Pattern | Use when |
|---------|----------|
| add-queue-rule | adding or reordering a routing rule |
| replay-raw-message | a message was stored but never became a ticket |
| split-thread | two conversations were joined into one thread |
| merge-tickets | one conversation became two tickets |
