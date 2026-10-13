import assert from "node:assert/strict";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { VERSION } from "../src/core/version.js";
import { fixtureConfig, REPO_ROOT, runCliInProcess, runCliProcess, tempDir, writeJson } from "./helpers.js";

describe("CLI basics (real process)", () => {
  it("--version prints the package version", () => {
    const r = runCliProcess(["--version"], { cwd: tempDir() });
    assert.equal(r.code, 0);
    assert.equal(r.stdout.trim(), VERSION);
    const pkg = JSON.parse(readFileSync(path.join(REPO_ROOT, "package.json"), "utf8")) as { version: string };
    assert.equal(VERSION, pkg.version);
  });

  it("--help and help <command> print usage", () => {
    const cwd = tempDir();
    const main = runCliProcess(["--help"], { cwd });
    assert.equal(main.code, 0);
    assert.match(main.stdout, /Commands:/);
    assert.match(main.stdout, /Exit codes:/);
    const runHelp = runCliProcess(["help", "run"], { cwd });
    assert.match(runHelp.stdout, /--fail-on/);
    const flagHelp = runCliProcess(["compare", "--help"], { cwd });
    assert.match(flagHelp.stdout, /run reference/);
  });

  it("exits 2 for unknown commands and options", () => {
    const cwd = tempDir();
    const unknown = runCliProcess(["explode"], { cwd });
    assert.equal(unknown.code, 2);
    assert.match(unknown.stderr, /Unknown command "explode"/);
    const badFlag = runCliProcess(["run", "--bogus"], { cwd });
    assert.equal(badFlag.code, 2);
    assert.match(badFlag.stderr, /Unknown option/);
    const extra = runCliProcess(["validate", "extra"], { cwd });
    assert.equal(extra.code, 2);
  });
});

describe("memimpact init", () => {
  it("creates a runnable fixture config and refuses to overwrite without --force", () => {
    const cwd = tempDir();
    const first = runCliProcess(["init"], { cwd });
    assert.equal(first.code, 0, first.stderr);
    assert.ok(existsSync(path.join(cwd, "memimpact.config.json")));
    const again = runCliProcess(["init"], { cwd });
    assert.equal(again.code, 2);
    assert.match(again.stderr, /already exists/);
    assert.equal(runCliProcess(["init", "--force"], { cwd }).code, 0);
    assert.equal(runCliProcess(["validate"], { cwd }).code, 0);
  });

  it("creates valid templates for every runner", () => {
    for (const runner of ["openai-compatible", "command"]) {
      const cwd = tempDir();
      const r = runCliProcess(["init", "--runner", runner], { cwd });
      assert.equal(r.code, 0, r.stderr);
      const v = runCliProcess(["validate", "--json"], { cwd });
      assert.equal(v.code, 0, v.stdout);
      const config = readFileSync(path.join(cwd, "memimpact.config.json"), "utf8");
      assert.doesNotMatch(config, /sk-|Bearer/);
    }
    assert.equal(runCliProcess(["init", "--runner", "nope"], { cwd: tempDir() }).code, 2);
  });

  it("the command template runs end-to-end with its sample agent", () => {
    const cwd = tempDir();
    runCliProcess(["init", "--runner", "command"], { cwd });
    const r = runCliProcess(["run", "--json"], { cwd });
    assert.equal(r.code, 0, r.stderr + r.stdout);
    const result = JSON.parse(r.stdout) as { variants: { id: string; impact: { level: string }; comparison: { tools: { status: string } } }[] };
    const removeDb = result.variants.find((v) => v.id === "remove-db-preference");
    assert.equal(removeDb?.impact.level, "high");
    assert.equal(removeDb?.comparison.tools.status, "changed");
  });
});

describe("memimpact validate", () => {
  it("reports invalid configs with exit code 2 and a JSON error", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig({ memories: [{ id: "a", content: "x" }, { id: "a", content: "y" }], variants: [] }));
    const human = runCliProcess(["validate"], { cwd });
    assert.equal(human.code, 2);
    assert.match(human.stderr, /duplicate memory id "a"/);
    const json = runCliProcess(["validate", "--json"], { cwd });
    assert.equal(json.code, 2);
    const parsed = JSON.parse(json.stdout) as { error: { kind: string; details: string[] } };
    assert.equal(parsed.error.kind, "config");
    assert.ok(parsed.error.details.some((d) => d.includes("duplicate")));
  });

  it("reports a missing config", () => {
    const r = runCliProcess(["validate"], { cwd: tempDir() });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /memimpact init/);
  });
});

