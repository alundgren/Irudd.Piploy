# Module seams and the unit/integration test split

## Decision

`dockerPlan.ts` contains the pure Docker decision policy. Given image or
container state, a Git commit, and a runtime-configuration hash, `planImage` and `planContainer` select
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
