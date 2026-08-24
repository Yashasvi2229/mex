# Keeping the scaffold honest

The scaffold drifts when code moves and nobody updates the prose that described
it. Run the sync check before proposing a change, and fix what it reports rather
than silencing it.

## What sync checks

It compares the routing edges against the files on disk, the pattern index
against the pattern files, and every recorded grounding against the code it
points at.
