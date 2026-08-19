import { mkdtemp, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  getApplicationDataDirectory,
  getApplicationRepoDirectory,
  getApplicationRootDirectory,
  getDataDirectory,
  getVolumeDirectory,
  loadSettings,
  parseSettings,
  resolveBundleDirectory,
  resolveConfigPath,
} from "../../src/settings.js";

const fixturesDir = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "fixtures",
);

const validApplication = {
  Name: "app1",
  GitRepositoryUrl: "https://github.com/example/app1.git",
  DockerfilePath: "Dockerfile",
};

/** Writes a piploy.json whose RootDirectory is relative to its own directory. */
async function writeConfig(relativeRootDirectory: string): Promise<string> {
  const directory = await mkdtemp(path.join(os.tmpdir(), "piploy-settings-"));
  const configPath = path.join(directory, "piploy.json");
  await writeFile(
    configPath,
    JSON.stringify({
      Piploy: {
        RootDirectory: path.join(directory, relativeRootDirectory),
        Applications: [validApplication],
      },
    }),
    "utf8",
  );
  return configPath;
}

describe("loadSettings", () => {
  it("reads and validates a valid piploy.json fixture", () => {
    const settings = loadSettings(path.join(fixturesDir, "piploy.valid.json"));

    expect(settings).toEqual({
      RootDirectory: "/opt/piploy/root",
      MinutesBetweenBackgroundPolls: 60,
      Applications: [
        {
          Name: "app1",
          GitRepositoryUrl: "https://github.com/example/app1.git",
          DockerfilePath: "Dockerfile",
          PortMappings: [{ hostPort: 8080, containerPort: 80 }],
        },
      ],
      IsTestRun: false,
    });
  });

  it.each(["", "data", "data/app1"])(
    "rejects a RootDirectory that overlaps the data directory ('%s')",
    async (relativeRootDirectory) => {
      const configPath = await writeConfig(relativeRootDirectory);

      expect(() => loadSettings(configPath)).toThrow(
        "overlaps the application data directory",
      );
    },
  );

  it("accepts a RootDirectory beside the data directory", async () => {
    const configPath = await writeConfig("root");

    expect(loadSettings(configPath).RootDirectory).toBe(
      path.join(path.dirname(configPath), "root"),
    );
  });
});

describe("parseSettings", () => {
  it("accepts a minimal valid config with no optional fields", () => {
    const settings = parseSettings({
      Piploy: {
        RootDirectory: "/root",
        Applications: [validApplication],
      },
    });

    expect(settings.MinutesBetweenBackgroundPolls).toBeUndefined();
    expect(settings.IsTestRun).toBeUndefined();
    expect(settings.Applications[0]?.PortMappings).toBeUndefined();
    expect(settings.Applications[0]?.Volumes).toBeUndefined();
    expect(settings.Applications[0]?.EnvironmentVariables).toBeUndefined();
  });

  it("rejects a config missing the Piploy wrapper key", () => {
    expect(() =>
      parseSettings({ RootDirectory: "/root", Applications: [] }),
    ).toThrow();
  });

  it("rejects a config missing RootDirectory", () => {
    expect(() =>
      parseSettings({ Piploy: { Applications: [validApplication] } }),
    ).toThrow();
  });

  it("rejects an application name with invalid characters", () => {
    expect(() =>
      parseSettings({
        Piploy: {
          RootDirectory: "/root",
          Applications: [{ ...validApplication, Name: "app 1!" }],
        },
      }),
    ).toThrow();
  });

  it.each(["8080", "8080:", ":80", "abc:80", "8080:80:90"])(
    "rejects an invalid port mapping string %s",
    (mapping) => {
      expect(() =>
        parseSettings({
          Piploy: {
            RootDirectory: "/root",
            Applications: [{ ...validApplication, PortMappings: [mapping] }],
          },
        }),
      ).toThrow(
        "Invalid port mappings. Must have the format <hostPort>:<containerPort>",
      );
    },
  );

  it("parses port mappings into typed host/container pairs", () => {
    const settings = parseSettings({
      Piploy: {
        RootDirectory: "/root",
        Applications: [
          { ...validApplication, PortMappings: ["8080:80", "9090:90"] },
        ],
      },
    });

    expect(settings.Applications[0]?.PortMappings).toEqual([
      { hostPort: 8080, containerPort: 80 },
      { hostPort: 9090, containerPort: 90 },
    ]);
  });

  it.each([
    "sqlite",
    "sqlite:relative/path",
    "/host/path:/container/path",
    "../host:/container/path",
    "sqlite:/container/../path",
    "sqlite:/app/data:ro",
    "sqlite:/app/data:/etc",
    "sqlite:/",
    "sqlite://",
  ])("rejects an unsafe volume mapping %s", (volume) => {
    expect(() =>
      parseSettings({
        Piploy: {
          RootDirectory: "/root",
          Applications: [{ ...validApplication, Volumes: [volume] }],
        },
      }),
    ).toThrow(
      "Invalid volumes. Must have the format <name>:/container/path; host paths, mount options, and '..' are not allowed",
    );
  });

  it("rejects two volumes sharing a container path", () => {
    expect(() =>
      parseSettings({
        Piploy: {
          RootDirectory: "/root",
          Applications: [
            {
              ...validApplication,
              Volumes: ["sqlite:/app/data", "uploads:/app/data"],
            },
          ],
        },
      }),
    ).toThrow(
      "Invalid volumes. Two Volumes of one Application cannot share a container path",
    );
  });

  it("parses volumes and environment variables without interpolation", () => {
    const settings = parseSettings({
      Piploy: {
        RootDirectory: "/root",
        Applications: [
          {
            ...validApplication,
            Volumes: ["sqlite:/app/data"],
            EnvironmentVariables: { DATABASE_PATH: "/app/data/app.db" },
          },
        ],
      },
    });

    expect(settings.Applications[0]?.Volumes).toEqual([
      { name: "sqlite", containerPath: "/app/data" },
    ]);
    expect(settings.Applications[0]?.EnvironmentVariables).toEqual({
      DATABASE_PATH: "/app/data/app.db",
    });
  });

  it("preserves a valid BuildContextPath", () => {
    const settings = parseSettings({
      Piploy: {
        RootDirectory: "/root",
        Applications: [
          { ...validApplication, BuildContextPath: "services/api" },
        ],
      },
    });

    expect(settings.Applications[0]?.BuildContextPath).toBe("services/api");
  });

  it.each(["", "/outside", "../outside", "services/../../outside"])(
    "rejects an invalid BuildContextPath during configuration validation: %s",
    (BuildContextPath) => {
      expect(() =>
        parseSettings({
          Piploy: {
            RootDirectory: "/root",
            Applications: [{ ...validApplication, BuildContextPath }],
          },
        }),
      ).toThrow("Invalid BuildContextPath");
    },
  );
});

