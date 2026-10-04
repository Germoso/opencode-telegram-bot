import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BotsConfig } from "../../src/multi/bots-config.js";
import {
  buildBotChildEnv,
  clearSupervisorState,
  getRestartDelayMs,
  isProcessAlive,
  readSupervisorState,
  shouldResetRestartCounter,
  stopProcessTree,
  waitForProcessExit,
  writeSupervisorState,
  type SupervisorState,
} from "../../src/multi/supervisor.js";

let tempDir: string;

function makeConfig(): BotsConfig {
  return {
    configPath: path.join(tempDir, "bots.yaml"),
    configDir: tempDir,
    openCode: { serverVersion: "v2", apiUrl: "http://127.0.0.1:49374" },
    model: { provider: "anthropic", id: "claude-sonnet" },
    bots: [],
  };
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "otb-supervisor-"));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("buildBotChildEnv", () => {
  it("injects per-bot home, credentials and shared server settings", () => {
    const config = makeConfig();
    const env = buildBotChildEnv(process.env, config, {
      name: "main",
      token: "123:abc",
      allowedUserId: "111111111",
      locale: "es",
    });

    expect(env.OPENCODE_TELEGRAM_HOME).toBe(path.join(tempDir, "bots", "main"));
    expect(env.TELEGRAM_BOT_TOKEN).toBe("123:abc");
    expect(env.TELEGRAM_ALLOWED_USER_ID).toBe("111111111");
    expect(env.BOT_LOCALE).toBe("es");
    expect(env.OPENCODE_SERVER_VERSION).toBe("v2");
    expect(env.OPENCODE_API_URL).toBe("http://127.0.0.1:49374");
    expect(env.OPENCODE_MODEL_PROVIDER).toBe("anthropic");
    expect(env.OPENCODE_MODEL_ID).toBe("claude-sonnet");
    // The supervisor owns restart policy, never the child.
    expect(env.OPENCODE_AUTO_RESTART_ENABLED).toBe("false");
  });

  it("strips stale values inherited from the supervisor shell", () => {
    const baseEnv: NodeJS.ProcessEnv = {
      OPENCODE_API_URL: "http://stale:1",
      OPENCODE_SERVER_PASSWORD: "stale-password",
      BOT_LOCALE: "de",
      OPENCODE_AUTO_RESTART_ENABLED: "true",
      UNRELATED: "keep-me",
    };
    const config = makeConfig();
    config.openCode = { serverVersion: "v1" };

    const env = buildBotChildEnv(baseEnv, config, {
      name: "dev",
      token: "2:b",
      allowedUserId: "222",
    });

    expect(env.OPENCODE_API_URL).toBeUndefined();
    expect(env.OPENCODE_SERVER_PASSWORD).toBeUndefined();
    expect(env.BOT_LOCALE).toBeUndefined();
    expect(env.OPENCODE_AUTO_RESTART_ENABLED).toBe("false");
    expect(env.UNRELATED).toBe("keep-me");
    expect(env.OPENCODE_SERVER_VERSION).toBe("v1");
  });
});

describe("restart policy helpers", () => {
  it("backs off 1s, 3s, 10s then gives up", () => {
    expect(getRestartDelayMs(0)).toBe(1000);
    expect(getRestartDelayMs(1)).toBe(3000);
    expect(getRestartDelayMs(2)).toBe(10000);
    expect(getRestartDelayMs(3)).toBeNull();
  });

  it("resets the counter only after a stable minute of uptime", () => {
    expect(shouldResetRestartCounter(59_000)).toBe(false);
    expect(shouldResetRestartCounter(60_000)).toBe(true);
  });
});

describe("supervisor state file", () => {
  it("round-trips state atomically", async () => {
    const statePath = path.join(tempDir, "run", "bots-supervisor.json");
    const state: SupervisorState = {
      version: 1,
      supervisorPid: process.pid,
      startedAt: new Date().toISOString(),
      configPath: path.join(tempDir, "bots.yaml"),
      bots: [
        {
          name: "main",
          pid: 4242,
          startedAt: new Date().toISOString(),
          consoleLogFilePath: "/tmp/main.log",
          restarts: 1,
          status: "running",
        },
      ],
    };

    await writeSupervisorState(statePath, state);
    const loaded = await readSupervisorState(statePath);
    expect(loaded).toEqual(state);

    // No leftover temp files after the atomic rename.
    const entries = fs.readdirSync(path.dirname(statePath));
    expect(entries).toEqual(["bots-supervisor.json"]);

    await clearSupervisorState(statePath);
    expect(await readSupervisorState(statePath)).toBeNull();
    // Clearing again is a no-op.
    await clearSupervisorState(statePath);
  });

  it("returns null for corrupt or incompatible state", async () => {
    const statePath = path.join(tempDir, "run", "bots-supervisor.json");
    fs.mkdirSync(path.dirname(statePath), { recursive: true });

    fs.writeFileSync(statePath, "not json", "utf-8");
    expect(await readSupervisorState(statePath)).toBeNull();

    fs.writeFileSync(statePath, JSON.stringify({ version: 99 }), "utf-8");
    expect(await readSupervisorState(statePath)).toBeNull();

    fs.writeFileSync(
      statePath,
      JSON.stringify({ version: 1, supervisorPid: 0, startedAt: 1, configPath: 2 }),
      "utf-8",
    );
    expect(await readSupervisorState(statePath)).toBeNull();

    expect(await readSupervisorState(path.join(tempDir, "absent.json"))).toBeNull();
  });
});

describe("process helpers", () => {
  it("detects this live process and rejects bogus pids", () => {
    expect(isProcessAlive(process.pid)).toBe(true);
    expect(isProcessAlive(-1)).toBe(false);
    expect(isProcessAlive(0)).toBe(false);
  });

  it("waitForProcessExit returns true for an already-dead pid", async () => {
    expect(await waitForProcessExit(0, 100)).toBe(true);
  });

  it("stopProcessTree does not throw for an already-dead pid", async () => {
    await expect(stopProcessTree(0)).resolves.toBeUndefined();
  });
});
