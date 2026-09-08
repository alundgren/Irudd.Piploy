import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import Dockerode from "dockerode";
import { pack } from "tar-fs";
import { expect, vi } from "vitest";

import {
  createDockerService,
  type EnsureImageResult,
} from "../../../src/docker.js";
import { getBuildIdentity } from "../../../src/dockerPlan.js";
import { createOrchestrator } from "../../../src/orchestrator.js";
import type { Logger } from "../../../src/logger.js";
import type { Application, PiploySettings } from "../../../src/settings.js";

/** Exercises the same Poll contract against either real builder. */
export async function verifyBuildIdentity(
  settings: PiploySettings,
  logger: Logger,
): Promise<void> {
  const application: Application = {
    Name: `identity${crypto.randomUUID().replaceAll("-", "")}`,
    GitRepositoryUrl: "https://example.invalid/identity.git",
    DockerfilePath: "nested/One",
  };
  const configured = {
    ...settings,
    Applications: [...settings.Applications, application],
  };
  const service = createDockerService(configured, logger);
  const engine = new Dockerode();
  const commit = { hash: "a".repeat(40) };
  const repo = path.join(settings.RootDirectory, application.Name, "repo");
  await mkdir(path.join(repo, "nested"), { recursive: true });
  const base =
    "alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc";
  for (const [file, marker] of [
    ["One", "one"],
    ["Two", "two"],
  ]) {
    await writeFile(
      path.join(repo, "nested", file!),
      `FROM ${base}\nCOPY marker /marker\nCMD ["sh", "-c", "echo ${marker}; cat /marker; exec sleep 3600"]\n`,
    );
  }
  await writeFile(
    path.join(repo, "nested", "Broken"),
    `FROM ${base}\nCOPY missing /missing\n`,
  );
  await writeFile(path.join(repo, "nested", "marker"), "nested-output\n");
  await writeFile(path.join(repo, "marker"), "root-output\n");

  // A pre-upgrade image has only the old ownership metadata and commit tag.
  const commitTag = `piploy/${application.Name}:g_${commit.hash}`;
  const legacyStream = await engine.buildImage(
    pack(path.join(repo, "nested")),
    {
      dockerfile: "One",
      t: commitTag,
      labels: {
        piploy_appName: application.Name,
        piploy_gitTipCommit: commit.hash,
        piploy_isCreatedByTest: "true",
      },
    },
  );
  await new Promise<void>((resolve, reject) => {
    engine.modem.followProgress(legacyStream, (error) =>
      error ? reject(error) : resolve(),
    );
  });
  const legacy = await engine.getImage(commitTag).inspect();
  await engine
    .getImage(legacy.Id)
    .tag({ repo: `piploy/${application.Name}`, tag: "v_legacy" });
  let selected: EnsureImageResult | undefined;
  let running: string | undefined;
  const poll = async () => {
    const result = await createOrchestrator(
      { ...configured, Applications: [application] },
      logger,
      {
        ensureLocalRepository: async () => {},
        getLatestCommit: async () => commit,
        ensureImageExists: async (current, tip, signal) => {
          selected = await service.ensureImageExists(current, tip, signal);
          return selected;
        },
        ensureContainerRunning: async (current, tip, imageId) => {
          running = (
            await service.ensureContainerRunning(current, tip, imageId)
          ).containerId;
        },
        cleanupInactive: () => service.cleanupInactive(configured.Applications),
      },
    ).poll();
    return result;
  };
  const output = async (expected: string) => {
    await vi.waitFor(async () => {
      const logs = (await service.getContainerLogs(application, 10))?.text;
      for (const line of expected.split("\n")) {
        expect(logs).toContain(` ${line}\n`);
      }
    });
    expect((await engine.getContainer(running!).inspect()).Image).toBe(
      selected!.imageId,
    );
  };

  expect(await poll()).toEqual([{ application: application.Name, ok: true }]);
  expect(selected!.wasCreated).toBe(true);
  expect(selected!.imageId).not.toBe(legacy.Id);
  await output("one\nnested-output");
  const firstImage = selected!.imageId;
  const firstContainer = running;
  expect(await poll()).toMatchObject([{ ok: true }]);
  expect(selected).toEqual({ wasCreated: false, imageId: firstImage });
  expect(running).toBe(firstContainer);
  application.DockerfilePath = " /nested\\.\\One ";
  application.BuildContextPath = "./nested//";
  expect(await poll()).toMatchObject([{ ok: true }]);
  expect(selected).toEqual({ wasCreated: false, imageId: firstImage });
  expect(running).toBe(firstContainer);

  application.EnvironmentVariables = { RUNTIME_ONLY: "changed" };
  expect(await poll()).toMatchObject([{ ok: true }]);
  expect(selected).toEqual({ wasCreated: false, imageId: firstImage });
  expect(running).not.toBe(firstContainer);
  expect((await engine.getContainer(running!).inspect()).Config.Env).toContain(
    "RUNTIME_ONLY=changed",
  );

  application.DockerfilePath = "nested/Two";
  expect(await poll()).toMatchObject([{ ok: true }]);
  expect(selected!.wasCreated).toBe(true);
  expect(selected!.imageId).not.toBe(firstImage);
  await output("two\nnested-output");
  const nestedImage = selected!.imageId;
  const nestedContainer = running!;
  await expect(engine.getImage(firstImage).inspect()).rejects.toThrow();

  application.BuildContextPath = ".";
  const rootImage = await service.ensureImageExists(application, commit);
  expect(rootImage.wasCreated).toBe(true);
  expect(rootImage.imageId).not.toBe(nestedImage);
  await service.cleanupInactive(configured.Applications);
  expect((await engine.getImage(nestedImage).inspect()).Id).toBe(nestedImage);
  expect(
    (await engine.getContainer(nestedContainer).inspect()).State.Running,
  ).toBe(true);

  // Moving compatibility tags must not change the image passed to creation.
  await engine
    .getImage(nestedImage)
    .tag({ repo: `piploy/${application.Name}`, tag: `g_${commit.hash}` });
  await engine
    .getImage(nestedImage)
    .tag({ repo: `piploy/${application.Name}`, tag: "latest" });
  running = (
    await service.ensureContainerRunning(application, commit, rootImage.imageId)
  ).containerId;
  expect(running).not.toBe(nestedContainer);
  selected = rootImage;
  await output("two\nroot-output");
  expect(await poll()).toMatchObject([{ ok: true }]);
  expect(selected).toEqual({ wasCreated: false, imageId: rootImage.imageId });
  const rootContainer = running;

  application.DockerfilePath = "nested/Broken";
  expect(await poll()).toMatchObject([{ ok: false, stage: "build" }]);
  expect(
    (await engine.getContainer(rootContainer!).inspect()).State.Running,
  ).toBe(true);
  expect((await engine.getImage(rootImage.imageId).inspect()).Id).toBe(
    rootImage.imageId,
  );

  // An identity tag is insufficient when its image metadata does not match.
  application.DockerfilePath = "nested/Two";
  const identity = getBuildIdentity(
    application.GitRepositoryUrl,
    commit.hash,
    application.DockerfilePath,
    application.BuildContextPath,
  );
  await engine
    .getImage(nestedImage)
    .tag({ repo: `piploy/${application.Name}`, tag: `b_${identity}` });
  expect(await poll()).toMatchObject([{ ok: true }]);
  expect(selected!.wasCreated).toBe(true);
  await output("two\nroot-output");
  await engine.getContainer(running!).remove({ force: true });
  await service.cleanupInactive(settings.Applications);
}
