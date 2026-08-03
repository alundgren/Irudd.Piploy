# Irudd.Piploy

Registers a git repo + docker commands to run a service, and makes sure they are always running. Runs as a background daemon on a Raspberry Pi.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `alundgren/Irudd.Piploy`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Dotnet-to-TypeScript migration in progress

`Irudd.Piploy.App` (C#) is legacy but still the code actually running on the
Pi — it is not dead code. `src/` (TypeScript) is the port target and is
incomplete; e.g. there is no Docker module yet. Deleting `Irudd.Piploy.App`
is the last step of the port, tracked by
[issue #17](https://github.com/alundgren/Irudd.Piploy/issues/17), and won't
happen until then.

Before changing behavior around git, Docker, config, or deploy — in either
codebase — check [issue #1](https://github.com/alundgren/Irudd.Piploy/issues/1)
(the wayfinder map) for the port's current state and decisions. A change
scoped only against its own issue text can easily land in the wrong
codebase, or in one but not both, and get silently dropped when the dotnet
project is deleted.

## TypeScript verification

Run `pnpm lint` and `pnpm test` before considering TypeScript changes complete.
