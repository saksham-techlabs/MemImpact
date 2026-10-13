import type { LoadedConfig, Runner } from "../types/index.js";
import { CommandRunner } from "./command.js";
import { FixtureRunner } from "./fixture.js";
import { DEFAULT_API_KEY_ENV, OpenAICompatibleRunner } from "./openai.js";

export { CommandRunner } from "./command.js";
export { FixtureRunner } from "./fixture.js";
export { OpenAICompatibleRunner, isLocalEndpoint } from "./openai.js";
export { renderPrompt } from "./prompt.js";

export function createRunner(loaded: LoadedConfig, env: NodeJS.ProcessEnv = process.env): Runner {
  const runner = loaded.config.runner;
  switch (runner.type) {
    case "fixture":
      return new FixtureRunner(runner);
    case "openai-compatible":
      return new OpenAICompatibleRunner(runner, env);
    case "command":
      return new CommandRunner(runner, loaded.baseDir);
  }
}

/** Names of environment variables whose values must be redacted for this config. */
export function secretEnvNames(loaded: LoadedConfig): string[] {
  const runner = loaded.config.runner;
  if (runner.type === "openai-compatible") return [runner.apiKeyEnv ?? DEFAULT_API_KEY_ENV];
  return [DEFAULT_API_KEY_ENV];
}
