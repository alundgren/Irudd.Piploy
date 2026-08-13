import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";

import Dockerode from "dockerode";

import {
  containerLogConfig,
  getContainerConfigHash,
  getDockerfilePathFromSetting,
  planContainer,
  planImage,
  type DockerContainer,
  validateDockerfileImageReferences,
} from "./dockerPlan.js";
import type { Logger } from "./logger.js";
import type { Application, PiploySettings } from "./settings.js";
import { getApplicationRepoDirectory, getVolumeDirectory } from "./settings.js";

const piploy = "piploy";
const imageAppLabelName = `${piploy}_appName`;
const imageCommitLabelName = `${piploy}_gitTipCommit`;
const containerConfigLabelName = `${piploy}_configHash`;
const testMarkerLabelName = `${piploy}_isCreatedByTest`;

export interface GitCommit {
  hash: string;
}

export interface EnsureImageResult {
  wasCreated: boolean;
  imageId: string;
}

export interface EnsureContainerResult {
  wasCreated: boolean;
  wasStarted: boolean;
  containerId: string;
}

export interface DockerStatus {
  latestImageHash?: string;
  runningContainerHash?: string;
}

export interface PiployDockerService {
  ensureImageExists(
    application: Application,
    commit: GitCommit,
  ): Promise<EnsureImageResult>;
  ensureContainerRunning(
    application: Application,
    commit: GitCommit,
  ): Promise<EnsureContainerResult>;
  getDockerStatus(application: Application): Promise<DockerStatus>;
  cleanupInactive(applications: Application[]): Promise<void>;
  cleanupAll(): Promise<void>;
  cleanupTestCreated(): Promise<void>;
}

export class PortAlreadyInUseError extends Error {
  readonly code = "portAlreadyInUse";

  constructor(hostPorts: number[]) {
    super(
      `At least one of these ports are already in use by the host: ${hostPorts.join(", ")}`,
    );
    this.name = "PortAlreadyInUseError";
  }
}

interface DockerWithBuildkitProgress extends Dockerode {
  followProgress(
    stream: NodeJS.ReadableStream,
    onFinished: (error: Error | null, output: unknown[]) => void,
    onProgress: (event: unknown) => void,
  ): void;
}

interface PiployImageBuildOptions extends Omit<
  Dockerode.ImageBuildOptions,
  "t"
> {
  t: string[];
}

function getImageVersionTag(appName: string, versionValue: string): string {
  return `${piploy}/${appName}:${versionValue}`.toLowerCase();
}

export function getImageVersionTagLatest(appName: string): string {
  return getImageVersionTag(appName, "latest");
}

function getImageVersionTagCommit(appName: string, commit: GitCommit): string {
  return getImageVersionTag(appName, `g_${commit.hash}`);
}

function getImageVersionTagUniqueId(appName: string, uniqueId: string): string {
  return getImageVersionTag(appName, `v_${uniqueId}`);
}

function getContainerName(application: Application): string {
  return `${piploy}_${application.Name}`;
}

function asDockerContainer(
  container: Dockerode.ContainerInfo,
): DockerContainer {
  return {
    id: container.Id,
    state: container.State,
    gitTipCommit: container.Labels[imageCommitLabelName],
    configHash: container.Labels[containerConfigLabelName],
  };
}

function isPortAlreadyAllocated(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("port is already allocated")
  );
}

function followBuildProgress(
  docker: Dockerode,
  stream: NodeJS.ReadableStream,
  logger: Logger,
): Promise<void> {
  return new Promise((resolve, reject) => {
    // dockerode's type package omits followProgress. Its Docker-level version,
    // unlike modem.followProgress, decodes BuildKit events correctly.
    (docker as DockerWithBuildkitProgress).followProgress(
      stream,
      (error) => (error ? reject(error) : resolve()),
      (event) => logger.debug(JSON.stringify(event)),
    );
  });
}

function buildImage(
  docker: Dockerode,
  context: Dockerode.ImageBuildContext,
  options: PiployImageBuildOptions,
): Promise<NodeJS.ReadableStream> {
  // @types/dockerode incorrectly only permits one tag, while the daemon API
  // and dockerode support a repeated tag parameter.
  return docker.buildImage(
    context,
    options as unknown as Dockerode.ImageBuildOptions,
  );
}

