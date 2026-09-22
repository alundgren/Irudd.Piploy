import { verifyBuildIdentity } from "./helpers/buildIdentity.js";
import { Readable } from "node:stream";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile, execFileSync } from "node:child_process";

import Dockerode from "dockerode";
import { afterAll, expect, it, vi } from "vitest";

import { createDockerService } from "../../src/docker.js";
import {
  BuildPostponedError,
  buildkitImage,
  createBuildx,
} from "../../src/buildx.js";
import { startGitFixtureRemote } from "./helpers/gitFixture.js";
import { parseSettings } from "../../src/settings.js";
import type { Logger } from "../../src/logger.js";

const temporary = await mkdtemp(path.join(os.tmpdir(), "piploy-buildx-"));
const previousConfig = process.env.PIPLOY_CONFIG;
process.env.PIPLOY_CONFIG = path.join(temporary, "piploy.json");
const messages: string[] = [];
let progress: ((message: string) => void) | undefined;
const logger: Logger = {
  debug: (m) => {
    messages.push(m);
    progress?.(m);
  },
  info: (m) => {
    messages.push(m);
    progress?.(m);
  },
  warn: (m) => messages.push(m),
  error: (m) => messages.push(m),
  child: () => logger,
};
const application = {
  Name: `buildx${crypto.randomUUID().replaceAll("-", "")}`,
  GitRepositoryUrl: "https://example.invalid/test",
  DockerfilePath: "Dockerfile",
};
const settings = parseSettings({
  Piploy: {
    RootDirectory: path.join(temporary, "root"),
    Applications: [application],
    IsTestRun: true,
    Buildx: {
      Enabled: true,
      MinimumFreeBytes: 1,
    },
  },
});
const engine = new Dockerode();
const service = createDockerService(settings, logger);
const builder = createBuildx(settings, engine, logger);
const unrelatedBuilder = `unrelated-${crypto.randomUUID()}`;
let unrelatedCreated = false;
const repo = path.join(settings.RootDirectory, application.Name, "repo");
await mkdir(repo, { recursive: true });

function cli(args: string[]): string {
  return execFileSync("docker", args, {
    encoding: "utf8",
    env: { ...process.env, BUILDX_CONFIG: builder.directory },
    timeout: 120000,
  });
}

function cacheRecords(): {
  id: string;
  size: number;
  inUse: boolean;
  createdAt: string;
  description: string;
}[] {
  return JSON.parse(
    cli([
      "exec",
      `buildx_buildkit_${builder.name}0`,
      "buildctl",
      "du",
      "--format",
      "{{json .}}",
    ]),
  );
}

afterAll(async () => {
  await service.cleanupTestCreated();
  if (unrelatedCreated) cli(["buildx", "rm", unrelatedBuilder]);
  const container = await engine
    .getContainer(`buildx_buildkit_${builder.name}0`)
    .inspect()
    .catch(() => undefined);
  if (
    container?.Config.Env?.some((value) =>
      value.startsWith("PIPLOY_BUILDER_OWNER="),
    )
  )
    cli(["buildx", "rm", builder.name]);
  if (previousConfig === undefined) delete process.env.PIPLOY_CONFIG;
  else process.env.PIPLOY_CONFIG = previousConfig;
  await rm(temporary, { recursive: true, force: true });
});

it("builds and reuses persistent cache across commit tags and Poll cleanup", async () => {
  await writeFile(
    path.join(repo, "Dockerfile"),
    'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc AS dependencies\nCOPY dependency /dependency\nRUN echo dependency-marker && cp /dependency /installed\nFROM dependencies AS application\nCOPY source /source\nRUN echo source-marker && cat /source > /result\nCMD ["sleep", "3600"]\n',
  );
  await writeFile(path.join(repo, "dependency"), "one");
  await writeFile(path.join(repo, "source"), "one");
  const first = { hash: crypto.randomUUID() };
  const image = await service.ensureImageExists(application, first);
  expect(image.wasCreated).toBe(true);
  console.info(
    "Cache fixture cold:",
    messages.find((line) => line.includes("Built docker image")),
  );
  expect(await service.ensureImageExists(application, first)).toEqual({
    wasCreated: false,
    imageId: image.imageId,
  });
  await service.cleanupInactive([application]);
  messages.length = 0;
  await service.ensureImageExists(application, { hash: crypto.randomUUID() });
  expect(messages.join("\n")).toContain("CACHED");
  console.info(
    "Cache fixture unchanged:",
    messages.find((line) => line.includes("Built docker image")),
  );
  expect(await builder.availableBytes()).toBeGreaterThan(0);
}, 240000);

