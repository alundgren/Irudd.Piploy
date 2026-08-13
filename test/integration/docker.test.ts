import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import Dockerode from "dockerode";
import { afterAll, describe, expect, it, vi } from "vitest";

import { createDockerService } from "../../src/docker.js";
import { getContainerConfigHash } from "../../src/dockerPlan.js";
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
const originalConfigPath = process.env.PIPLOY_CONFIG;
process.env.PIPLOY_CONFIG = path.join(temporaryDirectory, "piploy.json");
const applicationName = `integration${crypto.randomUUID().replaceAll("-", "")}`;
const commit = { hash: crypto.randomUUID().replaceAll("-", "") };
const application = {
  Name: applicationName,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
  Volumes: [{ name: "sqlite", containerPath: "/app/data" }],
  EnvironmentVariables: { DATABASE_PATH: "/app/data/app.db" },
};
const crashingCommit = { hash: crypto.randomUUID().replaceAll("-", "") };
const crashingApplication = {
  Name: `${applicationName}crash`,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
};
const settings: PiploySettings = {
  RootDirectory: path.join(temporaryDirectory, "root"),
  Applications: [application, crashingApplication],
  IsTestRun: true,
};
const docker = createDockerService(settings, logger);

afterAll(async () => {
  await docker.cleanupTestCreated();
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env.PIPLOY_CONFIG;
  else process.env.PIPLOY_CONFIG = originalConfigPath;
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
      'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nCMD ["sh", "-c", "echo hello-from-piploy; while true; do sleep 3600; done"]\n',
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
    expect(
      existsSync(
        path.join(temporaryDirectory, "data", application.Name, "sqlite"),
      ),
    ).toBe(true);
    const inspect = await new Dockerode()
      .getContainer(started.containerId)
      .inspect();
    expect(inspect.Config.Env).toContain("DATABASE_PATH=/app/data/app.db");
    expect(inspect.HostConfig.Binds).toContain(
      `${path.join(temporaryDirectory, "data", application.Name, "sqlite")}:/app/data`,
    );
    expect(inspect.HostConfig.LogConfig).toEqual({
      Type: "json-file",
      Config: { "max-size": "10m", "max-file": "3" },
    });
    expect(inspect.HostConfig.AutoRemove).toBe(false);
    expect(inspect.HostConfig.RestartPolicy).toMatchObject({
      Name: "unless-stopped",
    });
    expect(inspect.Config.Labels?.piploy_configHash).toBe(
      getContainerConfigHash({
        environmentVariables: ["DATABASE_PATH=/app/data/app.db"],
        volumes: [
          `${path.join(temporaryDirectory, "data", application.Name, "sqlite")}:/app/data`,
        ],
      }),
    );
    expect(await docker.ensureContainerRunning(application, commit)).toEqual({
      wasCreated: false,
      wasStarted: false,
      containerId: started.containerId,
    });
    expect(await docker.getDockerStatus(application)).toMatchObject({
      latestImageHash: commit.hash,
      runningContainerHash: commit.hash,
      container: { state: "running", exitCode: undefined, restartCount: 0 },
    });

    const logs = await docker.getContainerLogs(application, 10);
    expect(logs?.containerState).toBe("running");
    expect(logs?.text).toContain("hello-from-piploy");
    expect(logs?.truncated).toBe(false);

    await docker.cleanupTestCreated();
    expect(await docker.getDockerStatus(application)).toEqual({});
    expect(await docker.getContainerLogs(application, 10)).toBeUndefined();
  });

  it("reports the exit code and logs of a container that crashes on boot", async () => {
    const repoDirectory = path.join(
      settings.RootDirectory,
      crashingApplication.Name,
      "repo",
    );
    await mkdir(repoDirectory, { recursive: true });
    await writeFile(
      path.join(repoDirectory, "Dockerfile"),
      'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nCMD ["sh", "-c", "echo crashing-on-boot >&2; exit 3"]\n',
    );

    await docker.ensureImageExists(crashingApplication, crashingCommit);
    await docker.ensureContainerRunning(crashingApplication, crashingCommit);

    // The restart policy keeps the container alive as a slot, so it is seen
    // either mid-restart or between attempts. Both carry the last exit code.
    const status = await vi.waitFor(async () => {
      const current = await docker.getDockerStatus(crashingApplication);
      expect(current.container?.exitCode).toBe(3);
      return current;
    });
    expect(status.runningContainerHash).toBeUndefined();
    expect(["restarting", "exited"]).toContain(status.container?.state);

    const logs = await docker.getContainerLogs(crashingApplication, 10);
    expect(logs?.text).toContain("crashing-on-boot");

    await docker.cleanupTestCreated();
  });
});
