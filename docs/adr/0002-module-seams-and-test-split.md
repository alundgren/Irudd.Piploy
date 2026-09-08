# Module seams and the unit/integration test split

## Decision

`dockerPlan.ts` contains the pure Docker decision policy. Given image or
container state, a versioned build identity, an exact image ID, a Git commit,
and a runtime-configuration hash, `planImage` and `planContainer` select
`reuse`, `build`, `start`, or `recreate`; unit tests exercise these functions
with plain values. `docker.ts` is the I/O adapter around dockerode and applies
that policy while also handling cleanup.

Git operations remain a deep adapter in `git.ts`: cloning, fetching, resolving
the branch and tip, and resetting the checkout all require a repository. A
hard reset is composed privately from `writeRef` and `checkout`, so callers
only observe a completed reset. Integration tests with a real HTTP Git remote
verify this behavior.

Production uses one Git adapter and one Docker adapter. The orchestrator is
the only dependency seam: `OrchestratorDeps` exposes just the operations that
`poll()` sequences, allowing its ordering and error handling to be unit-tested
with an in-memory fake. `status.ts` is also pure, comparing already-fetched
Git and Docker state to determine whether an application runs the remote tip.

Failures for one application are logged and do not stop the rest of a poll.
Cleanup always runs after the application loop. The daemon queue's
admit/reject/drop policy is a pure, unit-tested decision; the interval that
submits poll ticks is thin scheduling glue. Client requests may be rejected
when the queue is busy, while timer ticks may be dropped silently.

`piploy_isCreatedByTest` labels containers and images created by integration
tests. Test setup and teardown use `cleanupTestCreated`, keeping unrelated
containers on a developer machine out of test cleanup.

## Module layout

| Module | Boundary | Test coverage |
|---|---|---|
| `git.ts` | clone, fetch, reset, and read commits against a remote | integration |
| `dockerPlan.ts` | pure image and container policy | unit |
| `docker.ts` | dockerode adapter and cleanup | integration, with policy covered by `dockerPlan` unit tests |
| `orchestrator.ts` | poll sequencing through `OrchestratorDeps` | unit |
| `status.ts` | pure running-version comparison | unit |
| `containerLogs.ts` | pure log tail bounds and Docker stream decoding | unit |
| `settings.ts` | configuration loading and Zod validation | unit |
| `commands.ts` / `cli.ts` | command wiring | thin existing coverage |

## Consequences

Unit tests focus on deterministic policy and sequencing. Integration tests
cover behavior whose correctness depends on Git or Docker rather than on a
substitute implementation.

`buildx.ts` owns the opt-in Docker CLI builder operations. `docker.ts` retains
Dockerfile validation, context creation, image identity, container operations,
and Application-image cleanup. Builder state is separate from Application
images. Normal cleanup preserves every image referenced by a container and
never invokes a global prune. A successful build does not imply successful
container replacement.

Build identity hashes the configured repository URL verbatim, exact commit,
normalized Dockerfile path, and effective context. URL aliases are deliberately
not combined, because different configured URLs may identify different sources.
The serialized identity carries a version, and only its hash is stored in image
labels and tags. Runtime-only settings remain in the container hash. Omitted
context retains the Dockerfile-parent default. Both builders use this policy.

Image reuse requires matching identity metadata. The build's unique tag locates
and validates its result, so another build moving a compatibility tag cannot
select the wrong result. The orchestrator carries the selected image ID into
container creation. Ordinary reuse and concurrent-create adoption compare that
ID alongside existing runtime checks. Legacy commit tags alone are cache misses.
See [upgrade behavior](../../README.md#image-reuse-and-upgrades).
