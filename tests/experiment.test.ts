import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createExperimentId, EXPERIMENT_ID_PATTERN, runExperiment, selectVariants } from "../src/experiments/run.js";
import { createRunner } from "../src/runners/index.js";
import type { RunInput, Runner, RunnerResult } from "../src/types/index.js";
import { fixtureConfig, loadFrom } from "./helpers.js";

describe("experiment execution", () => {
  it("runs the baseline and every variant with repetitions", async () => {
    const loaded = await loadFrom(fixtureConfig({ repetitions: 3 }));
    const events: string[] = [];
    const result = await runExperiment(loaded, {
      runner: createRunner(loaded),
      onProgress: (e) => {
        if (e.type === "run-end") events.push(`${e.condition}#${e.repetition}`);
      },
    });
    assert.equal(result.kind, "memimpact.experiment");
    assert.match(result.experimentId, EXPERIMENT_ID_PATTERN);
    assert.equal(result.baseline.runs.length, 3);
    assert.deepEqual(result.baseline.memoryIds, ["db", "hosting", "tz"]);
    assert.equal(result.variants.length, 2);
    assert.equal(events.length, 9);

    const removeDb = result.variants.find((v) => v.id === "remove-db");
    assert.ok(removeDb?.impact);
    assert.deepEqual(removeDb.memoryIds, ["hosting", "tz"]);
    assert.equal(removeDb.impact.level, "high");
    assert.equal(removeDb.impact.attribution, "above-noise");
    const field = removeDb.comparison?.structured?.fields.find((f) => f.path === "database");
    assert.equal(field?.status, "changed");
    assert.deepEqual(field?.baseline, [{ value: '"PostgreSQL"', count: 3 }]);
    assert.deepEqual(field?.variant, [{ value: '"MongoDB"', count: 3 }]);

    const removeTz = result.variants.find((v) => v.id === "remove-tz");
    assert.equal(removeTz?.impact?.level, "none");

    assert.equal(result.summary.highest, "high");
    assert.deepEqual(result.summary.byLevel, { none: 1, low: 0, medium: 0, high: 1 });
    assert.equal(result.summary.failedRuns, 0);
    assert.equal(result.runner.type, "fixture");
    assert.equal(result.config.file, "memimpact.config.json");
    assert.match(result.disclaimer, /not proof of causal attribution/);
  });

  it("executes replace and modify variants against copies of memory", async () => {
    const loaded = await loadFrom(
      fixtureConfig({
        variants: [
          { id: "replace-db", type: "replace", memoryId: "db", content: "User has no database preference." },
          { id: "modify-db", type: "modify", memoryId: "db", find: "PostgreSQL over MongoDB", replaceWith: "MongoDB over PostgreSQL" },
          { id: "add-cache", type: "add", memory: { id: "cache", content: "User likes Redis." } },
        ],
      }),
    );
    const seen: RunInput[] = [];
    const inner = createRunner(loaded);
    const spy: Runner = {
      info: () => inner.info(),
      run: (input) => {
        seen.push(input);
        return inner.run(input);
      },
    };
    const result = await runExperiment(loaded, { runner: spy, repetitions: 1 });
    const contexts = seen.map((i) => i.memories.map((m) => m.content).join(" | "));
    assert.ok(contexts.some((c) => c.includes("User has no database preference.")));
    assert.ok(contexts.some((c) => c.includes("User prefers MongoDB over PostgreSQL.")));
    assert.ok(contexts.some((c) => c.includes("User likes Redis.")));
    assert.equal(loaded.config.memories[0]?.content, "User prefers PostgreSQL over MongoDB.");
    assert.equal(result.variants.find((v) => v.id === "replace-db")?.impact?.level, "high");
    assert.equal(result.variants.find((v) => v.id === "modify-db")?.impact?.level, "high");
    assert.equal(result.variants.find((v) => v.id === "add-cache")?.impact?.level, "none");
    assert.equal(result.variants.find((v) => v.id === "add-cache")?.impact?.attribution, "no-difference");
  });

  it("records runner failures without aborting the experiment", async () => {
    const loaded = await loadFrom(fixtureConfig());
    let calls = 0;
    const flaky: Runner = {
      info: () => ({ type: "command", external: false, deterministic: false }),
      run: async (): Promise<RunnerResult> => {
        calls++;
        if (calls === 3) throw new Error("provider hiccup");
        return { output: "same answer" };
      },
    };
    const result = await runExperiment(loaded, { runner: flaky, repetitions: 2 });
    assert.equal(result.summary.failedRuns, 1);
    const failed = result.variants.flatMap((v) => v.runs).find((r) => r.status === "error");
    assert.equal(failed?.error, "provider hiccup");
    assert.ok(result.variants.every((v) => v.impact));
  });

  it("skips variants when every baseline run fails", async () => {
    const loaded = await loadFrom(fixtureConfig());
    const broken: Runner = {
      info: () => ({ type: "command", external: false, deterministic: false }),
      run: async () => {
        throw new Error("down");
      },
    };
    const result = await runExperiment(loaded, { runner: broken, repetitions: 1 });
    assert.equal(result.summary.variantErrors, 2);
    assert.ok(result.variants.every((v) => v.error?.includes("baseline")));
  });

  it("evaluates expectations", async () => {
    const loaded = await loadFrom(
      fixtureConfig({
        variants: [
          { id: "remove-db", type: "remove", memoryId: "db", expect: { minImpact: "high" } },
          { id: "remove-tz", type: "remove", memoryId: "tz", expect: { minImpact: "medium" } },
        ],
      }),
    );
    const result = await runExperiment(loaded, { runner: createRunner(loaded) });
    assert.equal(result.variants[0]?.expectation?.passed, true);
    assert.equal(result.variants[1]?.expectation?.passed, false);
    assert.equal(result.summary.expectationsFailed, 1);
  });
});

