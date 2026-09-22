# GitHub push notifications schedule targeted Polls

## Decision

An optional `node:http` listener in the daemon binds only to `127.0.0.1` on a
configured port. Its only delivery route is `POST /public/github-webhook`.
The operator supplies an HTTPS origin through a tunnel restricted to this
listener. The server has no private command dispatcher and cannot expose MCP,
status, logs, or administration. Listener failure leaves ordinary polling alive.

The receiver verifies HMAC-SHA256 over bounded raw bytes before parsing JSON.
It accepts signed ping without work. A push must identify a valid default
branch and its matching, non-deleted branch ref. Repository matching accepts
only canonical HTTPS github.com owner/repository identities, ignores case and
a trailing `.git`, and derives Application names from loaded configuration.
The delivery never supplies a clone URL or commit to a Poll. Git independently
resolves the current remote default and commit when the worker runs.

Admission checks the current configuration revision and reserves the complete
matching target set in the existing bounded serial queue. Pending webhook
signals coalesce by exact Application name. The worker removes that pending
marker before starting its Poll, allowing a push during the Poll to schedule
another pass. Manual commands, registration, and full Polls use the same worker.
The receiver responds 202 after admission, before waiting for Git or Docker.

Recent accepted delivery IDs are bounded by count and age. Saturation, stale
configuration and shutdown reject admission with 503, without recording the
ID or queueing only part of a delivery. Queue acceptance and Poll completion
are separate structured log events; a successful HTTP response does not prove
an Application is running the new commit.

## Consequences

There is no durable queue or automatic redelivery. Startup and scheduled Polls
remain recovery after a crash, dropped request, limit rejection or restart.
The operator can manually inspect and redeliver through GitHub. A default
branch changed after a delivery is always resolved again by the Poll.

Limits, manual setup, diagnostics and disabling are documented in
[the webhook guide](../agents/github-webhooks.md). Automatic hook creation and
Piploy-managed tunnels are outside this decision.