describe("memimpact run", () => {
  it("runs, prints a report, saves artifacts and exits 0", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const r = runCliProcess(["run"], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Impact:\s+HIGH/);
    assert.match(r.stdout, /Saved: \.memimpact[\\/]runs[\\/]\d{8}-\d{6}-[a-f0-9]{6}\.json/);
    assert.match(r.stderr, /baseline #1\/2 ok/);
    const runs = readdirSync(path.join(cwd, ".memimpact", "runs"));
    assert.equal(runs.length, 1);
    assert.equal(readdirSync(path.join(cwd, ".memimpact", "reports")).length, 1);
  });

  it("--json prints only JSON on stdout and --no-save writes nothing", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const r = runCliProcess(["run", "--json", "--no-save"], { cwd });
    assert.equal(r.code, 0, r.stderr);
    const parsed = JSON.parse(r.stdout) as { kind: string; summary: { highest: string } };
    assert.equal(parsed.kind, "memimpact.experiment");
    assert.equal(parsed.summary.highest, "high");
    assert.equal(existsSync(path.join(cwd, ".memimpact")), false);
  });

  it("supports --config with paths containing spaces and resolves artifacts next to the config", () => {
    const cwd = tempDir();
    const sub = path.join(cwd, "my project", "configs");
    mkdirSync(sub, { recursive: true });
    writeJson(path.join(sub, "exp.json"), fixtureConfig({ artifacts: { dir: "out dir" } }));
    const r = runCliProcess(["run", "-c", path.join("my project", "configs", "exp.json"), "-q"], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.ok(existsSync(path.join(sub, "out dir", "runs")));
    const list = runCliProcess(["list", "-c", path.join("my project", "configs", "exp.json")], { cwd });
    assert.match(list.stdout, /1 experiment\(s\)/);
  });

  it("--fail-on exits 1 when the threshold is reached", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const r = runCliProcess(["run", "--fail-on", "high", "--no-save"], { cwd });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--fail-on high/);
    assert.equal(runCliProcess(["run", "--fail-on", "high", "--variant", "remove-tz", "--no-save"], { cwd }).code, 0);
    assert.equal(runCliProcess(["run", "--fail-on", "none", "--no-save"], { cwd }).code, 2);
  });

  it("exits 1 when an expectation fails", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig({ variants: [{ id: "remove-tz", type: "remove", memoryId: "tz", expect: { minImpact: "high" } }] }));
    const r = runCliProcess(["run", "--no-save"], { cwd });
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Expectation:\s+FAIL/);
  });

  it("exits 2 when runner calls fail", () => {
    const cwd = tempDir();
    writeFileSync(path.join(cwd, "crash.mjs"), "process.exit(1)", "utf8");
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig({ runner: { type: "command", command: process.execPath, args: ["crash.mjs"] }, repetitions: 1 }));
    const r = runCliProcess(["run", "--no-save"], { cwd });
    assert.equal(r.code, 2);
    assert.match(r.stdout + r.stderr, /exited with code 1/);
  });

  it("--memory, --all, --variant and --repetitions select what runs", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const parse = (args: string[]) => JSON.parse(runCliProcess(["run", "--json", "--no-save", ...args], { cwd }).stdout) as { repetitions: number; variants: { id: string; auto: boolean }[] };
    assert.deepEqual(
      parse(["--memory", "hosting"]).variants.map((v) => [v.id, v.auto]),
      [["auto-remove-hosting", true]],
    );
    assert.deepEqual(
      parse(["--all"]).variants.map((v) => v.id),
      ["remove-db", "remove-tz", "auto-remove-hosting"],
    );
    assert.deepEqual(
      parse(["--variant", "remove-tz"]).variants.map((v) => v.id),
      ["remove-tz"],
    );
    assert.equal(parse(["-n", "4"]).repetitions, 4);
    assert.equal(runCliProcess(["run", "-n", "0"], { cwd }).code, 2);
    assert.equal(runCliProcess(["run", "--variant", "nope"], { cwd }).code, 2);
  });

  it("discloses external providers and fails clearly without a key", () => {
    const cwd = tempDir();
    writeJson(
      path.join(cwd, "memimpact.config.json"),
      fixtureConfig({ runner: { type: "openai-compatible", baseUrl: "https://api.example.invalid/v1", model: "m", apiKeyEnv: "MEMIMPACT_TEST_ABSENT_KEY" } }),
    );
    const r = runCliProcess(["run"], { cwd, env: { MEMIMPACT_TEST_ABSENT_KEY: "" } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /MEMIMPACT_TEST_ABSENT_KEY is not set/);
  });

  it("never prints or stores secret values from the environment", () => {
    const cwd = tempDir();
    const secret = "my-very-secret-test-value-0042";
    writeFileSync(path.join(cwd, "leaky.mjs"), "process.stdout.write('leaked: ' + process.env.LEAKY_API_KEY)", "utf8");
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig({ runner: { type: "command", command: process.execPath, args: ["leaky.mjs"] }, repetitions: 1 }));
    const r = runCliProcess(["run", "--json"], { cwd, env: { LEAKY_API_KEY: secret } });
    assert.equal(r.code, 0, r.stderr);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret));
    assert.match(r.stdout, /leaked: \[REDACTED\]/);
    const runsDir = path.join(cwd, ".memimpact", "runs");
    for (const file of readdirSync(runsDir)) assert.doesNotMatch(readFileSync(path.join(runsDir, file), "utf8"), new RegExp(secret));
  });

  it("redacts secrets in progress lines for failed runs", () => {
    const cwd = tempDir();
    const secret = "progress-secret-test-value-0077";
    writeFileSync(path.join(cwd, "fail.mjs"), "process.stderr.write('debug ' + process.env.PROGRESS_TOKEN); process.exit(1)", "utf8");
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig({ runner: { type: "command", command: process.execPath, args: ["fail.mjs"] }, repetitions: 1 }));
    const r = runCliProcess(["run", "--no-save"], { cwd, env: { PROGRESS_TOKEN: secret } });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /FAILED: .*debug \[REDACTED\]/);
    assert.doesNotMatch(r.stdout + r.stderr, new RegExp(secret));
  });

  it("rejects an unknown variant before announcing the run", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const r = runCliProcess(["run", "--variant", "nope"], { cwd });
    assert.equal(r.code, 2);
    assert.doesNotMatch(r.stderr, /Running/);
    assert.match(r.stderr, /Unknown variant "nope"/);
  });
});

