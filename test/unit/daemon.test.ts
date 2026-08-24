import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createDaemonDeps,
  isDaemonListening,
  requestDaemon,
  startDaemon,
  getApplicationStatus,
  type Daemon,
  type DaemonDeps,
  type DaemonResponse,
} from "../../src/daemon.js";
import type { Logger } from "../../src/logger.js";
import { GitOperationError } from "../../src/git.js";
import { loadSettings, type PiploySettings } from "../../src/settings.js";

const settings: PiploySettings = {
  RootDirectory: "/tmp/piploy",
  Applications: [],
};

function createLogger(): Logger {
  const logger: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    child: () => logger,
  };
  return logger;
}

// Tests must never bind a real network port, so no test discovers a Tailscale
// address unless it is the one asserting on that branch.
const noTailscale = { getTailscaleAddress: () => undefined };

// The default for every test that is not about logs: nothing is registered.
const noLogs: DaemonDeps["getLogs"] = async () => ({
  ok: false,
  reason: "unknown-application",
});

type TestDaemonDeps = Omit<DaemonDeps, "checkGitHubRepositoryAccess"> &
  Partial<Pick<DaemonDeps, "checkGitHubRepositoryAccess">>;

function completeDeps(deps: TestDaemonDeps): DaemonDeps {
  return {
    checkGitHubRepositoryAccess: async () => ({
      accessible: false,
      reason: "transport-or-fetch-failure",
    }),
    ...deps,
  };
}

function sendRequest(
  socketPath: string,
  request: unknown,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const client = net.createConnection(socketPath);
    let response = "";
    client.on("connect", () => client.write(JSON.stringify(request) + "\n"));
    client.on("data", (chunk: Buffer) => (response += chunk.toString("utf8")));
    client.on("end", () => resolve(JSON.parse(response) as DaemonResponse));
    client.on("error", reject);
  });
}

