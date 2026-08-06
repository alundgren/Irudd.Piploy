# Configuration validation and logging

## Decision

`piploy.json` is Piploy's supported configuration contract. It contains a
top-level `Piploy` object with `RootDirectory`, `Applications`, optional
`MinutesBetweenBackgroundPolls`, and optional `IsTestRun`. Each application
has `Name`, `GitRepositoryUrl`, `DockerfilePath`, optional `PortMappings`,
optional `Volumes`, and optional `EnvironmentVariables`. Names may contain
letters, numbers, underscores, and hyphens. Port mappings are validated as
`<hostPort>:<containerPort>` and converted to typed port pairs while the
configuration is parsed. Volumes are validated as
`<name>:/container/path` and likewise converted to typed names and container
paths; host paths and `..` are rejected. Environment variables are passed to
Docker verbatim, without interpolation.

The daemon reads and validates configuration once at startup. Restart Piploy
after changing `piploy.json`.

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
deployment. Log files are compact and directly readable, but changing the log
format or retention policy requires an explicit compatibility decision.
