import fs from "node:fs";
import path from "node:path";

import git from "isomorphic-git";
import http from "isomorphic-git/http/node";

import type { Logger } from "./logger.js";
import {
  getApplicationRepoDirectory,
  parseHostEnvironmentReference,
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

export type GitFailureReason =
  | "credential-not-configured"
  | "credential-environment-missing"
  | "credential-rejected"
  | "repository-inaccessible-or-not-found"
  | "transport-or-fetch-failure";

export interface GitDiagnostic {
  reason: GitFailureReason;
  message: string;
}

export class GitOperationError extends Error {
  constructor(readonly diagnostic: GitDiagnostic) {
    super(diagnostic.message);
    this.name = "GitOperationError";
  }
}

class AuthenticationStoppedError extends Error {
  constructor(readonly diagnostic: GitDiagnostic) {
    super(diagnostic.message);
    this.name = "AuthenticationStoppedError";
  }
}

function diagnosticFor(
  reason: GitFailureReason,
  details: { environmentName?: string; owner?: string } = {},
): GitDiagnostic {
  switch (reason) {
    case "credential-not-configured":
      return {
        reason,
        message:
          details.owner === undefined
            ? "No credential is configured for this GitHub owner."
            : `No credential is configured for GitHub owner '${details.owner}'.`,
      };
    case "credential-environment-missing":
      return {
        reason,
        message: `Host environment variable '${details.environmentName}' is not set. Restart Piploy after setting it.`,
      };
    case "credential-rejected":
      return {
        reason,
        message:
          details.owner === undefined
            ? "GitHub rejected the configured credential."
            : `GitHub rejected the credential configured for owner '${details.owner}'.`,
      };
    case "repository-inaccessible-or-not-found":
      return { reason, message: "Repository not found or inaccessible." };
    case "transport-or-fetch-failure":
      return { reason, message: "Git fetch failed." };
  }
}

/** Returns the GitHub owner only for the HTTPS URL shape eligible for credentials. */
export function credentialOwnerFromUrl(url: string): string | undefined {
  // WHATWG URL drops an explicit default port, so the raw input must also be
  // checked to keep this scope to exactly https://github.com.
  if (!url.startsWith("https://github.com/")) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.host !== "github.com" ||
    parsed.username !== "" ||
    parsed.password !== ""
  ) {
    return undefined;
  }
  if (parsed.search !== "" || parsed.hash !== "") return undefined;
  const match = /^\/([^/]+)\/([^/]+)(?:\/.*)?$/.exec(parsed.pathname);
  return match?.[1];
}

function httpStatus(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const candidate = error as {
    statusCode?: unknown;
    data?: { statusCode?: unknown };
  };
  return typeof candidate.statusCode === "number"
    ? candidate.statusCode
    : typeof candidate.data?.statusCode === "number"
      ? candidate.data.statusCode
      : undefined;
}

type RemoteAuthOptions = Pick<
  Parameters<typeof git.clone>[0],
  "onAuth" | "onAuthFailure"
>;

