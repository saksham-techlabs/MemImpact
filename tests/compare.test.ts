import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { compareRunSets, estimateNoise } from "../src/compare/aggregate.js";
import { diffSequences, sequenceSimilarity } from "../src/compare/diff.js";
import { compareStructured, extractJson, flattenJson } from "../src/compare/structured.js";
import { distinctiveTerms } from "../src/compare/terms.js";
import { compareSections, compareText, normalizeText, textSimilarity, tokenizeWords } from "../src/compare/text.js";
import { compareToolCalls } from "../src/compare/tools.js";
import type { RunRecord, ToolCall } from "../src/types/index.js";

function lcsLength(a: string[], b: string[]): number {
  const w = b.length + 1;
  const dp = new Int32Array((a.length + 1) * w);
  const at = (i: number, j: number): number => dp[i * w + j] as number;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i * w + j] = a[i - 1] === b[j - 1] ? at(i - 1, j - 1) + 1 : Math.max(at(i - 1, j), at(i, j - 1));
    }
  }
  return at(a.length, b.length);
}

function seeded(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
}

function run(output: string, toolCalls?: ToolCall[], id = "r"): RunRecord {
  const r: RunRecord = { id, condition: "c", repetition: 1, startedAt: "", durationMs: 0, memoryIds: [], status: "ok", output };
  if (toolCalls) r.toolCalls = toolCalls;
  return r;
}

const options = { structured: "auto" as const, decisionPaths: [], ignorePaths: [] };

describe("diff", () => {
  it("matches a reference LCS on random sequences and reconstructs both inputs", () => {
    const rand = seeded(42);
    for (let trial = 0; trial < 200; trial++) {
      const alphabet = ["a", "b", "c", "d"];
      const make = (): string[] => Array.from({ length: Math.floor(rand() * 25) }, () => alphabet[Math.floor(rand() * alphabet.length)] as string);
      const a = make();
      const b = make();
      const result = diffSequences(a, b);
      assert.equal(result.matches, lcsLength(a, b), `trial ${trial}`);
      const rebuiltA = result.ops.filter((o) => o.type !== "insert").flatMap((o) => o.items);
      const rebuiltB = result.ops.filter((o) => o.type !== "delete").flatMap((o) => o.items);
      assert.deepEqual(rebuiltA, a);
      assert.deepEqual(rebuiltB, b);
    }
  });

  it("falls back to an approximation when the edit budget is exceeded", () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`);
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`);
    const result = diffSequences(a, b, 10);
    assert.equal(result.approximate, true);
    assert.equal(result.matches, 0);
  });

  it("computes sequence similarity", () => {
    assert.equal(sequenceSimilarity([], []).similarity, 1);
    assert.equal(sequenceSimilarity(["a", "b"], ["a", "b"]).similarity, 1);
    assert.equal(sequenceSimilarity(["a", "b"], ["c", "d"]).similarity, 0);
    assert.equal(sequenceSimilarity(["a", "b", "c", "d"], ["a", "b"]).similarity, (2 * 2) / 6);
  });
});

