import fs from "node:fs";
import fsPromises from "node:fs/promises";
import path from "node:path";
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import type { BotDefinition, BotsConfig } from "./bots-config.js";
import { getBotHomePath } from "./bots-config.js";

const execFileAsync = promisify(execFile);

const SUPERVISOR_STATE_VERSION = 1;
const RESTART_DELAYS_MS = [1000, 3000, 10000] as const;
const RESTART_RESET_UPTIME_MS = 60_000;
const STOP_TIMEOUT_MS = 5000;
const PROCESS_EXIT_POLL_MS = 100;

export interface SupervisedBotState {
  name: string;
  pid: number;
  startedAt: string;
  consoleLogFilePath: string;
  restarts: number;
  status: "running" | "restarting" | "failed" | "stopped";
}

export interface SupervisorState {
  version: number;
  supervisorPid: number;
  startedAt: string;
  configPath: string;
  bots: SupervisedBotState[];
}

interface RunningBot {
  definition: BotDefinition;
  child: ChildProcess | null;
  pid: number | null;
  startedAt: Date;
  restarts: number;
  status: SupervisedBotState["status"];
  restartTimer: NodeJS.Timeout | null;
  consoleLogFilePath: string;
}

export function isProcessAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) {
    return false;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/**
 * Build the environment for one bot child. The yaml file is the single
 * source of truth for OpenCode/model/telegram settings: variables absent
 * from the config are removed so stale values from the supervisor's own
 * shell cannot leak into a child.
 */
export function buildBotChildEnv(
  baseEnv: NodeJS.ProcessEnv,
  config: BotsConfig,
  bot: BotDefinition,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...baseEnv };

  delete env.OPENCODE_API_URL;
  delete env.OPENCODE_SERVER_USERNAME;
  delete env.OPENCODE_SERVER_PASSWORD;
  delete env.BOT_LOCALE;
  delete env.OPENCODE_AUTO_RESTART_ENABLED;

  env.OPENCODE_TELEGRAM_HOME = getBotHomePath(config.configPath, bot.name);
  env.TELEGRAM_BOT_TOKEN = bot.token;
  env.TELEGRAM_ALLOWED_USER_ID = bot.allowedUserId;
  env.OPENCODE_SERVER_VERSION = config.openCode.serverVersion;
  env.OPENCODE_MODEL_PROVIDER = config.model.provider;
  env.OPENCODE_MODEL_ID = config.model.id;
  // The supervisor owns restart policy; children must never fight over the
  // shared OpenCode server port.
  env.OPENCODE_AUTO_RESTART_ENABLED = "false";

  if (config.openCode.apiUrl) {
    env.OPENCODE_API_URL = config.openCode.apiUrl;
  }
  if (config.openCode.serverUsername) {
    env.OPENCODE_SERVER_USERNAME = config.openCode.serverUsername;
  }
  if (config.openCode.serverPassword) {
    env.OPENCODE_SERVER_PASSWORD = config.openCode.serverPassword;
  }
  if (bot.locale) {
    env.BOT_LOCALE = bot.locale;
  }

  return env;
}

/** Restart backoff: 1s, 3s, 10s; null once the attempts are exhausted. */
export function getRestartDelayMs(attempt: number): number | null {
  return RESTART_DELAYS_MS[attempt] ?? null;
}

export function shouldResetRestartCounter(uptimeMs: number): boolean {
  return uptimeMs >= RESTART_RESET_UPTIME_MS;
}

