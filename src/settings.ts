import { createHash } from "node:crypto";
import {
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

import { z } from "zod";

import { getBuildContextPathFromSetting } from "./dockerPlan.js";
import { isDuplicateApplicationName } from "./registerPolicy.js";

const portMappingPattern = /^(\d+):(\d+)$/;
const hostEnvironmentReferencePattern =
  /^\$\{hostEnv:([A-Za-z_][A-Za-z0-9_]*)\}$/;
const githubOwnerPattern =
  /^(?=.{1,39}$)(?!.*--)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
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

const BuildContextPathSchema = z.string().superRefine((value, ctx) => {
  try {
    getBuildContextPathFromSetting(value);
  } catch (error) {
    ctx.addIssue({
      code: "custom",
      message: error instanceof Error ? error.message : String(error),
    });
  }
});

/** Returns the referenced daemon environment-variable name for an exact reference. */
export function parseHostEnvironmentReference(
  value: string,
): string | undefined {
  return hostEnvironmentReferencePattern.exec(value)?.[1];
}

const HostEnvironmentReferenceSchema = z.string().superRefine((value, ctx) => {
  if (parseHostEnvironmentReference(value) === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "Must be an exact ${hostEnv:NAME} reference",
    });
  }
});

const GitHubOwnerCredentialsSchema = z.record(
  z
    .string()
    .regex(
      githubOwnerPattern,
      "GitHub owner must be canonical lowercase letters, digits, or hyphens",
    ),
  HostEnvironmentReferenceSchema,
);

export const ApplicationSchema = z
  .object({
    Name: z.string().regex(/^[A-Za-z0-9_-]+$/),
    GitRepositoryUrl: z.string(),
    DockerfilePath: z.string(),
    BuildContextPath: BuildContextPathSchema.optional(),
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
  GitHubOwnerCredentials: GitHubOwnerCredentialsSchema.optional(),
  IsTestRun: z.boolean().optional(),
});

const ConfigFileSchema = z.object({
  Piploy: PiploySettingsSchema,
});

export type PortMapping = { hostPort: number; containerPort: number };
export type Volume = { name: string; containerPath: string };
export type Application = z.infer<typeof ApplicationSchema>;
export type PiploySettings = z.infer<typeof PiploySettingsSchema>;
export interface LoadedConfiguration {
  settings: PiploySettings;
  revision: string;
}

export function parseSettings(json: unknown): PiploySettings {
  return ConfigFileSchema.parse(json).Piploy;
}

export function calculateConfigurationRevision(raw: string | Buffer): string {
  return createHash("sha256").update(raw).digest("hex");
}

export function readConfigurationRevision(configPath: string): string | null {
  try {
    return calculateConfigurationRevision(readFileSync(configPath));
  } catch {
    return null;
  }
}

/** Reads once so the revision identifies the exact bytes that produced the settings. */
export function loadConfiguration(configPath: string): LoadedConfiguration {
  const raw = readFileSync(configPath, "utf8");
  const settings = parseSettings(JSON.parse(raw));
  assertDataDirectoryIsSeparateFromRootDirectory(settings, configPath);
  return {
    settings,
    revision: calculateConfigurationRevision(raw),
  };
}

export function loadSettings(configPath: string): PiploySettings {
  return loadConfiguration(configPath).settings;
}

export type RegisterApplicationFailure =
  "invalid-application" | "duplicate-application";

/** A register request rejected on its own merits, not on an I/O failure. */
export class RegisterApplicationError extends Error {
  constructor(
    readonly reason: RegisterApplicationFailure,
    message: string,
  ) {
    super(message);
    this.name = "RegisterApplicationError";
  }
}

export class ConfigurationChangedError extends Error {
  constructor() {
    super("piploy.json differs from the configuration loaded by the service");
    this.name = "ConfigurationChangedError";
  }
}

function describeValidationError(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.path.length > 0
        ? `${issue.path.join(".")}: ${issue.message}`
        : issue.message,
    )
    .join("; ");
}

/**
 * Validates one candidate Application, throwing the same rejection a daemon
 * register request would produce. Shared so the CLI can reject bad input before
 * a round trip and report it the same way the daemon would.
 */
export function parseApplication(rawApplication: unknown): Application {
  const parsed = ApplicationSchema.safeParse(rawApplication);
  if (!parsed.success) {
    throw new RegisterApplicationError(
      "invalid-application",
      describeValidationError(parsed.error),
    );
  }
  return parsed.data;
}

/**
 * Adds one Application to `piploy.json`. The raw input is what gets persisted:
 * `PortMappings` and `Volumes` are strings on disk and only the parsed value is
 * transformed, so writing the transformed Application back would produce a
 * config the schema then rejects.
 */
export function registerApplication(
  configPath: string,
  rawApplication: unknown,
  expectedRevision: string,
): { application: Application; revision: string } {
  const application = parseApplication(rawApplication);

  const currentRaw = readFileSync(configPath, "utf8");
  if (calculateConfigurationRevision(currentRaw) !== expectedRevision) {
    throw new ConfigurationChangedError();
  }
  const currentConfig = JSON.parse(currentRaw) as unknown;
  // An invalid file here is a broken installation, not a bad request, so it
  // propagates rather than becoming a register-specific rejection.
  const currentSettings = parseSettings(currentConfig);
  if (
    isDuplicateApplicationName(currentSettings.Applications, application.Name)
  ) {
    throw new RegisterApplicationError(
      "duplicate-application",
      `An application named '${application.Name}' is already registered`,
    );
  }

  const nextConfig = structuredClone(currentConfig) as {
    Piploy: { Applications: unknown[] };
  };
  nextConfig.Piploy.Applications = [
    ...nextConfig.Piploy.Applications,
    rawApplication,
  ];
  try {
    assertDataDirectoryIsSeparateFromRootDirectory(
      parseSettings(nextConfig),
      configPath,
    );
  } catch (error) {
    throw new RegisterApplicationError(
      "invalid-application",
      error instanceof z.ZodError
        ? describeValidationError(error)
        : error instanceof Error
          ? error.message
          : String(error),
    );
  }

  const nextRaw = JSON.stringify(nextConfig, null, 2) + "\n";
  writeConfigAtomically(configPath, nextRaw);
  return {
    application,
    revision: calculateConfigurationRevision(nextRaw),
  };
}

/**
 * Writes the config through a temporary file in the same directory, so a crash
 * mid-write leaves the previous `piploy.json` intact rather than a truncated
 * one the daemon would refuse to start from.
 */
function writeConfigAtomically(
  configPath: string,
  serializedConfig: string,
): void {
  const temporaryPath = `${configPath}.tmp-${process.pid.toString()}`;
  try {
    writeFileSync(temporaryPath, serializedConfig, {
      // Keep whatever the operator set on the existing file: a rename replaces
      // the inode, so the mode has to be carried over explicitly.
      mode: statSync(configPath).mode & 0o777,
    });
    renameSync(temporaryPath, configPath);
  } catch (error) {
    try {
      unlinkSync(temporaryPath);
    } catch {
      // The temporary file was never created, or is already gone.
    }
    throw error;
  }
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
