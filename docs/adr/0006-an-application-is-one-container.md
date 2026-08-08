# An Application is exactly one container

Registering `life` raised the first real demand for a second container: the app
talks to Ollama, and its Compose file runs the two side by side. Piploy keeps
its existing shape instead — an Application is one Git repository that becomes
one container — and Ollama runs natively on the Pi under its own systemd unit,
reached over the Docker bridge. Piploy gains no concept of multi-container
applications, service discovery, dependency ordering, or health gating, and
contains no reference to Ollama.

## Considered options

- **`Application` gains a `Containers: []` array.** Rejected: that is Compose
  re-implemented in JSON, and every Compose feature then becomes a plausible
  request. Compose itself was already ruled out during the port for a separate
  reason — it is a CLI plugin with no daemon API.
- **A new `Service` / `Dependency` noun** that Piploy understands as either
  containerised or host-native, wiring the URL into dependent Applications.
  Rejected: routing through the host erases the distinction the noun exists to
  model, so it would earn nothing. Both modes reduce to whether a second
  ordinary Application entry exists.
- **Running Ollama as a second Application** built from `life`'s own
  `docker/ollama/Dockerfile`. Possible under this decision, but rejected in
  favour of native: it requires amending
  [ADR-0004](0004-supply-chain-controls.md), because `ollama/ollama` is a
  third-party Docker Hub publisher that no digest pin can make compliant.
  Native Ollama keeps ADR-0004 untouched, and gains `Restart=always` under
  systemd.

## Consequences

- Applications reach host-native dependencies through the Docker bridge
  gateway, configured as a literal address in an environment variable. Piploy
  does not resolve, inject, or validate it.
- Piploy cannot express startup ordering. An Application that depends on
  something else must tolerate it being unavailable at boot.
- The generic features this drove — Volumes and environment variables — carry
  no knowledge of what they are used for, so they serve any future Application.
- Reversing this means adding a container-grouping concept from scratch. The
  cost is deliberate: it is what keeps Piploy from drifting into Compose.
