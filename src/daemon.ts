import { chmodSync, existsSync, lstatSync, unlinkSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { createDockerService, type DockerStatus } from "./docker.js";
import { getCommitStatus, type GitCommitStatus } from "./git.js";
import type { Logger } from "./logger.js";
import { createOrchestrator } from "./orchestrator.js";
import { decideQueueAdmission, type QueueSource } from "./queuePolicy.js";
import { attemptSelfUpdate, type SelfUpdateResult } from "./selfUpdate.js";
import {
  resolveConfigPath,
  type Application,
  type PiploySettings,
} from "./settings.js";
import { isRunningLatestVersion } from "./status.js";

const defaultQueueCapacity = 1000;
const defaultPollIntervalMinutes = 60;
const socketProbeTimeoutMilliseconds = 750;

export type DaemonRequest = { command: "status" } | { command: "poll" };

export type DaemonResponse =
  | { ok: true; status: DaemonStatus }
  | { ok: true }
  | { ok: false; reason: "busy" | "invalid-request" | "failed" };

export interface ApplicationDaemonStatus {
  application: string;
  git: GitCommitStatus | null;
  docker: DockerStatus;
  isRunningLatestVersion: boolean;
}

export interface DaemonStatus {
  applications: ApplicationDaemonStatus[];
}

export interface DaemonDeps {
  poll(): Promise<void>;
  getStatus(): Promise<DaemonStatus>;
  attemptSelfUpdate(): Promise<SelfUpdateResult>;
}

export interface DaemonOptions {
  socketPath?: string;
  queueCapacity?: number;
  pollIntervalMinutes?: number;
  deps?: DaemonDeps;
}

export interface Daemon {
  socketPath: string;
  stop(): Promise<void>;
}

interface QueuedRequest {
  request: DaemonRequest;
  respond(response: DaemonResponse): void;
}

function defaultSocketPath(): string {
  return path.join(path.dirname(resolveConfigPath()), "piploy.sock");
}

function getSocketPath(options: DaemonOptions): string {
  return options.socketPath ?? defaultSocketPath();
}

function parseRequest(value: unknown): DaemonRequest | undefined {
  if (
    typeof value !== "object" ||
    value === null ||
    !("command" in value) ||
    (value.command !== "status" && value.command !== "poll")
  ) {
    return undefined;
  }
  return { command: value.command };
}

function logError(logger: Logger, error: unknown): void {
  logger.error(error instanceof Error ? error.message : String(error));
}

export function createDaemonDeps(
  settings: PiploySettings,
  logger: Logger,
): DaemonDeps {
  const docker = createDockerService(settings, logger);
  const orchestrator = createOrchestrator(settings, logger);

  async function getApplicationStatus(
    application: Application,
  ): Promise<ApplicationDaemonStatus> {
    const [git, dockerStatus] = await Promise.all([
      getCommitStatus(settings, application),
      docker.getDockerStatus(application),
    ]);
    return {
      application: application.Name,
      git,
      docker: dockerStatus,
      isRunningLatestVersion: isRunningLatestVersion(git, dockerStatus),
    };
  }

  return {
    poll: () => orchestrator.poll(),
    getStatus: async () => ({
      applications: await Promise.all(
        settings.Applications.map(getApplicationStatus),
      ),
    }),
    attemptSelfUpdate: () => attemptSelfUpdate(logger),
  };
}

function canConnect(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    const timeout = setTimeout(() => {
      client.destroy();
      resolve(false);
    }, socketProbeTimeoutMilliseconds);
    client.once("connect", () => {
      clearTimeout(timeout);
      client.end();
      resolve(true);
    });
    client.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
  });
}

async function removeStaleSocket(socketPath: string): Promise<void> {
  if (!existsSync(socketPath)) return;
  if (!lstatSync(socketPath).isSocket()) {
    throw new Error(`Refusing to replace non-socket path ${socketPath}`);
  }
  if (await canConnect(socketPath)) {
    throw new Error(`Piploy daemon is already listening at ${socketPath}`);
  }
  unlinkSync(socketPath);
}

