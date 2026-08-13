import { describe, expect, it } from "vitest";

import {
  decodeContainerLog,
  defaultLogTailLines,
  limitLogBytes,
  maxLogBytes,
  maxLogTailLines,
  resolveTailLines,
} from "../../src/containerLogs.js";

function frame(streamType: number, payload: string): Buffer {
  const body = Buffer.from(payload, "utf8");
  const header = Buffer.alloc(8);
  header.writeUInt8(streamType, 0);
  header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}

describe("resolveTailLines", () => {
  it("uses the default when no tail is requested", () => {
    expect(resolveTailLines(undefined)).toBe(defaultLogTailLines);
  });

  it("keeps a requested tail within the allowed range", () => {
    expect(resolveTailLines(50)).toBe(50);
  });

  it("clamps a tail above the hard maximum", () => {
    expect(resolveTailLines(maxLogTailLines + 1000)).toBe(maxLogTailLines);
  });

  it.each([0, -5, 1.5, Number.NaN])(
    "falls back to the default for the unusable request %s",
    (requested) => {
      expect(resolveTailLines(requested)).toBe(defaultLogTailLines);
    },
  );
});

describe("decodeContainerLog", () => {
  it("joins stdout and stderr frames in the order Docker emitted them", () => {
    const buffer = Buffer.concat([
      frame(1, "starting\n"),
      frame(2, "boom\n"),
      frame(1, "done\n"),
    ]);
    expect(decodeContainerLog(buffer)).toBe("starting\nboom\ndone\n");
  });

  it("returns the raw text when the stream is not multiplexed", () => {
    expect(decodeContainerLog(Buffer.from("plain tty output\n", "utf8"))).toBe(
      "plain tty output\n",
    );
  });

  it("returns the raw text when a frame claims more bytes than remain", () => {
    const truncated = frame(1, "hello").subarray(0, 10);
    expect(decodeContainerLog(truncated)).toBe(truncated.toString("utf8"));
  });

  it("returns an empty string for an empty buffer", () => {
    expect(decodeContainerLog(Buffer.alloc(0))).toBe("");
  });
});

describe("limitLogBytes", () => {
  it("returns short output untouched", () => {
    expect(limitLogBytes("a\nb\n")).toEqual({
      text: "a\nb\n",
      truncated: false,
    });
  });

  it("keeps the most recent bytes when the output is too large", () => {
    const text = `${"x".repeat(maxLogBytes)}TAIL`;
    const result = limitLogBytes(text);
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text, "utf8")).toBeLessThanOrEqual(
      maxLogBytes,
    );
    expect(result.text.endsWith("TAIL")).toBe(true);
  });

  it("drops the partly cut line rather than starting mid-line", () => {
    const text = `${"x".repeat(maxLogBytes)}\nkept\nalso kept\n`;
    expect(limitLogBytes(text).text).toBe("kept\nalso kept\n");
  });

  it("never opens with half a multi-byte character", () => {
    // One unbroken line, so there is no line break to fall forward to.
    const text = "å".repeat(maxLogBytes);
    const result = limitLogBytes(text);
    expect(result.truncated).toBe(true);
    expect(result.text).not.toContain("�");
    expect(result.text.startsWith("å")).toBe(true);
  });
});
