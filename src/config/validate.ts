import { looksLikeSecret, isSecretEnvName, SECRET_HEADER_NAME } from "../core/redact.js";
import {
  IMPACT_LEVELS,
  RUNNER_TYPES,
  STRUCTURED_MODES,
  VARIANT_TYPES,
  type CommandRunnerConfig,
  type Expectation,
  type FixtureCondition,
  type FixtureRule,
  type FixtureRunnerConfig,
  type ImpactLevel,
  type ImpactThresholds,
  type JsonObject,
  type JsonValue,
  type MemImpactConfig,
  type Memory,
  type OpenAICompatibleRunnerConfig,
  type RunnerConfig,
  type ToolCall,
  type Variant,
} from "../types/index.js";

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult {
  config: MemImpactConfig | null;
  issues: ValidationIssue[];
  warnings: string[];
}

export const DEFAULT_THRESHOLDS: ImpactThresholds = { low: 0.05, medium: 0.2, high: 0.5 };
export const DEFAULT_ARTIFACT_DIR = ".memimpact";
export const MAX_REPETITIONS = 50;
export const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ENV_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

type Obj = Record<string, unknown>;

function isObj(value: unknown): value is Obj {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function isJsonValue(value: unknown, depth = 0): value is JsonValue {
  if (depth > 64) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((v) => isJsonValue(v, depth + 1));
  if (isObj(value)) return Object.values(value).every((v) => isJsonValue(v, depth + 1));
  return false;
}

class Ctx {
  readonly issues: ValidationIssue[] = [];
  readonly warnings: string[] = [];

  add(path: string, message: string): void {
    this.issues.push({ path: path || "(root)", message });
  }

  keys(obj: Obj, path: string, allowed: readonly string[]): void {
    for (const key of Object.keys(obj)) {
      if (!allowed.includes(key)) {
        this.add(join(path, key), `unknown property "${key}" (allowed: ${allowed.join(", ")})`);
      }
    }
  }

  string(
    obj: Obj,
    key: string,
    path: string,
    opts: { required?: boolean; nonEmpty?: boolean; pattern?: RegExp; patternHint?: string } = {},
  ): string | undefined {
    const value = obj[key];
    const p = join(path, key);
    if (value === undefined) {
      if (opts.required) this.add(p, "is required");
      return undefined;
    }
    if (typeof value !== "string") {
      this.add(p, `must be a string (got ${describe(value)})`);
      return undefined;
    }
    if ((opts.nonEmpty ?? opts.required) && value.trim().length === 0) {
      this.add(p, "must not be empty");
      return undefined;
    }
    if (opts.pattern && !opts.pattern.test(value)) {
      this.add(p, opts.patternHint ?? `must match ${opts.pattern}`);
      return undefined;
    }
    return value;
  }

  number(
    obj: Obj,
    key: string,
    path: string,
    opts: { integer?: boolean; min?: number; max?: number; exclusiveMin?: number } = {},
  ): number | undefined {
    const value = obj[key];
    const p = join(path, key);
    if (value === undefined) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value)) {
      this.add(p, `must be a number (got ${describe(value)})`);
      return undefined;
    }
    if (opts.integer && !Number.isInteger(value)) {
      this.add(p, "must be an integer");
      return undefined;
    }
    if (opts.min !== undefined && value < opts.min) {
      this.add(p, `must be >= ${opts.min}`);
      return undefined;
    }
    if (opts.exclusiveMin !== undefined && value <= opts.exclusiveMin) {
      this.add(p, `must be > ${opts.exclusiveMin}`);
      return undefined;
    }
    if (opts.max !== undefined && value > opts.max) {
      this.add(p, `must be <= ${opts.max}`);
      return undefined;
    }
    return value;
  }

  boolean(obj: Obj, key: string, path: string): boolean | undefined {
    const value = obj[key];
    if (value === undefined) return undefined;
    if (typeof value !== "boolean") {
      this.add(join(path, key), `must be a boolean (got ${describe(value)})`);
      return undefined;
    }
    return value;
  }

  enumValue<T extends string>(obj: Obj, key: string, path: string, allowed: readonly T[], required = false): T | undefined {
    const value = obj[key];
    const p = join(path, key);
    if (value === undefined) {
      if (required) this.add(p, "is required");
      return undefined;
    }
    if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
      this.add(p, `must be one of: ${allowed.join(", ")}`);
      return undefined;
    }
    return value as T;
  }

  stringArray(obj: Obj, key: string, path: string, opts: { nonEmptyItems?: boolean } = {}): string[] | undefined {
    const value = obj[key];
    const p = join(path, key);
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) {
      this.add(p, `must be an array of strings (got ${describe(value)})`);
      return undefined;
    }
    const out: string[] = [];
    value.forEach((item, i) => {
      if (typeof item !== "string") this.add(`${p}[${i}]`, "must be a string");
      else if (opts.nonEmptyItems && item.trim().length === 0) this.add(`${p}[${i}]`, "must not be empty");
      else out.push(item);
    });
    return out;
  }

  stringMap(obj: Obj, key: string, path: string): Record<string, string> | undefined {
    const value = obj[key];
    const p = join(path, key);
    if (value === undefined) return undefined;
    if (!isObj(value)) {
      this.add(p, `must be an object of string values (got ${describe(value)})`);
      return undefined;
    }
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(value)) {
      if (typeof v !== "string") this.add(join(p, k), "must be a string");
      else out[k] = v;
    }
    return out;
  }
}

