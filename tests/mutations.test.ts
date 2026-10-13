import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyVariant, autoRemoveVariant, describeVariant } from "../src/mutations/apply.js";
import { renderPrompt } from "../src/runners/prompt.js";
import type { Memory } from "../src/types/index.js";

const memories: Memory[] = [
  { id: "db", content: "User prefers PostgreSQL over MongoDB.", tags: ["stack"] },
  { id: "hosting", content: "Project is deployed on Vercel." },
];

describe("memory mutations", () => {
  it("remove drops exactly one memory", () => {
    const result = applyVariant(memories, { id: "v", type: "remove", memoryId: "db" });
    assert.deepEqual(
      result.map((m) => m.id),
      ["hosting"],
    );
  });

  it("replace swaps content but keeps id and position", () => {
    const result = applyVariant(memories, { id: "v", type: "replace", memoryId: "db", content: "User prefers MySQL." });
    assert.equal(result[0]?.id, "db");
    assert.equal(result[0]?.content, "User prefers MySQL.");
    assert.equal(result[1]?.content, "Project is deployed on Vercel.");
  });

  it("modify replaces every occurrence of the literal text", () => {
    const input: Memory[] = [{ id: "x", content: "a.b a.b" }];
    const result = applyVariant(input, { id: "v", type: "modify", memoryId: "x", find: "a.b", replaceWith: "c" });
    assert.equal(result[0]?.content, "c c");
  });

  it("add appends a new memory", () => {
    const result = applyVariant(memories, { id: "v", type: "add", memory: { id: "cache", content: "Use Redis." } });
    assert.deepEqual(
      result.map((m) => m.id),
      ["db", "hosting", "cache"],
    );
  });

  it("never mutates the input memories", () => {
    const snapshot = structuredClone(memories);
    applyVariant(memories, { id: "v", type: "remove", memoryId: "db" });
    applyVariant(memories, { id: "v", type: "replace", memoryId: "db", content: "x" });
    const modified = applyVariant(memories, { id: "v", type: "modify", memoryId: "db", find: "PostgreSQL", replaceWith: "MySQL" });
    modified[0]?.tags?.push("mutated");
    assert.deepEqual(memories, snapshot);
  });

  it("throws on unknown memory ids and missing find text", () => {
    assert.throws(() => applyVariant(memories, { id: "v", type: "remove", memoryId: "nope" }), /unknown memory/);
    assert.throws(() => applyVariant(memories, { id: "v", type: "modify", memoryId: "db", find: "Oracle", replaceWith: "x" }), /not found/);
    assert.throws(() => applyVariant(memories, { id: "v", type: "add", memory: { id: "db", content: "x" } }), /already exists/);
  });

  it("describes variants for humans", () => {
    assert.equal(describeVariant({ id: "v", type: "remove", memoryId: "db" }), 'Removed memory "db"');
    assert.match(describeVariant({ id: "v", type: "modify", memoryId: "db", find: "a", replaceWith: "b" }), /Modified memory "db": "a" → "b"/);
  });

  it("generates unique automatic remove variants", () => {
    const taken = new Set(["auto-remove-db"]);
    const v = autoRemoveVariant("db", taken);
    assert.equal(v.type, "remove");
    assert.notEqual(v.id, "auto-remove-db");
  });
});

describe("prompt rendering", () => {
  it("includes system text and memory content but not memory ids", () => {
    const prompt = renderPrompt({ task: "Do it", system: "Be helpful.", memories });
    assert.equal(prompt.user, "Do it");
    assert.match(prompt.system, /^Be helpful\./);
    assert.match(prompt.system, /- User prefers PostgreSQL over MongoDB\./);
    assert.doesNotMatch(prompt.system, /\bdb\b/);
  });

  it("omits the memory block when there are no memories", () => {
    assert.equal(renderPrompt({ task: "t", memories: [] }).system, "");
  });
});
