# Piploy

Piploy registers a Git repository and its Docker commands, then keeps the
resulting container running as a background daemon on a Raspberry Pi.

## One-time bootstrap

These steps install Piploy on a new Pi. They assume the service user is
`irudd` and its files live in `/home/irudd/Piploy`.

1. Install Node.js 24 from the NodeSource apt repository:

   ```bash
   curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
   sudo apt install -y nodejs
   ```

2. Create Piploy's root directory and place its configuration alongside the
   bundle:

   ```bash
   mkdir -p /home/irudd/Piploy/root
   ```

   Place `piploy.json` at `/home/irudd/Piploy/piploy.json`. Piploy resolves
   configuration relative to the bundle, rather than the current working
   directory. Set `PIPLOY_CONFIG` to use a configuration file elsewhere.

3. Download the current release bundle:

   ```bash
   curl -fL https://github.com/alundgren/Irudd.Piploy/releases/latest/download/piploy.cjs \
     -o /home/irudd/Piploy/piploy.cjs
   ```

   The resulting layout is:

   ```text
   /home/irudd/Piploy/
   ├── piploy.cjs       # installed bundle
   ├── piploy.cjs.prev  # rollback copy, created after the first self-update
   ├── piploy.json      # configuration; self-update never overwrites it
   ├── root/             # application repositories and logs
   └── data/             # persistent application data; Piploy never deletes it
   ```

4. Create `/etc/systemd/system/piploy.service`:

   ```ini
   [Unit]
   Description=Raspberry Pi + Docker application runner
   After=docker.service
   Requires=docker.service

   [Service]
   WorkingDirectory=/home/irudd/Piploy
   ExecStart=/usr/bin/node /home/irudd/Piploy/piploy.cjs service-start
   Restart=always
   RestartSec=10
   SyslogIdentifier=piploy
   User=irudd

   [Install]
   WantedBy=multi-user.target
   ```

5. Register and start the service:

   ```bash
   sudo systemctl daemon-reload && sudo systemctl enable --now piploy
   ```

   On an existing installation, add the two Docker directives to the `[Unit]`
   section, then apply them with:

   ```bash
   sudo systemctl daemon-reload && sudo systemctl restart piploy
   ```

## Running CLI commands

The installed bundle is both the daemon and the command line client:

```bash
node piploy.cjs <command>
```

Piploy resolves `piploy.json` and `piploy.sock` relative to the bundle rather
than the current directory, so the bundle can also be given by an absolute path
from anywhere. Set `PIPLOY_CONFIG` to point at a configuration file elsewhere;
the socket then lives next to that file.

The daemon's control socket is created with `0600` permissions and owned by the
user the daemon runs as, so the commands below must run as that same user to
reach it. Another user gets the offline fallback described under `status`.

| Command         | What it does                                                                                                                                                                                                                  |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `status`        | Prints the Piploy version, whether the background service is reachable, and per-application configured host-to-container port mappings, Git, and Docker state, including the container's state, exit code, and restart count. |
| `logs`          | Prints one application's recent container output, running or exited. `--tail <lines>` sets how much. Requires the daemon to be running.                                                                                       |
| `poll`          | Runs one reconciliation now instead of waiting for the poll timer.                                                                                                                                                            |
| `service-start` | Runs the daemon in the foreground. This is what systemd invokes; do not run it by hand while the service is up.                                                                                                               |
| `service-stop`  | Asks the running daemon to shut down.                                                                                                                                                                                         |
| `register`      | Adds one application to `piploy.json` and to the running daemon, so the next poll deploys it without a restart. Requires the daemon to be running.                                                                            |
| `wipeall`       | Removes all Piploy containers and images and deletes the root directory. Application data is preserved and its paths are printed.                                                                                             |
| `self-update`   | Checks GitHub for a newer release, installs it, then restarts the running daemon through its control socket.                                                                                                                  |
| `--version`     | Prints the running bundle's version.                                                                                                                                                                                          |
| `--help`        | Lists the commands.                                                                                                                                                                                                           |

### `status`

```bash
node piploy.cjs status
```

### `logs`

```bash
node piploy.cjs logs my-app --tail 500
```

Returns at most 2000 lines and 256 KB, keeping the most recent output. Docker
caps what it retains at roughly 30 MB per application, so anything older than
that is already gone. Application logs are returned unredacted and may contain
secrets.

### `register`

