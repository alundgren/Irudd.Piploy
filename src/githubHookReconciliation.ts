import {
  canonicalGitHubRepository,
  githubWebhookUrl,
} from "./githubWebhooks.js";
import type { Logger } from "./logger.js";
import {
  parseHostEnvironmentReference,
  type PiploySettings,
} from "./settings.js";

export const hookReconciliationIntervalMilliseconds = 10 * 60_000;
export const hookRequestTimeoutMilliseconds = 10_000;
const maximumPages = 100;

export interface HookOutcome {
  repository: string;
  outcome: "created" | "existing" | "operator-action" | "failed" | "skipped";
  message: string;
  checkedAt: string;
  lastFailure?: string;
}

export interface HookReconciliation {
  request(): void;
  status(): HookOutcome[];
  stop(): Promise<void>;
}

class HookRequestError extends Error {}

const signatureAdvice =
  "Verify a signed push in GitHub Recent deliveries and the receiver logs; listing cannot verify its signing secret.";

/** Lists and creates hooks independently of the daemon's Poll worker. */
export function startHookReconciliation(options: {
  settings: PiploySettings;
  secret: string;
  available(): boolean;
  logger: Logger;
  fetch?: typeof fetch;
}): HookReconciliation {
  const requestFetch = options.fetch ?? fetch;
  const cancellation = new AbortController();
  const outcomes = new Map<string, HookOutcome>();
  const nextAttempts = new Map<string, number>();
  let running: Promise<void> | undefined;
  let pending = false;
  let apiRetryAt = 0;

  function report(
    repository: string,
    outcome: HookOutcome["outcome"],
    message: string,
  ) {
    const lastFailure =
      outcome === "failed" || outcome === "operator-action"
        ? message
        : outcomes.get(repository)?.lastFailure;
    outcomes.set(repository, {
      repository,
      outcome,
      message,
      checkedAt: new Date().toISOString(),
      ...(lastFailure ? { lastFailure } : {}),
    });
    options.logger
      .child({
        event: "github-hook-reconciliation",
        gitRepository: repository,
        outcome,
      })
      .info(message);
  }

  async function api(
    repository: string,
    token: string,
    page?: number,
  ): Promise<unknown> {
    if (!options.available() || cancellation.signal.aborted)
      throw new HookRequestError(
        "Receiver unavailable or configuration changed. Restart Piploy; ordinary Polls remain available.",
      );
    if (Date.now() < apiRetryAt)
      throw new HookRequestError(
        "GitHub rate limit active. Reconciliation will retry after GitHub's requested delay.",
      );
    // Construct every URL locally. Neither redirects nor Link URLs receive credentials.
    const url = `https://api.github.com/repos/${repository}/hooks${page === undefined ? "" : `?per_page=100&page=${page}`}`;
    const timeout = new AbortController();
    const timer = setTimeout(
      () => timeout.abort(),
      hookRequestTimeoutMilliseconds,
    );
    try {
      const response = await requestFetch(url, {
        method: page === undefined ? "POST" : "GET",
        redirect: "manual",
        signal: AbortSignal.any([cancellation.signal, timeout.signal]),
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2026-03-10",
          "Content-Type": "application/json",
        },
        ...(page === undefined
          ? {
              body: JSON.stringify({
                name: "web",
                active: true,
                events: ["push"],
                config: {
                  url: githubWebhookUrl(
                    options.settings.GitHubWebhooks!.PublicUrl!,
                  ),
                  content_type: "json",
                  secret: options.secret,
                  insecure_ssl: "0",
                },
              }),
            }
          : {}),
      });
      if (response.status !== (page === undefined ? 201 : 200)) {
        await response.body?.cancel();
        const retryAfter = response.headers.get("retry-after");
        const remaining = response.headers.get("x-ratelimit-remaining");
        if (
          response.status === 429 ||
          (response.status === 403 &&
            (retryAfter !== null || remaining === "0"))
        ) {
          const seconds = retryAfter === null ? NaN : Number(retryAfter);
          const retryDate = retryAfter === null ? NaN : Date.parse(retryAfter);
          const reset =
            Number(response.headers.get("x-ratelimit-reset")) * 1000;
          apiRetryAt = Math.max(
            Date.now() + hookReconciliationIntervalMilliseconds,
            Number.isFinite(seconds)
              ? Date.now() + seconds * 1000
              : Number.isFinite(retryDate)
                ? retryDate
                : 0,
            Number.isFinite(reset) ? reset : 0,
          );
          throw new HookRequestError(
            "GitHub rate limit reached. Reconciliation will retry after GitHub's requested delay.",
          );
        }
        if (response.status === 401)
          throw new HookRequestError(
            "GitHub credential rejected. Replace the owner's host-environment token and restart.",
          );
        if (response.status === 403)
          throw new HookRequestError(
            "GitHub permission denied. Grant the owner's token repository Webhooks write access and restart.",
          );
        if (response.status === 404)
          throw new HookRequestError(
            "GitHub repository inaccessible or not found. Check the configured repository and token repository access.",
          );
        if (response.status >= 300 && response.status < 400)
          throw new HookRequestError(
            "GitHub API redirect refused. Check the canonical repository URL; no credential was forwarded.",
          );
        throw new HookRequestError(
          "GitHub API request failed or creation outcome is uncertain. A later reconciliation will list hooks before any create attempt.",
        );
      }
      if (page === undefined) {
        await response.body?.cancel();
        return undefined;
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw new HookRequestError(
          "GitHub returned an empty hook list response. Retry later.",
        );
      const chunks: Uint8Array[] = [];
      let size = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.length;
        if (size > 1024 * 1024) {
          await reader.cancel();
          throw new HookRequestError(
            "GitHub hook list exceeds 1 MiB. Inspect hooks manually; no hook was created.",
          );
        }
        chunks.push(value);
      }
      return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
    } catch (error) {
      if (error instanceof HookRequestError) throw error;
      throw new HookRequestError(
        "GitHub API transport or timeout failure; creation may have succeeded. A later reconciliation will list hooks before any create attempt.",
      );
    } finally {
      clearTimeout(timer);
    }
  }

  async function reconcile(repository: string) {
    const reference =
      options.settings.GitHubOwnerCredentials?.[repository.split("/")[0]!];
    const environmentName =
      reference === undefined
        ? undefined
        : parseHostEnvironmentReference(reference);
    const token =
      environmentName === undefined ? undefined : process.env[environmentName];
    if (!token) {
      report(
        repository,
        "failed",
        "Configure GitHubOwnerCredentials for this owner with a populated host-environment reference. Grant Contents read and Webhooks write access, then restart.",
      );
      return;
    }
    try {
      let found = false;
      const mismatches = new Set<string>();
      for (let page = 1; page <= maximumPages; page++) {
        const hooks = await api(repository, token, page);
        if (!Array.isArray(hooks))
          throw new HookRequestError(
            "GitHub returned an invalid hook list. Retry later or inspect repository hooks manually.",
          );
        for (const hook of hooks as {
          active?: boolean;
          events?: string[];
          config?: {
            url?: string;
            content_type?: string;
            insecure_ssl?: string | number;
          };
        }[]) {
          if (typeof hook?.config?.url !== "string") {
            throw new HookRequestError(
              "GitHub returned an invalid hook entry. Inspect hooks manually; no hook was created.",
            );
          }
          if (
            hook.config.url !==
            githubWebhookUrl(options.settings.GitHubWebhooks!.PublicUrl!)
          )
            continue;
          found = true;
          if (hook.active !== true) mismatches.add("enable delivery");
          if (
            !Array.isArray(hook.events) ||
            (!hook.events.includes("push") && !hook.events.includes("*"))
          )
            mismatches.add("enable push events");
          if (hook.config.content_type !== "json")
            mismatches.add("select JSON content type");
          if (String(hook.config.insecure_ssl) !== "0")
            mismatches.add("enable TLS verification");
        }
        if (hooks.length < 100) break;
        if (page === maximumPages)
          throw new HookRequestError(
            "GitHub hook pagination exceeded 100 pages. Inspect hooks manually; no hook was created.",
          );
      }
      if (found)
        report(
          repository,
          mismatches.size ? "operator-action" : "existing",
          `${mismatches.size ? `Existing callback requires operator action: ${[...mismatches].join(", ")}. ` : "Existing callback left unchanged. "}${signatureAdvice}`,
        );
      else {
        await api(repository, token);
        report(
          repository,
          "created",
          `Created a signed JSON push hook with TLS verification. ${signatureAdvice}`,
        );
      }
    } catch (error) {
      // Only our fixed diagnostics cross this boundary, never an API body or thrown transport text.
      report(
        repository,
        "failed",
        error instanceof HookRequestError
          ? error.message
          : "Reconciliation interrupted. Check receiver readiness and restart after configuration changes.",
      );
    }
  }

  async function run() {
    do {
      pending = false;
      if (!options.available() || cancellation.signal.aborted) return;
      const repositories = new Set<string>();
      for (const application of options.settings.Applications) {
        const repository = canonicalGitHubRepository(
          application.GitRepositoryUrl,
        );
        if (repository) repositories.add(repository);
        else if (!outcomes.has(`Application ${application.Name}`))
          report(
            `Application ${application.Name}`,
            "skipped",
            "Use an exact HTTPS github.com owner/repository URL for webhook acceleration. Ordinary polling remains enabled.",
          );
      }
      for (const repository of repositories) {
        if (!options.available() || cancellation.signal.aborted) return;
        if (Date.now() < (nextAttempts.get(repository) ?? 0)) continue;
        nextAttempts.set(
          repository,
          Date.now() + hookReconciliationIntervalMilliseconds,
        );
        await reconcile(repository);
        nextAttempts.set(
          repository,
          Date.now() + hookReconciliationIntervalMilliseconds,
        );
      }
    } while (pending);
  }
  function request() {
    if (cancellation.signal.aborted || !options.available()) return;
    pending = true;
    running ??= run().finally(() => {
      running = undefined;
    });
  }
  const timer = setInterval(request, hookReconciliationIntervalMilliseconds);
  request();
  return {
    request,
    status: () => [...outcomes.values()].map((value) => ({ ...value })),
    stop: async () => {
      clearInterval(timer);
      cancellation.abort();
      await running;
    },
  };
}
