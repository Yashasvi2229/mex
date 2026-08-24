---
name: add-inbound-address
description: "Accept mail on a new inbound address. Follow this rather than working it out again."
triggers:
  - "inbound"
  - "address"
edges:
  - target: context/conventions.md
    condition: when verifying the change against house style
last_updated: 2026-03-14
---
# Accept mail on a new inbound address

## Context

Use this when the task is exactly the one this file names. If the situation is
close but not the same, read the pattern anyway and then say in the change why
you departed from it.

## Steps

Work through these in order. Each step is checkable on its own, so a run that
stops halfway leaves something a reader can reason about rather than a partial
state nobody can name.

## Gotchas

The step that goes wrong most often is the one that looks like bookkeeping. Do
not skip the verification below on the grounds that the change was small.

## Verify

Run the check target and confirm the summary is clean. Then exercise the path by
hand once, because the check does not cover the operator-facing side.

## Debug

If the result is not what the pattern promises, the cause is almost always state
left over from an earlier attempt. Reset the local database and start again
before looking for a deeper explanation.

## Update Scaffold

If this pattern was wrong or incomplete, fix it here in the same change. Add a
row to the index if the pattern is new.
