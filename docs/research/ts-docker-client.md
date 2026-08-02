# Which Docker client should the TypeScript port use?

Research for [issue #5](https://github.com/alundgren/Irudd.Piploy/issues/5). Target: linux-arm64 Raspberry Pi, daemon over the
local unix socket. Docker Compose is out of scope, so a daemon-API client is viable.

All version-specific claims are as of 2026-08-02, against dockerode 5.0.1, docker-modem 5.0.7 and `@types/dockerode` 4.0.1.

Claims marked **(verified)** were run end to end against a real daemon — Docker Engine **29.2.1, API 1.53 (minimum 1.44),
`linux/arm64`** (colima on an M-series Mac). That daemon is the same OS/arch as the Pi, so the build, run and error-string
behaviour below is observed on the target architecture, not inferred. It is *not* the Pi's actual daemon version — see
"Open items".

## Recommendation

**Use `dockerode`.** It covers every operation `PiployDockerService` and `PiployDockerCleanupService` perform, I verified
all of them end to end on linux/arm64, and it is the only maintained option in this space.

**dockerode is pure JavaScript** — no `gypfile`, no build step of its own — **but its dependency tree pulls one native,
optional addon.** `dockerode` → `docker-modem` → `ssh2` → optional `cpu-features` (+ `nan`), which has a `binding.gyp` and
compiles at install time. It is declared in `ssh2`'s `optionalDependencies` and `ssh2` requires it inside a bare
`try {} catch {}`, so a failed build is not an install failure and the library works without it — I confirmed this by
deleting `node_modules/cpu-features` and successfully calling the daemon **(verified)**. So for the packaging decision:
**treat dockerode as pure JS, with the caveat that a compile will be attempted on the Pi unless you suppress it.**
This corrects `arm64-packaging.md`, which recorded dockerode as having no native dependency — true of the package itself,
not of its transitive tree.

The tradeoff, stated plainly: **dockerode's runtime is excellent and its types are third-party and wrong in three places
that this port hits directly.** `@types/dockerode` is DefinitelyTyped, not shipped by the project (dockerode's own
`package.json` has no `types` field). It rejects a multi-tag build, rejects a `Buffer` build context, and does not know
about `docker.followProgress` at all — the exact method you need to read BuildKit output. All three work at runtime. You
will be writing a small typed façade with a couple of `as any` escapes behind it. That is the whole cost, and it is
cheap relative to hand-rolling the HTTP layer.

The sharpest single finding: **`modem.followProgress` silently returns undecodable base64 protobuf when the build uses
BuildKit.** Port `ProgressTracer` onto `docker.followProgress` instead. Details below — this is the one that would
otherwise be discovered at 11pm on the Pi.

## The operations that must be covered

From `Irudd.Piploy.App/PiployDockerService.cs` and `PiployDockerCleanupService.cs`:

| Docker.DotNet today | dockerode equivalent | Status |
| --- | --- | --- |
| `Images.BuildImageFromDockerfileAsync(params, tarStream, ...)` | `docker.buildImage(tarStreamOrBuffer, opts)` | Direct **(verified)** |
| `ImageBuildParameters.Tags` (3 tags) | `opts.t = ['a:latest','a:g_…','a:v_…']` | Works at runtime; **types reject it** |
| `ImageBuildParameters.Labels` | `opts.labels = { … }` | Direct **(verified)** |
| `ImageBuildParameters.Dockerfile = "<bare name>"` | `opts.dockerfile = '<bare name>'` | Direct **(verified)** |
| `ProgressTracer : IProgress<JSONMessage>` | `docker.followProgress(stream, onDone, onEvent)` | Direct, **not** `modem.followProgress` |
| `Images.ListImagesAsync(Filters { reference })` | `docker.listImages({ filters: { reference: ['…'] } })` | Direct **(verified)** |
| `Containers.ListContainersAsync(Filters { name })` | `docker.listContainers({ filters: { name: ['…'] } })` | Direct **(verified)** |
| label filters for cleanup | `{ filters: { label: ['piploy_isCreatedByTest=true'] } }` | Direct **(verified)** |
| `CreateContainerParameters` + `HostConfig.PortBindings`/`AutoRemove`, `ExposedPorts`, `Name` | `docker.createContainer({ Image, name, ExposedPorts, HostConfig: { PortBindings, AutoRemove } })` | Direct **(verified)** |
| `Containers.StartContainerAsync` | `container.start()` | Direct **(verified)** |
| `Containers.RemoveContainerAsync(Force = true)` | `container.remove({ force: true })` | Direct **(verified)** |
| `Containers.StopContainerAsync` | `container.stop()` | Direct |
| `Images.DeleteImageAsync(Force = true)` | `docker.getImage(idOrTag).remove({ force: true })` | Direct **(verified)** |
| `Images.PruneImagesAsync(Filters { dangling })` | `docker.pruneImages({ filters: { dangling: ['true'] } })` | Direct **(verified)** |
| `DockerApiException` → "port is already allocated" | thrown `Error` with `.statusCode` / `.json` / `.message` | Direct **(verified)** — see below |

### Verified end-to-end

One script built a real image from an in-memory tar with three tags and five labels, filtered it back out of the daemon,
created and started a named container with a port binding and `AutoRemove`, provoked the port clash, force-removed, and
pruned:

```
== tar built, bytes = 3072
== build progress events = 47
{"stream":"Step 1/9 : FROM alpine:3.20"}
  ...
{"stream":"Successfully tagged piploy/probeapp:latest\n"}
{"stream":"Successfully tagged piploy/probeapp:g_abc123def456\n"}
{"stream":"Successfully tagged piploy/probeapp:v_aaaa-bbbb-cccc\n"}
== listImages reference filter => 1 sha256:6f701be03cb2
   RepoTags: ["piploy/probeapp:g_abc123def456"]
   Labels  : {"piploy_appName":"probeapp","piploy_buildDate":"…","piploy_gitTipCommit":"abc123def456",
              "piploy_isCreatedByTest":"true","piploy_uniqueId":"aaaa-bbbb-cccc"}
== listImages label filter => 2
== container created+started f1b9b19a8837c16a8c4
== listContainers name filter => 1 running ["/piploy_probeapp"]
== force removed
== prune dangling => {"ImagesDeleted":null,"SpaceReclaimed":0}
```

So the whole `PiployDockerService` shape maps over without contortion.

## Building from a tar'd context — what replaces `TarFile.CreateFromDirectoryAsync`

There are two routes, and **you probably do not need a tar library at all.**

**Route A — let dockerode pack the directory.** `buildImage` accepts `{ context, src }` instead of a stream;
`util.prepareBuildContext` then packs with the bundled `tar-fs`, applies `.dockerignore` via `@balena/dockerignore`, and
gzips the result before sending. Verified with a nested context and a non-default Dockerfile name **(verified)**:

```
build ok, events 36 | COPY worked: true
tags ["piploy/ctxsrc:1"]
labels {"piploy_appName":"ctxsrc","piploy_isCreatedByTest":"true"}
```

This is strictly *more* than the C# does today — the dotnet version does not honour `.dockerignore` at all, since
`TarFile.CreateFromDirectoryAsync` tars everything. **Sharp edge:** `src` is not optional despite reading like it should
be. `lib/util.js` does `const entries = file.src.slice() || []` inside an `fs.readFile` callback, so omitting `src`
throws a `TypeError` that is *not* routed into the returned promise — it crashes the process **(verified)**. Always pass
`src: fs.readdirSync(context)`.

**Route B — hand-build the tar.** If you want byte-level control (or to keep parity with today's "tar everything"
behaviour), `tar-stream` is already in the tree as a transitive dependency of `tar-fs`, and `buildImage` accepts a raw
`Buffer` or `Readable`: `docker-modem` passes `options.file` straight through and sets `Content-Type: application/tar`.
Verified with a hand-rolled `tar.pack()` walk of the context directory **(verified)** — that is the direct equivalent of
the C# `MemoryStream` + `TarFile` pair.

Either way the `Dockerfile` handling is identical to C#: the tar's root is the build context, and `dockerfile` is the
bare filename. The Engine API says the `Dockerfile` "is typically in the archive's root, but can be at a different path
or have a different name by specifying the `dockerfile` parameter"
([Engine API `/build`](https://docs.docker.com/reference/api/engine/version/v1.51/#tag/Image/operation/ImageBuild)).
Verified with `dockerfile: 'Dockerfile.custom'` and a `COPY sub/x.txt` from a nested directory **(verified)**.

**Recommendation: Route A.** No extra dependency, and you get `.dockerignore` for free.

## Multiple tags on one build

The API supports it — `t` is "A name and optional tag to apply to the image in the `name:tag` format. … You can provide
several `t` parameters" (swagger `/build`). `docker-modem`'s `buildQuerystring` passes arrays through to
`querystring.stringify`, which emits the repeated form; only non-array objects get `JSON.stringify`'d. Observed directly:

```
t=piploy%2Fa%3Alatest&t=piploy%2Fa%3Ag_abc&t=piploy%2Fa%3Av_guid&dockerfile=Dockerfile
  &labels=%7B%22piploy_appName%22%3A%22a%22%2C%22piploy_gitTipCommit%22%3A%22abc%22%7D
```

All three tags landed on one image **(verified)** — the build log ends with three `Successfully tagged` lines.

**But `@types/dockerode` declares `t?: string | undefined`.** `tsc --strict` on the exact call the port needs:

```
tcheck2.ts(6,27): error TS2769: No overload matches this call.
    Type 'string[]' is not assignable to type 'string'.
```

This is the first of the three typing gaps. Runtime is fine; the type is wrong.

## Streaming build progress — the BuildKit trap

`ProgressTracer` today just serialises each `JSONMessage` into the logger. The naive TS port is
`docker.modem.followProgress(stream, done, ev => logger.info(JSON.stringify(ev)))`, and against the **classic** builder
that works exactly like the C# — `{"stream":"Step 1/9 : FROM alpine:3.20"}` and friends **(verified)**.

Against **BuildKit** (`version: '2'`) it produces garbage. Same build, both callbacks, side by side **(verified)**:

```
== modem.followProgress -> 27 events
[{"id":"moby.buildkit.trace","aux":"Cm8KR3NoYTI1NjoxMTk2OTZlNWQxMzk2MTM0MzBmYTEyNTM2ZmMyZDM3ZjllMmI5MmI2…"}, …]
   contains BUILD-STEP-MARKER: false

== docker.followProgress -> 11 events
[{"stream":"[sha256:27a1f] [internal] load remote build context\n"},
 {"stream":"CACHED: copy /context /\n"},
 {"stream":"[sha256:60f80] [1/2] FROM docker.io/library/alpine:3.20@sha256:d9e853e8…\n"}, …]
   contains BUILD-STEP-MARKER: true
```

`RUN echo BUILD-STEP-MARKER` is visible through one and invisible through the other. dockerode 5 added
`lib/buildkit.js`, which decodes the `moby.buildkit.trace` `aux` field as a `moby.buildkit.v1.StatusResponse` protobuf
and reformats it into `{ stream: … }` events — that is what `protobufjs` and `@grpc/proto-loader` are in the dependency
list for. `Docker.prototype.followProgress` delegates to it; `Modem.prototype.followProgress` does not.

**`@types/dockerode` 4.0.1 does not declare `Dockerode.followProgress`** — typing gap two:

```
tcheck.ts(18,5): error TS2339: Property 'followProgress' does not exist on type 'Dockerode'.
```

So the typed path leads you straight into the broken one. Worth an explicit comment in the port.

**Why this matters even though the API still defaults to the classic builder.** `/build`'s `version` parameter defaults
to `"1"`, described in the spec itself as "the first generation classic (deprecated) builder". Docker's deprecation page
is blunter: "This release marks the beginning of the deprecation cycle of the classic ('legacy') builder for Linux
images. No active development will happen on the classic builder (except for bugfixes)", and the CLI's warning reads
"DEPRECATED: The legacy builder is deprecated and will be removed in a future release."
([Deprecated Engine features](https://docs.docker.com/engine/deprecated/)). Piploy can stay on the default for now, but
the removal is announced, so wire the progress path onto `docker.followProgress` from day one and the eventual flip to
`version: '2'` is a one-line change. I verified BuildKit builds work through dockerode today, tags and labels included
**(verified)**.

## Server-side filters

The API takes filters "encoded as JSON (a `map[string][]string`)" — array-of-strings, unlike Docker.DotNet's
`map[string]map[string]bool`. `docker-modem` JSON-stringifies any non-array object in the query, so the plain object form
is correct:

```
filters=%7B%22reference%22%3A%5B%22piploy%2Fa%3Ag_abc%22%5D%7D
filters=%7B%22name%22%3A%5B%22piploy_a%22%5D%2C%22label%22%3A%5B%22piploy_isCreatedByTest%3Dtrue%22%5D%7D
```

`reference`, `name` and `label` are all in the documented filter lists for `/images/json` and `/containers/json`, and all
three returned correctly **(verified)**. `@types/dockerode` gets this one right: `filters?: string | { [key: string]: string[] }`.

Note for the cleanup port: `PiployDockerCleanupService.GetAllPiployImages` fetches *all* images and filters
`piploy_appName` in memory. dockerode can push that to the daemon as `{ label: ['piploy_appName'] }` (key-only label
filter is documented). Not required for parity, but it is free.

## Recognising "port is already allocated"

The string is stable and comes from the daemon, not the client. In moby,
`daemon/libnetwork/portallocator/portallocator.go`:

```go
func (e alreadyAllocatedErr) Error() string {
	return fmt.Sprintf("Bind for %s:%d failed: port is already allocated", e.ip, e.port)
}
```

Provoked live, with two containers with distinct names binding the same host port **(verified)**:

```
statusCode: 500
message   : "(HTTP code 500) server error - failed to set up container networking: driver failed programming external
             connectivity on endpoint piploy_probe2_b (c0a7b667…): Bind for 0.0.0.0:18081 failed: port is already allocated "
json      : {"message":"failed to set up container networking: … Bind for 0.0.0.0:18081 failed: port is already allocated"}
/port is already allocated/ test -> true
```

The thrown value is a plain `Error` (not a subclass) with own enumerable keys `["reason","statusCode","json"]`. So
`PiployException.CreatePortAlreadyInUse` ports as a substring test on `err.message`, exactly like the C#
`ex.Message.Contains("port is already allocated")` — or, slightly better, on `err.json.message`, which is the daemon's
text without dockerode's `(HTTP code 500) server error - ` prefix.

One incidental finding worth guarding: the failure surfaces on **`start`**, not on `create`, and a *name* clash raises a
different error first (`statusCode: 409`, "The container name … is already in use"). The C# already removes the existing
container before creating, so the name clash should not occur — but do not collapse the two branches.

## Volume mounts and other richer `docker run` options

Not foreclosed. `HostConfig.Binds` works through dockerode and is correctly typed — a container run with
`Binds: ['<hostdir>:/data:ro']` read the mounted file and printed `mounted-ok` **(verified)**. `HostConfig.Mounts`,
`Env`, `RestartPolicy`, `Memory` and the rest of `HostConfig` are all in the same `ContainerCreateOptions` type. The
daemon API is the full surface `docker run` itself uses, so anything `docker run` can do is reachable; the only thing
genuinely out of reach is Compose, which is already out of scope.

(A first attempt at this test failed with "No such file or directory" because the host path was under macOS `/var/folders`,
which is not shared into the colima VM — a dev-environment artifact, not a dockerode or API limitation. Re-run from a
shared path it worked.)

## API version

dockerode sends **no version prefix** unless you pass one: `docker-modem` only prepends `'/' + this.version` when
`opts.version` is set. That works, but the spec says "Using the API without a version-prefix is deprecated and will be
removed in a future release", and the deprecation page adds "API versions should be supplied to all API calls to ensure
compatibility with future Engine versions."

Pinning works and is cheap — `new Docker({ version: 'v1.44' })`. Observed against the arm64 daemon **(verified)**:

```
(no prefix)  -> ApiVersion 1.53 MinAPIVersion 1.44 Version 29.2.1 Arch arm64 linux
v1.44        -> ApiVersion 1.53 MinAPIVersion 1.44 Version 29.2.1 Arch arm64 linux
v1.53        -> ApiVersion 1.53 MinAPIVersion 1.44 Version 29.2.1 Arch arm64 linux
v1.99        -> ERROR 400 "(HTTP code 400) unexpected - client version 1.99 is too new. Maximum supported API version is 1.53 "
```

Note the floor has moved twice: Docker's deprecation page records the minimum as 1.24 from v25.0, "permanently removed"
below that in v26 — but the Engine 29.2.1 daemon I tested reports `MinAPIVersion 1.44`. So **pin low, not high**:
everything piploy uses (`t`, `labels`, `filters`, `PortBindings`, `AutoRemove`, `dangling` prune) long predates 1.44.
Confirm against the Pi before choosing the exact number — see "Open items".

**Connection.** On the Pi this is a non-issue: `new Docker()` defaults to `/var/run/docker.sock`. On a macOS dev box it
is a papercut — dockerode reads `DOCKER_HOST` but **does not read `docker context`**, so a colima/Rancher/Docker-Desktop
setup with a non-default socket needs `DOCKER_HOST` or an explicit `socketPath`. I hit exactly this
(`connect ENOENT /var/run/docker.sock`) before setting `DOCKER_HOST`. Worth a line in the integration-test setup.

## Maintenance and typing quality — the honest picture

**dockerode.** 4,932 stars, Apache-2.0, last push 2026-07-21, 25 open issues, v5.0.1 released 2026-06-24 and v5.0.0
2026-04-23. So it is actively released, not coasting. The caveat is a real one: **one maintainer** (`apocas`, who also
maintains `docker-modem`), and a chunk of recent commit traffic is dependabot. `engines: node >= 14.17`. The code is
old-style JS — `var`, callbacks with a promise wrapper — which is exactly the "callback-flavoured" character the ticket
suspected. It works; it is not pretty.

**`@types/dockerode` 4.0.1** (2026-01-21) is DefinitelyTyped, maintained separately from the library, and lags it. Three
gaps confirmed by `tsc --strict` against the calls this port actually makes:

1. `t?: string` — rejects the multi-tag array that the port requires.
2. `Dockerode.followProgress` is missing entirely — the BuildKit-decoding method.
3. `buildImage` does not accept a `Buffer`: *"Argument of type 'Buffer<ArrayBuffer>' is not assignable to parameter of
   type 'string | ImageBuildContext | ReadableStream'"*. Avoidable by passing a `Readable` (route A or a
   `Readable.from(buf)`), which is better style anyway.

None are blockers, all are one `as any` or a local `declare module` augmentation. But they are in the *load-bearing*
calls, not the periphery, which is why the façade recommendation below is not optional decoration.

## The alternatives, and why not

**Hand-rolled HTTP over the unix socket.** Genuinely viable for this narrow a surface — Node's `http` takes `socketPath`
directly, and piploy touches maybe eight endpoints. But it means owning the chunked NDJSON build-progress parser *and*
the BuildKit protobuf decoding, which is the one thing dockerode does that is not trivial. Reject unless dockerode
becomes unmaintained.

**Generate a typed client from the official spec.** Attractive on paper — moby publishes `api/swagger.yaml` (currently
Engine API 1.55) as a first-party artifact. It does not work with the current toolchain: the file declares
`swagger: "2.0"`, and `openapi-typescript` 7.13.0 is "Convert OpenAPI **3.0 & 3.1** schemas to TypeScript", with OpenAPI
2.x "supported with versions `5.x` and previous". So this is a conversion step plus a five-major-versions-old generator,
and it still leaves you writing the streaming and error layers by hand. Reject.

**`node-docker-api`** (1.1.22) and **`docker-cli-js`** (2.10.0) both last published 2023-06-01 and are dead. `node-docker-api`
still depends on `docker-modem@^0.3.1` — five majors behind. Reject.

**`testcontainers`** (12.0.4, actively maintained) is not a competitor: it *depends on* `dockerode@^5.0.0` and
`@types/dockerode@^4.0.1`. Its existence is the strongest available evidence that dockerode 5 is the current, working
choice — a heavily used library with real CI picked exactly this. It is also a good source of usage patterns, the same
way `testcontainers-dotnet` is cited in `PiployDockerService.cs` today.

## Suggested shape for the port

A thin typed façade, so the `as any` escapes live in one file and no caller can reach the wrong `followProgress`:

```ts
import Docker from 'dockerode'
import fs from 'node:fs'

const docker = new Docker({ version: 'v1.44' }) // pin once the Pi's MinAPIVersion is known

type BuildOpts = { context: string; dockerfile: string; tags: string[]; labels: Record<string, string> }

export async function buildImage(o: BuildOpts, log: (line: string) => void) {
  const stream = await docker.buildImage(
    { context: o.context, src: fs.readdirSync(o.context) }, // src is NOT optional
    { t: o.tags, labels: o.labels, dockerfile: o.dockerfile } as any, // @types says t: string
  )
  await new Promise<void>((resolve, reject) =>
    // docker.followProgress, NOT modem.followProgress — the latter cannot decode BuildKit
    (docker as any).followProgress(stream, (e: unknown) => (e ? reject(e) : resolve()),
      (ev: { stream?: string }) => log(JSON.stringify(ev))),
  )
}

export function isPortAlreadyInUse(err: unknown): boolean {
  const m = (err as { json?: { message?: string }; message?: string })
  return /port is already allocated/.test(m?.json?.message ?? m?.message ?? '')
}
```

`EnsureImageExists` then becomes: `listImages({ filters: { reference: [commitTag] } })` → return if found, else
`buildImage` → re-query. `EnsureContainerRunning` becomes: `listContainers({ filters: { name: [containerName] } })` →
inspect label/state → `remove({ force: true })` → `createContainer` → `start()` inside a `try` that runs
`isPortAlreadyInUse`. Same shape as the C# today.

For packaging (issue #6): if you want to avoid the `cpu-features` compile attempt on the Pi, pnpm's
`onlyBuiltDependencies` / `neverBuiltDependencies` can suppress it, and dockerode still works — proven above. Whether to
bother is a judgement call for issue #8, but the option exists and costs nothing.

## Open items this research could not close

- **The Pi's actual daemon and API version are unknown** — [issue #2](https://github.com/alundgren/Irudd.Piploy/issues/2)
  is still open and is a HITL task. Everything here was verified against Engine 29.2.1 / API 1.53 / min 1.44 on
  linux/arm64, which is a good proxy but not the box. Read the Pi's `MinAPIVersion` before fixing the `version:` pin. If
  the Pi runs an older Engine, nothing in the operation set is at risk — all of it predates API 1.24 — only the pin
  number changes.
- **Whether the classic builder is removed in any currently shipping Engine** is not established. The deprecation is
  announced and "no active development" is stated, but I found no primary source naming a removal version. Treated as
  "announced, not scheduled". The mitigation (use `docker.followProgress`) costs nothing either way.
- **`cpu-features` was observed compiling successfully on darwin/arm64, not on linux/arm64.** It is optional and
  dockerode demonstrably runs without it, so a failure is harmless — but I have not watched it build on a Pi, and cannot
  say whether it succeeds there or merely fails quietly.
- **Nothing was tested against a low-memory device.** Building images on a Pi is a Pi question, not a client question,
  but it is the kind of thing that only shows up on the target.

## Sources

Primary sources only; every claim above traces to one of these.

- `Irudd.Piploy.App/PiployDockerService.cs`, `PiployDockerCleanupService.cs` — this repo
- [Docker Engine API reference](https://docs.docker.com/reference/api/engine/) and [`moby/moby` `api/swagger.yaml`](https://github.com/moby/moby/blob/master/api/swagger.yaml) (Engine API 1.55) — `/build`, `/images/json`, `/containers/json`, `/containers/create`, versioning preamble
- [Docker — Deprecated Engine features](https://docs.docker.com/engine/deprecated/) — legacy builder, unversioned API requests, minimum API version
- moby source: [`daemon/libnetwork/portallocator/portallocator.go`](https://github.com/moby/moby/blob/master/daemon/libnetwork/portallocator/portallocator.go) — the "port is already allocated" string
- dockerode source: [`lib/docker.js`](https://github.com/apocas/dockerode/blob/master/lib/docker.js), [`lib/util.js`](https://github.com/apocas/dockerode/blob/master/lib/util.js), [`lib/buildkit.js`](https://github.com/apocas/dockerode/blob/master/lib/buildkit.js)
- docker-modem source: [`lib/modem.js`](https://github.com/apocas/docker-modem/blob/master/lib/modem.js) (`dial`, `buildQuerystring`, `defaultOpts`), `lib/ssh.js`
- [ssh2 README](https://github.com/mscdex/ssh2#readme) — `cpu-features` as an optional dependency; `lib/protocol/constants.js` for the `try/catch`
- [`@types/dockerode`](https://www.npmjs.com/package/@types/dockerode) 4.0.1 (DefinitelyTyped) `index.d.ts`
- [openapi-typescript](https://openapi-ts.dev/introduction) — OpenAPI 3.x only, 2.x on 5.x and earlier
- npm registry metadata and GitHub repo metadata for `dockerode`, `docker-modem`, `@types/dockerode`, `node-docker-api`, `docker-cli-js`, `testcontainers`, `ssh2` (2026-08-02)
- Direct experiments run with dockerode 5.0.1 on Node 26 against Docker Engine 29.2.1 / API 1.53 / linux-arm64 (build with 3 tags + 5 labels from both an in-memory `tar-stream` buffer and dockerode's `{context, src}` packer; classic vs BuildKit progress decoding; `reference`/`name`/`label` filters; create/start/force-remove with `PortBindings`, `ExposedPorts`, `AutoRemove`; provoked port clash; `Binds` volume mount; dangling prune; API-version pinning; `cpu-features` removal)
