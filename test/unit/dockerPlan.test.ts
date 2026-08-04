import { describe, expect, it } from "vitest";

import {
  getDockerfilePathFromSetting,
  planContainer,
  planImage,
} from "../../src/dockerPlan.js";

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
      expect(planContainer(container, "commit")).toEqual(expected);
    },
  );

  it("reuses a running container at the requested commit", () => {
    expect(
      planContainer(
        { id: "container", state: "running", gitTipCommit: "commit" },
        "commit",
      ),
    ).toEqual({ action: "reuse", containerId: "container" });
  });

  it("starts an exited container at the requested commit", () => {
    expect(
      planContainer(
        { id: "container", state: "exited", gitTipCommit: "commit" },
        "commit",
      ),
    ).toEqual({ action: "start", containerId: "container" });
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

  it.each([undefined, "", "   "])(
    "resolves to the repository-root Dockerfile when unset (%j)",
    (setting) => {
      expect(getDockerfilePathFromSetting(setting)).toEqual({
        contextDirectory: "",
        dockerfileName: "Dockerfile",
      });
    },
  );

  it("rejects a path that points at a directory", () => {
    expect(() => getDockerfilePathFromSetting("api/")).toThrow(
      "Invalid DockerfilePath",
    );
  });
});
