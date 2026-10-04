import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import { isSupportedLocale, type Locale } from "../i18n/index.js";

export const BOTS_CONFIG_FILENAME = "bots.yaml";
export const BOTS_CONFIG_ENV_VAR = "OPENCODE_TELEGRAM_BOTS_CONFIG";

const BOT_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;
const POSITIVE_INTEGER_PATTERN = /^[1-9][0-9]*$/;
const DEFAULT_MODEL_PROVIDER = "opencode";
const DEFAULT_MODEL_ID = "big-pickle";

export interface BotDefinition {
  name: string;
  token: string;
  allowedUserId: string;
  locale?: Locale;
}

export interface OpenCodeSectionConfig {
  serverVersion: "v1" | "v2";
  apiUrl?: string;
  serverUsername?: string;
  serverPassword?: string;
}

export interface ModelSectionConfig {
  provider: string;
  id: string;
}

export interface BotsConfig {
  configPath: string;
  configDir: string;
  openCode: OpenCodeSectionConfig;
  model: ModelSectionConfig;
  bots: BotDefinition[];
}

export class BotsConfigError extends Error {
  readonly errors: string[];

  constructor(errors: string[]) {
    super(errors.map((error) => `  - ${error}`).join("\n"));
    this.name = "BotsConfigError";
    this.errors = errors;
  }
}

/** Resolve the bots.yaml path: env override, otherwise <cwd>/bots.yaml. */
export function resolveBotsConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  cwd: string = process.cwd(),
): string {
  const override = env[BOTS_CONFIG_ENV_VAR];
  if (override && override.trim().length > 0) {
    return path.resolve(override);
  }
  return path.join(cwd, BOTS_CONFIG_FILENAME);
}

/** Supervisor state lives next to the config: <configDir>/run/bots-supervisor.json. */
export function getBotsStateFilePath(configPath: string): string {
  return path.join(path.dirname(configPath), "run", "bots-supervisor.json");
}

