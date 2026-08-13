import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  getContainerConfigHash,
  getDockerfilePathFromSetting,
  planContainer,
  planImage,
  validateDockerfileImageReferences,
} from "../../src/dockerPlan.js";

const digest = "a".repeat(64);

describe("planImage", () => {
  it("reuses an image already built for the commit", () => {
    expect(planImage({ id: "sha256:existing" })).toEqual({
      action: "reuse",
      imageId: "sha256:existing",
    });
  });

  it("builds when the commit image does not exist", () => {
    expect(planImage()).toEqual({ action: "build" });
  });
});

describe("planContainer", () => {
  const configHash = getContainerConfigHash({});

  it.each([
    [undefined, { action: "recreate" }],
    [
      { id: "container", state: "running", gitTipCommit: "other" },
      { action: "recreate", existingContainerId: "container" },
    ],
    [
      { id: "container", state: "created", gitTipCommit: "commit" },
      { action: "recreate", existingContainerId: "container" },
    ],
  ] as const)(
    "recreates when the current container is not usable",
    (container, expected) => {
      expect(planContainer(container, "commit", configHash)).toEqual(expected);
    },
  );

  it("reuses a running container at the requested commit", () => {
    expect(
      planContainer(
        {
          id: "container",
          state: "running",
          gitTipCommit: "commit",
          configHash,
        },
        "commit",
        configHash,
      ),
    ).toEqual({ action: "reuse", containerId: "container" });
  });

  it("leaves a matching container to Docker while it is restarting", () => {
    expect(
      planContainer(
        {
          id: "container",
          state: "restarting",
          gitTipCommit: "commit",
          configHash,
        },
        "commit",
        configHash,
      ),
    ).toEqual({ action: "reuse", containerId: "container" });
  });

  it("starts an exited container at the requested commit", () => {
    expect(
      planContainer(
        {
          id: "container",
          state: "exited",
          gitTipCommit: "commit",
          configHash,
        },
        "commit",
        configHash,
      ),
    ).toEqual({ action: "start", containerId: "container" });
  });

  it("recreates a container when its runtime configuration changes", () => {
    expect(
      planContainer(
        {
          id: "container",
          state: "running",
          gitTipCommit: "commit",
          configHash: getContainerConfigHash({
            portMappings: [{ hostPort: 8080, containerPort: 80 }],
          }),
        },
        "commit",
        getContainerConfigHash({
          portMappings: [{ hostPort: 9090, containerPort: 80 }],
        }),
      ),
    ).toEqual({ action: "recreate", existingContainerId: "container" });
  });

  it("hashes equivalent runtime configurations identically", () => {
    expect(
      getContainerConfigHash({
        environmentVariables: ["B=two", "A=one"],
        volumes: ["cache:/cache", "data:/data"],
        portMappings: [
          { hostPort: 9090, containerPort: 90 },
          { hostPort: 8080, containerPort: 80 },
        ],
      }),
    ).toBe(
      getContainerConfigHash({
        environmentVariables: ["A=one", "B=two"],
        volumes: ["data:/data", "cache:/cache"],
        portMappings: [
          { hostPort: 8080, containerPort: 80 },
          { hostPort: 9090, containerPort: 90 },
        ],
      }),
    );
  });

  it("changes the hash of containers created before the restart policy", () => {
    const previousHash = createHash("sha256")
      .update(
        JSON.stringify({
          environmentVariables: [],
          volumes: [],
          portMappings: [],
          logConfig: {
            Type: "json-file",
            Config: { "max-size": "10m", "max-file": "3" },
          },
        }),
      )
      .digest("hex");

    expect(getContainerConfigHash({})).not.toBe(previousHash);
  });
});

describe("getDockerfilePathFromSetting", () => {
  it.each([
    ["Dockerfile", { contextDirectory: "", dockerfileName: "Dockerfile" }],
    [
      " /Dockerfile.custom ",
      { contextDirectory: "", dockerfileName: "Dockerfile.custom" },
    ],
    [
      "api/Dockerfile",
      { contextDirectory: "api", dockerfileName: "Dockerfile" },
    ],
    [
      "api\\Dockerfile",
      { contextDirectory: "api", dockerfileName: "Dockerfile" },
    ],
  ])("normalizes %s", (setting, expected) => {
    expect(getDockerfilePathFromSetting(setting)).toEqual(expected);
  });

  it("rejects a path that points at a directory", () => {
    expect(() => getDockerfilePathFromSetting("api/")).toThrow(
      "Invalid DockerfilePath",
    );
  });
});

