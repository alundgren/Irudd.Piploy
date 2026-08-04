# Irudd.Piploy

Registers a git repo + docker commands to run a service, and makes sure they are always running. Runs as a background daemon on a Raspberry Pi.

## Agent skills

### Issue tracker

Issues live as GitHub issues in `alundgren/Irudd.Piploy`, managed with the `gh` CLI. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical triage roles, each label string equal to its name. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context — `CONTEXT.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.

## Implementation context

Piploy is implemented in TypeScript under `src/`. Before changing behavior
around git, Docker, configuration, or deployment, check
[issue #1](https://github.com/alundgren/Irudd.Piploy/issues/1) and the
relevant ADRs for the project's settled decisions.

## TypeScript verification

Run `pnpm lint` and `pnpm test` before considering TypeScript changes complete.
