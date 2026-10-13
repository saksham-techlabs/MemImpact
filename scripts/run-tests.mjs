// Runs the compiled test suite with the built-in node:test runner.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const testDir = path.join(root, ".test-build", "tests");

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) return collect(full);
    return entry.name.endsWith(".test.js") ? [full] : [];
  });
}

const files = collect(testDir).sort();
if (files.length === 0) {
  console.error("No compiled test files found in", testDir);
  process.exit(1);
}
const result = spawnSync(process.execPath, ["--test", "--test-reporter=spec", ...process.argv.slice(2), ...files], {
  cwd: root,
  stdio: "inherit",
  env: { ...process.env, NO_COLOR: "1" },
});
process.exit(result.status ?? 1);
