const fromInstructionPattern =
  /^(?:--platform=\S+\s+)?(\S+)(?:\s+[Aa][Ss]\s+(\S+))?$/;
const copyFromFlagPattern = /(?:^|\s)--from=(\S+)/i;
const digestReferencePattern = /^(.+?)(?::[^/@]+)?@sha256:[0-9a-f]{64}$/;

/**
 * Validates every external `FROM` and external `COPY --from` reference in a
 * Dockerfile against the supply-chain policy settled in issue #20: only
 * immutable `@sha256` references from Docker Official Images
 * (`docker.io/library/*`, including short names) or `mcr.microsoft.com/dotnet/*`
 * are permitted. `scratch` and prior build stages are not registry references
 * and are always allowed. Throws on the first violation.
 */
export function validateDockerfileImageReferences(
  dockerfileContents: string,
): void {
  const stageNames = new Set<string>();
  let stageCount = 0;

  for (const instruction of readInstructions(dockerfileContents)) {
    const spaceIndex = instruction.search(/\s/);
    const keyword = (
      spaceIndex === -1 ? instruction : instruction.slice(0, spaceIndex)
    ).toUpperCase();
    const args =
      spaceIndex === -1 ? "" : instruction.slice(spaceIndex + 1).trim();

    if (keyword === "FROM") {
      const match = fromInstructionPattern.exec(args);
      if (!match) {
        throw new Error(
          `Dockerfile FROM instruction has no resolvable image reference: '${instruction}'`,
        );
      }
      const [, reference, alias] = match;
      validateReference(reference!, "FROM", stageNames, stageCount);
      if (alias) stageNames.add(alias);
      stageCount++;
    } else if (keyword === "COPY") {
      const fromFlag = copyFromFlagPattern.exec(args);
      if (fromFlag) {
        validateReference(fromFlag[1]!, "COPY --from", stageNames, stageCount);
      }
    }
  }
}

function validateReference(
  rawReference: string,
  instruction: "FROM" | "COPY --from",
  stageNames: Set<string>,
  stageCount: number,
): void {
  const reference = rawReference.replace(/^['"]|['"]$/g, "");

  if (reference.toLowerCase() === "scratch") return;
  if (stageNames.has(reference)) return;
  if (/^\d+$/.test(reference) && Number(reference) < stageCount) return;

  if (reference.includes("$")) {
    throw new Error(
      `Dockerfile ${instruction} uses a dynamic, unresolved external image reference: '${reference}'`,
    );
  }

  const digestMatch = digestReferencePattern.exec(reference);
  if (!digestMatch) {
    throw new Error(
      `Dockerfile ${instruction} external image '${reference}' must be pinned to an immutable @sha256 digest.`,
    );
  }

  const name = normalizeImageName(digestMatch[1]!);
  const isDockerOfficialImage = name.startsWith("library/");
  const isMicrosoftDotnetImage = name.startsWith("mcr.microsoft.com/dotnet/");
  if (!isDockerOfficialImage && !isMicrosoftDotnetImage) {
    throw new Error(
      `Dockerfile ${instruction} external image '${reference}' is not from an approved registry namespace (docker.io/library or mcr.microsoft.com/dotnet).`,
    );
  }
}

function normalizeImageName(name: string): string {
  const withoutDefaultRegistry = name.startsWith("docker.io/")
    ? name.slice("docker.io/".length)
    : name;
  return withoutDefaultRegistry.includes("/")
    ? withoutDefaultRegistry
    : `library/${withoutDefaultRegistry}`;
}

function* readInstructions(dockerfileContents: string): Generator<string> {
  let logicalLine = "";
  for (const line of dockerfileContents.split("\n")) {
    const trimmed = line.trim();
    if (
      logicalLine.length === 0 &&
      (trimmed.length === 0 || trimmed.startsWith("#"))
    ) {
      continue;
    }

    const continued = trimmed.endsWith("\\");
    const content = continued ? trimmed.slice(0, -1).trim() : trimmed;
    logicalLine =
      logicalLine.length === 0 ? content : `${logicalLine} ${content}`;

    if (!continued) {
      yield logicalLine.trim();
      logicalLine = "";
    }
  }

  if (logicalLine.length > 0) {
    yield logicalLine.trim();
  }
}
