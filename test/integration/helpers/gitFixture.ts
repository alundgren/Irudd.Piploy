import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { Git as GitServer } from "node-git-server";

const gitEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "piploy-test",
  GIT_AUTHOR_EMAIL: "test@example.com",
  GIT_COMMITTER_NAME: "piploy-test",
  GIT_COMMITTER_EMAIL: "test@example.com",
};

function runGit(cwd: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd,
    env: gitEnv,
    stdio: ["ignore", "pipe", "ignore"],
  })
    .toString()
    .trim();
}

export interface GitFixtureRemote {
  /** The clone URL of the served fixture repository. */
  url: string;
  /** Writes `files`, commits, and pushes to the served remote. Returns the new commit hash. */
  commit(files: Record<string, string>, message?: string): string;
  close(): Promise<void>;
}

/**
 * Serves a real git repository over local smart HTTP (git-upload-pack/git-receive-pack),
 * matching isomorphic-git's own test suite approach — isomorphic-git speaks HTTP(S) only
 * (docs/research/ts-git-library.md), so a plain local-directory remote can't be cloned.
 */
export async function startGitFixtureRemote(): Promise<GitFixtureRemote> {
  const root = mkdtempSync(path.join(os.tmpdir(), "piploy-git-fixture-"));
  const reposDirectory = path.join(root, "repos");
  const workDirectory = path.join(root, "work");
  mkdirSync(reposDirectory, { recursive: true });
  mkdirSync(workDirectory, { recursive: true });

  runGit(root, [
    "init",
    "--bare",
    "-b",
    "main",
    path.join(reposDirectory, "repo.git"),
  ]);
  runGit(workDirectory, ["init", "-b", "main"]);
  runGit(workDirectory, [
    "remote",
    "add",
    "origin",
    path.join(reposDirectory, "repo.git"),
  ]);

  const server = new GitServer(reposDirectory, { autoCreate: false });
  await new Promise<void>((resolve) => {
    server.listen(0, undefined, () => resolve());
  });

  const address = server.server?.address();
  if (
    address === null ||
    address === undefined ||
    typeof address === "string"
  ) {
    throw new Error("Expected the git fixture server to bind to a TCP port");
  }
  const url = `http://127.0.0.1:${address.port}/repo.git`;

  function commit(
    files: Record<string, string>,
    message = "test commit",
  ): string {
    for (const [name, content] of Object.entries(files)) {
      writeFileSync(path.join(workDirectory, name), content);
    }
    runGit(workDirectory, ["add", "-A"]);
    runGit(workDirectory, ["commit", "-m", message, "--allow-empty"]);
    runGit(workDirectory, ["push", "origin", "main"]);
    return runGit(workDirectory, ["rev-parse", "HEAD"]);
  }

  async function close(): Promise<void> {
    await server.close();
    rmSync(root, { recursive: true, force: true });
  }

  return { url, commit, close };
}
