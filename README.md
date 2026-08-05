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
   ├── piploy.cjs       # deployed bundle
   ├── piploy.cjs.prev  # rollback copy, created after the first self-update
   ├── piploy.json      # configuration; deployments never overwrite it
   └── root/             # application repositories and logs
   ```

4. Create `/etc/systemd/system/piploy.service`:

   ```ini
   [Unit]
   Description=Raspberry pi + docker deployment tool

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

## Running CLI commands

The deployed bundle is both the daemon and the command line client:

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

| Command | What it does |
| --- | --- |
| `status` | Prints the Piploy version, whether the background service is reachable, and per-application Git and Docker state. |
| `poll` | Runs one reconciliation now instead of waiting for the poll timer. |
| `service-start` | Runs the daemon in the foreground. This is what systemd invokes; do not run it by hand while the service is up. |
| `service-stop` | Asks the running daemon to shut down. |
| `wipeall` | Removes all Piploy containers and images and deletes the root directory. Destructive. |
| `self-update` | Checks GitHub for a newer release and installs it. |
| `--version` | Prints the running bundle's version. |
| `--help` | Lists the commands. |

### `status`

```bash
node piploy.cjs status
```

```text
Piploy version: v1.2.3
Background service: running

my-application
  Running latest version: yes
  Latest local commit: 6f1c2ab...
  Latest remote commit: 6f1c2ab...
  Latest image hash: 6f1c2ab...
  Running container hash: 6f1c2ab...
```

- **Background service** — `running` when the daemon answered on its socket.
  `not running` means Piploy could not reach the daemon and computed the rest
  of the report itself by inspecting Git and Docker directly. The application
  lines are still accurate in that case; only the daemon is missing. If this
  says `not running` while `systemctl status piploy` says the unit is active,
  the likely cause is running the command as the wrong user.
- **Running latest version** — `yes` only when the running container was built
  from the current remote commit. Anything else (no container, a container
  built from an older commit, an unreachable remote) reports `no`.
- **Latest local commit** — the tip of Piploy's local clone of the repository.
- **Latest remote commit** — the tip of the tracked remote branch. A newer
  remote than local commit means the next poll has work to do.
- **Latest image hash** / **Running container hash** — the commit each was
  built from. A newer image hash than container hash means the image built but
  the container has not been swapped yet.

Any field reads `none` when the underlying object does not exist yet — for
example before the first clone, build, or start.

`status` fetches from each Git remote to read the remote tip, so it needs
network access and takes as long as the slowest fetch. It only reads: it never
builds, starts, or stops anything.

### `poll`

```bash
node piploy.cjs poll
```

Fetches each repository, rebuilds when the remote moved, and restarts
containers that are not running the latest image. The command waits for the
reconciliation to finish and prints `Poll completed.`

The daemon serializes work, so a `poll` issued while it is already busy waits
its turn. If no daemon is reachable, `poll` performs the same reconciliation
in the foreground process instead.

### `service-stop`

```bash
node piploy.cjs service-stop
```

Stops the daemon after it finishes any in-flight work. Under systemd the unit
is configured with `Restart=always`, so the service comes back after
`RestartSec`. To keep it down, use systemd instead:

```bash
sudo systemctl stop piploy
```

Unlike the other commands, `service-stop` has no offline fallback: it fails
with `No Piploy daemon is reachable.` and a non-zero exit code when nothing is
listening.

### `self-update`

```bash
node piploy.cjs self-update
```

Forces the release check that the daemon otherwise performs on its poll timer.
It downloads the latest `piploy.cjs`, moves the current bundle aside to
`piploy.cjs.prev`, and swaps the new one into place. Running it by hand only
replaces the file — the daemon keeps running the old bundle until it is
restarted:

```bash
sudo systemctl restart piploy
```

### `wipeall`

```bash
node piploy.cjs wipeall
```

Removes every Piploy-managed container and image, then deletes the configured
`RootDirectory` — repositories, logs, and all. `piploy.json` and the bundle
survive, so the next poll starts over from a clean clone. Stop the service
first; otherwise a poll can recreate state while the wipe runs.

### Logs

Piploy writes to stdout and to a weekly rotating file under the configured root
directory, keeping only the current week's file:

```bash
tail -f root/logs/piploy-log-*.txt
```

Because the daemon runs under systemd, the same lines are also in the journal:

```bash
sudo journalctl -u piploy -f
```

## Deploying a release

Tag and push the release:

```bash
git tag vX.Y.Z
git push --tags
```

The release workflow runs linting, tests, and the build, then attaches
`dist/piploy.cjs` to the GitHub release. The running daemon checks GitHub's
latest release on its poll timer. Within one
`MinutesBetweenBackgroundPolls` interval, it downloads the bundle, swaps it
into place, exits, and systemd starts the new version. No action on the Pi is
needed for routine deploys.

## Rollback

If a release is bad, roll back manually over SSH:

```bash
mv /home/irudd/Piploy/piploy.cjs.prev /home/irudd/Piploy/piploy.cjs && sudo systemctl restart piploy
```

There is no automatic health check or revert; a release that fails at startup
will remain in systemd's restart loop until it is rolled back manually.

## TODO

- Git commit hook + minimal web server on the Pi to receive the hook so Piploy does not have to poll.
