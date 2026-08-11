import { describe, expect, it } from "vitest";

import { isDuplicateApplicationName } from "../../src/registerPolicy.js";

describe("isDuplicateApplicationName", () => {
  it("finds an exactly matching name", () => {
    expect(
      isDuplicateApplicationName([{ Name: "other" }, { Name: "app" }], "app"),
    ).toBe(true);
  });

  it("does not match a name that differs only in case", () => {
    expect(isDuplicateApplicationName([{ Name: "App" }], "app")).toBe(false);
  });

  it("does not match a partial name", () => {
    expect(isDuplicateApplicationName([{ Name: "app-two" }], "app")).toBe(
      false,
    );
  });

  it("is false when nothing is registered", () => {
    expect(isDuplicateApplicationName([], "app")).toBe(false);
  });
});