describe("validateDockerfileImageReferences", () => {
  it("accepts digest-pinned official and Microsoft .NET images", () => {
    expect(
      validateDockerfileImageReferences(`
        FROM --platform=linux/arm64 node:current-slim@sha256:${digest} AS build
        FROM library/nginx:latest@sha256:${digest}
        FROM docker.io/library/alpine@sha256:${digest}
        FROM mcr.microsoft.com/dotnet/core/sdk:3.1@sha256:${digest}
      `),
    ).toEqual([]);
  });

  it("accepts scratch and earlier stages by name or index", () => {
    expect(
      validateDockerfileImageReferences(`
        FROM node@sha256:${digest} AS build
        RUN npm run build
        FROM scratch AS artifact
        COPY --from=build /app /app
        COPY --from=0 /app /app
      `),
    ).toEqual([]);
  });

  it("parses platform flags and Dockerfile comments", () => {
    expect(
      validateDockerfileImageReferences(
        `FROM --platform linux/arm64 node@sha256:${digest} AS build # comment`,
      ),
    ).toEqual([]);
  });

  it("reports every untrusted external image reference", () => {
    expect(
      validateDockerfileImageReferences(`
        ARG NODE_IMAGE=node:latest
        FROM node:latest
        COPY --from=docker.io/someone/tool@sha256:${digest} /tool /tool
        FROM ghcr.io/example/image@sha256:${digest}
        FROM \${NODE_IMAGE}
      `),
    ).toEqual([
      {
        reference: "node:latest",
        reason: "must be pinned with an @sha256 digest",
      },
      {
        reference: `docker.io/someone/tool@sha256:${digest}`,
        reason:
          "must be a Docker Official Image or mcr.microsoft.com/dotnet image",
      },
      {
        reference: `ghcr.io/example/image@sha256:${digest}`,
        reason:
          "must be a Docker Official Image or mcr.microsoft.com/dotnet image",
      },
      {
        reference: "${NODE_IMAGE}",
        reason: "contains an unresolved Dockerfile variable",
      },
    ]);
  });

  it.each([
    [
      "irudd-cooking",
      `
        FROM mcr.microsoft.com/dotnet/core/sdk:3.1
        FROM mcr.microsoft.com/dotnet/core/aspnet:3.1
      `,
      `
        FROM mcr.microsoft.com/dotnet/core/sdk:3.1@sha256:150d074697d1cda38a0c2185fe43895d84b5745841e9d15c5adba29604a6e4cb
        FROM mcr.microsoft.com/dotnet/core/aspnet:3.1@sha256:e3b773f30a0a6e88d71ce52429f6847627fc9353e491346902ca345760b82bdd
      `,
    ],
    [
      "kalori",
      `
        FROM node:current-slim
        FROM nginx:latest
      `,
      `
        FROM node:current-slim@sha256:deae974a69e140f44f434ab29cb519fb5f8fe250fd364b8ca446bd0761acdc6a
        FROM nginx:latest@sha256:5a88c9c45479443d7be2eadc894b4ed0a9801bae03d97a5760ae13b5c2005942
      `,
    ],
    [
      "daily-tracker",
      `
        FROM node:16.15.0
        FROM nginx:alpine
      `,
      `
        FROM node:16.15.0@sha256:59eb4e9d6a344ae1161e7d6d8af831cb50713cc631889a5a8c2d438d6ec6aa0f
        FROM nginx:alpine@sha256:4a73073bd557c65b759505da037898b61f1be6cbcc3c2c3aeac22d2a470c1752
      `,
    ],
  ])(
    "validates the %s Dockerfile before and after digest pinning",
    (_, tagged, pinned) => {
      expect(validateDockerfileImageReferences(tagged)).not.toEqual([]);
      expect(validateDockerfileImageReferences(pinned)).toEqual([]);
    },
  );
});
