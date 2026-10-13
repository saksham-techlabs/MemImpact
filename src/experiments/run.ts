import { randomBytes } from "node:crypto";
import path from "node:path";
import { compareRunSets } from "../compare/aggregate.js";
import { errorMessage, MemImpactError, UsageError } from "../core/errors.js";
import { assessImpact, checkExpectation, DISCLAIMER, maxLevel } from "../core/impact.js";
import { VERSION } from "../core/version.js";
import { applyVariant, autoRemoveVariant, describeVariant, variantMemoryId } from "../mutations/apply.js";
import { renderPrompt } from "../runners/prompt.js";
import {
  IMPACT_LEVELS,
  type ExperimentResult,
  type ImpactLevel,
  type LoadedConfig,
  type Memory,
  type RunRecord,
  type Runner,
  type Variant,
  type VariantResult,
} from "../types/index.js";

export interface SelectedVariant {
  variant: Variant;
  auto: boolean;
}

export interface RunSelection {
  variantIds?: string[];
  memoryIds?: string[];
  all?: boolean;
}

export type ProgressEvent =
  | { type: "run-start"; condition: string; repetition: number; total: number }
  | { type: "run-end"; condition: string; repetition: number; total: number; record: RunRecord };

export interface RunOptions extends RunSelection {
  repetitions?: number;
  runner: Runner;
  onProgress?: (event: ProgressEvent) => void;
  now?: () => Date;
}

export function createExperimentId(date: Date): string {
  const p = (n: number): string => String(n).padStart(2, "0");
  const stamp = `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}`;
  return `${stamp}-${randomBytes(3).toString("hex")}`;
}

export const EXPERIMENT_ID_PATTERN = /^\d{8}-\d{6}-[a-f0-9]{6}$/;

/**
 * Resolves which variants to run:
 * - default: every configured variant
 * - --variant <id>: only those configured variants
 * - --memory <id>: configured variants targeting that memory; if none exist, an
 *   automatic `remove` variant is generated for it
 * - --all: every configured variant, plus an automatic `remove` variant for each
 *   memory that has no configured remove variant (leave-one-out ablation)
 */
export function selectVariants(loaded: LoadedConfig, selection: RunSelection): SelectedVariant[] {
  const { config } = loaded;
  const configured = config.variants;
  const memoryIds = new Set(config.memories.map((m) => m.id));
  const taken = new Set(configured.map((v) => v.id));
  const selected: SelectedVariant[] = [];

  for (const id of selection.variantIds ?? []) {
    if (!configured.some((v) => v.id === id)) {
      throw new UsageError(`Unknown variant "${id}"`, [`Configured variants: ${configured.map((v) => v.id).join(", ") || "(none)"}`]);
    }
  }
  for (const id of selection.memoryIds ?? []) {
    if (!memoryIds.has(id) && !configured.some((v) => v.type === "add" && v.memory.id === id)) {
      throw new UsageError(`Unknown memory "${id}"`, [`Memories: ${[...memoryIds].join(", ") || "(none)"}`]);
    }
  }

  const hasFilter = (selection.variantIds?.length ?? 0) > 0 || (selection.memoryIds?.length ?? 0) > 0;
  const add = (variant: Variant, auto: boolean): void => {
    if (!selected.some((s) => s.variant.id === variant.id)) selected.push({ variant, auto });
  };

  if (!hasFilter || selection.all) {
    for (const v of configured) add(v, false);
  }
  for (const id of selection.variantIds ?? []) add(configured.find((v) => v.id === id) as Variant, false);
  for (const memoryId of selection.memoryIds ?? []) {
    const targeting = configured.filter((v) => variantMemoryId(v) === memoryId);
    if (targeting.length > 0) for (const v of targeting) add(v, false);
    else {
      const auto = autoRemoveVariant(memoryId, taken);
      taken.add(auto.id);
      add(auto, true);
    }
  }
  if (selection.all) {
    for (const memory of config.memories) {
      if (configured.some((v) => v.type === "remove" && v.memoryId === memory.id)) continue;
      if (selected.some((s) => s.variant.type === "remove" && s.variant.memoryId === memory.id)) continue;
      const auto = autoRemoveVariant(memory.id, taken);
      taken.add(auto.id);
      add(auto, true);
    }
  }
  if (selected.length === 0) {
    throw new UsageError("No variants to run", ['Add entries to "variants" in the config, or use `memimpact run --all` for automatic leave-one-out ablation.']);
  }
  return selected;
}

