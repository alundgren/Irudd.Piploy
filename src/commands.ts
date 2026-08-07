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
import type { PiploySettings } from "./settings.js";
import { getApplicationDataDirectory } from "./settings.js";
import { piployVersion } from "./version.js";

export interface CommandDeps {
  requestDaemon(request: DaemonRequest): Promise<DaemonResponse | undefined>;
  computeStatusInline(): Promise<DaemonStatus>;
  pollInline(): Promise<void>;
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

function commandFailed(message: string): void {
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
    await deps.pollInline();
    console.log("Poll completed.");
    return;
  }
  if (!response.ok) {
    commandFailed(`Daemon poll request failed: ${response.reason}`);
    return;
  }
  console.log("Poll completed.");
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
