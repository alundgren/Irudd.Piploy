# Registering and polling an Application

Use this guide to derive an `Application` payload from an application's
repository and, with human approval, register it through the preconfigured,
Tailscale-reachable production MCP. It intentionally contains no MCP endpoint
configuration, machine or tailnet names, addresses, or secrets.

An Application is one Git repository that Piploy turns into exactly one
container. Do not use this workflow for a group of containers.

This guide is the public half of the workflow. A companion agent-workflow
deployment skill, kept in a separate private repository that this guide
deliberately does not name or link, carries the operational details omitted
here, such as non-secret connection hints. It complements this contract rather
than replacing it: the payload rules, the approval gate, and the boundaries
below hold either way.

## Read-only first

Start with the MCP `status` tool. It is read-only: use it to see the currently
registered Applications, their configured host-to-container `portMappings`,
and their Git and Docker state. `portMappings` is always an array: an empty
array means that Application has no configured host ports. Each entry has a
`hostPort` and `containerPort`, corresponding to the `"hostPort:containerPort"`
form in an Application payload.

Use those configured host ports to avoid a conflict with another Piploy
Application when proposing `PortMappings`. This is not a host-wide port scan:
a port absent from `status` can still be bound by a non-Piploy process, so do
not claim it is globally available. Do not infer that a missing health-check
result or logs are available; this MCP does not promise either.

## Derive the payload from the repository

Before proposing a change, inspect the application repository and confirm:

- the Dockerfile's path relative to the repository root;
- that every `COPY` and `ADD` source in that Dockerfile resolves inside the
  Dockerfile's own directory, because that directory, not the repository root,
  is the build context Piploy sends to Docker;
- which ports the container listens on and which, if any, should be exposed on
  the host;
- the environment variables the container needs, including their literal
  values; and
- which writable paths need to survive a container replacement.

Also read the Dockerfile's `FROM` and external `COPY --from` references.
Piploy accepts only SHA-256-digest-pinned Docker Official Images
(`docker.io/library/*`, including short names) and Microsoft .NET images
(`mcr.microsoft.com/dotnet/*`). `scratch` and earlier build stages are valid;
other external references are rejected. Piploy does not advance image digests
for the Application.

## Application payload reference

`register` accepts one JSON object with these fields. The submitted object is
the persisted form: `PortMappings` and `Volumes` remain strings in
`piploy.json`, even though Piploy parses them into richer values in memory.

| Field | Required | Accepted form and validation | Persistence and effect |
| --- | --- | --- | --- |
| `Name` | Yes | A string containing only letters, numbers, `_`, and `-`. It must not exactly match an already registered Application name; comparison is case-sensitive. | Stored as submitted and used to identify the Application and its data directory. |
| `GitRepositoryUrl` | Yes | Any string at payload validation; it must identify a repository Piploy can clone when it polls. | Stored as submitted. A Poll clones it when absent, otherwise fetches it and resets the local clone to the remote tip. |
| `DockerfilePath` | Yes | Any string at payload validation. During a Poll it must identify a Dockerfile relative to the repository root; a path ending in `/` is rejected. Piploy trims whitespace, accepts `\\` as separators, and strips one leading `/`; examples include `Dockerfile`, `SubDirectory/Dockerfile`, and `Dockerfile.custom`. | Stored as submitted. Its parent path, not the repository root, is the Docker build context: a Dockerfile in a subdirectory can only `COPY` from that subdirectory. |
| `PortMappings` | No | An array of strings, each exactly `<hostPort>:<containerPort>` with digits on both sides, for example `"8080:80"`. | Stored as submitted; parsed into host/container port pairs for the container. Omit it when no host port should be exposed. |
| `Volumes` | No | An array of strings, each `<name>:/container/path`. `name` uses letters, numbers, `_`, or `-`. The container path is absolute, has at least one segment, contains neither `:` nor `..`, and cannot be `/`. Two Volumes for one Application cannot target the same container path. | Stored as submitted; parsed into a named Volume and its container path for the container. |
| `EnvironmentVariables` | No | An object whose keys and values are strings. Values are literal: Piploy performs no interpolation. | Stored as submitted and passed to the container verbatim. Piploy has no secret store, so a credential passed this way is written to `piploy.json` in plaintext. See the production-change gate for how to keep one out of the approval record without weakening the gate. |

Each named Volume resolves to a Piploy-created directory under Piploy's data
directory, alongside its configuration, rather than under `RootDirectory`.
Piploy owns this host location and Application data survives container
replacement; users cannot supply a host path. Choose a Volume name for the
data, not for a location.

### Generic example

Copy and adapt this only after the repository preflight. It deliberately uses
example values and no production topology or secrets.

```json
{
  "Name": "example-app",
  "GitRepositoryUrl": "https://github.com/example/example-app.git",
  "DockerfilePath": "Dockerfile",
  "PortMappings": ["8080:8080"],
  "Volumes": ["app-data:/var/lib/example-app"],
  "EnvironmentVariables": {
    "NODE_ENV": "production",
    "DATA_DIRECTORY": "/var/lib/example-app"
  }
}
```

This example builds from the repository root. A `DockerfilePath` such as
`docker/Dockerfile` is equally valid, but then `docker/` alone is the build
context: only its contents reach Docker, and the repository's other files are
not available to `COPY`. Use a subdirectory path only after confirming the
Dockerfile builds from that directory.

## Production-change gate

`register` and `poll` change production state. Before calling either tool,
state the exact intended action and payload, its expected impact, and its
failure mode; then obtain explicit human approval.

Show the payload exactly, with one exception: replace the value of an
`EnvironmentVariables` entry that carries a credential with a placeholder, and
say which key it belongs to. Every key stays visible, because which variables
the container gets is part of what is being approved; only secret values are
withheld. The call you make after approval uses that same payload with the
real value in place — a redacted approval record never means a redacted
`register`. If a secret has to be rotated or reviewed later, that happens on
the host, not through this workflow.

A useful approval request is:

> I intend to register this Application with the exact payload shown above.
> This writes it to Piploy's configuration and makes it available to the next
> Poll; it does not start a container itself. If validation fails or the name
> is already registered, registration is rejected and the configuration is not
> changed. May I proceed?

After approval of the `register` request, call `register` with that payload,
changing nothing but the restored value of a redacted secret. Then make a
separate, explicit request before polling, for example:

> I intend to run one Poll for all registered Applications, with no payload.
> It will fetch each repository, build what is needed, and start or replace
> containers that are out of date. If an Application fails during its
> repository, image, or container work, Piploy logs that error and continues
> polling the others. May I proceed?

After approval, call `poll`, then call read-only `status` to review the result.
The preferred sequence is therefore:

```text
status → approval → register → approval → poll → status
```

`register` does not start an Application or trigger a Poll. Never call
`service-stop` as part of this guide. Do not promise log access or
Application-level health checks. If the available MCP results are insufficient,
ask for explicit human permission before falling back to SSH.

## Cloudflare Tunnel mapping

Cloudflare Tunnel configuration is currently manual. After the Application is
running, use the chosen **host** side of its `PortMappings` entry as the tunnel
service port — not the container port. For example, a mapping of
`"8080:80"` means Piploy publishes container port `80` on host port `8080`,
so the Cloudflare Tunnel public-hostname service must point to
`http://localhost:8080` (or the equivalent local-host service address for the
tunnel process). State this mapping to the human who maintains the tunnel.