function join(path: string, key: string | number): string {
  if (typeof key === "number") return `${path}[${key}]`;
  return path ? `${path}.${key}` : key;
}

function scanForSecrets(ctx: Ctx, value: unknown, path: string): void {
  if (typeof value === "string") {
    if (looksLikeSecret(value)) {
      ctx.add(path, "looks like an API key or token. Never put secrets in config files; reference an environment variable instead (e.g. runner.apiKeyEnv).");
    }
    return;
  }
  if (Array.isArray(value)) value.forEach((v, i) => scanForSecrets(ctx, v, join(path, i)));
  else if (isObj(value)) for (const [k, v] of Object.entries(value)) scanForSecrets(ctx, v, join(path, k));
}

function parseMemory(ctx: Ctx, raw: unknown, path: string): Memory | null {
  if (!isObj(raw)) {
    ctx.add(path, `must be an object with "id" and "content" (got ${describe(raw)})`);
    return null;
  }
  ctx.keys(raw, path, ["id", "content", "tags", "source"]);
  const id = ctx.string(raw, "id", path, {
    required: true,
    pattern: ID_PATTERN,
    patternHint: "must be 1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
  });
  const content = ctx.string(raw, "content", path, { required: true });
  const tags = ctx.stringArray(raw, "tags", path, { nonEmptyItems: true });
  const source = ctx.string(raw, "source", path);
  if (id === undefined || content === undefined) return null;
  const memory: Memory = { id, content };
  if (tags) memory.tags = tags;
  if (source !== undefined) memory.source = source;
  return memory;
}

export function parseMemories(ctx: Ctx, raw: unknown, path: string): Memory[] {
  if (!Array.isArray(raw)) {
    ctx.add(path, `must be an array of memories (got ${describe(raw)})`);
    return [];
  }
  const memories: Memory[] = [];
  const seen = new Set<string>();
  raw.forEach((item, i) => {
    const memory = parseMemory(ctx, item, join(path, i));
    if (!memory) return;
    if (seen.has(memory.id)) {
      ctx.add(join(join(path, i), "id"), `duplicate memory id "${memory.id}"`);
      return;
    }
    seen.add(memory.id);
    memories.push(memory);
  });
  return memories;
}

