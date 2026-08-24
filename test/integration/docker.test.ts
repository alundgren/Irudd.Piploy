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

const loggedMessages: string[] = [];
const logger: Logger = {
  debug: () => {},
  info: (message) => loggedMessages.push(message),
  warn: () => {},
  error: () => {},
  child: () => logger,
};

const temporaryDirectory = await mkdtemp(
  path.join(os.tmpdir(), "piploy-docker-"),
);
const originalConfigPath = process.env.PIPLOY_CONFIG;
process.env.PIPLOY_CONFIG = path.join(temporaryDirectory, "piploy.json");
const hostEnvironmentName = `PIPLOY_HOST_ENV_${crypto.randomUUID().replaceAll("-", "")}`;
const hostEnvironmentSecret = "test-host-environment-secret";
const originalHostEnvironmentValue = process.env[hostEnvironmentName];
process.env[hostEnvironmentName] = hostEnvironmentSecret;
const hostEnvironmentReference = `\${hostEnv:${hostEnvironmentName}}`;
const applicationName = `integration${crypto.randomUUID().replaceAll("-", "")}`;
const commit = { hash: crypto.randomUUID().replaceAll("-", "") };
const application = {
  Name: applicationName,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
  Volumes: [{ name: "sqlite", containerPath: "/app/data" }],
  EnvironmentVariables: {
    DATABASE_PATH: "/app/data/app.db",
    HOST_ENV_TOKEN: hostEnvironmentReference,
  },
};
const crashingCommit = { hash: crypto.randomUUID().replaceAll("-", "") };
const crashingApplication = {
  Name: `${applicationName}crash`,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
};
const contextApplication = {
  Name: `${applicationName}context`,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "context/Dockerfile",
  BuildContextPath: "context",
};
const dockerIgnoreApplication = {
  Name: `${applicationName}dockerignore`,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
};
const raceApplication = {
  Name: `${applicationName}race`,
  GitRepositoryUrl: "https://example.invalid/integration.git",
  DockerfilePath: "Dockerfile",
};
const settings: PiploySettings = {
  RootDirectory: path.join(temporaryDirectory, "root"),
  Applications: [
    application,
    crashingApplication,
    contextApplication,
    dockerIgnoreApplication,
    raceApplication,
  ],
  IsTestRun: true,
};
const docker = createDockerService(settings, logger);

