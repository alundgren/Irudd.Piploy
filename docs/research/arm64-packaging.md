# Shipping a TypeScript daemon to linux-arm64 (Raspberry Pi)

Research for [issue #6](https://github.com/alundgren/Irudd.Piploy/issues/6). Dev box is macOS/arm64, target is a Raspberry Pi running 64-bit Raspberry Pi OS under systemd, package manager is pnpm.

There was no existing convention for research notes in this repo, so this file starts `docs/research/`.

All claims below are cited to the source that owns them. Numbers marked **(measured)** were obtained by downloading the actual release artifacts on 2026-08-02; everything else is a documented claim, not a measurement.

---

## Recommendation

**Bundle to one JS file with esbuild/tsup, install Node on the Pi, and ship `piploy.js` + a systemd unit. Treat Node SEA as an upgrade you can take later without redoing any work.**

The reason this is the right shape rather than a cop-out: **a SEA takes a single bundled JS file as its `main`.** Node's SEA config is `{ "main": "/path/to/bundled/script.js", "output": ... }`, and the docs are explicit that by default only built-in modules can be resolved at runtime, so the entry must already be bundled ([Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html)). So the bundler step is not an alternative to SEA — it is step one of SEA. Doing it first costs nothing and buys a decision you can defer until the git/Docker library question (below) is settled.

Concretely:

1. `tsup`/`esbuild` → `dist/piploy.cjs`, one file, CommonJS.
2. `scp dist/piploy.cjs pi:/home/<user>/Piploy/`, `systemctl restart piploy`.
3. Unit's `ExecStart` becomes `/usr/bin/node /home/<user>/Piploy/piploy.cjs service-start`.
4. If and when the single-binary workflow is missed, add `node --build-sea sea-config.json` pointing `main` at the same `dist/piploy.cjs`. Nothing else changes.

**What this gives up:** one extra thing installed on the Pi (Node), and the artifact is not `chmod +x`-able on its own. **What it buys:** the deploy artifact is ~1 MB instead of ~150 MB, stack traces are real, you can `node --inspect` on the Pi, and the packaging decision stops blocking on the native-module question.

**Bun and Deno are not recommended**, not because their compile story is worse — Bun's is actually the best of the three — but because they swap the runtime out from under a daemon whose whole job is talking to Unix sockets and child processes. That is a compatibility surface you would be paying for forever to save one `apt install`. Detail in the per-option sections.

---

## The native-module question, answered both ways

This is the load-bearing unknown, so take it first.

### Fact 1: the libraries most likely to be picked are pure JS

Checked directly against the npm registry (`npm view <pkg> dependencies gypfile`) on 2026-08-02:

| Package | Native? | Evidence |
|---|---|---|
| `dockerode` 5.0.1 | **No** | No `gypfile`. Deps are `docker-modem`, `@grpc/grpc-js`, `protobufjs`, `tar-fs`, `@balena/dockerignore`. `@grpc/grpc-js` self-describes as "gRPC Library for Node - **pure JS** implementation". |
| `simple-git` 3.36.0 | **No** | Deps are all JS helpers; it shells out to the `git` binary. |
| `isomorphic-git` 1.40.0 | **No** | Pure JS deps (`pako`, `sha.js`, `crc-32`, …). |
| `nodegit` 0.27.0 | **Yes** | Depends on `nan`, `node-gyp`, `node-pre-gyp`. |

So the native-module risk is concentrated almost entirely in one choice: `nodegit`. If the parallel git/Docker research lands on `dockerode` + (`simple-git` or `isomorphic-git`), **this whole section is moot** and every packaging option below stays open.

### Fact 2: ABI stability does not save you across architectures

Node-API guarantees that an addon compiled for one Node major version runs on later majors "without recompilation" ([Node-API docs](https://nodejs.org/api/n-api.html)). That stability is **across Node versions only**. The same docs point at `node-pre-gyp`/`prebuild`/`prebuildify` precisely because a separate binary is still needed per OS and per architecture. A `.node` file built on your Mac is `darwin/arm64` and will not load on the Pi.

### Fact 3: pnpm can fetch foreign-arch binaries without a Pi

`supportedArchitectures` lets you "specify architectures for which you'd like to install optional dependencies, even if they don't match the architecture of the system running the install", with `os`, `cpu` and `libc` keys ([pnpm dependency-resolution settings](https://pnpm.io/settings/dependency-resolution)). So:

```yaml
supportedArchitectures:
  os: [linux, current]
  cpu: [arm64, current]
  libc: [glibc]
```

This works for packages that ship **prebuilt** arm64 binaries as optional deps. It does **not** work for packages that compile in a `postinstall` (`nodegit` does), because there is no arm64 toolchain on the Mac.

### If the libraries are pure JS

- **Cross-compilation is a non-problem for every option.** JS is architecture-neutral; the only per-arch thing is the runtime, and all three runtimes ship official linux-arm64 builds.
- Node SEA cross-builds cleanly (see below), Bun and Deno cross-compile by design, and the bundler option has nothing to cross-compile at all.
- **This is the world to plan for.** Pick on ergonomics, not on native-module contortions.

### If the git or Docker library turns out to be native

Ranked easiest to hardest:

1. **Bundler + Node on the Pi — easiest.** Two escape hatches: ship `node_modules/<pkg>` alongside the bundle with an arm64 prebuild pulled via `supportedArchitectures`, or run `pnpm rebuild` on the Pi where the toolchain and the target arch are the same thing. Nothing about the packaging changes. Note that esbuild/tsup must then mark the native package `external` — you cannot bundle a `.node` into a JS file.
2. **Container — also easy, structurally.** `docker buildx build --platform linux/arm64` builds the addon on (an emulation of) the target platform, so `postinstall` compilation works without a cross-toolchain. `node` official images publish `arm64v8` for both `bookworm` and `alpine` variants ([docker-library/official-images `library/node`](https://github.com/docker-library/official-images/blob/master/library/node)).
3. **Node SEA — possible but manual.** Native addons are supported by declaring them in the `assets` field, then at runtime writing the asset to a temp file and calling `process.dlopen()` — the docs spell out exactly this dance ([Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html)). You are hand-writing extraction code, and the addon must already be an arm64 `.node`. There is also a pointed caveat: *"if the single-executable application is produced by postject running on a Linux arm64 docker container, the produced ELF binary does not have the correct hash table to load the addons and will crash on `process.dlopen()`. Build the single-executable application on other platforms, or at least on a non-container Linux arm64 environment to work around this issue."* Building on macOS avoids that specific trap; building in an arm64 CI container walks straight into it.
4. **Bun — plausible, with a live bug.** Bun "implements this interface from scratch, so **most** existing Node-API extensions work with Bun out of the box" ([Bun Node-API docs](https://bun.com/docs/api/node-api)) — "most" is doing work in that sentence. `bun build --compile` can embed `.node` files, but with a caveat: *"If you're using `@mapbox/node-pre-gyp` or similar tools, the `.node` file must be required directly or it won't bundle correctly"* ([Bun executables docs](https://bun.com/docs/bundler/executables)) — and `node-pre-gyp` is exactly what `nodegit` uses. There is also an open regression, [oven-sh/bun#26045](https://github.com/oven-sh/bun/issues/26045), where `--compile` with multiple NAPI modules mixes their exports. Additionally, nothing in Bun's docs states that a *foreign-architecture* `.node` is embedded correctly when cross-compiling; cross-compilation and native embedding are documented separately and I found no primary source that they compose.
5. **Deno — most constrained.** `deno compile` gained FFI and Node native addon support in 2.3: *"Deno 2.3 extends `deno compile` to support programs that use Foreign Function Interface (FFI) and Node native add-ons"* ([Deno 2.3 release notes](https://deno.com/blog/v2.3)). But it requires a real `node_modules/` directory (`nodeModulesDir: "auto"|"manual"`) plus `--allow-ffi`, and Deno does not run npm lifecycle scripts by default for security reasons — which is how most native addons obtain their binding ([deno compile docs](https://docs.deno.com/runtime/reference/cli/compile/), [Node/npm compatibility](https://docs.deno.com/runtime/fundamentals/node/)).

**Bottom line:** if a native module lands, options 1 and 2 barely notice and options 3–5 all become projects. That asymmetry is a real argument for the recommendation even before ergonomics are considered.

---

## Option 1: Node SEA

**Status.** *"Stability: 1.1 - Active development"* ([Node.js SEA docs](https://nodejs.org/api/single-executable-applications.html)). Added in v19.7.0/v18.16.0; the one-step `node --build-sea <config>` flag landed in **v25.5.0**, replacing the older manual `npx postject` dance. Same doc lists CI coverage as Windows, macOS arm64, and *"Linux (all distributions supported by Node.js except Alpine and all architectures supported by Node.js except s390x)"* — so linux-arm64 is a regularly tested target.

**Cross-compiling from macOS: yes, with one setting.** Two mechanics make it work:

- The config takes an `executable` key — *"Optional, if not specified, uses the current Node.js binary"* — so you point it at a downloaded `node-vX-linux-arm64` binary instead of your Mac's.
- Injection is done by [postject](https://github.com/nodejs/postject), which per its own README injects into *"Mach-O, PE, ELF"* and is built with Emscripten (CMake + Ninja + emsdk, output is `dist/main.js`). It is a WASM/JS tool, not a native host tool, so it manipulates an aarch64 ELF from a macOS host without needing a cross-toolchain.

The documented constraint: *"When generating cross-platform SEAs (e.g., generating a SEA for `linux-x64` on `darwin-arm64`), `useCodeCache` and `useSnapshot` must be set to false to avoid generating incompatible executables. Since code cache and snapshots can only be loaded on the same platform where they are compiled, the generated executable might crash on startup."* Both default to `false` anyway, so the practical cost is that **you forfeit the startup optimisation that is SEA's main runtime advantage over plain `node script.js`**. If startup on the Pi ever matters, the fix is to run the SEA build *on the Pi* with `useCodeCache: true` — which is a strictly larger deploy pipeline.

Also relevant: `useSnapshot` cannot be combined with `"mainFormat": "module"`, and with `useCodeCache: true` dynamic `import()` does not work. ESM is supported via `"mainFormat": "module"`, but `import.meta.resolve` is unavailable and `import()` can only load built-ins — another reason to bundle to CJS.

**Disk (measured).** The SEA output is a copy of the Node binary with a blob appended. `node-v26.5.1-linux-arm64/bin/node` is **148,303,152 bytes (~141 MiB)**, `ELF 64-bit LSB executable, ARM aarch64 … not stripped, with debug_info`. So expect a ~141 MiB artifact over `scp` on every deploy. (For comparison, the whole `node-v26.5.1-linux-arm64` tarball is 31 MB compressed / 232 MB extracted, of which 62 MB is `include/` headers you would never ship.)

**Startup.** Not measured on a Pi. Structurally it is the same V8 + same bundled script as plain Node, so with code cache disabled expect parity with `node piploy.js`, not an improvement.

**Verdict.** The genuine spiritual successor to `dotnet publish --self-contained -p:PublishSingleFile=true`, and cross-building from the Mac works. Held back only by Stability 1.1 and a ~141 MiB artifact. **Adopt it second, once the library question is closed** — it slots onto the recommended bundle with no rework.

## Option 2: `bun build --compile`

**Cross-compilation: best in class.** *"Use the `--target` flag to compile your standalone executable for a different operating system, architecture, or version of Bun than the machine you're running `bun build` on."* `bun-linux-arm64` and `bun-linux-arm64-musl` are both listed targets ([Bun executables docs](https://bun.com/docs/bundler/executables)). So `bun build --compile --target=bun-linux-arm64 --minify --bytecode ./src/index.ts --outfile piploy` from macOS is a documented one-liner. No arch caveats apply on ARM (the AVX2/`-baseline` business is x64-only).

**Startup.** `--bytecode` *"moves parsing overhead for large input files from runtime to bundle time"*, with a claimed 2x faster startup for a workload like `tsc` (same doc). Unlike SEA's code cache, nothing in the docs says `--bytecode` is incompatible with cross-compilation. For a daemon that starts once and runs forever, this is close to irrelevant anyway.

**Disk (measured).** `bun-linux-aarch64` from release `bun-v1.3.14` is **91,801,560 bytes (~88 MiB)** — the smallest of the three single-binary options, and that is the floor your compiled artifact sits on.

**Requirements.** *"Bun's glibc binaries require glibc 2.17 or newer"* and *"Kernel version 5.6 or higher is recommended; Bun runs on kernels as old as 3.10"* ([Bun installation docs](https://bun.com/docs/installation)). Raspberry Pi OS is Debian-based and the current release is on Debian Trixie ([Raspberry Pi OS docs](https://www.raspberrypi.com/documentation/computers/os.html)), far above both floors. 64-bit Pi OS covers Pi 3, 4 and 5.

**What you give up.** The runtime. Bun's own compatibility table rates `node:net` *"🟢 Fully implemented"* (good — that is the Docker Unix socket path) but `node:child_process` only partially: *"Missing `proc.gid` `proc.uid`. `Stream` class not exported. IPC cannot send socket handles"* ([Bun Node.js API compatibility](https://bun.com/docs/runtime/nodejs-apis)). A deploy daemon that shells out to `git` and `docker` lives in `child_process`. None of the listed gaps are obviously fatal, but the list is a moving target and you would be validating it yourself on every upgrade.

**Verdict.** Technically the smoothest cross-compile of the three, and the smallest binary. Rejected only on runtime risk: adopting Bun means every future Node-ecosystem library is a compatibility question. Reasonable to revisit if the daemon stays small and the deps stay boring.

## Option 3: `deno compile`

**Cross-compilation: officially supported.** *"Deno supports cross compiling to all targets regardless of the host platform"*, with `aarch64-unknown-linux-gnu` in the target list. Mechanically, `--target` downloads and caches a platform-specific `denort` (stripped runtime) binary, after which builds work offline ([deno compile docs](https://docs.deno.com/runtime/reference/cli/compile/)).

**Disk (measured).** `denort-aarch64-unknown-linux-gnu` from `v2.9.4` unpacks to **108,766,096 bytes (~104 MiB)**. `--bundle` + `--minify` tree-shake your code but do not shrink that floor.

**What you give up.** The npm interop is the weak point for this use case. Per the compile docs, non-statically-analyzable dynamic imports and computed worker URLs are dropped unless passed via `--include`, and CJS packages plus `.node` addons need special handling. Deno also does not run lifecycle scripts by default. `node:child_process` is "partially supported" with Deno 2.7 improvements noted, and `node:net` is partial (`fd` option unsupported) ([Node/npm compatibility](https://docs.deno.com/runtime/fundamentals/node/)).

**Verdict.** No advantage over Bun for this project — bigger binary, more npm friction — and the same runtime-swap risk. Rejected.

## Option 4: Bundler + Node on the Pi (recommended)

**Cross-compilation: not applicable.** esbuild/tsup emit portable JavaScript. The only per-arch artifact is Node itself, and nodejs.org ships official `linux-arm64` builds for every current release (`node-v26.5.1-linux-arm64.tar.xz`, 31,021,640 bytes over the wire; **measured** 232 MB extracted, 153 MB of which is `bin/`).

**Deploy shape.** Two artifacts instead of one — but only one of them changes per deploy, and it is ~1 MB rather than ~141 MiB. Installing Node is a one-time `tar -xJf` into `/usr/local` (or the distro package). The systemd unit in `README.md` needs `ExecStart=/usr/bin/node /home/<user>/Piploy/piploy.cjs service-start`; everything else in that unit is unchanged.

**Startup and disk.** Identical runtime to Option 1, so identical startup, at ~150 MB resident on disk for Node — the same bytes Option 1 would ship on *every* deploy, paid once.

**Debuggability.** This is the real win. `node --inspect`, `node --stack-trace-limit`, source maps that resolve, and the ability to `node -e` against your own bundle on the Pi when something misbehaves at 11pm. None of the compiled options give you that without rebuilding.

**Verdict.** Recommended. Also the option that keeps every other option open.

## Option 5: piploy in a container

**Shape.** `docker buildx build --platform linux/arm64` from the Mac (buildx handles the cross-build; `node` official images publish `arm64v8` per [docker-library/official-images](https://github.com/docker-library/official-images/blob/master/library/node)), push or `docker save`/`scp`/`docker load`, then run with `-v /var/run/docker.sock:/var/run/docker.sock`.

**The security cost is real and documented.** Docker's own post-install guide states flatly: *"The `docker` group grants root-level privileges to the user."* ([Docker post-install docs](https://docs.docker.com/engine/install/linux-postinstall/)), and the daemon-protection page makes the same point about daemon credentials: *"anyone with the keys can give any instructions to your Docker daemon, giving them root access to the machine hosting the daemon"* ([Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/)). Worth noting honestly: **piploy already needs this privilege**, container or not — it exists to drive Docker. Containerising does not add a new capability, it just relocates where the socket is mounted.

**Bootstrapping.** Something must start the container and restart it on boot. systemd still does that (`ExecStart=/usr/bin/docker run --rm ...` or a `docker compose` unit), so systemd does not go away; you gain a layer rather than removing one.

**Verdict.** Not the first move — it makes routine debugging harder (`docker logs` instead of `journalctl`, exec into a container to poke at a git checkout) for benefit you do not collect until self-deploy exists. But see below.

---

## Which options help the future "piploy redeploys itself" story

Not in scope to build, but cheap to prefer.

- **Container (Option 5) — clearly easiest.** Self-redeploy becomes "pull a new image tag and recreate the container", which is *literally the thing piploy already does for every other service*. No new mechanism at all. This is the strongest argument in Option 5's favour and the reason it should stay on the table as a phase 2.
- **Bundler + Node (Option 4) — easy.** Replacing a `.js` file has no OS-level restriction; write the new file, `systemctl restart piploy`. The daemon can even stage the file and exit, letting `Restart=always` in the existing unit pick it up.
- **Single-binary options (1–3) — mildly awkward.** Linux refuses to write to the file of a running executable (`ETXTBSY`), so self-replacement must be `rename()`-then-write, not overwrite-in-place. This is a well-known, solvable pattern, but it is code you have to get right, and the artifact being ~88–141 MiB makes the transfer itself a more serious operation.

---

## Summary table

| | Cross-build from macOS | Artifact on the wire | Disk on Pi | If native module | Self-redeploy | Debuggability |
|---|---|---|---|---|---|---|
| **Bundler + Node** ✅ | N/A (portable JS) | ~1 MB | ~150 MB (once) | Easy (`pnpm rebuild` or arm64 prebuild) | Easy | Best |
| **Node SEA** | Yes, `executable` + postject; no code cache | ~141 MiB (measured) | ~141 MiB | Manual `assets` + `process.dlopen()` | ETXTBSY dance | Poor |
| **Bun compile** | Yes, `--target=bun-linux-arm64` | ~88 MiB floor (measured) | ~88 MiB | Docs unclear for foreign-arch `.node`; open bug #26045 | ETXTBSY dance | Poor |
| **Deno compile** | Yes, all targets | ~104 MiB floor (measured) | ~104 MiB | Needs `node_modules` + `--allow-ffi`, no lifecycle scripts | ETXTBSY dance | Poor |
| **Container** | Yes, buildx `--platform linux/arm64` | image layers | image + Node layer | Easiest (builds on target platform) | Easiest | Medium |

## Open items this research could not close

- **Startup time on actual Pi hardware was not measured** — no device available to this investigation. All three compiled options run the same class of JS engine; the only documented startup lever that survives cross-compilation is Bun's `--bytecode`. If startup ever matters, measure on the device rather than trusting any of this.
- **Whether Bun correctly embeds a foreign-architecture `.node` when cross-compiling** is not addressed by any primary source I could find. Treat as unknown, not as "works".
- The git/Docker library choice is being decided in parallel; if it lands on `nodegit`, re-read the "if native" section before committing to a packaging option.

## Sources

- [Node.js — Single Executable Applications](https://nodejs.org/api/single-executable-applications.html)
- [Node.js — Node-API](https://nodejs.org/api/n-api.html)
- [nodejs/postject README](https://github.com/nodejs/postject/blob/main/README.markdown)
- [Node.js downloads index](https://nodejs.org/dist/index.json)
- [Bun — Single-file executable](https://bun.com/docs/bundler/executables)
- [Bun — Node-API](https://bun.com/docs/api/node-api)
- [Bun — Node.js API compatibility](https://bun.com/docs/runtime/nodejs-apis)
- [Bun — Installation / system requirements](https://bun.com/docs/installation)
- [oven-sh/bun#26045 — `--compile` mixes multiple NAPI module exports](https://github.com/oven-sh/bun/issues/26045)
- [Deno — `deno compile`](https://docs.deno.com/runtime/reference/cli/compile/)
- [Deno — Node and npm compatibility](https://docs.deno.com/runtime/fundamentals/node/)
- [Deno 2.3 release notes](https://deno.com/blog/v2.3)
- [pnpm — dependency resolution settings (`supportedArchitectures`)](https://pnpm.io/settings/dependency-resolution)
- [Docker — Linux post-installation steps](https://docs.docker.com/engine/install/linux-postinstall/)
- [Docker — Protect the Docker daemon socket](https://docs.docker.com/engine/security/protect-access/)
- [docker-library/official-images — `library/node`](https://github.com/docker-library/official-images/blob/master/library/node)
- [Raspberry Pi OS documentation](https://www.raspberrypi.com/documentation/computers/os.html)
- npm registry metadata for `dockerode`, `simple-git`, `isomorphic-git`, `nodegit`, `@grpc/grpc-js` (via `npm view`, 2026-08-02)
