import { createServer, type Server } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { attemptSelfUpdate } from "../../src/selfUpdate.js";
import { createSilentLogger } from "./helpers/testLogger.js";

describe("self-update", () => {
  let server: Server;
  let releaseApiUrl: string;
  let bundleDirectory: string;

  beforeEach(async () => {
    server = createServer((request, response) => {
      const origin = `http://${request.headers.host}`;
      if (request.url === "/repos/alundgren/Irudd.Piploy/releases/latest") {
        response.setHeader("content-type", "application/json");
        response.end(
          JSON.stringify({
            tag_name: "v99.0.0",
            assets: [
              {
                name: "piploy.cjs",
                browser_download_url: `${origin}/assets/piploy.cjs`,
              },
            ],
          }),
        );
        return;
      }
      if (request.url === "/assets/piploy.cjs") {
        response.end("new Piploy bundle");
        return;
      }
      response.statusCode = 404;
      response.end();
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Fixture server did not bind to a TCP port");
    }
    releaseApiUrl = `http://127.0.0.1:${address.port}/repos/alundgren/Irudd.Piploy/releases/latest`;
    bundleDirectory = await mkdtemp(path.join(os.tmpdir(), "piploy-update-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(bundleDirectory, { recursive: true, force: true });
  });

  it("downloads a release from a real HTTP server and swaps only the bundle", async () => {
    const bundlePath = path.join(bundleDirectory, "piploy.cjs");
    const configPath = path.join(bundleDirectory, "piploy.json");
    await writeFile(bundlePath, "old Piploy bundle");
    await writeFile(configPath, '{"Piploy":{}}');
    const exit = vi
      .spyOn(process, "exit")
      .mockImplementation(() => undefined as never);

    await expect(
      attemptSelfUpdate(createSilentLogger(), {
        bundleDirectory,
        latestReleaseUrl: releaseApiUrl,
      }),
    ).resolves.toBe("updated");

    expect(exit).toHaveBeenCalledWith(0);
    await expect(readFile(bundlePath, "utf8")).resolves.toBe(
      "new Piploy bundle",
    );
    await expect(readFile(`${bundlePath}.prev`, "utf8")).resolves.toBe(
      "old Piploy bundle",
    );
    await expect(readFile(configPath, "utf8")).resolves.toBe('{"Piploy":{}}');
  });
});
