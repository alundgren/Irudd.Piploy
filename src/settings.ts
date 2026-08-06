import { readFileSync } from "node:fs";
import path from "node:path";

import { z } from "zod";

const portMappingPattern = /^(\d+):(\d+)$/;
// The container path is a plain absolute path: no colons, because Docker reads
// a third bind field as mount options, and at least one segment, because the
// container root is not a mount point.
const volumePattern = /^([A-Za-z0-9_-]+):((?:\/[^:/]+)+\/?)$/;

const PortMappingSchema = z.string().transform((value, ctx) => {
  const match = portMappingPattern.exec(value);
  if (!match) {
    ctx.addIssue({
      code: "custom",
      message:
        "Invalid port mappings. Must have the format <hostPort>:<containerPort>",
    });
    return z.NEVER;
  }
  return {
    hostPort: Number(match[1]),
    containerPort: Number(match[2]),
  };
});

const VolumeSchema = z.string().transform((value, ctx) => {
  const match = volumePattern.exec(value);
  if (!match || value.includes("..")) {
    ctx.addIssue({
      code: "custom",
      message:
        "Invalid volumes. Must have the format <name>:/container/path; host paths, mount options, and '..' are not allowed",
    });
    return z.NEVER;
  }
  return { name: match[1]!, containerPath: match[2]! };
});

const ApplicationSchema = z
  .object({
    Name: z.string().regex(/^[A-Za-z0-9_-]+$/),
    GitRepositoryUrl: z.string(),
    DockerfilePath: z.string(),
    PortMappings: z.array(PortMappingSchema).optional(),
    Volumes: z.array(VolumeSchema).optional(),
    EnvironmentVariables: z.record(z.string(), z.string()).optional(),
  })
  .superRefine((application, ctx) => {
    const containerPaths = (application.Volumes ?? []).map(
      (volume) => volume.containerPath,
    );
    if (new Set(containerPaths).size !== containerPaths.length) {
      ctx.addIssue({
        code: "custom",
        message:
          "Invalid volumes. Two Volumes of one Application cannot share a container path",
      });
    }
  });

const PiploySettingsSchema = z.object({
  RootDirectory: z.string(),
  MinutesBetweenBackgroundPolls: z.number().optional(),
  Applications: z.array(ApplicationSchema),
  IsTestRun: z.boolean().optional(),
});

const ConfigFileSchema = z.object({
  Piploy: PiploySettingsSchema,
});

export type PortMapping = { hostPort: number; containerPort: number };
export type Volume = { name: string; containerPath: string };
export type Application = z.infer<typeof ApplicationSchema>;
export type PiploySettings = z.infer<typeof PiploySettingsSchema>;

export function parseSettings(json: unknown): PiploySettings {
  return ConfigFileSchema.parse(json).Piploy;
}

export function loadSettings(configPath: string): PiploySettings {
  const raw = readFileSync(configPath, "utf8");
  const settings = parseSettings(JSON.parse(raw));
  assertDataDirectoryIsSeparateFromRootDirectory(settings, configPath);
  return settings;
}

function containsDirectory(directory: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(directory), candidate);
  return (
    relative === "" ||
    (!relative.startsWith(`..${path.sep}`) &&
      relative !== ".." &&
      !path.isAbsolute(relative))
  );
}

/**
 * `wipeall` hands RootDirectory to a recursive forced delete, so Application
 * data only survives it while the two trees are disjoint. RootDirectory is
 * free-form, so nothing but this check keeps them that way (ADR-0005).
 */
function assertDataDirectoryIsSeparateFromRootDirectory(
  settings: PiploySettings,
  configPath: string,
): void {
  const dataDirectory = getDataDirectory(configPath);
  const rootDirectory = settings.RootDirectory;
  if (
    containsDirectory(rootDirectory, dataDirectory) ||
    containsDirectory(dataDirectory, rootDirectory)
  ) {
    throw new Error(
      `Invalid RootDirectory '${rootDirectory}'. It overlaps the application data directory '${dataDirectory}', which wipeall would then delete. Point RootDirectory at a directory outside it.`,
    );
  }
}

/** `piploy.json` resolves relative to the running bundle, not CWD, with a `PIPLOY_CONFIG` override (#8). */
export function resolveConfigPath(
  bundleDir: string = resolveBundleDirectory(),
): string {
  return process.env.PIPLOY_CONFIG ?? path.join(bundleDir, "piploy.json");
}

/** The directory containing the running Piploy bundle. */
export function resolveBundleDirectory(): string {
  return path.dirname(process.argv[1] ?? process.cwd());
}

/**
 * The directory where Piploy keeps Application data that must outlive
 * containers. Always absolute: Docker rejects a relative bind mount source.
 */
export function getDataDirectory(
  configPath: string = resolveConfigPath(),
): string {
  return path.resolve(path.dirname(configPath), "data");
}

/** The directory holding all of one Application's Volumes. */
export function getApplicationDataDirectory(application: Application): string {
  return path.join(getDataDirectory(), application.Name);
}

/** Resolves a configured Volume to its Piploy-owned host directory. */
export function getVolumeDirectory(
  application: Application,
  volume: Volume,
): string {
  return path.join(getApplicationDataDirectory(application), volume.name);
}

export function getApplicationRootDirectory(
  settings: PiploySettings,
  application: Application,
): string {
  return path.join(settings.RootDirectory, application.Name);
}

export function getApplicationRepoDirectory(
  settings: PiploySettings,
  application: Application,
): string {
  return path.join(getApplicationRootDirectory(settings, application), "repo");
}
