---
name: setup
description: "Preparing a machine to run and test Harbour locally."
triggers:
  - "setup"
  - "first run"
  - "environment"
  - "local development"
  - "getting started"
edges:
  - target: context/stack.md
    condition: when a version constraint is unclear
  - target: context/architecture.md
    condition: when it is not obvious which service to run
last_updated: 2026-03-14
---
# Setup

Everything needed to get a working local environment, in the order it is needed.

## Prerequisites

A recent runtime, a local Postgres, and a mail catcher that accepts SMTP on a
local port. The catcher stands in for the provider so that no local run can send
real mail to a real address.

## First-time setup

Run the bootstrap target once. It creates the database, applies migrations, and
loads a fixture set with three queues and a handful of threads. It is safe to
re-run; it drops and recreates the local database only.

## Environment variables

Configuration is read from the environment with no defaults for anything that
addresses a real system. A missing variable fails at startup with the name of the
variable, rather than defaulting to something that silently works.

## Common issues

If ingest accepts mail but no tickets appear, the parser worker is not running.
If replies never leave, check that the catcher is listening on the port the
sender is configured with.
