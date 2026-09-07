import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import type Dockerode from "dockerode";

import type { Logger } from "./logger.js";
import type { PiploySettings } from "./settings.js";
import { resolveConfigPath } from "./settings.js";

export const buildkitImage =
  "docker.io/moby/buildkit:v0.32.0@sha256:1f8167fcb0eca5b7126353d35299386945cbb8949cc516c592a49f80cfce4fa2";

export class BuildPostponedError extends Error {
  readonly code = "buildPostponed";
  constructor(reason: string) {
    super(
      `Build postponed: ${reason}. Check Docker storage and Buildx prerequisites; Piploy will retry on a later Poll.`,
    );
    this.name = "BuildPostponedError";
  }
}

export function buildkitConfiguration(
  retentionHours: number,
  targetBytes: number,
  minimumFreeBytes: number,
): string {
  return `[worker.oci]\n  gc = true\n[[worker.oci.gcpolicy]]\n  all = true\n  keepDuration = "${retentionHours * 3600}s"\n  reservedSpace = 0\n  maxUsedSpace = ${targetBytes}\n  minFreeSpace = ${minimumFreeBytes}\n[worker.containerd]\n  enabled = false\n`;
}

export function parseAvailableBytes(output: string): number {
  const lines = output.trim().split("\n");
  const available = lines
    .slice(1)
    .map((line) => Number(line.trim().split(/\s+/)[3]) * 1024);
  if (
    available.length < 1 ||
    available.some((value) => !Number.isSafeInteger(value) || value < 0)
  ) {
    throw new Error("Docker storage free-space measurement was invalid");
  }
  return Math.min(...available);
}

interface CommandOptions {
  input?: NodeJS.ReadableStream;
  signal?: AbortSignal;
  progress?: boolean;
}

