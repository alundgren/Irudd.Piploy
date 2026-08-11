# Live configuration mutation for register

## Decision

A successful `register` request mutates the daemon's in-memory
`PiploySettings.Applications` array in place, by pushing the newly validated
Application onto it. The orchestrator reads that same array on every `poll()`,
so the next poll deploys the new Application with no orchestrator change and no
daemon restart.

This mutation is **additive only**. Nothing may splice, remove, reorder, or
replace entries in the live array, and no code may replace the `settings`
object itself. Removing or editing an Application means editing `piploy.json`
and restarting the daemon
([ADR-0001](0001-config-validation-and-logging.md)).

The mutation is safe because every request — `register` included — runs through
the daemon's single-worker FIFO queue. A register can therefore never interleave
with a poll that is reading the array. `register` is not special-cased in
queue admission, and it does not trigger a poll of its own: polling stays
Piploy's only trigger.

Disk and memory are updated in that order. `piploy.json` is written first,
through a temporary file and a rename, and the live array is only extended once
that write succeeded. A crash between the two leaves the Application registered
on disk, which the next startup picks up.

`isDuplicateApplicationName` in `registerPolicy.ts` is the pure duplicate-name
check, kept as its own testable seam like `queuePolicy.ts`
([ADR-0002](0002-module-seams-and-test-split.md)). It matches names exactly,
without case folding.

## Consequences

Registering an Application takes effect within one poll interval instead of
requiring an operator to edit a file and restart the service. In exchange, the
settings object is no longer immutable after startup, so any future code that
caches a snapshot of `settings.Applications` — rather than reading it per poll —
would silently miss newly registered Applications.
