import { afterEach, describe, expect, it, vi } from "vitest";

import {
  poll,
  serviceStart,
  serviceStop,
  status,
  wipeAll,
  type CommandDeps,
} from "../../src/commands.js";
import type { DaemonStatus } from "../../src/daemon.js";

const daemonStatus: DaemonStatus = {
  applications: [
    {
      application: "app",
      git: null,
      docker: {},
      isRunningLatestVersion: false,
    },
  ],
};

function createDeps(): CommandDeps {
  return {
    requestDaemon: vi.fn(),
    computeStatusInline: vi.fn(async () => daemonStatus),
    pollInline: vi.fn(),
    wipeAll: vi.fn(),
    getPreservedApplicationDataDirectories: vi.fn(() => []),
    startDaemon: vi.fn(async () => ({
      socketPath: "/tmp/piploy.sock",
      stop: vi.fn(),
    })),
  };
}

describe("commands", () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("uses daemon status when the daemon is reachable", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: true as const,
      status: daemonStatus,
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await status(deps);

    expect(deps.requestDaemon).toHaveBeenCalledWith({ command: "status" });
    expect(deps.computeStatusInline).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("Background service: running");
  });

  it("computes status inline only when no daemon is reachable", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => undefined);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await status(deps);

    expect(deps.computeStatusInline).toHaveBeenCalledOnce();
    expect(output).toHaveBeenCalledWith("Background service: not running");
  });

  it("reports a failed daemon status request without an inline fallback", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: false as const,
      reason: "busy" as const,
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await status(deps);

    expect(deps.computeStatusInline).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Daemon status request failed: busy");
    expect(process.exitCode).toBe(1);
  });

  it("delegates poll to a reachable daemon", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({ ok: true as const }));
    vi.spyOn(console, "log").mockImplementation(() => {});

    await poll(deps);

    expect(deps.requestDaemon).toHaveBeenCalledWith({ command: "poll" });
    expect(deps.pollInline).not.toHaveBeenCalled();
  });

  it("runs poll inline only when no daemon is reachable", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => undefined);
    vi.spyOn(console, "log").mockImplementation(() => {});

    await poll(deps);

    expect(deps.pollInline).toHaveBeenCalledOnce();
  });

  it("reports a failed daemon poll request without an inline fallback", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: false as const,
      reason: "failed" as const,
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await poll(deps);

    expect(deps.pollInline).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith("Daemon poll request failed: failed");
    expect(process.exitCode).toBe(1);
  });

  it("stops a reachable daemon and reports when none is reachable", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi
      .fn()
      .mockResolvedValueOnce({ ok: true as const })
      .mockResolvedValueOnce(undefined);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await serviceStop(deps);
    await serviceStop(deps);

    expect(deps.requestDaemon).toHaveBeenCalledWith({ command: "stop" });
    expect(output).toHaveBeenCalledWith("Piploy daemon stopped.");
    expect(error).toHaveBeenCalledWith("No Piploy daemon is reachable.");
    expect(process.exitCode).toBe(1);
  });

  it("wipes without contacting the daemon", async () => {
    const deps = createDeps();
    deps.getPreservedApplicationDataDirectories = vi.fn(() => [
      "/opt/piploy/data/app",
    ]);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await wipeAll(deps);

    expect(deps.wipeAll).toHaveBeenCalledOnce();
    expect(deps.requestDaemon).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      "Preserved application data: /opt/piploy/data/app",
    );
  });

  it("starts the daemon", async () => {
    const deps = createDeps();

    await serviceStart(deps);

    expect(deps.startDaemon).toHaveBeenCalledOnce();
  });
});
