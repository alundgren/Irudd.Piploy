import { BuildPostponedError } from "./buildx.js";
import { createDockerService, PortAlreadyInUseError } from "./docker.js";
import {
  ensureLocalRepository,
  getLatestCommit,
  GitOperationError,
  type GitDiagnostic,
} from "./git.js";
import type { Logger } from "./logger.js";
import {
  ApplicationNameSchema,
  type Application,
  type PiploySettings,
} from "./settings.js";

export interface OrchestratorDeps {
  ensureLocalRepository(application: Application): Promise<void>;
  getLatestCommit(application: Application): Promise<{ hash: string }>;
  ensureImageExists(
    application: Application,
    commit: { hash: string },
    signal?: AbortSignal,
  ): Promise<{ imageId: string }>;
  ensureContainerRunning(
    application: Application,
    commit: { hash: string },
    imageId: string,
  ): Promise<void>;
  cleanupInactive(applications: Application[]): Promise<void>;
}

export interface Orchestrator {
  poll(
    signal?: AbortSignal,
    application?: string,
  ): Promise<PollApplicationResult[]>;
}

export class PollSelectionError extends Error {
  constructor(
    readonly reason: "invalid-request" | "unknown-application",
    message: string,
  ) {
    super(message);
    this.name = "PollSelectionError";
  }
}

export function selectPollApplications(
  settings: PiploySettings,
  application?: string,
): Application[] {
  if (application === undefined) return settings.Applications;
  if (!ApplicationNameSchema.safeParse(application).success) {
    throw new PollSelectionError(
      "invalid-request",
      "Application must be a complete configured Name using letters, digits, underscores, or hyphens.",
    );
  }
  const selected = settings.Applications.find(
    ({ Name }) => Name === application,
  );
  if (!selected) {
    throw new PollSelectionError(
      "unknown-application",
      `No Application named '${application}' is registered.`,
    );
  }
  return [selected];
}

export type PollApplicationResult =
  | { application: string; ok: true }
  | {
      application: string;
      ok: false;
      stage: PollFailureStage;
      message: string;
      code?: "portAlreadyInUse" | "buildPostponed";
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
    async ensureImageExists(application, commit, signal) {
      return docker.ensureImageExists(application, commit, signal);
    },
    async ensureContainerRunning(application, commit, imageId) {
      await docker.ensureContainerRunning(application, commit, imageId);
    },
    cleanupInactive: (applications) => docker.cleanupInactive(applications),
  };
}

export function createOrchestrator(
  settings: PiploySettings,
  logger: Logger,
  deps: OrchestratorDeps = createOrchestratorDeps(settings, logger),
): Orchestrator {
  async function poll(
    signal?: AbortSignal,
    application?: string,
  ): Promise<PollApplicationResult[]> {
    const selected = selectPollApplications(settings, application);
    const pollLogger = logger.child({ operation: "poll" });
    pollLogger.info("Polling applications");
    const results: PollApplicationResult[] = [];

    try {
      for (const application of selected) {
        if (signal?.aborted) break;
        const applicationLogger = pollLogger.child({
          application: application.Name,
        });
        applicationLogger.info(`Polling application: ${application.Name}`);

        let stage: PollFailureStage = "fetch";
        try {
          await deps.ensureLocalRepository(application);
          const commit = await deps.getLatestCommit(application);
          stage = "build";
          signal?.throwIfAborted();
          const image = await deps.ensureImageExists(
            application,
            commit,
            signal,
          );
          signal?.throwIfAborted();
          stage = "start";
          await deps.ensureContainerRunning(application, commit, image.imageId);
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
            ...(error instanceof PortAlreadyInUseError ||
            error instanceof BuildPostponedError
              ? { code: error.code }
              : {}),
          });
        }
      }
    } finally {
      if (application === undefined && !signal?.aborted) {
        pollLogger.info("Cleaning up unused images");
        await deps.cleanupInactive(settings.Applications);
      }
    }

    return results;
  }

  return { poll };
}
