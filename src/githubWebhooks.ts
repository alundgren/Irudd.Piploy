import { createHmac, timingSafeEqual } from "node:crypto";
import http from "node:http";

import type { Logger } from "./logger.js";

export const githubWebhookPath = "/public/github-webhook";
export function githubWebhookUrl(publicOrigin: string): string {
  return publicOrigin.replace(/\/$/, "") + githubWebhookPath;
}

export const webhookBodyLimit = 1024 * 1024;
export const webhookRequestTimeoutMilliseconds = 5000;
export const webhookConnectionLimit = 32;
export const webhookDeliveryLimit = 4096;
export const webhookDeliveryWindowMilliseconds = 60 * 60 * 1000;

/** Only canonical public GitHub HTTPS repository URLs identify Applications. */
export function canonicalGitHubRepository(value: string): string | undefined {
  const match =
    /^https:\/\/github\.com\/([a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?)\/([a-z0-9_.-]+)$/i.exec(
      value,
    );
  if (!match || match[1]!.includes("--")) return undefined;
  const repository = match[2]!.replace(/\.git$/i, "");
  if (!repository || repository === "." || repository === "..")
    return undefined;
  return `${match[1]!}/${repository}`.toLowerCase();
}

export type WebhookAdmission =
  | "accepted"
  | "coalesced"
  | "duplicate"
  | "ignored"
  | "busy"
  | "stopping"
  | "configuration-changed";

export interface GitHubWebhookServer {
  port: number;
  stop(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBranch(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.startsWith("-") &&
    value.length <= 1024 &&
    !/[~^:?*[\\]/.test(value) &&
    [...value].every(
      (character) =>
        character.charCodeAt(0) > 32 && character.charCodeAt(0) !== 127,
    ) &&
    !value.includes("..") &&
    !value.includes("@{") &&
    !value.endsWith(".") &&
    value
      .split("/")
      .every(
        (part) =>
          part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock"),
      )
  );
}

/** This HTTP server has no daemon command dispatcher or private API routes. */
export async function startGitHubWebhookServer(options: {
  port: number;
  secret: string;
  logger: Logger;
  admit(repository: string, delivery: string): WebhookAdmission;
}): Promise<GitHubWebhookServer> {
  let stopping = false;
  const server = http.createServer(
    { maxHeaderSize: 16 * 1024 },
    (request, response) => {
      const started = Date.now();
      let finished = false;
      const finish = (status: number, outcome: string) => {
        if (finished) return;
        finished = true;
        options.logger
          .child({
            event: "github-webhook-receipt",
            outcome,
            status,
            durationMilliseconds: Date.now() - started,
          })
          .info("GitHub webhook receipt");
        response.writeHead(status, {
          Connection: "close",
          ...(status === 405 ? { Allow: "POST" } : {}),
          ...(status === 503 ? { "Retry-After": "5" } : {}),
        });
        response.end();
      };
      if (request.url !== githubWebhookPath) {
        finish(404, "rejected-route");
        return;
      }
      if (request.method !== "POST") {
        finish(405, "rejected-method");
        return;
      }
      if (stopping) {
        finish(503, "rejected-stopping");
        return;
      }
      const signature = request.headers["x-hub-signature-256"];
      if (
        typeof signature !== "string" ||
        !/^sha256=[a-f0-9]{64}$/.test(signature)
      ) {
        finish(401, "rejected-signature");
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      const timeout = setTimeout(() => {
        finish(408, "rejected-timeout");
        request.destroy();
      }, webhookRequestTimeoutMilliseconds);
      response.once("close", () => clearTimeout(timeout));
      request.on("error", () => {
        clearTimeout(timeout);
        finish(400, "rejected-request");
      });
      request.on("data", (chunk: Buffer) => {
        if (finished) return;
        length += chunk.length;
        if (length > webhookBodyLimit) {
          chunks.length = 0;
          finish(413, "rejected-size");
          return;
        }
        chunks.push(chunk);
      });
      request.on("end", () => {
        if (finished) return;
        clearTimeout(timeout);
        const body = Buffer.concat(chunks);
        const digest = createHmac("sha256", options.secret)
          .update(body)
          .digest();
        if (!timingSafeEqual(digest, Buffer.from(signature.slice(7), "hex"))) {
          finish(401, "rejected-signature");
          return;
        }
        let payload: unknown;
        try {
          payload = JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(body),
          );
        } catch {
          finish(400, "rejected-json");
          return;
        }
        const event = request.headers["x-github-event"];
        const delivery = request.headers["x-github-delivery"];
        if (
          !isRecord(payload) ||
          typeof event !== "string" ||
          !/^[a-z_]{1,64}$/.test(event) ||
          typeof delivery !== "string" ||
          !/^[a-zA-Z0-9-]{1,128}$/.test(delivery)
        ) {
          finish(400, "rejected-payload");
          return;
        }
        if (event !== "push") {
          finish(200, event === "ping" ? "ignored-ping" : "ignored-event");
          return;
        }
        const repository = payload.repository;
        if (
          !isRecord(repository) ||
          typeof repository.html_url !== "string" ||
          !validBranch(repository.default_branch) ||
          typeof payload.ref !== "string" ||
          !/^refs\/(heads|tags)\//.test(payload.ref) ||
          !validBranch(payload.ref.slice(payload.ref.indexOf("/", 5) + 1)) ||
          typeof payload.deleted !== "boolean"
        ) {
          finish(400, "rejected-payload");
          return;
        }
        const identity = canonicalGitHubRepository(repository.html_url);
        if (!identity) {
          finish(400, "rejected-repository");
          return;
        }
        if (
          payload.deleted ||
          payload.ref !== `refs/heads/${repository.default_branch}`
        ) {
          finish(200, "ignored-ref");
          return;
        }
        if (stopping) {
          finish(503, "rejected-stopping");
          return;
        }
        try {
          const outcome = options.admit(identity, delivery);
          const rejected =
            outcome === "busy" ||
            outcome === "stopping" ||
            outcome === "configuration-changed";
          finish(
            rejected ? 503 : outcome === "ignored" ? 200 : 202,
            rejected ? `rejected-${outcome}` : outcome,
          );
        } catch {
          finish(503, "rejected-unavailable");
        }
      });
    },
  );
  server.maxConnections = webhookConnectionLimit;
  server.maxRequestsPerSocket = 1;
  server.requestTimeout = webhookRequestTimeoutMilliseconds;
  server.headersTimeout = webhookRequestTimeoutMilliseconds;
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    // An absolute bound also covers slow headers before the request event.
    const timeout = setTimeout(
      () => socket.destroy(),
      webhookRequestTimeoutMilliseconds,
    );
    socket.once("close", () => clearTimeout(timeout));
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  server.on("error", () =>
    options.logger.warn(
      "GitHub webhook listener error; check the configured loopback port",
    ),
  );
  const address = server.address();
  if (address === null || typeof address === "string")
    throw new Error("GitHub webhook listener unavailable");
  return {
    port: address.port,
    stop: () => {
      stopping = true;
      return new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
    },
  };
}