describe("memimpact compare / list / show", () => {
  it("compares two text files", () => {
    const cwd = tempDir();
    writeFileSync(path.join(cwd, "a.txt"), "Use PostgreSQL for relational data.", "utf8");
    writeFileSync(path.join(cwd, "b.txt"), "Use MongoDB for document data.", "utf8");
    const r = runCliProcess(["compare", "a.txt", "b.txt"], { cwd });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Impact:\s+MEDIUM/);
    assert.match(r.stdout, /Single run per condition/);
    assert.match(r.stdout, /Only in baseline: postgresql, relational/);
    assert.equal(runCliProcess(["compare", "a.txt", "b.txt", "--fail-on", "medium"], { cwd }).code, 1);
    assert.equal(runCliProcess(["compare", "a.txt", "a.txt", "--fail-on", "low"], { cwd }).code, 0);
    const dir = runCliProcess(["compare", ".", "a.txt"], { cwd });
    assert.equal(dir.code, 2);
    assert.match(dir.stderr, /is not a file/);
  });

  it("compares structured JSON files", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "a.json"), { database: "PostgreSQL", hosting: "Vercel" });
    writeJson(path.join(cwd, "b.json"), { database: "MongoDB", hosting: "Vercel" });
    const r = runCliProcess(["compare", "a.json", "b.json", "--json"], { cwd });
    assert.equal(r.code, 0);
    const parsed = JSON.parse(r.stdout) as { impact: { level: string }; comparison: { structured: { fields: { path: string; status: string }[] } } };
    assert.equal(parsed.impact.level, "high");
    assert.deepEqual(
      parsed.comparison.structured.fields.map((f) => [f.path, f.status]),
      [
        ["database", "changed"],
        ["hosting", "unchanged"],
      ],
    );
  });

  it("compares saved runs by reference, lists and shows experiments", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const run = runCliProcess(["run", "--json"], { cwd });
    const id = (JSON.parse(run.stdout) as { experimentId: string }).experimentId;
    const cmp = runCliProcess(["compare", `${id}:baseline`, `${id}:remove-db#2`], { cwd });
    assert.equal(cmp.code, 0, cmp.stderr);
    assert.match(cmp.stdout, /database\s+CHANGED/);
    assert.equal(runCliProcess(["compare", `${id}:baseline`, `${id}:nope`], { cwd }).code, 2);
    assert.equal(runCliProcess(["compare", `${id}:baseline#9`, `${id}:remove-db`], { cwd }).code, 2);
    assert.equal(runCliProcess(["compare", "missing.txt", `${id}:baseline`], { cwd }).code, 2);

    const list = runCliProcess(["list", "--json"], { cwd });
    assert.equal((JSON.parse(list.stdout) as { experimentId: string }[])[0]?.experimentId, id);
    const show = runCliProcess(["show", id], { cwd });
    assert.equal(show.code, 0);
    assert.match(show.stdout, new RegExp(`experiment ${id}`));
    assert.equal(runCliProcess(["show", "20990101-000000-abcdef"], { cwd }).code, 2);

    const artifact = path.join(".memimpact", "runs", `${id}.json`);
    const wrong = runCliProcess(["compare", artifact, "a"], { cwd });
    assert.equal(wrong.code, 2);
    assert.match(wrong.stderr, /experiment artifact/);
  });

  it("refuses to compare runs whose outputs were not stored", () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig({ artifacts: { storeOutputs: false } }));
    const id = (JSON.parse(runCliProcess(["run", "--json"], { cwd }).stdout) as { experimentId: string }).experimentId;
    const r = runCliProcess(["compare", `${id}:baseline`, `${id}:remove-db`], { cwd });
    assert.equal(r.code, 2);
    assert.match(r.stderr, /storeOutputs = false/);
  });
});

describe("in-process CLI", () => {
  it("returns the same exit codes without spawning", async () => {
    const cwd = tempDir();
    writeJson(path.join(cwd, "memimpact.config.json"), fixtureConfig());
    const r = await runCliInProcess(["run", "--no-save", "--quiet"], cwd);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Summary/);
    assert.equal((await runCliInProcess(["nope"], cwd)).code, 2);
  });
});