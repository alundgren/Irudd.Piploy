# Can an embedded TS git library replace LibGit2Sharp?

Research for [issue #4](https://github.com/alundgren/Irudd.Piploy/issues/4). Target: linux-arm64, no `git` binary on the Pi.

All version-specific claims are as of 2026-08-02, against isomorphic-git 1.40.0 and nodegit 0.27.0 / 0.28.0-alpha.38.

## Recommendation

**Use isomorphic-git.** It covers every operation `PiployGitService` performs, is pure JavaScript with no native
build step, and I verified the whole pipeline end-to-end against this repo's own GitHub remote.

The tradeoff, stated plainly: **isomorphic-git only speaks HTTP(S).** No SSH, no `file://`, no local paths.
LibGit2Sharp today accepts all of them. If piploy only ever deploys from `https://` remotes, this costs nothing.
If a Pi is ever expected to pull via a deploy key over SSH, isomorphic-git cannot do it and the answer changes to
the git CLI. That is the whole decision.

There is also a second, smaller cost: isomorphic-git has no `reset --hard`, so it has to be composed from two
calls. I tested that the composition is exactly equivalent, including the index — details below. It is an honest
equivalent, not a rough one.

nodegit — the obvious LibGit2Sharp analogue — is ruled out, not on API grounds but on shipping grounds: it has
never published a Node-ABI linux-arm64 prebuilt binary, so it would compile libgit2 from source on the Pi.

## The operations that must be covered

From `Irudd.Piploy.App/PiployGitService.cs` and `GitCommit.cs`:

| LibGit2Sharp today | isomorphic-git equivalent | Status |
| --- | --- | --- |
| `Repository.Clone(url, dir)` | `git.clone({ fs, http, dir, url })` | Direct |
| `Commands.Fetch(repo, remote, refspecs, ...)` | `git.fetch({ fs, http, dir, remote })` | Direct |
| `repo.Head` (branch + tip) | `git.currentBranch()` + `git.resolveRef({ ref: 'HEAD' })` | Direct |
| `repo.Head.RemoteName` | `git.getConfig({ path: 'branch.<name>.remote' })` | Direct |
| `repo.Branches["origin/master"].Tip` | `git.resolveRef({ ref: 'refs/remotes/origin/master' })` | Direct |
| `repo.Reset(ResetMode.Hard, tip)` | `git.writeRef(...)` + `git.checkout({ force: true })` | **Composed — see below** |
| `commit.Sha` / `.Message` / `.Committer.When` | `git.readCommit()` → `oid`, `commit.message`, `commit.committer.{timestamp,timezoneOffset}` | Direct |
| `Directory.Exists(repo/.git)` probe | `git.findRoot()`, or keep the plain directory check | Direct |

`.git` directory detection can stay exactly as it is — it is a filesystem check, not a git operation.

### Verified end-to-end

Against `https://github.com/alundgren/Irudd.Piploy` itself, with isomorphic-git 1.40.0 on Node 26:

```
clone ok in 1142 ms
currentBranch   master
HEAD            c748f963374d263f290305380d3263bc83690adf
branch.master.remote = origin
remotes         [{"remote":"origin","url":"https://github.com/alundgren/Irudd.Piploy"}]
fetch -> { defaultBranch: 'refs/heads/master',
           fetchHead: 'c748f963374d263f290305380d3263bc83690adf',
           desc: "branch 'master' of https://github.com/alundgren/Irudd.Piploy" }
refs/remotes/origin/master = c748f963374d263f290305380d3263bc83690adf
tip message     "Port already in use handling"
```

So clone, fetch, remote-tracking ref resolution, config read and commit read all work, and the shape maps onto
`GetBranches` / `GetCommitStatus` without contortion.

## The `reset --hard` gap, and whether the workaround is honest

**The gap is real.** isomorphic-git has no `reset` command. The API directory
([`src/api/`](https://github.com/isomorphic-git/isomorphic-git/tree/main/src/api)) contains `resetIndex.js` but no
`reset.js`, and the [commands index](https://isomorphic-git.org/docs/en/alphabetic) lists `resetIndex` under
plumbing with no porcelain `reset`. This is long-standing, not a recent regression:
[issue #129 "git reset"](https://github.com/isomorphic-git/isomorphic-git/issues/129) was opened in April 2018 and
closed without a `reset` command being added; the thread's answer is the manual ref-rewrite workaround. Eight
years and 1.40.0 later there is still no `reset`.

**The naive workaround does not work.** `checkout({ ref: 'master', force: true })` on its own is *not* a hard reset
to the remote tip. If the local branch already exists, `_checkout` resolves the ref to the *local* branch and
leaves the branch pointer where it was
([`src/commands/checkout.js`](https://github.com/isomorphic-git/isomorphic-git/blob/main/src/commands/checkout.js) —
the `GitRefManager.resolve({ ref })` path only falls back to `<remote>/<ref>` when the local ref does **not**
resolve). I confirmed this: after `checkout({ ref: 'master', force: true })` with `origin/master` at commit B, HEAD
was still at commit A. Anyone porting this by reaching for `checkout --force` alone will silently never deploy new
commits.

**The correct composition, and proof it is equivalent.** Two calls:

```js
await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: remoteTipOid, force: true })
await git.checkout({ fs, dir, ref: branch, force: true })
```

I built two identical dirty working copies at commit A with `origin/master` at commit B, dirtied them in every way
that distinguishes reset semantics — a modified tracked file, a modified file that B deletes, a deleted tracked
file, a staged new file, and an untracked file — then ran `git reset --hard B` on one and the two-call composition
on the other, and diffed the results:

```
--- head:   IDENTICAL   05765ef811346eff15a42d6c5e413a98767a2c2a
--- branch: IDENTICAL   main
--- status: IDENTICAL   ?? untracked.txt
--- files:  IDENTICAL
    ./added.txt  "new in B\n"
    ./keep.txt  "v2\n"
    ./sub/nested.txt  "n2\n"
    ./untracked.txt  "untracked\n"
```

Identical on all four axes, including the index — the staged file was unstaged and removed by both, and the
untracked file survived both. That last point matters and matches git's own definition: `git reset --hard` updates
tracked content and the index, and per [git-reset(1)](https://git-scm.com/docs/git-reset), "Tracked files not in
*<commit>* are removed so that the working tree matches *<commit>*. Update the index to match the new `HEAD`, so
nothing will be staged." It does not sweep untracked files, and neither does the composition.

This is corroborated by the source: in `_checkout`'s `analyze()`, case `'001'` (untracked, absent from the target
commit) returns without an operation unless explicitly named in `filepaths`; case `'101'` (in index and workdir,
absent from the commit) returns `delete`; and cases `'011'`/`'111'` return `update` when `force` is set instead of
raising `CheckoutConflictError`.

**Verdict: the workaround is genuinely equivalent for piploy's use.** The caveat is that it is two operations, not
one, and therefore not atomic — a crash between `writeRef` and `checkout` leaves the branch pointer moved and the
working tree stale. LibGit2Sharp's single `Reset` call has the same exposure in practice (it is not transactional
either), and piploy's loop is idempotent — the next pass re-runs the checkout — so this is a note, not a blocker.
Worth wrapping in one `resetHard()` helper so no caller can do half of it.

## The transport constraint — the real cost

isomorphic-git resolves a remote helper in
[`src/managers/GitRemoteManager.js`](https://github.com/isomorphic-git/isomorphic-git/blob/main/src/managers/GitRemoteManager.js),
whose entire table is:

```js
remoteHelpers.set('http', GitRemoteHTTP)
remoteHelpers.set('https', GitRemoteHTTP)
```

Anything else throws `UnknownTransportError`; an unparseable URL throws `UrlParseError`. `GitRemoteHTTP` is the
only helper in `src/managers/`. Observed directly:

```
UrlParseError          /tmp/.../work/upstream
    -> Cannot parse remote URL: "/tmp/.../work/upstream"
UnknownTransportError  file:///tmp/.../work/upstream
    -> uses an unrecognized transport protocol: "file"
UnknownTransportError  ssh://git@example.com/x/y.git
    -> uses an unrecognized transport protocol: "ssh"
UnknownTransportError  git@example.com:x/y.git
    -> uses an unrecognized transport protocol: "ssh"
```

Two consequences worth deciding on before committing to this:

1. **SSH remotes are impossible.** Not awkward — impossible. `git@github.com:...` and `ssh://` both throw. The
   library will helpfully suggest an HTTPS translation of the URL, but it cannot use the key.
2. **The existing test harness breaks.** `Irudd.Piploy.Test/Utilities/TestBase.cs` sets
   `GitRepositoryUrl = remoteDirectory` — a plain local directory path — for both test applications, and
   `FakeGitRepository` builds a real repo there. LibGit2Sharp clones that happily; isomorphic-git raises
   `UrlParseError`. The TS port's test suite will need a different approach: serve the fixture repo over HTTP
   locally (isomorphic-git's own test suite does this), or make the fixture setup do a filesystem copy plus
   `git.init` rather than a clone. This is a known chunk of porting work, not a surprise to be discovered later.

## Credentials

**The dotnet version passes no credentials, and does not need to.** `PiployGitService.cs` calls
`Repository.Clone(application.GitRepositoryUrl, repoDirectory)` and `Commands.Fetch(..., new FetchOptions { }, "")`
with no `CredentialsProvider` anywhere; `PiploySettings.Application` (`PiploySettings.cs`) has exactly one git
field, `GitRepositoryUrl`, with no username, token or key-path sibling. There is no credential handling in the
codebase at all. So today piploy works only against **public repositories** — or, on a machine where libgit2 picks
up ambient config, whatever that config provides. The target repo itself is public, which is consistent with this.

If private repos are ever wanted, isomorphic-git's route is the
[`onAuth`](https://isomorphic-git.org/docs/en/onAuth) callback, which returns `{ username, password }` (a Personal
Access Token as the password) or raw `{ headers }`. It documents no SSH-key path — consistent with the
HTTPS-only transport table. A `GitCredentials` block in `piploy.json`, or a token from the environment, would drop
into `onAuth` cleanly. Worth noting that this would be a *new* capability, not a port of an existing one, and
should be its own issue rather than smuggled into the port.

## Why not nodegit

nodegit is libgit2 bindings — the closest analogue to LibGit2Sharp, and API-wise it would map almost one-to-one,
including a real `Reset.reset(repo, commit, Reset.TYPE.HARD)`. It fails on delivery:

- **The stable release is nearly six years old.** `nodegit@0.27.0` was published 2020-07-28 (npm registry
  metadata). The `next` tag is `0.28.0-alpha.38` (2026-04-23) — still alpha after years, though the repo is
  actively committed to (most recent commits July 2026).
- **No Node-ABI linux-arm64 prebuilt binary has ever been published.** I enumerated the full prebuild bucket
  (`https://axonodegit.s3.amazonaws.com/nodegit/nodegit/`, the `binary.host` declared in nodegit's own
  `package.json`): 3183 objects across all versions, 47 mentioning arm. Every `linux-arm64` artifact is an
  **Electron** ABI build:

  ```
  nodegit-v0.28.0-alpha.36-electron-v38.4-linux-arm64.tar.gz
  nodegit-v0.28.0-alpha.38-electron-v41.3-linux-arm64.tar.gz
  ```

  Count of `node-v*-linux-arm64` artifacts in the entire bucket: **0**. darwin-arm64 and win32-arm64 Node builds
  exist; linux-arm64 Node builds do not.
- **Therefore it compiles from source on the Pi.** `lifecycleScripts/install.js` invokes node-pre-gyp with
  `--fallback-to-build`, so a missing prebuild is not an error — it silently becomes a full libgit2 + C++ addon
  compile, needing a toolchain and Python on the target, taking a long time on a Pi, and re-triggering on every
  Node major upgrade. That is strictly worse than the dotnet status quo, where LibGit2Sharp ships a native
  linux-arm64 binary in the NuGet package.

Also note `0.28.0-alpha.38` declares `engines: { node: '>= 20' }` — fine, but it is an alpha, so choosing nodegit
means depending on an alpha to get any recent-Node support at all.

## The fallback: simple-git / child_process

Kept as the documented fallback, not the recommendation. simple-git 3.36.0 (2026-04-12) is pure JS with only
four small runtime deps, and is behaviourally the most faithful option — it *is* git, so `file://`, local paths,
SSH, credential helpers and `reset --hard` all just work. Its readme states the cost outright under System
Dependencies: "Requires git to be installed and that it can be called using the command `git`."

That forfeits the embedded property the ticket asks to preserve, and adds a provisioning requirement on the Pi
(and on any container piploy itself runs in). Take this route only if SSH remotes turn out to be a requirement —
in which case it is the *only* route, since isomorphic-git cannot do SSH at any price.

## Suggested shape for the port

```ts
// one helper so no caller can perform half a reset
async function resetHard(dir: string, oid: string, branch: string) {
  await git.writeRef({ fs, dir, ref: `refs/heads/${branch}`, value: oid, force: true })
  await git.checkout({ fs, dir, ref: branch, force: true })
}
```

`EnsureLocalRepository` then becomes: probe `.git` → `clone` if absent; otherwise `fetch`, compare
`resolveRef('HEAD')` against `resolveRef('refs/remotes/origin/<branch>')`, and call `resetHard` when they differ —
the same shape as the C# today.

Two implementation notes:

- isomorphic-git needs an explicit HTTP client: `import http from 'isomorphic-git/http/node'`. It is a separate
  export subpath, not bundled into the default import.
- `commit.committer.timezoneOffset` is in **minutes and sign-inverted relative to ISO 8601** — a commit at
  `+02:00` reports `timezoneOffset: -120` (observed; matches the JS `Date.getTimezoneOffset()` convention, not
  git's). Get this backwards and `GitCommit.Date` is off by twice the offset. `commit.committer.timestamp` is
  plain UTC epoch seconds and is the safe field to build from.

## Sources

Primary sources only; every claim above traces to one of these.

- `Irudd.Piploy.App/PiployGitService.cs`, `GitCommit.cs`, `PiploySettings.cs`, `Irudd.Piploy.Test/Utilities/TestBase.cs` — this repo
- [isomorphic-git command index](https://isomorphic-git.org/docs/en/alphabetic), [`clone`](https://isomorphic-git.org/docs/en/clone), [`fetch`](https://isomorphic-git.org/docs/en/fetch), [`onAuth`](https://isomorphic-git.org/docs/en/onAuth)
- isomorphic-git source: [`src/api/`](https://github.com/isomorphic-git/isomorphic-git/tree/main/src/api), [`src/managers/GitRemoteManager.js`](https://github.com/isomorphic-git/isomorphic-git/blob/main/src/managers/GitRemoteManager.js), [`src/commands/checkout.js`](https://github.com/isomorphic-git/isomorphic-git/blob/main/src/commands/checkout.js), [`src/typedefs.js`](https://github.com/isomorphic-git/isomorphic-git/blob/main/src/typedefs.js)
- [isomorphic-git issue #129 "git reset"](https://github.com/isomorphic-git/isomorphic-git/issues/129)
- [git-reset(1)](https://git-scm.com/docs/git-reset)
- npm registry metadata for `isomorphic-git`, `nodegit`, `simple-git`; nodegit prebuild bucket listing at `https://axonodegit.s3.amazonaws.com/nodegit/nodegit/`
- nodegit source: [`lifecycleScripts/install.js`](https://github.com/nodegit/nodegit/blob/master/lifecycleScripts/install.js)
- [simple-git readme](https://github.com/steveukx/git-js/blob/main/simple-git/readme.md)
- Direct experiments run against isomorphic-git 1.40.0 on Node 26 / git 2.54.0 (transport table, reset equivalence, commit metadata, live clone+fetch of this repo)