function parseExpectation(ctx: Ctx, raw: unknown, path: string): Expectation | undefined {
  if (raw === undefined) return undefined;
  if (!isObj(raw)) {
    ctx.add(path, `must be an object (got ${describe(raw)})`);
    return undefined;
  }
  ctx.keys(raw, path, ["minImpact", "maxImpact"]);
  const minImpact = ctx.enumValue<ImpactLevel>(raw, "minImpact", path, IMPACT_LEVELS);
  const maxImpact = ctx.enumValue<ImpactLevel>(raw, "maxImpact", path, IMPACT_LEVELS);
  if (minImpact === undefined && maxImpact === undefined) {
    ctx.add(path, 'must set "minImpact" and/or "maxImpact"');
    return undefined;
  }
  if (minImpact && maxImpact && IMPACT_LEVELS.indexOf(minImpact) > IMPACT_LEVELS.indexOf(maxImpact)) {
    ctx.add(path, "minImpact must not be greater than maxImpact");
  }
  const expectation: Expectation = {};
  if (minImpact) expectation.minImpact = minImpact;
  if (maxImpact) expectation.maxImpact = maxImpact;
  return expectation;
}

function parseVariant(ctx: Ctx, raw: unknown, path: string, memories: Map<string, Memory>): Variant | null {
  if (!isObj(raw)) {
    ctx.add(path, `must be an object (got ${describe(raw)})`);
    return null;
  }
  const type = ctx.enumValue(raw, "type", path, VARIANT_TYPES, true);
  const common = ["id", "type", "description", "expect"];
  const id = ctx.string(raw, "id", path, {
    required: true,
    pattern: ID_PATTERN,
    patternHint: "must be 1-64 characters: letters, digits, '.', '_' or '-', starting with a letter or digit",
  });
  if (id === "baseline") ctx.add(join(path, "id"), '"baseline" is reserved');
  const description = ctx.string(raw, "description", path);
  const expect = parseExpectation(ctx, raw["expect"], join(path, "expect"));
  if (!type) return null;

  const memoryIdOf = (): string | undefined => {
    const memoryId = ctx.string(raw, "memoryId", path, { required: true });
    if (memoryId !== undefined && !memories.has(memoryId)) {
      ctx.add(join(path, "memoryId"), `unknown memory id "${memoryId}"`);
      return undefined;
    }
    return memoryId;
  };

  let variant: Variant | null = null;
  switch (type) {
    case "remove": {
      ctx.keys(raw, path, [...common, "memoryId"]);
      const memoryId = memoryIdOf();
      if (id && memoryId) variant = { id, type, memoryId };
      break;
    }
    case "replace": {
      ctx.keys(raw, path, [...common, "memoryId", "content"]);
      const memoryId = memoryIdOf();
      const content = ctx.string(raw, "content", path, { required: true });
      if (memoryId && content !== undefined && memories.get(memoryId)?.content === content) {
        ctx.add(join(path, "content"), "is identical to the original memory; the variant would change nothing");
      } else if (id && memoryId && content !== undefined) {
        variant = { id, type, memoryId, content };
      }
      break;
    }
    case "modify": {
      ctx.keys(raw, path, [...common, "memoryId", "find", "replaceWith"]);
      const memoryId = memoryIdOf();
      const find = ctx.string(raw, "find", path, { required: true });
      const replaceWith = ctx.string(raw, "replaceWith", path);
      if (raw["replaceWith"] === undefined) ctx.add(join(path, "replaceWith"), "is required (use an empty string to delete text)");
      if (memoryId && find !== undefined && replaceWith !== undefined) {
        const original = memories.get(memoryId)?.content ?? "";
        if (!original.includes(find)) {
          ctx.add(join(path, "find"), `text "${find}" does not occur in memory "${memoryId}"`);
        } else if (find === replaceWith) {
          ctx.add(join(path, "replaceWith"), "is identical to find; the variant would change nothing");
        } else if (id) {
          variant = { id, type, memoryId, find, replaceWith };
        }
      }
      break;
    }
    case "add": {
      ctx.keys(raw, path, [...common, "memory"]);
      const memory = raw["memory"] === undefined ? (ctx.add(join(path, "memory"), "is required"), null) : parseMemory(ctx, raw["memory"], join(path, "memory"));
      if (memory && memories.has(memory.id)) {
        ctx.add(join(join(path, "memory"), "id"), `memory id "${memory.id}" already exists; use a "replace" variant instead`);
      } else if (id && memory) {
        variant = { id, type, memory };
      }
      break;
    }
  }
  if (variant) {
    if (description !== undefined) variant.description = description;
    if (expect) variant.expect = expect;
  }
  return variant;
}

