import { IMPACT_LEVELS, type Attribution, type Expectation, type ExpectationResult, type ImpactAssessment, type ImpactLevel, type ImpactThresholds, type VariantComparison } from "../types/index.js";

export const DISCLAIMER =
  "Impact levels describe OBSERVED differences between baseline and variant runs under this configured experiment. " +
  "They are not proof of causal attribution: model outputs can vary between runs, and other factors (provider changes, " +
  "sampling, hidden state) can contribute. Use repetitions and deterministic settings to strengthen the evidence.";

export function levelRank(level: ImpactLevel): number {
  return IMPACT_LEVELS.indexOf(level);
}

export function maxLevel(levels: ImpactLevel[]): ImpactLevel | null {
  if (levels.length === 0) return null;
  return levels.reduce((a, b) => (levelRank(b) > levelRank(a) ? b : a));
}

const pct = (n: number): string => `${(n * 100).toFixed(1)}%`;
const fixed = (n: number): string => n.toFixed(3);

function formatValues(values: { value: string; count: number }[]): string {
  return values.map((v) => (values.length === 1 ? v.value : `${v.value} ×${v.count}`)).join(", ");
}

/**
 * Transparent, rule-based impact classification. See docs/impact.md.
 *
 * HIGH   : a decision field changed (no value shared between conditions), OR the
 *          tool-call sequence changed, OR adjustedDistance >= thresholds.high
 * MEDIUM : adjustedDistance >= thresholds.medium, OR a non-decision field changed
 * LOW    : adjustedDistance >= thresholds.low, OR fields vary in a mixed way
 * NONE   : otherwise (including differences that fall within the measured noise)
 * Text identical after normalization yields adjustedDistance 0, but structured
 * and tool-call changes are still evaluated (normalization is case-insensitive).
 */
export function assessImpact(comparison: VariantComparison, thresholds: ImpactThresholds): ImpactAssessment {
  const { noise } = comparison;
  const evidence: string[] = [];
  const changedFields = comparison.structured?.fields.filter((f) => f.status === "changed" || f.status === "added" || f.status === "removed") ?? [];
  const decisionChanges = changedFields.filter((f) => f.decision);
  const otherChanges = changedFields.filter((f) => !f.decision);
  const mixedFields = comparison.structured?.fields.filter((f) => f.status === "mixed") ?? [];
  const toolsChanged = comparison.tools?.status === "changed";
  const multiRun = comparison.runs.baseline > 1 || comparison.runs.variant > 1;

  for (const f of decisionChanges) {
    evidence.push(`Decision field \`${f.path}\` changed: ${formatValues(f.baseline)} → ${formatValues(f.variant)}${f.consistent ? "" : " (values varied within a condition, but no value was shared)"}`);
  }
  for (const f of otherChanges) {
    evidence.push(`Field \`${f.path}\` changed: ${formatValues(f.baseline)} → ${formatValues(f.variant)}`);
  }
  for (const f of mixedFields) {
    evidence.push(`Field \`${f.path}\` varied across repetitions (baseline: ${formatValues(f.baseline)}; variant: ${formatValues(f.variant)})`);
  }
  if (toolsChanged && comparison.tools) {
    evidence.push(`Tool calls changed: ${formatValues(comparison.tools.baseline)} → ${formatValues(comparison.tools.variant)}`);
  } else if (comparison.tools?.status === "mixed") {
    evidence.push("Tool calls varied across repetitions in a way that overlaps between conditions");
  }

  const noiseText =
    noise.noiseFloor === null
      ? "noise floor unknown (single run per condition)"
      : `noise floor ${fixed(noise.noiseFloor)} from within-condition self-similarity`;
  evidence.push(
    `Mean word-sequence similarity ${pct(noise.crossSimilarity)} → raw distance ${fixed(noise.rawDistance)}; ${noiseText}; adjusted distance ${fixed(noise.adjustedDistance)} (thresholds low ${thresholds.low}, medium ${thresholds.medium}, high ${thresholds.high})`,
  );

  let level: ImpactLevel;
  if (decisionChanges.length > 0 || toolsChanged || noise.adjustedDistance >= thresholds.high) {
    level = "high";
  } else if (noise.adjustedDistance >= thresholds.medium || otherChanges.length > 0) {
    level = "medium";
  } else if (noise.adjustedDistance >= thresholds.low || mixedFields.length > 0) {
    level = "low";
  } else {
    level = "none";
  }

  let attribution: Attribution;
  if (level === "none") {
    attribution = noise.noiseFloor !== null && noise.rawDistance >= thresholds.low ? "within-noise" : "no-difference";
    if (comparison.allNormalizedIdentical) evidence.unshift("All baseline and variant outputs are identical after normalization");
    else if (attribution === "within-noise") evidence.unshift("Observed differences are within the run-to-run variation measured inside each condition");
    else evidence.unshift("Differences are below the low threshold");
  } else if (!multiRun) {
    attribution = "single-run";
  } else {
    attribution = "above-noise";
  }

  return {
    level,
    attribution,
    evidence,
    signals: {
      adjustedDistance: noise.adjustedDistance,
      rawDistance: noise.rawDistance,
      noiseFloor: noise.noiseFloor,
      structuredDecisionChanges: decisionChanges.length,
      structuredOtherChanges: otherChanges.length,
      structuredMixed: mixedFields.length,
      toolCallsChanged: toolsChanged,
      thresholds,
    },
  };
}

export function checkExpectation(expected: Expectation, level: ImpactLevel): ExpectationResult {
  const rank = levelRank(level);
  const problems: string[] = [];
  if (expected.minImpact && rank < levelRank(expected.minImpact)) problems.push(`expected at least ${expected.minImpact.toUpperCase()}`);
  if (expected.maxImpact && rank > levelRank(expected.maxImpact)) problems.push(`expected at most ${expected.maxImpact.toUpperCase()}`);
  const passed = problems.length === 0;
  return {
    expected,
    passed,
    message: passed ? `Impact ${level.toUpperCase()} meets expectation` : `Impact ${level.toUpperCase()}: ${problems.join(" and ")}`,
  };
}

export function attributionLabel(attribution: Attribution, runs: { baseline: number; variant: number }): string {
  switch (attribution) {
    case "no-difference":
      return "No observable difference";
    case "within-noise":
      return "Difference is within measured run-to-run variation";
    case "single-run":
      return "Single run per condition: cannot separate the memory's effect from run-to-run variation";
    case "above-noise":
      return `Difference exceeds measured run-to-run variation (${runs.baseline} baseline / ${runs.variant} variant runs)`;
  }
}