it("resumes interrupted builder recreation using the owned retained volume", async () => {
  const volumeName = `buildx_buildkit_${builder.name}0_state`;
  const before = await engine.getVolume(volumeName).inspect();
  expect(before.Labels.piploy_builderOwner).toBeDefined();
  // Reproduce process termination after rm succeeds but before create runs.
  cli(["buildx", "rm", "--keep-state", builder.name]);
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = temporary;
    await expect(
      service.ensureImageExists(application, { hash: crypto.randomUUID() }),
    ).rejects.toThrow("Cannot execute Docker CLI");
  } finally {
    process.env.PATH = previousPath;
  }
  messages.length = 0;
  const resumed = createDockerService(settings, logger);
  await resumed.ensureImageExists(application, { hash: crypto.randomUUID() });
  expect(cached("dependency-marker")).toBe(true);
  expect(cached("source-marker")).toBe(true);
  const after = await engine.getVolume(volumeName).inspect();
  expect(before).toHaveProperty("CreatedAt");
  expect(after).toEqual(before);
}, 240000);

function cached(marker: string): boolean {
  const instruction = messages.find((line) =>
    line.includes(`RUN echo ${marker}`),
  );
  const step = instruction?.match(/#\d+/)?.[0];
  return !!step && messages.some((line) => line.includes(`${step} CACHED`));
}

it("reuses dependencies on source changes and reversion, and invalidates them on dependency changes", async () => {
  for (const [file, value, dependenciesCached, sourceCached] of [
    ["source", "two", true, false],
    ["source", "one", true, true],
    ["dependency", "two", false, false],
  ] as const) {
    await writeFile(path.join(repo, file), value);
    await service.cleanupInactive([application]);
    messages.length = 0;
    await service.ensureImageExists(application, { hash: crypto.randomUUID() });
    expect(cached("dependency-marker")).toBe(dependenciesCached);
    expect(cached("source-marker")).toBe(sourceCached);
    console.info(
      `Cache fixture ${file}=${value}:`,
      messages.find((line) => line.includes("Built docker image")),
    );
    expect(messages.some((line) => /duration=\d+ms/.test(line))).toBe(true);
  }
}, 240000);

it("postpones low-space builds, permits same-commit reuse, and builds after capacity is available", async () => {
  const previous = { hash: crypto.randomUUID() };
  const image = await service.ensureImageExists(application, previous);
  const started = await service.ensureContainerRunning(
    application,
    previous,
    image.imageId,
  );
  const limited = createDockerService(
    {
      ...settings,
      Buildx: {
        ...settings.Buildx!,
        MinimumFreeBytes: Number.MAX_SAFE_INTEGER,
      },
    },
    logger,
  );
  expect(await limited.ensureImageExists(application, previous)).toEqual({
    wasCreated: false,
    imageId: image.imageId,
  });
  const next = previous;
  await writeFile(
    path.join(repo, "Replacement"),
    await readFile(path.join(repo, "Dockerfile")),
  );
  const changed = { ...application, DockerfilePath: "Replacement" };
  await expect(limited.ensureImageExists(changed, next)).rejects.toBeInstanceOf(
    BuildPostponedError,
  );
  expect(
    (await engine.getContainer(started.containerId).inspect()).State.Running,
  ).toBe(true);
  await limited.cleanupInactive([application]);
  expect((await engine.getImage(image.imageId).inspect()).Id).toBe(
    image.imageId,
  );
  expect((await service.ensureImageExists(changed, next)).wasCreated).toBe(
    true,
  );
}, 240000);

it("postpones a build when the Engine storage filesystem cannot be measured", async () => {
  const actualInfo = await engine.info();
  const measurementFailure = vi.spyOn(engine, "info").mockResolvedValue({
    ...actualInfo,
    DockerRootDir: `/nonexistent-${crypto.randomUUID()}`,
  });
  try {
    await expect(
      builder.build(Readable.from([]), "Dockerfile", [], {}),
    ).rejects.toBeInstanceOf(BuildPostponedError);
  } finally {
    measurementFailure.mockRestore();
  }
});

it("propagates Dockerfile failures and cancellation without replacing the serving container", async () => {
  const before = await service.getDockerStatus(application);
  await writeFile(
    path.join(repo, "Dockerfile"),
    "FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nRUN exit 42\n",
  );
  await expect(
    service.ensureImageExists(application, { hash: crypto.randomUUID() }),
  ).rejects.toThrow("operation failed");
  await writeFile(
    path.join(repo, "Dockerfile"),
    "FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nRUN sleep 300\n",
  );
  const controller = new AbortController();
  progress = (message) => {
    if (message.includes("RUN sleep 300")) controller.abort();
  };
  try {
    await expect(
      service.ensureImageExists(
        application,
        { hash: crypto.randomUUID() },
        controller.signal,
      ),
    ).rejects.toThrow("cancelled");
  } finally {
    progress = undefined;
  }
  expect(
    (await service.getDockerStatus(application)).runningContainerHash,
  ).toBe(before.runningContainerHash);
}, 240000);

it("reclaims many young failed-build snapshots to the cache limit", async () => {
  const target = 16 * 1024 * 1024;
  await builder.cleanup();
  const started = Math.floor(Date.now() / 1000) * 1000;
  for (let attempt = 0; attempt < 12; attempt++) {
    await writeFile(
      path.join(repo, "Dockerfile"),
      `FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nRUN echo ${attempt} && dd if=/dev/urandom of=/failed-install bs=1M count=4\nRUN exit 42\n`,
    );
    await expect(
      promisify(execFile)(
        "docker",
        ["buildx", "build", "--builder", builder.name, repo],
        {
          env: { ...process.env, BUILDX_CONFIG: builder.directory },
          timeout: 120000,
        },
      ),
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("exit code: 42"),
    });
  }
  const before = cacheRecords();
  expect(
    before.filter(
      (record) =>
        !record.inUse &&
        record.description.includes("/failed-install") &&
        Date.parse(record.createdAt) >= started,
    ).length,
  ).toBeGreaterThanOrEqual(12);
  expect(before.reduce((sum, record) => sum + record.size, 0)).toBeGreaterThan(
    target,
  );
  expect(before.filter((record) => !record.inUse).length).toBeGreaterThan(10);
  const limited = createBuildx(
    { ...settings, Buildx: { ...settings.Buildx!, CacheTargetBytes: target } },
    engine,
    logger,
  );
  messages.length = 0;
  await limited.cleanup();
  const after = cacheRecords();
  expect(
    after.reduce((sum, record) => sum + record.size, 0),
  ).toBeLessThanOrEqual(target);
  expect(after.length).toBeLessThan(before.length);
  console.info("Failed-build cache bytes:", {
    before: before.reduce((sum, record) => sum + record.size, 0),
    after: after.reduce((sum, record) => sum + record.size, 0),
    target,
  });
  expect(messages.join("\n")).toContain("Buildx cache usage after cleanup:");
  expect(messages.join("\n")).toContain("Reclaimable:");
  expect((await service.getDockerStatus(application)).container?.state).toBe(
    "running",
  );
}, 240000);

