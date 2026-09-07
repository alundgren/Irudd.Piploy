# Buildx rollout and recovery

This runbook supports the human-owned rollout in issue #140. Merging the code
does not activate Buildx. Automatic bundle updates leave it disabled unless
`Piploy.Buildx.Enabled` is explicitly true.

Before production access, an assisting agent must read the environment's
private production instructions. Keep service identities, paths, endpoints,
configuration contents, and credentials in a private working record. For each
production mutation, show the exact resolved command, its effect, failure
risk, and rollback, then obtain approval for that one action. Machine-level
package installation always requires approval. Do not run this document as a
single script.

## Supported components

Use Linux Docker Engine and CLI 29 or newer, Buildx 0.36 or newer, and the
pinned BuildKit 0.32.0 multi-platform image below. Its index includes native
`linux/arm64` and `linux/amd64` images. Piploy checks the Engine identity,
versions, owned builder metadata/container, and effective GC policy before
using the builder. The CLI uses Dockerode's Engine endpoint explicitly;
it never selects a different Docker context or changes the default builder.

```text
docker.io/moby/buildkit:v0.32.0@sha256:1f8167fcb0eca5b7126353d35299386945cbb8949cc516c592a49f80cfce4fa2
```

ARM64 manifest:
`sha256:518fe61c1c400205c50541fd57bbb6eb11549027737fb8c76ac56af48e42c181`.
This infrastructure image has the narrow exception recorded in ADR-0004.
Application Dockerfile image rules remain unchanged.

## Read-only checks

Run as the daemon's service account, with its Docker environment. First
resolve the installed bundle, configuration, systemd unit, and Engine endpoint
from private instructions. In the command examples, set `piploy_bundle`,
`piploy_config`, `piploy_unit`, and `piploy_engine` to those verified values.
Do not assume that an operator's interactive Docker context matches them.
Set `export PIPLOY_CONFIG="$piploy_config"` in this operator shell so every
bundle command reads the same configuration as the daemon.

```bash
uname -m
node "$piploy_bundle" --version
docker --host "$piploy_engine" version
docker --host "$piploy_engine" buildx version
docker --host "$piploy_engine" info --format '{{.ID}} {{.Driver}} {{json .DriverStatus}} {{.DockerRootDir}}'
docker --host "$piploy_engine" buildx ls
node "$piploy_bundle" status
systemctl status "$piploy_unit"
```

Confirm there is no in-flight Poll or self-update. Record health and current
image/container identities for every Application. Inventory legacy cache with
`docker --host "$piploy_engine" system df -v` and read-only image listings.
Piploy will not import or prune unidentified legacy cache. If manual maintenance
is needed, prepare exact resource targets and obtain separate approval.

Measure the filesystem containing the Engine's `DockerRootDir` on the Engine
host, not the CLI host. On a Pi using `overlay2`, run `df -h` against that
reported directory. For containerd image storage, also find the actual
containerd data directory from its service arguments/configuration and measure
that filesystem. Docker's `data-root` does not relocate containerd data.
With Docker Desktop, these paths belong to the VM.

Piploy measures via a short-lived, network-disabled, read-only container using
the pinned image and a read-only bind of the Engine storage directory. This
infrastructure operation does not alter Application Volume configuration.
The measured minimum covers Docker's data directory and the helper's root
filesystem, which resides on the Engine's image snapshot storage. This also
covers the usual containerd image store when it uses a different filesystem
from Docker's data directory. Builder bootstrap/image download also needs space; budget
for it before activation. A 5 GiB preflight threshold cannot guarantee that an
arbitrary build fits. Build/export failures leave the current Application in
place and never trigger deletion to recover disk space.

## Installation if required

The Pi evidence collected for this change showed Engine/CLI 29.7.0, Buildx
0.36.0, ARM64, `overlay2`, and 34 GiB available. Recheck at rollout time.
These versions do not require an upgrade for this feature.

