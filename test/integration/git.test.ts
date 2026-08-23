import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

import gitHttp from "isomorphic-git/http/node";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  credentialOwnerFromUrl,
  ensureLocalRepository,
  getCommitStatus,
  getLatestCommit,
} from "../../src/git.js";
import {
  getApplicationRepoDirectory,
  getApplicationRootDirectory,
} from "../../src/settings.js";
import type { Application, PiploySettings } from "../../src/settings.js";
import { startGitFixtureRemote } from "./helpers/gitFixture.js";
import type { GitFixtureRemote } from "./helpers/gitFixture.js";
import { createSilentLogger } from "./helpers/testLogger.js";

const githubOwner = "alundgren";
const tokenEnvironmentName = "PIPLOY_GITHUB_TOKEN";
const sentinelToken = "sentinel-github-token";

function githubFixtureHttp(remote: GitFixtureRemote) {
  return {
    request(request: Parameters<typeof gitHttp.request>[0]) {
      const source = new URL(request.url);
      const fixturePath = source.pathname.replace(`/${githubOwner}`, "");
      return gitHttp.request({
        ...request,
        url: `${remote.baseUrl}${fixturePath}${source.search}`,
      });
    },
  };
}

describe("git", () => {
  const logger = createSilentLogger();
  let remote: GitFixtureRemote;
  let rootDirectory: string;
  let settings: PiploySettings;
  let application: Application;

  beforeEach(async () => {
    remote = await startGitFixtureRemote();
    rootDirectory = mkdtempSync(path.join(os.tmpdir(), "piploy-git-test-"));
    application = {
      Name: "app1",
      GitRepositoryUrl: remote.url,
      DockerfilePath: "Dockerfile",
    };
    settings = { RootDirectory: rootDirectory, Applications: [application] };
  });

  afterEach(async () => {
    await remote.close();
    rmSync(rootDirectory, { recursive: true, force: true });
  });

  describe("credential URL policy", () => {
    it("accepts only an exact GitHub HTTPS owner repository URL", () => {
      expect(
        credentialOwnerFromUrl("https://github.com/alundgren/repository.git"),
      ).toBe("alundgren");
    });

    it.each([
      "http://github.com/alundgren/repository.git",
      "https://github.com:443/alundgren/repository.git",
      "https://github.com./alundgren/repository.git",
      "https://github.com.evil.test/alundgren/repository.git",
      "https://token@github.com/alundgren/repository.git",
      "https://github.com/alundgren",
      "https://github.com/alundgren/repository.git?token=secret",
    ])("rejects a credential URL outside the exact scope: %s", (url) => {
      expect(credentialOwnerFromUrl(url)).toBeUndefined();
    });
  });

  describe("ensureLocalRepository", () => {
    it("creates the application root and repo directories", async () => {
      remote.commit({ "index.html": "v1" }, "initial");

      await ensureLocalRepository(settings, application, logger);

      expect(
        existsSync(getApplicationRootDirectory(settings, application)),
      ).toBe(true);
      expect(
        existsSync(getApplicationRepoDirectory(settings, application)),
      ).toBe(true);
    });

    it("clones the remote when the repo directory is empty", async () => {
      remote.commit({ "index.html": "v1" }, "initial");

      await ensureLocalRepository(settings, application, logger);

      const filePath = path.join(
        getApplicationRepoDirectory(settings, application),
        "index.html",
      );
      expect(readFileSync(filePath, "utf8")).toBe("v1");
    });

    it("moves the local repo forward when the remote has changed", async () => {
      remote.commit({ "index.html": "v1" }, "initial");
      await ensureLocalRepository(settings, application, logger);

      remote.commit({ "index.html": "v2" }, "second");
      await ensureLocalRepository(settings, application, logger);

      const filePath = path.join(
        getApplicationRepoDirectory(settings, application),
        "index.html",
      );
      expect(readFileSync(filePath, "utf8")).toBe("v2");
    });

    it("resets staged and unstaged local changes when moving forward", async () => {
      remote.commit({ "index.html": "v1" }, "initial");
      await ensureLocalRepository(settings, application, logger);

      const repoDirectory = getApplicationRepoDirectory(settings, application);
      writeFileSync(path.join(repoDirectory, "index.html"), "local change");
      execFileSync("git", ["add", "index.html"], { cwd: repoDirectory });
      writeFileSync(path.join(repoDirectory, "index.html"), "unstaged change");

      remote.commit({ "index.html": "v2" }, "second");
      await ensureLocalRepository(settings, application, logger);

      expect(readFileSync(path.join(repoDirectory, "index.html"), "utf8")).toBe(
        "v2",
      );
      expect(() =>
        execFileSync("git", ["diff", "--quiet"], { cwd: repoDirectory }),
      ).not.toThrow();
      expect(() =>
        execFileSync("git", ["diff", "--cached", "--quiet"], {
          cwd: repoDirectory,
        }),
      ).not.toThrow();
    });

    it("is a no-op when the local repo is already up to date", async () => {
      remote.commit({ "index.html": "v1" }, "initial");
      await ensureLocalRepository(settings, application, logger);

      await expect(
        ensureLocalRepository(settings, application, logger),
      ).resolves.toBeUndefined();
    });

    it("normalizes a transport failure without retaining the adapter error", async () => {
      application.GitRepositoryUrl = "http://127.0.0.1:1/repository.git";

      await expect(
        ensureLocalRepository(settings, application, logger),
      ).rejects.toEqual(
        expect.objectContaining({
          name: "GitOperationError",
          diagnostic: {
            reason: "transport-or-fetch-failure",
            message: "Git fetch failed.",
          },
        }),
      );
    });

    it("authenticates clone and poll fetch through the GitHub callback without persisting a token", async () => {
      const authenticatedRemote = await startGitFixtureRemote({
        credentials: { username: "x-access-token", password: sentinelToken },
      });
      const originalToken = process.env[tokenEnvironmentName];
      const messages: string[] = [];
      const logging = {
        debug: (message: string) => messages.push(message),
        info: (message: string) => messages.push(message),
        warn: (message: string) => messages.push(message),
        error: (message: string) => messages.push(message),
        child: () => logging,
      };
      try {
        process.env[tokenEnvironmentName] = sentinelToken;
        const authenticatedApplication: Application = {
          Name: "authenticated",
          GitRepositoryUrl: `https://github.com/${githubOwner}/repo.git`,
          DockerfilePath: "Dockerfile",
        };
        const authenticatedSettings: PiploySettings = {
          RootDirectory: rootDirectory,
          Applications: [authenticatedApplication],
          GitHubOwnerCredentials: {
            [githubOwner]: `\${hostEnv:${tokenEnvironmentName}}`,
          },
        };
        const http = githubFixtureHttp(authenticatedRemote);
        const initialHash = authenticatedRemote.commit(
          { "index.html": "v1" },
          "initial",
        );

        await ensureLocalRepository(
          authenticatedSettings,
          authenticatedApplication,
          logging,
          http,
        );
        const nextHash = authenticatedRemote.commit(
          { "index.html": "v2" },
          "next",
        );
        await ensureLocalRepository(
          authenticatedSettings,
          authenticatedApplication,
          logging,
          http,
        );
        const status = await getCommitStatus(
          authenticatedSettings,
          authenticatedApplication,
          http,
        );

        expect(initialHash).not.toBe(nextHash);
        expect(status?.remote.hash).toBe(nextHash);
        expect(
          authenticatedRemote.authenticatedRequests(),
        ).toBeGreaterThanOrEqual(3);
        expect(
          readFileSync(
            path.join(
              getApplicationRepoDirectory(
                authenticatedSettings,
                authenticatedApplication,
              ),
              ".git",
              "config",
            ),
            "utf8",
          ),
        ).not.toContain(sentinelToken);
        expect(JSON.stringify(authenticatedSettings)).not.toContain(
          sentinelToken,
        );
        expect(JSON.stringify(status)).not.toContain(sentinelToken);
        expect(messages.join("\n")).not.toContain(sentinelToken);
      } finally {
        if (originalToken === undefined)
          delete process.env[tokenEnvironmentName];
        else process.env[tokenEnvironmentName] = originalToken;
        await authenticatedRemote.close();
      }
    });

    it("normalizes missing, rejected, and ambiguous GitHub credential failures through real clone requests", async () => {
      const authenticatedRemote = await startGitFixtureRemote({
        credentials: { username: "x-access-token", password: sentinelToken },
      });
      const originalToken = process.env[tokenEnvironmentName];
      const failedApplication: Application = {
        Name: "failed-authentication",
        GitRepositoryUrl: `https://github.com/${githubOwner}/repo.git`,
        DockerfilePath: "Dockerfile",
      };
      const failedSettings: PiploySettings = {
        RootDirectory: rootDirectory,
        Applications: [failedApplication],
        GitHubOwnerCredentials: {
          [githubOwner]: `\${hostEnv:${tokenEnvironmentName}}`,
        },
      };
      const http = githubFixtureHttp(authenticatedRemote);
      authenticatedRemote.commit({ "index.html": "v1" }, "initial");
      try {
        delete process.env[tokenEnvironmentName];
        await expect(
          ensureLocalRepository(
            failedSettings,
            failedApplication,
            logger,
            http,
          ),
        ).rejects.toMatchObject({
          diagnostic: {
            reason: "credential-environment-missing",
            message: `Host environment variable '${tokenEnvironmentName}' is not set. Restart Piploy after setting it.`,
          },
        });

        process.env[tokenEnvironmentName] = "wrong-token";
        await expect(
          ensureLocalRepository(
            failedSettings,
            failedApplication,
            logger,
            http,
          ),
        ).rejects.toMatchObject({
          diagnostic: {
            reason: "credential-rejected",
            message:
              "GitHub rejected the credential configured for owner 'alundgren'.",
          },
        });

        process.env[tokenEnvironmentName] = sentinelToken;
        const missingApplication = {
          ...failedApplication,
          Name: "missing",
          GitRepositoryUrl: `https://github.com/${githubOwner}/missing.git`,
        };
        await expect(
          ensureLocalRepository(
            { ...failedSettings, Applications: [missingApplication] },
            missingApplication,
            logger,
            http,
          ),
        ).rejects.toMatchObject({
          diagnostic: {
            reason: "repository-inaccessible-or-not-found",
            message: "Repository not found or inaccessible.",
          },
        });
      } finally {
        if (originalToken === undefined)
          delete process.env[tokenEnvironmentName];
        else process.env[tokenEnvironmentName] = originalToken;
        await authenticatedRemote.close();
      }
    });
  });

  describe("getLatestCommit", () => {
    it("reads the hash, date and message of the local HEAD", async () => {
      const hash = remote.commit({ "index.html": "v1" }, "initial commit");
      await ensureLocalRepository(settings, application, logger);

      const commit = await getLatestCommit(settings, application);

      expect(commit.hash).toBe(hash);
      expect(commit.message).toBe("initial commit");
      expect(commit.date).toBeInstanceOf(Date);
    });
  });

  describe("getCommitStatus", () => {
    it("returns null when the repo has not been cloned yet", async () => {
      remote.commit({ "index.html": "v1" }, "initial");

      const status = await getCommitStatus(settings, application);

      expect(status).toBeNull();
    });

    it("reports matching local and remote commits when up to date", async () => {
      const hash = remote.commit({ "index.html": "v1" }, "initial");
      await ensureLocalRepository(settings, application, logger);

      const status = await getCommitStatus(settings, application);

      expect(status?.local.hash).toBe(hash);
      expect(status?.remote.hash).toBe(hash);
    });

    it("reports a diverged remote without moving the local repo", async () => {
      remote.commit({ "index.html": "v1" }, "initial");
      await ensureLocalRepository(settings, application, logger);
      const localCommit = await getLatestCommit(settings, application);
      const remoteHash = remote.commit({ "index.html": "v2" }, "second");

      const status = await getCommitStatus(settings, application);

      expect(status?.local.hash).toBe(localCommit.hash);
      expect(status?.remote.hash).toBe(remoteHash);
      expect(status?.local.hash).not.toBe(status?.remote.hash);
    });
  });
});
