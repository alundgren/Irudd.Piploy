import { describe, expect, it } from "vitest";

import { shouldSelfUpdate } from "../../src/selfUpdate.js";

describe("shouldSelfUpdate", () => {
  it("updates exactly when the release tag differs from the running version", () => {
    expect(shouldSelfUpdate("v1.2.3", "v1.2.3")).toBe(false);
    expect(shouldSelfUpdate("v1.2.3", "v1.2.4")).toBe(true);
    expect(shouldSelfUpdate("0.1.0+abc123", "v0.1.0")).toBe(true);
  });
});
