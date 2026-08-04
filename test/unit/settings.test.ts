import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  getApplicationRepoDirectory,
  getApplicationRootDirectory,
  loadSettings,
  parseSettings,
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
});
