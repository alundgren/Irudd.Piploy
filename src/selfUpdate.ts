import { mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Logger } from "./logger.js";
import { resolveBundleDirectory } from "./settings.js";
import { piployVersion } from "./version.js";

const releaseApiUrl =
  "https://api.github.com/repos/alundgren/Irudd.Piploy/releases/latest";
const bundleFilename = "piploy.cjs";

export type SelfUpdateResult = "updated" | "up-to-date" | "failed";

export interface LatestRelease {
  tag: string;
  downloadUrl: string;
}

interface ReleaseResponse {
  tag_name?: unknown;
  assets?: unknown;
}

interface ReleaseAsset {
  name?: unknown;
  browser_download_url?: unknown;
}

/** Optional locations make the real HTTP/file-system flow integration-testable. */
export interface SelfUpdateOptions {
  bundleDirectory?: string;
  latestReleaseUrl?: string;
}

/** A release tag differs from a tagged production build exactly when it should install. */
export function shouldSelfUpdate(
  runningVersion: string,
  latestTag: string,
): boolean {
  return runningVersion !== latestTag;
}

function latestReleaseFrom(value: unknown): LatestRelease {
  const release = value as ReleaseResponse;
  if (typeof release.tag_name !== "string" || !Array.isArray(release.assets)) {
    throw new Error("Latest release response is missing release metadata");
  }
  const asset = (release.assets as ReleaseAsset[]).find(
    (candidate) => candidate.name === bundleFilename,
  );
  if (!asset || typeof asset.browser_download_url !== "string") {
    throw new Error(`Latest release has no ${bundleFilename} asset`);
  }
  return { tag: release.tag_name, downloadUrl: asset.browser_download_url };
}

export async function checkLatestRelease(
  latestUrl: string = releaseApiUrl,
): Promise<LatestRelease> {
  const response = await fetch(latestUrl);
  if (!response.ok) {
    throw new Error(
      `Latest release check failed: ${response.status} ${response.statusText}`,
    );
  }
  return latestReleaseFrom(await response.json());
}

async function downloadAndSwap(
  downloadUrl: string,
  bundleDirectory: string,
): Promise<void> {
  const response = await fetch(downloadUrl);
  if (!response.ok) {
    throw new Error(
      `Piploy release download failed: ${response.status} ${response.statusText}`,
    );
  }

  const temporaryDirectory = await mkdtemp(
    path.join(bundleDirectory, ".piploy-update-"),
  );
  const temporaryBundle = path.join(temporaryDirectory, bundleFilename);
  const bundlePath = path.join(bundleDirectory, bundleFilename);
  const previousBundlePath = `${bundlePath}.prev`;
  try {
    await writeFile(
      temporaryBundle,
      new Uint8Array(await response.arrayBuffer()),
    );
    await rename(bundlePath, previousBundlePath);
    await rename(temporaryBundle, bundlePath);
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

/**
 * Checks GitHub for a release, atomically swaps in its bundle when needed, and
 * never lets an update failure interrupt the caller's normal work.
 */
export async function attemptSelfUpdate(
  logger: Logger,
  options: SelfUpdateOptions = {},
): Promise<SelfUpdateResult> {
  try {
    logger.info("Checking for a Piploy update");
    const release = await checkLatestRelease(options.latestReleaseUrl);
    if (!shouldSelfUpdate(piployVersion, release.tag)) {
      logger.info(`Piploy is up to date (${piployVersion})`);
      return "up-to-date";
    }

    logger.info(`Installing Piploy update ${release.tag}`);
    await downloadAndSwap(
      release.downloadUrl,
      options.bundleDirectory ?? resolveBundleDirectory(),
    );
    logger.info(`Installed Piploy update ${release.tag}; restarting`);
    process.exit(0);
    return "updated";
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.error(`Self-update failed: ${detail}`);
    return "failed";
  }
}
