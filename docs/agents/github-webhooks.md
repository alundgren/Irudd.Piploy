# GitHub webhook setup

A verified GitHub push can queue a Poll for every registered Application using
that repository's default branch. The Poll still fetches the current remote
default and commit. A delayed delivery cannot select old code.

1. Create a strong random signing secret and place it in the Piploy daemon's
   host environment as `PIPLOY_GITHUB_WEBHOOK_SECRET`. Use a protected host file
   or your service manager's environment configuration. Do not put its value in
   `piploy.json`, an Application environment, a URL, or shell history.
2. Add the following object inside `Piploy` in `piploy.json`, choosing an unused
   loopback port and your public HTTPS origin:

   ```json
   "GitHubWebhooks": {
     "Enabled": true,
     "Port": 8392,
     "PublicUrl": "https://hooks.example.com",
     "Secret": "${hostEnv:PIPLOY_GITHUB_WEBHOOK_SECRET}"
   }
   ```

   `PublicUrl` is an HTTPS origin, with no credentials, path, query, or fragment.
   The webhook endpoint appends `/public/github-webhook`. `Enabled` defaults to
   false; the other three values are required when it is true. Changes to this
   configuration or the daemon's signing secret require a service restart.
3. Configure your operator-managed tunnel to forward only this webhook host
   and path to `http://127.0.0.1:8392/public/github-webhook`. Reject other paths
   at the tunnel. Never point this public hostname at MCP port 8391, the daemon
   socket, or another administration endpoint. This listener is part of the
   daemon process, not an Application or Docker container. Piploy does not
   create, start, or manage the tunnel.
4. Restart Piploy. Check its logs for `event=github-webhook-listener` and the
   configured port. A missing host secret or busy port logs an actionable
   warning while ordinary commands and scheduled Polls continue.
5. Configure `GitHubOwnerCredentials` for each repository owner with an exact
   host-environment reference. For example, `"owner": "${hostEnv:GITHUB_TOKEN}"`.
   Grant that token access to the repositories, Contents read access for Git,
   and Webhooks write access for hook creation. Restart after credential changes.
   Once the receiver is ready, Piploy lists hooks and creates an active JSON push
   hook with the configured signing secret and TLS verification if the exact
   callback URL is missing. Applications sharing a repository share one hook.
6. Check the hook's Recent deliveries. A signed ping returns 200 without work.
   Push to the repository's actual default branch, which need not be `main`.
   A matching push returns 202 promptly. Check per-Application
   `event=github-webhook-queue` and `event=github-webhook-poll` logs, then use
   ordinary private status to verify the Application is running its new commit.

Only canonical URLs such as `https://github.com/OWNER/REPOSITORY` and the same
URL with `.git` match configured Applications. Matching ignores owner/repository
case. Credentials, explicit ports, extra path segments, query strings, SSH
URLs and lookalike hosts do not match. Multiple Applications using that
repository each receive a targeted Poll; other Applications are untouched.

## Limits and diagnostics

The listener accepts at most 32 simultaneous TCP connections. Each connection
has a five-second absolute lifetime, including headers and body. Headers are
limited to 16 KiB and a body to 1 MiB. A connection handles one request and
closes afterward. Delivery IDs must contain 1 to 128 ASCII letters, digits or
hyphens. These finite limits may reject unusually large or slow GitHub
requests. The tunnel must preserve the raw body and signature header.

The shared daemon queue holds at most 1,000 pending commands by default.
Webhook signals already pending for an Application coalesce. A new delivery
while that Application's Poll runs queues a subsequent pass. Matching targets
are admitted together or none are admitted. Accepted delivery IDs are kept in
memory for up to one hour, with at most 4,096 entries; reaching the count limit
evicts the oldest ID. Repeating an ID still in that window does not queue work.
A failed admission does not remember the ID. Restarts clear both queue and IDs.

Receipt logs distinguish `accepted`, `coalesced`, `duplicate`, `ignored-*`, and
`rejected-*` outcomes. Queue logs identify trusted Application names. Poll logs
report completion or failure and elapsed milliseconds separately. Acceptance
only means the signal was queued or coalesced, not that its Poll succeeded.
Bodies, signatures and signing secret values are never logged by the receiver.

