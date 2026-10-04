import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import {
  BOTS_CONFIG_FILENAME,
  getBotsStateFilePath,
  loadBotsConfig,
  resolveBotsConfigPath,
} from "./bots-config.js";
import {
  BotSupervisor,
  isProcessAlive,
  readSupervisorState,
  stopProcessTree,
  waitForProcessExit,
} from "./supervisor.js";

const EXIT_SUCCESS = 0;
const EXIT_RUNTIME_ERROR = 1;
const EXIT_INVALID_ARGS = 2;
const DOWN_SUPERVISOR_TIMEOUT_MS = 10000;
const LOG_TAIL_POLL_MS = 500;
const LOG_TAIL_INITIAL_LINES = 50;

const BOTS_USAGE = `Usage:
  opencode-telegram bots up              Start all bots from ${BOTS_CONFIG_FILENAME} and supervise them
  opencode-telegram bots down            Stop the supervisor and all bots
  opencode-telegram bots status          Show supervisor and per-bot status
  opencode-telegram bots logs <name>     Follow one bot's log file`;

const BOTS_SUBCOMMANDS = ["up", "down", "status", "logs"] as const;
type BotsSubcommand = (typeof BOTS_SUBCOMMANDS)[number];

function writeStdout(message: string): void {
  process.stdout.write(`${message}\n`);
}

function writeStderr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function isBotsSubcommand(value: string): value is BotsSubcommand {
  return (BOTS_SUBCOMMANDS as readonly string[]).includes(value);
}

/**
 * Entry point for `opencode-telegram bots <subcommand>`.
 * Returns a process exit code.
 */
export async function runBotsCommand(args: string[]): Promise<number> {
  const [subcommand, ...rest] = args;

  if (!subcommand || subcommand === "--help" || subcommand === "-h") {
    writeStdout(BOTS_USAGE);
    return subcommand ? EXIT_SUCCESS : EXIT_INVALID_ARGS;
  }

  if (!isBotsSubcommand(subcommand)) {
    writeStderr(`Unknown bots subcommand: ${subcommand}`);
    writeStdout(BOTS_USAGE);
    return EXIT_INVALID_ARGS;
  }

  if (subcommand === "logs") {
    const [name, ...extra] = rest;
    if (!name || extra.length > 0) {
      writeStderr("Command `bots logs` requires exactly one bot name.");
      writeStdout(BOTS_USAGE);
      return EXIT_INVALID_ARGS;
    }
    return runBotsLogs(name);
  }

  if (rest.length > 0) {
    writeStderr(`Unexpected argument for bots ${subcommand}: ${rest[0]}`);
    writeStdout(BOTS_USAGE);
    return EXIT_INVALID_ARGS;
  }

  if (subcommand === "up") {
    return runBotsUp();
  }
  if (subcommand === "down") {
    return runBotsDown();
  }
  return runBotsStatus();
}

