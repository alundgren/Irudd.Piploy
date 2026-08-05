import { Command } from "commander";

import {
  createCommandDeps,
  poll,
  serviceStart,
  serviceStop,
  status,
  wipeAll,
} from "./commands.js";
import { createLogger, type Logger } from "./logger.js";
import { loadSettings, resolveConfigPath } from "./settings.js";
import { attemptSelfUpdate } from "./selfUpdate.js";
import { piployVersion } from "./version.js";

const commandNames = [
  "status",
  "service-start",
  "service-stop",
  "poll",
  "wipeall",
] as const;

function registerCommand(
  program: Command,
  commandName: (typeof commandNames)[number],
): void {
  program.command(commandName).action(async () => {
    const settings = loadSettings(resolveConfigPath());
    const deps = createCommandDeps(settings, createLogger(settings));
    const actions = {
      status,
      "service-start": serviceStart,
      "service-stop": serviceStop,
      poll,
      wipeall: wipeAll,
    } as const;
    await actions[commandName](deps);
  });
}

function createConsoleLogger(): Logger {
  const logger: Logger = {
    debug: (message) => console.debug(message),
    info: (message) => console.log(message),
    warn: (message) => console.warn(message),
    error: (message) => console.error(message),
    child: () => logger,
  };
  return logger;
}

export function createProgram(): Command {
  const program = new Command();

  program.name("piploy").version(piployVersion);
  program.command("self-update").action(async () => {
    const result = await attemptSelfUpdate(createConsoleLogger());
    if (result === "failed") {
      process.exitCode = 1;
    }
  });
  for (const commandName of commandNames) {
    registerCommand(program, commandName);
  }

  return program;
}

void createProgram().parseAsync();