describe("daemon", () => {
  const daemons: Daemon[] = [];

  afterEach(async () => {
    await Promise.all(daemons.splice(0).map((daemon) => daemon.stop()));
    vi.useRealTimers();
  });

  it("keeps Docker status when Git status returns a safe diagnostic", async () => {
    const application = {
      Name: "app",
      GitRepositoryUrl: "https://github.com/alundgren/app.git",
      DockerfilePath: "Dockerfile",
    };

    await expect(
      getApplicationStatus(
        application,
        Promise.reject(
          new GitOperationError({
            reason: "credential-not-configured",
            message:
              "No credential is configured for GitHub owner 'alundgren'.",
          }),
        ),
        Promise.resolve({ runningContainerHash: "current" }),
      ),
    ).resolves.toEqual({
      application: "app",
      portMappings: [],
      git: null,
      gitError: {
        reason: "credential-not-configured",
        message: "No credential is configured for GitHub owner 'alundgren'.",
      },
      docker: { runningContainerHash: "current" },
      isRunningLatestVersion: false,
    });
  });

  async function start(
    deps: TestDaemonDeps,
    queueCapacity?: number,
  ): Promise<Daemon> {
    const socketPath = path.join(
      await mkdtemp(path.join(os.tmpdir(), "piploy-")),
      "piploy.sock",
    );
    const daemon = await startDaemon(settings, createLogger(), {
      socketPath,
      queueCapacity,
      pollIntervalMinutes: 60,
      deps: completeDeps(deps),
      ...noTailscale,
    });
    daemons.push(daemon);
    return daemon;
  }

  it("serves daemon-computed status over a private socket", async () => {
    const daemon = await start({
      getLogs: noLogs,
      poll: async () => [],
      getStatus: async () => ({
        applications: [
          {
            application: "app",
            portMappings: [{ hostPort: 8080, containerPort: 80 }],
            git: null,
            docker: {},
            isRunningLatestVersion: false,
          },
        ],
      }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    expect((await stat(daemon.socketPath)).mode & 0o777).toBe(0o600);
    await expect(
      requestDaemon({ command: "status" }, daemon.socketPath),
    ).resolves.toEqual({
      ok: true,
      status: {
        applications: [
          {
            application: "app",
            portMappings: [{ hostPort: 8080, containerPort: 80 }],
            git: null,
            docker: {},
            isRunningLatestVersion: false,
          },
        ],
      },
    });
  });

  it("returns container logs for one application over the private socket", async () => {
    const logs = {
      application: "app",
      containerState: "exited",
      text: "boom\n",
      truncated: false,
      tail: 50,
    };
    const requested: { application: string; tail?: number }[] = [];
    const daemon = await start({
      getLogs: async (application, tail) => {
        requested.push({ application, tail });
        return { ok: true, logs };
      },
      poll: async () => [],
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      requestDaemon(
        { command: "logs", application: "app", tail: 50 },
        daemon.socketPath,
      ),
    ).resolves.toEqual({ ok: true, logs });
    expect(requested).toEqual([{ application: "app", tail: 50 }]);
  });

  it("routes repository access checks through the daemon queue", async () => {
    const requested: string[] = [];
    const daemon = await start({
      getLogs: noLogs,
      checkGitHubRepositoryAccess: async (repository) => {
        requested.push(repository);
        return { accessible: false, reason: "credential-rejected" };
      },
      poll: async () => [],
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      sendRequest(daemon.socketPath, {
        command: "check-github-repository-access",
        repository: "repository",
      }),
    ).resolves.toEqual({
      ok: true,
      repositoryAccess: { accessible: false, reason: "credential-rejected" },
    });
    expect(requested).toEqual(["repository"]);
  });

  it("keeps actual repository-access failures out of daemon output and configuration", async () => {
    const token = "sentinel-github-token";
    const rawAdapterError = "adapter error /tmp/private-checkout secret";
    const repositoryContent = "private repository content";
    const messages: string[] = [];
    const logger: Logger = {
      debug: (message) => messages.push(message),
      info: (message) => messages.push(message),
      warn: (message) => messages.push(message),
      error: (message) => messages.push(message),
      child: () => logger,
    };
    const accessSettings: PiploySettings = {
      RootDirectory: "/tmp/piploy",
      Applications: [],
      GitHubOwnerCredentials: {
        alundgren: "${hostEnv:PIPLOY_GITHUB_TOKEN}",
      },
    };
    const before = JSON.stringify(accessSettings);
    vi.stubGlobal("fetch", () => Promise.reject(new Error(rawAdapterError)));
    try {
      const daemon = await startDaemon(accessSettings, logger, {
        socketPath: path.join(
          await mkdtemp(path.join(os.tmpdir(), "piploy-")),
          "piploy.sock",
        ),
        pollIntervalMinutes: 60,
        deps: createDaemonDeps(accessSettings, logger),
        ...noTailscale,
      });
      daemons.push(daemon);

      const response = await sendRequest(daemon.socketPath, {
        command: "check-github-repository-access",
        repository: "repository",
      });

      expect(response).toEqual({
        ok: true,
        repositoryAccess: {
          accessible: false,
          reason: "transport-or-fetch-failure",
        },
      });
      const observable = `${JSON.stringify(response)}\n${messages.join("\n")}`;
      expect(observable).not.toContain(token);
      expect(observable).not.toContain(rawAdapterError);
      expect(observable).not.toContain(repositoryContent);
      expect(observable).not.toContain("piploy-github-access-");
      expect(JSON.stringify(accessSettings)).toBe(before);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("reports an application with no container as a distinct logs rejection", async () => {
    const daemon = await start({
      getLogs: async () => ({ ok: false, reason: "no-container" }),
      poll: async () => [],
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      requestDaemon({ command: "logs", application: "app" }, daemon.socketPath),
    ).resolves.toEqual({ ok: false, reason: "no-container" });
  });

  it("rejects a logs request without an application name", async () => {
    const daemon = await start({
      getLogs: noLogs,
      poll: async () => [],
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      sendRequest(daemon.socketPath, { command: "logs", application: 7 }),
    ).resolves.toEqual({ ok: false, reason: "invalid-request" });
  });

  it("returns per-application poll results over the private socket", async () => {
    const applications = [
      {
        application: "app",
        ok: false as const,
        stage: "build" as const,
        message: "build failed",
      },
    ];
    const daemon = await start({
      getLogs: noLogs,
      poll: async () => applications,
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      requestDaemon({ command: "poll" }, daemon.socketPath),
    ).resolves.toEqual({ ok: true, applications });
  });

  it("runs poll requests serially and rejects a client when its queue is full", async () => {
    let releaseFirstPoll: (() => void) | undefined;
    const firstPoll = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    let polls = 0;
    const daemon = await start(
      {
        getLogs: noLogs,
        poll: async () => {
          polls += 1;
          if (polls === 2) await firstPoll;
          return [];
        },
        getStatus: async () => ({ applications: [] }),
        attemptSelfUpdate: async () => "up-to-date",
      },
      1,
    );

    const first = sendRequest(daemon.socketPath, { command: "poll" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = sendRequest(daemon.socketPath, { command: "poll" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await expect(
      sendRequest(daemon.socketPath, { command: "poll" }),
    ).resolves.toEqual({
      ok: false,
      reason: "busy",
    });

    releaseFirstPoll!();
    await expect(first).resolves.toEqual({ ok: true, applications: [] });
    await expect(second).resolves.toEqual({ ok: true, applications: [] });
    expect(polls).toBe(3);
  });

  it("answers status immediately with poll-in-progress instead of waiting behind a running poll", async () => {
    let releasePoll: (() => void) | undefined;
    const pollGate = new Promise<void>((resolve) => {
      releasePoll = resolve;
    });
    const daemon = await start({
      getLogs: noLogs,
      poll: async () => {
        await pollGate;
        return [];
      },
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    const poll = sendRequest(daemon.socketPath, { command: "poll" });
    await new Promise<void>((resolve) => setImmediate(resolve));

    await expect(
      sendRequest(daemon.socketPath, { command: "status" }),
    ).resolves.toEqual({ ok: false, reason: "poll-in-progress" });
    // Logs report on the same state a running poll is changing, so they answer
    // the same way rather than queueing behind a slow build.
    await expect(
      sendRequest(daemon.socketPath, { command: "logs", application: "app" }),
    ).resolves.toEqual({ ok: false, reason: "poll-in-progress" });

    releasePoll!();
    await expect(poll).resolves.toEqual({ ok: true, applications: [] });
  });

  it("rejects malformed requests", async () => {
    const daemon = await start({
      getLogs: noLogs,
      poll: async () => [],
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      sendRequest(daemon.socketPath, { command: "bogus" }),
    ).resolves.toEqual({
      ok: false,
      reason: "invalid-request",
    });
  });

  it("acknowledges stop requests before shutting down the daemon", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => {
      return undefined as never;
    }) as typeof process.exit);
    const daemon = await start({
      getLogs: noLogs,
      poll: async () => [],
      getStatus: async () => ({ applications: [] }),
      attemptSelfUpdate: async () => "up-to-date",
    });

    await expect(
      sendRequest(daemon.socketPath, { command: "stop" }),
    ).resolves.toEqual({ ok: true });
    await vi.waitFor(() => expect(exit).toHaveBeenCalledWith(0));
    await expect(
      requestDaemon({ command: "status" }, daemon.socketPath),
    ).resolves.toBeUndefined();

    exit.mockRestore();
  });

  it.each([
    ["up-to-date", ["update", "poll"]],
    ["failed", ["update", "poll"]],
    ["updated", ["update"]],
  ] as const)(
    "runs self-update before polling on a timer tick when it is %s",
    async (updateResult, expectedEvents) => {
      vi.useFakeTimers();
      const exit = vi
        .spyOn(process, "exit")
        .mockImplementation(() => undefined as never);
      const events: string[] = [];
      const socketPath = path.join(
        await mkdtemp(path.join(os.tmpdir(), "piploy-")),
        "piploy.sock",
      );
      const daemon = await startDaemon(settings, createLogger(), {
        socketPath,
        pollIntervalMinutes: 1,
        deps: {
          checkGitHubRepositoryAccess: async () => ({
            accessible: false,
            reason: "transport-or-fetch-failure",
          }),
          attemptSelfUpdate: async () => {
            events.push("update");
            return updateResult;
          },
          getLogs: noLogs,
          poll: async () => {
            events.push("poll");
            return [];
          },
          getStatus: async () => ({ applications: [] }),
        },
        ...noTailscale,
      });
      daemons.push(daemon);

      await vi.advanceTimersByTimeAsync(0);
      events.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(events).toEqual(expectedEvents);
      if (updateResult === "updated") {
        expect(exit).toHaveBeenCalledWith(0);
      } else {
        expect(exit).not.toHaveBeenCalled();
      }
      exit.mockRestore();
    },
  );

  it("enqueues a poll immediately on startup without self-updating", async () => {
    const events: string[] = [];
    await start({
      attemptSelfUpdate: async () => {
        events.push("update");
        return "up-to-date";
      },
      getLogs: noLogs,
      poll: async () => {
        events.push("poll");
        return [];
      },
      getStatus: async () => ({ applications: [] }),
    });

    await vi.waitFor(() => expect(events).toEqual(["poll"]));
  });

  describe("register", () => {
    const newApplication = {
      Name: "app",
      GitRepositoryUrl: "https://example.com/app.git",
      DockerfilePath: "Dockerfile",
      PortMappings: ["8080:80"],
      EnvironmentVariables: { TOKEN: "${hostEnv:CONTAINER_TOKEN}" },
    };

    async function startWithConfig(
      deps: TestDaemonDeps,
      registered: unknown[] = [],
    ): Promise<{
      daemon: Daemon;
      configPath: string;
      liveSettings: PiploySettings;
    }> {
      const directory = await mkdtemp(path.join(os.tmpdir(), "piploy-"));
      const configPath = path.join(directory, "piploy.json");
      await writeFile(
        configPath,
        JSON.stringify({
          Piploy: {
            RootDirectory: path.join(directory, "root"),
            Applications: registered,
          },
        }),
      );
      const liveSettings = loadSettings(configPath);
      const daemon = await startDaemon(liveSettings, createLogger(), {
        socketPath: path.join(directory, "piploy.sock"),
        configPath,
        pollIntervalMinutes: 60,
        deps: completeDeps(deps),
        ...noTailscale,
      });
      daemons.push(daemon);
      return { daemon, configPath, liveSettings };
    }

    function idleDeps(): TestDaemonDeps {
      return {
        getLogs: noLogs,
        poll: async () => [],
        getStatus: async () => ({ applications: [] }),
        attemptSelfUpdate: async () => "up-to-date",
      };
    }

    it("persists a new application, returns it transformed, and adds it to the live settings", async () => {
      const { daemon, configPath, liveSettings } =
        await startWithConfig(idleDeps());

      await expect(
        sendRequest(daemon.socketPath, {
          command: "register",
          application: newApplication,
        }),
      ).resolves.toEqual({
        ok: true,
        application: {
          Name: "app",
          GitRepositoryUrl: "https://example.com/app.git",
          DockerfilePath: "Dockerfile",
          PortMappings: [{ hostPort: 8080, containerPort: 80 }],
          EnvironmentVariables: { TOKEN: "${hostEnv:CONTAINER_TOKEN}" },
        },
      });

      // The file keeps the raw string form the schema parses, not the
      // transformed port pairs.
      const written = JSON.parse(await readFile(configPath, "utf8")) as {
        Piploy: { Applications: unknown[] };
      };
      expect(written.Piploy.Applications).toEqual([newApplication]);
      expect(liveSettings.Applications.map((one) => one.Name)).toEqual(["app"]);
    });

    it("rejects an application the schema does not accept", async () => {
      const { daemon, configPath, liveSettings } =
        await startWithConfig(idleDeps());

      const response = await sendRequest(daemon.socketPath, {
        command: "register",
        application: { ...newApplication, PortMappings: ["not-a-mapping"] },
      });

      expect(response).toMatchObject({
        ok: false,
        reason: "invalid-application",
      });
      expect(liveSettings.Applications).toEqual([]);
      const written = JSON.parse(await readFile(configPath, "utf8")) as {
        Piploy: { Applications: unknown[] };
      };
      expect(written.Piploy.Applications).toEqual([]);
    });

    it("rejects an application whose name is already registered", async () => {
      const { daemon, configPath } = await startWithConfig(idleDeps(), [
        newApplication,
      ]);

      const response = await sendRequest(daemon.socketPath, {
        command: "register",
        application: { ...newApplication, PortMappings: ["9090:80"] },
      });

      expect(response).toMatchObject({
        ok: false,
        reason: "duplicate-application",
      });
      const written = JSON.parse(await readFile(configPath, "utf8")) as {
        Piploy: { Applications: unknown[] };
      };
      expect(written.Piploy.Applications).toEqual([newApplication]);
    });

    it("does not poll", async () => {
      let polls = 0;
      const { daemon } = await startWithConfig({
        ...idleDeps(),
        poll: async () => {
          polls += 1;
          return [];
        },
      });
      // The daemon polls once at startup; register must not add another.
      await vi.waitFor(() => expect(polls).toBe(1));

      await expect(
        sendRequest(daemon.socketPath, {
          command: "register",
          application: newApplication,
        }),
      ).resolves.toMatchObject({ ok: true });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(polls).toBe(1);
    });

    it("waits behind a poll that is already running", async () => {
      let releasePoll: (() => void) | undefined;
      const pollGate = new Promise<void>((resolve) => {
        releasePoll = resolve;
      });
      const events: string[] = [];
      const { daemon } = await startWithConfig({
        ...idleDeps(),
        poll: async () => {
          await pollGate;
          events.push("poll");
          return [];
        },
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const register = sendRequest(daemon.socketPath, {
        command: "register",
        application: newApplication,
      }).then((response) => {
        events.push("register");
        return response;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(events).toEqual([]);

      releasePoll!();
      await expect(register).resolves.toMatchObject({ ok: true });
      expect(events).toEqual(["poll", "register"]);
    });
  });

  describe("mcp server", () => {
    function createRecordingLogger(messages: string[]): Logger {
      const logger: Logger = {
        debug: () => {},
        info: (message) => messages.push(`info ${message}`),
        warn: (message) => messages.push(`warn ${message}`),
        error: (message) => messages.push(`error ${message}`),
        child: () => logger,
      };
      return logger;
    }

    /** A port nothing is listening on, so a refused connection is meaningful. */
    async function reserveFreePort(): Promise<number> {
      const probe = net.createServer();
      await new Promise<void>((resolve) =>
        probe.listen(0, "127.0.0.1", resolve),
      );
      const port = (probe.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => probe.close(() => resolve()));
      return port;
    }

    function isListening(port: number): Promise<boolean> {
      return new Promise((resolve) => {
        const client = net.createConnection(port, "127.0.0.1");
        client.once("connect", () => {
          client.destroy();
          resolve(true);
        });
        client.once("error", () => resolve(false));
      });
    }

    async function startWithAddress(
      address: string | undefined,
      deps: TestDaemonDeps,
      // Port 0 keeps the test off the fixed v1 port.
      mcpPort = 0,
    ): Promise<{ daemon: Daemon; messages: string[] }> {
      const messages: string[] = [];
      const socketPath = path.join(
        await mkdtemp(path.join(os.tmpdir(), "piploy-")),
        "piploy.sock",
      );
      const daemon = await startDaemon(
        settings,
        createRecordingLogger(messages),
        {
          socketPath,
          pollIntervalMinutes: 60,
          deps: completeDeps(deps),
          mcpPort,
          getTailscaleAddress: () => address,
        },
      );
      daemons.push(daemon);
      return { daemon, messages };
    }

    it("keeps serving the socket when no Tailscale address is found", async () => {
      const mcpPort = await reserveFreePort();
      const { daemon, messages } = await startWithAddress(
        undefined,
        {
          getLogs: noLogs,
          poll: async () => [],
          getStatus: async () => ({ applications: [] }),
          attemptSelfUpdate: async () => "up-to-date",
        },
        mcpPort,
      );

      await expect(isListening(mcpPort)).resolves.toBe(false);
      await expect(
        sendRequest(daemon.socketPath, { command: "status" }),
      ).resolves.toEqual({ ok: true, status: { applications: [] } });
      expect(messages).toContain(
        "warn No Tailscale address found. MCP server not started",
      );
      expect(
        messages.some((message) => message.includes("MCP server listening")),
      ).toBe(false);
    });

    it("runs MCP tool calls through the same queue as socket clients", async () => {
      const events: string[] = [];
      const { messages } = await startWithAddress("127.0.0.1", {
        getLogs: noLogs,
        poll: async () => {
          events.push("poll");
          return [];
        },
        getStatus: async () => ({ applications: [] }),
        attemptSelfUpdate: async () => "up-to-date",
      });
      await vi.waitFor(() => expect(events).toEqual(["poll"]));

      const url = messages
        .find((message) => message.startsWith("info MCP server listening"))
        ?.split(" at ")[1];
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);

      const client = new Client({ name: "test", version: "0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(url!)));
      await client.callTool({ name: "poll" });
      await client.close();

      expect(events).toEqual(["poll", "poll"]);
    });
  });

  describe("isDaemonListening", () => {
    it("is true while a daemon is listening at the socket", async () => {
      const daemon = await start({
        getLogs: noLogs,
        poll: async () => [],
        getStatus: async () => ({ applications: [] }),
        attemptSelfUpdate: async () => "up-to-date",
      });

      await expect(isDaemonListening(daemon.socketPath)).resolves.toBe(true);
    });

    it("is false for a stale socket file left behind by a daemon that crashed", async () => {
      const socketPath = path.join(
        await mkdtemp(path.join(os.tmpdir(), "piploy-")),
        "piploy.sock",
      );
      await writeFile(socketPath, "");

      await expect(isDaemonListening(socketPath)).resolves.toBe(false);
    });
  });
});
