import { appendFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import path from "node:path";

import pino from "pino";

import type { PiploySettings } from "./settings.js";

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface LogScope {
  operation?: string;
  application?: string;
  gitRepository?: string;
}

export interface Logger {
  debug(message: string): void;
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
  child(scope: LogScope): Logger;
}

const reservedKeys = new Set(["level", "time", "msg", "pid", "hostname"]);

/**
 * .NET's `CalendarWeekRule.FirstDay` + Monday-first week, matching the ported
 * file's original rotation cadence exactly (not true ISO 8601, whose week 1
 * can start in the prior year).
 */
export function calendarWeekOfYear(date: Date): number {
  const year = date.getUTCFullYear();
  const jan1 = Date.UTC(year, 0, 1);
  const dayOfYear =
    Math.floor((date.getTime() - jan1) / (24 * 60 * 60 * 1000)) + 1;
  const jan1Iso = ((new Date(jan1).getUTCDay() + 6) % 7) + 1; // Mon=1..Sun=7
  const daysInWeek1 = 8 - jan1Iso;
  if (dayOfYear <= daysInWeek1) {
    return 1;
  }
  return 1 + Math.ceil((dayOfYear - daysInWeek1) / 7);
}

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace("T", " ");
}

function formatLine(parsed: Record<string, unknown>): string {
  const scopeEntries = Object.entries(parsed).filter(
    ([key]) => !reservedKeys.has(key),
  );
  const scopePrefix = `[${scopeEntries.map(([key, value]) => `${key}=${String(value)}`).join(", ")}]`;
  const timestamp = formatTimestamp(new Date(parsed.time as number));
  return `${timestamp} ${scopePrefix} ${String(parsed.msg)}`;
}

function getLogFolder(settings: PiploySettings): string {
  return path.join(settings.RootDirectory, "logs");
}

function rotatingLogFilename(now: Date): string {
  return `piploy-log-${now.getUTCFullYear()}-${calendarWeekOfYear(now)}.txt`;
}

function writeRotatingLogLine(logFolder: string, line: string): void {
  const now = new Date();
  const currentFilename = rotatingLogFilename(now);
  for (const entry of readdirSync(logFolder, { withFileTypes: true })) {
    if (
      entry.isFile() &&
      entry.name.startsWith("piploy-log-") &&
      entry.name !== currentFilename
    ) {
      unlinkSync(path.join(logFolder, entry.name));
    }
  }
  appendFileSync(path.join(logFolder, currentFilename), line + "\n");
}

function createTextStream(logFolder: string): pino.DestinationStream {
  return {
    write(rawLine: string) {
      if (!rawLine.trim()) return;
      const parsed = JSON.parse(rawLine) as Record<string, unknown>;
      const line = formatLine(parsed);
      process.stdout.write(line + "\n");
      writeRotatingLogLine(logFolder, line);
    },
  };
}

function wrap(pinoLogger: pino.Logger): Logger {
  return {
    debug: (message) => pinoLogger.debug(message),
    info: (message) => pinoLogger.info(message),
    warn: (message) => pinoLogger.warn(message),
    error: (message) => pinoLogger.error(message),
    child: (scope) => wrap(pinoLogger.child(scope)),
  };
}

export function createLogger(
  settings: PiploySettings,
  level: LogLevel = "info",
): Logger {
  const logFolder = getLogFolder(settings);
  mkdirSync(logFolder, { recursive: true });
  const pinoLogger = pino(
    { level, base: undefined, timestamp: pino.stdTimeFunctions.epochTime },
    createTextStream(logFolder),
  );
  return wrap(pinoLogger);
}
