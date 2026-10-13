import assert from "node:assert/strict";
import path from "node:path";
import { describe, it } from "node:test";
import { loadConfig } from "../src/config/load.js";
import { validateConfig } from "../src/config/validate.js";
import { ConfigError } from "../src/core/errors.js";
import { fakeKey, fixtureConfig, tempDir, writeJson } from "./helpers.js";

function issues(raw: unknown): string[] {
  return validateConfig(raw).issues.map((i) => `${i.path}: ${i.message}`);
}

function expectIssue(raw: unknown, pattern: RegExp): void {
  const list = issues(raw);
  assert.ok(list.some((i) => pattern.test(i)), `expected an issue matching ${pattern}, got:\n${list.join("\n")}`);
}

describe("config validation", () => {
  it("accepts a valid config and applies defaults", () => {
    const result = validateConfig(fixtureConfig({ repetitions: undefined }));
    assert.deepEqual(result.issues, []);
    assert.ok(result.config);
    assert.equal(result.config.repetitions, 1);
    assert.equal(result.config.compare.structured, "auto");
    assert.deepEqual(result.config.impact.thresholds, { low: 0.05, medium: 0.2, high: 0.5 });
    assert.equal(result.config.artifacts.dir, ".memimpact");
    assert.equal(result.config.artifacts.save, true);
  });

  it("rejects non-object configs", () => {
    expectIssue([], /config must be a JSON object/);
    expectIssue(null, /config must be a JSON object/);
  });

  it("requires version, task, memories, variants and runner", () => {
    const list = issues({});
    for (const key of ["version", "task", "memories", "variants", "runner"]) {
      assert.ok(list.some((i) => i.startsWith(`${key}:`)), `missing issue for ${key}: ${list.join("; ")}`);
    }
  });

  it("rejects unsupported versions and unknown keys", () => {
    expectIssue(fixtureConfig({ version: 2 }), /version: unsupported/);
    expectIssue(fixtureConfig({ tasks: "x" }), /unknown property "tasks"/);
    expectIssue(fixtureConfig({ runner: { type: "fixture", rules: [{ output: "x" }], extra: 1 } }), /runner\.extra: unknown property/);
  });

  it("rejects empty task", () => {
    expectIssue(fixtureConfig({ task: "   " }), /task: must not be empty/);
  });

  it("rejects duplicate memory ids", () => {
    expectIssue(
      fixtureConfig({ memories: [{ id: "a", content: "x" }, { id: "a", content: "y" }], variants: [] }),
      /memories\[1\]\.id: duplicate memory id "a"/,
    );
  });

  it("rejects invalid memory ids and empty content", () => {
    expectIssue(fixtureConfig({ memories: [{ id: "has space", content: "x" }], variants: [] }), /memories\[0\]\.id/);
    expectIssue(fixtureConfig({ memories: [{ id: "ok", content: "" }], variants: [] }), /memories\[0\]\.content: must not be empty/);
  });

  it("rejects duplicate and reserved variant ids", () => {
    expectIssue(
      fixtureConfig({
        variants: [
          { id: "v", type: "remove", memoryId: "db" },
          { id: "v", type: "remove", memoryId: "tz" },
        ],
      }),
      /duplicate variant id "v"/,
    );
    expectIssue(fixtureConfig({ variants: [{ id: "baseline", type: "remove", memoryId: "db" }] }), /"baseline" is reserved/);
  });

  it("rejects variants referencing unknown memories", () => {
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "remove", memoryId: "nope" }] }), /unknown memory id "nope"/);
  });

  it("validates replace, modify and add variants", () => {
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "replace", memoryId: "db" }] }), /variants\[0\]\.content: is required/);
    expectIssue(
      fixtureConfig({ variants: [{ id: "v", type: "replace", memoryId: "db", content: "User prefers PostgreSQL over MongoDB." }] }),
      /identical to the original/,
    );
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "modify", memoryId: "db", find: "Oracle", replaceWith: "x" }] }), /does not occur/);
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "modify", memoryId: "db", find: "PostgreSQL" }] }), /replaceWith: is required/);
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "add", memory: { id: "db", content: "dup" } }] }), /already exists/);
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "explode", memoryId: "db" }] }), /type: must be one of/);
    const ok = validateConfig(
      fixtureConfig({
        variants: [
          { id: "r", type: "replace", memoryId: "db", content: "User prefers MySQL." },
          { id: "m", type: "modify", memoryId: "db", find: "PostgreSQL", replaceWith: "MySQL" },
          { id: "a", type: "add", memory: { id: "new", content: "User likes Redis." } },
        ],
      }),
    );
    assert.deepEqual(ok.issues, []);
    assert.equal(ok.config?.variants.length, 3);
  });

  it("validates expectations", () => {
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "remove", memoryId: "db", expect: {} }] }), /must set "minImpact"/);
    expectIssue(
      fixtureConfig({ variants: [{ id: "v", type: "remove", memoryId: "db", expect: { minImpact: "high", maxImpact: "low" } }] }),
      /minImpact must not be greater/,
    );
    expectIssue(fixtureConfig({ variants: [{ id: "v", type: "remove", memoryId: "db", expect: { minImpact: "huge" } }] }), /must be one of/);
  });

  it("validates runners", () => {
    expectIssue(fixtureConfig({ runner: { type: "magic" } }), /runner\.type: must be one of/);
    expectIssue(fixtureConfig({ runner: { type: "fixture", rules: [] } }), /non-empty array of rules/);
    expectIssue(fixtureConfig({ runner: { type: "fixture", rules: [{}] } }), /exactly one of "output" or "outputs"/);
    expectIssue(fixtureConfig({ runner: { type: "openai-compatible", model: "m" } }), /baseUrl: is required/);
    expectIssue(fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "not a url", model: "m" } }), /valid absolute URL/);
    expectIssue(fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "ftp://x", model: "m" } }), /http or https/);
    expectIssue(fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "https://u:p@x.test", model: "m" } }), /must not contain credentials/);
    expectIssue(fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "https://x.test/v1", model: "m", temperature: 5 } }), /temperature: must be <= 2/);
    expectIssue(fixtureConfig({ runner: { type: "command" } }), /command: is required/);
    expectIssue(fixtureConfig({ runner: { type: "command", command: "node", args: [1] } }), /args\[0\]: must be a string/);
    expectIssue(fixtureConfig({ runner: { type: "command", command: "node", protocol: "xml" } }), /protocol: must be one of/);
  });

  it("validates repetitions, thresholds and compare options", () => {
    expectIssue(fixtureConfig({ repetitions: 0 }), /repetitions: must be >= 1/);
    expectIssue(fixtureConfig({ repetitions: 51 }), /repetitions: must be <= 50/);
    expectIssue(fixtureConfig({ repetitions: 1.5 }), /must be an integer/);
    expectIssue(fixtureConfig({ impact: { thresholds: { low: 0.5, medium: 0.2 } } }), /low < medium < high/);
    expectIssue(fixtureConfig({ compare: { structured: "sometimes" } }), /compare\.structured/);
  });

  it("rejects secrets in config values and credential headers", () => {
    expectIssue(
      fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "https://x.test/v1", model: "m", apiKeyEnv: fakeKey("sk-", "abcdefghijklmnopqrstuvwxyz123456") } }),
      /looks like an API key/,
    );
    expectIssue(fixtureConfig({ description: `key ${fakeKey("sk-", "proj-abcdefghijklmnopqrstu1234")}` }), /description: looks like an API key/);
    expectIssue(
      fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "https://x.test/v1", model: "m", headers: { Authorization: "abc" } } }),
      /credential headers are not allowed/,
    );
    expectIssue(fixtureConfig({ runner: { type: "command", command: "node", env: { OPENAI_API_KEY: "x" } } }), /secret-looking variables/);
  });

  it("warns about single repetitions and non-zero temperature for real models", () => {
    const result = validateConfig(
      fixtureConfig({ repetitions: 1, runner: { type: "openai-compatible", baseUrl: "http://localhost:1/v1", model: "m", temperature: 0.7 } }),
    );
    assert.deepEqual(result.issues, []);
    assert.equal(result.warnings.length, 2);
  });
});

