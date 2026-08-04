import { describe, expect, it, vi } from "vitest";

import {
  createOrchestrator,
  type OrchestratorDeps,
} from "../../src/orchestrator.js";
import type { Logger } from "../../src/logger.js";
import type { Application, PiploySettings } from "../../src/settings.js";

const applications: Application[] = [
  {
    Name: "first",
    GitRepositoryUrl: "https://example.test/first.git",
    DockerfilePath: "Dockerfile",
  },
  {
    Name: "second",
    GitRepositoryUrl: "https://example.test/second.git",
    DockerfilePath: "Dockerfile",
  },
];

const settings: PiploySettings = {
  RootDirectory: "/tmp/piploy",
  Applications: applications,
};

function createLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

function createDeps(): OrchestratorDeps {
  return {
    ensureLocalRepository: vi.fn(),
    getLatestCommit: vi.fn(async () => ({ hash: "abc123" })),
    ensureImageExists: vi.fn(),
    ensureContainerRunning: vi.fn(),
    cleanupInactive: vi.fn(),
  };
}

describe("orchestrator", () => {
  it("reconciles each application in order, then cleans up inactive images", async () => {
    const calls: string[] = [];
    const deps = createDeps();
    deps.ensureLocalRepository = vi.fn(async (application) => {
      calls.push(`repository:${application.Name}`);
    });
    deps.getLatestCommit = vi.fn(async (application) => {
      calls.push(`commit:${application.Name}`);
      return { hash: application.Name };
    });
    deps.ensureImageExists = vi.fn(async (application, commit) => {
      calls.push(`image:${application.Name}:${commit.hash}`);
    });
    deps.ensureContainerRunning = vi.fn(async (application, commit) => {
      calls.push(`container:${application.Name}:${commit.hash}`);
    });
    deps.cleanupInactive = vi.fn(
      async (configuredApplications: Application[]) => {
        calls.push(
          `cleanup:${configuredApplications.map(({ Name }) => Name).join(",")}`,
        );
      },
    );

    await createOrchestrator(settings, createLogger(), deps).poll();

    expect(calls).toEqual([
      "repository:first",
      "commit:first",
      "image:first:first",
      "container:first:first",
      "repository:second",
      "commit:second",
      "image:second:second",
      "container:second:second",
      "cleanup:first,second",
    ]);
  });

  it("isolates an application failure and continues to the next application", async () => {
    const deps = createDeps();
    const errors: string[] = [];
    const logger = createLogger();
    logger.error = (message) => errors.push(message);
    deps.ensureImageExists = vi.fn(async (application) => {
      if (application.Name === "first") throw new Error("build failed");
    });

    await createOrchestrator(settings, logger, deps).poll();

    expect(deps.ensureContainerRunning).toHaveBeenCalledTimes(1);
    expect(deps.ensureContainerRunning).toHaveBeenCalledWith(applications[1], {
      hash: "abc123",
    });
    expect(deps.cleanupInactive).toHaveBeenCalledWith(applications);
    expect(errors).toEqual(["build failed"]);
  });
});
