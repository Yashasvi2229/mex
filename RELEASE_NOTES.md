# mex 0.8.0 — Project memory for the whole team

mex 0.8.0 connects repository-native memory, the local Code Graph and Wiki,
and the Project Hub into one guarded team workflow. It also completes the
fresh-project experience: setup now populates the scaffold with Claude Code or
Codex, finishes both indexes, installs the official skills, validates the
result, and stops at a clear Git checkpoint before Hub starts.

## Highlights

- **Project Hub and team workflows.** The loopback-only Hub now brings together
  Members, immutable Activity, Workstreams, governed Inbox proposals for Spec
  changes, and standalone Relay handoffs. Canonical changes use exact
  preview/review/apply boundaries and successful mutations emit Activity;
  member selection and drafts remain checkout-local.
- **Governed Spec authoring and handoffs.** Inbox proposals cover one bounded
  Spec create or update at a time, with explicit approval, rejection,
  withdrawal, stale detection, and repair. Relays record durable handoffs with
  publication-time repository context and an acknowledge/close lifecycle.
- **Graph and Wiki lifecycle.** Setup builds the Graph and completes Wiki
  migration and indexing after agent population. Hub Code, Knowledge, and Spec
  views read stable index snapshots; ordinary reads never refresh, migrate, or
  repair an index. Health surfaces expose only explicit maintenance actions
  that are safe for the observed state.
- **Official agent skills.** `mex-inbox` and `mex-relay` ship for Claude Code
  and Codex. Setup installs the selected project copies and managed instruction
  anchors; `mex skills sync` safely refreshes them after an upgrade without
  overwriting user-authored instructions or unrelated skills.
- **Agent-safe discovery.** `mex capabilities --json` reports the bounded
  reads, previews, apply operations, and maintenance commands actually
  available in the current checkout.

## Fresh setup

mex requires Node.js 22.5 or newer.

```bash
npx mex-agent@0.8.0 setup
```

Setup preserves existing authored scaffold files, protects
`.mex/graph.db*`, `.mex/wiki.db*`, and `.mex/local/` from Git, and can launch
the first selected available Claude Code or Codex CLI from the project root.
Review the generated canonical files and use the scoped Git commands printed by
setup. MEX does not stage, commit, push, or pull for you.

`mex hub` intentionally remains blocked until the current
`.mex/config.json` bytes are committed at Git `HEAD`. The Graph and Wiki
databases and `.mex/local/` state are disposable checkout-local data and should
not be committed.

## Upgrade and compatibility

```bash
npm install -g mex-agent@0.8.0
mex skills sync
```

Installing the npm package alone does not modify a repository. Run
`mex skills sync` only in projects where you want to activate or refresh the
packaged skills, then start a new Claude Code or Codex session so it loads the
new project instructions.

Compatible schema-v2 and complete schema-v3 Graph stores upgrade losslessly to
schema v4 during explicit maintenance. Schema-v1, partial, or ambiguous stores
require a safe rebuild. Read-only commands never perform the migration.
Existing Markdown scaffolds remain valid.

Before a team publishes new schema-v3 Relays, every teammate should update to
mex 0.8.0 because older binaries cannot parse that Relay format.

The team workflow contracts remain internal rather than new package-root API
exports. Project Hub remains local-only, and Playbook/Catch Up product surfaces,
general Wiki editing UI, and external Relay delivery remain future work.
