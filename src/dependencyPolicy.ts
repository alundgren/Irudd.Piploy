/**
 * pnpm enforces the release-age and dependency-build policy itself, from
 * `pnpm-workspace.yaml`, at install time. That enforcement can't be unit
 * tested without a real registry, so this module is a pure, testable mirror
 * of its decision rules (#20) — proving the policy's semantics deterministically,
 * independent of network access.
 */

/** `pnpm-workspace.yaml`'s `minimumReleaseAge`, in minutes (8 days). */
export const minimumReleaseAgeMinutes = 11520;

export function isPackageVersionReleaseAgeApproved(
  publishedAt: Date,
  now: Date,
  minimumReleaseAgeMinutesValue: number = minimumReleaseAgeMinutes,
): boolean {
  const ageMinutes = (now.getTime() - publishedAt.getTime()) / 60_000;
  return ageMinutes >= minimumReleaseAgeMinutesValue;
}

/** Default-deny: a dependency build script runs only if explicitly approved. */
export function isDependencyBuildScriptApproved(
  packageName: string,
  allowBuilds: Record<string, boolean>,
): boolean {
  return allowBuilds[packageName] === true;
}