describe("resolveConfigPath", () => {
  const originalEnv = process.env.PIPLOY_CONFIG;

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.PIPLOY_CONFIG;
    } else {
      process.env.PIPLOY_CONFIG = originalEnv;
    }
  });

  it("resolves piploy.json relative to the bundle directory by default", () => {
    delete process.env.PIPLOY_CONFIG;
    expect(resolveConfigPath("/opt/piploy")).toBe("/opt/piploy/piploy.json");
  });

  it("prefers the PIPLOY_CONFIG override when set", () => {
    process.env.PIPLOY_CONFIG = "/etc/piploy/custom.json";
    expect(resolveConfigPath("/opt/piploy")).toBe("/etc/piploy/custom.json");
  });
});

describe("resolveBundleDirectory", () => {
  it("uses the directory containing the invoked bundle", () => {
    expect(resolveBundleDirectory()).toBe(
      path.dirname(process.argv[1] ?? process.cwd()),
    );
  });
});

describe("application directories", () => {
  it("derives the per-application root and repo directories", () => {
    const settings = parseSettings({
      Piploy: {
        RootDirectory: "/opt/piploy/root",
        Applications: [validApplication],
      },
    });
    const application = settings.Applications[0]!;

    expect(getApplicationRootDirectory(settings, application)).toBe(
      "/opt/piploy/root/app1",
    );
    expect(getApplicationRepoDirectory(settings, application)).toBe(
      "/opt/piploy/root/app1/repo",
    );
  });

  it("derives data directories next to the active configuration", () => {
    const originalConfigPath = process.env.PIPLOY_CONFIG;
    process.env.PIPLOY_CONFIG = "/opt/piploy/piploy.json";
    try {
      const application = parseSettings({
        Piploy: { RootDirectory: "/ignored", Applications: [validApplication] },
      }).Applications[0]!;
      const volume = { name: "sqlite", containerPath: "/app/data" };

      expect(getDataDirectory()).toBe("/opt/piploy/data");
      expect(getApplicationDataDirectory(application)).toBe(
        "/opt/piploy/data/app1",
      );
      expect(getVolumeDirectory(application, volume)).toBe(
        "/opt/piploy/data/app1/sqlite",
      );
    } finally {
      if (originalConfigPath === undefined) delete process.env.PIPLOY_CONFIG;
      else process.env.PIPLOY_CONFIG = originalConfigPath;
    }
  });

  it("keeps the data directory absolute for a relative configuration path", () => {
    const originalConfigPath = process.env.PIPLOY_CONFIG;
    process.env.PIPLOY_CONFIG = "piploy.json";
    try {
      expect(getDataDirectory()).toBe(path.resolve(process.cwd(), "data"));
    } finally {
      if (originalConfigPath === undefined) delete process.env.PIPLOY_CONFIG;
      else process.env.PIPLOY_CONFIG = originalConfigPath;
    }
  });
});
