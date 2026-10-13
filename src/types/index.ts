export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export const IMPACT_LEVELS = ["none", "low", "medium", "high"] as const;
export type ImpactLevel = (typeof IMPACT_LEVELS)[number];

export const VARIANT_TYPES = ["remove", "replace", "modify", "add"] as const;
export type VariantType = (typeof VARIANT_TYPES)[number];

export const RUNNER_TYPES = ["fixture", "openai-compatible", "command"] as const;
export type RunnerType = (typeof RUNNER_TYPES)[number];

export const STRUCTURED_MODES = ["auto", "always", "never"] as const;
export type StructuredMode = (typeof STRUCTURED_MODES)[number];

export interface Memory {
  id: string;
  content: string;
  tags?: string[];
  source?: string;
}

export interface Expectation {
  minImpact?: ImpactLevel;
  maxImpact?: ImpactLevel;
}

interface VariantBase {
  id: string;
  description?: string;
  expect?: Expectation;
}

export interface RemoveVariant extends VariantBase {
  type: "remove";
  memoryId: string;
}

export interface ReplaceVariant extends VariantBase {
  type: "replace";
  memoryId: string;
  content: string;
}

export interface ModifyVariant extends VariantBase {
  type: "modify";
  memoryId: string;
  find: string;
  replaceWith: string;
}

export interface AddVariant extends VariantBase {
  type: "add";
  memory: Memory;
}

export type Variant = RemoveVariant | ReplaceVariant | ModifyVariant | AddVariant;

export interface ToolCall {
  name: string;
  arguments?: JsonValue;
}

export interface FixtureCondition {
  memoryPresent?: string[];
  memoryAbsent?: string[];
  contextIncludes?: string[];
  contextExcludes?: string[];
  taskIncludes?: string[];
}

export interface FixtureRule {
  when?: FixtureCondition;
  output?: JsonValue;
  outputs?: JsonValue[];
  toolCalls?: ToolCall[];
}

export interface FixtureRunnerConfig {
  type: "fixture";
  rules: FixtureRule[];
}

export interface OpenAICompatibleRunnerConfig {
  type: "openai-compatible";
  baseUrl: string;
  model: string;
  apiKeyEnv?: string;
  temperature?: number;
  seed?: number;
  maxTokens?: number;
  timeoutMs?: number;
  responseFormat?: "text" | "json";
  tools?: JsonObject[];
  headers?: Record<string, string>;
}

export interface CommandRunnerConfig {
  type: "command";
  command: string;
  args?: string[];
  cwd?: string;
  timeoutMs?: number;
  protocol?: "text" | "envelope";
  env?: Record<string, string>;
  inheritEnv?: boolean;
}

export type RunnerConfig = FixtureRunnerConfig | OpenAICompatibleRunnerConfig | CommandRunnerConfig;

export interface CompareOptions {
  structured: StructuredMode;
  decisionPaths: string[];
  ignorePaths: string[];
}

export interface ImpactThresholds {
  low: number;
  medium: number;
  high: number;
}

export interface ArtifactOptions {
  dir: string;
  save: boolean;
  storeMemoryContent: boolean;
  storeOutputs: boolean;
}

/** Fully validated configuration with defaults applied. */
export interface MemImpactConfig {
  version: 1;
  name?: string;
  description?: string;
  task: string;
  system?: string;
  memoryPreamble?: string;
  memories: Memory[];
  memoriesFile?: string;
  variants: Variant[];
  runner: RunnerConfig;
  repetitions: number;
  compare: CompareOptions;
  impact: { thresholds: ImpactThresholds };
  artifacts: ArtifactOptions;
}

export interface LoadedConfig {
  config: MemImpactConfig;
  configPath: string;
  baseDir: string;
  configHash: string;
  warnings: string[];
}

export interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface RunnerResult {
  output: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  model?: string;
  finishReason?: string;
  metadata?: Record<string, JsonValue>;
}

export interface RunnerInfo {
  type: RunnerType;
  model?: string;
  endpoint?: string;
  command?: string;
  external: boolean;
  deterministic: boolean;
  temperature?: number;
  seed?: number;
}

export interface RenderedPrompt {
  system: string;
  user: string;
}

export interface RunInput {
  task: string;
  system?: string;
  memories: Memory[];
  prompt: RenderedPrompt;
  repetition: number;
}

export interface Runner {
  info(): RunnerInfo;
  run(input: RunInput): Promise<RunnerResult>;
}

