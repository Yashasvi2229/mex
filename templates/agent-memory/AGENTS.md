---
name: agents
description: Always-loaded operating contract for a persistent AI agent workspace.
last_updated: [YYYY-MM-DD]
---

# [Agent / Workspace Name]

## What This Is
<!-- One sentence. What environment or agent does this scaffold describe? -->

## Non-Negotiables
<!-- 3-5 hard safety/operational rules the agent must never violate. -->

## Commands
<!-- Exact commands for health checks, service status, restart/recovery, and mex maintenance. -->

Use the smallest relevant structured resolver. For Inbox or Relay mutations, resolve only the intended action with `mex inbox contract --action <command-id> --json` or `mex relay contract --action <command-id> --json`; use `mex capabilities --json` only for broader capability discovery. If the user explicitly asks to create, save, or draft a checkout-local Inbox or Relay draft, preview and apply that exact draft without asking for redundant confirmation. Deleting a local draft, or publishing, approving, rejecting, withdrawing, marking stale, repairing, taking or acknowledging, or closing, requires fresh explicit confirmation after semantic preview. Treat Git commit, push, and pull as separate actions requiring their own authorization.

## GROW
After meaningful work:
- Ground: what changed in reality?
- Record: update `ROUTER.md` and relevant `context/` files
- Orient: create/update a `patterns/` runbook if this can recur
- Write: bump `last_updated` and run `mex log` when rationale matters

## Heartbeat
When invoked for a heartbeat, read `HEARTBEAT.md`. If all checks pass, respond with exactly `HEARTBEAT_OK`.

## Navigation
At the start of every normal session, read `ROUTER.md` before doing anything else.

<!-- mex-agent:skills:start -->
## MEX context policy
- When MEX context materially influences an answer or implementation, include one concise acknowledgement: `MEX context used: <specific records/files/entities consulted>.`
- Do not claim an author, date, or historical event unless the retrieved data actually provides it.
- After a MEX write, say exactly what changed and its sharing boundary: a local draft is checkout-only and nothing is shared; a canonical artifact is written to the working tree and requires commit/push to share.
- Skill activation is not approval for canonical actions.
<!-- mex-agent:skills:end -->
