import { afterEach, expect, it, vi } from "vitest";
import {
  startHookReconciliation,
  hookReconciliationIntervalMilliseconds as interval,
  hookRequestTimeoutMilliseconds,
  type HookReconciliation,
} from "../../src/githubHookReconciliation.js";
import type { Logger } from "../../src/logger.js";
import type { PiploySettings } from "../../src/settings.js";

const secret = "signing-secret-fixture";
const token = "token-fixture";
const callback = "https://hooks.example/public/github-webhook";
const hook = () => ({
  active: true,
  events: ["push"],
  config: { url: callback, content_type: "json", insecure_ssl: "0" },
});
const application = (
  url = "https://github.com/OWNER/repo.git",
  Name = "One",
) => ({ Name, GitRepositoryUrl: url, DockerfilePath: "Dockerfile" });
const stops: HookReconciliation[] = [];
afterEach(async () => {
  for (const running of stops.splice(0)) await running.stop();
  vi.useRealTimers();
  vi.unstubAllEnvs();
});
function setup(fetcher: typeof fetch, applications = [application()]) {
  vi.stubEnv("HOOK_TOKEN", token);
  const settings: PiploySettings = {
    RootDirectory: "/tmp/work",
    Applications: applications,
    GitHubOwnerCredentials: { owner: "${hostEnv:HOOK_TOKEN}" },
    GitHubWebhooks: {
      Enabled: true,
      PublicUrl: "https://hooks.example",
      Secret: "${hostEnv:SIGNING}",
    },
  };
  const records: unknown[] = [];
  const logger: Logger = {
    info: (text) => {
      records.push(text);
    },
    warn: () => {},
    debug: () => {},
    error: () => {},
    child: (scope) => {
      records.push(scope);
      return logger;
    },
  };
  let available = true;
  const running = startHookReconciliation({
    settings,
    secret,
    logger,
    fetch: fetcher,
    available: () => available,
  });
  stops.push(running);
  return {
    running,
    settings,
    records,
    unavailable: () => {
      available = false;
    },
  };
}
const json = (data: unknown, status = 200, headers?: HeadersInit) =>
  new Response(JSON.stringify(data), { status, headers });
async function settled(running: HookReconciliation, count = 1) {
  await vi.waitFor(() => expect(running.status()).toHaveLength(count));
}

