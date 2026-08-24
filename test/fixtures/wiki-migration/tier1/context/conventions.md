---
name: conventions
description: "How code is written in Harbour: naming, structure, error handling and tests."
triggers:
  - "convention"
  - "naming"
  - "style"
  - "how should I write"
  - "error handling"
edges:
  - target: context/architecture.md
    condition: when a convention depends on a service boundary
  - target: patterns/INDEX.md
    condition: when a task looks like something already documented
last_updated: 2026-03-14
---
# Conventions

The rules a change is reviewed against. They are short because a long list is a
list nobody reads.

## Naming

Modules are named for the noun they own, not for the layer they sit in. A module
called ticket owns tickets; there is no ticket-service, ticket-manager or
ticket-helper. Functions that answer a question are named for the answer, so a
reader can predict the return type from the call site without opening the
definition.

## Errors

An error carries the identifier of the thing that failed and nothing else. No
stack strings in messages, no wrapped-and-rewrapped chains, no error text that
depends on which layer caught it. A handler either recovers or lets the error
reach the boundary that turns it into a response.

## Structure

A module exports a narrow surface and keeps its internals unexported. If two
modules need the same private helper, the helper moves into a third module that
owns it rather than being exported from one of them and imported by the other.

## Tests

Every test names the behaviour it protects in its title, and a test that cannot
fail is deleted rather than kept for coverage. A test that needs more than one
fixture to explain itself is usually testing two things.
