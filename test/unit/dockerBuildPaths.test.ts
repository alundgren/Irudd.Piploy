import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { resolveDockerBuildPaths } from "../../src/docker.js";
import type { Application } from "../../src/settings.js";

const directories: string[] = [];

async function repository(): Promise<string> {
  const directory = await mkdtemp(
    path.join(os.tmpdir(), "piploy-build-paths-"),
  );
  directories.push(directory);
  return directory;
}

function application(
  DockerfilePath: string,
  BuildContextPath?: string,
): Application {
  return {
    Name: "app",
    GitRepositoryUrl: "https://example.test/app.git",
    DockerfilePath,
    ...(BuildContextPath === undefined ? {} : { BuildContextPath }),
  };
}

afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("resolveDockerBuildPaths", () => {
  it("keeps the legacy Dockerfile-parent context when BuildContextPath is absent", () => {
    const repo = "/checkout";
    expect(() =>
      resolveDockerBuildPaths(repo, application(" /Dockerfile.custom ")),
    ).toThrow(
      "Dockerfile ' /Dockerfile.custom ' does not exist. Expected location: '/checkout/Dockerfile.custom'",
    );
  });

  it("preserves the legacy Dockerfile-parent context when the Dockerfile exists", async () => {
    const repo = await repository();
    await writeFile(path.join(repo, "Dockerfile.custom"), "FROM scratch\n");

    expect(
      resolveDockerBuildPaths(repo, application(" /Dockerfile.custom ")),
    ).toEqual({
      contextDirectory: repo,
      dockerfilePath: "Dockerfile.custom",
      absoluteDockerfilePath: path.join(repo, "Dockerfile.custom"),
    });
  });

  it("uses the explicit root or nested context and a Dockerfile path relative to it", async () => {
    const repo = await repository();
    await mkdir(path.join(repo, "services", "api"), { recursive: true });
    await writeFile(path.join(repo, "Dockerfile"), "FROM scratch\n");
    await writeFile(
      path.join(repo, "services", "api", "Dockerfile"),
      "FROM scratch\n",
    );

    expect(
      resolveDockerBuildPaths(repo, application("Dockerfile", ".")),
    ).toMatchObject({
      contextDirectory: repo,
      dockerfilePath: "Dockerfile",
    });
    expect(
      resolveDockerBuildPaths(
        repo,
        application("services/api/Dockerfile", "services"),
      ),
    ).toMatchObject({
      contextDirectory: path.join(repo, "services"),
      dockerfilePath: "api/Dockerfile",
    });
  });

  it("rejects a Dockerfile outside the selected context", async () => {
    const repo = await repository();
    await mkdir(path.join(repo, "allowed"), { recursive: true });
    await writeFile(path.join(repo, "Dockerfile"), "FROM scratch\n");

    expect(() =>
      resolveDockerBuildPaths(repo, application("Dockerfile", "allowed")),
    ).toThrow("DockerfilePath must remain inside the repository build context");
  });

  it("rejects a selected context symlink that escapes the checkout", async () => {
    const repo = await repository();
    const outside = await repository();
    await writeFile(path.join(outside, "Dockerfile"), "FROM scratch\n");
    await symlink(outside, path.join(repo, "context"));

    expect(() =>
      resolveDockerBuildPaths(
        repo,
        application("context/Dockerfile", "context"),
      ),
    ).toThrow(
      "BuildContextPath must remain inside the repository build context",
    );
  });

  it("rejects a Dockerfile symlink that escapes the selected context", async () => {
    const repo = await repository();
    await mkdir(path.join(repo, "context"), { recursive: true });
    await writeFile(path.join(repo, "outside.Dockerfile"), "FROM scratch\n");
    await symlink(
      "../outside.Dockerfile",
      path.join(repo, "context", "Dockerfile"),
    );

    expect(() =>
      resolveDockerBuildPaths(
        repo,
        application("context/Dockerfile", "context"),
      ),
    ).toThrow("DockerfilePath must remain inside the repository build context");
  });
});