export async function readSupervisorState(
  stateFilePath: string,
): Promise<SupervisorState | null> {
  let content: string;
  try {
    content = await fsPromises.readFile(stateFilePath, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    return null;
  }

  try {
    const parsed: unknown = JSON.parse(content);
    if (!parsed || typeof parsed !== "object") {
      return null;
    }
    const candidate = parsed as Partial<SupervisorState>;
    if (
      candidate.version !== SUPERVISOR_STATE_VERSION ||
      typeof candidate.supervisorPid !== "number" ||
      !Number.isInteger(candidate.supervisorPid) ||
      candidate.supervisorPid <= 0 ||
      typeof candidate.startedAt !== "string" ||
      typeof candidate.configPath !== "string" ||
      !Array.isArray(candidate.bots)
    ) {
      return null;
    }
    return candidate as SupervisorState;
  } catch {
    return null;
  }
}

export async function writeSupervisorState(
  stateFilePath: string,
  state: SupervisorState,
): Promise<void> {
  await fsPromises.mkdir(path.dirname(stateFilePath), { recursive: true });
  const tempFilePath = `${stateFilePath}.${process.pid}.tmp`;
  await fsPromises.writeFile(tempFilePath, `${JSON.stringify(state, null, 2)}\n`, "utf-8");
  await fsPromises.rename(tempFilePath, stateFilePath);
}

export async function clearSupervisorState(stateFilePath: string): Promise<void> {
  try {
    await fsPromises.unlink(stateFilePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

/** Stop a process tree: group signal on POSIX, taskkill /T on Windows. */
export async function stopProcessTree(pid: number): Promise<void> {
  if (!Number.isInteger(pid) || pid <= 0) {
    // Guard: kill(-0)/kill(0) would signal our own process group.
    return;
  }
  if (process.platform === "win32") {
    try {
      await execFileAsync("taskkill", ["/PID", String(pid), "/T"]);
    } catch {
      // The process may already be gone; the caller polls liveness anyway.
    }
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already exited.
    }
  }
}

export async function waitForProcessExit(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!isProcessAlive(pid)) {
      return true;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, PROCESS_EXIT_POLL_MS));
  }
  return !isProcessAlive(pid);
}

export class BotSupervisor {
  private readonly bots = new Map<string, RunningBot>();
  private stopping = false;
  private stopped = false;
  private stateWriteQueue: Promise<void> = Promise.resolve();
  private stopResolvers: Array<() => void> = [];
  private exitCode = 0;

  constructor(
    private readonly config: BotsConfig,
    private readonly stateFilePath: string,
    private readonly consoleLogDir: string,
  ) {}

  async start(): Promise<void> {
    await fsPromises.mkdir(this.consoleLogDir, { recursive: true });

    const entryScript = this.resolveEntryScript();
    for (const definition of this.config.bots) {
      const entry: RunningBot = {
        definition,
        child: null,
        pid: null,
        startedAt: new Date(),
        restarts: 0,
        status: "running",
        restartTimer: null,
        consoleLogFilePath: this.createConsoleLogFilePath(definition.name),
      };
      this.bots.set(definition.name, entry);
      this.spawnBot(entry, entryScript);
    }
    await this.writeState();
  }