async function runBotsUp(): Promise<number> {
  const configPath = resolveBotsConfigPath();
  const stateFilePath = getBotsStateFilePath(configPath);

  const existingState = await readSupervisorState(stateFilePath);
  if (existingState && isProcessAlive(existingState.supervisorPid)) {
    writeStderr(
      `A supervisor is already running (PID ${existingState.supervisorPid}). ` +
        `Run \`opencode-telegram bots down\` first.`,
    );
    return EXIT_RUNTIME_ERROR;
  }
  if (existingState) {
    writeStderr(
      `Removed stale supervisor state (old PID ${existingState.supervisorPid} is gone).`,
    );
    await stopOrphanChildren(existingState);
    await fsPromises.rm(stateFilePath, { force: true });
  }

  let config;
  try {
    config = loadBotsConfig(configPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    return EXIT_RUNTIME_ERROR;
  }

  const configDir = path.dirname(configPath);
  const supervisor = new BotSupervisor(
    config,
    stateFilePath,
    path.join(configDir, "logs"),
  );

  let shutdownPromise: Promise<void> | null = null;
  const requestShutdown = (): void => {
    if (shutdownPromise) {
      return;
    }
    writeStdout("[supervisor] Stop requested; stopping all bots...");
    shutdownPromise = supervisor.stop();
  };
  process.once("SIGINT", requestShutdown);
  process.once("SIGTERM", requestShutdown);

  try {
    await supervisor.start();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    writeStderr(message);
    await supervisor.stop();
    return EXIT_RUNTIME_ERROR;
  }

  writeStdout(`Supervisor started for ${config.bots.length} bot(s):`);
  for (const summary of supervisor.getBotSummaries()) {
    const pidText = summary.pid !== null ? `PID ${summary.pid}` : "not running";
    writeStdout(`  - ${summary.name}: ${pidText} | console log: ${summary.logFilePath}`);
  }
  writeStdout(`  state: ${stateFilePath}`);
  writeStdout("Press Ctrl+C to stop all bots.");

  await supervisor.waitUntilStopped();
  writeStdout("Supervisor stopped.");
  return supervisor.getExitCode();
}

async function runBotsDown(): Promise<number> {
  const configPath = resolveBotsConfigPath();
  const stateFilePath = getBotsStateFilePath(configPath);
  const state = await readSupervisorState(stateFilePath);

  if (!state) {
    writeStdout("No supervisor is running.");
    return EXIT_SUCCESS;
  }

  const supervisorPid = state.supervisorPid;
  if (isProcessAlive(supervisorPid)) {
    writeStdout(`Stopping supervisor (PID ${supervisorPid})...`);
    await stopProcessTree(supervisorPid);
    const exited = await waitForProcessExit(supervisorPid, DOWN_SUPERVISOR_TIMEOUT_MS);
    if (!exited) {
      writeStderr(
        `Supervisor (PID ${supervisorPid}) did not exit; stopping children directly.`,
      );
    }
  }

  // The supervisor normally stops its children; this covers a supervisor that
  // crashed or ignored the signal.
  await stopOrphanChildren(state);
  await fsPromises.rm(stateFilePath, { force: true });
  writeStdout(`Stopped ${state.bots.length} bot(s).`);
  return EXIT_SUCCESS;
}

async function runBotsStatus(): Promise<number> {
  const configPath = resolveBotsConfigPath();
  const stateFilePath = getBotsStateFilePath(configPath);
  const state = await readSupervisorState(stateFilePath);

  if (!state) {
    writeStdout("Service status: stopped");
    writeStdout(`Config: ${configPath}`);
    return EXIT_SUCCESS;
  }

  const supervisorAlive = isProcessAlive(state.supervisorPid);
  writeStdout(
    `Service status: ${supervisorAlive ? "running" : "stale (supervisor gone)"}`,
  );
  writeStdout(`Supervisor PID: ${state.supervisorPid}`);
  writeStdout(`Started at: ${state.startedAt}`);
  writeStdout(`Config: ${state.configPath}`);
  writeStdout("Bots:");

  for (const bot of state.bots) {
    const alive = bot.pid > 0 && isProcessAlive(bot.pid);
    const pidText = bot.pid > 0 ? `PID ${bot.pid}` : "no PID";
    const liveness = bot.pid > 0 ? (alive ? "up" : "dead") : "-";
    writeStdout(
      `  - ${bot.name}: status=${bot.status} ${pidText} (${liveness}) restarts=${bot.restarts}`,
    );
    writeStdout(`      console log: ${bot.consoleLogFilePath}`);
  }
  return EXIT_SUCCESS;
}

async function runBotsLogs(name: string): Promise<number> {
  const configPath = resolveBotsConfigPath();
  const stateFilePath = getBotsStateFilePath(configPath);
  const state = await readSupervisorState(stateFilePath);

  const botState = state?.bots.find((bot) => bot.name === name);
  const logFilePath = botState?.consoleLogFilePath ?? findFallbackLog(configPath, name);

  if (!logFilePath) {
    writeStderr(
      `No log file found for bot "${name}". ` +
        `Is the name correct (see \`bots status\`) and has the bot ever started?`,
    );
    return EXIT_RUNTIME_ERROR;
  }

  writeStdout(`==> ${logFilePath} <==`);
  await followFile(logFilePath);
  return EXIT_SUCCESS;
}

function findFallbackLog(configPath: string, name: string): string | null {
  const logsDir = path.join(path.dirname(configPath), "logs");
  let entries: string[];
  try {
    entries = fs.readdirSync(logsDir);
  } catch {
    return null;
  }
  const prefix = `bot-${name}-`;
  const matches = entries
    .filter((entry) => entry.startsWith(prefix) && entry.endsWith(".log"))
    .sort();
  const last = matches[matches.length - 1];
  return last ? path.join(logsDir, last) : null;
}

/** Print the tail of a file and follow appends until Ctrl+C. */
async function followFile(filePath: string): Promise<void> {
  const initial = await fsPromises.readFile(filePath, "utf-8").catch(() => "");
  const lines = initial.split("\n");
  const tail = lines.slice(Math.max(0, lines.length - LOG_TAIL_INITIAL_LINES));
  writeStdout(tail.join("\n"));

  let offset = Buffer.byteLength(initial, "utf-8");
  await new Promise<void>((resolve) => {
    const timer = setInterval(() => {
      void (async () => {
        try {
          const stats = await fsPromises.stat(filePath);
          if (stats.size < offset) {
            offset = 0; // The file was rotated; start over.
          }
          if (stats.size > offset) {
            const handle = await fsPromises.open(filePath, "r");
            try {
              const buffer = Buffer.alloc(stats.size - offset);
              const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
              offset += bytesRead;
              process.stdout.write(buffer.subarray(0, bytesRead).toString("utf-8"));
            } finally {
              await handle.close();
            }
          }
        } catch {
          // The file may rotate between stat and open; retry on next tick.
        }
      })();
    }, LOG_TAIL_POLL_MS);

    const stopFollow = (): void => {
      clearInterval(timer);
      writeStdout("");
      resolve();
    };
    process.once("SIGINT", stopFollow);
    process.once("SIGTERM", stopFollow);
  });
}

async function stopOrphanChildren(state: Awaited<ReturnType<typeof readSupervisorState>>): Promise<void> {
  if (!state) {
    return;
  }
  for (const bot of state.bots) {
    if (bot.pid > 0 && isProcessAlive(bot.pid)) {
      await stopProcessTree(bot.pid);
    }
  }
}
