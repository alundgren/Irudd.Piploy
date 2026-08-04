import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
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

    it("is a no-op when the local repo is already up to date", async () => {
      remote.commit({ "index.html": "v1" }, "initial");
      await ensureLocalRepository(settings, application, logger);

      await expect(
        ensureLocalRepository(settings, application, logger),
      ).resolves.toBeUndefined();
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
