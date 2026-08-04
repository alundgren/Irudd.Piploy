import { Command } from "commander";

import { notImplementedMessage } from "./commands.js";
import type { Logger } from "./logger.js";
import { attemptSelfUpdate } from "./selfUpdate.js";
import { piployVersion } from "./version.js";

const commandNames = [
  "status",
  "service-start",
  "service-stop",
  "poll",
  "wipeall",
] as const;

function registerStubCommand(
  program: Command,
  commandName: (typeof commandNames)[number],
): void {
  program.command(commandName).action(() => {
    console.error(notImplementedMessage(commandName));
    process.exitCode = 1;
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
    registerStubCommand(program, commandName);
  }

  return program;
}

createProgram().parse();