describe("config loading", () => {
  it("loads a config file and resolves paths relative to it", async () => {
    const dir = tempDir();
    const file = writeJson(path.join(dir, "memimpact.config.json"), fixtureConfig());
    const loaded = await loadConfig(file);
    assert.equal(loaded.baseDir, dir);
    assert.equal(loaded.configHash.length, 64);
  });

  it("loads memories from memoriesFile (array or {memories})", async () => {
    const dir = tempDir();
    writeJson(path.join(dir, "mem.json"), { memories: [{ id: "db", content: "User prefers PostgreSQL over MongoDB." }] });
    const cfg = fixtureConfig({ memories: undefined, memoriesFile: "mem.json", variants: [{ id: "v", type: "remove", memoryId: "db" }] });
    writeJson(path.join(dir, "memimpact.config.json"), cfg);
    const loaded = await loadConfig("memimpact.config.json", dir);
    assert.equal(loaded.config.memories.length, 1);
    assert.equal(loaded.config.memories[0]?.id, "db");
  });

  it("reports missing files, bad JSON and invalid configs as ConfigError", async () => {
    const dir = tempDir();
    await assert.rejects(loadConfig("missing.json", dir), (e: unknown) => e instanceof ConfigError && /not found/.test(e.message));
    const bad = path.join(dir, "bad.json");
    (await import("node:fs")).writeFileSync(bad, "{ nope", "utf8");
    await assert.rejects(loadConfig(bad), (e: unknown) => e instanceof ConfigError && /not valid JSON/.test(e.message));
    const invalid = writeJson(path.join(dir, "invalid.json"), { version: 1 });
    await assert.rejects(loadConfig(invalid), (e: unknown) => e instanceof ConfigError && e.details.length > 0);
  });

  it("accepts a UTF-8 BOM", async () => {
    const dir = tempDir();
    const file = path.join(dir, "bom.json");
    (await import("node:fs")).writeFileSync(file, `\uFEFF${JSON.stringify(fixtureConfig())}`, "utf8");
    const loaded = await loadConfig(file);
    assert.equal(loaded.config.task, "Design the database architecture.");
  });
});
