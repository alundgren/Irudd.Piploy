import { rmSync } from "node:fs";

import {
  createDaemonDeps,
  requestDaemon,
  startDaemon,
  type Daemon,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatus,
} from "./daemon.js";
import { createDockerService } from "./docker.js";
import type { Logger } from "./logger.js";
import type { PollApplicationResult } from "./orchestrator.js";
import type { PiploySettings } from "./settings.js";
import {
  getApplicationDataDirectory,
  parseApplication,
  RegisterApplicationError,
} from "./settings.js";
import { piployVersion } from "./version.js";

/** A daemon register response, or `undefined` when no daemon answered. */
export type RegisterResult = DaemonResponse | undefined;

export interface CommandDeps {
  requestDaemon(request: DaemonRequest): Promise<DaemonResponse | undefined>;
  computeStatusInline(): Promise<DaemonStatus>;
  pollInline(): Promise<PollApplicationResult[]>;
  register(application: unknown): Promise<RegisterResult>;
  wipeAll(): Promise<void>;
  getPreservedApplicationDataDirectories(): string[];
  startDaemon(): Promise<Daemon>;
}

/** Wires CLI commands to the one real daemon, orchestration, and Docker adapters. */
export function createCommandDeps(
  settings: PiploySettings,
  logger: Logger,
): CommandDeps {
  const daemonDeps = createDaemonDeps(settings, logger);
  return {
    requestDaemon,
    computeStatusInline: daemonDeps.getStatus,
    pollInline: daemonDeps.poll,
    register: (application) =>
      requestDaemon({ command: "register", application }),
    async wipeAll() {
      try {
        await createDockerService(settings, logger).cleanupAll();
      } finally {
        rmSync(settings.RootDirectory, { recursive: true, force: true });
      }
    },
    getPreservedApplicationDataDirectories: () =>
      settings.Applications.filter(
        (application) => (application.Volumes?.length ?? 0) > 0,
      ).map(getApplicationDataDirectory),
    startDaemon: () => startDaemon(settings, logger),
  };
}

/** The one place a command's failure sets both the message and the exit code. */
export function commandFailed(message: string): void {
  console.error(message);
  process.exitCode = 1;
}

function printStatus(status: DaemonStatus, daemonReachable: boolean): void {
  console.log(`Piploy version: ${piployVersion}`);
  console.log(
    `Background service: ${daemonReachable ? "running" : "not running"}`,
  );
  for (const application of status.applications) {
    console.log(`\n${application.application}`);
    console.log(
      `  Running latest version: ${application.isRunningLatestVersion ? "yes" : "no"}`,
    );
    console.log(
      `  Latest local commit: ${application.git?.local.hash ?? "none"}`,
    );
    console.log(
      `  Latest remote commit: ${application.git?.remote.hash ?? "none"}`,
    );
    console.log(
      `  Latest image hash: ${application.docker.latestImageHash ?? "none"}`,
    );
    console.log(
      `  Running container hash: ${application.docker.runningContainerHash ?? "none"}`,
    );
    console.log(
      `  Port mappings: ${application.portMappings.length === 0 ? "none" : application.portMappings.map(({ hostPort, containerPort }) => `${hostPort}:${containerPort}`).join(", ")}`,
    );
  }
}

/** Prints daemon status, falling back to local git/Docker state only when unreachable. */
export async function status(deps: CommandDeps): Promise<void> {
  const response = await deps.requestDaemon({ command: "status" });
  if (response === undefined) {
    printStatus(await deps.computeStatusInline(), false);
    return;
  }
  if (!response.ok) {
    if (response.reason === "poll-in-progress") {
      console.log(`Piploy version: ${piployVersion}`);
      console.log("Background service: running");
      console.log("\nAn install is in progress. Try again shortly.");
      return;
    }
    commandFailed(`Daemon status request failed: ${response.reason}`);
    return;
  }
  if (!("status" in response)) {
    commandFailed("Daemon status request returned no status");
    return;
  }
  printStatus(response.status, true);
}

/** Requests an immediate daemon poll, or reconciles inline when no daemon is running. */
export async function poll(deps: CommandDeps): Promise<void> {
  const response = await deps.requestDaemon({ command: "poll" });
  if (response === undefined) {
    printPollResult(await deps.pollInline());
    return;
  }
  if (!response.ok) {
    commandFailed(`Daemon poll request failed: ${response.reason}`);
    return;
  }
  if ("applications" in response) {
    printPollResult(response.applications);
    return;
  }
  console.log("Poll completed.");
}

function printPollResult(applications: PollApplicationResult[]): void {
  const failures = applications.filter((application) => !application.ok);
  if (failures.length === 0) {
    console.log("Poll completed.");
    return;
  }
  console.log("Poll completed with failures:");
  for (const failure of failures) {
    console.log(
      `  ${failure.application} (${failure.stage}): ${failure.message}`,
    );
  }
}

/** The `register` flags commander collects, before they become an Application. */
export interface RegisterOptions {
  json?: string;
  name?: string;
  gitRepositoryUrl?: string;
  dockerfilePath?: string;
  portMapping?: string[];
  volume?: string[];
  env?: string[];
}

export type ParsedRegisterOptions =
  { ok: true; application: unknown } | { ok: false; message: string };

type ParsedEnvironmentVariables =
  | { ok: true; environmentVariables: Record<string, string> }
  | { ok: false; message: string };

