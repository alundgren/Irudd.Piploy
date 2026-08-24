import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import path from "node:path";
import { createGzip } from "node:zlib";

import DockerIgnore from "@balena/dockerignore";
import Dockerode from "dockerode";
import { pack } from "tar-fs";

import { decodeContainerLog, limitLogBytes } from "./containerLogs.js";
import {
  containerLogConfig,
  containerRestartPolicy,
  getBuildContextPathFromSetting,
  getContainerConfigHash,
  getDockerfilePathFromSetting,
  planContainer,
  planImage,
  planRacedContainer,
  resolveContainerEnvironmentVariables,
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

/**
 * The container occupying an Application's slot, as Docker reports it. This is
 * what tells `isRunningLatestVersion: false` apart from a container that
 * crashes on boot: under the `unless-stopped` restart policy (ADR-0009) a
 * crash loop shows as `restarting` with the last non-zero `exitCode`.
 */
export interface ContainerRuntimeStatus {
  state: string;
  /** Absent until the container has exited at least once. */
  exitCode?: number;
  restartCount: number;
}

export interface DockerStatus {
  latestImageHash?: string;
  runningContainerHash?: string;
  container?: ContainerRuntimeStatus;
}

export interface ContainerLogs {
  containerState: string;
  text: string;
  /** True when the oldest returned bytes were dropped to stay within the cap. */
  truncated: boolean;
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
  /** Resolves to `undefined` when the Application has no container at all. */
  getContainerLogs(
    application: Application,
    tailLines: number,
  ): Promise<ContainerLogs | undefined>;
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

/**
 * Whether the container has run and stopped at least once. Docker zeroes
 * `FinishedAt` for a container that has never run, so `ExitCode` 0 there means
 * "no exit yet" rather than a clean one.
 */
function hasExited(state: Dockerode.ContainerInspectInfo["State"]): boolean {
  return (
    (!state.Running || state.Restarting) && Date.parse(state.FinishedAt) > 0
  );
}

function isPortAlreadyAllocated(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("port is already allocated")
  );
}

function isContainerNameConflict(error: unknown): boolean {
  return (
    error instanceof Error &&
    error.message.includes("is already in use by container")
  );
}

function isContainerAlreadyStarted(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { reason?: string }).reason === "container already started"
  );
}

function isContainerNotFound(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error as { reason?: string }).reason === "no such container"
  );
}

function isContainerRemovalInProgress(error: unknown): boolean {
  return (
    error instanceof Error && error.message.includes("is already in progress")
  );
}

const containerConflictRecheckAttempts = 10;
const containerConflictRecheckDelayMilliseconds = 150;

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
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
  context: NodeJS.ReadableStream,
  options: PiployImageBuildOptions,
): Promise<NodeJS.ReadableStream> {
  // @types/dockerode incorrectly only permits one tag, while the daemon API
  // and dockerode support a repeated tag parameter.
  return docker.buildImage(
    context,
    options as unknown as Dockerode.ImageBuildOptions,
  );
}

interface DockerBuildPaths {
  contextDirectory: string;
  dockerfilePath: string;
  absoluteDockerfilePath: string;
}

function createBuildContext(
  buildPaths: DockerBuildPaths,
): NodeJS.ReadableStream {
  const dockerfileIgnorePath = `${buildPaths.absoluteDockerfilePath}.dockerignore`;
  const ignorePath = existsSync(dockerfileIgnorePath)
    ? dockerfileIgnorePath
    : path.join(buildPaths.contextDirectory, ".dockerignore");
  const protectedPaths = [
    path.relative(
      buildPaths.contextDirectory,
      buildPaths.absoluteDockerfilePath,
    ),
    path.relative(buildPaths.contextDirectory, ignorePath),
  ].map((filePath) => filePath.replaceAll(path.sep, "/"));
  const dockerIgnore = existsSync(ignorePath)
    ? DockerIgnore.default({ ignorecase: false }).add(
        readFileSync(ignorePath, "utf8"),
      )
    : undefined;

  return pack(buildPaths.contextDirectory, {
    ignore(filePath) {
      const relativePath = path
        .relative(buildPaths.contextDirectory, filePath)
        .replaceAll(path.sep, "/");
      const mustInclude = protectedPaths.some(
        (protectedPath) =>
          relativePath === protectedPath ||
          protectedPath.startsWith(`${relativePath}/`),
      );
      return (
        relativePath !== "" &&
        !mustInclude &&
        dockerIgnore?.ignores(relativePath) === true
      );
    },
  }).pipe(createGzip());
}

