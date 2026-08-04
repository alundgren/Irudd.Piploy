import fs from "node:fs";
import path from "node:path";

import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

import type { Logger } from "./logger.js";
import {
  getApplicationRepoDirectory,
  type Application,
  type PiploySettings,
} from "./settings.js";

export interface GitCommit {
  hash: string;
  date: Date;
  message: string;
}

export interface GitCommitStatus {
  local: GitCommit;
  remote: GitCommit;
}

function hasGitDirectory(repoDirectory: string): boolean {
  return fs.existsSync(path.join(repoDirectory, ".git"));
}

async function resolveBranch(repoDirectory: string): Promise<string> {
  const branch = await git.currentBranch({
    fs,
    dir: repoDirectory,
    fullname: false,
  });
  if (!branch) {
    throw new Error(
      `Could not determine the current branch for the repository at ${repoDirectory}`,
    );
  }
  return branch;
}

async function readGitCommit(
  repoDirectory: string,
  oid: string,
): Promise<GitCommit> {
  const { commit } = await git.readCommit({ fs, dir: repoDirectory, oid });
  return {
    hash: oid,
    // committer.timestamp is UTC epoch seconds; committer.timezoneOffset is
    // minutes and sign-inverted relative to ISO 8601, so it's not safe to
    // combine with timestamp (see docs/research/ts-git-library.md).
    date: new Date(commit.committer.timestamp * 1000),
    message: commit.message.trimEnd(),
  };
}

/**
 * Composes `git reset --hard <oid>` from writeRef + checkout, proven
 * byte-identical including the index (docs/research/ts-git-library.md).
 * Not exported: no caller may run half of it.
 */
async function resetHard(
  repoDirectory: string,
  branch: string,
  oid: string,
): Promise<void> {
  await git.writeRef({
    fs,
    dir: repoDirectory,
    ref: `refs/heads/${branch}`,
    value: oid,
    force: true,
  });
  await git.checkout({ fs, dir: repoDirectory, ref: branch, force: true });
}

/** Clones `application`'s git repository if absent, otherwise fetches and hard-resets to the remote tip. */
export async function ensureLocalRepository(
  settings: PiploySettings,
  application: Application,
  logger: Logger,
): Promise<void> {
  const log = logger.child({
    operation: "ensureLocalRepository",
    gitRepository: application.GitRepositoryUrl,
  });
  const repoDirectory = getApplicationRepoDirectory(settings, application);
  fs.mkdirSync(repoDirectory, { recursive: true });

  if (hasGitDirectory(repoDirectory)) {
    log.info("Local exists. Fetching origin");
    const branch = await resolveBranch(repoDirectory);
    await git.fetch({ fs, http, dir: repoDirectory, remote: "origin" });

    const localOid = await git.resolveRef({
      fs,
      dir: repoDirectory,
      ref: "HEAD",
    });
    const remoteOid = await git.resolveRef({
      fs,
      dir: repoDirectory,
      ref: `refs/remotes/origin/${branch}`,
    });

    if (localOid !== remoteOid) {
      log.info(
        `Latest remote origin/${branch} ${remoteOid} is ahead of local. Resetting local to match`,
      );
      await resetHard(repoDirectory, branch, remoteOid);
    } else {
      log.info("Local is up-to-date with remote already");
    }
  } else {
    log.info("Cloning into remote");
    await git.clone({
      fs,
      http,
      dir: repoDirectory,
      url: application.GitRepositoryUrl,
    });
  }
}

/** Reads the commit at the local HEAD of `application`'s cloned repository. */
export async function getLatestCommit(
  settings: PiploySettings,
  application: Application,
): Promise<GitCommit> {
  const repoDirectory = getApplicationRepoDirectory(settings, application);
  const oid = await git.resolveRef({ fs, dir: repoDirectory, ref: "HEAD" });
  return readGitCommit(repoDirectory, oid);
}

/**
 * Fetches and compares the local HEAD against the remote tracking branch.
 * Returns `null` if the repository has not been cloned yet.
 */
export async function getCommitStatus(
  settings: PiploySettings,
  application: Application,
): Promise<GitCommitStatus | null> {
  const repoDirectory = getApplicationRepoDirectory(settings, application);
  if (!hasGitDirectory(repoDirectory)) {
    return null;
  }

  const branch = await resolveBranch(repoDirectory);
  await git.fetch({ fs, http, dir: repoDirectory, remote: "origin" });

  const localOid = await git.resolveRef({
    fs,
    dir: repoDirectory,
    ref: "HEAD",
  });
  const remoteOid = await git.resolveRef({
    fs,
    dir: repoDirectory,
    ref: `refs/remotes/origin/${branch}`,
  });

  const [local, remote] = await Promise.all([
    readGitCommit(repoDirectory, localOid),
    readGitCommit(repoDirectory, remoteOid),
  ]);

  return { local, remote };
}