export function createDockerService(
  settings: PiploySettings,
  logger: Logger,
): PiployDockerService {
  const docker = new Dockerode();

  async function findImage(
    reference: string,
  ): Promise<Dockerode.ImageInfo | undefined> {
    return (
      await docker.listImages({ filters: { reference: [reference] } })
    )[0];
  }

  async function findContainer(
    name: string,
  ): Promise<Dockerode.ContainerInfo | undefined> {
    return (
      await docker.listContainers({ all: true, filters: { name: [name] } })
    )[0];
  }

  async function ensureImageExists(
    application: Application,
    commit: GitCommit,
  ): Promise<EnsureImageResult> {
    const commitTag = getImageVersionTagCommit(application.Name, commit);
    const existingImage = await findImage(commitTag);
    const imagePlan = planImage(
      existingImage ? { id: existingImage.Id } : undefined,
    );
    if (imagePlan.action === "reuse") {
      return { wasCreated: false, imageId: imagePlan.imageId };
    }

    const dockerfilePath = getDockerfilePathFromSetting(
      application.DockerfilePath,
    );
    const repoDirectory = getApplicationRepoDirectory(settings, application);
    const contextDirectory = path.join(
      repoDirectory,
      dockerfilePath.contextDirectory,
    );
    const absoluteDockerfilePath = path.join(
      contextDirectory,
      dockerfilePath.dockerfileName,
    );
    if (!existsSync(absoluteDockerfilePath)) {
      throw new Error(
        `Dockerfile '${application.DockerfilePath}' does not exist. Expected location: '${absoluteDockerfilePath}'`,
      );
    }
    const violations = validateDockerfileImageReferences(
      readFileSync(absoluteDockerfilePath, "utf8"),
    );
    if (violations.length > 0) {
      throw new Error(
        `Dockerfile base-image policy rejected:\n${violations
          .map(({ reference, reason }) => `- ${reference}: ${reason}`)
          .join("\n")}`,
      );
    }

    const uniqueId = crypto.randomUUID();
    logger.info(`Building docker image for commit ${commit.hash}`);
    const buildStream = await buildImage(
      docker,
      { context: contextDirectory, src: readdirSync(contextDirectory) },
      {
        dockerfile: dockerfilePath.dockerfileName,
        t: [
          getImageVersionTagLatest(application.Name),
          commitTag,
          getImageVersionTagUniqueId(application.Name, uniqueId),
        ],
        labels: {
          [`${piploy}_buildDate`]: new Date().toISOString(),
          [imageAppLabelName]: application.Name,
          [imageCommitLabelName]: commit.hash,
          [`${piploy}_uniqueId`]: uniqueId,
          ...(settings.IsTestRun ? { [testMarkerLabelName]: "true" } : {}),
        },
      },
    );
    await followBuildProgress(docker, buildStream, logger);
    logger.info(`Built docker image for commit ${commit.hash}`);

    const builtImage = await findImage(commitTag);
    if (!builtImage) {
      throw new Error(`Failed to create image for ${application.Name}`);
    }
    return { wasCreated: true, imageId: builtImage.Id };
  }

  async function ensureContainerRunning(
    application: Application,
    commit: GitCommit,
  ): Promise<EnsureContainerResult> {
    const containerName = getContainerName(application);
    const existingContainer = await findContainer(containerName);
    const binds = (application.Volumes ?? []).map(
      (volume) =>
        `${getVolumeDirectory(application, volume)}:${volume.containerPath}`,
    );
    const environment = Object.entries(
      application.EnvironmentVariables ?? {},
    ).map(([name, value]) => `${name}=${value}`);
    const configHash = getContainerConfigHash({
      environmentVariables: environment,
      volumes: binds,
      portMappings: application.PortMappings,
    });
    const containerPlan = planContainer(
      existingContainer ? asDockerContainer(existingContainer) : undefined,
      commit.hash,
      configHash,
    );

    if (containerPlan.action === "reuse") {
      return {
        wasCreated: false,
        wasStarted: false,
        containerId: containerPlan.containerId,
      };
    }
    if (containerPlan.action === "start") {
      logger.info(`Starting container ${containerName}`);
      await docker.getContainer(containerPlan.containerId).start();
      return {
        wasCreated: false,
        wasStarted: true,
        containerId: containerPlan.containerId,
      };
    }

    if (containerPlan.existingContainerId) {
      logger.info(`Removing container ${containerName}`);
      await docker
        .getContainer(containerPlan.existingContainerId)
        .remove({ force: true });
    }

    const portBindings: Record<string, Array<{ HostPort: string }>> = {};
    const exposedPorts: Record<string, object> = {};
    for (const portMapping of application.PortMappings ?? []) {
      const port = `${portMapping.containerPort}/tcp`;
      portBindings[port] = [{ HostPort: String(portMapping.hostPort) }];
      exposedPorts[port] = {};
    }

    for (const volume of application.Volumes ?? []) {
      mkdirSync(getVolumeDirectory(application, volume), { recursive: true });
    }

    logger.info(`Creating container ${containerName}`);
    const createdContainer = await docker.createContainer({
      Image: getImageVersionTagCommit(application.Name, commit),
      name: containerName,
      Env: environment,
      ExposedPorts: exposedPorts,
      HostConfig: {
        PortBindings: portBindings,
        Binds: binds,
        AutoRemove: true,
        LogConfig: containerLogConfig,
      },
      Labels: { [containerConfigLabelName]: configHash },
    });
    try {
      logger.info(`Starting container ${containerName}`);
      await createdContainer.start();
    } catch (error) {
      if (isPortAlreadyAllocated(error)) {
        throw new PortAlreadyInUseError(
          (application.PortMappings ?? []).map(({ hostPort }) => hostPort),
        );
      }
      throw error;
    }

    return {
      wasCreated: true,
      wasStarted: true,
      containerId: createdContainer.id,
    };
  }

  async function getDockerStatus(
    application: Application,
  ): Promise<DockerStatus> {
    const [image, container] = await Promise.all([
      findImage(getImageVersionTagLatest(application.Name)),
      findContainer(getContainerName(application)),
    ]);
    return {
      latestImageHash: image?.Labels[imageCommitLabelName],
      runningContainerHash:
        container?.State === "running"
          ? container.Labels[imageCommitLabelName]
          : undefined,
    };
  }

  async function getPiployImages(
    additionalLabel?: string,
  ): Promise<Dockerode.ImageInfo[]> {
    const labelFilters = [imageAppLabelName];
    if (additionalLabel) labelFilters.push(additionalLabel);
    return (
      await docker.listImages({
        all: true,
        filters: { label: labelFilters },
      })
    ).filter((image) => (image.RepoTags?.length ?? 0) > 0);
  }

  async function stopContainersAndDeleteImages(
    images: Dockerode.ImageInfo[],
  ): Promise<void> {
    const imageIds = new Set(images.map((image) => image.Id));
    const containers = (await docker.listContainers({ all: true })).filter(
      (container) => imageIds.has(container.ImageID),
    );
    for (const container of containers) {
      if (container.State === "running") {
        await docker.getContainer(container.Id).stop();
      }
    }
    for (const image of images) {
      await docker.getImage(image.Id).remove({ force: true });
    }
    await docker.pruneImages({ filters: { dangling: ["true"] } });
  }

  async function cleanupInactive(applications: Application[]): Promise<void> {
    const latestTags = new Set(
      applications.map((application) =>
        getImageVersionTagLatest(application.Name),
      ),
    );
    const inactiveImages = (await getPiployImages()).filter(
      (image) => !image.RepoTags?.some((tag) => latestTags.has(tag)),
    );
    await stopContainersAndDeleteImages(inactiveImages);
  }

  async function cleanupAll(): Promise<void> {
    await stopContainersAndDeleteImages(await getPiployImages());
  }

  async function cleanupTestCreated(): Promise<void> {
    await stopContainersAndDeleteImages(
      await getPiployImages(`${testMarkerLabelName}=true`),
    );
  }

  return {
    ensureImageExists,
    ensureContainerRunning,
    getDockerStatus,
    cleanupInactive,
    cleanupAll,
    cleanupTestCreated,
  };
}
