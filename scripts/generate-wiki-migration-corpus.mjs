#!/usr/bin/env node
/**
 * Generate the tier-1 migration corpus.
 *
 * Plan section 6a: the corpus is **synthesized**, never vendored, and is
 * generated to match a committed shape census. Every word of prose here is
 * invented — it describes a fictional "Harbour" ticketing service — and the
 * only thing taken from any real scaffold is a count.
 *
 * Deterministic: no clock, no randomness, no absolute paths in output. Running
 * it twice produces byte-identical files, which is what lets a test assert the
 * committed fixture is exactly the generator's output.
 *
 *   node scripts/generate-wiki-migration-corpus.mjs [target-dir]
 */
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_TARGET = resolve(HERE, "..", "test", "fixtures", "wiki", "migration", "tier1");

/** A fixed date. A clock in a generator makes the fixture change on its own. */
const DATE = "2026-03-14";

/** Two invented graph node ids and fingerprints. Not derived from any repo. */
const NODE_A = "function:1c9d4b7e2f5a8036c4e1b9d7a2f60358";
const NODE_B = "class:7e2a1f4c8b09d3e65a17c4f2b8d09e13";
const FP_A = "mh:64:4b1c7e29";
const FP_B = "mh:64:c08a3f7d";

const front = ({ name, description, triggers, edges, grounds }) => {
  const lines = ["---", `name: ${name}`, `description: "${description}"`];
  lines.push("triggers:");
  for (const trigger of triggers) lines.push(`  - "${trigger}"`);
  lines.push("edges:");
  for (const edge of edges) {
    lines.push(`  - target: ${edge.target}`);
    lines.push(`    condition: ${edge.condition}`);
  }
  if (grounds !== undefined) {
    lines.push("grounds_to:");
    for (const entry of grounds) {
      lines.push(`  - node: "${entry.node}"`);
      lines.push(`    fingerprint: "${entry.fingerprint}"`);
    }
  }
  lines.push(`last_updated: ${DATE}`, "---", "");
  return lines.join("\n");
};

const files = {};
const add = (path, text) => {
  files[path] = text;
};

// -- root -------------------------------------------------------------------

add(
  "ROUTER.md",
  front({
    name: "router",
    description: "Session bootstrap and navigation hub for the Harbour ticketing service.",
    triggers: ["start of session", "where do I look", "routing", "bootstrap", "navigation"],
    edges: [
      { target: "context/architecture.md", condition: "when working on service boundaries or request flow" },
      { target: "context/stack.md", condition: "when choosing or upgrading a library" },
      { target: "context/conventions.md", condition: "when writing new handlers or reviewing a change" },
      { target: "context/decisions.md", condition: "when a design choice needs its reasoning" },
      { target: "context/setup.md", condition: "when preparing a development machine" },
      { target: "patterns/INDEX.md", condition: "at the start of a task, to find a matching pattern" },
    ],
  }) +
    `# Session Bootstrap

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
`,
);

add(
  "AGENTS.md",
  `# Harbour

Harbour is a ticketing service for small support teams. It accepts inbound mail,
turns each thread into a ticket, and routes tickets to the queue that owns them.

## Non-negotiables

Inbound mail is never dropped. A message that cannot be parsed becomes a ticket
in the triage queue with the raw body attached, and an operator decides.

## Commands

The dev target runs the service against a local Postgres. The check target runs
the whole test suite and the linter. Both must pass before a change is proposed.

## After every task

Update the decision log when a choice was made, and the pattern index when a new
pattern file lands.
`,
);

add(
  "SETUP.md",
  `# First run

This file is what a new contributor reads on day one. It assumes nothing beyond
a working package manager.

## Install

Install the toolchain, then run the bootstrap target once. It creates the local
database, applies every migration, and loads a small fixture set.

## Verify

Run the check target. A clean run prints a summary and exits zero. Anything else
means the environment is not ready and the output says which step failed.

## Where to go next

Open the router. It explains which context file answers which kind of question.
`,
);

add(
  "SYNC.md",
  `# Keeping the scaffold honest

The scaffold drifts when code moves and nobody updates the prose that described
it. Run the sync check before proposing a change, and fix what it reports rather
than silencing it.

## What sync checks

It compares the routing edges against the files on disk, the pattern index
against the pattern files, and every recorded grounding against the code it
points at.
`,
);

// -- context ----------------------------------------------------------------

add(
  "context/architecture.md",
  front({
    name: "architecture",
    description: "How Harbour's pieces connect and how a message becomes a ticket.",
    triggers: ["architecture", "request flow", "how does X reach Y", "boundaries", "queues"],
    edges: [
      { target: "context/stack.md", condition: "when a specific library's behaviour matters" },
      { target: "context/decisions.md", condition: "when the reasoning behind a boundary is needed" },
      { target: "context/conventions.md", condition: "when adding a handler to an existing service" },
    ],
    grounds: [
      { node: NODE_A, fingerprint: FP_A },
      { node: NODE_B, fingerprint: FP_B },
    ],
  }) +
    `# Architecture

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
[\`threadFor()\`](mex://${NODE_A}) for the matcher.

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
`,
);

