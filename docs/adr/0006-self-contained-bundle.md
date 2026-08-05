# The bundle is self-contained, with `ssh2` stubbed out

`tsup` treats everything in `dependencies` as external by default, so v1.0.0
shipped a `piploy.cjs` that still required `commander`, `dockerode`,
`isomorphic-git`, `pino` and `zod` from a `node_modules` that does not exist on
the Pi — the daemon could not start from a clean install
([#55](https://github.com/alundgren/Irudd.Piploy/issues/55)). **The build
bundles all runtime dependencies into the Bundle, and resolves `ssh2` and
`cpu-features` to empty stub modules instead.** Bundling them for real is not
possible: their native addons are never built (`allowBuilds` in
`pnpm-workspace.yaml` sets both to `false`), and merely marking them external
moves the failure from build time to startup, because `docker-modem/lib/ssh.js`
requires `ssh2` eagerly when the module loads. The stub is safe because
[ADR-0005](./0005-docker-endpoint-pinned-to-local-socket.md) pins the Docker
endpoint to the local Unix socket, so the SSH transport is unreachable by
construction rather than merely unused.

## Two checks guard it

A **static check at build time** fails `pnpm build` if the emitted bundle
requires anything outside Node's builtins. This is the check that maps exactly
onto how #55 happened.

A **behavioural check gating releases** copies only the Bundle into a temporary
directory, puts a fixture `piploy.json` beside it, and runs `--version` and
`status` as a child process. Two properties of it are load-bearing and easy to
get wrong:

- It must **spawn the Bundle as a subprocess**, not import from `src/`. Every
  existing test in `test/integration/` imports the TypeScript sources with
  `node_modules` present, which is why a green suite sat alongside an
  unusable release asset. Those tests prove the source works and structurally
  cannot prove the Bundle works.
- The temporary directory must be **outside the repository tree**. Node
  resolves `node_modules` by walking up from the file's own directory, not
  from the working directory, so a scratch directory anywhere under the repo
  would find the repo's own dependencies and pass a broken Bundle. That
  failure mode is worse than having no check, because it manufactures
  confidence.

## Known gap, accepted deliberately

The behavioural check starts the Bundle but never builds an image. Some
libraries below `dockerode` — `@grpc/grpc-js` and `protobufjs` — resolve module
paths while running rather than declaring them statically, so the bundler
cannot see those requests and does not pack what they ask for. A failure of
that kind would survive both checks and first appear when Piploy builds an
application image on the Pi.

Closing it would mean a release-gating end-to-end run that clones a fixture
repository and performs a real image build through the Bundle. That was
considered and rejected as too slow to sit in front of every release. The gap
is recorded here so that a future "Cannot find module" during a deploy is
recognised as this known hole rather than diagnosed from scratch.