export function createBuildx(
  settings: PiploySettings,
  docker: Dockerode,
  logger: Logger,
) {
  const policy = settings.Buildx!;
  const owner = createHash("sha256")
    .update(path.resolve(resolveConfigPath()))
    .update(settings.IsTestRun ? ":test" : ":normal")
    .digest("hex")
    .slice(0, 24);
  const name = `piploy-${settings.IsTestRun ? "test-" : ""}${owner}`;
  const directory = path.join(
    path.dirname(path.resolve(resolveConfigPath())),
    ".piploy-buildx",
    settings.IsTestRun ? "test" : "normal",
  );
  const configuration =
    (settings.IsTestRun ? "debug = true\n" : "") +
    buildkitConfiguration(
      policy.CacheRetentionHours,
      policy.CacheTargetBytes,
      policy.MinimumFreeBytes,
    );
  const policyHash = createHash("sha256").update(configuration).digest("hex");
  const containerName = `buildx_buildkit_${name}0`;
  const stateVolumeName = `${containerName}_state`;
  let endpoint: string | undefined;

  async function command(
    args: string[],
    options: CommandOptions = {},
  ): Promise<string> {
    options.signal?.throwIfAborted();
    return new Promise((resolve, reject) => {
      const child = spawn(
        "docker",
        endpoint ? ["--host", endpoint, ...args] : args,
        {
          shell: false,
          env: {
            ...process.env,
            DOCKER_CONTEXT: undefined,
            BUILDX_BUILDER: undefined,
            BUILDX_CONFIG: directory,
          },
          stdio: ["pipe", "pipe", "pipe"],
        },
      );
      let output = "";
      let pending = "";
      let inputError: unknown;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      const abort = () => {
        child.kill("SIGTERM");
        killTimer ??= setTimeout(() => child.kill("SIGKILL"), 5000);
        killTimer.unref();
      };
      const timeout = options.progress ? undefined : setTimeout(abort, 120000);
      timeout?.unref();
      options.signal?.addEventListener("abort", abort, { once: true });
      const onData = (data: Buffer) => {
        output = (output + data.toString()).slice(-1024 * 1024);
        if (options.progress) {
          pending += data.toString();
          const lines = pending.split(/\r?\n/);
          pending = lines.pop() ?? "";
          for (const line of lines) if (line) logger.info(`Buildx ${line}`);
          if (pending.length > 16384) {
            logger.info(`Buildx ${pending.slice(0, 16384)}`);
            pending = "";
          }
        }
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.once("error", () => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        reject(
          new Error(
            "Cannot execute Docker CLI. Install the supported Docker CLI and Buildx plugin before enabling Buildx.",
          ),
        );
      });
      child.once("close", (code) => {
        clearTimeout(timeout);
        clearTimeout(killTimer);
        options.signal?.removeEventListener("abort", abort);
        if (pending) logger.info(`Buildx ${pending}`);
        if (options.signal?.aborted)
          reject(new Error("Buildx operation cancelled"));
        else if (code !== 0 || inputError)
          reject(
            new Error(
              `Buildx ${args.slice(0, args[0] === "buildx" ? 2 : 1).join(" ")} operation failed (exit ${String(code)}). ${options.progress ? "Check timestamped build progress for Dockerfile, export, or disk errors." : args[0] === "run" ? "Docker storage measurement failed; check Engine storage access and capacity." : "Check Docker CLI/Buildx prerequisites and the owned builder using docs/buildx-rollout.md."}`,
            ),
          );
        else resolve(output);
      });
      if (options.input) {
        void pipeline(options.input as Readable, child.stdin).catch(
          (error: unknown) => {
            inputError = error;
            abort();
          },
        );
      } else child.stdin.end();
    });
  }

  async function preflight(signal?: AbortSignal): Promise<void> {
    const run = (args: string[]) => command(args, { signal });
    // Dockerode resolves DOCKER_HOST itself. An explicit endpoint prevents CLI
    // context selection from redirecting builds to another Engine.
    const modem = docker.modem as unknown as {
      getSocketPath(): Promise<string> | undefined;
    };
    const socketPath = await modem.getSocketPath();
    if (socketPath) endpoint = `unix://${socketPath}`;
    else if (process.env.DOCKER_HOST) endpoint = process.env.DOCKER_HOST;
    else throw new Error("Buildx requires an explicit Docker Engine endpoint");
    const info = await docker.info();
    const cliInfo = JSON.parse(await run(["info", "--format", "{{json .}}"]));
    if (!info.ID || cliInfo.ID !== info.ID)
      throw new Error("Docker CLI and Dockerode must address the same Engine");
    const version = JSON.parse(
      await run(["version", "--format", "{{json .}}"]),
    );
    const buildxVersion = await run(["buildx", "version"]);
    const cliMajor = Number(
      /^(\d+)\./.exec(String(version.Client?.Version))?.[1],
    );
    const engineMajor = Number(
      /^(\d+)\./.exec(String(version.Server?.Version))?.[1],
    );
    const buildxMatch = /\bv(\d+)\.(\d+)\./.exec(buildxVersion);
    if (
      !(cliMajor >= 29) ||
      !(engineMajor >= 29) ||
      !buildxMatch ||
      !(Number(buildxMatch[1]) > 0 || Number(buildxMatch[2]) >= 36)
    ) {
      throw new Error(
        "Buildx requires Docker Engine/CLI 29 or newer and Buildx 0.36 or newer. Install compatible versions before activation.",
      );
    }
    if (info.OSType !== "linux")
      throw new Error("Piploy Buildx requires a Linux Docker Engine");
    mkdirSync(directory, { recursive: true, mode: 0o700 });
  }

  async function verifyContainer(expectedPolicy = policyHash): Promise<void> {
    const container = await docker.getContainer(containerName).inspect();
    if (
      !container.Mounts.some(
        (mount) =>
          mount.Name === stateVolumeName &&
          mount.Destination === "/var/lib/buildkit",
      ) ||
      container.Config.Image !== buildkitImage ||
      !container.Config.Env?.includes(`PIPLOY_BUILDER_OWNER=${owner}`) ||
      !container.Config.Env?.includes(`PIPLOY_BUILDER_POLICY=${expectedPolicy}`)
    ) {
      throw new Error(
        "Piploy builder ownership or retention configuration differs. Follow the runbook to inspect and recreate the owned builder with cache preserved.",
      );
    }
  }

  async function ensureBuilder(signal?: AbortSignal): Promise<void> {
    const run = (args: string[]) => command(args, { signal });
    await preflight(signal);
    const containers = await docker.listContainers({ all: true });
    const exists = containers.some((container) =>
      container.Names.includes(`/${containerName}`),
    );
    const volume = (await docker.listVolumes()).Volumes?.find(
      (candidate) => candidate.Name === stateVolumeName,
    );
    if (
      volume &&
      (volume.Labels?.piploy_builderOwner !== owner ||
        volume.Driver !== "local" ||
        Object.keys(volume.Options ?? {}).length !== 0)
    ) {
      throw new Error(
        "An unidentified Piploy cache volume already exists. Inspect its ownership using the runbook; Piploy will not adopt it.",
      );
    }
    if (exists && !volume)
      throw new Error(
        "Piploy builder has no owned cache volume; inspect the builder before recovery",
      );
    // Private Buildx metadata avoids changing the operator's default builder.
    const inspected = (await run(["buildx", "ls", "--format", "{{json .}}"]))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((builder) => builder.Name === name);
    let create = !inspected;
    if (inspected) {
      const previousPolicy =
        inspected.Nodes?.[0]?.DriverOpts?.["env.PIPLOY_BUILDER_POLICY"];
      if (
        inspected.Driver !== "docker-container" ||
        inspected.Nodes?.length !== 1 ||
        inspected.Nodes[0].Endpoint !== endpoint ||
        inspected.Nodes[0].DriverOpts?.["env.PIPLOY_BUILDER_OWNER"] !== owner ||
        inspected.Nodes[0].DriverOpts?.image !== buildkitImage ||
        typeof previousPolicy !== "string" ||
        !/^[a-f0-9]{64}$/.test(previousPolicy)
      ) {
        throw new Error(
          "Piploy builder ownership or Engine differs. Inspect it using the runbook before making changes.",
        );
      }
      if (exists) await verifyContainer(previousPolicy);
      if (previousPolicy !== policyHash) {
        await run(["buildx", "rm", "--keep-state", name]);
        logger.info(
          "Recreating owned Buildx builder with restart-applied retention; persistent cache retained",
        );
        create = true;
      }
    } else {
      if (exists)
        throw new Error(
          "Piploy builder container exists without its Buildx metadata. Restore the metadata before building.",
        );
      if (volume)
        logger.info(
          "Resuming owned Buildx builder creation with retained cache",
        );
    }
    if (!volume) {
      signal?.throwIfAborted();
      // The label survives buildx rm --keep-state, so a later Poll can safely
      // resume an interrupted creation without trusting the volume name alone.
      await docker.createVolume({
        Name: stateVolumeName,
        Driver: "local",
        Labels: { piploy_builderOwner: owner },
      });
    }
    const verifiedVolume = await docker.getVolume(stateVolumeName).inspect();
    if (
      verifiedVolume.Labels?.piploy_builderOwner !== owner ||
      verifiedVolume.Driver !== "local" ||
      Object.keys(verifiedVolume.Options ?? {}).length !== 0
    ) {
      throw new Error(
        "Piploy cache volume ownership changed before builder creation; inspect it before retrying",
      );
    }
    if (create) {
      const configPath = path.join(directory, "buildkitd.toml");
      writeFileSync(configPath, configuration, { mode: 0o600 });
      await run([
        "buildx",
        "create",
        "--name",
        name,
        "--driver",
        "docker-container",
        "--driver-opt",
        `image=${buildkitImage}`,
        "--driver-opt",
        `env.PIPLOY_BUILDER_OWNER=${owner}`,
        "--driver-opt",
        `env.PIPLOY_BUILDER_POLICY=${policyHash}`,
        "--buildkitd-config",
        configPath,
        endpoint!,
      ]);
    }
    await run(["buildx", "inspect", name, "--bootstrap"]);
    await verifyContainer();
    const running = (await run(["buildx", "ls", "--format", "{{json .}}"]))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .find((builder) => builder.Name === name);
    const policies = running?.Nodes?.[0]?.GCPolicy;
    if (
      running?.Nodes?.[0]?.Version !== "v0.32.0" ||
      policies?.length !== 1 ||
      policies[0].all !== true ||
      policies[0].keepDuration !== policy.CacheRetentionHours * 3600 * 1e9 ||
      policies[0].maxUsedSpace !== policy.CacheTargetBytes ||
      policies[0].minFreeSpace !== policy.MinimumFreeBytes ||
      policies[0].reservedSpace !== 0
    ) {
      throw new Error(
        "Piploy BuildKit version or effective GC policy differs; stop the owned builder and restore the runbook configuration",
      );
    }
  }

  async function cleanup(signal?: AbortSignal): Promise<void> {
    const run = (args: string[]) => command(args, { signal });
    await ensureBuilder(signal);
    const result = await run([
      "buildx",
      "prune",
      "--builder",
      name,
      "--force",
      "--all",
      "--filter",
      `until=${policy.CacheRetentionHours * 3600}s`,
      "--max-used-space",
      String(policy.CacheTargetBytes),
      "--min-free-space",
      String(policy.MinimumFreeBytes),
      "--reserved-space",
      "0",
    ]);
    logger.info(`Buildx cache cleanup: ${result.trim()}`);
  }

  async function availableBytes(signal?: AbortSignal): Promise<number> {
    const run = (args: string[]) => command(args, { signal });
    const info = await docker.info();
    const storagePath = info.DockerRootDir as string;
    if (!storagePath?.startsWith("/") || /[,\n]/.test(storagePath))
      throw new Error("Cannot identify Docker storage filesystem");
    // The helper's root filesystem measures the Engine's image snapshot
    // storage, which can differ from DockerRootDir with containerd.
    const output = await run([
      "run",
      "--rm",
      "--network",
      "none",
      "--read-only",
      "--mount",
      `type=bind,src=${storagePath},dst=/storage,readonly`,
      "--entrypoint",
      "df",
      buildkitImage,
      "-Pk",
      "/storage",
      "/",
    ]);
    return parseAvailableBytes(output);
  }

  async function build(
    input: NodeJS.ReadableStream,
    dockerfile: string,
    tags: string[],
    labels: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<void> {
    try {
      signal?.throwIfAborted();
      await ensureBuilder(signal);
      let free = await availableBytes(signal);
      if (free < policy.MinimumFreeBytes) {
        await cleanup(signal);
        free = await availableBytes(signal);
      }
      logger.info(
        `Buildx Docker storage available=${free} minimum=${policy.MinimumFreeBytes} bytes`,
      );
      if (free < policy.MinimumFreeBytes)
        throw new Error(
          `Docker storage has ${free} free bytes, below ${policy.MinimumFreeBytes}; protected cache will not be deleted`,
        );
    } catch (error) {
      (input as Readable).destroy();
      if (signal?.aborted) throw error;
      throw new BuildPostponedError(
        error instanceof Error ? error.message : String(error),
      );
    }
    const args = [
      "buildx",
      "build",
      "--builder",
      name,
      "--load",
      "--progress",
      "plain",
      "--file",
      dockerfile,
    ];
    for (const tag of tags) args.push("--tag", tag);
    for (const [key, value] of Object.entries(labels))
      args.push("--label", `${key}=${value}`);
    args.push("-");
    await command(args, { input, signal, progress: true });
  }

  logger.info(
    `Buildx enabled: retention=${policy.CacheRetentionHours}h cacheTarget=${policy.CacheTargetBytes} minimumFree=${policy.MinimumFreeBytes} bytes; settings apply after restart`,
  );
  return { build, cleanup, availableBytes, name, directory };
}