describe("text comparison", () => {
  it("detects exact and normalized equality", () => {
    const same = compareText("Hello world", "Hello world");
    assert.equal(same.identical, true);
    assert.equal(same.similarity, 1);
    const normalized = compareText("Hello   World\r\n", "hello world");
    assert.equal(normalized.identical, false);
    assert.equal(normalized.normalizedIdentical, true);
    assert.equal(normalized.similarity, 1);
    assert.equal(normalizeText("  A\r\n\r\n b  "), "a\nb");
  });

  it("counts line and word changes and length delta", () => {
    const t = compareText("line one\nline two\nline three", "line one\nline 2\nline three\nline four");
    assert.equal(t.lines.added, 2);
    assert.equal(t.lines.removed, 1);
    assert.equal(t.lines.unchanged, 2);
    assert.equal(t.words.added, 3);
    assert.equal(t.words.removed, 1);
    assert.equal(t.length.deltaChars, t.length.variantChars - t.length.baselineChars);
    assert.ok(t.length.deltaPercent !== null && t.length.deltaPercent > 0);
  });

  it("reports significant differences with low similarity", () => {
    const t = compareText("PostgreSQL relational schema with strict consistency", "MongoDB document collections with flexible schema");
    assert.ok(t.similarity < 0.5, `similarity ${t.similarity}`);
  });

  it("handles empty outputs", () => {
    const t = compareText("", "");
    assert.equal(t.similarity, 1);
    assert.equal(t.length.deltaPercent, null);
    assert.equal(compareText("", "something").similarity, 0);
  });

  it("tokenizes words including technical terms", () => {
    assert.deepEqual(tokenizeWords("Use Node.js and C# with PostgreSQL-16!"), ["use", "node.js", "and", "c#", "with", "postgresql-16"]);
  });

  it("compares markdown sections", () => {
    const a = "# Intro\nhello\n## Database\nPostgreSQL\n## Hosting\nVercel";
    const b = "# Intro\nhello\n## Database\nMongoDB\n## Caching\nRedis";
    const sections = compareSections(a, b);
    assert.ok(sections);
    const byTitle = Object.fromEntries(sections.map((s) => [s.title, s.status]));
    assert.equal(byTitle["Intro"], "unchanged");
    assert.equal(byTitle["Database"], "changed");
    assert.equal(byTitle["Hosting"], "removed");
    assert.equal(byTitle["Caching"], "added");
    assert.equal(compareSections("plain", "text"), null);
  });

  it("textSimilarity is symmetric", () => {
    const a = "the quick brown fox jumps";
    const b = "the slow brown dog jumps high";
    assert.equal(textSimilarity(a, b), textSimilarity(b, a));
  });
});

describe("structured comparison", () => {
  it("extracts JSON from raw output or fenced blocks", () => {
    assert.deepEqual(extractJson('{"a":1}'), { a: 1 });
    assert.deepEqual(extractJson('Here you go:\n```json\n{"a": [1, 2]}\n```\nThanks'), { a: [1, 2] });
    assert.equal(extractJson("no json here"), undefined);
    assert.equal(extractJson("{ broken"), undefined);
    assert.equal(extractJson("42"), undefined);
  });

  it("flattens nested JSON into leaf paths", () => {
    const flat = flattenJson({ a: { b: 1, "odd key": true }, list: [{ name: "x" }], empty: {}, none: [] });
    assert.deepEqual(Object.fromEntries(flat), {
      "a.b": "1",
      'a["odd key"]': "true",
      "list[0].name": '"x"',
      empty: "{}",
      none: "[]",
    });
  });

  it("reports changed and unchanged fields", () => {
    const { fields } = compareStructured([{ database: "PostgreSQL", hosting: "Vercel" }], [{ database: "MongoDB", hosting: "Vercel" }], options);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    assert.equal(byPath["database"]?.status, "changed");
    assert.deepEqual(byPath["database"]?.baseline, [{ value: '"PostgreSQL"', count: 1 }]);
    assert.deepEqual(byPath["database"]?.variant, [{ value: '"MongoDB"', count: 1 }]);
    assert.equal(byPath["hosting"]?.status, "unchanged");
  });

  it("reports added, removed and mixed fields across repetitions", () => {
    const { fields } = compareStructured(
      [
        { a: 1, gone: true, noisy: "x" },
        { a: 1, gone: true, noisy: "y" },
      ],
      [
        { a: 1, added: 2, noisy: "x" },
        { a: 1, added: 2, noisy: "x" },
      ],
      options,
    );
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f.status]));
    const same = compareStructured([{ n: "x" }, { n: "y" }], [{ n: "y" }, { n: "x" }], options);
    assert.equal(same.fields[0]?.status, "unchanged", "identical value sets are unchanged even when they vary");
    assert.equal(same.fields[0]?.consistent, false);
    assert.equal(byPath["gone"], "removed");
    assert.equal(byPath["added"], "added");
    assert.equal(byPath["noisy"], "mixed");
    assert.equal(byPath["a"], "unchanged");
  });

  it("honours decision and ignore paths", () => {
    const { fields, ignoredPaths } = compareStructured(
      [{ db: { engine: "pg" }, note: "a", ts: 1 }],
      [{ db: { engine: "mongo" }, note: "b", ts: 2 }],
      { decisionPaths: ["db"], ignorePaths: ["ts"] },
    );
    assert.deepEqual(ignoredPaths, ["ts"]);
    const byPath = Object.fromEntries(fields.map((f) => [f.path, f]));
    assert.equal(byPath["db.engine"]?.decision, true);
    assert.equal(byPath["note"]?.decision, false);
    assert.equal(byPath["ts"], undefined);
  });
});

