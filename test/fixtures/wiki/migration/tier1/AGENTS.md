# Harbour

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
