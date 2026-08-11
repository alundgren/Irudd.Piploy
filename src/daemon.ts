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
  registerApplication,
  RegisterApplicationError,
  resolveConfigPath,
  type Application,
  type PiploySettings,
  type RegisterApplicationFailure,
} from "./settings.js";
import { isRunningLatestVersion } from "./status.js";

const defaultQueueCapacity = 1000;
const defaultPollIntervalMinutes = 60;
const socketProbeTimeoutMilliseconds = 750;

export type DaemonRequest =
  | { command: "status" }
  | { command: "poll" }
  | { command: "stop" }
  | { command: "register"; application: unknown };

export type DaemonResponse =
  | { ok: true; status: DaemonStatus }
  | { ok: true; application: Application }
  | { ok: true }
  | {
      ok: false;
      reason: "busy" | "invalid-request" | "failed" | "poll-in-progress";
    }
  | { ok: false; reason: RegisterApplicationFailure; message: string };

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
  configPath?: string;
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

/** Resolves the daemon socket alongside the active Piploy configuration. */
export function defaultSocketPath(): string {
  return path.join(path.dirname(resolveConfigPath()), "piploy.sock");
}

function getSocketPath(options: DaemonOptions): string {
  return options.socketPath ?? defaultSocketPath();
}

function parseRequest(value: unknown): DaemonRequest | undefined {
  if (typeof value !== "object" || value === null || !("command" in value)) {
    return undefined;
  }
  const command = value.command;
  if (command === "status" || command === "poll" || command === "stop") {
    return { command };
  }
  // Only the envelope is checked here. The payload is validated once, by the
  // Application schema, when the request runs.
  if (command === "register" && "application" in value) {
    return { command: "register", application: value.application };
  }
  return undefined;
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

/**
 * Sends one request to the local daemon. A connection attempt doubles as the
 * liveness probe: only establishing the socket connection is time-boxed.
 */
export function requestDaemon(
  request: DaemonRequest,
  socketPath: string = defaultSocketPath(),
): Promise<DaemonResponse | undefined> {
  return new Promise((resolve) => {
    const client = net.createConnection(socketPath);
    let settled = false;
    let connected = false;
    let received = "";

    const finish = (response: DaemonResponse | undefined) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      client.destroy();
      resolve(response);
    };

    const timeout = setTimeout(
      () => finish(undefined),
      socketProbeTimeoutMilliseconds,
    );

    client.once("connect", () => {
      connected = true;
      clearTimeout(timeout);
      client.write(JSON.stringify(request) + "\n");
    });
    client.on("data", (chunk: Buffer) => {
      received += chunk.toString("utf8");
      const newline = received.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(JSON.parse(received.slice(0, newline)) as DaemonResponse);
      } catch {
        finish(undefined);
      }
    });
    client.once("end", () => {
      if (!settled) finish(undefined);
    });
    client.once("error", () => {
      // A failed connection is an unreachable daemon. A later socket failure
      // before a response is equally unusable to the caller.
      if (!connected || !settled) finish(undefined);
    });
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

  const configPath = options.configPath ?? resolveConfigPath();
  const deps = options.deps ?? createDaemonDeps(settings, logger);
  const queue: QueuedRequest[] = [];
  const sockets = new Set<net.Socket>();
  let workerRunning = false;
  let stopping = false;
  let pollInProgress = false;
  let shutdownPromise: Promise<void> | undefined;

  function shutdown(): Promise<void> {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    clearInterval(timer);
    for (const socket of sockets) socket.destroy();
    shutdownPromise = close(server);
    return shutdownPromise;
  }

  /**
   * Registering writes `piploy.json` and then appends to the very array the
   * orchestrator re-reads on each poll, so the next poll picks the Application
   * up (ADR-0007). It deliberately does not poll itself: polling is Piploy's
   * only trigger, and nothing pushes work to it.
   */
  function runRegister(rawApplication: unknown): DaemonResponse {
    try {
      const application = registerApplication(configPath, rawApplication);
      settings.Applications.push(application);
      logger.info(`Registered application ${application.Name}`);
      return { ok: true, application };
    } catch (error) {
      if (!(error instanceof RegisterApplicationError)) throw error;
      logger.warn(`Rejected register request. ${error.message}`);
      return { ok: false, reason: error.reason, message: error.message };
    }
  }

  async function runRequest(request: DaemonRequest): Promise<DaemonResponse> {
    try {
      // Every command is matched explicitly: a fallthrough here would run
      // something other than what the client asked for.
      switch (request.command) {
        case "status":
          return { ok: true, status: await deps.getStatus() };
        case "stop":
          return { ok: true };
        case "register":
          return runRegister(request.application);
        case "poll":
          pollInProgress = true;
          try {
            await deps.poll();
          } finally {
            pollInProgress = false;
          }
          return { ok: true };
      }
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
        const response = await runRequest(queued.request);
        queued.respond(response);
        if (queued.request.command === "stop" && response.ok) {
          stopping = true;
          // Let socket.end() flush its acknowledgement before closing all
          // active sockets and exiting the service process.
          setImmediate(() => {
            void shutdown()
              .then(() => process.exit(0))
              .catch((error: unknown) => logError(logger, error));
          });
          return;
        }
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
    if (request.command === "status" && pollInProgress) {
      respond({ ok: false, reason: "poll-in-progress" });
      return true;
    }
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
  enqueue({ command: "poll" }, "timer");
  logger.info(`Daemon listening at ${socketPath}`);

  return {
    socketPath,
    stop: shutdown,
  };
}
