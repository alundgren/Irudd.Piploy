# The Docker endpoint is pinned to the local Unix socket

Piploy manages containers on the single host it runs on, but `new Dockerode()`
with no options does not say that — it delegates transport selection to
`docker-modem`, which consults `DOCKER_HOST` and related environment at
construction time. **`docker.ts` constructs Dockerode with an explicit
`socketPath` for the local daemon socket instead, so the environment can no
longer choose the transport.** This makes a single-host daemon's one real
assumption an enforced invariant rather than a deployment coincidence, and it
is the precondition for [ADR-0006](./0006-self-contained-bundle.md): with the
SSH and TCP transports unreachable by construction, stubbing `ssh2` and
`cpu-features` out of the bundle is provably safe rather than a bet that a code
path is dead.

## Considered options

**Keep the environment in charge** (status quo) was rejected because it leaves
`ssh2` genuinely reachable: a stray `DOCKER_HOST=ssh://…` in the systemd unit
or the service user's environment would enter a stubbed transport and fail
inside a shim with an unreadable error.

**Keep remote Docker as a supported capability**, with the stub throwing a
legible error instead of being inert, was rejected because nothing in Piploy
uses it — it is dead weight on an artifact whose whole purpose is to be small
and self-contained.

## Consequences

Remote Docker over `DOCKER_HOST` is not supported and setting it has no
effect. Restoring it means reversing this ADR *and* un-stubbing `ssh2` in the
bundle — the two are one decision, which is why the rejection is recorded here
rather than left to be re-proposed.