/** Creates callbacks and safe error handling for one HTTPS remote operation. */
function createGitRemoteAuthentication(settings: PiploySettings): {
  callbacks: RemoteAuthOptions;
  errorFor(error: unknown): GitOperationError;
} {
  let stopped: AuthenticationStoppedError | undefined;
  let suppliedCredential = false;
  let credentialOwner: string | undefined;

  const stop = (
    reason: GitFailureReason,
    details: { environmentName?: string; owner?: string } = {},
  ) => {
    stopped = new AuthenticationStoppedError(diagnosticFor(reason, details));
    return { cancel: true };
  };

  return {
    callbacks: {
      onAuth: (url) => {
        const owner = credentialOwnerFromUrl(url);
        const credentials = settings.GitHubOwnerCredentials;
        const reference =
          owner !== undefined &&
          credentials !== undefined &&
          Object.hasOwn(credentials, owner)
            ? credentials[owner]
            : undefined;
        if (reference === undefined) {
          return stop("credential-not-configured", { owner });
        }

        const environmentName = parseHostEnvironmentReference(reference);
        if (environmentName === undefined) {
          return stop("credential-not-configured", { owner });
        }
        const token = process.env[environmentName];
        if (token === undefined) {
          return stop("credential-environment-missing", { environmentName });
        }
        suppliedCredential = true;
        credentialOwner = owner;
        return { username: "x-access-token", password: token };
      },
      onAuthFailure: () => {
        if (suppliedCredential) {
          return stop("credential-rejected", { owner: credentialOwner });
        }
        return stop("credential-not-configured");
      },
    },
    errorFor(error) {
      const status = httpStatus(error);
      if (status === 404) {
        return new GitOperationError(
          diagnosticFor("repository-inaccessible-or-not-found"),
        );
      }
      if (stopped !== undefined)
        return new GitOperationError(stopped.diagnostic);
      if ((status === 401 || status === 403) && suppliedCredential) {
        return new GitOperationError(
          diagnosticFor("credential-rejected", { owner: credentialOwner }),
        );
      }
      return new GitOperationError(diagnosticFor("transport-or-fetch-failure"));
    },
  };
}

/** Runs one HTTPS remote operation without retaining a resolved credential. */
async function runRemoteOperation<T>(
  settings: PiploySettings,
  invoke: (authentication: RemoteAuthOptions) => Promise<T>,
): Promise<T> {
  const authentication = createGitRemoteAuthentication(settings);
  try {
    return await invoke(authentication.callbacks);
  } catch (error) {
    throw authentication.errorFor(error);
  }
}

type GitHttp = Parameters<typeof git.clone>[0]["http"];

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
    // committer.timestamp is a UTC epoch timestamp. The timezone offset is
    // not needed to represent this instant and has the opposite ISO 8601 sign.
    date: new Date(commit.committer.timestamp * 1000),
    message: commit.message.trimEnd(),
  };
}

/**
 * Composes `git reset --hard <oid>` from `writeRef` and `checkout`. Keeping
 * the composition private makes the reset atomic from callers' perspective;
 * integration tests cover the resulting worktree and index state.
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

async function fetchOrigin(
  settings: PiploySettings,
  repoDirectory: string,
  gitHttp: GitHttp,
): Promise<void> {
  await runRemoteOperation(settings, (authentication) =>
    git.fetch({
      fs,
      http: gitHttp,
      dir: repoDirectory,
      remote: "origin",
      ...authentication,
    }),
  );
}

/** Clones `application`'s git repository if absent, otherwise fetches and hard-resets to the remote tip. */
export async function ensureLocalRepository(
  settings: PiploySettings,
  application: Application,
  logger: Logger,
  gitHttp: GitHttp = http,
): Promise<void> {
  const log = logger.child({ operation: "ensureLocalRepository" });
  const repoDirectory = getApplicationRepoDirectory(settings, application);
  fs.mkdirSync(repoDirectory, { recursive: true });

  if (hasGitDirectory(repoDirectory)) {
    log.info("Local exists. Fetching origin");
    const branch = await resolveBranch(repoDirectory);
    await fetchOrigin(settings, repoDirectory, gitHttp);

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
    await runRemoteOperation(settings, (authentication) =>
      git.clone({
        fs,
        http: gitHttp,
        dir: repoDirectory,
        url: application.GitRepositoryUrl,
        ...authentication,
      }),
    );
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
  gitHttp: GitHttp = http,
): Promise<GitCommitStatus | null> {
  const repoDirectory = getApplicationRepoDirectory(settings, application);
  if (!hasGitDirectory(repoDirectory)) {
    return null;
  }

  const branch = await resolveBranch(repoDirectory);
  await fetchOrigin(settings, repoDirectory, gitHttp);

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
