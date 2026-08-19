import { afterEach, describe, expect, it, vi } from "vitest";

import {
  logs,
  parseRegisterOptions,
  parseTailOption,
  poll,
  register,
  restartDaemonAfterUpdate,
  serviceStart,
  serviceStop,
  status,
  wipeAll,
  type CommandDeps,
} from "../../src/commands.js";
import type { DaemonResponse, DaemonStatus } from "../../src/daemon.js";

const application = {
  Name: "app",
  GitRepositoryUrl: "https://example.com/app.git",
  DockerfilePath: "Dockerfile",
};

const daemonStatus: DaemonStatus = {
  applications: [
    {
      application: "app",
      portMappings: [{ hostPort: 8080, containerPort: 80 }],
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
    pollInline: vi.fn(async () => []),
    register: vi.fn(),
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
    expect(output).toHaveBeenCalledWith("  Port mappings: 8080:80");
  });

  it("prints an explicit no-port-mappings state", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: true as const,
      status: {
        applications: [{ ...daemonStatus.applications[0]!, portMappings: [] }],
      },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await status(deps);

    expect(output).toHaveBeenCalledWith("  Port mappings: none");
  });

  it("prints the container state, exit code, and restart count", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: true as const,
      status: {
        applications: [
          {
            ...daemonStatus.applications[0]!,
            docker: {
              container: { state: "restarting", exitCode: 1, restartCount: 4 },
            },
          },
        ],
      },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await status(deps);

    expect(output).toHaveBeenCalledWith("  Container state: restarting");
    expect(output).toHaveBeenCalledWith("  Container exit code: 1");
    expect(output).toHaveBeenCalledWith("  Container restart count: 4");
  });

  it("prints no container state when the application has no container", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: true as const,
      status: daemonStatus,
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await status(deps);

    expect(output).toHaveBeenCalledWith("  Container state: none");
    expect(output).not.toHaveBeenCalledWith(
      expect.stringContaining("Container exit code"),
    );
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

  it("reports an in-progress install without treating it as a failure", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: false as const,
      reason: "poll-in-progress" as const,
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await status(deps);

    expect(deps.computeStatusInline).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith(
      "\nAn install is in progress. Try again shortly.",
    );
    expect(error).not.toHaveBeenCalled();
    expect(process.exitCode).toBeUndefined();
  });

  it("prints container logs from a reachable daemon", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: true as const,
      logs: {
        application: "app",
        containerState: "exited",
        text: "boom\n",
        truncated: false,
        tail: 200,
      },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await logs(deps, { application: "app", tail: 200 });

    expect(deps.requestDaemon).toHaveBeenCalledWith({
      command: "logs",
      application: "app",
      tail: 200,
    });
    expect(output).toHaveBeenCalledWith(
      "app (container exited, last 200 lines)",
    );
    expect(output).toHaveBeenCalledWith("boom\n");
  });

  it("says when older log output was dropped", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({
      ok: true as const,
      logs: {
        application: "app",
        containerState: "running",
        text: "tail\n",
        truncated: true,
        tail: 200,
      },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await logs(deps, { application: "app" });

    expect(output).toHaveBeenCalledWith(
      "Older output was dropped to stay within the size limit.",
    );
  });

  it.each([
    ["unknown-application" as const, "No such application is registered."],
    [
      "no-container" as const,
      "That application has no container yet. Run a poll first.",
    ],
    [
      "poll-in-progress" as const,
      "An install is in progress. Try again shortly.",
    ],
  ])("explains the %s logs rejection", async (reason, message) => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => ({ ok: false as const, reason }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await logs(deps, { application: "app" });

    expect(error).toHaveBeenCalledWith(message);
    expect(process.exitCode).toBe(1);
  });

  it("refuses to read logs without a running daemon", async () => {
    const deps = createDeps();
    deps.requestDaemon = vi.fn(async () => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await logs(deps, { application: "app" });

    expect(error).toHaveBeenCalledWith(
      "Background service not running. Start it, then run 'piploy logs' again.",
    );
    expect(process.exitCode).toBe(1);
  });

  it.each([undefined, "1", "2000"])("accepts the tail option %s", (value) => {
    expect(parseTailOption(value)).toEqual({
      ok: true,
      tail: value === undefined ? undefined : Number(value),
    });
  });

  it.each(["0", "-5", "1.5", "2001", "all"])(
    "rejects the tail option %s before contacting the daemon",
    (value) => {
      const parsed = parseTailOption(value);
      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.message).toContain("between 1 and 2000");
    },
  );

  it("delegates poll to a reachable daemon", async () => {
    const deps = createDeps();
    const response: DaemonResponse = {
      ok: true,
      applications: [
        {
          application: "app",
          ok: false,
          stage: "build",
          message: "Dockerfile is invalid",
        },
      ],
    };
    deps.requestDaemon = vi.fn(async () => response);
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await poll(deps);

    expect(deps.requestDaemon).toHaveBeenCalledWith({ command: "poll" });
    expect(deps.pollInline).not.toHaveBeenCalled();
    expect(output).toHaveBeenCalledWith("Poll completed with failures:");
    expect(output).toHaveBeenCalledWith("  app (build): Dockerfile is invalid");
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

  it("stops the daemon after a CLI self-update so systemd can restart it", async () => {
    const request = vi.fn(async () => ({ ok: true as const }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await restartDaemonAfterUpdate(request);

    expect(request).toHaveBeenCalledWith({ command: "stop" });
    expect(output).toHaveBeenCalledWith(
      "Piploy update installed; restarting daemon.",
    );
  });

  it("reports when an installed update cannot restart a daemon", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await restartDaemonAfterUpdate(async () => undefined);

    expect(error).toHaveBeenCalledWith(
      "Piploy update installed, but no daemon is reachable to restart.",
    );
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

  it("reports the registered application name on success", async () => {
    const deps = createDeps();
    deps.register = vi.fn(async () => ({
      ok: true as const,
      application: { ...application },
    }));
    const output = vi.spyOn(console, "log").mockImplementation(() => {});

    await register(deps, application);

    expect(deps.register).toHaveBeenCalledWith(application);
    expect(output).toHaveBeenCalledWith("Registered application app.");
    expect(process.exitCode).toBeUndefined();
  });

  it("reports an invalid application with the daemon message", async () => {
    const deps = createDeps();
    deps.register = vi.fn(async () => ({
      ok: false as const,
      reason: "invalid-application" as const,
      message: "Name: Invalid input",
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await register(deps, application);

    expect(error).toHaveBeenCalledWith(
      "Register failed: invalid-application. Name: Invalid input",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports a duplicate application with the daemon message", async () => {
    const deps = createDeps();
    deps.register = vi.fn(async () => ({
      ok: false as const,
      reason: "duplicate-application" as const,
      message: "An application named 'app' is already registered",
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await register(deps, application);

    expect(error).toHaveBeenCalledWith(
      "Register failed: duplicate-application. An application named 'app' is already registered",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports a generic daemon rejection without a message", async () => {
    const deps = createDeps();
    deps.register = vi.fn(async () => ({
      ok: false as const,
      reason: "busy" as const,
    }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await register(deps, application);

    expect(error).toHaveBeenCalledWith("Daemon register request failed: busy");
    expect(process.exitCode).toBe(1);
  });

  it("refuses to register without a running daemon", async () => {
    const deps = createDeps();
    deps.register = vi.fn(async () => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await register(deps, application);

    expect(error).toHaveBeenCalledWith(
      "Background service not running. Start it, then run 'piploy register' again.",
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports a success response missing its application", async () => {
    const deps = createDeps();
    deps.register = vi.fn(async () => ({ ok: true as const }));
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await register(deps, application);

    expect(error).toHaveBeenCalledWith(
      "Daemon register request returned no application",
    );
    expect(process.exitCode).toBe(1);
  });
});

describe("parseRegisterOptions", () => {
  it("builds a raw application from the individual flags", () => {
    const parsed = parseRegisterOptions({
      name: "app",
      gitRepositoryUrl: "https://example.com/app.git",
      dockerfilePath: "Dockerfile",
      buildContextPath: "services/app",
      portMapping: ["8080:80", "8443:443"],
      volume: ["data:/var/lib/app"],
      env: ["A=1", "B=${hostEnv:CONTAINER_TOKEN}"],
    });

    expect(parsed).toEqual({
      ok: true,
      application: {
        ...application,
        BuildContextPath: "services/app",
        PortMappings: ["8080:80", "8443:443"],
        Volumes: ["data:/var/lib/app"],
        EnvironmentVariables: { A: "1", B: "${hostEnv:CONTAINER_TOKEN}" },
      },
    });
  });

  it("omits optional fields when their flags are absent", () => {
    const parsed = parseRegisterOptions({
      name: "app",
      gitRepositoryUrl: "https://example.com/app.git",
      dockerfilePath: "Dockerfile",
      buildContextPath: "services/app",
      portMapping: [],
      volume: [],
      env: [],
    });

    expect(parsed).toEqual({
      ok: true,
      application: { ...application, BuildContextPath: "services/app" },
    });
  });

  it("accepts a whole application as JSON", () => {
    const parsed = parseRegisterOptions({
      json: JSON.stringify({
        ...application,
        BuildContextPath: "services/app",
        PortMappings: ["8080:80"],
      }),
    });

    expect(parsed).toEqual({
      ok: true,
      application: {
        ...application,
        BuildContextPath: "services/app",
        PortMappings: ["8080:80"],
      },
    });
  });

  it("rejects mixing --json with the individual flags", () => {
    const parsed = parseRegisterOptions({
      json: JSON.stringify(application),
      name: "other",
    });

    expect(parsed).toEqual({
      ok: false,
      message: "Use either --json or the individual flags, not both.",
    });
  });

  it("rejects malformed JSON", () => {
    const parsed = parseRegisterOptions({ json: "{" });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(/^Invalid --json\./);
  });

  it("rejects an --env flag without a key and value", () => {
    const parsed = parseRegisterOptions({
      name: "app",
      gitRepositoryUrl: "https://example.com/app.git",
      dockerfilePath: "Dockerfile",
      env: ["=1"],
    });

    expect(parsed).toEqual({
      ok: false,
      message: "Invalid --env '=1'. Must have the format KEY=VALUE",
    });
  });

  it("rejects an application the schema refuses", () => {
    const parsed = parseRegisterOptions({
      name: "not a valid name",
      gitRepositoryUrl: "https://example.com/app.git",
      dockerfilePath: "Dockerfile",
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toMatch(
      /^Invalid application\./,
    );
  });

  it("rejects a port mapping the schema refuses before contacting the daemon", () => {
    const parsed = parseRegisterOptions({
      name: "app",
      gitRepositoryUrl: "https://example.com/app.git",
      dockerfilePath: "Dockerfile",
      portMapping: ["80"],
    });

    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.message).toContain(
      "Invalid port mappings",
    );
  });

  it.each(["", "/outside", "../outside"])(
    "rejects an invalid build context path from flags before contacting the daemon: %s",
    (buildContextPath) => {
      const parsed = parseRegisterOptions({
        name: "app",
        gitRepositoryUrl: "https://example.com/app.git",
        dockerfilePath: "Dockerfile",
        buildContextPath,
      });

      expect(parsed.ok).toBe(false);
      expect(parsed.ok ? "" : parsed.message).toContain(
        "Invalid BuildContextPath",
      );
    },
  );
});