function listen(server: net.Server, socketPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(socketPath);
  });
}

function close(server: net.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

/** Starts the local socket server, serial worker, and periodic poll feeder. */
export async function startDaemon(
  settings: PiploySettings,
  logger: Logger,
  options: DaemonOptions = {},
): Promise<Daemon> {
  const socketPath = getSocketPath(options);
  const queueCapacity = options.queueCapacity ?? defaultQueueCapacity;
  const pollIntervalMinutes =
    options.pollIntervalMinutes ??
    settings.MinutesBetweenBackgroundPolls ??
    defaultPollIntervalMinutes;
  if (!Number.isInteger(queueCapacity) || queueCapacity < 1) {
    throw new Error("Daemon queue capacity must be a positive integer");
  }
  if (!(pollIntervalMinutes > 0)) {
    throw new Error("Daemon poll interval must be greater than zero");
  }

  const deps = options.deps ?? createDaemonDeps(settings, logger);
  const queue: QueuedRequest[] = [];
  const sockets = new Set<net.Socket>();
  let workerRunning = false;
  let stopping = false;

  async function runRequest(request: DaemonRequest): Promise<DaemonResponse> {
    try {
      if (request.command === "status") {
        return { ok: true, status: await deps.getStatus() };
      }
      await deps.poll();
      return { ok: true };
    } catch (error) {
      logError(logger, error);
      return { ok: false, reason: "failed" };
    }
  }

  async function runWorker(): Promise<void> {
    try {
      while (!stopping) {
        const queued = queue.shift();
        if (!queued) return;
        queued.respond(await runRequest(queued.request));
      }
    } finally {
      workerRunning = false;
      if (!stopping && queue.length > 0) {
        workerRunning = true;
        void runWorker();
      }
    }
  }

  function enqueue(request: DaemonRequest, source: QueueSource): void {
    const decision = decideQueueAdmission(queue.length, queueCapacity, source);
    if (decision === "reject-busy") return;
    if (decision === "drop") {
      logger.warn("Command queue full. Skipping periodic poll");
      return;
    }
    queue.push({ request, respond: () => {} });
    if (!workerRunning) {
      workerRunning = true;
      void runWorker();
    }
  }

  function enqueueClient(
    request: DaemonRequest,
    respond: (response: DaemonResponse) => void,
  ): boolean {
    if (
      decideQueueAdmission(queue.length, queueCapacity, "client") !== "enqueue"
    ) {
      return false;
    }
    queue.push({ request, respond });
    if (!workerRunning) {
      workerRunning = true;
      void runWorker();
    }
    return true;
  }

  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    let received = "";
    socket.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline === -1) return;
      socket.removeAllListeners("data");

      let request: DaemonRequest | undefined;
      try {
        request = parseRequest(JSON.parse(received.slice(0, newline)));
      } catch {
        // The standard invalid-request response below handles malformed JSON.
      }
      if (!request) {
        socket.end(
          JSON.stringify({ ok: false, reason: "invalid-request" }) + "\n",
        );
        return;
      }
      if (
        !enqueueClient(request, (response) =>
          socket.end(JSON.stringify(response) + "\n"),
        )
      ) {
        socket.end(JSON.stringify({ ok: false, reason: "busy" }) + "\n");
      }
    });
  });

  await removeStaleSocket(socketPath);
  await listen(server, socketPath);
  chmodSync(socketPath, 0o600);
  server.on("error", (error) => logError(logger, error));

  async function runTimerTick(): Promise<void> {
    const updateResult = await deps.attemptSelfUpdate();
    if (updateResult !== "updated") {
      enqueue({ command: "poll" }, "timer");
    }
  }

  const timer = setInterval(
    () => void runTimerTick(),
    pollIntervalMinutes * 60_000,
  );
  logger.info(`Daemon listening at ${socketPath}`);

  return {
    socketPath,
    async stop(): Promise<void> {
      stopping = true;
      clearInterval(timer);
      for (const socket of sockets) socket.destroy();
      await close(server);
    },
  };
}