add(
  "context/conventions.md",
  front({
    name: "conventions",
    description: "How code is written in Harbour: naming, structure, error handling and tests.",
    triggers: ["convention", "naming", "style", "how should I write", "error handling"],
    edges: [
      { target: "context/architecture.md", condition: "when a convention depends on a service boundary" },
      { target: "patterns/INDEX.md", condition: "when a task looks like something already documented" },
    ],
  }) +
    `# Conventions

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
`,
);

add(
  "context/decisions.md",
  front({
    name: "decisions",
    description: "The choices Harbour has made and the reasoning behind each one.",
    triggers: ["why do we", "decision", "alternative", "we chose", "rationale"],
    edges: [
      { target: "context/architecture.md", condition: "when a decision shaped a boundary" },
      { target: "context/stack.md", condition: "when a decision was about a dependency" },
    ],
  }) +
    `# Decisions

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
`,
);

add(
  "context/setup.md",
  front({
    name: "setup",
    description: "Preparing a machine to run and test Harbour locally.",
    triggers: ["setup", "first run", "environment", "local development", "getting started"],
    edges: [
      { target: "context/stack.md", condition: "when a version constraint is unclear" },
      { target: "context/architecture.md", condition: "when it is not obvious which service to run" },
    ],
  }) +
    `# Setup

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
`,
);

add(
  "context/stack.md",
  front({
    name: "stack",
    description: "The technologies Harbour runs on and the constraints on changing them.",
    triggers: ["stack", "library", "dependency", "version", "what do we use"],
    edges: [
      { target: "context/decisions.md", condition: "when a dependency choice needs its reasoning" },
      { target: "context/architecture.md", condition: "when a library choice is shaped by a boundary" },
    ],
  }) +
    `# Stack

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
`,
);

add(
  "context/risks.md",
  front({
    name: "risks",
    description: "Known risks in Harbour, what triggers each one, and what would reduce it.",
    triggers: ["risk", "what could break", "failure mode", "incident", "capacity", "retention"],
    edges: [
      { target: "context/architecture.md", condition: "when a risk sits at a boundary" },
      { target: "context/decisions.md", condition: "when a risk was accepted deliberately" },
      { target: "context/setup.md", condition: "when reproducing a failure locally" },
    ],
  }) +
    `# Risks

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
`,
);

// -- patterns ---------------------------------------------------------------

add(
  "patterns/INDEX.md",
  front({
    name: "pattern-index",
    description: "Lookup table for Harbour's pattern files.",
    triggers: ["pattern", "index", "how do I", "is there a pattern", "lookup", "recipe"],
    edges: [
      { target: "ROUTER.md", condition: "when the task does not match any pattern" },
      { target: "context/conventions.md", condition: "when a pattern and a convention disagree" },
    ],
  }) +
    `# Pattern Index

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
`,
);

add(
  "patterns/README.md",
  `# Patterns

A pattern file describes one repeatable task: what it is for, the steps, the
places it goes wrong, and how to check it worked.

## Adding a pattern

Copy an existing file, keep the section headings, and add a row to the index.

## Keeping them honest

A pattern that no longer matches the code is worse than no pattern. Delete it or
fix it; do not leave it.
`,
);

const PATTERNS = [
  ["add-queue-rule", "Add or reorder a routing rule", "routing rules", "queue"],
  ["replay-raw-message", "Replay a stored message that never became a ticket", "replay", "raw store"],
  ["split-thread", "Split a thread that was joined wrongly", "threading", "split"],
  ["merge-tickets", "Merge two tickets that are the same conversation", "merge", "duplicate"],
  ["add-migration", "Add and apply a database migration", "migration", "schema"],
  ["rotate-provider-credentials", "Rotate the mail provider credentials", "credentials", "rotation"],
  ["add-inbound-address", "Accept mail on a new inbound address", "inbound", "address"],
  ["backfill-queue-assignment", "Backfill queue assignment after a rule change", "backfill", "assignment"],
  ["trace-a-reply", "Trace a reply that never reached the customer", "delivery", "trace"],
  ["add-a-health-check", "Add a health check to a worker", "health check", "worker"],
  ["expire-raw-messages", "Expire raw messages past their retention window", "retention", "expiry"],
  ["reprocess-bounces", "Reprocess a batch of bounced replies", "bounce", "reprocess"],
  ["add-an-operator-action", "Add an action operators can take on a ticket", "operator", "action"],
];

for (const [slug, title, triggerA, triggerB] of PATTERNS) {
  const anchor = slug === "replay-raw-message" ? ` The entry point is [\`replayMessage()\`](mex://${NODE_B}).` : "";
  const options = {
    name: slug,
    description: `${title}. Follow this rather than working it out again.`,
    triggers: [triggerA, triggerB],
    edges: [{ target: "context/conventions.md", condition: "when verifying the change against house style" }],
  };
  if (slug === "add-queue-rule") options.grounds = [{ node: NODE_A, fingerprint: FP_A }];
  add(
    `patterns/${slug}.md`,
    front(options) +
      `# ${title}

## Context

Use this when the task is exactly the one this file names. If the situation is
close but not the same, read the pattern anyway and then say in the change why
you departed from it.${anchor}

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
`,
  );
}

// -- write ------------------------------------------------------------------

const target = resolve(process.argv[2] ?? DEFAULT_TARGET);
rmSync(target, { recursive: true, force: true });
for (const [path, text] of Object.entries(files)) {
  const absolute = join(target, path);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, text, "utf-8");
}
console.log(`${Object.keys(files).length} files written to ${target}`);