  waitUntilStopped(): Promise<void> {
    if (this.stopped) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this.stopResolvers.push(resolve);
    });
  }

  getExitCode(): number {
    return this.exitCode;
  }

  getBotSummaries(): Array<{ name: string; pid: number | null; logFilePath: string }> {
    return [...this.bots.values()].map((entry) => ({
      name: entry.definition.name,
      pid: entry.pid,
      logFilePath: entry.consoleLogFilePath,
    }));
  }

  async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.stopping) {
      return this.waitUntilStopped();
    }
    this.stopping = true;

    const stopOperations = [...this.bots.values()].map(async (entry) => {
      if (entry.restartTimer) {
        clearTimeout(entry.restartTimer);
        entry.restartTimer = null;
      }
      if (entry.pid !== null && isProcessAlive(entry.pid)) {
        await stopProcessTree(entry.pid);
        const exited = await waitForProcessExit(entry.pid, STOP_TIMEOUT_MS);
        if (!exited && isProcessAlive(entry.pid)) {
          try {
            if (process.platform === "win32") {
              await execFileAsync("taskkill", ["/PID", String(entry.pid), "/T", "/F"]);
            } else {
              process.kill(-entry.pid, "SIGKILL");
            }
          } catch {
            // Best effort; the liveness check below reports the truth.
          }
        }
      }
      entry.status = "stopped";
      entry.pid = null;
      entry.child = null;
    });

    await Promise.all(stopOperations);
    await this.clearState();
    this.stopped = true;

    const resolvers = this.stopResolvers;
    this.stopResolvers = [];
    for (const resolve of resolvers) {
      resolve();
    }
  }

  private resolveEntryScript(): string {
    const scriptPath = process.argv[1];
    if (!scriptPath || scriptPath.trim().length === 0) {
      throw new Error("Failed to resolve CLI entry script path.");
    }
    return path.resolve(scriptPath);
  }

  private createConsoleLogFilePath(botName: string): string {
    const timestamp = new Date()
      .toISOString()
      .slice(0, 19)
      .replace(/:/g, "-")
      .replace("T", "_");
    return path.join(this.consoleLogDir, `bot-${botName}-${timestamp}.log`);
  }

  private spawnBot(entry: RunningBot, entryScript: string): void {
    const env = buildBotChildEnv(process.env, this.config, entry.definition);
    const consoleFd = fs.openSync(entry.consoleLogFilePath, "a");

    let child: ChildProcess;
    try {
      child = spawn(process.execPath, [entryScript, "start"], {
        detached: process.platform !== "win32",
        stdio: ["ignore", consoleFd, consoleFd],
        windowsHide: true,
        env,
      });
    } finally {
      fs.closeSync(consoleFd);
    }

    entry.child = child;
    entry.startedAt = new Date();
    entry.pid = child.pid ?? null;

    child.on("exit", (code, signal) => {
      this.handleChildExit(child, entry, code, signal);
    });
    child.on("error", (error) => {
      this.log(`[${entry.definition.name}] spawn error: ${error.message}`);
      // A failed spawn emits "error" but may never emit "exit".
      this.handleChildExit(child, entry, null, null);
    });
  }

  private handleChildExit(
    child: ChildProcess,
    entry: RunningBot,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    // Guard against "error" + "exit" double-fire and stale events from a
    // previous spawn after a restart.
    if (entry.child !== child) {
      return;
    }
    entry.child = null;
    entry.pid = null;

    if (this.stopping) {
      return;
    }

    const uptimeMs = Date.now() - entry.startedAt.getTime();
    if (shouldResetRestartCounter(uptimeMs)) {
      entry.restarts = 0;
    }

    this.log(
      `[${entry.definition.name}] exited (code=${code ?? "null"}, signal=${signal ?? "null"}); ` +
        `restart attempt ${entry.restarts + 1}/${RESTART_DELAYS_MS.length}`,
    );

    const delayMs = getRestartDelayMs(entry.restarts);
    if (delayMs === null) {
      entry.status = "failed";
      this.exitCode = 1;
      this.log(
        `[${entry.definition.name}] FAILED after ${RESTART_DELAYS_MS.length} restart attempts. ` +
          `Giving up on this bot; check its console log.`,
      );
      void this.writeState();
      this.stopIfAllFailed();
      return;
    }

    entry.status = "restarting";
    entry.restarts += 1;
    void this.writeState();

    entry.restartTimer = setTimeout(() => {
      entry.restartTimer = null;
      if (this.stopping) {
        return;
      }
      const entryScript = this.resolveEntryScript();
      entry.consoleLogFilePath = this.createConsoleLogFilePath(entry.definition.name);
      this.spawnBot(entry, entryScript);
      if (entry.pid !== null) {
        entry.status = "running";
        this.log(`[${entry.definition.name}] restarted (PID=${entry.pid})`);
      } else {
        entry.status = "failed";
        this.exitCode = 1;
        this.log(`[${entry.definition.name}] restart failed to spawn.`);
      }
      void this.writeState();
      this.stopIfAllFailed();
    }, delayMs);
  }

  private stopIfAllFailed(): void {
    if (this.stopping || this.bots.size === 0) {
      return;
    }
    const allFailed = [...this.bots.values()].every((entry) => entry.status === "failed");
    if (allFailed) {
      this.log("[supervisor] All bots failed; shutting down.");
      void this.stop();
    }
  }

  private snapshotState(): SupervisorState {
    return {
      version: SUPERVISOR_STATE_VERSION,
      supervisorPid: process.pid,
      startedAt: new Date().toISOString(),
      configPath: this.config.configPath,
      bots: [...this.bots.values()].map((entry) => ({
        name: entry.definition.name,
        pid: entry.pid ?? -1,
        startedAt: entry.startedAt.toISOString(),
        consoleLogFilePath: entry.consoleLogFilePath,
        restarts: entry.restarts,
        status: entry.status,
      })),
    };
  }

  private writeState(): Promise<void> {
    this.stateWriteQueue = this.stateWriteQueue
      .then(() => writeSupervisorState(this.stateFilePath, this.snapshotState()))
      .catch((error: unknown) => {
        this.log(`[supervisor] Failed to write state file: ${String(error)}`);
      });
    return this.stateWriteQueue;
  }

  private async clearState(): Promise<void> {
    await this.stateWriteQueue.catch(() => undefined);
    try {
      await clearSupervisorState(this.stateFilePath);
    } catch (error) {
      this.log(`[supervisor] Failed to remove state file: ${String(error)}`);
    }
  }

  private log(message: string): void {
    process.stdout.write(`[supervisor] ${message}\n`);
  }
}
