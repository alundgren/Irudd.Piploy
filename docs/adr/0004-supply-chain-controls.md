# Supply-chain controls for dependencies and Docker base images

Piploy is a privileged daemon: it installs its own dependencies, clones
configured application repositories, and asks the Docker daemon to build
those repositories. Application repositories remain trusted input, but two
inputs outside their reviewed commits need an explicit policy.

## Decision

Piploy uses a supported, pinned pnpm 11 release. Dependency resolution has an
eight-day minimum release age, fails closed when publish-time data is missing,
does not trust an already-written lockfile over the current policy, blocks
exotic transitive sources, and prevents trust-policy downgrades. Dependency
install scripts are default-deny; `esbuild` is the sole reviewed exception.
Release installs are frozen, and releases publish a CycloneDX SBOM and the
pnpm audit report alongside the bundled daemon.

Before calling Docker to build an application image, Piploy validates the
resolved Dockerfile text. Every external `FROM` and `COPY --from` reference
must be pinned to a SHA-256 digest and be either a Docker Official Image
(`docker.io/library/*`, including short names) or a Microsoft .NET image
(`mcr.microsoft.com/dotnet/*`). `scratch` and earlier Docker build stages are
not external references and remain valid. The validator collects every
violation and prevents Docker from being called when one is found.

## Consequences

New packages take at least eight days to enter a Piploy build and an unknown
or unreviewed install script cannot run during installation. The SBOM and
audit add detection for known vulnerabilities but do not replace release-age
quarantine.

Application Dockerfiles must update base-image digests in reviewed commits.
Piploy never advances a digest automatically. The policy establishes image
identity and allowlisted publishers; it does not sandbox Dockerfile build
commands or verify image signatures/provenance.
