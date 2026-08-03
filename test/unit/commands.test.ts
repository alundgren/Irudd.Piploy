import { describe, expect, it } from "vitest";

import { notImplementedMessage } from "../../src/commands.js";

describe("notImplementedMessage", () => {
  it("identifies the command as an unavailable stub", () => {
    expect(notImplementedMessage("status")).toBe("status: not implemented");
  });
});
