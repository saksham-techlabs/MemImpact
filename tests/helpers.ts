import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after } from "node:test";
import { runCli, type CliIO } from "../src/cli/app.js";
import { loadConfig } from "../src/config/load.js";
import type { LoadedConfig } from "../src/types/index.js";

export const CLI_PATH = path.resolve(import.meta.dirname, "..", "src", "cli", "main.js");
export const REPO_ROOT = path.resolve(import.meta.dirname, "..", "..");

const created: string[] = [];
after(() => {
  for (const dir of created) rmSync(dir, { recursive: true, force: true });
});

/** Creates a real temporary directory (with a space in its name to exercise path handling). */
export function tempDir(prefix = "memimpact test "): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/**
 * Builds an obviously fake credential at runtime so that no key-shaped literal
 * exists in the source tree (keeps secret scanners quiet).
 */
export function fakeKey(prefix: string, rest: string): string {
  return `${prefix}${rest}`;
}

export function writeJson(file: string, value: unknown): string {
  writeFileSync(file, JSON.stringify(value, null, 2), "utf8");
  return file;
}

export function fixtureConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    name: "test-experiment",
    task: "Design the database architecture.",
    memories: [
      { id: "db", content: "User prefers PostgreSQL over MongoDB." },
      { id: "hosting", content: "Project is deployed on Vercel." },
      { id: "tz", content: "User works in the IST timezone." },
    ],
    variants: [
      { id: "remove-db", type: "remove", memoryId: "db" },
      { id: "remove-tz", type: "remove", memoryId: "tz" },
    ],
    runner: {
      type: "fixture",
      rules: [
        { when: { contextIncludes: ["prefers PostgreSQL"] }, output: { database: "PostgreSQL", hosting: "Vercel" } },
        { output: { database: "MongoDB", hosting: "Vercel" } },
      ],
    },
    repetitions: 2,
    ...overrides,
  };
}

export async function loadFrom(config: unknown, dir = tempDir()): Promise<LoadedConfig> {
  const file = writeJson(path.join(dir, "memimpact.config.json"), config);
  return loadConfig(file);
}

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs the compiled CLI in a real child process. */
export function runCliProcess(args: string[], options: { cwd: string; env?: NodeJS.ProcessEnv; input?: string }): CliResult {
  const result = spawnSync(process.execPath, [CLI_PATH, ...args], {
    cwd: options.cwd,
    env: { ...process.env, NO_COLOR: "1", ...(options.env ?? {}) },
    encoding: "utf8",
    input: options.input,
    timeout: 60_000,
  });
  return { code: result.status ?? -1, stdout: result.stdout, stderr: result.stderr };
}

/** Runs the CLI in-process, capturing output. */
export async function runCliInProcess(args: string[], cwd: string, env: NodeJS.ProcessEnv = {}): Promise<CliResult> {
  let stdout = "";
  let stderr = "";
  const io: CliIO = {
    stdout: (t) => {
      stdout += `${t}\n`;
    },
    stderr: (t) => {
      stderr += `${t}\n`;
    },
    cwd,
    env: { ...process.env, ...env },
    color: false,
  };
  const code = await runCli(args, io);
  return { code, stdout, stderr };
}
