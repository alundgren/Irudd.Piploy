import { describe, expect, it } from "vitest";

import { decideQueueAdmission } from "../../src/queuePolicy.js";

describe("decideQueueAdmission", () => {
  it("enqueues an item while capacity remains", () => {
    expect(decideQueueAdmission(2, 3, "client")).toBe("enqueue");
  });

  it("rejects a client request immediately when full", () => {
    expect(decideQueueAdmission(3, 3, "client")).toBe("reject-busy");
  });

  it("silently drops an internal timer tick when full", () => {
    expect(decideQueueAdmission(3, 3, "timer")).toBe("drop");
  });
});
