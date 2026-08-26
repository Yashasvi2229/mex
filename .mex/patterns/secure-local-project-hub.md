---
name: secure-local-project-hub
description: Safe workflow for loopback-only Hub APIs, browser sessions, packaged assets, and explicit local jobs.
triggers:
  - "Project Hub"
  - "Hub API"
  - "Hub job"
  - "browser session"
edges:
  - target: "patterns/local-first-team-state.md"
    condition: "when persisting a Hub job or migrating team.db"
  - target: "context/architecture.md"
    condition: "when wiring a real Graph or Wiki adapter"
grounds_to: []
last_updated: 2026-08-23
---

# Secure Local Project Hub

## Context

The Project Hub is a local browser control room, not a remotely exposed service.
Its API contracts and web workspace are private implementation boundaries. Hub
reads must be honest and side-effect free; user-launched work is represented by
durable, bounded jobs in `.mex/local/team.db`.

## Steps

1. Bind the HTTP listener to exactly `127.0.0.1`. Validate the native request
   target before URL normalization and validate Host on every request.
2. Exchange a high-entropy, one-use bootstrap token for a process-memory
   HttpOnly session. Require exact Origin, JSON content type, and CSRF proof for
   every mutation; never add CORS or proxy trust.
3. Parse requests and responses through the private shared Zod contracts. Bound
   bodies, cursors, result counts, serialized responses, diagnostics, and SSE
   subscribers. Project internal failures to safe Problem Details.
4. Serve only the built index plus manifest-known hashed assets. Do not join an
   arbitrary URL path to `dist/hub`.
5. Acquire the repository Hub lease before startup reconciliation. Persist only
   allowlisted job phases, numeric progress, terminal summaries, and safe
   problems; never persist prompts, source, diffs, commands, or secrets.
6. Reject unsupported Graph/Wiki actions as unavailable. Mocks belong only to
   development and tests and must be removed by the production build.
7. Close HTTP intake before job shutdown, keep the durable active slot until an
   executor settles, and fail closed when ownership or persistence is uncertain.
8. Build root code before Vite so the final `dist/hub` survives tsup cleanup,
   then verify a clean packed installation can bootstrap and load it.

## Gotchas

- WHATWG URL construction normalizes traversal and backslashes; native request
  targets need their own pre-normalization gate.
- A HEAD request may be routed through a GET handler. Reject it before reserving
  an SSE subscriber.
- Authentication at stream creation is insufficient: an SSE stream must close
  at absolute session expiry.
- A second Hub process must not reconcile or release work owned by a live first
  process. Use a token-bound local lease and recover only a provably dead PID.
- Bundlers can rewrite a static `node:sqlite` import. Load it through
  `createRequire(import.meta.url)` and smoke-test the packed CLI.
- Terminal SSE events should close the browser connection immediately; do not
  let `EventSource` reconnect to a finished job.

## Verify

- [ ] Host, Origin, CSRF, expiry, traversal, body, response, and SSE bounds pass
- [ ] Hub lease, contention, cancellation, late progress, restart, and retention pass
- [ ] Page loads and local-state reads are non-mutating
- [ ] Every route is keyboard reachable and passes automated accessibility checks
- [ ] 1024 and 1440 desktop layouts work; narrower viewports show the guard
- [ ] Production bundles contain no fixture data or external network dependency
- [ ] Packed-install bootstrap and API/UI smoke pass
- [ ] Public library declarations and graph/TUI behavior remain unchanged

## Update Scaffold

- [ ] Update `.mex/ROUTER.md` when real Graph or Wiki Hub capabilities land
- [ ] Record any new security, packaging, or job-lifecycle trap here