function parseToolCalls(ctx: Ctx, raw: unknown, path: string): ToolCall[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    ctx.add(path, "must be an array of tool calls");
    return undefined;
  }
  const calls: ToolCall[] = [];
  raw.forEach((item, i) => {
    const p = join(path, i);
    if (!isObj(item)) {
      ctx.add(p, "must be an object with a name");
      return;
    }
    ctx.keys(item, p, ["name", "arguments"]);
    const name = ctx.string(item, "name", p, { required: true });
    if (item["arguments"] !== undefined && !isJsonValue(item["arguments"])) ctx.add(join(p, "arguments"), "must be JSON");
    if (name !== undefined) {
      const call: ToolCall = { name };
      if (item["arguments"] !== undefined) call.arguments = item["arguments"] as JsonValue;
      calls.push(call);
    }
  });
  return calls;
}

function parseFixtureRunner(ctx: Ctx, raw: Obj, path: string): FixtureRunnerConfig | null {
  ctx.keys(raw, path, ["type", "rules"]);
  const rulesRaw = raw["rules"];
  if (!Array.isArray(rulesRaw) || rulesRaw.length === 0) {
    ctx.add(join(path, "rules"), "must be a non-empty array of rules");
    return null;
  }
  const rules: FixtureRule[] = [];
  rulesRaw.forEach((ruleRaw, i) => {
    const p = join(join(path, "rules"), i);
    if (!isObj(ruleRaw)) {
      ctx.add(p, "must be an object");
      return;
    }
    ctx.keys(ruleRaw, p, ["when", "output", "outputs", "toolCalls"]);
    const rule: FixtureRule = {};
    if (ruleRaw["when"] !== undefined) {
      const whenRaw = ruleRaw["when"];
      const wp = join(p, "when");
      if (!isObj(whenRaw)) ctx.add(wp, "must be an object");
      else {
        const condKeys = ["memoryPresent", "memoryAbsent", "contextIncludes", "contextExcludes", "taskIncludes"] as const;
        ctx.keys(whenRaw, wp, condKeys);
        const when: FixtureCondition = {};
        for (const key of condKeys) {
          const values = ctx.stringArray(whenRaw, key, wp, { nonEmptyItems: true });
          if (values) when[key] = values;
        }
        rule.when = when;
      }
    }
    const hasOutput = ruleRaw["output"] !== undefined;
    const hasOutputs = ruleRaw["outputs"] !== undefined;
    if (hasOutput === hasOutputs) {
      ctx.add(p, 'must define exactly one of "output" or "outputs"');
    } else if (hasOutput) {
      if (!isJsonValue(ruleRaw["output"])) ctx.add(join(p, "output"), "must be a string or JSON value");
      else rule.output = ruleRaw["output"];
    } else {
      const outputs = ruleRaw["outputs"];
      if (!Array.isArray(outputs) || outputs.length === 0 || !outputs.every((o) => isJsonValue(o))) {
        ctx.add(join(p, "outputs"), "must be a non-empty array of strings or JSON values");
      } else rule.outputs = outputs as JsonValue[];
    }
    const toolCalls = parseToolCalls(ctx, ruleRaw["toolCalls"], join(p, "toolCalls"));
    if (toolCalls) rule.toolCalls = toolCalls;
    rules.push(rule);
  });
  return { type: "fixture", rules };
}

