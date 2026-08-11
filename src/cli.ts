import { Command } from "commander";

import {
  createCommandDeps,
  parseRegisterOptions,
  poll,
  register,
  serviceStart,
  serviceStop,
  status,
  wipeAll,
  type RegisterOptions,
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
  "register",
] as const;

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

/** `register` is the one command carrying a payload, so it alone takes flags. */
function addRegisterOptions(command: Command): Command {
  return command
    .option("--name <name>", "application name")
    .option("--git-repository-url <url>", "git repository to deploy from")
    .option("--dockerfile-path <path>", "Dockerfile path within the repository")
    .option(
      "--port-mapping <hostPort:containerPort>",
      "port mapping, repeatable",
      collect,
      [],
    )
    .option(
      "--volume <name:/container/path>",
      "volume, repeatable",
      collect,
      [],
    )
    .option(
      "--env <KEY=VALUE>",
      "environment variable, repeatable",
      collect,
      [],
    )
    .option("--json <application>", "the whole Application as JSON");
}

function registerCommand(
  program: Command,
  commandName: (typeof commandNames)[number],
): void {
  const command = program.command(commandName);
  if (commandName === "register") addRegisterOptions(command);
  command.action(async (options: RegisterOptions) => {
    const parsed =
      commandName === "register" ? parseRegisterOptions(options) : undefined;
    if (parsed?.ok === false) {
      console.error(parsed.message);
      process.exitCode = 1;
      return;
    }
    const settings = loadSettings(resolveConfigPath());
    const deps = createCommandDeps(settings, createLogger(settings));
    if (parsed) {
      await register(deps, parsed.application);
      return;
    }
    const actions = {
      status,
      "service-start": serviceStart,
      "service-stop": serviceStop,
      poll,
      wipeall: wipeAll,
    } as const;
    await actions[commandName as Exclude<typeof commandName, "register">](deps);
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
