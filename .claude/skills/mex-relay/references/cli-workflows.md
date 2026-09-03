# Relay CLI workflows

Use JSON mode for deterministic agent work. Keep request and preview files temporary and avoid displaying them unless troubleshooting.

## Resolve only the needed contract

Run:

```text
mex relay contract --action <command-id> --json
```

Use one of these command IDs:

- `relay.draft.save`
- `relay.draft.delete`
- `relay.publish`
- `relay.acknowledge`
- `relay.close`

Treat this bounded action result as the exact runtime source for the request shape, available examples, constraints, preview command, and apply command. Do not dump `mex capabilities --json` or the full Relay contract during ordinary execution. Write request and preview JSON only to ordinary regular files inside the checkout or an approved temporary directory; do not use symlinks.

## Resolve recipients and optional context

1. Run `mex member list --active --limit 100 --json`, following bounded cursors when present, and match the user's names or team intent to active Members.
2. Use `mex member show <member-id> --json` when a candidate needs disambiguation or a current artifact revision is required.
3. Stop and ask for recipient clarification when multiple active Members remain plausible, no active Member matches, or bounded results cannot prove uniqueness. Relay stores individual Members, so never fabricate a group for “the backend team.”
4. Default to no Workstream lookup. If the user named a Workstream or the handoff clearly belongs to an existing one, run `mex workstream list --json` and `mex workstream show <workstream-id> --json` to resolve it exactly.
5. In Relay v3, preserve a relevant Workstream as typed entity evidence when the selected contract supports it; do not author the legacy top-level Workstream field.

Never fabricate recipient IDs, entity IDs, revisions, commits, code fingerprints, paths, URLs, or provenance.

## Save a checkout-local draft

1. Resolve `relay.draft.save`.
2. Create a unique operation ID and a standalone draft with active recipient references and a concise summary.
3. Include only useful non-empty context sections. Prefer accurate omissions over invented completeness.
4. For a new draft, provide no unrelated expectations. For an existing draft update, read it with `mex relay draft show <draft-id> --json` and use its exact local revision.
5. Preview with `mex relay draft save <request-file> --json` and capture the complete successful JSON wrapper unchanged. Require `ok: true`, `mode: "preview"`, and `data.preview.valid: true`.
6. Summarize recipients and continuation state. If the user asked to create/save/draft, apply with `mex relay draft save --apply <preview-envelope> --json` without another confirmation.
7. Read the returned draft ID and respond with `/relays?view=drafts&draft=<id>`.

The apply writes only checkout-local draft state in `.mex/local/team.db`. It does not create a canonical Relay or Activity record, deliver a handoff, commit, push, or notify anyone. Apply before the preview expires; if anything changes or the preview becomes stale, preview again instead of reconstructing it.

## Delete a local draft

1. Read the exact draft and current local revision.
2. Resolve and preview `relay.draft.delete`.
3. Explain that the checkout-local draft will be deleted and wait for fresh confirmation.
4. Apply the captured preview unchanged with `mex relay draft delete --apply <preview-envelope> --json`.

## Publish a Relay

1. Read the exact draft and every active recipient Member required by the selected contract.
2. Resolve `relay.publish`, build exact draft/member expectations, and preview with `mex relay publish <request-file> --json`.
3. Explain that applying replaces the private local draft with canonical Git-tracked Relay and Activity records in the working tree, records the service-observed branch/HEAD/dirty repository state without copying dirty source contents, and does not deliver through a notification service or share before Git commit/push and teammate pull/refresh.
4. Wait for fresh explicit confirmation.
5. Apply the exact preview with `mex relay publish --apply <preview-envelope> --json`.
6. Return `/relays?view=sent&state=open&relay=<relay-id>`.

## Take a Relay

1. Resolve the exact published Relay with `mex relay show <relay-id> --json` and verify that the current actor is an intended active recipient.
2. Resolve `relay.acknowledge` and preview with `mex relay acknowledge <request-file> --json`.
3. Explain that applying makes the current recipient the sole claimant, prevents another recipient from taking it, and writes canonical Relay/Activity state in the working tree. There is no unclaim or reassignment action, and it does not assign or start a task elsewhere.
4. Wait for fresh explicit confirmation, then apply the exact preview with `mex relay acknowledge --apply <preview-envelope> --json`.
5. Return `/relays?view=mine&state=open&relay=<relay-id>`.

## Close a Relay

1. Resolve the exact acknowledged Relay and its current revision.
2. Resolve `relay.close` and preview with `mex relay close <request-file> --json`.
3. Explain that applying irreversibly marks only the handoff as no longer needing attention and writes canonical Relay/Activity state in the working tree.
4. Wait for fresh explicit confirmation, then apply the exact preview with `mex relay close --apply <preview-envelope> --json`.
5. Return `/relays?view=all&state=closed&relay=<relay-id>`.

Closing does not complete a linked task, issue, pull request, or Workstream. No lifecycle command stages, commits, pushes, pulls, or sends a notification.
