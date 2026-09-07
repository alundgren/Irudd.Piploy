import { describe, expect, it } from "vitest";

import {
  buildkitConfiguration,
  parseAvailableBytes,
} from "../../src/buildx.js";
import { parseSettings } from "../../src/settings.js";

const base = { RootDirectory: "/tmp/root", Applications: [] };

describe("Buildx configuration", () => {
  it("keeps existing installations opted out and defaults to the protected retention policy", () => {
    expect(parseSettings({ Piploy: base }).Buildx).toBeUndefined();
    expect(parseSettings({ Piploy: { ...base, Buildx: {} } }).Buildx).toEqual({
      Enabled: false,
      CacheRetentionHours: 720,
      CacheTargetBytes: 8589934592,
      MinimumFreeBytes: 5368709120,
    });
  });
  it.each([0, -1, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, "100"])(
    "rejects invalid storage limits %s",
    (value) => {
      for (const field of ["CacheTargetBytes", "MinimumFreeBytes"])
        expect(() =>
          parseSettings({ Piploy: { ...base, Buildx: { [field]: value } } }),
        ).toThrow();
    },
  );
  it("has one age-protected automatic GC policy and no unprotected fallback", () => {
    const config = buildkitConfiguration(720, 8589934592, 5368709120);
    expect(config.match(/\[\[worker.oci.gcpolicy\]\]/g)).toHaveLength(1);
    expect(config).toContain('keepDuration = "2592000s"');
    expect(config).toContain("maxUsedSpace = 8589934592");
    expect(config).toContain("minFreeSpace = 5368709120");
  });
});

describe("Docker storage measurement", () => {
  it("reads the available column in 1024-byte units", () => {
    expect(
      parseAvailableBytes(
        "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 1000 600 400 60% /storage\n",
      ),
    ).toBe(409600);
  });
  it.each([
    "",
    "permission denied",
    "header\n/dev/vda 1000 600 nope 60% /storage",
    "header\n/dev/vda 1000 600 -1 60% /storage",
  ])("rejects unreliable output", (output) => {
    expect(() => parseAvailableBytes(output)).toThrow();
  });
});

it("uses the lower capacity when Docker data and image snapshots use different filesystems", () => {
  expect(
    parseAvailableBytes(
      "Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/vda 1000 600 400 60% /storage\noverlay 1000 900 100 90% /\n",
    ),
  ).toBe(102400);
});
