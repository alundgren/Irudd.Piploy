import { createDockerService, PortAlreadyInUseError } from "./docker.js";
import {
  ensureLocalRepository,
  getLatestCommit,
  GitOperationError,
  type GitDiagnostic,
} from "./git.js";
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
  poll(): Promise<PollApplicationResult[]>;
}

export type PollApplicationResult =
  | { application: string; ok: true }
  | {
      application: string;
      ok: false;
      stage: PollFailureStage;
      message: string;
      code?: "portAlreadyInUse";
      gitError?: GitDiagnostic;
    };

export type PollFailureStage = "fetch" | "build" | "start";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function logError(logger: Logger, error: unknown): void {
  logger.error(errorMessage(error));
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
  async function poll(): Promise<PollApplicationResult[]> {
    const pollLogger = logger.child({ operation: "poll" });
    pollLogger.info("Polling applications");
    const results: PollApplicationResult[] = [];

    try {
      for (const application of settings.Applications) {
        const applicationLogger = pollLogger.child({
          application: application.Name,
        });
        applicationLogger.info(`Polling application: ${application.Name}`);

        let stage: PollFailureStage = "fetch";
        try {
          await deps.ensureLocalRepository(application);
          const commit = await deps.getLatestCommit(application);
          stage = "build";
          await deps.ensureImageExists(application, commit);
          stage = "start";
          await deps.ensureContainerRunning(application, commit);
          results.push({ application: application.Name, ok: true });
        } catch (error) {
          const gitError =
            error instanceof GitOperationError ? error.diagnostic : undefined;
          logError(applicationLogger, gitError?.message ?? error);
          results.push({
            application: application.Name,
            ok: false,
            stage,
            message: gitError?.message ?? errorMessage(error),
            ...(gitError === undefined ? {} : { gitError }),
            ...(error instanceof PortAlreadyInUseError
              ? { code: error.code }
              : {}),
          });
        }
      }
    } finally {
      pollLogger.info("Cleaning up unused images");
      await deps.cleanupInactive(settings.Applications);
    }

    return results;
  }

  return { poll };
}