function isContainedBy(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

function assertContainedBy(
  parent: string,
  child: string,
  description: string,
): void {
  if (!isContainedBy(parent, child)) {
    throw new Error(
      `${description} must remain inside the repository build context.`,
    );
  }
}

/**
 * Resolves the files Docker receives. The optional setting enables the strict
 * containment checks; omitting it deliberately retains the legacy behavior.
 */
export function resolveDockerBuildPaths(
  repoDirectory: string,
  application: Application,
): DockerBuildPaths {
  const dockerfilePath = getDockerfilePathFromSetting(
    application.DockerfilePath,
  );
  if (application.BuildContextPath === undefined) {
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
    return {
      contextDirectory,
      dockerfilePath: dockerfilePath.dockerfileName,
      absoluteDockerfilePath,
    };
  }

  const buildContextPath = getBuildContextPathFromSetting(
    application.BuildContextPath,
  );
  const absoluteRepoDirectory = path.resolve(repoDirectory);
  const contextDirectory = path.resolve(
    absoluteRepoDirectory,
    buildContextPath,
  );
  const absoluteDockerfilePath = path.resolve(
    absoluteRepoDirectory,
    dockerfilePath.contextDirectory,
    dockerfilePath.dockerfileName,
  );
  assertContainedBy(
    absoluteRepoDirectory,
    contextDirectory,
    "BuildContextPath",
  );
  assertContainedBy(
    absoluteRepoDirectory,
    absoluteDockerfilePath,
    "DockerfilePath",
  );
  assertContainedBy(contextDirectory, absoluteDockerfilePath, "DockerfilePath");

  if (
    !existsSync(contextDirectory) ||
    !statSync(contextDirectory).isDirectory()
  ) {
    throw new Error(
      `BuildContextPath '${application.BuildContextPath}' does not exist or is not a directory.`,
    );
  }
  if (!existsSync(absoluteDockerfilePath)) {
    throw new Error(
      `Dockerfile '${application.DockerfilePath}' does not exist. Expected location: '${absoluteDockerfilePath}'`,
    );
  }

  const resolvedRepoDirectory = realpathSync(absoluteRepoDirectory);
  const resolvedContextDirectory = realpathSync(contextDirectory);
  const resolvedDockerfilePath = realpathSync(absoluteDockerfilePath);
  assertContainedBy(
    resolvedRepoDirectory,
    resolvedContextDirectory,
    "BuildContextPath",
  );
  assertContainedBy(
    resolvedContextDirectory,
    resolvedDockerfilePath,
    "DockerfilePath",
  );

  return {
    contextDirectory: resolvedContextDirectory,
    dockerfilePath: path
      .relative(resolvedContextDirectory, resolvedDockerfilePath)
      .replaceAll("\\", "/"),
    absoluteDockerfilePath: resolvedDockerfilePath,
  };
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
    const containers = await docker.listContainers({
      all: true,
      filters: { name: [name] },
    });
    return containers.find(({ Names }) => Names.includes(`/${name}`));
  }

  /**
   * Waits for a container a concurrent poll is already removing to actually
   * disappear, so this call does not try to create its replacement while the
   * old name is still reserved. Gives up after the same bounded window used
   * for the create-conflict recheck rather than waiting indefinitely; the
   * subsequent create attempt surfaces a real failure if the name is still
   * taken by then.
   */
  async function waitForContainerRemoval(containerId: string): Promise<void> {
    for (
      let attempt = 0;
      attempt < containerConflictRecheckAttempts;
      attempt++
    ) {
      try {
        await docker.getContainer(containerId).inspect();
      } catch (inspectError) {
        if (isContainerNotFound(inspectError)) return;
        throw inspectError;
      }
      await delay(containerConflictRecheckDelayMilliseconds);
    }
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

    const repoDirectory = getApplicationRepoDirectory(settings, application);
    const buildPaths = resolveDockerBuildPaths(repoDirectory, application);
    const violations = validateDockerfileImageReferences(
      readFileSync(buildPaths.absoluteDockerfilePath, "utf8"),
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
      createBuildContext(buildPaths),
      {
        dockerfile: buildPaths.dockerfilePath,
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
    const declaredEnvironment = Object.entries(
      application.EnvironmentVariables ?? {},
    ).map(([name, value]) => `${name}=${value}`);
    const configHash = getContainerConfigHash({
      environmentVariables: declaredEnvironment,
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
      // A concurrent poll can independently reach the same "start" decision
      // for this container and win the race to start it first; that is the
      // desired end state, not a failure.
      try {
        await docker.getContainer(containerPlan.containerId).start();
      } catch (startError) {
        if (!isContainerAlreadyStarted(startError)) throw startError;
      }
      return {
        wasCreated: false,
        wasStarted: true,
        containerId: containerPlan.containerId,
      };
    }

    // Resolve only after planning proves that Docker must create a new
    // container. In particular, an unset host value must not disturb the
    // existing container that a failed recreation would otherwise replace.
    const environment = resolveContainerEnvironmentVariables(
      application.EnvironmentVariables ?? {},
      process.env,
    );

    if (containerPlan.existingContainerId) {
      logger.info(`Removing container ${containerName}`);
      // A concurrent poll cycle can be removing (or have already removed)
      // this same container, e.g. two pollers upgrading the same
      // application at once. Neither outcome is a failure: the container is
      // gone, or on its way out, either way.
      try {
        await docker
          .getContainer(containerPlan.existingContainerId)
          .remove({ force: true });
      } catch (removeError) {
        if (isContainerRemovalInProgress(removeError)) {
          await waitForContainerRemoval(containerPlan.existingContainerId);
        } else if (!isContainerNotFound(removeError)) {
          throw removeError;
        }
      }
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
    let createdContainer: Dockerode.Container;
    try {
      createdContainer = await docker.createContainer({
        Image: getImageVersionTagCommit(application.Name, commit),
        name: containerName,
        Env: environment,
        ExposedPorts: exposedPorts,
        HostConfig: {
          PortBindings: portBindings,
          Binds: binds,
          LogConfig: containerLogConfig,
          RestartPolicy: containerRestartPolicy,
        },
        Labels: { [containerConfigLabelName]: configHash },
      });
    } catch (error) {
      if (!isContainerNameConflict(error)) throw error;

      // Another poll cycle created the container between our findContainer
      // check and this create call. Docker reserves the container name
      // before it registers the container where listContainers can see it,
      // so the winner can briefly be invisible even though the name is
      // already taken; poll for it a few times rather than failing on the
      // first miss.
      let racedContainer = await findContainer(containerName);
      for (
        let attempt = 0;
        !racedContainer && attempt < containerConflictRecheckAttempts;
        attempt++
      ) {
        await delay(containerConflictRecheckDelayMilliseconds);
        racedContainer = await findContainer(containerName);
      }
      const racedPlan = planRacedContainer(
        racedContainer ? asDockerContainer(racedContainer) : undefined,
        commit.hash,
        configHash,
      );
      if (racedPlan.action === "fail") throw error;

      if (racedPlan.action === "adopt") {
        logger.info(
          `Container ${containerName} was already created by a concurrent poll; reusing it`,
        );
        return {
          wasCreated: false,
          wasStarted: false,
          containerId: racedPlan.containerId,
        };
      }
      logger.info(
        `Container ${containerName} was already created by a concurrent poll; starting it`,
      );
      try {
        await docker.getContainer(racedPlan.containerId).start();
      } catch (startError) {
        if (!isContainerAlreadyStarted(startError)) throw startError;
      }
      return {
        wasCreated: false,
        wasStarted: true,
        containerId: racedPlan.containerId,
      };
    }
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
    const runtime = container
      ? await inspectRuntimeStatus(container.Id)
      : undefined;
    return {
      latestImageHash: image?.Labels[imageCommitLabelName],
      // The inspected state decides this, not the list state: Docker's list
      // API reports a crash-looping container as running, and calling that the
      // latest running version is the confusion this whole status exists to
      // remove.
      runningContainerHash:
        container && runtime?.state === "running"
          ? container.Labels[imageCommitLabelName]
          : undefined,
      container: runtime,
    };
  }

  async function inspectRuntimeStatus(
    containerId: string,
  ): Promise<ContainerRuntimeStatus> {
    const { State, RestartCount } = await docker
      .getContainer(containerId)
      .inspect();
    return {
      state: State.Status,
      // Docker reports 0 for a container that is running or has never run at
      // all, which both read as a clean exit. Report the code only once there
      // has been one. A restarting container is `Running` while Docker waits
      // out its backoff, and its last exit code is the whole point of asking.
      exitCode: hasExited(State) ? State.ExitCode : undefined,
      restartCount: RestartCount,
    };
  }

  async function getContainerLogs(
    application: Application,
    tailLines: number,
  ): Promise<ContainerLogs | undefined> {
    const container = await findContainer(getContainerName(application));
    if (!container) return undefined;

    // The inspected state, for the same reason `getDockerStatus` uses it: the
    // list state would label a crash-looping container as running, right above
    // the output showing it crash.
    const runtime = await inspectRuntimeStatus(container.Id);
    // `follow: false` makes dockerode resolve the whole response as a buffer
    // rather than hand back a live stream, which is what a bounded tail wants.
    const raw = (await docker.getContainer(container.Id).logs({
      stdout: true,
      stderr: true,
      timestamps: true,
      tail: tailLines,
    })) as unknown as Buffer;
    const { text, truncated } = limitLogBytes(decodeContainerLog(raw));
    return { containerState: runtime.state, text, truncated };
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
    // Containers no longer back a declared Application, so they are removed
    // rather than stopped (ADR-0009). Without `AutoRemove` a stop alone would
    // leave the container behind, holding a reference to the image below and
    // occupying its Application's slot indefinitely.
    for (const container of containers) {
      await docker.getContainer(container.Id).remove({ force: true });
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
    getContainerLogs,
    cleanupInactive,
    cleanupAll,
    cleanupTestCreated,
  };
}
