# MCP server, Tailscale-only binding

## Decision

The MCP server binds only to the IPv4 address
selected from Tailscale's `100.64.0.0/10` CGNAT range. It will not listen on a
wildcard or public interface. The daemon will log the selected address when it
starts the MCP server, so the binding is visible to the operator.

Discovery is intentionally independent of an interface name: macOS, for
example, uses `utun*` rather than Linux's `tailscale0`. When multiple addresses
are in the CGNAT range, discovery prefers an interface whose name starts with
`tailscale`; otherwise, it uses the first match, which is arbitrary.

This is a heuristic. `100.64.0.0/10` is RFC 6598 shared address space, so a
host on a CGNAT uplink could have a non-Tailscale address in that range. In
that situation the MCP server could bind to the uplink rather than the
tailnet. Piploy currently runs on a home-network Raspberry Pi, where that
assumption holds. Reconsider an authoritative source such as `tailscale ip -4`
or the Tailscale local API if Piploy must run behind a CGNAT uplink. They are
deferred because they add a runtime dependency on the binary or local socket.

## Exposed tools

The server registers exactly seven tools: `status`, `logs`, `poll`, `register`,
`service-start`, `service-stop`, and `check-github-repository-access`. The
repository-access check accepts one repository-name segment only, fixes the
owner to `alundgren`, and constructs the GitHub URL inside the daemon. It uses
a bounded shallow clone in an operating-system temporary directory and removes
that checkout afterward. It returns only a typed, redacted access result: no
checkout path, repository content, credentials, raw Git error, or logs. It
does not register an Application, change configuration, build, or touch Docker.
`logs` belongs here because it is
read-only; it returns a bounded tail of one Application's container output,
unredacted, so anything on the tailnet can read whatever that Application
prints. `wipeall` and `self-update` are excluded,
and the exclusion is structural — they are simply never registered, so there is
no block list that could drift out of sync with the command set. `wipeall`
destroys every container, image, and file Piploy owns; `self-update` replaces
the running binary. Neither belongs behind a network call.

Each tool builds the same `DaemonRequest` a Unix-socket client would send and
hands it to the same queue through one `dispatch` seam, so an MCP call inherits
the single-worker FIFO ordering and runs the one implementation of that command
([ADR-0007](0007-live-config-mutation-for-register.md)). `service-start` is the
exception: the MCP server lives inside the daemon, so answering the call at all
proves the daemon is running. It enqueues nothing and says so.

The transport is Streamable HTTP in stateless mode (no session id, no session
store) on a plain `node:http` server at `/mcp`, port `8391`, fixed for v1 and
not configurable through `piploy.json`. Stateless mode means a fresh MCP server
and transport per request, which is what makes it safe for one `McpServer` to
own its transport exclusively.

## Rejected: Cloudflare Tunnel with Access

Fronting the MCP server with a Cloudflare Tunnel plus Access policies would
make it reachable from anywhere, at the cost of a second daemon on the Pi, an
account-level dependency, an identity provider to configure, and a publicly
routable hostname for a service that manages the machine. The need for
off-tailnet access is hypothetical today. Tailscale membership is the entire
v1 authentication model: there is no bearer token and no OAuth, because
reaching the port already requires being on the tailnet.

## Graceful degradation

The MCP server starts only after the Unix socket is already listening, and
nothing about it can prevent the daemon from starting. If no Tailscale address
is found, or if binding fails (a taken port, for example), the daemon logs a
warning and carries on serving the socket. Tailscale being down must never cost
Piploy its local control path.

## Consequences

The MCP binding remains unreachable from the public internet, but a wrong
selection on a CGNAT uplink could expose it to peers on that shared network.
The explicit startup log makes that failure mode diagnosable. IPv6 Tailscale
addresses are not supported in v1.