/** Each bot gets an isolated home: <configDir>/bots/<name>. */
export function getBotHomePath(configPath: string, botName: string): string {
  return path.join(path.dirname(configPath), "bots", botName);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function validateOpenCodeSection(
  raw: unknown,
  openCode: OpenCodeSectionConfig,
  errors: string[],
): void {
  if (raw === undefined) {
    return;
  }
  if (!isRecord(raw)) {
    errors.push("openCode must be a mapping");
    return;
  }

  const version = raw.serverVersion;
  if (version !== undefined) {
    if (version !== "v1" && version !== "v2") {
      errors.push(`openCode.serverVersion must be "v1" or "v2" (got ${JSON.stringify(version)})`);
    } else {
      openCode.serverVersion = version;
    }
  }

  const apiUrl = raw.apiUrl;
  if (apiUrl !== undefined) {
    if (typeof apiUrl !== "string" || !isHttpUrl(apiUrl)) {
      errors.push("openCode.apiUrl must be a valid http(s) URL");
    } else {
      openCode.apiUrl = apiUrl;
    }
  }

  const username = raw.serverUsername;
  if (username !== undefined) {
    if (typeof username !== "string" || username.length === 0) {
      errors.push("openCode.serverUsername must be a non-empty string");
    } else {
      openCode.serverUsername = username;
    }
  }

  const password = raw.serverPassword;
  if (password !== undefined) {
    if (typeof password !== "string") {
      errors.push("openCode.serverPassword must be a string");
    } else {
      openCode.serverPassword = password;
    }
  }
}

function validateModelSection(raw: unknown, model: ModelSectionConfig, errors: string[]): void {
  if (raw === undefined) {
    return;
  }
  if (!isRecord(raw)) {
    errors.push("model must be a mapping");
    return;
  }

  const provider = raw.provider;
  if (provider !== undefined) {
    if (typeof provider !== "string" || provider.trim().length === 0) {
      errors.push("model.provider must be a non-empty string");
    } else {
      model.provider = provider;
    }
  }

  const id = raw.id;
  if (id !== undefined) {
    if (typeof id !== "string" || id.trim().length === 0) {
      errors.push("model.id must be a non-empty string");
    } else {
      model.id = id;
    }
  }
}

function validateBot(raw: unknown, index: number, seenNames: Set<string>, errors: string[]): void {
  const label = `bots[${index}]`;
  if (!isRecord(raw)) {
    errors.push(`${label} must be a mapping`);
    return;
  }

  const name = raw.name;
  if (typeof name !== "string" || !BOT_NAME_PATTERN.test(name)) {
    errors.push(
      `${label}.name must be filesystem-safe (letters, digits, "-", "_", max 64 chars)`,
    );
  } else if (seenNames.has(name.toLowerCase())) {
    errors.push(`${label}.name "${name}" is duplicated (names are case-insensitive)`);
  } else {
    seenNames.add(name.toLowerCase());
  }

  const token = raw.token;
  if (typeof token !== "string" || token.trim().length === 0) {
    errors.push(`${label}.token must be a non-empty string (from @BotFather)`);
  }

  const allowedUserId = raw.allowedUserId;
  const normalizedUserId =
    typeof allowedUserId === "number" ? String(allowedUserId) : allowedUserId;
  if (
    typeof normalizedUserId !== "string" ||
    !POSITIVE_INTEGER_PATTERN.test(normalizedUserId)
  ) {
    errors.push(`${label}.allowedUserId must be a positive integer (your Telegram user ID)`);
  }

  const locale = raw.locale;
  if (locale !== undefined && (typeof locale !== "string" || !isSupportedLocale(locale))) {
    errors.push(`${label}.locale "${String(locale)}" is not a supported locale`);
  }
}

function buildBot(raw: Record<string, unknown>): BotDefinition {
  const bot: BotDefinition = {
    name: String(raw.name),
    token: String(raw.token),
    allowedUserId: String(raw.allowedUserId),
  };
  if (typeof raw.locale === "string" && isSupportedLocale(raw.locale)) {
    bot.locale = raw.locale;
  }
  return bot;
}

/**
 * Read and validate bots.yaml. Throws BotsConfigError with every problem found
 * so the operator fixes the file once instead of iterating.
 */
export function loadBotsConfig(configPath: string): BotsConfig {
  let content: string;
  try {
    content = fs.readFileSync(configPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new BotsConfigError([
        `Config file not found: ${configPath}`,
        `Copy the template and edit it: cp bots.example.yaml ${BOTS_CONFIG_FILENAME}`,
      ]);
    }
    throw new BotsConfigError([`Cannot read ${configPath}: ${String(error)}`]);
  }

  let raw: unknown;
  try {
    raw = parseYaml(content);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BotsConfigError([`Invalid YAML in ${configPath}: ${message}`]);
  }

  if (!isRecord(raw)) {
    throw new BotsConfigError([`${configPath} must contain a YAML mapping`]);
  }

  const errors: string[] = [];

  const openCode: OpenCodeSectionConfig = { serverVersion: "v1" };
  validateOpenCodeSection(raw.openCode, openCode, errors);

  const model: ModelSectionConfig = {
    provider: DEFAULT_MODEL_PROVIDER,
    id: DEFAULT_MODEL_ID,
  };
  validateModelSection(raw.model, model, errors);

  const botsRaw = raw.bots;
  const bots: BotDefinition[] = [];
  if (!Array.isArray(botsRaw) || botsRaw.length === 0) {
    errors.push("bots must be a non-empty list of bot definitions");
  } else {
    const seenNames = new Set<string>();
    botsRaw.forEach((entry, index) => {
      const errorsBefore = errors.length;
      validateBot(entry, index, seenNames, errors);
      if (isRecord(entry) && errors.length === errorsBefore) {
        bots.push(buildBot(entry));
      }
    });
  }

  if (errors.length > 0) {
    throw new BotsConfigError([`Invalid ${configPath}:`, ...errors]);
  }

  return {
    configPath,
    configDir: path.dirname(configPath),
    openCode,
    model,
    bots,
  };
}
