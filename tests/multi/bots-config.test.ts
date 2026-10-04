import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BotsConfigError,
  getBotHomePath,
  getBotsStateFilePath,
  loadBotsConfig,
  resolveBotsConfigPath,
} from "../../src/multi/bots-config.js";

let tempDir: string;
let configPath: string;

function writeConfig(content: string): string {
  fs.writeFileSync(configPath, content, "utf-8");
  return configPath;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "otb-bots-config-"));
  configPath = path.join(tempDir, "bots.yaml");
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("resolveBotsConfigPath", () => {
  it("uses cwd/bots.yaml by default", () => {
    expect(resolveBotsConfigPath({}, "/work")).toBe(path.join("/work", "bots.yaml"));
  });

  it("honors the OPENCODE_TELEGRAM_BOTS_CONFIG override", () => {
    const result = resolveBotsConfigPath(
      { OPENCODE_TELEGRAM_BOTS_CONFIG: "/other/bots.yaml" },
      "/work",
    );
    expect(result).toBe(path.resolve("/other/bots.yaml"));
  });

  it("ignores a blank override", () => {
    expect(resolveBotsConfigPath({ OPENCODE_TELEGRAM_BOTS_CONFIG: "  " }, "/work")).toBe(
      path.join("/work", "bots.yaml"),
    );
  });
});

describe("state and home paths", () => {
  it("derives state and home paths from the config directory", () => {
    expect(getBotsStateFilePath("/work/bots.yaml")).toBe(
      path.join("/work", "run", "bots-supervisor.json"),
    );
    expect(getBotHomePath("/work/bots.yaml", "main")).toBe(path.join("/work", "bots", "main"));
  });
});

describe("loadBotsConfig", () => {
  it("throws a helpful error when the file is missing", () => {
    expect(() => loadBotsConfig(configPath)).toThrow(BotsConfigError);
    expect(() => loadBotsConfig(configPath)).toThrow(/cp bots\.example\.yaml/);
  });

  it("loads a minimal valid config with defaults", () => {
    writeConfig(`
bots:
  - name: main
    token: "123:abc"
    allowedUserId: 111111111
`);
    const config = loadBotsConfig(configPath);
    expect(config.bots).toHaveLength(1);
    expect(config.bots[0]).toEqual({
      name: "main",
      token: "123:abc",
      allowedUserId: "111111111",
    });
    expect(config.openCode.serverVersion).toBe("v1");
    expect(config.openCode.apiUrl).toBeUndefined();
    expect(config.model).toEqual({ provider: "opencode", id: "big-pickle" });
    expect(config.configDir).toBe(tempDir);
  });

  it("loads the full config shape", () => {
    writeConfig(`
openCode:
  apiUrl: http://127.0.0.1:49374
  serverVersion: v2
  serverUsername: opencode
  serverPassword: secret
model:
  provider: anthropic
  id: claude-sonnet
bots:
  - name: main
    token: "1:a"
    allowedUserId: 111
    locale: es
  - name: dev
    token: "2:b"
    allowedUserId: 222
`);
    const config = loadBotsConfig(configPath);
    expect(config.openCode).toEqual({
      serverVersion: "v2",
      apiUrl: "http://127.0.0.1:49374",
      serverUsername: "opencode",
      serverPassword: "secret",
    });
    expect(config.model).toEqual({ provider: "anthropic", id: "claude-sonnet" });
    expect(config.bots).toHaveLength(2);
    expect(config.bots[0]?.locale).toBe("es");
    expect(config.bots[1]?.locale).toBeUndefined();
  });

  it("rejects invalid YAML", () => {
    writeConfig("bots: [");
    expect(() => loadBotsConfig(configPath)).toThrow(/Invalid YAML/);
  });

  it("rejects a non-mapping document", () => {
    writeConfig("- just\n- a list\n");
    expect(() => loadBotsConfig(configPath)).toThrow(/must contain a YAML mapping/);
  });

  it("rejects an empty or missing bots list", () => {
    writeConfig("bots: []");
    expect(() => loadBotsConfig(configPath)).toThrow(/non-empty list/);
    writeConfig("model:\n  provider: x\n");
    expect(() => loadBotsConfig(configPath)).toThrow(/non-empty list/);
  });

  it("collects every error in one pass", () => {
    writeConfig(`
openCode:
  serverVersion: v9
  apiUrl: not-a-url
bots:
  - name: "bad name!"
    token: ""
    allowedUserId: -5
  - name: main
    token: "1:a"
    allowedUserId: 111
    locale: xx
  - name: MAIN
    token: "2:b"
    allowedUserId: 222
`);
    try {
      loadBotsConfig(configPath);
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(BotsConfigError);
      const errors = (error as BotsConfigError).errors.join("\n");
      expect(errors).toMatch(/serverVersion must be "v1" or "v2"/);
      expect(errors).toMatch(/apiUrl must be a valid http/);
      expect(errors).toMatch(/filesystem-safe/);
      expect(errors).toMatch(/token must be a non-empty string/);
      expect(errors).toMatch(/allowedUserId must be a positive integer/);
      expect(errors).toMatch(/locale "xx" is not a supported locale/);
      // case-insensitive duplicate: "MAIN" after "main"
      expect(errors).toMatch(/"MAIN" is duplicated/);
    }
  });

  it("rejects a duplicated bot name case-insensitively", () => {
    writeConfig(`
bots:
  - name: main
    token: "1:a"
    allowedUserId: 111
  - name: MAIN
    token: "2:b"
    allowedUserId: 222
`);
    expect(() => loadBotsConfig(configPath)).toThrow(/duplicated/);
  });

  it("rejects invalid model and openCode sections", () => {
    writeConfig(`
openCode: "not a mapping"
model:
  provider: ""
bots:
  - name: main
    token: "1:a"
    allowedUserId: 111
`);
    try {
      loadBotsConfig(configPath);
      expect.unreachable("should have thrown");
    } catch (error) {
      const errors = (error as BotsConfigError).errors.join("\n");
      expect(errors).toMatch(/openCode must be a mapping/);
      expect(errors).toMatch(/model\.provider must be a non-empty string/);
    }
  });
});
