import { RunnerError, errorMessage } from "../core/errors.js";
import type {
  JsonValue,
  OpenAICompatibleRunnerConfig,
  RunInput,
  Runner,
  RunnerInfo,
  RunnerResult,
  ToolCall,
  Usage,
} from "../types/index.js";

export const DEFAULT_API_KEY_ENV = "MEMIMPACT_API_KEY";
export const DEFAULT_OPENAI_TIMEOUT_MS = 120_000;

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLocalEndpoint(baseUrl: string): boolean {
  try {
    return LOCAL_HOSTS.has(new URL(baseUrl).hostname.toLowerCase());
  } catch {
    return false;
  }
}

/** Origin + path only; never includes credentials or query strings. */
export function safeEndpoint(baseUrl: string): string {
  const url = new URL(baseUrl);
  return `${url.protocol}//${url.host}${url.pathname.replace(/\/+$/, "")}`;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

function parseToolCalls(raw: unknown): ToolCall[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const calls: ToolCall[] = [];
  for (const item of raw) {
    if (!isObj(item)) continue;
    const fn = isObj(item["function"]) ? item["function"] : item;
    const name = typeof fn["name"] === "string" ? fn["name"] : undefined;
    if (!name) continue;
    const call: ToolCall = { name };
    const args = fn["arguments"];
    if (typeof args === "string") {
      try {
        call.arguments = JSON.parse(args) as JsonValue;
      } catch {
        call.arguments = args;
      }
    } else if (args !== undefined) {
      call.arguments = args as JsonValue;
    }
    calls.push(call);
  }
  return calls;
}

function parseUsage(raw: unknown): Usage | undefined {
  if (!isObj(raw)) return undefined;
  const usage: Usage = {};
  if (typeof raw["prompt_tokens"] === "number") usage.inputTokens = raw["prompt_tokens"];
  if (typeof raw["completion_tokens"] === "number") usage.outputTokens = raw["completion_tokens"];
  if (typeof raw["total_tokens"] === "number") usage.totalTokens = raw["total_tokens"];
  return Object.keys(usage).length > 0 ? usage : undefined;
}

/**
 * Calls any endpoint that implements the OpenAI Chat Completions API
 * (`POST {baseUrl}/chat/completions`). The API key is read from an
 * environment variable at run time and is never stored.
 */
export class OpenAICompatibleRunner implements Runner {
  private readonly apiKey: string | undefined;

  constructor(
    private readonly config: OpenAICompatibleRunnerConfig,
    env: NodeJS.ProcessEnv = process.env,
  ) {
    const envName = config.apiKeyEnv ?? DEFAULT_API_KEY_ENV;
    const value = env[envName];
    if (config.apiKeyEnv && !value) {
      throw new RunnerError(`Environment variable ${config.apiKeyEnv} is not set`, [
        `runner.apiKeyEnv points to ${config.apiKeyEnv}. Export your own API key in that variable before running.`,
        "For local servers that need no key (e.g. Ollama), remove runner.apiKeyEnv.",
      ]);
    }
    this.apiKey = value || undefined;
  }

  info(): RunnerInfo {
    const info: RunnerInfo = {
      type: "openai-compatible",
      model: this.config.model,
      endpoint: safeEndpoint(this.config.baseUrl),
      external: !isLocalEndpoint(this.config.baseUrl),
      deterministic: false,
      temperature: this.config.temperature ?? 0,
    };
    if (this.config.seed !== undefined) info.seed = this.config.seed;
    return info;
  }

  async run(input: RunInput): Promise<RunnerResult> {
    const url = `${this.config.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    const messages: Obj[] = [];
    if (input.prompt.system) messages.push({ role: "system", content: input.prompt.system });
    messages.push({ role: "user", content: input.prompt.user });
    const body: Obj = {
      model: this.config.model,
      messages,
      temperature: this.config.temperature ?? 0,
    };
    if (this.config.seed !== undefined) body["seed"] = this.config.seed;
    if (this.config.maxTokens !== undefined) body["max_tokens"] = this.config.maxTokens;
    if (this.config.responseFormat === "json") body["response_format"] = { type: "json_object" };
    if (this.config.tools) body["tools"] = this.config.tools;

    const headers: Record<string, string> = { "content-type": "application/json", ...(this.config.headers ?? {}) };
    if (this.apiKey) headers["authorization"] = `Bearer ${this.apiKey}`;

    const timeoutMs = this.config.timeoutMs ?? DEFAULT_OPENAI_TIMEOUT_MS;
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      const name = (error as Error).name;
      if (name === "TimeoutError" || name === "AbortError") {
        throw new RunnerError(`Request to ${safeEndpoint(this.config.baseUrl)} timed out after ${timeoutMs}ms`);
      }
      throw new RunnerError(`Request to ${safeEndpoint(this.config.baseUrl)} failed: ${errorMessage(error)}`);
    }
    const text = await response.text();
    if (!response.ok) {
      throw new RunnerError(`Provider returned HTTP ${response.status} ${response.statusText}`.trim(), [text.slice(0, 500)]);
    }
    let data: unknown;
    try {
      data = JSON.parse(text);
    } catch {
      throw new RunnerError("Provider returned a non-JSON response", [text.slice(0, 200)]);
    }
    if (!isObj(data) || !Array.isArray(data["choices"]) || !isObj(data["choices"][0])) {
      throw new RunnerError("Provider response has no choices[0]");
    }
    const choice = data["choices"][0];
    const message = isObj(choice["message"]) ? choice["message"] : {};
    const content = message["content"];
    const result: RunnerResult = { output: typeof content === "string" ? content : "" };
    const toolCalls = parseToolCalls(message["tool_calls"]);
    if (toolCalls) result.toolCalls = toolCalls;
    const usage = parseUsage(data["usage"]);
    if (usage) result.usage = usage;
    if (typeof data["model"] === "string") result.model = data["model"];
    if (typeof choice["finish_reason"] === "string") result.finishReason = choice["finish_reason"];
    if (typeof data["system_fingerprint"] === "string") result.metadata = { systemFingerprint: data["system_fingerprint"] };
    return result;
  }
}
