import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { createDockerService } from "../../src/docker.js";
import type { Logger } from "../../src/logger.js";
import type { PiploySettings } from "../../src/settings.js";

const logger: Logger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "piploy-docker-"),
);
const applicationName = `integration${crypto.randomUUID().replaceAll("-", "")}`;
const commit = { hash: crypto.randomUUID().replaceAll("-", "") };
const application = {
  Name: applicationName,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
};
const settings: PiploySettings = {
  RootDirectory: path.join(temporaryDirectory, "root"),
  Applications: [application],
  IsTestRun: true,
};
const docker = createDockerService(settings, logger);

afterAll(async () => {
  await docker.cleanupTestCreated();
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("docker adapter", () => {
  it("builds, runs, reports, and cleans up a marked container", async () => {
    const repoDirectory = path.join(
      settings.RootDirectory,
      application.Name,
      "repo",
    );
    await mkdir(repoDirectory, { recursive: true });
    await writeFile(
      path.join(repoDirectory, "Dockerfile"),
      'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nCMD ["sh", "-c", "while true; do sleep 3600; done"]\n',
    );

    const built = await docker.ensureImageExists(application, commit);
    expect(built.wasCreated).toBe(true);
    expect(built.imageId).toMatch(/^sha256:/);
    expect(await docker.ensureImageExists(application, commit)).toEqual({
      wasCreated: false,
      imageId: built.imageId,
    });

    const started = await docker.ensureContainerRunning(application, commit);
    expect(started).toMatchObject({ wasCreated: true, wasStarted: true });
    expect(await docker.ensureContainerRunning(application, commit)).toEqual({
      wasCreated: false,
      wasStarted: false,
      containerId: started.containerId,
    });
    expect(await docker.getDockerStatus(application)).toEqual({
      latestImageHash: commit.hash,
      runningContainerHash: commit.hash,
    });

    await docker.cleanupTestCreated();
    expect(await docker.getDockerStatus(application)).toEqual({});
  });
});
