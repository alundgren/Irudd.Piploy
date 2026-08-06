import { createHash } from "node:crypto";

export interface DockerImage {
  id: string;
}

export interface DockerContainer {
  id: string;
  state: string;
  gitTipCommit?: string;
  configHash?: string;
}

export interface ContainerConfiguration {
  environmentVariables?: readonly string[];
  volumes?: readonly string[];
  portMappings?: readonly {
    hostPort: number;
    containerPort: number;
  }[];
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

export interface DockerfileImageReferenceViolation {
  reference: string;
  reason: string;
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
  configHash: string,
): ContainerPlan {
  if (!existingContainer) {
    return { action: "recreate" };
  }

  if (
    existingContainer.gitTipCommit === gitTipCommit &&
    existingContainer.configHash === configHash
  ) {
    if (existingContainer.state === "running") {
      return { action: "reuse", containerId: existingContainer.id };
    }
    if (existingContainer.state === "exited") {
      return { action: "start", containerId: existingContainer.id };
    }
  }

  return { action: "recreate", existingContainerId: existingContainer.id };
}

/**
 * Produces a stable identity for the settings which affect a container at
 * runtime. Arrays are sorted because their configuration order is not
 * meaningful to Docker.
 */
export function getContainerConfigHash(
  configuration: ContainerConfiguration,
): string {
  const normalized = {
    environmentVariables: [
      ...(configuration.environmentVariables ?? []),
    ].sort(),
    volumes: [...(configuration.volumes ?? [])].sort(),
    portMappings: [...(configuration.portMappings ?? [])].sort(
      (left, right) =>
        left.hostPort - right.hostPort ||
        left.containerPort - right.containerPort,
    ),
  };
  return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
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

/**
 * Finds every external image reference that is outside Piploy's immutable
 * base-image allowlist. This intentionally parses only the Dockerfile
 * instructions relevant to image resolution; Docker remains responsible for
 * interpreting the rest of the Dockerfile.
 */
export function validateDockerfileImageReferences(
  dockerfile: string,
): DockerfileImageReferenceViolation[] {
  const violations: DockerfileImageReferenceViolation[] = [];
  const stageNames = new Set<string>();
  let stageCount = 0;

  for (const line of dockerfileInstructions(dockerfile)) {
    const from = parseFromInstruction(line);
    if (from) {
      const reference = from.reference;
      validateExternalReference(reference, stageNames, stageCount, violations);
      stageCount += 1;
      if (from.stageName) stageNames.add(from.stageName);
      continue;
    }

    if (!/^COPY\s/i.test(line)) continue;
    const reference = copyFromReference(line);
    if (reference) {
      validateExternalReference(reference, stageNames, stageCount, violations);
    }
  }

  return violations;
}

function dockerfileInstructions(dockerfile: string): string[] {
  const instructions: string[] = [];
  let current = "";

  for (const rawLine of dockerfile.split(/\r?\n/)) {
    const line = rawLine.trim().replace(/\s+#.*$/, "");
    if (!line || line.startsWith("#")) continue;
    const continued = /\\\s*$/.test(line);
    current += `${line.replace(/\\\s*$/, "")} `;
    if (!continued) {
      instructions.push(current.trim());
      current = "";
    }
  }
  if (current) instructions.push(current.trim());
  return instructions;
}

function parseFromInstruction(
  line: string,
): { reference: string; stageName?: string } | undefined {
  const instruction = line.match(/^FROM\s+(.+)$/i);
  if (!instruction) return undefined;

  const tokens = instruction[1]!.split(/\s+/);
  let index = 0;
  while (tokens[index]?.startsWith("--")) {
    index += 1;
    if (tokens[index - 1] === "--platform") index += 1;
  }

  const reference = tokens[index] ?? "<missing FROM reference>";
  const stageName =
    tokens[index + 1]?.toUpperCase() === "AS" ? tokens[index + 2] : undefined;
  return { reference, stageName };
}

function copyFromReference(line: string): string | undefined {
  const tokens = line.split(/\s+/);
  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.startsWith("--from=")) return token.slice("--from=".length);
    if (token === "--from") return tokens[index + 1];
  }
  return undefined;
}

function validateExternalReference(
  reference: string,
  stageNames: ReadonlySet<string>,
  stageCount: number,
  violations: DockerfileImageReferenceViolation[],
): void {
  if (
    reference === "scratch" ||
    stageNames.has(reference) ||
    (/^\d+$/.test(reference) && Number(reference) < stageCount)
  ) {
    return;
  }

  const normalized = normalizeOfficialImage(reference);
  if (reference === "<missing FROM reference>") {
    violations.push({
      reference,
      reason: "is not statically resolvable",
    });
  } else if (hasUnresolvedVariable(reference)) {
    violations.push({
      reference,
      reason: "contains an unresolved Dockerfile variable",
    });
  } else if (!hasSha256Digest(reference)) {
    violations.push({
      reference,
      reason: "must be pinned with an @sha256 digest",
    });
  } else if (
    normalized?.startsWith("docker.io/library/") ||
    /^mcr\.microsoft\.com\/dotnet\/.+@sha256:[a-f\d]{64}$/i.test(reference)
  ) {
    return;
  } else {
    violations.push({
      reference,
      reason:
        "must be a Docker Official Image or mcr.microsoft.com/dotnet image",
    });
  }
}

function hasUnresolvedVariable(reference: string): boolean {
  return reference.includes("$");
}

function hasSha256Digest(reference: string): boolean {
  return /@sha256:[a-f\d]{64}$/i.test(reference);
}

function normalizeOfficialImage(reference: string): string | undefined {
  if (!reference.includes("/")) return `docker.io/library/${reference}`;
  if (reference.startsWith("library/")) return `docker.io/${reference}`;
  if (reference.startsWith("docker.io/library/")) return reference;
  return undefined;
}
