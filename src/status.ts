import type { DockerStatus } from "./docker.js";
import type { GitCommitStatus } from "./git.js";

/** Whether the running container was built from the remote repository tip. */
export function isRunningLatestVersion(
  commitStatus: GitCommitStatus | null,
  dockerStatus: DockerStatus,
): boolean {
  return (
    commitStatus !== null &&
    dockerStatus.runningContainerHash !== undefined &&
    commitStatus.remote.hash === dockerStatus.runningContainerHash
  );
}
