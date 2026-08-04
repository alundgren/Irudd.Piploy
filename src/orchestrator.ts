import { createDockerService } from "./docker.js";
import { ensureLocalRepository, getLatestCommit } from "./git.js";
import type { Logger } from "./logger.js";
import type { Application, PiploySettings } from "./settings.js";

export interface OrchestratorDeps {
  ensureLocalRepository(application: Application): Promise<void>;
  getLatestCommit(application: Application): Promise<{ hash: string }>;
  ensureImageExists(
    application: Application,
    commit: { hash: string },
  ): Promise<void>;
  ensureContainerRunning(
    application: Application,
    commit: { hash: string },
  ): Promise<void>;
  cleanupInactive(applications: Application[]): Promise<void>;
}

export interface Orchestrator {
  poll(): Promise<void>;
}

function logError(logger: Logger, error: unknown): void {
  logger.error(error instanceof Error ? error.message : String(error));
}

/** Wires the one real git and Docker adapter into the orchestrator's narrow seam. */
export function createOrchestratorDeps(
  settings: PiploySettings,
  logger: Logger,
): OrchestratorDeps {
  const docker = createDockerService(settings, logger);

  return {
    ensureLocalRepository: (application) =>
      ensureLocalRepository(settings, application, logger),
    getLatestCommit: (application) => getLatestCommit(settings, application),
    async ensureImageExists(application, commit) {
      await docker.ensureImageExists(application, commit);
    },
    async ensureContainerRunning(application, commit) {
      await docker.ensureContainerRunning(application, commit);
    },
    cleanupInactive: (applications) => docker.cleanupInactive(applications),
  };
}

export function createOrchestrator(
  settings: PiploySettings,
  logger: Logger,
  deps: OrchestratorDeps = createOrchestratorDeps(settings, logger),
): Orchestrator {
  async function poll(): Promise<void> {
    const pollLogger = logger.child({ operation: "poll" });
    pollLogger.info("Polling applications");

    try {
      for (const application of settings.Applications) {
        const applicationLogger = pollLogger.child({
          application: application.Name,
        });
        applicationLogger.info(`Polling application: ${application.Name}`);

        try {
          await deps.ensureLocalRepository(application);
          const commit = await deps.getLatestCommit(application);
          await deps.ensureImageExists(application, commit);
          await deps.ensureContainerRunning(application, commit);
        } catch (error) {
          logError(applicationLogger, error);
        }
      }
    } finally {
      pollLogger.info("Cleaning up unused images");
      await deps.cleanupInactive(settings.Applications);
    }
  }

  return { poll };
}
