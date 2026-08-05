import { Command } from "commander";

import {
  createCommandDeps,
  poll,
  serviceStart,
  serviceStop,
  status,
  wipeAll,
} from "./commands.js";
import { createLogger } from "./logger.js";
import { loadSettings, resolveConfigPath } from "./settings.js";
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

export function createProgram(): Command {
  const program = new Command();

  program.name("piploy").version(piployVersion);
  for (const commandName of commandNames) {
    registerCommand(program, commandName);
  }

  return program;
}

void createProgram().parseAsync();