describe("tool-call comparison", () => {
  it("returns null without tool data", () => {
    assert.equal(compareToolCalls([undefined], [undefined]), null);
  });

  it("detects changed and unchanged tool sequences", () => {
    const search: ToolCall = { name: "search", arguments: { q: "postgres" } };
    const unchanged = compareToolCalls([[search]], [[search]]);
    assert.equal(unchanged?.status, "unchanged");
    const changed = compareToolCalls([[search]], [[{ name: "fetch_docs" }]]);
    assert.equal(changed?.status, "changed");
    assert.deepEqual(changed?.addedTools, ["fetch_docs"]);
    assert.deepEqual(changed?.removedTools, ["search"]);
    const args = compareToolCalls([[search]], [[{ name: "search", arguments: { q: "mongo" } }]]);
    assert.equal(args?.status, "changed");
  });
});

describe("distinctive terms", () => {
  it("keeps only terms consistent across all repetitions", () => {
    const terms = distinctiveTerms(["use postgresql for storage", "postgresql works for storage"], ["use mongodb for storage", "mongodb is good storage"]);
    assert.deepEqual(terms.baselineOnly, ["postgresql"]);
    assert.deepEqual(terms.variantOnly, ["mongodb"]);
  });
});

describe("aggregate comparison", () => {
  it("estimates noise from repetitions", () => {
    const noise = estimateNoise(["a b c d", "a b c e"], ["x y z w", "x y z w"]);
    assert.ok(noise.baselineSelfSimilarity !== null && noise.baselineSelfSimilarity < 1);
    assert.equal(noise.variantSelfSimilarity, 1);
    assert.ok(noise.noiseFloor !== null && noise.noiseFloor > 0);
    assert.ok(noise.adjustedDistance < noise.rawDistance);
  });

  it("has unknown noise with single runs", () => {
    const noise = estimateNoise(["a"], ["b"]);
    assert.equal(noise.noiseFloor, null);
    assert.equal(noise.adjustedDistance, noise.rawDistance);
  });

  it("ignores failed runs and compares structured outputs", () => {
    const failed: RunRecord = { ...run(""), status: "error", error: "boom" };
    delete failed.output;
    const c = compareRunSets([run('{"db":"pg"}'), failed], [run('{"db":"mongo"}')], options);
    assert.equal(c.runs.baseline, 1);
    assert.equal(c.structured?.fields[0]?.status, "changed");
  });

  it("skips structured comparison when not all outputs are JSON", () => {
    const c = compareRunSets([run('{"db":"pg"}')], [run("plain text")], options);
    assert.equal(c.structured, null);
    assert.match(c.structuredNote ?? "", /skipped/);
    const never = compareRunSets([run('{"db":"pg"}')], [run('{"db":"x"}')], { ...options, structured: "never" });
    assert.equal(never.structured, null);
  });

  it("throws without successful runs", () => {
    assert.throws(() => compareRunSets([], [run("x")], options));
  });
});
