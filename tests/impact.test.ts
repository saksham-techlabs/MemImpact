import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareRunSets } from "../src/compare/aggregate.js";
import { DEFAULT_THRESHOLDS } from "../src/config/validate.js";
import { assessImpact, checkExpectation, levelRank, maxLevel } from "../src/core/impact.js";
import type { CompareOptions, RunRecord, ToolCall } from "../src/types/index.js";

let counter = 0;
function run(output: string, toolCalls?: ToolCall[]): RunRecord {
  const r: RunRecord = { id: `r${counter++}`, condition: "c", repetition: 1, startedAt: "", durationMs: 0, memoryIds: [], status: "ok", output };
  if (toolCalls) r.toolCalls = toolCalls;
  return r;
}

const opts: CompareOptions = { structured: "auto", decisionPaths: [], ignorePaths: [] };

function assess(baseline: string[], variant: string[], options: CompareOptions = opts) {
  return assessImpact(
    compareRunSets(
      baseline.map((o) => run(o)),
      variant.map((o) => run(o)),
      options,
    ),
    DEFAULT_THRESHOLDS,
  );
}

const LONG_A = "Docker packages an application and its dependencies into a portable container image that runs the same way everywhere.";

describe("impact classification", () => {
  it("is NONE for identical outputs", () => {
    const impact = assess([LONG_A, LONG_A], [LONG_A, LONG_A]);
    assert.equal(impact.level, "none");
    assert.equal(impact.attribution, "no-difference");
  });

  it("is NONE for formatting-only differences", () => {
    const impact = assess([LONG_A], [`  ${LONG_A.toUpperCase()}\r\n`]);
    assert.equal(impact.level, "none");
  });

  it("is LOW for a small wording change", () => {
    const impact = assess([LONG_A], [LONG_A.replace("portable", "lightweight")]);
    assert.equal(impact.level, "low");
    assert.equal(impact.attribution, "single-run");
  });

  it("is MEDIUM for a moderate rewrite", () => {
    const variant = `${LONG_A} It also isolates processes using Linux namespaces and control groups for safety.`;
    const impact = assess([LONG_A], [variant]);
    assert.equal(impact.level, "medium", impact.evidence.join("\n"));
  });

  it("is HIGH for a completely different answer", () => {
    const impact = assess([LONG_A], ["Kubernetes orchestrates clusters of machines, scheduling workloads across nodes automatically."]);
    assert.equal(impact.level, "high");
  });

  it("is HIGH when a structured decision field changes, even if most text matches", () => {
    const a = JSON.stringify({ database: "PostgreSQL", hosting: "Vercel", region: "us-east-1", cache: "Redis", queue: "SQS", cdn: "CloudFront" });
    const b = JSON.stringify({ database: "MongoDB", hosting: "Vercel", region: "us-east-1", cache: "Redis", queue: "SQS", cdn: "CloudFront" });
    const impact = assess([a, a], [b, b]);
    assert.equal(impact.level, "high");
    assert.equal(impact.signals.structuredDecisionChanges, 1);
    assert.match(impact.evidence[0] ?? "", /Decision field `database` changed: "PostgreSQL" → "MongoDB"/);
    assert.equal(impact.attribution, "above-noise");
  });

  it("is MEDIUM when only a non-decision field changes", () => {
    const a = JSON.stringify({ database: "PostgreSQL", hosting: "Vercel", region: "us-east-1", cache: "Redis", queue: "SQS", cdn: "CloudFront" });
    const b = JSON.stringify({ database: "PostgreSQL", hosting: "Fly.io", region: "us-east-1", cache: "Redis", queue: "SQS", cdn: "CloudFront" });
    const impact = assess([a], [b], { ...opts, decisionPaths: ["database"] });
    assert.equal(impact.level, "medium");
    assert.equal(impact.signals.structuredOtherChanges, 1);
  });

  it("is HIGH when tool calls change", () => {
    const comparison = compareRunSets([run(LONG_A, [{ name: "search" }])], [run(LONG_A, [{ name: "delete_file" }])], opts);
    const impact = assessImpact(comparison, DEFAULT_THRESHOLDS);
    assert.equal(impact.level, "high");
    assert.equal(impact.signals.toolCallsChanged, true);
    assert.equal(comparison.allNormalizedIdentical, true, "text alone is identical");
  });

  it("detects case-only changes in structured values despite case-insensitive text normalization", () => {
    const impact = assess([JSON.stringify({ env: "PROD" })], [JSON.stringify({ env: "prod" })]);
    assert.equal(impact.level, "high");
  });

  it("does not attribute differences that are within baseline noise", () => {
    const b1 = "Docker runs containers. Answer variant alpha with some phrasing.";
    const b2 = "Docker runs containers. Answer variant beta using other wording.";
    const impact = assess([b1, b2, b1], [b2, b1, b2]);
    assert.equal(impact.level, "none", impact.evidence.join("\n"));
    assert.equal(impact.attribution, "within-noise");
  });

  it("subtracts the noise floor from the raw distance", () => {
    const base = ["alpha beta gamma delta epsilon", "alpha beta gamma delta zeta"];
    const variant = ["one two three four five", "one two three four six"];
    const impact = assess(base, variant);
    assert.ok(impact.signals.noiseFloor !== null && impact.signals.noiseFloor > 0);
    assert.ok(impact.signals.adjustedDistance < impact.signals.rawDistance);
    assert.equal(impact.level, "high");
  });

  it("respects custom thresholds", () => {
    const comparison = compareRunSets([run(LONG_A)], [run(LONG_A.replace("portable", "lightweight"))], opts);
    assert.equal(assessImpact(comparison, { low: 0.001, medium: 0.002, high: 0.003 }).level, "high");
    assert.equal(assessImpact(comparison, { low: 0.5, medium: 0.6, high: 0.7 }).level, "none");
  });

  it("always includes transparent text evidence", () => {
    const impact = assess([LONG_A], ["Different."]);
    assert.ok(impact.evidence.some((e) => e.includes("adjusted distance")));
  });
});

describe("expectations", () => {
  it("checks min and max impact", () => {
    assert.equal(checkExpectation({ minImpact: "medium" }, "high").passed, true);
    assert.equal(checkExpectation({ minImpact: "medium" }, "low").passed, false);
    assert.equal(checkExpectation({ maxImpact: "low" }, "none").passed, true);
    assert.equal(checkExpectation({ maxImpact: "low" }, "high").passed, false);
    assert.match(checkExpectation({ maxImpact: "none" }, "high").message, /expected at most NONE/);
  });

  it("orders levels", () => {
    assert.ok(levelRank("high") > levelRank("medium"));
    assert.equal(maxLevel(["low", "high", "none"]), "high");
    assert.equal(maxLevel([]), null);
  });
});