describe("variant selection", () => {
  it("selects configured variants by default and filters by --variant", async () => {
    const loaded = await loadFrom(fixtureConfig());
    assert.deepEqual(
      selectVariants(loaded, {}).map((s) => s.variant.id),
      ["remove-db", "remove-tz"],
    );
    assert.deepEqual(
      selectVariants(loaded, { variantIds: ["remove-tz"] }).map((s) => s.variant.id),
      ["remove-tz"],
    );
    assert.throws(() => selectVariants(loaded, { variantIds: ["nope"] }), /Unknown variant/);
  });

  it("--memory uses targeting variants or generates an automatic remove", async () => {
    const loaded = await loadFrom(fixtureConfig());
    assert.deepEqual(
      selectVariants(loaded, { memoryIds: ["db"] }).map((s) => s.variant.id),
      ["remove-db"],
    );
    const auto = selectVariants(loaded, { memoryIds: ["hosting"] });
    assert.equal(auto[0]?.auto, true);
    assert.equal(auto[0]?.variant.id, "auto-remove-hosting");
    assert.throws(() => selectVariants(loaded, { memoryIds: ["nope"] }), /Unknown memory/);
  });

  it("--all adds leave-one-out removals for uncovered memories", async () => {
    const loaded = await loadFrom(fixtureConfig());
    assert.deepEqual(
      selectVariants(loaded, { all: true }).map((s) => s.variant.id),
      ["remove-db", "remove-tz", "auto-remove-hosting"],
    );
  });

  it("errors when there is nothing to run", async () => {
    const loaded = await loadFrom(fixtureConfig({ variants: [] }));
    assert.throws(() => selectVariants(loaded, {}), /No variants to run/);
    assert.equal(selectVariants(loaded, { all: true }).length, 3);
  });

  it("creates sortable experiment ids", () => {
    const id = createExperimentId(new Date("2026-10-14T01:02:03Z"));
    assert.match(id, /^20261014-010203-[a-f0-9]{6}$/);
  });
});