export interface RunRecord {
  id: string;
  condition: string;
  repetition: number;
  startedAt: string;
  durationMs: number;
  memoryIds: string[];
  status: "ok" | "error";
  output?: string;
  toolCalls?: ToolCall[];
  usage?: Usage;
  model?: string;
  finishReason?: string;
  metadata?: Record<string, JsonValue>;
  error?: string;
}

export interface LineWordCounts {
  added: number;
  removed: number;
  unchanged: number;
}

export interface SectionChange {
  title: string;
  status: "added" | "removed" | "changed" | "unchanged";
  similarity?: number;
}

export interface TextComparison {
  identical: boolean;
  normalizedIdentical: boolean;
  similarity: number;
  approximate: boolean;
  lines: LineWordCounts;
  words: LineWordCounts;
  length: {
    baselineChars: number;
    variantChars: number;
    deltaChars: number;
    deltaPercent: number | null;
    baselineWords: number;
    variantWords: number;
  };
  sections: SectionChange[] | null;
}

export interface ValueCount {
  value: string;
  count: number;
}

export type FieldStatus = "changed" | "unchanged" | "mixed" | "added" | "removed";

export interface StructuredFieldChange {
  path: string;
  status: FieldStatus;
  consistent: boolean;
  decision: boolean;
  baseline: ValueCount[];
  variant: ValueCount[];
}

export interface StructuredComparison {
  parsed: { baseline: number; variant: number; baselineTotal: number; variantTotal: number };
  fields: StructuredFieldChange[];
  ignoredPaths: string[];
}

export interface ToolComparison {
  status: "changed" | "unchanged" | "mixed";
  consistent: boolean;
  baseline: ValueCount[];
  variant: ValueCount[];
  addedTools: string[];
  removedTools: string[];
}

export interface NoiseEstimate {
  baselineSelfSimilarity: number | null;
  variantSelfSimilarity: number | null;
  crossSimilarity: number;
  noiseFloor: number | null;
  rawDistance: number;
  adjustedDistance: number;
}

export interface VariantComparison {
  runs: { baseline: number; variant: number };
  allNormalizedIdentical: boolean;
  noise: NoiseEstimate;
  representative: TextComparison;
  structured: StructuredComparison | null;
  structuredNote?: string;
  tools: ToolComparison | null;
  terms: { baselineOnly: string[]; variantOnly: string[] };
}

export type Attribution = "no-difference" | "within-noise" | "single-run" | "above-noise";

export interface ImpactAssessment {
  level: ImpactLevel;
  attribution: Attribution;
  evidence: string[];
  signals: {
    adjustedDistance: number;
    rawDistance: number;
    noiseFloor: number | null;
    structuredDecisionChanges: number;
    structuredOtherChanges: number;
    structuredMixed: number;
    toolCallsChanged: boolean;
    thresholds: ImpactThresholds;
  };
}

export interface ExpectationResult {
  expected: Expectation;
  passed: boolean;
  message: string;
}

export interface VariantResult {
  id: string;
  type: VariantType;
  auto: boolean;
  description: string;
  definition: Variant;
  memoryIds: string[];
  runs: RunRecord[];
  comparison: VariantComparison | null;
  impact: ImpactAssessment | null;
  expectation: ExpectationResult | null;
  error?: string;
}

export interface ExperimentSummary {
  variants: number;
  byLevel: Record<ImpactLevel, number>;
  highest: ImpactLevel | null;
  failedRuns: number;
  variantErrors: number;
  expectationsFailed: number;
}

export interface ExperimentResult {
  kind: "memimpact.experiment";
  schemaVersion: 1;
  experimentId: string;
  tool: { name: "memimpact"; version: string };
  name?: string;
  createdAt: string;
  finishedAt: string;
  durationMs: number;
  config: { file: string; hash: string };
  task: string;
  system?: string;
  runner: RunnerInfo;
  repetitions: number;
  memories: Memory[];
  baseline: { memoryIds: string[]; runs: RunRecord[] };
  variants: VariantResult[];
  summary: ExperimentSummary;
  privacy: { memoryContentStored: boolean; outputsStored: boolean };
  disclaimer: string;
}

export interface CompareResult {
  kind: "memimpact.comparison";
  schemaVersion: 1;
  a: string;
  b: string;
  comparison: VariantComparison;
  impact: ImpactAssessment;
  disclaimer: string;
}
