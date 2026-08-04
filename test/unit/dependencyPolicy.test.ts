import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  isDependencyBuildScriptApproved,
  isPackageVersionReleaseAgeApproved,
} from "../../src/dependencyPolicy.js";

const now = new Date("2026-08-04T00:00:00Z");
const oneDayMs = 24 * 60 * 60_000;

describe("isPackageVersionReleaseAgeApproved", () => {
  it("resolves a package published exactly eight days ago", () => {
    const publishedAt = new Date(now.getTime() - 8 * oneDayMs);
    expect(isPackageVersionReleaseAgeApproved(publishedAt, now)).toBe(true);
  });

  it("resolves a package older than eight days", () => {
    const publishedAt = new Date(now.getTime() - 30 * oneDayMs);
    expect(isPackageVersionReleaseAgeApproved(publishedAt, now)).toBe(true);
  });

  it("rejects a package published more recently than eight days ago", () => {
    const publishedAt = new Date(now.getTime() - 2 * oneDayMs);
    expect(isPackageVersionReleaseAgeApproved(publishedAt, now)).toBe(false);
  });

  it("rejects a package published moments ago", () => {
    expect(isPackageVersionReleaseAgeApproved(now, now)).toBe(false);
  });
});

describe("isDependencyBuildScriptApproved", () => {
  const allowBuilds = { esbuild: true, "cpu-features": false };

  it("allows an explicitly reviewed dependency build script", () => {
    expect(isDependencyBuildScriptApproved("esbuild", allowBuilds)).toBe(true);
  });

  it.each(["cpu-features", "some-unreviewed-package"])(
    "denies %s by default",
    (packageName) => {
      expect(isDependencyBuildScriptApproved(packageName, allowBuilds)).toBe(
        false,
      );
    },
  );
});

describe("pnpm-workspace.yaml", () => {
  it("configures the settled supply-chain policy (#20)", () => {
    const workspaceConfigPath = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../pnpm-workspace.yaml",
    );
    const contents = readFileSync(workspaceConfigPath, "utf8");

    expect(contents).toMatch(/^minimumReleaseAge:\s*11520\s*$/m);
    expect(contents).toMatch(/^minimumReleaseAgeStrict:\s*true\s*$/m);
    expect(contents).toMatch(
      /^minimumReleaseAgeIgnoreMissingTime:\s*false\s*$/m,
    );
    expect(contents).toMatch(/^trustPolicy:\s*no-downgrade\s*$/m);
    expect(contents).toMatch(/^trustLockfile:\s*false\s*$/m);
    expect(contents).toMatch(/^blockExoticSubdeps:\s*true\s*$/m);
  });
});
