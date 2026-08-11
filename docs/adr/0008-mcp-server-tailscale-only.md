# MCP server, Tailscale-only binding

## Decision

The MCP server introduced by issue #88 will bind only to the IPv4 address
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

## Consequences

The MCP binding remains unreachable from the public internet, but a wrong
selection on a CGNAT uplink could expose it to peers on that shared network.
The explicit startup log makes that failure mode diagnosable. IPv6 Tailscale
addresses are not supported in v1.
