import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runExperiment } from "../src/experiments/run.js";
import { renderExperiment, renderExperimentList } from "../src/reporters/human.js";
import { renderJson } from "../src/reporters/json.js";
import { createStyle } from "../src/reporters/style.js";
import { createRunner } from "../src/runners/index.js";
import { fixtureConfig, loadFrom } from "./helpers.js";

const ESC = String.fromCharCode(27);

async function sampleResult() {
  const loaded = await loadFrom(fixtureConfig({ variants: [{ id: "remove-db", type: "remove", memoryId: "db", expect: { minImpact: "high" } }] }));
  return runExperiment(loaded, { runner: createRunner(loaded) });
}

describe("human report", () => {
  it("contains task, memory change, impact, structured fields and the disclaimer", async () => {
    const text = renderExperiment(await sampleResult());
    assert.match(text, /Task:\s+Design the database architecture\./);
    assert.match(text, /Memory change:\s+Removed memory "db"/);
    assert.match(text, /Impact:\s+HIGH/);
    assert.match(text, /database\s+CHANGED\s+"PostgreSQL" → "MongoDB"/);
    assert.match(text, /hosting\s+UNCHANGED\s+"Vercel"/);
    assert.match(text, /Similarity\s+\d+\.\d%/);
    assert.match(text, /Expectation:\s+PASS/);
    assert.match(text, /not proof of causal attribution/);
    assert.ok(!text.includes(ESC), "no ANSI codes when color is off");
  });

  it("adds a line diff in verbose mode and ANSI codes when color is on", async () => {
    const result = await sampleResult();
    const verbose = renderExperiment(result, { verbose: true });
    assert.match(verbose, /Line diff/);
    assert.match(verbose, /^\s+- {3}"database": "PostgreSQL",$/m);
    assert.match(verbose, /^\s+\+ {3}"database": "MongoDB",$/m);
    assert.ok(renderExperiment(result, { color: true }).includes(`${ESC}[`));
  });

  it("lists experiments", async () => {
    const result = await sampleResult();
    assert.match(renderExperimentList([result]), new RegExp(result.experimentId));
    assert.equal(renderExperimentList([]), "No saved experiments.");
  });

  it("styles levels", () => {
    const s = createStyle(false);
    assert.equal(s.level("medium"), "MEDIUM");
  });
});

describe("JSON report", () => {
  it("round-trips the full experiment result", async () => {
    const result = await sampleResult();
    const parsed = JSON.parse(renderJson(result)) as typeof result;
    assert.equal(parsed.kind, "memimpact.experiment");
    assert.equal(parsed.schemaVersion, 1);
    assert.equal(parsed.variants[0]?.impact?.level, "high");
    assert.ok(parsed.variants[0]?.impact?.evidence.length);
    assert.equal(typeof parsed.variants[0]?.comparison?.noise.crossSimilarity, "number");
  });
});
