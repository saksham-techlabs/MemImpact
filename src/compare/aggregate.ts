import type { CompareOptions, JsonValue, NoiseEstimate, RunRecord, VariantComparison } from "../types/index.js";
import { compareStructured, extractJson } from "./structured.js";
import { distinctiveTerms } from "./terms.js";
import { compareText, normalizeText, textSimilarity } from "./text.js";
import { compareToolCalls } from "./tools.js";

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

function pairwiseWithin(outputs: string[]): number | null {
  const sims: number[] = [];
  for (let i = 0; i < outputs.length; i++) {
    for (let j = i + 1; j < outputs.length; j++) sims.push(textSimilarity(outputs[i] as string, outputs[j] as string));
  }
  return mean(sims);
}

/**
 * Estimates run-to-run noise and the cross-condition difference.
 * - selfSimilarity: mean pairwise similarity among runs of ONE condition
 * - crossSimilarity: mean similarity over all baseline × variant pairs
 * - noiseFloor = 1 - mean(available selfSimilarities)
 * - adjustedDistance = max(0, (1 - crossSimilarity) - noiseFloor)
 */
export function estimateNoise(baseline: string[], variant: string[]): NoiseEstimate {
  const cross: number[] = [];
  for (const a of baseline) for (const b of variant) cross.push(textSimilarity(a, b));
  const crossSimilarity = mean(cross) ?? 1;
  const baselineSelfSimilarity = pairwiseWithin(baseline);
  const variantSelfSimilarity = pairwiseWithin(variant);
  const selfValues = [baselineSelfSimilarity, variantSelfSimilarity].filter((v): v is number => v !== null);
  const within = mean(selfValues);
  const noiseFloor = within === null ? null : 1 - within;
  const rawDistance = 1 - crossSimilarity;
  const adjustedDistance = Math.max(0, rawDistance - (noiseFloor ?? 0));
  return { baselineSelfSimilarity, variantSelfSimilarity, crossSimilarity, noiseFloor, rawDistance, adjustedDistance };
}

export function compareRunSets(baselineRuns: RunRecord[], variantRuns: RunRecord[], options: CompareOptions): VariantComparison {
  const okA = baselineRuns.filter((r) => r.status === "ok" && r.output !== undefined);
  const okB = variantRuns.filter((r) => r.status === "ok" && r.output !== undefined);
  if (okA.length === 0 || okB.length === 0) {
    throw new Error("compareRunSets requires at least one successful run on each side");
  }
  const outA = okA.map((r) => r.output as string);
  const outB = okB.map((r) => r.output as string);

  const normalized = new Set([...outA, ...outB].map(normalizeText));
  const comparison: VariantComparison = {
    runs: { baseline: okA.length, variant: okB.length },
    allNormalizedIdentical: normalized.size === 1,
    noise: estimateNoise(outA, outB),
    representative: compareText(outA[0] as string, outB[0] as string),
    structured: null,
    tools: compareToolCalls(
      okA.map((r) => r.toolCalls),
      okB.map((r) => r.toolCalls),
    ),
    terms: distinctiveTerms(outA, outB),
  };

  if (options.structured !== "never") {
    const jsonA = outA.map(extractJson);
    const jsonB = outB.map(extractJson);
    const parsedA = jsonA.filter((v): v is JsonValue => v !== undefined);
    const parsedB = jsonB.filter((v): v is JsonValue => v !== undefined);
    const allParsed = parsedA.length === outA.length && parsedB.length === outB.length;
    if (allParsed) {
      const { fields, ignoredPaths } = compareStructured(parsedA, parsedB, options);
      comparison.structured = {
        parsed: { baseline: parsedA.length, variant: parsedB.length, baselineTotal: outA.length, variantTotal: outB.length },
        fields,
        ignoredPaths,
      };
    } else if (options.structured === "always" || parsedA.length + parsedB.length > 0) {
      comparison.structuredNote = `Structured comparison skipped: JSON found in ${parsedA.length}/${outA.length} baseline and ${parsedB.length}/${outB.length} variant outputs (all outputs must be JSON).`;
    }
  }
  return comparison;
}
