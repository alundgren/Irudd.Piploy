import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { z } from "zod";

const portMappingPattern = /^(\d+):(\d+)$/;

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

const ApplicationSchema = z.object({
  Name: z.string().regex(/^[A-Za-z0-9_-]+$/),
  GitRepositoryUrl: z.string(),
  DockerfilePath: z.string().optional(),
  PortMappings: z.array(PortMappingSchema).optional(),
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
export type Application = z.infer<typeof ApplicationSchema>;
export type PiploySettings = z.infer<typeof PiploySettingsSchema>;

export function parseSettings(json: unknown): PiploySettings {
  return ConfigFileSchema.parse(json).Piploy;
}

export function loadSettings(configPath: string): PiploySettings {
  const raw = readFileSync(configPath, "utf8");
  return parseSettings(JSON.parse(raw));
}

/** `piploy.json` resolves relative to the running bundle, not CWD, with a `PIPLOY_CONFIG` override (#8). */
export function resolveConfigPath(
  bundleDir: string = defaultBundleDirectory(),
): string {
  return process.env.PIPLOY_CONFIG ?? path.join(bundleDir, "piploy.json");
}

function defaultBundleDirectory(): string {
  return path.dirname(fileURLToPath(import.meta.url));
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
