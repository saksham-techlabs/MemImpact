// Package smoke test: packs the project with `npm pack`, installs the tarball
// into a fresh temporary project, and exercises the installed `memimpact` bin.
// Nothing is published; the tarball and temp project are deleted afterwards.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const root = path.resolve(import.meta.dirname, "..");
const isWindows = process.platform === "win32";
const work = mkdtempSync(path.join(tmpdir(), "memimpact-smoke "));

// Under `npm run`, npm_execpath points at npm's JS entry point, which runs
// without a shell. Otherwise .cmd shims need a shell on Windows; the shell
// joins arguments unquoted, so paths containing spaces are quoted explicitly.
const npmCli = process.env.npm_execpath && /\.c?js$/.test(process.env.npm_execpath) ? process.env.npm_execpath : null;
const npmShell = !npmCli && isWindows;

function run(cmd, args, cwd, { allowFail = false } = {}) {
  const shell = isWindows && cmd.endsWith(".cmd");
  const result = spawnSync(shell ? quoteIfNeeded(cmd) : cmd, args, { cwd, encoding: "utf8", shell, env: { ...process.env, NO_COLOR: "1" } });
  if (!allowFail && result.status !== 0) {
    throw new Error(`${cmd} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result;
}

function npm(args, cwd) {
  if (npmCli) return run(process.execPath, [npmCli, ...args], cwd);
  return run(isWindows ? "npm.cmd" : "npm", args.map((a) => (npmShell ? quoteIfNeeded(a) : a)), cwd);
}

function quoteIfNeeded(p) {
  return isWindows && p.includes(" ") ? `"${p}"` : p;
}

try {
  const pack = npm(["pack", "--json", "--pack-destination", work], root);
  const info = JSON.parse(pack.stdout)[0];
  const files = info.files.map((f) => f.path).sort();
  console.log(`packed ${info.filename} (${files.length} files, ${info.size} bytes)`);

  const forbidden = files.filter((f) => /^(src|tests|scripts|\.test-build|\.github|examples)\//.test(f) || f.includes(".memimpact") || f.endsWith(".tgz"));
  if (forbidden.length > 0) throw new Error(`unexpected files in package: ${forbidden.join(", ")}`);
  for (const required of ["dist/cli/main.js", "dist/index.js", "dist/index.d.ts", "schema/memimpact.config.schema.json", "README.md", "LICENSE", "package.json"]) {
    if (!files.includes(required)) throw new Error(`package is missing ${required}`);
  }

  const project = path.join(work, "consumer project");
  mkdirSync(project, { recursive: true });
  writeFileSync(path.join(project, "package.json"), JSON.stringify({ name: "consumer", private: true, type: "module" }), "utf8");
  const tarball = path.join(work, info.filename);
  npm(["install", "--no-audit", "--no-fund", "--ignore-scripts", tarball], project);

  const bin = path.join(project, "node_modules", "memimpact", "dist", "cli", "main.js");
  const version = run(process.execPath, [bin, "--version"], project).stdout.trim();
  if (version !== info.version) throw new Error(`--version printed ${version}, expected ${info.version}`);
  console.log(`installed bin reports version ${version}`);

  const binDir = path.join(project, "node_modules", ".bin");
  const shim = readdirSync(binDir).find((f) => f === (isWindows ? "memimpact.cmd" : "memimpact"));
  if (!shim) throw new Error("node_modules/.bin/memimpact shim was not created");
  const shimPath = path.join(binDir, shim);
  const viaShim = isWindows ? spawnSync(`"${shimPath}" --version`, { cwd: project, encoding: "utf8", shell: true }) : run(shimPath, ["--version"], project);
  if (viaShim.stdout.trim() !== info.version) throw new Error("bin shim did not run");
  console.log("bin shim works");

  run(process.execPath, [bin, "init"], project);
  run(process.execPath, [bin, "validate"], project);
  const result = run(process.execPath, [bin, "run", "--json"], project);
  const experiment = JSON.parse(result.stdout);
  if (experiment.summary.highest !== "high") throw new Error(`unexpected highest impact ${experiment.summary.highest}`);
  const list = run(process.execPath, [bin, "list"], project).stdout;
  if (!list.includes(experiment.experimentId)) throw new Error("list did not show the saved experiment");
  const failOn = run(process.execPath, [bin, "run", "--fail-on", "high", "--no-save", "-q"], project, { allowFail: true });
  if (failOn.status !== 1) throw new Error(`--fail-on high should exit 1, got ${failOn.status}`);

  const lib = run(process.execPath, ["--input-type=module", "-e", "import { VERSION, validateConfig } from 'memimpact'; console.log(VERSION, typeof validateConfig);"], project);
  if (!lib.stdout.includes(`${info.version} function`)) throw new Error(`library import failed: ${lib.stdout}`);
  console.log("library import works");

  console.log("\nPackage smoke test passed.");
} finally {
  rmSync(work, { recursive: true, force: true });
}
