# Migrating a Pi from the .NET Piploy to the TypeScript Piploy

This is a one-time, one-way migration for a Raspberry Pi that is currently
running the .NET build of Piploy as the `piploy` systemd service. It ends with
only the TypeScript build installed, the .NET runtime removed, and the
application containers still serving traffic.

The plan is built around one fact: **the two versions use identical on-disk and
Docker naming**, so the TypeScript daemon adopts what the .NET daemon left
behind rather than rebuilding it. See
[What carries over unchanged](#what-carries-over-unchanged). Because of that,
the cutover is a service swap, not an application redeployment, and every phase
before the swap is reversible.

Throughout, the service user is `irudd` and its files live in
`/home/irudd/Piploy`. Substitute your own if they differ.

---

## Read this first: two blockers before you touch the Pi

Both are in the release/packaging path, not in the daemon. Clear them on your
dev box before starting Phase 1, or the install in Phase 5 will fail.

### 1. There is no published release yet

The repository has no tags, so
`https://github.com/alundgren/Irudd.Piploy/releases/latest/download/piploy.cjs`
— the URL in the README's bootstrap — has nothing behind it. Cut a release
first (`git tag v0.1.0 && git push --tags`); the release workflow lints, tests,
builds, and attaches `dist/piploy.cjs`.

Cutting the tag also matters for self-update: the bundle's baked-in version is
the git tag when built at a tagged commit, and the daemon compares that string
to the release's `tag_name`. A hand-built bundle carries `0.1.0+<shorthash>`
instead, which never matches — so a locally-built bundle scp'd to the Pi will
be **overwritten by the latest release within one poll interval**. Install from
a real release, not from a local build.

### 2. The released bundle is not self-contained

`dist/piploy.cjs` is ~42 KB and still `require`s `commander`, `dockerode`,
`isomorphic-git`, `pino`, and `zod` at runtime — tsup treats `dependencies` as
external by default. Following the README's step 3 alone produces:

```
Error: Cannot find module 'commander'
```

Two ways out. Pick one before Phase 5.

**Option A — make the bundle self-contained (preferred, needs a code change).**
`noExternal: [/.*/]` alone does not work: esbuild fails resolving the optional
native addons behind `dockerode` → `docker-modem` → `ssh2`
(`sshcrypto.node`, `cpufeatures.node`). Marking `ssh2`/`cpu-features` external
does not work either, because `docker-modem` requires `ssh2` eagerly at module
load, so the bundle throws `Cannot find module 'ssh2'` at startup even though
Piploy only ever talks to the Docker Unix socket. It needs an alias/stub for
the SSH transport. This is the shape
[the packaging research](research/arm64-packaging.md) assumed ("one file,
CommonJS"), so it is worth doing properly rather than working around.

**Option B — ship production dependencies alongside the bundle (works today).**
Verified end to end. On the Pi, next to `piploy.cjs`, place `package.json`,
`pnpm-lock.yaml`, and `pnpm-workspace.yaml` from the release's tag, then:

```bash
pnpm install --prod --frozen-lockfile
```

`pnpm-workspace.yaml` is required, not optional: it carries the `overrides` and
supply-chain policy the lockfile was resolved under, and `--frozen-lockfile`
fails without it.

Option B has a sharp edge worth knowing before you rely on it: **self-update
swaps `piploy.cjs` only.** A future release that adds or bumps a runtime
dependency will leave a bundle that requires modules the Pi's `node_modules`
does not have, and the daemon will crash-loop under systemd until you refresh
them by hand. If you go with Option B, re-run the install after any release
that changes `dependencies` in `package.json`.

---

## What carries over unchanged

Verified against the .NET sources removed in `0895c3a`. Nothing in this list
needs migrating — it is why the cutover is cheap.

| | .NET | TypeScript |
|---|---|---|
| Config file | `piploy.json`, `{"Piploy": {…}}` | identical schema and casing |
| Config keys | `RootDirectory`, `MinutesBetweenBackgroundPolls`, `Applications[].{Name,GitRepositoryUrl,DockerfilePath,PortMappings}`, `IsTestRun` | identical |
| Repo layout | `<RootDirectory>/<app>/repo` | identical |
| Log folder | `<RootDirectory>/logs` | identical |
| Image tags | `piploy/<app>:latest`, `:g_<commit>`, `:v_<uuid>`, lowercased | identical |
| Container name | `piploy_<app>` | identical |
| Labels | `piploy_appName`, `piploy_gitTipCommit`, `piploy_buildDate`, `piploy_uniqueId`, `piploy_isCreatedByTest` | identical |
| Container config | `AutoRemove: true`, TCP-only single-port bindings | identical |
| CLI verbs | `status`, `service-start`, `service-stop`, `poll`, `wipeall` | identical (plus `self-update`) |

The consequence to hold on to: on its first poll the TypeScript daemon finds
`piploy_<app>`, reads its `piploy_gitTipCommit` label, and — if that matches the
repository tip — **reuses the running container without stopping it**. If the
label does not match (a commit landed while the service was down), it rebuilds
and restarts that app exactly as the .NET version would have. So the only
downtime risk during cutover is a commit arriving mid-migration.

## What changes

- **Runtime.** dotnet → Node.js 24. `ExecStart` becomes
  `/usr/bin/node /home/irudd/Piploy/piploy.cjs service-start`, and
  `Environment=ASPNETCORE_ENVIRONMENT=Production` is dropped.
- **CLI ↔ daemon IPC.** .NET used a named pipe (`/tmp/CoreFxPipe_piploy_pipe`);
  the TypeScript daemon listens on a Unix socket `piploy.sock` next to
  `piploy.json`, chmod `0600`. The two cannot talk to each other — the old
  `piploy service-stop` will not stop the new daemon, and vice versa. The `0600`
  mode also means CLI commands must run as `irudd` (or root) to reach the daemon.
- **Config resolution.** .NET read `piploy.json` from the process working
  directory; TypeScript resolves it next to the running bundle, with a
  `PIPLOY_CONFIG` environment override. Same file if you keep the standard
  layout, but systemd's `WorkingDirectory` no longer determines it.
- **Git.** LibGit2Sharp → isomorphic-git (pure JS, no native build). Existing
  clones are ordinary git repositories and are reused as-is; the daemon fetches
  `origin` and hard-resets to the remote tip, same as before.
- **Self-update.** New. On each poll-timer tick the daemon checks GitHub's
  latest release, and on a mismatch downloads the bundle, renames the current
  one to `piploy.cjs.prev`, swaps, and calls `process.exit(0)` so systemd
  restarts it. The check runs on the timer, not at startup, so the first one is
  a full poll interval (default 60 minutes) after start.
- **Logs.** Same folder, same `piploy-log-<year>-<week>.txt` name, same weekly
  rotation — and the rotation deletes *every* `piploy-log-*` file that is not
  the current week's. The first TypeScript log write will therefore delete your
  .NET log history in that folder. Copy it out in Phase 1 if you want it.
- **`status` output.** Reformatted; scripts parsing the old block layout break.

`wipeall` is not part of this migration. It deletes `RootDirectory` outright and
removes every Piploy image and container. Use it only if you deliberately want a
from-scratch rebuild — the cost is downtime equal to a full clone plus image
build for every app.

---

## Phase 1 — Record the current state

Do this before stopping anything; it is both the verification baseline and the
rollback reference.

```bash
sudo systemctl status piploy --no-pager
docker ps -a --filter "label=piploy_appName" \
  --format '{{.ID}}\t{{.Names}}\t{{.State}}\t{{.Image}}'
docker images --filter "label=piploy_appName" \
  --format '{{.ID}}\t{{.Repository}}:{{.Tag}}'
cd /home/irudd/Piploy && ./piploy status
```

For each application, record the container ID and its commit label — Phase 7
checks these did not change:

```bash
docker inspect -f '{{.Id}} {{index .Config.Labels "piploy_gitTipCommit"}}' piploy_<app>
```

Back up config, the .NET install, and the logs:

```bash
cp /home/irudd/Piploy/piploy.json /home/irudd/piploy.json.bak
sudo tar czf /home/irudd/piploy-dotnet-backup.tgz \
  -C /home/irudd Piploy --exclude='Piploy/root'
cp -r /home/irudd/Piploy/root/logs /home/irudd/piploy-logs-dotnet
```

The `root/` exclusion keeps the backup small — repos and logs are not being
touched by the migration and are reused in place.

**Freeze deploys.** From here until Phase 7, do not push to any repository
Piploy watches. A commit arriving mid-migration turns a zero-downtime container
adoption into a rebuild-and-restart.

## Phase 2 — Install Node.js 24

```bash
curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
sudo apt install -y nodejs
node --version   # expect v24.x
```

Nothing is disturbed yet; the .NET service is still running and serving.

## Phase 3 — Stage and dry-run the new build beside the old one

Do not overwrite `/home/irudd/Piploy` yet. Stage in a scratch directory:

```bash
sudo -u irudd mkdir -p /home/irudd/piploy-next
cd /home/irudd/piploy-next
curl -fL https://github.com/alundgren/Irudd.Piploy/releases/latest/download/piploy.cjs -o piploy.cjs
```

If you took **Option B**, also fetch `package.json`, `pnpm-lock.yaml`, and
`pnpm-workspace.yaml` at the release tag and run
`pnpm install --prod --frozen-lockfile` here.

Smoke-test the binary itself:

```bash
node piploy.cjs --version
```

Then a read-only dry run against the real configuration. `status` only reads
git and Docker state, and with the .NET daemon holding a named pipe rather than
this build's socket, it reports "Background service: not running" and falls back
to computing status inline — which is exactly what you want to see:

```bash
PIPLOY_CONFIG=/home/irudd/Piploy/piploy.json node piploy.cjs status
```

Confirm every application is listed and its `Latest image hash` /
`Running container hash` match Phase 1. **Do not run `poll` here** — it would
reconcile Docker while the .NET daemon is still running and the two could fight.

If this phase fails, stop. Nothing has changed on the Pi and there is nothing to
roll back.

## Phase 4 — Stop and disable the .NET service

```bash
sudo systemctl stop piploy
sudo systemctl disable piploy
sudo systemctl status piploy --no-pager
docker ps --filter "label=piploy_appName"
```

The application containers keep running: the .NET daemon never stopped
containers on shutdown, it only stopped polling. Your services stay up for the
whole cutover.

**Rollback from here:** `sudo systemctl enable --now piploy`.

## Phase 5 — Replace the install directory contents

Keep exactly two things: `piploy.json` and `root/`. Everything else in that
directory is .NET publish output.

Look before you delete:

```bash
ls -la /home/irudd/Piploy
```

Then, with the Phase 1 backup confirmed present:

```bash
sudo find /home/irudd/Piploy -maxdepth 1 -mindepth 1 \
  ! -name piploy.json ! -name root -exec rm -rf {} +
sudo -u irudd cp -r /home/irudd/piploy-next/. /home/irudd/Piploy/
ls -la /home/irudd/Piploy
```

Target layout:

```text
/home/irudd/Piploy/
├── piploy.cjs        # deployed bundle
├── piploy.json       # unchanged from the .NET install
├── node_modules/     # Option B only
├── package.json      # Option B only
├── pnpm-lock.yaml    # Option B only
├── pnpm-workspace.yaml  # Option B only
└── root/             # untouched repos and logs
```

Ownership matters — the daemon writes `piploy.sock`, logs, and (on self-update)
`piploy.cjs` itself:

```bash
sudo chown -R irudd:irudd /home/irudd/Piploy
```

`piploy.json` needs no edits. If you want to shorten the first-poll wait, this
is the moment to lower `MinutesBetweenBackgroundPolls`; remember it also sets
the self-update check interval.

## Phase 6 — Swap the systemd unit and start

```bash
sudo tee /etc/systemd/system/piploy.service >/dev/null <<'EOF'
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
EOF

sudo systemctl daemon-reload
sudo systemctl enable --now piploy
```

Note there is no `ASPNETCORE_ENVIRONMENT` line, and `ExecStart` invokes `node`
rather than the executable directly — the bundle is not `chmod +x`-able on its
own.

## Phase 7 — Verify

```bash
sudo systemctl status piploy --no-pager
sudo journalctl -u piploy -n 50 --no-pager
sudo -u irudd /usr/bin/node /home/irudd/Piploy/piploy.cjs status
```

Expect `Background service: running` — that line proves the CLI reached the
daemon over `piploy.sock`, which is the real "the new daemon is alive" signal.

Force one reconciliation instead of waiting out the poll interval:

```bash
sudo -u irudd /usr/bin/node /home/irudd/Piploy/piploy.cjs poll
```

Then confirm adoption — the container IDs must equal the ones from Phase 1:

```bash
docker inspect -f '{{.Id}} {{index .Config.Labels "piploy_gitTipCommit"}}' piploy_<app>
```

Same ID means the daemon reused the running container and there was no
downtime at all. A different ID means it rebuilt — check whether a commit landed
during the migration, and confirm the app is healthy on its mapped port.

Finally, check the app itself over its published port, and unfreeze deploys:
push a trivial commit to one watched repository, run `poll`, and confirm the new
commit is picked up, built, and running.

**Rollback from here:**

```bash
sudo systemctl stop piploy && sudo systemctl disable piploy
sudo rm -rf /home/irudd/Piploy
sudo tar xzf /home/irudd/piploy-dotnet-backup.tgz -C /home/irudd
# restore the .NET unit file (ExecStart=/home/irudd/Piploy/piploy service-start,
# Environment=ASPNETCORE_ENVIRONMENT=Production), then:
sudo systemctl daemon-reload && sudo systemctl enable --now piploy
```

`root/` was never moved, so a rollback also reuses the existing repos and
containers. Do not delete the backup until you have watched at least one
successful self-update.

## Phase 8 — Clean up to a .NET-free state

Only after Phase 7 passes.

```bash
rm -rf /home/irudd/piploy-next
sudo rm -f /tmp/CoreFxPipe_piploy_pipe      # dead .NET named pipe
```

Remove the .NET runtime. Which command applies depends on how it was installed:

```bash
dotnet --info                                # nothing installed? skip this step
sudo apt purge -y 'dotnet*' 'aspnetcore*' 'netstandard*' && sudo apt autoremove -y
rm -rf /home/irudd/.dotnet /home/irudd/.nuget      # dotnet-install.sh layout
```

The .NET version was published self-contained in some setups, in which case
there is no runtime package to purge and deleting `/home/irudd/Piploy`'s old
contents in Phase 5 already removed it. Check before purging: `apt list
--installed | grep -i dotnet`.

Verify the end state:

```bash
which dotnet || echo "dotnet removed"
systemctl cat piploy | grep ExecStart
ls /home/irudd/Piploy
sudo -u irudd /usr/bin/node /home/irudd/Piploy/piploy.cjs status
```

Keep `/home/irudd/piploy-dotnet-backup.tgz` and `piploy.json.bak` for a while;
they cost nothing and are the only copies of the old install.

---

## After the migration

- **First self-update.** Within one poll interval of the next release, the
  daemon downloads the bundle, writes `piploy.cjs.prev`, exits, and systemd
  restarts it. Watch `journalctl -u piploy` across that first one so you know
  the loop works before you rely on it.
- **Rollback of a bad release** is manual and unchanged from the README:
  `mv /home/irudd/Piploy/piploy.cjs.prev /home/irudd/Piploy/piploy.cjs && sudo systemctl restart piploy`.
  There is no health check or automatic revert; a release that fails at startup
  sits in systemd's restart loop until someone intervenes.
- **Under Option B**, re-run `pnpm install --prod --frozen-lockfile` after any
  release that changed `dependencies`, or the self-updated bundle will crash-loop.
