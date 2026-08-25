---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-08-26
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Working:**
- MEX v0.7.2 graph retrieval and protocol-v3 JSONL behavior.
- Internal human-team application contracts, ownership rules, and stable error
  codes are available under `src/team/contracts` as a provisional boundary.
- A behavioral WikiPort mock, realistic fixture, reusable conformance suite,
  and graph protocol goldens cover the consumer-side Checkpoint 0 work.
- Lane C provides internal canonical team-member/activity artifacts, actor
  resolution, bounded read-only Git access, legacy timeline normalization, and
  local configured-member/Catch Up cursor state. These remain non-public.
- Lane B provides the loopback-only Project Hub, secure browser-session
  bootstrap, bounded `/api/v1` contracts, persistent local job orchestration,
  packaged React shell, and honest Home/Search/Health/Jobs states.
- The Project Hub now projects Lane C's immutable canonical activity and legacy
  decision log through a bounded, read-only Activity timeline. Recorded actors
  remain immutable while current alias resolution is shown separately.
- Versioned graph snapshot provenance and read-only freshness inspection gate
  grounding in check, doctor, and dashboard flows without implicit graph sync.
- Explicit graph status, refresh, and isolated rebuild/recovery commands preserve
  the last trustworthy index behind one cross-process maintenance lease.
- Targeted graph get/query/impact consumers use one provenance-bound immutable
  snapshot and discard output if graph or exact source identity changes.
- The graph half of Checkpoint 2 is working in the Project Hub: grouped symbol
  and source Search, the read-only Code workspace, structured graph Health, and
  explicit refresh/rebuild jobs all use the repository-bound GraphPort adapter.
  Hub graph reads preserve engine ranking and never maintain the index implicitly.
- Graph evaluator determinism includes semantic snapshot provenance while
  excluding only operational timestamps and Git coordinates.
- The pinned Wiki engine now has an internal repository WikiPort adapter with
  exact-byte index freshness, immutable bounded reads, strict revision-bound
  cursors, complete entity/relationship/grounding projections, pinned operation
  and migration plans, and explicit cancellable maintenance. The real adapter
  passes the consumer-owned conformance suite without skips.

**Not Built:**
- Real Wiki Hub search, Knowledge pages, health, and maintenance;
  Workstream/Inbox/Relay/Playbook
  persistence; Catch Up actions; activity creation; and later delivery
  checkpoints from the human-team program.
- Public package-root exports for the provisional team contracts.

**Known Issues:**
- The current scaffold architecture, conventions, decisions, stack, and setup
  context files are still largely unpopulated placeholders.
- Hub Wiki controls remain unavailable until the real adapter is integrated;
  development fixtures are never production data. Graph repair controls appear
  only when a fresh status or executable Lane A remediation makes them safe.

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After completing the task:
   - If no pattern exists for this task type, create one in `patterns/` using the format in `patterns/README.md`. Add it to `patterns/INDEX.md`. Flag it: "Created `patterns/<name>.md` from this session."
   - If a pattern exists but you deviated from it or discovered a new gotcha, update it with what you learned.
   - If any `context/` file is now out of date because of this work, update it surgically — do not rewrite entire files.
   - Update the "Current Project State" section above if the work was significant.
