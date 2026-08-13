# Docker maintains declared Application containers

## Decision

Piploy creates each Application container with Docker's `unless-stopped`
restart policy and without `AutoRemove`. A Poll remains the only operation
that changes the declared state: it selects an Application's repository
commit and runtime configuration, then creates, replaces, or starts its one
container. Docker may restart that already-declared container after an
unexpected exit or host reboot.

The restart policy is part of the container configuration hash. Existing
containers therefore differ from the new declared configuration and are
recreated on their next Poll.

While Docker reports a matching container as `restarting`, Piploy reuses it.
It must not repeatedly remove and recreate a crash-looping container. A
matching `exited` container remains a `start` action: a manual Docker stop
does not change Piploy's configuration, so the next Poll resumes the declared
Application.

`unless-stopped` is used rather than `always`. It preserves Docker's explicit
manual-stop behaviour across a Docker daemon restart, and Piploy's cleanup
path still explicitly stops and removes containers for Applications no longer
declared.

## Consequences

- Recovery from an Application crash or Pi reboot no longer waits for the next
  Poll, provided Docker itself is running.
- A stopped container and its bounded Docker logs remain available for
  diagnosis. Log bounds are set separately by the container log configuration.
- Docker is an enforcer of Piploy's declared state, not a second source of
  configuration or an inbound trigger to Piploy.
- Container logs and restart/exit reporting are read back through `status` and
  the read-only `logs` tool ([ADR-0008](0008-mcp-server-tailscale-only.md)).
  Because a crash-looping container is `Running` to Docker while it waits out
  its restart backoff, Piploy reports the inspected state rather than the list
  state, so a crash loop is never mistaken for the latest running version.
- Cleanup removes a container rather than stopping it. Without `AutoRemove` a
  stop would leave it behind, holding its image and occupying its
  Application's slot.
