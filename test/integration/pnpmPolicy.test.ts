import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { gzipSync } from "node:zlib";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const oldEnough = "2020-01-01T00:00:00.000Z";
const tooRecent = new Date().toISOString();

interface FixturePackage {
  name: string;
  publishedAt: string;
  scripts?: Record<string, string>;
}

const fixturePackages: FixturePackage[] = [
  { name: "fixture-old", publishedAt: oldEnough },
  { name: "fixture-new", publishedAt: tooRecent },
  {
    name: "fixture-install-script",
    publishedAt: oldEnough,
    scripts: { preinstall: "node write-marker.cjs" },
  },
];

let registry: Server;
let registryUrl: string;
let temporaryDirectory: string;

beforeAll(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "piploy-pnpm-"));
  registry = createFixtureRegistry();
  await new Promise<void>((resolve) =>
    registry.listen(0, "127.0.0.1", resolve),
  );
  const address = registry.address();
  if (!address || typeof address === "string") {
    throw new Error("Fixture registry did not bind a TCP port");
  }
  registryUrl = `http://127.0.0.1:${address.port}`;
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    registry.close((error) => (error ? reject(error) : resolve())),
  );
  await rm(temporaryDirectory, { recursive: true, force: true });
});

describe("pnpm supply-chain policy", () => {
  it("resolves a package published more than eight days ago", async () => {
    const projectDirectory = await createProject("fixture-old");

    await expect(install(projectDirectory)).resolves.toBeUndefined();
    expect(
      existsSync(path.join(projectDirectory, "node_modules/fixture-old")),
    ).toBe(true);
  });

  it("fails closed for a package published within eight days", async () => {
    const projectDirectory = await createProject("fixture-new");

    await expect(install(projectDirectory)).rejects.toMatchObject({
      stdout: expect.stringContaining("ERR_PNPM_NO_MATURE_MATCHING_VERSION"),
    });
  });

  it("does not run an unreviewed dependency install script", async () => {
    const projectDirectory = await createProject("fixture-install-script");
    const markerPath = path.join(projectDirectory, "install-script-ran");

    await expect(install(projectDirectory)).rejects.toMatchObject({
      stdout: expect.stringContaining("ERR_PNPM_IGNORED_BUILDS"),
    });
    expect(existsSync(markerPath)).toBe(false);
  });
});

function createFixtureRegistry(): Server {
  return createServer((request, response) => {
    const requestPath = new URL(request.url ?? "/", registryUrl).pathname;
    const packageName = requestPath.split("/")[1];
    const fixture = fixturePackages.find(({ name }) => name === packageName);
    if (!fixture) {
      response.writeHead(404).end();
      return;
    }

    if (requestPath === `/${fixture.name}`) {
      const tarball = `${registryUrl}/${fixture.name}/-/${fixture.name}-1.0.0.tgz`;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: fixture.name,
          "dist-tags": { latest: "1.0.0" },
          time: {
            created: fixture.publishedAt,
            modified: fixture.publishedAt,
            "1.0.0": fixture.publishedAt,
          },
          versions: {
            "1.0.0": {
              name: fixture.name,
              version: "1.0.0",
              scripts: fixture.scripts,
              dist: { tarball },
            },
          },
        }),
      );
      return;
    }

    response.setHeader("content-type", "application/octet-stream");
    response.end(packageTarball(fixture));
  });
}

async function createProject(dependency: string): Promise<string> {
  const projectDirectory = await mkdtemp(
    path.join(temporaryDirectory, `${dependency}-`),
  );
  await writeFile(
    path.join(projectDirectory, "package.json"),
    JSON.stringify({
      name: "policy-fixture",
      private: true,
      dependencies: { [dependency]: "1.0.0" },
    }),
  );
  await writeFile(
    path.join(projectDirectory, "pnpm-workspace.yaml"),
    readFileSync(path.join(process.cwd(), "pnpm-workspace.yaml"), "utf8"),
  );
  return projectDirectory;
}

async function install(projectDirectory: string): Promise<void> {
  await execFileAsync("pnpm", ["install", `--registry=${registryUrl}`], {
    cwd: projectDirectory,
  });
}

function packageTarball(fixture: FixturePackage): Buffer {
  const markerScript = fixture.scripts
    ? "require('node:fs').writeFileSync(`${process.env.INIT_CWD}/install-script-ran`, 'ran');\n"
    : "";
  return gzipSync(
    tar([
      [
        "package/package.json",
        JSON.stringify({
          name: fixture.name,
          version: "1.0.0",
          scripts: fixture.scripts,
        }),
      ],
      ["package/write-marker.cjs", markerScript],
    ]),
  );
}

function tar(files: Array<[string, string]>): Buffer {
  return Buffer.concat([
    ...files.flatMap(([name, contents]) => {
      const body = Buffer.from(contents);
      const padding = Buffer.alloc((512 - (body.length % 512)) % 512);
      return [tarHeader(name, body.length), body, padding];
    }),
    Buffer.alloc(1024),
  ]);
}

function tarHeader(name: string, size: number): Buffer {
  const header = Buffer.alloc(512);
  header.write(name);
  writeTarNumber(header, 100, 8, 0o644);
  writeTarNumber(header, 108, 8, 0);
  writeTarNumber(header, 116, 8, 0);
  writeTarNumber(header, 124, 12, size);
  writeTarNumber(header, 136, 12, 0);
  header.fill(0x20, 148, 156);
  header[156] = 0;
  header.write("ustar", 257);
  header.write("00", 263);
  writeTarNumber(
    header,
    148,
    8,
    header.reduce((sum, byte) => sum + byte, 0),
  );
  return header;
}

function writeTarNumber(
  buffer: Buffer,
  offset: number,
  length: number,
  value: number,
): void {
  buffer.write(value.toString(8).padStart(length - 1, "0"), offset);
}
