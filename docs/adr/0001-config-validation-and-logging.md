# Configuration validation and logging

## Decision

`piploy.json` is Piploy's supported configuration contract. It contains a
top-level `Piploy` object with `RootDirectory`, `Applications`, optional
`MinutesBetweenBackgroundPolls`, and optional `IsTestRun`. Each application
has `Name`, `GitRepositoryUrl`, `DockerfilePath`, optional `BuildContextPath`,
optional `PortMappings`, optional `Volumes`, and optional `EnvironmentVariables`. Names may contain
letters, numbers, underscores, and hyphens. Port mappings are validated as
`<hostPort>:<containerPort>` and converted to typed port pairs while the
configuration is parsed. Volumes are validated as
`<name>:/container/path` and likewise converted to typed names and container
paths; host paths, `..`, the container root, a second colon — which Docker
would read as mount options — and two Volumes of one Application sharing a
container path are all rejected. Environment-variable values are literals,
except that an entire value exactly matching `${hostEnv:NAME}` (where `NAME`
uses letters, digits, and underscores and does not start with a digit) is a
reference to the daemon's host environment. Piploy persists that reference,
uses the reference itself in its container identity, and resolves it only when
it is about to create or recreate a container. It never writes the resolved
value to its normal diagnostics. A daemon-environment change takes effect only
after restarting the daemon and a later configuration- or commit-driven
container recreation; all other interpolation-like strings remain literal.

`GitHubOwnerCredentials` is an optional root-level mapping of canonical
lowercase GitHub owners to exact `${hostEnv:NAME}` references. Piploy retains
only those references. It reads a mapped value only when isomorphic-git asks to
authenticate an exact `https://github.com/<owner>/<repository>` request, then
passes it only through that request's authentication callback. SSH URLs,
userinfo, alternate ports, lookalike hosts, other owners, and non-GitHub hosts
never receive a credential. Resolved GitHub values are absent from persisted
configuration, Git remotes, Docker input and hashes, normal logs, errors, and
CLI/MCP results. A token change takes effect after the daemon restarts.

Git operations report only these safe failures across the adapter boundary:
credential not configured, configured host variable missing, credential
rejected, repository inaccessible or not found, and transport or fetch failure.
Status keeps the application's Docker state when a Git fetch fails, sets
`git` to `null`, and includes the safe diagnostic. A `null` Git value without a
diagnostic still means the repository has not been cloned. GitHub's ambiguous
private-repository 404 is reported as inaccessible or not found, never as a
rejected credential.

`RootDirectory` is rejected when it overlaps the data directory in either
direction, because `wipeall` deletes `RootDirectory` recursively and
Application data must survive it (see
[ADR-0005](0005-application-state-and-volume-model.md)).

The daemon reads and validates configuration once at startup. Restart Piploy
after changing `piploy.json`.

The one exception is `register`, which adds a single Application. It validates
the payload, rejects a duplicate `Name`, re-validates the whole resulting
configuration, writes `piploy.json` through a temporary file and a rename, and
then adds the Application to the daemon's live configuration, so the next poll
deploys it without a restart (see
[ADR-0007](0007-live-config-mutation-for-register.md)). Every other change to
`piploy.json` — editing or removing an Application, `RootDirectory`,
`MinutesBetweenBackgroundPolls` — still requires a restart.

Piploy uses pino for level filtering and contextual child loggers. It writes
human-readable text lines in the form `timestamp [key=value, ...] message`;
the expected operator workflow is SSH access and reading the log file. Docker
build progress is logged at `debug`, with one `info` summary when a build
completes.

Logs live in `<RootDirectory>/logs`. Piploy keeps one file for the current
Monday-first calendar week, named `piploy-log-<year>-<week>.txt`, and removes
older Piploy log files when it writes a line. Week 1 begins on January 1; this
is intentionally not ISO 8601 week numbering.

## Consequences

Configuration errors fail at startup instead of surfacing later during a
Poll. Log files are compact and directly readable, but changing the log
format or retention policy requires an explicit compatibility decision.