it("backs off the same failed build while new commits remain eligible", async () => {
  const commit = { hash: crypto.randomUUID() };
  await writeFile(
    path.join(repo, "Dockerfile"),
    "FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nRUN exit 42\n",
  );
  await expect(service.ensureImageExists(application, commit)).rejects.toThrow(
    "operation failed",
  );
  messages.length = 0;
  await expect(service.ensureImageExists(application, commit)).rejects.toThrow(
    "next retry at",
  );
  expect(
    messages.some((message) => message.includes("Building docker image")),
  ).toBe(false);
  const now = Date.now();
  const time = vi.spyOn(Date, "now").mockReturnValue(now + 5 * 60_000);
  try {
    await expect(
      service.ensureImageExists(application, commit),
    ).rejects.toThrow("operation failed");
    let clock = now + 5 * 60_000;
    for (const minutes of [10, 20, 40, 80, 160, 320, 360, 360]) {
      time.mockReturnValue(clock + minutes * 60_000 - 1);
      await expect(
        service.ensureImageExists(application, commit),
      ).rejects.toThrow("next retry at");
      clock += minutes * 60_000;
      time.mockReturnValue(clock);
      await expect(
        service.ensureImageExists(application, commit),
      ).rejects.toThrow("operation failed");
    }
  } finally {
    time.mockRestore();
  }
  await expect(
    service.ensureImageExists(application, { hash: crypto.randomUUID() }),
  ).rejects.toThrow("operation failed");
}, 240000);

