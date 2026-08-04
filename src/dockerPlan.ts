export interface DockerImage {
  id: string;
}

export interface DockerContainer {
  id: string;
  state: string;
  gitTipCommit?: string;
}

export type ImagePlan =
  { action: "reuse"; imageId: string } | { action: "build" };

export type ContainerPlan =
  | { action: "reuse"; containerId: string }
  | { action: "start"; containerId: string }
  | { action: "recreate"; existingContainerId?: string };

export interface DockerfilePath {
  contextDirectory: string;
  dockerfileName: string;
}

const invalidDockerfilePathMessage =
  "Invalid DockerfilePath. It must point to a dockerfile relative to the repository root. Examples: 'Dockerfile' or 'SubDirectory/Dockerfile' or Dockerfile.custom'";

export function planImage(existingImage?: DockerImage): ImagePlan {
  return existingImage
    ? { action: "reuse", imageId: existingImage.id }
    : { action: "build" };
}

export function planContainer(
  existingContainer: DockerContainer | undefined,
  gitTipCommit: string,
): ContainerPlan {
  if (!existingContainer) {
    return { action: "recreate" };
  }

  if (existingContainer.gitTipCommit === gitTipCommit) {
    if (existingContainer.state === "running") {
      return { action: "reuse", containerId: existingContainer.id };
    }
    if (existingContainer.state === "exited") {
      return { action: "start", containerId: existingContainer.id };
    }
  }

  return { action: "recreate", existingContainerId: existingContainer.id };
}

/** Converts the config setting into a Docker build context and its Dockerfile. */
export function getDockerfilePathFromSetting(
  dockerfilePath: string,
): DockerfilePath {
  let normalized = dockerfilePath.replaceAll("\\", "/").trim();
  normalized = normalized.startsWith("/") ? normalized.slice(1) : normalized;

  if (normalized.endsWith("/")) {
    throw new Error(invalidDockerfilePathMessage);
  }

  const segments = normalized.split("/");
  const dockerfileName = segments.at(-1)!;
  return {
    contextDirectory: segments.slice(0, -1).join("/"),
    dockerfileName,
  };
}
