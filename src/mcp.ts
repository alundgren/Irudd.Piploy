import http from "node:http";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

import {
  defaultLogTailLines,
  maxLogBytes,
  maxLogTailLines,
} from "./containerLogs.js";
import type { DaemonRequest, DaemonResponse } from "./daemon.js";
import type { ApplicationSchema } from "./settings.js";
import { piployVersion } from "./version.js";

/** Fixed for v1. Making the port configurable is deliberately deferred. */
export const mcpPort = 8391;
const mcpPath = "/mcp";
const flushGraceMs = 250;

export type McpDispatch = (request: DaemonRequest) => Promise<DaemonResponse>;

export interface McpServerOptions {
  /** Explicit so tests can bind 127.0.0.1 without a Tailscale interface. */
  address: string;
  port: number;
  dispatch: McpDispatch;
  /** Reports a failure the caller cannot act on, such as a dropped request. */
  onError(error: unknown): void;
}

export interface McpServerHandle {
  url: string;
  port: number;
  stop(): Promise<void>;
}

/**
 * Describes the register payload for the calling client. `ApplicationSchema`
 * is still the one authority that validates it, on the daemon side, and the
 * payload reaches it untransformed, because what it validates is what gets
 * written to `piploy.json` (ADR-0007). It cannot be reused here for the same
 * reason: its own fields parse the written strings into richer values.
 *
 * The `satisfies` clause is the guard against the two drifting: a field added
 * to `ApplicationSchema` fails to compile until it is described here too.
 */
const registerInputSchema = {
  Name: z.string(),
  GitRepositoryUrl: z.string(),
  DockerfilePath: z.string(),
  PortMappings: z.array(z.string()).optional(),
  Volumes: z.array(z.string()).optional(),
  EnvironmentVariables: z.record(z.string(), z.string()).optional(),
} satisfies Record<
  keyof Required<z.input<typeof ApplicationSchema>>,
  z.ZodType
>;

function toolResult(response: DaemonResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    isError: !response.ok,
  };
}

/**
 * Registers the six commands that are safe to expose on the tailnet. The
 * exclusion of `wipeall` and `self-update` is structural: they are simply
 * never registered here, so there is no block list to keep in sync.
 */
function createMcpServer(dispatch: McpDispatch): McpServer {
  const server = new McpServer({ name: "piploy", version: piployVersion });

  server.registerTool(
    "status",
    {
      description:
        "Report each registered application's configured host-to-container port mappings (an empty array means none), git commits, Docker image and container hashes, whether it runs the latest version, and its container's state, exit code, and restart count. A 'restarting' state with a non-zero exit code means the container is crash-looping.",
    },
    async () => toolResult(await dispatch({ command: "status" })),
  );

  server.registerTool(
    "logs",
    {
      description: `Read the recent stdout and stderr of one application's container, running or exited. Returns at most ${maxLogTailLines} lines (default ${defaultLogTailLines}) and at most ${maxLogBytes} bytes, keeping the most recent output. Application logs may contain secrets; they are returned unredacted.`,
      inputSchema: {
        application: z.string(),
        tail: z.number().int().min(1).max(maxLogTailLines).optional(),
      },
    },
    async ({ application, tail }) =>
      toolResult(await dispatch({ command: "logs", application, tail })),
  );

  server.registerTool(
    "poll",
    {
      description:
        "Run one reconciliation pass now: fetch each application's repository, rebuild, and restart what is out of date.",
    },
    async () => toolResult(await dispatch({ command: "poll" })),
  );

  server.registerTool(
    "register",
    {
      description:
        "Register one application in piploy.json. Registering does not start it; the next poll does.",
      inputSchema: registerInputSchema,
    },
    async (application) =>
      toolResult(await dispatch({ command: "register", application })),
  );

  server.registerTool(
    "service-start",
    {
      description:
        "Start the Piploy background daemon. Answering this call at all proves the daemon is already running.",
    },
    // The MCP server lives inside the daemon, so there is nothing to start and
    // nothing to enqueue. The tool exists to answer the question truthfully.
    () => ({
      content: [
        {
          type: "text" as const,
          text: "The Piploy daemon is already running.",
        },
      ],
    }),
  );

  server.registerTool(
    "service-stop",
    {
      description:
        "Stop the Piploy background daemon. This also ends this MCP server, which only runs inside the daemon.",
    },
    async () => toolResult(await dispatch({ command: "stop" })),
  );

  return server;
}

async function handleRequest(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  dispatch: McpDispatch,
): Promise<void> {
  if ((request.url ?? "").split("?")[0] !== mcpPath) {
    response.writeHead(404).end();
    return;
  }
  // Stateless mode (no session id, no session store): a server and transport
  // per request, because one McpServer assumes sole ownership of its
  // transport. Statelessness is what makes creating them per request cheap.
  const server = createMcpServer(dispatch);
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  });
  response.once("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(request, response);
}

/** Serves the MCP tools over Streamable HTTP on one explicit address. */
export function startMcpServer(
  options: McpServerOptions,
): Promise<McpServerHandle> {
  const server = http.createServer((request, response) => {
    handleRequest(request, response, options.dispatch).catch(
      (error: unknown) => {
        options.onError(error);
        if (!response.headersSent) response.writeHead(500);
        response.end();
      },
    );
  });

  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      // An 'error' after listening, such as a client resetting a connection,
      // is fatal to the process if nothing is listening for it. Losing the
      // daemon to a tailnet client's mistake is the one outcome to avoid.
      server.on("error", options.onError);
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      resolve({
        url: `http://${options.address}:${port}${mcpPath}`,
        port,
        stop: () =>
          new Promise((resolveStop, rejectStop) => {
            server.close((error) =>
              error ? rejectStop(error) : resolveStop(),
            );
            // Idle keep-alive connections would hold close() open forever, and
            // an in-flight one until it finishes. A stop asked for over MCP is
            // itself in flight here, so it gets a bounded moment to flush.
            server.closeIdleConnections();
            setTimeout(
              () => server.closeAllConnections(),
              flushGraceMs,
            ).unref();
          }),
      });
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(options.port, options.address);
  });
}