async function executeCondition(
  condition: string,
  memories: Memory[],
  loaded: LoadedConfig,
  repetitions: number,
  options: RunOptions,
): Promise<RunRecord[]> {
  const { config } = loaded;
  const prompt = renderPrompt({ task: config.task, system: config.system, memoryPreamble: config.memoryPreamble, memories });
  const records: RunRecord[] = [];
  for (let repetition = 1; repetition <= repetitions; repetition++) {
    options.onProgress?.({ type: "run-start", condition, repetition, total: repetitions });
    const started = performance.now();
    const startedAt = (options.now?.() ?? new Date()).toISOString();
    const record: RunRecord = {
      id: `${condition}#${repetition}`,
      condition,
      repetition,
      startedAt,
      durationMs: 0,
      memoryIds: memories.map((m) => m.id),
      status: "ok",
    };
    try {
      const input = { task: config.task, memories: memories.map((m) => ({ ...m })), prompt, repetition };
      const result = await options.runner.run(config.system === undefined ? input : { ...input, system: config.system });
      record.output = result.output;
      if (result.toolCalls) record.toolCalls = result.toolCalls;
      if (result.usage) record.usage = result.usage;
      if (result.model) record.model = result.model;
      if (result.finishReason) record.finishReason = result.finishReason;
      if (result.metadata) record.metadata = result.metadata;
    } catch (error) {
      record.status = "error";
      const details = error instanceof MemImpactError && error.details.length > 0 ? ` (${error.details.join("; ")})` : "";
      record.error = `${errorMessage(error)}${details}`;
    }
    record.durationMs = Math.round(performance.now() - started);
    records.push(record);
    options.onProgress?.({ type: "run-end", condition, repetition, total: repetitions, record });
  }
  return records;
}

export async function runExperiment(loaded: LoadedConfig, options: RunOptions): Promise<ExperimentResult> {
  const { config } = loaded;
  const now = options.now ?? (() => new Date());
  const startedDate = now();
  const started = performance.now();
  const repetitions = options.repetitions ?? config.repetitions;
  const selected = selectVariants(loaded, options);

  const baselineRuns = await executeCondition("baseline", config.memories, loaded, repetitions, options);
  const baselineOk = baselineRuns.some((r) => r.status === "ok");

  const variants: VariantResult[] = [];
  for (const { variant, auto } of selected) {
    const memories = applyVariant(config.memories, variant);
    const result: VariantResult = {
      id: variant.id,
      type: variant.type,
      auto,
      description: variant.description && !auto ? `${describeVariant(variant)} (${variant.description})` : describeVariant(variant),
      definition: variant,
      memoryIds: memories.map((m) => m.id),
      runs: [],
      comparison: null,
      impact: null,
      expectation: null,
    };
    if (!baselineOk) {
      result.error = "Skipped: every baseline run failed";
      variants.push(result);
      continue;
    }
    result.runs = await executeCondition(variant.id, memories, loaded, repetitions, options);
    if (!result.runs.some((r) => r.status === "ok")) {
      result.error = "Every variant run failed";
    } else {
      result.comparison = compareRunSets(baselineRuns, result.runs, config.compare);
      result.impact = assessImpact(result.comparison, config.impact.thresholds);
      if (variant.expect) result.expectation = checkExpectation(variant.expect, result.impact.level);
    }
    variants.push(result);
  }

  const byLevel = Object.fromEntries(IMPACT_LEVELS.map((l) => [l, 0])) as Record<ImpactLevel, number>;
  for (const v of variants) if (v.impact) byLevel[v.impact.level]++;
  const allRuns = [...baselineRuns, ...variants.flatMap((v) => v.runs)];
  const finishedDate = now();

  const experiment: ExperimentResult = {
    kind: "memimpact.experiment",
    schemaVersion: 1,
    experimentId: createExperimentId(startedDate),
    tool: { name: "memimpact", version: VERSION },
    createdAt: startedDate.toISOString(),
    finishedAt: finishedDate.toISOString(),
    durationMs: Math.round(performance.now() - started),
    config: { file: path.basename(loaded.configPath), hash: loaded.configHash },
    task: config.task,
    runner: options.runner.info(),
    repetitions,
    memories: config.memories.map((m) => ({ ...m })),
    baseline: { memoryIds: config.memories.map((m) => m.id), runs: baselineRuns },
    variants,
    summary: {
      variants: variants.length,
      byLevel,
      highest: maxLevel(variants.flatMap((v) => (v.impact ? [v.impact.level] : []))),
      failedRuns: allRuns.filter((r) => r.status === "error").length,
      variantErrors: variants.filter((v) => v.error).length,
      expectationsFailed: variants.filter((v) => v.expectation && !v.expectation.passed).length,
    },
    privacy: { memoryContentStored: true, outputsStored: true },
    disclaimer: DISCLAIMER,
  };
  if (config.name) experiment.name = config.name;
  if (config.system !== undefined) experiment.system = config.system;
  return experiment;
}