function parseEnvironmentVariables(
  values: string[],
): ParsedEnvironmentVariables {
  const environmentVariables: Record<string, string> = {};
  for (const value of values) {
    // Only the first '=' separates: a value may legitimately contain more.
    const separator = value.indexOf("=");
    if (separator < 1) {
      return {
        ok: false,
        message: `Invalid --env '${value}'. Must have the format KEY=VALUE`,
      };
    }
    environmentVariables[value.slice(0, separator)] = value.slice(
      separator + 1,
    );
  }
  return { ok: true, environmentVariables };
}

function buildApplicationFromFlags(
  options: RegisterOptions,
): Record<string, unknown> {
  // Optional fields stay absent rather than empty, so a flagless invocation
  // produces the same document an operator would have hand-written.
  const application: Record<string, unknown> = {
    Name: options.name,
    GitRepositoryUrl: options.gitRepositoryUrl,
    DockerfilePath: options.dockerfilePath,
  };
  if (options.portMapping?.length) {
    application.PortMappings = options.portMapping;
  }
  if (options.volume?.length) application.Volumes = options.volume;
  return application;
}

/**
 * Turns `register` flags into the raw Application to send. Raw, not parsed:
 * the daemon persists exactly what it receives, and `PortMappings`/`Volumes`
 * are strings on disk. Validation runs here only to fail with a CLI message
 * instead of a daemon rejection reason.
 */
export function parseRegisterOptions(
  options: RegisterOptions,
): ParsedRegisterOptions {
  const usesFlags =
    options.name !== undefined ||
    options.gitRepositoryUrl !== undefined ||
    options.dockerfilePath !== undefined ||
    (options.portMapping?.length ?? 0) > 0 ||
    (options.volume?.length ?? 0) > 0 ||
    (options.env?.length ?? 0) > 0;

  let application: unknown;
  if (options.json !== undefined) {
    if (usesFlags) {
      return {
        ok: false,
        message: "Use either --json or the individual flags, not both.",
      };
    }
    try {
      application = JSON.parse(options.json);
    } catch (error) {
      return {
        ok: false,
        message: `Invalid --json. ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  } else {
    const parsedEnvironment = parseEnvironmentVariables(options.env ?? []);
    if (!parsedEnvironment.ok) return parsedEnvironment;
    const fromFlags = buildApplicationFromFlags(options);
    if (Object.keys(parsedEnvironment.environmentVariables).length > 0) {
      fromFlags.EnvironmentVariables = parsedEnvironment.environmentVariables;
    }
    application = fromFlags;
  }

  try {
    parseApplication(application);
  } catch (error) {
    if (!(error instanceof RegisterApplicationError)) throw error;
    return { ok: false, message: `Invalid application. ${error.message}` };
  }
  return { ok: true, application };
}

/**
 * Registers one Application with the running daemon. There is no inline
 * fallback: register exists to reach the live daemon's settings, and writing
 * the file alone would still need a restart (ADR-0007).
 */
export async function register(
  deps: CommandDeps,
  application: unknown,
): Promise<void> {
  const response = await deps.register(application);
  if (response === undefined) {
    commandFailed(
      "Background service not running. Start it, then run 'piploy register' again.",
    );
    return;
  }
  if (!response.ok) {
    commandFailed(
      "message" in response
        ? `Register failed: ${response.reason}. ${response.message}`
        : `Daemon register request failed: ${response.reason}`,
    );
    return;
  }
  if (!("application" in response)) {
    commandFailed("Daemon register request returned no application");
    return;
  }
  console.log(`Registered application ${response.application.Name}.`);
}

/** Asks the running daemon to stop without falling back to a local action. */
export async function serviceStop(deps: CommandDeps): Promise<void> {
  const response = await deps.requestDaemon({ command: "stop" });
  if (response === undefined) {
    commandFailed("No Piploy daemon is reachable.");
    return;
  }
  if (!response.ok) {
    commandFailed(`Daemon stop request failed: ${response.reason}`);
    return;
  }
  console.log("Piploy daemon stopped.");
}

/**
 * Stops the live daemon after a CLI self-update so systemd restarts it from
 * the newly swapped bundle. This uses Piploy's private control socket rather
 * than requiring the invoking user to have permission for `systemctl`.
 */
export async function restartDaemonAfterUpdate(
  request: CommandDeps["requestDaemon"],
): Promise<void> {
  const response = await request({ command: "stop" });
  if (response === undefined) {
    commandFailed(
      "Piploy update installed, but no daemon is reachable to restart.",
    );
    return;
  }
  if (!response.ok) {
    commandFailed(
      `Piploy update installed, but daemon restart failed: ${response.reason}`,
    );
    return;
  }
  console.log("Piploy update installed; restarting daemon.");
}

/** Cleans up all Piploy Docker resources and removes the configured root directory. */
export async function wipeAll(deps: CommandDeps): Promise<void> {
  await deps.wipeAll();
  console.log("Removed all Piploy containers, images, and files.");
  for (const directory of deps.getPreservedApplicationDataDirectories()) {
    console.log(`Preserved application data: ${directory}`);
  }
}

/** Starts the foreground daemon and lets SIGINT/SIGTERM stop it cleanly. */
export async function serviceStart(deps: CommandDeps): Promise<void> {
  const daemon = await deps.startDaemon();
  let stopping = false;
  const stop = () => {
    if (stopping) return;
    stopping = true;
    void daemon
      .stop()
      .then(() => process.exit(0))
      .catch((error: unknown) => {
        console.error(error instanceof Error ? error.message : String(error));
        process.exitCode = 1;
      });
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}