it("creates once across normalized/shared repositories and restart, leaving unrelated hooks alone", async () => {
  const hooks = [
    {
      ...hook(),
      config: { ...hook().config, url: "https://unrelated.example" },
    },
  ];
  const api = vi.fn<typeof fetch>(async (_url, init) => {
    if (init?.method === "POST") {
      hooks.push(hook());
      return json({}, 201);
    }
    return json(hooks);
  });
  const first = setup(api, [
    application(),
    application("https://GITHUB.com/owner/REPO", "Two"),
  ]);
  await settled(first.running);
  expect(api).toHaveBeenCalledTimes(2);
  const [url, init] = api.mock.calls[1]!;
  expect(url).toBe("https://api.github.com/repos/owner/repo/hooks");
  expect(init?.redirect).toBe("manual");
  expect(JSON.parse(init!.body as string)).toEqual({
    name: "web",
    active: true,
    events: ["push"],
    config: { url: callback, content_type: "json", secret, insecure_ssl: "0" },
  });
  await first.running.stop();
  const second = setup(api);
  await settled(second.running);
  expect(second.running.status()[0]?.outcome).toBe("existing");
  expect(
    api.mock.calls.filter(([, init]) => init?.method === "POST"),
  ).toHaveLength(1);
  expect(
    JSON.stringify([
      first.records,
      second.records,
      second.running.status(),
      first.settings,
    ]),
  ).not.toContain(token);
  expect(
    JSON.stringify([
      first.records,
      second.records,
      second.running.status(),
      first.settings,
    ]),
  ).not.toContain(secret);
});
it("reads every page and never changes exact-URL disabled or mismatched hooks", async () => {
  const api = vi.fn<typeof fetch>(async (url) =>
    String(url).endsWith("page=1")
      ? json(
          Array.from({ length: 100 }, () => ({
            config: { url: "https://other.example" },
          })),
        )
      : json([
          {
            active: false,
            events: ["issues"],
            config: { url: callback, content_type: "form", insecure_ssl: "1" },
          },
        ]),
  );
  const { running } = setup(api);
  await settled(running);
  expect(api).toHaveBeenCalledTimes(2);
  expect(running.status()[0]).toMatchObject({ outcome: "operator-action" });
  expect(running.status()[0]?.message).toContain("listing cannot verify");
  for (const [, init] of api.mock.calls) expect(init?.method).toBe("GET");
});
it.each([401, 403, 404, 422, 500, 302, 429])(
  "reports safe HTTP %i failure and still handles another repository",
  async (status) => {
    const api = vi.fn<typeof fetch>(async (url) =>
      String(url).includes("/repo/")
        ? json(
            { message: secret + token },
            status,
            status === 302 ? { location: "https://evil.example" } : undefined,
          )
        : json([hook()]),
    );
    const { running, records } = setup(api, [
      application(),
      application("https://github.com/owner/second", "Two"),
    ]);
    await settled(running, 2);
    expect(running.status()[0]?.outcome).toBe("failed");
    if (status !== 429) expect(running.status()[1]?.outcome).toBe("existing");
    expect(JSON.stringify([records, running.status()])).not.toContain(secret);
    for (const [url, init] of api.mock.calls) {
      expect(new URL(String(url)).origin).toBe("https://api.github.com");
      expect(init?.redirect).toBe("manual");
    }
  },
);
it("never exposes thrown API text, even text starting with GitHub", async () => {
  const { running, records } = setup(async () => {
    throw new Error(`GitHub ${token} ${secret}`);
  });
  await settled(running);
  expect(JSON.stringify([records, running.status()])).not.toContain(token);
});
it("does not resolve credentials or call the API for unsupported repositories", async () => {
  const api = vi.fn<typeof fetch>();
  const { running } = setup(api, [
    application("https://github.com.evil/owner/repo"),
    application("https://user:password@github.com/owner/repo", "Two"),
    application("git@github.com:owner/repo", "Three"),
  ]);
  await settled(running, 3);
  expect(api).not.toHaveBeenCalled();
});
it("reports absent owner credentials without sending requests", async () => {
  const api = vi.fn<typeof fetch>();
  const { running } = setup(api, [
    application("https://github.com/other/repo"),
  ]);
  await settled(running);
  expect(api).not.toHaveBeenCalled();
  expect(running.status()[0]?.message).toContain("GitHubOwnerCredentials");
});
it.each([false, true])(
  "lists again after an uncertain create, created remotely=%s",
  async (created) => {
    vi.useFakeTimers();
    let attempted = false;
    const api = vi.fn<typeof fetch>(async (_url, init) => {
      if (init?.method === "POST") {
        attempted = true;
        throw new Error(secret);
      }
      return json(attempted && created ? [hook()] : []);
    });
    const { running } = setup(api);
    await vi.advanceTimersByTimeAsync(1);
    expect(running.status()[0]?.outcome).toBe("failed");
    for (let n = 0; n < 50; n++) running.request();
    await vi.advanceTimersByTimeAsync(1);
    expect(api).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(interval * 2);
    expect(api.mock.calls[2]?.[1]?.method).toBe("GET");
    expect(
      api.mock.calls.filter(([, init]) => init?.method === "POST"),
    ).toHaveLength(created ? 1 : 3);
  },
);
it("coalesces concurrent triggers, handles registration and checks availability before creating", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const api = vi.fn<typeof fetch>(async () => {
    await gate;
    return json([]);
  });
  const { running, settings, unavailable } = setup(api);
  settings.Applications.push(
    application("https://github.com/owner/new", "New"),
  );
  for (let n = 0; n < 20; n++) running.request();
  expect(api).toHaveBeenCalledTimes(1);
  unavailable();
  release();
  await settled(running);
  expect(api).toHaveBeenCalledTimes(1);
});
it("times out requests and cancels in-flight requests on shutdown", async () => {
  vi.useFakeTimers();
  const api = vi.fn<typeof fetch>(
    async (_url, init) =>
      new Promise((_resolve, reject) =>
        init!.signal!.addEventListener("abort", () =>
          reject(new Error(secret)),
        ),
      ),
  );
  const { running } = setup(api);
  await vi.advanceTimersByTimeAsync(hookRequestTimeoutMilliseconds + 1);
  expect(running.status()[0]?.outcome).toBe("failed");
  await vi.advanceTimersByTimeAsync(interval * 2);
  await running.stop();
  const count = api.mock.calls.length;
  await vi.advanceTimersByTimeAsync(interval * 4);
  expect(api).toHaveBeenCalledTimes(count);
});
it("honors rate-limit reset and retry-after without tight retries", async () => {
  vi.useFakeTimers();
  const api = vi.fn<typeof fetch>(async () =>
    json({}, 403, {
      "retry-after": "3600",
      "x-ratelimit-remaining": "0",
      "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 3600),
    }),
  );
  const { running } = setup(api);
  await vi.advanceTimersByTimeAsync(interval * 3);
  expect(api).toHaveBeenCalledTimes(1);
  await running.stop();
});

it("refuses creation after an invalid or oversized list", async () => {
  for (const body of [
    [null],
    { unexpected: secret },
    [{ config: { url: "x".repeat(1024 * 1024) } }],
  ]) {
    const api = vi.fn<typeof fetch>(async () => json(body));
    const { running } = setup(api);
    await settled(running);
    expect(running.status()[0]?.outcome).toBe("failed");
    expect(api).toHaveBeenCalledTimes(1);
    await running.stop();
  }
});
