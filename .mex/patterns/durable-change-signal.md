---
name: durable-change-signal
description: Keep the value that answers "has this changed?" in Git, not in a disposable index, and make every reader consult the same key path.
triggers:
  - "drift baseline"
  - "body hash"
  - "grounding change signal"
  - "disposable index"
  - "grounds_to key path"
edges:
  - target: "../context/architecture.md"
    condition: "when changing what a drift check compares against"
  - target: "safe-graph-snapshot-evolution.md"
    condition: "when the value also lives in the graph database"
  - target: "../context/conventions.md"
    condition: "when verifying the change"
grounds_to: []
last_updated: 2026-09-01
---

# Durable Change Signal

## Context

`.mex/graph.db` and `.mex/wiki.db` are derived, gitignored, and disposable by
invariant: `mex graph rebuild` is offered in the Hub as a routine repair, and a
teammate who clones never receives either file. Anything held only there is gone
the moment a user takes the repair the product recommends.

That is correct for an index and wrong for a baseline. A drift check answers
"has this code changed since we wrote this down?", and the value it compares
against is a claim made at a point in time. Re-derive it during a rebuild and
you compare current against current: the drift silently disappears, nothing
warns, and the scaffold keeps reporting clean.

Two distinct kinds of value, and the difference decides where each one lives:

- **Identity** — the fingerprint. Answers "where did this symbol go?" It is
  deliberately insensitive to an edited constant or a renamed local. Never use
  it to answer "did this change?"
- **Change** — the body hash. Answers "is this still the code we described?"
  Canonical because it is committed in Markdown and reviewable in a pull
  request.

## Steps

1. Decide which kind of value you are adding. If it is a claim about a moment
   in time, it belongs in Markdown. If it is a re-derivable lookup, the index is
   the right home.
2. Add the field to the shared type in `src/types.ts` as **optional**. Every
   scaffold in the world lacks it, and a required field turns each of them into
   a parse error. Mirror the wiki lane's key name and placement so both writers
   produce one shape rather than two conventions.
3. Populate it at every write site, from a value the graph produced. Never let a
   caller supply one — a hash an agent can invent is not evidence.
4. **Change the readers in the same commit.** A field nothing reads is inert,
   and a fix that ships only the write half looks complete and does nothing.
   Grep for every consumer of the old source of truth before you start.
5. Read the key through `extractGroundings`, never `frontmatter.grounds_to`
   directly. A pre-wiki scaffold keeps the key at the root; once `wiki migrate`
   adopts the file as an entity, section 13.4 moves it under the `mex` map.
   Reading the root key directly finds nothing on a migrated scaffold, the loop
   runs zero times, and the check reports clean. Writer and reader must resolve
   the path the same way or they will disagree silently.
6. Keep the index copy and say in a comment that it is now a **cache of a
   canonical value**, not a second store of a fact. Otherwise the next reader
   deletes it as a duplicate — and it often carries something Markdown has no
   business holding, such as the body text a drift review needs for a diff.
7. Backfill, never re-baseline. Write the value when it is absent, or when an
   authorized caller is deliberately re-pointing the record at current code. A
   value that merely **differs** is the finding; overwriting it erases the
   evidence and reports fresh on the next run.

## Verify

- Delete the index, rebuild it, then edit the grounded code. The check must
  still fire. This is the whole point, and it is the only test that proves it.
- A record written before the field existed must still parse, still validate,
  still warn, and still behave exactly as it did against a live index.
- Confirm the new tests actually fail on the pre-fix tree. Restore the source
  files from the base commit and re-run; a test that passes both ways is a
  backward-compatibility pin, not a proof of the fix, and should be labelled as
  one.
- Run the check against a real migrated scaffold, not only a synthetic fixture.
  Both key paths and both populations only appear there.

## Gotchas

- A command that reports success is not evidence it wrote anything. A capture
  pass printed "16 captured, 0 skipped" while writing nothing durable.
- `serviceOptions` in the wiki CLI carries no code graph, so `wiki validate` and
  `wiki migrate` degrade silently rather than failing. Check what a command
  actually receives before believing a message about what it found.
- A diagnostic that names a cause nobody checked costs more than no diagnostic.
  If a flag has two causes, carry the discriminator rather than asserting one.
