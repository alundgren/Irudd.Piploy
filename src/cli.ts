import { Command } from "commander";

import { notImplementedMessage } from "./commands.js";
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

export function createProgram(): Command {
  const program = new Command();

  program.name("piploy").version(piployVersion);
  for (const commandName of commandNames) {
    registerStubCommand(program, commandName);
  }

  return program;
}

createProgram().parse();