```bash
node piploy.cjs register \
  --name my-app \
  --git-repository-url https://github.com/me/my-app.git \
  --dockerfile-path Dockerfile \
  --port-mapping 8080:80 \
  --volume data:/var/lib/my-app \
  --env NODE_ENV=production
```

`--port-mapping`, `--volume`, and `--env` may each be repeated. For scripting,
`--json '<application-json>'` passes the whole application instead; it cannot be
combined with the individual flags.

`--build-context-path` optionally selects the repository-relative directory to
send to Docker as the build context. It accepts `.` for the repository root and
defaults to the parent directory of `DockerfilePath`, preserving existing
registrations. When it is set, Piploy rejects paths that escape the checkout,
contexts or Dockerfiles reached through escaping symlinks, and Dockerfiles
outside the selected context. Docker receives only that context, so `COPY` and
`ADD` cannot use files outside it.

For example, a nested Dockerfile can deliberately build with the repository
root as its context:

```bash
node piploy.cjs register \
  --name api \
  --git-repository-url https://github.com/me/monorepo.git \
  --dockerfile-path services/api/Dockerfile \
  --build-context-path .
```

An `EnvironmentVariables` value is normally literal. The one exception is an
entire value in the form `${hostEnv:NAME}`, where `NAME` starts with a letter or
underscore and then contains only letters, digits, or underscores. Piploy stores
that reference unchanged and resolves it from the daemon's environment only
when it creates or recreates a container; it does not include the resolved value
in its ordinary diagnostics. Restart the daemon after changing its environment,
then make a configuration or commit change that recreates the container for the
new value to apply. Other interpolation-like values remain literal.

### Private GitHub repositories

`GitHubOwnerCredentials` is an optional root-level mapping for private HTTPS
repositories. Each key is a canonical lowercase GitHub owner and each value is
an exact daemon-environment reference. For example:

```json
{
  "Piploy": {
    "RootDirectory": "/home/irudd/Piploy/root",
    "Applications": [],
    "GitHubOwnerCredentials": {
      "alundgren": "${hostEnv:PIPLOY_GITHUB_TOKEN}"
    }
  }
}
```

Piploy reads the token only when Git asks to authenticate an HTTPS request for
`github.com/alundgren/<repository>`. It never writes the token to
`piploy.json`, a Git remote, a Docker context, normal logs, or CLI and MCP
results. Other hosts, SSH URLs, URLs with userinfo, lookalike hosts, and other
owners never receive it. Restart the daemon after setting or renewing the host
environment variable.

When a status fetch cannot complete, Piploy still reports Docker state and adds
a safe Git diagnostic. It distinguishes a missing mapping, an unset host
variable, a rejected credential, a repository that is missing or inaccessible,
and a general fetch failure. GitHub's private-repository response is reported
as "Repository not found or inaccessible", not as a bad token.

## MCP server

While the daemon runs, it also serves an MCP endpoint over Streamable HTTP at:

```
http://<tailscale-address>:8391/mcp
```

It binds only to the machine's Tailscale address, so it is reachable from the
tailnet and from nowhere else. There is no token and no other authentication:
being on the tailnet is the whole of it. If the machine has no Tailscale
address, the daemon logs a warning and starts anyway, without the endpoint.

It exposes six tools — `status`, `logs`, `poll`, `register`, `service-start`,
and `service-stop` — which run exactly what the matching CLI commands do.
`wipeall` and `self-update` are deliberately not exposed. See
[ADR-0008](docs/adr/0008-mcp-server-tailscale-only.md).

## Publishing a release

In GitHub, run the **Release** workflow from the Actions page and enter the
version (with or without a leading `v`). It runs the release checks against the
current default branch, then creates an annotated `vX.Y.Z` tag and publishes
the release.

To create a release from the command line, tag and push it instead:

```bash
git tag vX.Y.Z
git push --tags
```

The release workflow runs linting, tests, and the build, then attaches
`dist/piploy.cjs` to the GitHub release. The running daemon checks GitHub's
latest release on its poll timer. Within one
`MinutesBetweenBackgroundPolls` interval, it downloads the bundle, swaps it
into place, exits, and systemd starts the new version. No action on the Pi is
needed for routine releases.

## Rollback

If a release is bad, roll back manually over SSH:

```bash
mv /home/irudd/Piploy/piploy.cjs.prev /home/irudd/Piploy/piploy.cjs && sudo systemctl restart piploy
```

There is no automatic health check or revert; a release that fails at startup
will remain in systemd's restart loop until it is rolled back manually.

## TODO

- Git commit hook + minimal web server on the Pi to receive the hook so Piploy does not have to poll.
