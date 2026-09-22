import { createHmac } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  requestDaemon,
  startDaemon,
  type DaemonDeps,
} from "../../src/daemon.js";
import {
  canonicalGitHubRepository,
  startGitHubWebhookServer,
  webhookBodyLimit,
  webhookDeliveryLimit,
  webhookDeliveryWindowMilliseconds,
} from "../../src/githubWebhooks.js";
import type { Logger, LogScope } from "../../src/logger.js";
import { loadConfiguration, parseSettings } from "../../src/settings.js";

const secret = "test-signing-secret-never-log";
const application = (
  Name: string,
  GitRepositoryUrl = "https://github.com/Owner/project.git",
) => ({ Name, GitRepositoryUrl, DockerfilePath: "Dockerfile" });
const payload = () => ({
  ref: "refs/heads/trunk",
  deleted: false,
  repository: {
    html_url: "https://github.com/owner/project",
    default_branch: "trunk",
  },
});
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    cleanups
      .splice(0)
      .reverse()
      .map((cleanup) => cleanup()),
  );
});
function logger() {
  const records: unknown[] = [];
  const scoped = (scope: LogScope): Logger => ({
    info: (message) => {
      records.push({ ...scope, message });
    },
    warn: (message) => {
      records.push({ ...scope, message });
    },
    error: (message) => {
      records.push({ ...scope, message });
    },
    debug: () => {},
    child: (child) => scoped({ ...scope, ...child }),
  });
  return { log: scoped({}), records };
}
let id = 0;
async function send(
  port: number,
  body: unknown = payload(),
  overrides: {
    event?: string;
    delivery?: string;
    signature?: string;
    method?: string;
    route?: string;
  } = {},
) {
  const raw = typeof body === "string" ? body : JSON.stringify(body);
  return new Promise<number>((resolve, reject) => {
    const request = http.request(
      {
        host: "127.0.0.1",
        port,
        path: overrides.route ?? "/public/github-webhook",
        method: overrides.method ?? "POST",
        headers: {
          "x-hub-signature-256":
            overrides.signature ??
            `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
          "x-github-event": overrides.event ?? "push",
          "x-github-delivery": overrides.delivery ?? `delivery-${++id}`,
        },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve(response.statusCode!));
      },
    );
    request.on("error", reject);
    request.end(raw);
  });
}
async function listener() {
  const logs = logger();
  const admit = vi.fn(() => "accepted" as const);
  const server = await startGitHubWebhookServer({
    port: 0,
    secret,
    logger: logs.log,
    admit,
  });
  cleanups.push(() => server.stop());
  return { ...server, ...logs, admit };
}
async function unusedPort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
async function daemon(
  options: {
    capacity?: number;
    poll?: DaemonDeps["poll"];
    enabled?: boolean;
    missingSecret?: boolean;
    port?: number;
    applications?: ReturnType<typeof application>[];
  } = {},
) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "piploy-webhook-"));
  const port = options.port ?? (await unusedPort());
  const logs = logger();
  const configPath = path.join(directory, "piploy.json");
  const raw = {
    Piploy: {
      RootDirectory: path.join(directory, "work"),
      Applications: options.applications ?? [
        application("One"),
        application("Two", "https://GITHUB.com/OWNER/PROJECT"),
        application("Other", "https://git.example/owner/project"),
      ],
      GitHubWebhooks: {
        Enabled: options.enabled ?? true,
        Port: port,
        PublicUrl: "https://hooks.example",
        Secret: "${hostEnv:PIPLOY_TEST_WEBHOOK_SECRET}",
      },
    },
  };
  await writeFile(configPath, JSON.stringify(raw));
  vi.stubEnv("PIPLOY_TEST_WEBHOOK_SECRET", options.missingSecret ? "" : secret);
  const poll = vi.fn(options.poll ?? (async () => []));
  const loaded = loadConfiguration(configPath);
  const running = await startDaemon(loaded.settings, logs.log, {
    socketPath: path.join(directory, "daemon.sock"),
    configPath,
    loadedConfigurationRevision: loaded.revision,
    queueCapacity: options.capacity,
    getTailscaleAddress: () => undefined,
    deps: {
      poll,
      getStatus: async () => ({ applications: [] }),
      getLogs: async () => ({ ok: false, reason: "unknown-application" }),
      checkGitHubRepositoryAccess: async () => ({
        accessible: false,
        reason: "transport-or-fetch-failure",
      }),
      attemptSelfUpdate: async () => "up-to-date",
    },
  });
  cleanups.push(async () => {
    await running.stop();
    await rm(directory, { recursive: true, force: true });
  });
  return { ...running, port, poll, configPath, raw, ...logs };
}

describe("webhook configuration and repository identities", () => {
  it("defaults off and retains only the exact host reference", () => {
    const config = {
      Piploy: { RootDirectory: "/work", Applications: [], GitHubWebhooks: {} },
    };
    expect(parseSettings(config).GitHubWebhooks?.Enabled).toBe(false);
    expect(() =>
      parseSettings({
        Piploy: { ...config.Piploy, GitHubWebhooks: { Enabled: true } },
      }),
    ).toThrow();
    const value = {
      Enabled: true,
      Port: 1234,
      PublicUrl: "https://hooks.example/",
      Secret: "${hostEnv:SIGNING_SECRET}",
    };
    expect(
      parseSettings({ Piploy: { ...config.Piploy, GitHubWebhooks: value } })
        .GitHubWebhooks,
    ).toEqual(value);
    for (const change of [
      { Port: 0 },
      { Port: 65536 },
      { Port: 3.5 },
      { PublicUrl: "http://hooks.example" },
      { PublicUrl: "https://user:password@hooks.example" },
      { PublicUrl: "https://hooks.example/path" },
      { PublicUrl: "https://hooks.example?x" },
      { PublicUrl: "https://hooks.example#x" },
      { Secret: "literal-secret" },
      { Secret: " ${hostEnv:SECRET}" },
    ]) {
      expect(() =>
        parseSettings({
          Piploy: { ...config.Piploy, GitHubWebhooks: { ...value, ...change } },
        }),
      ).toThrow();
    }
  });
  it("accepts only canonical GitHub owner/repository URLs", () => {
    expect(canonicalGitHubRepository("https://GITHUB.com/Owner/Repo.GIT")).toBe(
      "owner/repo",
    );
    for (const url of [
      "http://github.com/a/b",
      "https://user:token@github.com/a/b",
      "https://github.com:443/a/b",
      "https://github.com.evil/a/b",
      "https://github.com/a/b/c",
      "https://github.com/a/b/",
      "https://github.com/a/../b",
      "https://github.com/a/%62",
      "https://github.com/a/b?x",
      "https://github.com/a/b#x",
      "git@github.com:a/b.git",
      "https://github.com/a/.git",
    ])
      expect(canonicalGitHubRepository(url)).toBeUndefined();
  });
});

describe("public HTTP receiver", () => {
  it("restricts methods and paths and never exposes private APIs", async () => {
    const server = await listener();
    for (const route of [
      "/mcp",
      "/status",
      "/logs",
      "/",
      "/public/github-webhook?x",
    ])
      expect(await send(server.port, {}, { route })).toBe(404);
    expect(await send(server.port, {}, { method: "GET" })).toBe(405);
    expect(server.admit).not.toHaveBeenCalled();
  });
  it("verifies exact raw bytes and accepts a non-main default branch", async () => {
    const server = await listener();
    const raw = JSON.stringify({ ...payload(), extra: "unicode ☃" }, null, 2);
    expect(await send(server.port, raw)).toBe(202);
    expect(server.admit).toHaveBeenCalledWith(
      "owner/project",
      expect.any(String),
    );
    expect(
      await send(server.port, raw + " ", {
        signature: `sha256=${createHmac("sha256", secret).update(raw).digest("hex")}`,
      }),
    ).toBe(401);
  });
  it("rejects missing/invalid signatures, malformed JSON and payloads and oversized bodies", async () => {
    const server = await listener();
    for (const signature of ["", "sha1=abc", "sha256=" + "0".repeat(64)])
      expect(await send(server.port, payload(), { signature })).toBe(401);
    for (const bad of [
      "{",
      "[]",
      "null",
      {},
      { ...payload(), deleted: "false" },
      {
        ...payload(),
        repository: {
          html_url: "https://github.com/a/b",
          default_branch: "bad..branch",
        },
      },
      {
        ...payload(),
        repository: {
          html_url: "https://token@github.com/a/b",
          default_branch: "trunk",
        },
      },
    ])
      expect(await send(server.port, bad)).toBe(400);
    expect(await send(server.port, "x".repeat(webhookBodyLimit + 1))).toBe(413);
    expect(server.admit).not.toHaveBeenCalled();
    expect(JSON.stringify(server.records)).not.toContain(secret);
    expect(JSON.stringify(server.records)).not.toContain("sha256=");
    expect(JSON.stringify(server.records)).not.toContain("token@");
  });
  it("acknowledges ping, other events, nondefault branches and deletion without work", async () => {
    const server = await listener();
    expect(await send(server.port, {}, { event: "ping" })).toBe(200);
    expect(await send(server.port, {}, { event: "issues" })).toBe(200);
    expect(
      await send(server.port, { ...payload(), ref: "refs/heads/feature" }),
    ).toBe(200);
    expect(await send(server.port, { ...payload(), deleted: true })).toBe(200);
    expect(server.admit).not.toHaveBeenCalled();
  });
});

it("bounds slow HTTP connections and stops without admitting partial bodies", async () => {
  const server = await listener();
  const socket = net.createConnection({ host: "127.0.0.1", port: server.port });
  socket.on("error", () => {});
  await new Promise<void>((resolve) => socket.once("connect", resolve));
  const start = Date.now();
  const closed = new Promise<void>((resolve) =>
    socket.once("close", () => resolve()),
  );
  socket.write("POST /public/github-webhook HTTP/1.1\r\nHost: localhost\r\n");
  await closed;
  expect(Date.now() - start).toBeLessThan(6500);
  expect(server.admit).not.toHaveBeenCalled();
}, 8000);

describe("webhook admission through the real daemon listener", () => {
  it("acknowledges during a blocked build, fans out, coalesces, and follows an active Poll", async () => {
    const startup = deferred();
    const active = deferred();
    const instance = await daemon({
      poll: async (_signal, name) => {
        if (!name) await startup.promise;
        else if (name === "One") await active.promise;
        return [];
      },
    });
    expect(instance.records).toContainEqual(
      expect.objectContaining({
        event: "github-webhook-listener",
        publicUrl: "https://hooks.example/public/github-webhook",
      }),
    );
    const start = Date.now();
    expect(await send(instance.port, payload(), { delivery: "first" })).toBe(
      202,
    );
    expect(Date.now() - start).toBeLessThan(1000);
    expect(await send(instance.port, payload(), { delivery: "first" })).toBe(
      202,
    );
    expect(await send(instance.port)).toBe(202);
    expect(instance.poll).toHaveBeenCalledTimes(1);
    startup.resolve();
    await vi.waitFor(() => expect(instance.poll).toHaveBeenCalledTimes(2));
    expect(await send(instance.port)).toBe(202);
    active.resolve();
    await vi.waitFor(() => expect(instance.poll).toHaveBeenCalledTimes(4));
    expect(instance.poll.mock.calls.map((args) => args[1])).toEqual([
      undefined,
      "One",
      "Two",
      "One",
    ]);
    expect(instance.records).toContainEqual(
      expect.objectContaining({
        event: "github-webhook-receipt",
        outcome: "coalesced",
      }),
    );
    expect(instance.records).toContainEqual(
      expect.objectContaining({
        event: "github-webhook-receipt",
        outcome: "duplicate",
      }),
    );
  });
  it("reserves the entire fan-out and never remembers a rejected delivery", async () => {
    const startup = deferred();
    const instance = await daemon({
      capacity: 2,
      poll: async (_signal, name) => {
        if (!name) await startup.promise;
        return [];
      },
    });
    const manual = requestDaemon(
      { command: "poll", application: "Other" },
      instance.socketPath,
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await send(instance.port, payload(), { delivery: "retry" })).toBe(
      503,
    );
    expect(instance.poll).toHaveBeenCalledTimes(1);
    startup.resolve();
    await manual;
    expect(await send(instance.port, payload(), { delivery: "retry" })).toBe(
      202,
    );
    await vi.waitFor(() => expect(instance.poll).toHaveBeenCalledTimes(4));
    expect(instance.poll.mock.calls.map((args) => args[1])).toEqual([
      undefined,
      "Other",
      "One",
      "Two",
    ]);
  });
  it("ignores unknown repositories and rejects stale config even for duplicate IDs", async () => {
    const instance = await daemon();
    expect(
      await send(instance.port, {
        ...payload(),
        repository: {
          html_url: "https://github.com/unknown/project",
          default_branch: "trunk",
        },
      }),
    ).toBe(200);
    expect(instance.poll).toHaveBeenCalledTimes(1);
    expect(await send(instance.port, payload(), { delivery: "accepted" })).toBe(
      202,
    );
    await writeFile(instance.configPath, JSON.stringify(instance.raw) + " ");
    expect(await send(instance.port, payload(), { delivery: "accepted" })).toBe(
      503,
    );
    expect(await send(instance.port)).toBe(503);
  });
  it("matches newly registered Applications from live trusted configuration", async () => {
    const instance = await daemon({ applications: [] });
    expect(
      await requestDaemon(
        { command: "register", application: application("New") },
        instance.socketPath,
      ),
    ).toEqual({ ok: true, application: application("New") });
    expect(await send(instance.port)).toBe(202);
    await vi.waitFor(() =>
      expect(instance.poll.mock.calls.map((args) => args[1])).toEqual([
        undefined,
        "New",
      ]),
    );
  });
  it("bounds duplicate memory by age and entry count", async () => {
    const startup = deferred();
    const instance = await daemon({
      poll: async () => {
        await startup.promise;
        return [];
      },
    });
    expect(await send(instance.port, payload(), { delivery: "oldest" })).toBe(
      202,
    );
    for (let index = 0; index < webhookDeliveryLimit; index++)
      await send(instance.port, payload(), { delivery: `bounded-${index}` });
    expect(await send(instance.port, payload(), { delivery: "oldest" })).toBe(
      202,
    );
    expect(instance.records.at(-1)).toEqual(
      expect.objectContaining({ outcome: "coalesced" }),
    );
    const future = Date.now() + webhookDeliveryWindowMilliseconds + 1;
    vi.spyOn(Date, "now").mockReturnValue(future);
    expect(await send(instance.port, payload(), { delivery: "oldest" })).toBe(
      202,
    );
    expect(instance.records.at(-1)).toEqual(
      expect.objectContaining({ outcome: "coalesced" }),
    );
    startup.resolve();
  }, 15000);
  it("keeps ordinary commands alive when disabled, missing a secret or unable to bind", async () => {
    for (const options of [{ enabled: false }, { missingSecret: true }]) {
      const instance = await daemon(options);
      await expect(send(instance.port)).rejects.toThrow();
      expect(
        (await requestDaemon({ command: "status" }, instance.socketPath))?.ok,
      ).toBe(true);
    }
    const occupied = await listener();
    const instance = await daemon({ port: occupied.port });
    expect(
      (await requestDaemon({ command: "status" }, instance.socketPath))?.ok,
    ).toBe(true);
    expect(instance.records).toContainEqual(
      expect.objectContaining({
        message: expect.stringContaining("could not bind"),
      }),
    );
    expect(JSON.stringify(instance.records)).not.toContain(secret);
  });
  it("aborts active work, clears pending work and closes in-flight requests on shutdown", async () => {
    const started = deferred();
    const instance = await daemon({
      poll: async (signal) => {
        started.resolve();
        await new Promise<void>((resolve) =>
          signal!.addEventListener("abort", () => resolve(), { once: true }),
        );
        return [];
      },
    });
    await started.promise;
    expect(await send(instance.port)).toBe(202);
    const socket = net.createConnection({
      host: "127.0.0.1",
      port: instance.port,
    });
    socket.on("error", () => {});
    await new Promise<void>((resolve) => socket.once("connect", resolve));
    const closed = new Promise<void>((resolve) =>
      socket.once("close", () => resolve()),
    );
    socket.write("POST /public/github-webhook HTTP/1.1\r\nHost: localhost\r\n");
    await instance.stop();
    await closed;
    expect(instance.poll).toHaveBeenCalledTimes(1);
    expect(instance.poll.mock.calls[0]![0]?.aborted).toBe(true);
    await expect(send(instance.port)).rejects.toThrow();
  });
  it("logs a failed Application Poll separately from accepted admission", async () => {
    const instance = await daemon({
      poll: async (_signal, name) =>
        name
          ? [
              {
                application: name,
                ok: false,
                stage: "build",
                message: "build failed",
              },
            ]
          : [],
    });
    expect(await send(instance.port)).toBe(202);
    await vi.waitFor(() =>
      expect(instance.records).toContainEqual(
        expect.objectContaining({
          event: "github-webhook-poll",
          outcome: "failed",
          application: "One",
        }),
      ),
    );
  });
});