it("automatically reclaims young cache above the limit without removing the running Application", async () => {
  const target = 16 * 1024 * 1024;
  const automaticSettings = {
    ...settings,
    Buildx: { ...settings.Buildx!, CacheTargetBytes: target },
  };
  const automaticBuilder = createBuildx(automaticSettings, engine, logger);
  await automaticBuilder.cleanup();
  await writeFile(
    path.join(repo, "Dockerfile"),
    "FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nRUN dd if=/dev/urandom of=/automatic bs=1M count=32\n",
  );
  cli(["buildx", "build", "--builder", builder.name, repo]);
  const used = () =>
    cacheRecords().reduce((sum, record) => sum + record.size, 0);
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline && used() > target) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  expect(used()).toBeLessThanOrEqual(target);
  expect((await service.getDockerStatus(application)).container?.state).toBe(
    "running",
  );
}, 240000);

it("refuses mismatched ownership and missing CLI prerequisites without changing containers", async () => {
  const metadataPath = path.join(builder.directory, "instances", builder.name);
  const original = await readFile(metadataPath, "utf8");
  const container = await engine
    .getContainer(`buildx_buildkit_${builder.name}0`)
    .inspect();
  try {
    const metadata = JSON.parse(original);
    metadata.Nodes[0].DriverOpts["env.PIPLOY_BUILDER_OWNER"] = "someone-else";
    await writeFile(metadataPath, JSON.stringify(metadata));
    await expect(
      service.ensureImageExists(application, { hash: crypto.randomUUID() }),
    ).rejects.toThrow("ownership");
    expect((await engine.getContainer(container.Id).inspect()).Id).toBe(
      container.Id,
    );
  } finally {
    await writeFile(metadataPath, original);
  }
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = temporary;
    await expect(
      service.ensureImageExists(application, { hash: crypto.randomUUID() }),
    ).rejects.toThrow("Cannot execute Docker CLI");
  } finally {
    process.env.PATH = previousPath;
  }
});

it("leaves an unrelated builder and its cache intact during owned cleanup", async () => {
  const fixture = path.join(temporary, "unrelated");
  await mkdir(fixture);
  await writeFile(
    path.join(fixture, "Dockerfile"),
    "FROM scratch\nCOPY marker /marker\n",
  );
  await writeFile(path.join(fixture, "marker"), "unrelated");
  cli([
    "buildx",
    "create",
    "--name",
    unrelatedBuilder,
    "--driver",
    "docker-container",
    "--driver-opt",
    `image=${buildkitImage}`,
  ]);
  unrelatedCreated = true;
  cli(["buildx", "build", "--builder", unrelatedBuilder, fixture]);
  const before = cli([
    "buildx",
    "du",
    "--builder",
    unrelatedBuilder,
    "--format",
    "{{.ID}}",
  ]);
  await builder.cleanup();
  expect(
    cli(["buildx", "du", "--builder", unrelatedBuilder, "--format", "{{.ID}}"]),
  ).toBe(before);
}, 240000);

it("runs Buildx through the installed single-file bundle during a real Poll", async () => {
  const remote = await startGitFixtureRemote();
  try {
    const hash = remote.commit({
      Dockerfile:
        'FROM alpine:3.20@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc\nRUN echo bundle-marker > /marker\nCMD ["sleep", "3600"]\n',
    });
    const bundledApplication = {
      ...application,
      Name: `${application.Name}bundle`,
      GitRepositoryUrl: remote.url,
    };
    await writeFile(
      process.env.PIPLOY_CONFIG!,
      JSON.stringify({
        Piploy: { ...settings, Applications: [bundledApplication] },
      }),
    );
    const result = await promisify(execFile)(
      process.execPath,
      [path.resolve("dist/piploy.cjs"), "poll"],
      { env: process.env, timeout: 120000 },
    );
    expect(result.stdout).toContain("bundle-marker");
    expect(result.stdout).toContain("Built docker image");
    expect(
      (await service.getDockerStatus(bundledApplication)).runningContainerHash,
    ).toBe(hash);
  } finally {
    await remote.close();
  }
}, 240000);

it("uses build identity and exact image IDs through Poll", async () => {
  await verifyBuildIdentity(settings, logger);
}, 240000);
