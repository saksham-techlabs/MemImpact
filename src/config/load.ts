import { readFile } from "node:fs/promises";
import path from "node:path";
import { ConfigError } from "../core/errors.js";
import { sha256 } from "../core/hash.js";
import type { LoadedConfig } from "../types/index.js";
import { formatIssues, validateConfig } from "./validate.js";

export const DEFAULT_CONFIG_FILE = "memimpact.config.json";

async function readJson(file: string, label: string): Promise<{ text: string; data: unknown }> {
  let text: string;
  try {
    text = await readFile(file, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") {
      throw new ConfigError(`${label} not found: ${file}`, label === "Config file" ? ["Run `memimpact init` to create one, or pass --config <path>."] : []);
    }
    throw new ConfigError(`Could not read ${label.toLowerCase()} ${file}: ${(error as Error).message}`);
  }
  try {
    return { text, data: JSON.parse(text.replace(/^\uFEFF/, "")) as unknown };
  } catch (error) {
    throw new ConfigError(`${label} is not valid JSON: ${file}`, [(error as Error).message]);
  }
}

export async function loadConfig(configPath: string, cwd = process.cwd()): Promise<LoadedConfig> {
  const resolved = path.resolve(cwd, configPath);
  const baseDir = path.dirname(resolved);
  const { text, data } = await readJson(resolved, "Config file");

  let external: { file: string; data: unknown } | undefined;
  let hashInput = text;
  if (data !== null && typeof data === "object" && !Array.isArray(data)) {
    const memoriesFile = (data as Record<string, unknown>)["memoriesFile"];
    if (typeof memoriesFile === "string" && memoriesFile.trim() && (data as Record<string, unknown>)["memories"] === undefined) {
      const memPath = path.resolve(baseDir, memoriesFile);
      const mem = await readJson(memPath, "Memories file");
      external = { file: memoriesFile, data: mem.data };
      hashInput += "\n" + mem.text;
    }
  }

  const result = validateConfig(data, external);
  if (!result.config) {
    throw new ConfigError(`Invalid config: ${resolved}`, formatIssues(result.issues));
  }
  return {
    config: result.config,
    configPath: resolved,
    baseDir,
    configHash: sha256(hashInput),
    warnings: result.warnings,
  };
}
