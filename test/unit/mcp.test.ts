import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { afterEach, describe, expect, it } from "vitest";

import type { DaemonRequest, DaemonResponse } from "../../src/daemon.js";
import { startMcpServer, type McpServerHandle } from "../../src/mcp.js";

interface Harness {
  client: Client;
  requests: DaemonRequest[];
}

// callTool's result type is a union with the legacy compatibility shape, so
// the text content is narrowed here rather than at every call site.
function textOf(result: unknown): string {
  const { content } = result as { content?: { text: string }[] };
  return (content ?? []).map((part) => part.text).join("");
}

describe("mcp server", () => {
  const servers: McpServerHandle[] = [];
  const clients: Client[] = [];

  afterEach(async () => {
    await Promise.all(clients.splice(0).map((client) => client.close()));
    await Promise.all(servers.splice(0).map((server) => server.stop()));
  });

  async function start(
    respond: (request: DaemonRequest) => DaemonResponse = () => ({ ok: true }),
  ): Promise<Harness> {
    const requests: DaemonRequest[] = [];
    // CI has no Tailscale interface, so the address is a plain parameter and
    // the port is left to the operating system.
    const server = await startMcpServer({
      address: "127.0.0.1",
      port: 0,
      dispatch: async (request) => {
        requests.push(request);
        return respond(request);
      },
      onError: (error) => {
        throw error;
      },
    });
    servers.push(server);

    const client = new Client({ name: "test", version: "0" });
    await client.connect(
      new StreamableHTTPClientTransport(new URL(server.url)),
    );
    clients.push(client);
    return { client, requests };
  }

  it("exposes exactly the six safe commands as tools", async () => {
    const { client } = await start();

    const { tools } = await client.listTools();

    expect(tools.map((tool) => tool.name).sort()).toEqual([
      "logs",
      "poll",
      "register",
      "service-start",
      "service-stop",
      "status",
    ]);
  });

  it("describes status port mappings", async () => {
    const { client } = await start();

    const { tools } = await client.listTools();

    expect(tools.find((tool) => tool.name === "status")?.description).toContain(
      "host-to-container port mappings",
    );
    expect(tools.find((tool) => tool.name === "status")?.description).toContain(
      "gitError",
    );
  });

  it("warns that logs are returned unredacted", async () => {
    const { client } = await start();

    const { tools } = await client.listTools();

    expect(tools.find((tool) => tool.name === "logs")?.description).toContain(
      "may contain secrets",
    );
  });

  it("routes logs through the daemon dispatcher with the requested tail", async () => {
    const logs = {
      application: "app",
      containerState: "restarting",
      text: "boom\n",
      truncated: false,
      tail: 10,
    };
    const { client, requests } = await start(() => ({ ok: true, logs }));

    const result = await client.callTool({
      name: "logs",
      arguments: { application: "app", tail: 10 },
    });

    expect(requests).toEqual([
      { command: "logs", application: "app", tail: 10 },
    ]);
    expect(JSON.parse(textOf(result))).toEqual({ ok: true, logs });
  });

  it("rejects a logs tail above the hard maximum before dispatching", async () => {
    const { client, requests } = await start();

    const result = await client.callTool({
      name: "logs",
      arguments: { application: "app", tail: 1_000_000 },
    });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("tail");
    expect(requests).toEqual([]);
  });

  it("routes status through the daemon dispatcher", async () => {
    const status = { applications: [] };
    const { client, requests } = await start(() => ({ ok: true, status }));

    const result = await client.callTool({ name: "status" });

    expect(requests).toEqual([{ command: "status" }]);
    expect(JSON.parse(textOf(result))).toEqual({ ok: true, status });
  });

  it("routes poll through the daemon dispatcher", async () => {
    const applications = [
      {
        application: "app",
        ok: false as const,
        stage: "start" as const,
        code: "portAlreadyInUse" as const,
        message: "Port 8080 is already in use",
      },
    ];
    const { client, requests } = await start(() => ({
      ok: true,
      applications,
    }));

    const result = await client.callTool({ name: "poll" });

    expect(requests).toEqual([{ command: "poll" }]);
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result))).toEqual({ ok: true, applications });
  });

  it("routes service-stop to the daemon stop command", async () => {
    const { client, requests } = await start();

    const result = await client.callTool({ name: "service-stop" });

    expect(requests).toEqual([{ command: "stop" }]);
    expect(result.isError).toBeFalsy();
  });

  it("passes register arguments through untransformed", async () => {
    const application = {
      Name: "app",
      GitRepositoryUrl: "https://example.com/app.git",
      DockerfilePath: "Dockerfile",
      BuildContextPath: "services/app",
      PortMappings: ["8080:80"],
      EnvironmentVariables: { TOKEN: "${hostEnv:CONTAINER_TOKEN}" },
    };
    const { client, requests } = await start((request) =>
      request.command === "register"
        ? { ok: true, application: request.application as never }
        : { ok: true },
    );

    const result = await client.callTool({
      name: "register",
      arguments: application,
    });

    expect(requests).toEqual([{ command: "register", application }]);
    expect(JSON.parse(textOf(result))).toEqual({ ok: true, application });
  });

  it("answers service-start without touching the daemon queue", async () => {
    const { client, requests } = await start();

    const result = await client.callTool({ name: "service-start" });

    expect(requests).toEqual([]);
    expect(textOf(result)).toContain("already running");
  });

  it("reports a rejected request as a tool error", async () => {
    const { client } = await start(() => ({ ok: false, reason: "busy" }));

    const result = await client.callTool({ name: "poll" });

    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("busy");
  });
});
