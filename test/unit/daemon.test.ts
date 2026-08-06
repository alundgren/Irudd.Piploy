import { mkdtemp, stat } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestDaemon,
  startDaemon,
  type Daemon,
  type DaemonDeps,
  type DaemonResponse,
} from "../../src/daemon.js";
import type { Logger } from "../../src/logger.js";
import type { PiploySettings } from "../../src/settings.js";

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

  async function start(
    deps: DaemonDeps,
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
      deps,
    });
    daemons.push(daemon);
    return daemon;
  }

  it("serves daemon-computed status over a private socket", async () => {
    const daemon = await start({
      poll: async () => {},
      getStatus: async () => ({
        applications: [
          {
            application: "app",
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
            git: null,
            docker: {},
            isRunningLatestVersion: false,
          },
        ],
      },
    });
  });

  it("runs poll requests serially and rejects a client when its queue is full", async () => {
    let releaseFirstPoll: (() => void) | undefined;
    const firstPoll = new Promise<void>((resolve) => {
      releaseFirstPoll = resolve;
    });
    let polls = 0;
    const daemon = await start(
      {
        poll: async () => {
          polls += 1;
          if (polls === 2) await firstPoll;
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
    await expect(first).resolves.toEqual({ ok: true });
    await expect(second).resolves.toEqual({ ok: true });
    expect(polls).toBe(3);
  });

  it("rejects malformed requests", async () => {
    const daemon = await start({
      poll: async () => {},
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
      poll: async () => {},
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
      const events: string[] = [];
      const socketPath = path.join(
        await mkdtemp(path.join(os.tmpdir(), "piploy-")),
        "piploy.sock",
      );
      const daemon = await startDaemon(settings, createLogger(), {
        socketPath,
        pollIntervalMinutes: 1,
        deps: {
          attemptSelfUpdate: async () => {
            events.push("update");
            return updateResult;
          },
          poll: async () => {
            events.push("poll");
          },
          getStatus: async () => ({ applications: [] }),
        },
      });
      daemons.push(daemon);

      await vi.advanceTimersByTimeAsync(0);
      events.length = 0;
      await vi.advanceTimersByTimeAsync(60_000);

      expect(events).toEqual(expectedEvents);
    },
  );

  it("enqueues a poll immediately on startup without self-updating", async () => {
    const events: string[] = [];
    await start({
      attemptSelfUpdate: async () => {
        events.push("update");
        return "up-to-date";
      },
      poll: async () => {
        events.push("poll");
      },
      getStatus: async () => ({ applications: [] }),
    });

    await vi.waitFor(() => expect(events).toEqual(["poll"]));
  });
});
