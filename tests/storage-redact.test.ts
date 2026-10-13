import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { looksLikeSecret, Redactor, REDACTED } from "../src/core/redact.js";
import { runExperiment } from "../src/experiments/run.js";
import { renderExperiment } from "../src/reporters/human.js";
import { createRunner } from "../src/runners/index.js";
import { applyArtifactPrivacy, listExperiments, loadExperiment, saveExperiment } from "../src/storage/artifacts.js";
import { fakeKey, fixtureConfig, loadFrom, tempDir } from "./helpers.js";

describe("secret redaction", () => {
  it("redacts values of named and secret-looking environment variables", () => {
    const redactor = new Redactor({
      envNames: ["CUSTOM_VAR"],
      env: { CUSTOM_VAR: "plain-value-123", OPENAI_API_KEY: "abcdefgh12345678", HOME: "/home/someone" },
    });
    const text = "key=plain-value-123 other=abcdefgh12345678 home=/home/someone";
    assert.equal(redactor.redact(text), `key=${REDACTED} other=${REDACTED} home=/home/someone`);
  });

  it("redacts well-known key formats even without env vars", () => {
    const redactor = new Redactor({ env: {} });
    const samples = [
      fakeKey("sk-", "proj-AbCdEfGhIjKlMnOpQrStUv"),
      fakeKey("gh", "p_abcdefghijklmnopqrstuvwxyz0123"),
      fakeKey("AI", "zaSyAbCdEfGhIjKlMnOpQrStUvWxYz0123456"),
      fakeKey("xo", "xb-1234567890-abcdef"),
      fakeKey("AK", "IAABCDEFGHIJKLMNOP"),
    ];
    for (const s of samples) {
      assert.equal(looksLikeSecret(s), true, s);
      assert.equal(redactor.redact(`token ${s} end`), `token ${REDACTED} end`, s);
    }
    assert.equal(redactor.redact("Authorization: Bearer abc.def.ghi-123456"), `Authorization: Bearer ${REDACTED}`);
    assert.equal(looksLikeSecret("User prefers PostgreSQL"), false);
    assert.equal(looksLikeSecret("The API uses Bearer authentication for every request."), false);
  });

  it("redacts deeply nested structures without mutating the input", () => {
    const redactor = new Redactor({ env: { MY_TOKEN: "supersecretvalue" } });
    const input = { a: ["x supersecretvalue y"], b: { c: "supersecretvalue", n: 1 } };
    const out = redactor.redactDeep(input);
    assert.deepEqual(out, { a: [`x ${REDACTED} y`], b: { c: REDACTED, n: 1 } });
    assert.equal(input.b.c, "supersecretvalue");
  });

  it("ignores short values to avoid false positives", () => {
    const redactor = new Redactor({ env: { API_KEY: "abc" } });
    assert.equal(redactor.redact("abc"), "abc");
  });
});

describe("run artifacts", () => {
  it("saves, lists and loads experiments with a protective .gitignore", async () => {
    const loaded = await loadFrom(fixtureConfig());
    const result = await runExperiment(loaded, { runner: createRunner(loaded) });
    const dir = path.join(tempDir(), "nested dir", ".memimpact");
    const { runFile, reportFile } = await saveExperiment(dir, result, renderExperiment(result));
    assert.ok(existsSync(runFile));
    assert.ok(existsSync(reportFile));
    assert.equal(path.dirname(runFile), path.join(dir, "runs"));
    assert.match(readFileSync(path.join(dir, ".gitignore"), "utf8"), /^\*$/m);
    const loadedBack = await loadExperiment(dir, result.experimentId);
    assert.deepEqual(loadedBack, JSON.parse(JSON.stringify(result)));
    const list = await listExperiments(dir);
    assert.equal(list.length, 1);
    await assert.rejects(loadExperiment(dir, "20990101-000000-000000"), /not found/);
    await assert.rejects(loadExperiment(dir, "../evil"), /Invalid experiment id/);
    assert.deepEqual(await listExperiments(path.join(dir, "missing")), []);
  });

  it("omits memory content and outputs when configured", async () => {
    const loaded = await loadFrom(
      fixtureConfig({
        variants: [{ id: "replace-db", type: "replace", memoryId: "db", content: "Secret replacement content" }],
      }),
    );
    const result = await runExperiment(loaded, { runner: createRunner(loaded) });
    const stored = applyArtifactPrivacy(result, { storeMemoryContent: false, storeOutputs: false });
    const text = JSON.stringify(stored);
    assert.doesNotMatch(text, /PostgreSQL over MongoDB/);
    assert.doesNotMatch(text, /Secret replacement content/);
    assert.doesNotMatch(text, /"database": "MongoDB"/);
    assert.match(text, /\[omitted sha256:[0-9a-f]{16} length:\d+\]/);
    assert.deepEqual(stored.privacy, { memoryContentStored: false, outputsStored: false });
    assert.ok(stored.variants[0]?.impact?.evidence.some((e) => e.includes("(values omitted)")));
    assert.match(JSON.stringify(result), /PostgreSQL over MongoDB/, "original result is untouched");
  });

  it("omits Markdown section titles taken from outputs", async () => {
    const loaded = await loadFrom(
      fixtureConfig({
        runner: {
          type: "fixture",
          rules: [
            { when: { memoryPresent: ["db"] }, output: "## Private heading alpha\nUse PostgreSQL." },
            { output: "## Private heading beta\nUse MongoDB." },
          ],
        },
      }),
    );
    const result = await runExperiment(loaded, { runner: createRunner(loaded) });
    assert.match(JSON.stringify(result), /Private heading/);
    const stored = applyArtifactPrivacy(result, { storeMemoryContent: true, storeOutputs: false });
    assert.doesNotMatch(JSON.stringify(stored), /Private heading/);
    assert.doesNotMatch(renderExperiment(stored), /Private heading/);
  });
});
