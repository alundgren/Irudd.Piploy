import { Command } from "commander";

import {
  commandFailed,
  createCommandDeps,
  logs,
  parseRegisterOptions,
  parseTailOption,
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
import { defaultLogTailLines, maxLogTailLines } from "./containerLogs.js";
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
  "logs",
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
      "--build-context-path <path>",
      "Docker build context directory within the repository",
    )
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

// `register` and `logs` carry a payload, so each is wired to its own action
// below. Everything else takes nothing but the dependencies.
const plainActions: Record<
  Exclude<(typeof commandNames)[number], "register" | "logs">,
  (deps: CommandDeps) => Promise<void>
> = {
  status,
  "service-start": serviceStart,
  "service-stop": serviceStop,
  poll,
  wipeall: wipeAll,
};

async function runCommand(
  run: (deps: CommandDeps) => Promise<void>,
): Promise<void> {
  const settings = loadSettings(resolveConfigPath());
  await run(createCommandDeps(settings, createLogger(settings)));
}

function defineCommand(
  program: Command,
  commandName: (typeof commandNames)[number],
): void {
  const command = program.command(commandName);
  if (commandName === "logs") {
    command
      .argument("<application>", "registered application name")
      .option(
        "--tail <lines>",
        `lines to return (default ${defaultLogTailLines}, maximum ${maxLogTailLines})`,
      )
      .action(async (application: string, options: { tail?: string }) => {
        const parsed = parseTailOption(options.tail);
        if (!parsed.ok) {
          commandFailed(parsed.message);
          return;
        }
        await runCommand((deps) =>
          logs(deps, { application, tail: parsed.tail }),
        );
      });
    return;
  }
  if (commandName !== "register") {
    command.action(() => runCommand(plainActions[commandName]));
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
    await runCommand((deps) => register(deps, parsed.application));
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
