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

## Shared-agent Git workflow

### Start new work from the remote main branch

Before starting any new implementation work, refresh the remote tracking ref:

```sh
git fetch origin main
```

Treat the freshly fetched `origin/main` as the source of truth. Do not assume a
local `main` branch is current, and do not use `git pull` as a substitute for
this check. Create new work from `origin/main`:

```sh
git switch --create <agent>/<topic> origin/main
```

Use an agent identifier such as `claude`, `codex`, or a human username, with a
short, descriptive topic. Before reusing an existing branch, fetch first and
confirm that the branch is the intended one; otherwise create a new branch.

### Keep agent work isolated

- Work only in your assigned worktree and on your own `<agent>/<topic>` branch.
- Do not commit, reset, rebase, force-push, or delete another agent's branch.
- If your worktree has uncommitted changes or commits that must be preserved,
  stop and ask for direction before rebasing, resetting, or changing branches.
- Before opening a pull request, fetch `origin/main` again and verify the diff
  is scoped to the intended work. Target the pull request at `main` unless the
  task specifies another base branch.

## TypeScript verification

Run `pnpm lint` and `pnpm test` before considering TypeScript changes complete.
