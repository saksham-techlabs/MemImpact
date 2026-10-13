// Internal consistency checks run by `npm run check` after the build:
// - package.json, src/core/version.ts and CHANGELOG agree on the version
// - the JSON schema lists the same runner/variant types as the code
// - every example config validates, and every offline example runs with all
//   expectations met (exit code 0)
// - required open-source files exist
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const cli = path.join(root, "dist", "cli", "main.js");
const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
  else console.log(`ok - ${message}`);
};

const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
const { VERSION } = await import(new URL(`file:///${path.join(root, "dist", "core", "version.js").replace(/\\/g, "/")}`).href);
const types = await import(new URL(`file:///${path.join(root, "dist", "types", "index.js").replace(/\\/g, "/")}`).href);
check(VERSION === pkg.version, `version.ts (${VERSION}) matches package.json (${pkg.version})`);
check(readFileSync(path.join(root, "CHANGELOG.md"), "utf8").includes(`## [${pkg.version}]`), "CHANGELOG has an entry for the current version");

const schema = JSON.parse(readFileSync(path.join(root, "schema", "memimpact.config.schema.json"), "utf8"));
const schemaRunners = schema.$defs.runner.oneOf.map((s) => s.properties.type.const).sort();
const schemaVariants = schema.$defs.variant.oneOf.map((s) => s.properties.type.const).sort();
check(JSON.stringify(schemaRunners) === JSON.stringify([...types.RUNNER_TYPES].sort()), "schema runner types match code");
check(JSON.stringify(schemaVariants) === JSON.stringify([...types.VARIANT_TYPES].sort()), "schema variant types match code");
check(
  JSON.stringify(schema.$defs.impactLevel.enum) === JSON.stringify([...types.IMPACT_LEVELS]),
  "schema impact levels match code",
);

for (const file of ["README.md", "LICENSE", "SECURITY.md", "CONTRIBUTING.md", "CHANGELOG.md", ".gitignore", ".github/workflows/ci.yml", "docs/impact.md", "docs/configuration.md", "docs/privacy.md"]) {
  check(existsSync(path.join(root, file)), `${file} exists`);
}

const examplesDir = path.join(root, "examples");
const offline = new Set(["preferences", "structured-decision", "command-agent"]);
for (const example of readdirSync(examplesDir, { withFileTypes: true }).filter((d) => d.isDirectory())) {
  const dir = path.join(examplesDir, example.name);
  for (const config of readdirSync(dir).filter((f) => f.endsWith(".json"))) {
    const v = spawnSync(process.execPath, [cli, "validate", "-c", config], { cwd: dir, encoding: "utf8" });
    check(v.status === 0, `examples/${example.name}/${config} validates${v.status === 0 ? "" : `: ${v.stderr}`}`);
  }
  if (offline.has(example.name)) {
    const r = spawnSync(process.execPath, [cli, "run", "--no-save", "--json"], { cwd: dir, encoding: "utf8" });
    let detail = "";
    if (r.status === 0) {
      const result = JSON.parse(r.stdout);
      detail = result.variants.map((v) => `${v.id}=${v.impact.level}`).join(", ");
    }
    check(r.status === 0, `examples/${example.name} runs offline with all expectations met (${detail || r.stderr || r.stdout})`);
  }
}

if (failures.length > 0) {
  console.error(`\n${failures.length} internal check(s) failed:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log("\nAll internal checks passed.");
