import { Command } from "commander";

import {
  commandFailed,
  createCommandDeps,
  parseRegisterOptions,
  poll,
  register,
  restartDaemonAfterUpdate,
  serviceStart,
  serviceStop,
  status,
  wipeAll,
  type CommandDeps,
  type RegisterOptions,
} from "./commands.js";
import { requestDaemon } from "./daemon.js";
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

// Only `register` reads the second argument; the rest are zero-arg commands.
type CommandAction = (deps: CommandDeps, application: unknown) => Promise<void>;

const actions: Record<(typeof commandNames)[number], CommandAction> = {
  status,
  "service-start": serviceStart,
  "service-stop": serviceStop,
  poll,
  wipeall: wipeAll,
  register,
};

async function runCommand(
  commandName: (typeof commandNames)[number],
  application: unknown,
): Promise<void> {
  const settings = loadSettings(resolveConfigPath());
  const deps = createCommandDeps(settings, createLogger(settings));
  await actions[commandName](deps, application);
}

function defineCommand(
  program: Command,
  commandName: (typeof commandNames)[number],
): void {
  const command = program.command(commandName);
  if (commandName !== "register") {
    command.action(() => runCommand(commandName, undefined));
    return;
  }
  // Flags are parsed before the configuration is loaded, so bad input fails on
  // its own terms rather than on a missing or broken piploy.json.
  addRegisterOptions(command).action(async (options: RegisterOptions) => {
    const parsed = parseRegisterOptions(options);
    if (!parsed.ok) {
      commandFailed(parsed.message);
      return;
    }
    await runCommand(commandName, parsed.application);
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
    if (result === "updated") {
      await restartDaemonAfterUpdate(requestDaemon);
    } else if (result === "failed") {
      process.exitCode = 1;
    }
  });
  for (const commandName of commandNames) {
    defineCommand(program, commandName);
  }

  return program;
}

void createProgram().parseAsync();