afterAll(async () => {
  await docker.cleanupTestCreated();
  await rm(temporaryDirectory, { recursive: true, force: true });
  if (originalConfigPath === undefined) delete process.env.PIPLOY_CONFIG;
  else process.env.PIPLOY_CONFIG = originalConfigPath;
  if (originalHostEnvironmentValue === undefined) {
    delete process.env[hostEnvironmentName];
  } else {
    process.env[hostEnvironmentName] = originalHostEnvironmentValue;
  }
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
    expect(inspect.Config.Env).toContain(
      `HOST_ENV_TOKEN=${hostEnvironmentSecret}`,
    );
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
        environmentVariables: [
          "DATABASE_PATH=/app/data/app.db",
          `HOST_ENV_TOKEN=${hostEnvironmentReference}`,
        ],
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
    expect(loggedMessages.join("\n")).not.toContain(hostEnvironmentSecret);
    expect(await docker.getDockerStatus(application)).toEqual({
      latestImageHash: commit.hash,
      runningContainerHash: commit.hash,
      container: { state: "running", exitCode: undefined, restartCount: 0 },
    });

    const logs = await docker.getContainerLogs(application, 10);
    expect(logs?.containerState).toBe("running");
    expect(logs?.text).toContain("hello-from-piploy");
    expect(logs?.truncated).toBe(false);

    // Reuse and start make no host-environment read, while a failed recreate
    // checks before removing the current container.
    delete process.env[hostEnvironmentName];
    expect(await docker.ensureContainerRunning(application, commit)).toEqual({
      wasCreated: false,
      wasStarted: false,
      containerId: started.containerId,
    });
    await new Dockerode().getContainer(started.containerId).stop();
    expect(await docker.ensureContainerRunning(application, commit)).toEqual({
      wasCreated: false,
      wasStarted: true,
      containerId: started.containerId,
    });
    await expect(
      docker.ensureContainerRunning(application, {
        hash: crypto.randomUUID().replaceAll("-", ""),
      }),
    ).rejects.toThrow(
      `Host environment variable '${hostEnvironmentName}' is not set`,
    );
    const afterFailedRecreation = await new Dockerode()
      .getContainer(started.containerId)
      .inspect();
    expect(afterFailedRecreation.Id).toBe(started.containerId);
    expect(loggedMessages.join("\n")).not.toContain(hostEnvironmentSecret);
    expect(
      JSON.stringify(await docker.getDockerStatus(application)),
    ).not.toContain(hostEnvironmentSecret);

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

  it("builds only from the selected context", async () => {
    const repoDirectory = path.join(
      settings.RootDirectory,
      contextApplication.Name,
      "repo",
    );
    const contextDirectory = path.join(repoDirectory, "context");
    await mkdir(contextDirectory, { recursive: true });
    await writeFile(path.join(contextDirectory, "inside.txt"), "inside\n");
    await writeFile(path.join(repoDirectory, "outside.txt"), "outside\n");
    const base =
      "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";

    await writeFile(
      path.join(contextDirectory, "Dockerfile"),
      `FROM ${base}\nCOPY inside.txt /inside.txt\n`,
    );
    await expect(
      docker.ensureImageExists(contextApplication, {
        hash: crypto.randomUUID().replaceAll("-", ""),
      }),
    ).resolves.toMatchObject({ wasCreated: true });

    for (const instruction of [
      "COPY ../outside.txt /outside.txt",
      "ADD ../outside.txt /outside.txt",
    ]) {
      await writeFile(
        path.join(contextDirectory, "Dockerfile"),
        `FROM ${base}\n${instruction}\n`,
      );
      await expect(
        docker.ensureImageExists(contextApplication, {
          hash: crypto.randomUUID().replaceAll("-", ""),
        }),
      ).rejects.toThrow();
    }

    await docker.cleanupTestCreated();
  });

  it("keeps re-included files in a dockerignore build context", async () => {
    const repoDirectory = path.join(
      settings.RootDirectory,
      dockerIgnoreApplication.Name,
      "repo",
    );
    await mkdir(path.join(repoDirectory, "src"), { recursive: true });
    await writeFile(
      path.join(repoDirectory, ".dockerignore"),
      "*\n!Dockerfile\n!src/\n!src/**\n",
    );
    await writeFile(path.join(repoDirectory, "src", "probe.txt"), "present\n");
    await writeFile(
      path.join(repoDirectory, "Dockerfile"),
      'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nCOPY src/probe.txt /probe.txt\nRUN test "$(cat /probe.txt)" = present\n',
    );

    await expect(
      docker.ensureImageExists(dockerIgnoreApplication, {
        hash: crypto.randomUUID().replaceAll("-", ""),
      }),
    ).resolves.toMatchObject({ wasCreated: true });

    await docker.cleanupTestCreated();
  });

  it("resolves a concurrent create race for the same version but not a mismatched one", async () => {
    const repoDirectory = path.join(
      settings.RootDirectory,
      raceApplication.Name,
      "repo",
    );
    await mkdir(repoDirectory, { recursive: true });
    await writeFile(
      path.join(repoDirectory, "Dockerfile"),
      'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nCMD ["sh", "-c", "while true; do sleep 3600; done"]\n',
    );

    const raceCommit = { hash: crypto.randomUUID().replaceAll("-", "") };
    await docker.ensureImageExists(raceApplication, raceCommit);

    // Two pollers racing to create the SAME version: the loser must detect
    // that the winner already created exactly the container it wanted, and
    // adopt it instead of failing.
    const sameVersionResults = await Promise.all([
      docker.ensureContainerRunning(raceApplication, raceCommit),
      docker.ensureContainerRunning(raceApplication, raceCommit),
    ]);
    expect(sameVersionResults[0].containerId).toBe(
      sameVersionResults[1].containerId,
    );
    expect(sameVersionResults.filter((r) => r.wasCreated)).toHaveLength(1);

    await docker.cleanupTestCreated();

    // Two pollers racing to create DIFFERENT versions: the loser must not
    // silently adopt the winner's container, since that would leave the
    // wrong version running while reporting success.
    const otherCommit = { hash: crypto.randomUUID().replaceAll("-", "") };
    await docker.ensureImageExists(raceApplication, raceCommit);
    await docker.ensureImageExists(raceApplication, otherCommit);

    const mismatchedResults = await Promise.allSettled([
      docker.ensureContainerRunning(raceApplication, raceCommit),
      docker.ensureContainerRunning(raceApplication, otherCommit),
    ]);
    expect(
      mismatchedResults.filter((r) => r.status === "fulfilled"),
    ).toHaveLength(1);
    const rejected = mismatchedResults.find((r) => r.status === "rejected");
    expect(rejected).toBeDefined();
    expect(String((rejected as PromiseRejectedResult).reason)).toContain(
      "already in use by container",
    );

    await docker.cleanupTestCreated();

    // Two pollers racing to upgrade the SAME existing container to the SAME
    // new version: both plan "recreate" against the same
    // existingContainerId, so one's remove() can hit the other's already
    // completed (or in-progress) removal. Neither should surface as a
    // failure, and both must land on the same replacement container.
    const upgradeFromCommit = { hash: crypto.randomUUID().replaceAll("-", "") };
    const upgradeToCommit = { hash: crypto.randomUUID().replaceAll("-", "") };
    await docker.ensureImageExists(raceApplication, upgradeFromCommit);
    await docker.ensureImageExists(raceApplication, upgradeToCommit);
    const upgradeFromResult = await docker.ensureContainerRunning(
      raceApplication,
      upgradeFromCommit,
    );
    expect(upgradeFromResult.wasCreated).toBe(true);

    const upgradeResults = await Promise.all([
      docker.ensureContainerRunning(raceApplication, upgradeToCommit),
      docker.ensureContainerRunning(raceApplication, upgradeToCommit),
    ]);
    expect(upgradeResults[0].containerId).toBe(upgradeResults[1].containerId);
    expect(upgradeResults[0].containerId).not.toBe(
      upgradeFromResult.containerId,
    );

    await docker.cleanupTestCreated();
  });
});
