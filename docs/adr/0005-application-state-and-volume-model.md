# Application state and the volume model

Piploy needed persistent storage so an Application like `life` — a SQLite-backed
planner — can survive having its container replaced by a Poll. An
Application declares Volumes as bare names (`"sqlite:/app/data"`), never host
paths, and Piploy resolves each to a directory it creates itself under a data
directory derived next to `piploy.json` — the same rule that already locates
`piploy.sock`. Application data therefore lives outside `RootDirectory`, so
`wipeall` never deletes it and instead reports the paths it preserved.

## Considered options

- **Docker named volumes**, which is what `life`'s Compose file uses. Rejected:
  portability and volume drivers are worth nothing on one Pi that never moves,
  and they make the single irreplaceable thing in the system impossible to
  `rsync` or open with `sqlite3` without digging through `/var/lib/docker`.
- **Bind mounts under `RootDirectory`**, as a sibling of each Application's
  `repo/`. Rejected: that is exactly the tree `wipeall` hands to a recursive
  forced delete.
- **Absolute host paths in configuration**, e.g. `"/mnt/photos:/app/photos"`.
  Rejected: configuration that can name any path can hand a container `/etc`,
  Piploy's own bundle and configuration, or `/var/run/docker.sock` — which is
  root on the host. An external disk is served by symlinking the data directory
  instead. This is addable later without invalidating existing configuration.
- **An explicit `DataDirectory` setting.** Rejected: the location is derivable
  from a rule the codebase already has, and `RootDirectory` is free-form enough
  that deriving from *it* would place data somewhere surprising.

## Consequences

- Piploy only ever mounts directories it created. It cannot be configured into
  mounting anything else.
- All Application data sits under one directory, so backup is a single `rsync`.
- "Piploy never deletes Application data" holds without an asterisk. A `wipeall`
  followed by a poll therefore yields a fresh container attached to the
  *existing* database — wipe-and-retry is no longer a way to exercise an
  Application's first-run path.
- `PIPLOY_CONFIG` relocates Application data as well as the socket, which gives
  integration runs their own data root for free.
- Files in a Volume are owned by whatever user the container runs as. An
  Application whose Dockerfile sets no `USER` writes root-owned files that the
  service user cannot read without `sudo`.
