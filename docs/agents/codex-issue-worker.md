# Local Codex issue worker

`scripts/codex-issue-worker` is an opt-in local worker that implements at most
one GitHub issue at a time. It runs only when this Mac is on and the launchd
job is loaded. It is **disabled by default**.

## Safety contract

- An issue must be open and have both `ready-for-agent` and `codex:implement`.
- The worker adds `codex:claimed` before making a worktree. While any open
  issue has that label, it will not pick another issue.
- Codex receives issue text through an ignored local file and is explicitly
  told to treat it as untrusted requirements. It may not commit, push, label,
  close, or merge anything. The controller rejects a run that makes a commit
  or changes the controller's own files.
- Work happens in `.codex-issue-worker/worktrees/issue-<n>`, not in the main
  checkout.
- The configured checks run after Codex returns. A PR is opt-in and still
  requires human review. The worker never merges.
- It records token totals from Codex's JSON completion events. It will not make
  a follow-up run after the pre-turn guard, and it will not automatically create
  a PR after the total meets the budget.

The final point is an operational guard, not a hard mid-turn cutoff: Codex
reports token usage when a turn completes. A single run can therefore cross the
budget before the controller can stop it. Keep the pre-turn threshold below the
budget and begin with small, tightly scoped issues.

When the guard stops a held issue, inspect the worktree and recorded usage. To
authorize exactly one additional Codex run, use:

```bash
scripts/codex-issue-worker approve-budget 123
scripts/codex-issue-worker continue 123
```

The approval is consumed by `continue`; crossing the budget again requires a
new explicit approval. This prevents a scheduler from silently continuing a
high-cost issue.

## First-time setup

Run from the repository root:

```bash
chmod +x scripts/codex-issue-worker
scripts/codex-issue-worker init
# Review .codex-issue-worker/config.sh. Keep AUTO_CREATE_PR=false initially.
scripts/codex-issue-worker bootstrap-labels
scripts/codex-issue-worker enable
scripts/codex-issue-worker run --dry-run
```

To give it an issue, add both `ready-for-agent` and `codex:implement`. A normal
run (`scripts/codex-issue-worker run`) claims the oldest eligible issue.

After reviewing and closing the issue, release the gate:

```bash
scripts/codex-issue-worker release 123
```

Use `scripts/codex-issue-worker disable` to stop future runs. Disabling does
not interrupt an already running Codex process; let it finish, or stop that
process deliberately after inspecting it.

## Run while this laptop is on

`launchd` requires absolute paths, so the worker generates its local plist at
installation time. The checked-in files contain no user or repository path;
the generated plist uses the current checkout path and is stored under your
`~/Library/LaunchAgents` directory.

```bash
scripts/codex-issue-worker install-launchd
```

Unload the job to stop polling completely:

```bash
scripts/codex-issue-worker uninstall-launchd
```

Prefer `disable` as the normal kill switch, since the worker verifies it before
each action. Loading the job is an additional "this laptop only" gate.

## Cloud transition

Keep the labels, state machine, prompt, and budget-accounting contract. Replace
launchd with one trusted worker process or a GitHub Actions workflow protected
by a single concurrency group and an explicit repository-variable kill switch.
Use an isolated runner/worktree and a narrowly scoped GitHub token. Do not move
the local Codex authentication file to a shared or public runner.
