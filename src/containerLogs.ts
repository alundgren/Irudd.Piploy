/**
 * Container log output is read for diagnosis, not archival: a caller asks for
 * the tail and gets a bounded answer. The limits are hardcoded because an
 * unbounded tail returned over MCP is its own problem, and nothing so far has
 * needed to tune them per Application.
 */
export const defaultLogTailLines = 200;
export const maxLogTailLines = 2000;
export const maxLogBytes = 256 * 1024;

const frameHeaderBytes = 8;
const stdinStream = 0;
const stderrStream = 2;

/** Clamps a caller's requested tail; anything unusable falls back to the default. */
export function resolveTailLines(requested: number | undefined): number {
  if (requested === undefined) return defaultLogTailLines;
  if (!Number.isInteger(requested) || requested < 1) return defaultLogTailLines;
  return Math.min(requested, maxLogTailLines);
}

function readFrames(buffer: Buffer): string | undefined {
  const parts: Buffer[] = [];
  let offset = 0;
  while (offset < buffer.length) {
    if (offset + frameHeaderBytes > buffer.length) return undefined;
    const streamType = buffer.readUInt8(offset);
    if (streamType < stdinStream || streamType > stderrStream) return undefined;
    const length = buffer.readUInt32BE(offset + 4);
    const start = offset + frameHeaderBytes;
    const end = start + length;
    if (end > buffer.length) return undefined;
    parts.push(buffer.subarray(start, end));
    offset = end;
  }
  return Buffer.concat(parts).toString("utf8");
}

/**
 * Docker multiplexes stdout and stderr into length-prefixed frames for a
 * container without a TTY, which is every container Piploy creates. Anything
 * that does not parse as frames is returned as-is rather than mangled, so a
 * TTY container or a partial read still yields readable output.
 */
export function decodeContainerLog(buffer: Buffer): string {
  return readFrames(buffer) ?? buffer.toString("utf8");
}

/** Caps the returned output, keeping the most recent bytes. */
export function limitLogBytes(text: string): {
  text: string;
  truncated: boolean;
} {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxLogBytes) return { text, truncated: false };
  return {
    text: buffer.subarray(buffer.length - maxLogBytes).toString("utf8"),
    truncated: true,
  };
}