If prerequisites are missing, follow Docker's official
[Raspberry Pi OS/Debian installation instructions](https://docs.docker.com/engine/install/debian/).
First inspect the configured package sources and available versions:

```bash
apt-cache policy docker-ce docker-ce-cli docker-buildx-plugin
apt-cache madison docker-ce docker-ce-cli docker-buildx-plugin
```

Prepare a version-pinned install command using the actual package versions
from that output, for example `sudo apt-get install docker-ce-cli=VERSION
 docker-buildx-plugin=VERSION`. Show the fully resolved command before approval.
An Engine upgrade may restart Docker and affect running Applications; plan it
separately with a health baseline and package downgrade/recovery procedure.
If Docker's repository is absent, prepare each repository/key setup command
from the official instructions for the detected OS, and approve each write
separately. Piploy never installs packages itself.

## Preserve recovery before activation

Choose a recovery directory outside Piploy's root directory, Docker cleanup,
and normal release backup names. Resolve it as `piploy_recovery`. Preserve a
separately named known-good bundle and configuration there; `.prev` alone is
insufficient because another self-update can replace it. Approve each copy.
Record checksums and verify the copied bundle's version.

Expand each copy command and approve it separately:

```bash
cp --preserve=mode "$piploy_bundle" "$piploy_recovery/known-good-piploy.cjs"
cp --preserve=mode "$piploy_config" "$piploy_recovery/known-good-piploy.json"
```

Then record `sha256sum` of both copies and compare with the originals. Check
`PIPLOY_CONFIG="$piploy_recovery/known-good-piploy.json" node
"$piploy_recovery/known-good-piploy.cjs" --version`.

Before updating a representative Application, resolve `previous_image` from
the running container's inspected `.Image` value, and preserve its container
configuration privately. Prepare an exact `docker create` command from the
current container's ports, bind mounts, environment references, restart policy,
name, and image. Do not publish environment values. Check the Application's
health endpoint and record its expected response.

Account for the uncompressed image size, archive space, builder download,
new image, and cache growth. The archive must leave the configured minimum
free space plus room for the planned build. Prefer a separate recovery disk.
An image ID or extra tag is not a recovery archive.

The following are separately approved writes:

```bash
docker --host "$piploy_engine" image save --output "$piploy_recovery/application-image.tar" "$previous_image"
sha256sum "$piploy_recovery/application-image.tar" > "$piploy_recovery/application-image.tar.sha256"
```

Read-only verification:

```bash
sha256sum --check "$piploy_recovery/application-image.tar.sha256"
tar -tf "$piploy_recovery/application-image.tar"
```

Confirm the archive contains a manifest/index and the image configuration and
layers. On an isolated recovery Engine, approve an `image load --input` of the
archive and verify that `image inspect "$previous_image"` succeeds. Prepare
that same load command for production recovery before the representative
update. Keep the archive through the full observation period. Deleting it
requires separate approval.

## Activate

Stop the daemon with a separately approved `systemctl stop "$piploy_unit"`.
Existing Application containers keep running under Docker. This pauses Polls
and automatic self-update while configuration and builder setup are reviewed.
Back up the private `.piploy-buildx` directory next to the configuration if it
already exists. It contains builder ownership and configuration metadata.

Prepare this addition inside the existing `Piploy` object, preserving all
other settings. Approve the exact configuration edit before writing it:

```json
"Buildx": {
  "Enabled": true,
  "CacheRetentionHours": 720,
  "CacheTargetBytes": 8589934592,
  "MinimumFreeBytes": 5368709120
}
```

These settings require a restart. The cache target is a soft target, not a
quota. Running an Application does not refresh its intermediate cache's last
use; only builds using those records do. Both automatic GC and explicit prune
have the same last-use protection, with one GC policy and no broader fallback.
Eligible old cache is reclaimed least recently used first. Recent cache may
therefore exceed the target, and new builds may be postponed until capacity is
available. Existing-image reuse and running Applications continue.

Before the first Poll, prepare and approve the exact builder setup operations
using the values generated by `src/buildx.ts` in the reviewed release. The
normal builder name is `piploy-` plus the first 24 hex characters of SHA-256 of
`absolute configuration path + :normal`. Its Buildx metadata directory is
`.piploy-buildx/normal` next to that configuration. Test builders use `:test`,
`piploy-test-`, and `.piploy-buildx/test` instead. Set `BUILDX_CONFIG` to the
normal metadata directory for every inspection or maintenance command.

Creation uses `buildx create --name NAME --driver docker-container`, the pinned
image, `env.PIPLOY_BUILDER_OWNER=OWNER`, `env.PIPLOY_BUILDER_POLICY=HASH`, and
`--buildkitd-config FILE`, followed by the explicit Engine endpoint. OWNER is
the same 24-character hash used in the name; HASH is SHA-256 of the exact TOML
below, including final newline and indentation. Generate that file with the
reviewed `buildkitConfiguration` function, not a hand-reformatted copy.
Approve the config-file write, builder creation, and `buildx inspect NAME
--bootstrap` separately. Bootstrap pulls the pinned image and creates a
privileged BuildKit container with a persistent Docker volume. Review disk
cost and privilege implications before approval.

```toml
[worker.oci]
  gc = true
[[worker.oci.gcpolicy]]
  all = true
  keepDuration = "2592000s"
  reservedSpace = 0
  maxUsedSpace = 8589934592
  minFreeSpace = 5368709120
[worker.containerd]
  enabled = false
```

Resolve these local variables read-only before proposing setup commands:

```bash
piploy_config="$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$piploy_config")"
piploy_owner="$(node -e 'const c=require("node:crypto");process.stdout.write(c.createHash("sha256").update(process.argv[1]).update(":normal").digest("hex").slice(0,24))' "$piploy_config")"
piploy_builder="piploy-$piploy_owner"
export BUILDX_CONFIG="$(dirname "$piploy_config")/.piploy-buildx/normal"
piploy_builder_config="$BUILDX_CONFIG/buildkitd.toml"
piploy_buildkit_image='docker.io/moby/buildkit:v0.32.0@sha256:1f8167fcb0eca5b7126353d35299386945cbb8949cc516c592a49f80cfce4fa2'
```

Approve `mkdir -p -m 700 "$BUILDX_CONFIG"` separately. Then approve writing the
exact TOML above to `"$piploy_builder_config"` with mode 600, using a here-document
that retains its two-space indentation and final newline. Compute its hash:

```bash
piploy_policy="$(sha256sum "$piploy_builder_config" | cut -d ' ' -f 1)"
```

Before builder creation, inspect `buildx_buildkit_${piploy_builder}0_state` if
it exists. Its `piploy_builderOwner` label must equal `$piploy_owner`, its driver
must be `local`, and its options must be empty. Never add an ownership label
to an unidentified existing volume. If absent, expand and separately approve:

```bash
docker --host "$piploy_engine" volume create --driver local --label "piploy_builderOwner=$piploy_owner" "buildx_buildkit_${piploy_builder}0_state"
```

Expand and show each of these commands for separate approval:

```bash
docker --host "$piploy_engine" buildx create --name "$piploy_builder" --driver docker-container --driver-opt "image=$piploy_buildkit_image" --driver-opt "env.PIPLOY_BUILDER_OWNER=$piploy_owner" --driver-opt "env.PIPLOY_BUILDER_POLICY=$piploy_policy" --buildkitd-config "$piploy_builder_config" "$piploy_engine"
docker --host "$piploy_engine" buildx inspect "$piploy_builder" --bootstrap
```

Verify metadata, container image and ownership markers, Engine endpoint, and
`GCPolicy` through `buildx ls --format '{{json .}}'`. It must show exactly one
policy, `all=true`, 30-day `keepDuration`, 8 GiB `maxUsedSpace`, 5 GiB
`minFreeSpace`, and zero reserved space. Inspect the generated container and
its persistent state volume. Never adopt or remove a matching name whose
ownership is unverified. A settings change recreates a verified owned builder
with `buildx rm --keep-state` before applying the new policy. Approve those
exact operations as part of any production retention change.

With recovery ready and builder verified, approve restarting the daemon.
Startup queues a Poll, so this action also authorizes its identified Application
updates. If a representative update needs a manual Poll, approve that exact
command and expected commit separately. Buildx progress is timestamped at info level.

## Verify and observe

Check Application health, status, the loaded commit image in the same Engine,
Buildx progress, total build duration, and container replacement separately.
Record elapsed times without claiming a speedup from incomparable builds.
Repeat normal status/cache/free-space checks after at least one later normal
Poll. Restart the daemon only with approval and verify that the owned builder
and cache persist. Verify the operator's default builder/context is unchanged.
Use the local integration evidence for low-space and destructive cache tests;
do not force disk exhaustion or cache deletion on production.

## Interrupted builder recreation

The cache volume carries ownership independently of the Buildx metadata. If
creation or a retention change is interrupted after `buildx rm --keep-state`,
Piploy verifies that label, the local driver, and empty volume options on the
next Poll, then recreates the builder using the retained cache. No cache
migration or deletion is needed. A missing CLI must be repaired before retry.

For production recovery, keep the daemon stopped while inspecting:

```bash
docker --host "$piploy_engine" volume inspect "buildx_buildkit_${piploy_builder}0_state"
docker --host "$piploy_engine" buildx ls --format '{{json .}}'
```

If metadata and container are absent but the volume ownership checks match,
prepare the exact create and bootstrap commands from Activate, using the
approved configuration. Approve each separately, verify the effective policy,
and only then approve the next Poll. If the label does not match, or a container
exists without metadata, stop and restore the saved metadata after checking
its Engine, image, owner, and configuration. Do not adopt the volume by name,
relabel it, or delete it to make the error disappear.

## Disable or recover

If prerequisites, retention, storage, or Application health are wrong, pause
Piploy with an approved service stop. Preserve diagnostics before changing
anything else. Disabling Buildx means an approved edit setting `Enabled` to
false, then an approved restart. The bundle continues using Dockerode's legacy
build path. Disabling does not remove cache or roll back Application commits.
The dedicated builder's already-configured automatic GC continues while its
container runs; optionally stop the verified builder container with separate
approval to pause it. Builder deletion is never necessary for recovery.

For bundle recovery, keep the service stopped, approve restoration of the
separately saved bundle and configuration, and verify their checksums/version.
Keep the service stopped to prevent automatic self-update from undoing rollback.
For temporary Application checks use a separately approved manual CLI Poll
only after correcting the failed commit; manual Poll does not self-update.
Do not restart the automatic daemon until the release/commit problem is fixed
or the owner approves another plan. Restoring ordinary service operation also
restores timer-driven automatic self-update; verify that this is intentional.

If an Application needs recovery, keep Polls paused throughout:

1. Verify the archive checksum again.
2. Approve loading the archive into the correct Engine.
3. Inspect the recovered image by the recorded image ID.
4. Approve removal of only the failed replacement container, if present.
5. Approve the prepared container-create command using the recovered image,
   preserved Application data mounts and original runtime settings.
6. Approve starting that container, then check its health.

A restored bundle/configuration does not itself restore an Application. Keep
Piploy paused until the failed source commit is corrected or the owner approves
another recovery plan, otherwise the next Poll will immediately reapply it.
Never use `wipeall`, global image/system/volume pruning, or Application-data
deletion as a recovery step.

`wipeall` retains its existing meaning: remove Piploy Application containers,
images, and root-directory contents while preserving Application data. It does
not delete the dedicated BuildKit builder, its metadata, or cache volume.
Removed Applications still receive explicit container/image cleanup during
Poll. Obsolete unreferenced Application images are removed separately from
cache. Unrelated containers and their referenced images are protected.

Record sanitized rollout evidence in #140. A rollback leaves that issue open.
Retain recovery copies and archives through observation; approve any later
archive or verified-builder deletion separately.

## Upstream references

- [Dedicated builder and persistence](https://docs.docker.com/build/builders/drivers/docker-container/)
- [BuildKit configuration](https://docs.docker.com/build/buildkit/toml-configuration/)
- [Prune age filters and storage targets](https://docs.docker.com/reference/cli/docker/buildx/prune/)
- [Docker and containerd data directories](https://docs.docker.com/engine/daemon/)
