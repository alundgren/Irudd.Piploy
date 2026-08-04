import { describe, expect, it } from "vitest";

import { isRunningLatestVersion } from "../../src/status.js";

const commitStatus = {
  local: {
    hash: "local",
    date: new Date("2026-01-01T00:00:00Z"),
    message: "local commit",
  },
  remote: {
    hash: "remote",
    date: new Date("2026-01-02T00:00:00Z"),
    message: "remote commit",
  },
};

describe("isRunningLatestVersion", () => {
  it("returns true when the running container matches the remote tip", () => {
    expect(
      isRunningLatestVersion(commitStatus, {
        latestImageHash: "remote",
        runningContainerHash: "remote",
      }),
    ).toBe(true);
  });

  it.each([
    [null, { runningContainerHash: "remote" }],
    [commitStatus, { latestImageHash: "remote" }],
    [commitStatus, { runningContainerHash: "local" }],
  ])(
    "returns false when the repository or running container is not current",
    (gitStatus, dockerStatus) => {
      expect(isRunningLatestVersion(gitStatus, dockerStatus)).toBe(false);
    },
  );
});