function parseOpenAIRunner(ctx: Ctx, raw: Obj, path: string): OpenAICompatibleRunnerConfig | null {
  ctx.keys(raw, path, [
    "type",
    "baseUrl",
    "model",
    "apiKeyEnv",
    "temperature",
    "seed",
    "maxTokens",
    "timeoutMs",
    "responseFormat",
    "tools",
    "headers",
  ]);
  const baseUrl = ctx.string(raw, "baseUrl", path, { required: true });
  if (baseUrl !== undefined) {
    let parsed: URL | null = null;
    try {
      parsed = new URL(baseUrl);
    } catch {
      ctx.add(join(path, "baseUrl"), "must be a valid absolute URL such as https://api.openai.com/v1 or http://localhost:11434/v1");
    }
    if (parsed && parsed.protocol !== "http:" && parsed.protocol !== "https:") ctx.add(join(path, "baseUrl"), "must use http or https");
    if (parsed && (parsed.username || parsed.password)) ctx.add(join(path, "baseUrl"), "must not contain credentials");
    if (parsed && parsed.search) ctx.add(join(path, "baseUrl"), "must not contain a query string (keys belong in environment variables)");
  }
  const model = ctx.string(raw, "model", path, { required: true });
  const apiKeyEnv = ctx.string(raw, "apiKeyEnv", path, {
    pattern: ENV_NAME_PATTERN,
    patternHint: "must be the NAME of an environment variable (e.g. MEMIMPACT_API_KEY), not the key itself",
  });
  const temperature = ctx.number(raw, "temperature", path, { min: 0, max: 2 });
  const seed = ctx.number(raw, "seed", path, { integer: true });
  const maxTokens = ctx.number(raw, "maxTokens", path, { integer: true, min: 1 });
  const timeoutMs = ctx.number(raw, "timeoutMs", path, { integer: true, min: 1 });
  const responseFormat = ctx.enumValue(raw, "responseFormat", path, ["text", "json"] as const);
  let tools: JsonObject[] | undefined;
  if (raw["tools"] !== undefined) {
    if (!Array.isArray(raw["tools"]) || !raw["tools"].every((t) => isObj(t) && isJsonValue(t))) {
      ctx.add(join(path, "tools"), "must be an array of tool definition objects");
    } else tools = raw["tools"] as JsonObject[];
  }
  const headers = ctx.stringMap(raw, "headers", path);
  if (headers) {
    for (const name of Object.keys(headers)) {
      if (SECRET_HEADER_NAME.test(name) || isSecretEnvName(name)) {
        ctx.add(join(join(path, "headers"), name), "credential headers are not allowed in config; use apiKeyEnv so the key is read from the environment");
      }
    }
  }
  if (baseUrl === undefined || model === undefined) return null;
  const config: OpenAICompatibleRunnerConfig = { type: "openai-compatible", baseUrl, model };
  if (apiKeyEnv !== undefined) config.apiKeyEnv = apiKeyEnv;
  if (temperature !== undefined) config.temperature = temperature;
  if (seed !== undefined) config.seed = seed;
  if (maxTokens !== undefined) config.maxTokens = maxTokens;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (responseFormat !== undefined) config.responseFormat = responseFormat;
  if (tools) config.tools = tools;
  if (headers) config.headers = headers;
  if ((temperature ?? 0) > 0) {
    ctx.warnings.push(`runner.temperature is ${temperature}; non-zero temperature increases run-to-run variation. Use repetitions >= 3 to estimate noise.`);
  }
  return config;
}

function parseCommandRunner(ctx: Ctx, raw: Obj, path: string): CommandRunnerConfig | null {
  ctx.keys(raw, path, ["type", "command", "args", "cwd", "timeoutMs", "protocol", "env", "inheritEnv"]);
  const command = ctx.string(raw, "command", path, { required: true });
  const args = ctx.stringArray(raw, "args", path);
  const cwd = ctx.string(raw, "cwd", path, { nonEmpty: true });
  const timeoutMs = ctx.number(raw, "timeoutMs", path, { integer: true, min: 1 });
  const protocol = ctx.enumValue(raw, "protocol", path, ["text", "envelope"] as const);
  const env = ctx.stringMap(raw, "env", path);
  const inheritEnv = ctx.boolean(raw, "inheritEnv", path);
  if (env) {
    for (const name of Object.keys(env)) {
      if (!ENV_NAME_PATTERN.test(name)) ctx.add(join(join(path, "env"), name), "is not a valid environment variable name");
      else if (isSecretEnvName(name)) {
        ctx.add(join(join(path, "env"), name), "secret-looking variables must not be set in config; export them in your shell and keep inheritEnv enabled");
      }
    }
  }
  if (command === undefined) return null;
  const config: CommandRunnerConfig = { type: "command", command };
  if (args) config.args = args;
  if (cwd !== undefined) config.cwd = cwd;
  if (timeoutMs !== undefined) config.timeoutMs = timeoutMs;
  if (protocol !== undefined) config.protocol = protocol;
  if (env) config.env = env;
  if (inheritEnv !== undefined) config.inheritEnv = inheritEnv;
  return config;
}