- 200: signed ping, ignored event/ref, or unknown repository; no work queued.
- 202: admitted/coalesced work or an already accepted delivery ID.
- 400: malformed JSON or payload. Check the hook sends JSON push payloads.
- 401: absent or invalid signature. Check both signing secrets and whether the
  tunnel changes raw request bytes.
- 404/405: wrong route or method. Only POST at the exact webhook path is valid.
- 413: body exceeds the limit. Use an ordinary Poll to catch up.
- 408 or a closed connection: timeout or connection limit. Inspect the tunnel.
- 503: queue saturation, shutdown, unavailable handling, or changed on-disk
  configuration. The response includes `Retry-After: 5`. Restart after config
  changes; otherwise retry when capacity returns or run an ordinary Poll.

GitHub does not automatically retry failed webhook deliveries. Use its manual
redelivery control when needed, or run `poll` through the ordinary private
interface. Startup and scheduled full Polls remain the recovery mechanism for
missed signals. There is no durable webhook queue or automatic redelivery
service. A configuration edit after admission can also cause queued work to
fail its revision check; restart to load it and recover with the startup Poll.

## Disable

Disable or remove the GitHub hook, remove the tunnel's webhook route,
set `GitHubWebhooks.Enabled` to false, and restart Piploy. Confirm the webhook
port no longer listens. Ordinary startup, scheduled, and manual Polls continue.
Remove the host signing secret when no hook uses it.

See GitHub's [signature validation guide](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
and [delivery guidance](https://docs.github.com/en/webhooks/using-webhooks/best-practices-for-using-webhooks).


## Automatic missing-hook creation and maintenance

Reconciliation starts after listener readiness, after successful registration,
and on a fixed ten-minute timer independent of Poll duration. Concurrent requests
coalesce. Each repository is attempted at most once per ten minutes after its
previous attempt finishes, so a retry may wait until the following timer tick.
Newly registered repositories can be handled immediately. Requests time out after
ten seconds, list responses are limited to 1 MiB, and pagination to 100 pages of
100 hooks. Exceeding a limit prevents creation and calls for manual inspection.
API requests are serial and run outside the Poll worker. GitHub rate-limit delays
can postpone all hook requests beyond the normal interval. There are no immediate
create retries: each later attempt lists hooks again, including after a timeout
or conflict where creation may have succeeded.

A successful registration remains saved and successful if hook creation fails.
Read `githubHooks` in private daemon status or `event=github-hook-reconciliation`
in logs for per-repository results and the last failure. Missing credentials
require a populated owner environment reference; 401 requires replacing the token;
403 requires Webhooks write permission; 404 requires checking repository access
and the configured URL. Outages and rate limits retry automatically. Unsupported
repository URLs are skipped with the Application name, never the unsafe URL.
Ordinary polling continues in all these cases. A missing signing secret, listener
bind failure, or changed configuration prevents hook creation. Restart after
configuration changes. No API response bodies, tokens, or signing secrets appear
in these diagnostics.

An exact callback URL always prevents another hook from being created, even if
its existing hook is disabled or misconfigured. Piploy only lists and creates:
it never updates, reactivates, deletes, or replaces hooks. Fix reported push-event,
JSON, delivery, or TLS-verification mismatches manually in GitHub. An existing
hook's secret cannot be verified from listing. Send a signed default-branch push,
inspect Recent deliveries for a 202 response, and check matching receiver and
Poll logs. A successful list or create result alone does not verify tunnel access
or delivery signature setup.

For URL rotation, change the configured HTTPS origin and tunnel route, then
restart. Piploy may create a hook for the new exact URL; remove the old hook
manually. For signing-secret rotation, update the host environment and all existing
hooks using that receiver, then restart and verify signed deliveries. Piploy does
not adopt or overwrite existing secrets. Removing an Application or disabling the
feature leaves hooks behind for operator cleanup. Unknown-repository deliveries
cannot trigger a Poll. Disable the feature and remove unused hooks and tunnel
routes as described above.

See GitHub's [repository webhook API](https://docs.github.com/en/rest/repos/webhooks)
for list/create permissions and fields.