function parseRunner(ctx: Ctx, raw: unknown, path: string): RunnerConfig | null {
  if (!isObj(raw)) {
    ctx.add(path, raw === undefined ? "is required" : `must be an object (got ${describe(raw)})`);
    return null;
  }
  const type = ctx.enumValue(raw, "type", path, RUNNER_TYPES, true);
  switch (type) {
    case "fixture":
      return parseFixtureRunner(ctx, raw, path);
    case "openai-compatible":
      return parseOpenAIRunner(ctx, raw, path);
    case "command":
      return parseCommandRunner(ctx, raw, path);
    default:
      return null;
  }
}

/**
 * Validates a raw (parsed JSON) config. `externalMemories` is supplied by the
 * loader when the config uses `memoriesFile`.
 */
export function validateConfig(raw: unknown, externalMemories?: { file: string; data: unknown }): ValidationResult {
  const ctx = new Ctx();
  if (!isObj(raw)) {
    ctx.add("", `config must be a JSON object (got ${describe(raw)})`);
    return { config: null, issues: ctx.issues, warnings: ctx.warnings };
  }
  scanForSecrets(ctx, raw, "");
  ctx.keys(raw, "", [
    "$schema",
    "version",
    "name",
    "description",
    "task",
    "system",
    "memoryPreamble",
    "memories",
    "memoriesFile",
    "variants",
    "runner",
    "repetitions",
    "compare",
    "impact",
    "artifacts",
  ]);
  ctx.string(raw, "$schema", "");
  if (raw["version"] === undefined) ctx.add("version", "is required (use 1)");
  else if (raw["version"] !== 1) ctx.add("version", "unsupported config version (expected 1)");
  const name = ctx.string(raw, "name", "", { nonEmpty: true });
  const description = ctx.string(raw, "description", "");
  const task = ctx.string(raw, "task", "", { required: true });
  const system = ctx.string(raw, "system", "");
  const memoryPreamble = ctx.string(raw, "memoryPreamble", "", { nonEmpty: true });

  let memories: Memory[] = [];
  const memoriesFile = ctx.string(raw, "memoriesFile", "", { nonEmpty: true });
  if (raw["memories"] !== undefined && raw["memoriesFile"] !== undefined) {
    ctx.add("memories", 'use either "memories" or "memoriesFile", not both');
  } else if (raw["memories"] !== undefined) {
    memories = parseMemories(ctx, raw["memories"], "memories");
  } else if (memoriesFile !== undefined) {
    if (externalMemories) {
      scanForSecrets(ctx, externalMemories.data, `memoriesFile(${externalMemories.file})`);
      const data = isObj(externalMemories.data) && "memories" in externalMemories.data ? externalMemories.data["memories"] : externalMemories.data;
      memories = parseMemories(ctx, data, `memoriesFile(${externalMemories.file})`);
    }
  } else {
    ctx.add("memories", 'is required (or provide "memoriesFile")');
  }

  const memoryMap = new Map(memories.map((m) => [m.id, m]));
  const variants: Variant[] = [];
  if (raw["variants"] === undefined) {
    ctx.add("variants", "is required (an empty array is allowed when using `memimpact run --all`)");
  } else if (!Array.isArray(raw["variants"])) {
    ctx.add("variants", `must be an array (got ${describe(raw["variants"])})`);
  } else {
    const seen = new Set<string>();
    raw["variants"].forEach((item, i) => {
      const variant = parseVariant(ctx, item, join("variants", i), memoryMap);
      if (!variant) return;
      if (seen.has(variant.id)) {
        ctx.add(join(join("variants", i), "id"), `duplicate variant id "${variant.id}"`);
        return;
      }
      seen.add(variant.id);
      variants.push(variant);
    });
  }

  const runner = parseRunner(ctx, raw["runner"], "runner");
  const repetitions = ctx.number(raw, "repetitions", "", { integer: true, min: 1, max: MAX_REPETITIONS }) ?? 1;

  const compare = { structured: "auto" as const, decisionPaths: [] as string[], ignorePaths: [] as string[] } as MemImpactConfig["compare"];
  if (raw["compare"] !== undefined) {
    const c = raw["compare"];
    if (!isObj(c)) ctx.add("compare", "must be an object");
    else {
      ctx.keys(c, "compare", ["structured", "decisionPaths", "ignorePaths"]);
      compare.structured = ctx.enumValue(c, "structured", "compare", STRUCTURED_MODES) ?? "auto";
      compare.decisionPaths = ctx.stringArray(c, "decisionPaths", "compare", { nonEmptyItems: true }) ?? [];
      compare.ignorePaths = ctx.stringArray(c, "ignorePaths", "compare", { nonEmptyItems: true }) ?? [];
    }
  }

  const thresholds: ImpactThresholds = { ...DEFAULT_THRESHOLDS };
  if (raw["impact"] !== undefined) {
    const imp = raw["impact"];
    if (!isObj(imp)) ctx.add("impact", "must be an object");
    else {
      ctx.keys(imp, "impact", ["thresholds"]);
      const t = imp["thresholds"];
      if (t !== undefined) {
        if (!isObj(t)) ctx.add("impact.thresholds", "must be an object");
        else {
          ctx.keys(t, "impact.thresholds", ["low", "medium", "high"]);
          for (const key of ["low", "medium", "high"] as const) {
            const v = ctx.number(t, key, "impact.thresholds", { exclusiveMin: 0, max: 1 });
            if (v !== undefined) thresholds[key] = v;
          }
          if (!(thresholds.low < thresholds.medium && thresholds.medium < thresholds.high)) {
            ctx.add("impact.thresholds", "must satisfy low < medium < high");
          }
        }
      }
    }
  }

  const artifacts = { dir: DEFAULT_ARTIFACT_DIR, save: true, storeMemoryContent: true, storeOutputs: true };
  if (raw["artifacts"] !== undefined) {
    const a = raw["artifacts"];
    if (!isObj(a)) ctx.add("artifacts", "must be an object");
    else {
      ctx.keys(a, "artifacts", ["dir", "save", "storeMemoryContent", "storeOutputs"]);
      artifacts.dir = ctx.string(a, "dir", "artifacts", { nonEmpty: true }) ?? artifacts.dir;
      artifacts.save = ctx.boolean(a, "save", "artifacts") ?? artifacts.save;
      artifacts.storeMemoryContent = ctx.boolean(a, "storeMemoryContent", "artifacts") ?? artifacts.storeMemoryContent;
      artifacts.storeOutputs = ctx.boolean(a, "storeOutputs", "artifacts") ?? artifacts.storeOutputs;
    }
  }

  if (runner && runner.type !== "fixture" && repetitions < 2) {
    ctx.warnings.push("repetitions is 1: MemImpact cannot separate the memory's effect from ordinary run-to-run variation. Use repetitions >= 3 for real models.");
  }

  if (ctx.issues.length > 0 || task === undefined || runner === null) {
    return { config: null, issues: ctx.issues, warnings: ctx.warnings };
  }

  const config: MemImpactConfig = {
    version: 1,
    task,
    memories,
    variants,
    runner,
    repetitions,
    compare,
    impact: { thresholds },
    artifacts,
  };
  if (name !== undefined) config.name = name;
  if (description !== undefined) config.description = description;
  if (system !== undefined) config.system = system;
  if (memoryPreamble !== undefined) config.memoryPreamble = memoryPreamble;
  if (memoriesFile !== undefined) config.memoriesFile = memoriesFile;
  return { config, issues: [], warnings: ctx.warnings };
}

export function formatIssues(issues: ValidationIssue[]): string[] {
  return issues.map((issue) => `${issue.path}: ${issue.message}`);
}
