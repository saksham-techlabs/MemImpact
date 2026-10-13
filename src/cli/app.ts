import { existsSync, readFileSync, statSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs, type ParseArgsConfig } from "node:util";
import { compareRunSets } from "../compare/aggregate.js";
import { DEFAULT_CONFIG_FILE, loadConfig } from "../config/load.js";
import { DEFAULT_ARTIFACT_DIR, DEFAULT_THRESHOLDS } from "../config/validate.js";
import { EXIT_CODES, MemImpactError, UsageError, errorMessage } from "../core/errors.js";
import { assessImpact, DISCLAIMER, levelRank } from "../core/impact.js";
import { Redactor } from "../core/redact.js";
import { VERSION } from "../core/version.js";
import { EXPERIMENT_ID_PATTERN, runExperiment, selectVariants, type ProgressEvent } from "../experiments/run.js";
import { renderCompare, renderExperiment, renderExperimentList } from "../reporters/human.js";
import { renderJson } from "../reporters/json.js";
import { shouldUseColor } from "../reporters/style.js";
import { createRunner, secretEnvNames } from "../runners/index.js";
import { applyArtifactPrivacy, isExperimentResult, listExperiments, loadExperiment, saveExperiment } from "../storage/artifacts.js";
import { IMPACT_LEVELS, STRUCTURED_MODES, type CompareResult, type ImpactLevel, type RunRecord, type StructuredMode } from "../types/index.js";
import { COMMAND_HELP, MAIN_HELP } from "./help.js";
import { AGENT_FILE, AGENT_TEMPLATE, configTemplate, INIT_RUNNERS, type InitRunner } from "./templates.js";

export interface CliIO {
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  cwd: string;
  env: NodeJS.ProcessEnv;
  color: boolean;
}

const COMMON_OPTIONS = {
  config: { type: "string", short: "c" },
  json: { type: "boolean" },
  "no-color": { type: "boolean" },
  help: { type: "boolean", short: "h" },
} as const satisfies ParseArgsConfig["options"];

const COMMAND_OPTIONS = {
  init: { runner: { type: "string" }, force: { type: "boolean" } },
  validate: {},
  run: {
    variant: { type: "string", multiple: true },
    memory: { type: "string", multiple: true },
    all: { type: "boolean" },
    repetitions: { type: "string", short: "n" },
    "fail-on": { type: "string" },
    "no-save": { type: "boolean" },
    verbose: { type: "boolean", short: "v" },
    quiet: { type: "boolean", short: "q" },
  },
  compare: {
    structured: { type: "string" },
    "decision-path": { type: "string", multiple: true },
    "ignore-path": { type: "string", multiple: true },
    "fail-on": { type: "string" },
    dir: { type: "string" },
    verbose: { type: "boolean", short: "v" },
  },
  list: { dir: { type: "string" } },
  show: { dir: { type: "string" }, verbose: { type: "boolean", short: "v" } },
} as const satisfies Record<string, ParseArgsConfig["options"]>;

type CommandName = keyof typeof COMMAND_OPTIONS;
const POSITIONALS: Record<CommandName, [number, number]> = {
  init: [0, 0],
  validate: [0, 0],
  run: [0, 0],
  compare: [2, 2],
  list: [0, 0],
  show: [1, 1],
};

type Values = Record<string, string | boolean | string[] | undefined>;

function parseCommand(command: CommandName, args: string[]): { values: Values; positionals: string[] } {
  try {
    const parsed = parseArgs({
      args,
      options: { ...COMMON_OPTIONS, ...COMMAND_OPTIONS[command] },
      allowPositionals: true,
      strict: true,
    });
    return { values: parsed.values as Values, positionals: parsed.positionals };
  } catch (error) {
    throw new UsageError(errorMessage(error), [`Run "memimpact help ${command}" for usage.`]);
  }
}

function parseLevel(value: unknown, flag: string): ImpactLevel | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !(IMPACT_LEVELS as readonly string[]).includes(value) || value === "none") {
    throw new UsageError(`${flag} must be one of: low, medium, high`);
  }
  return value as ImpactLevel;
}

function relative(io: CliIO, file: string): string {
  const rel = path.relative(io.cwd, file);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel) ? rel : file;
}

function configPathOf(values: Values): string {
  return typeof values["config"] === "string" ? values["config"] : DEFAULT_CONFIG_FILE;
}

/** Artifacts dir: --dir, else the config's artifacts.dir (relative to the config file), else ./.memimpact */
function resolveArtifactDir(io: CliIO, values: Values): string {
  if (typeof values["dir"] === "string") return path.resolve(io.cwd, values["dir"]);
  const configFile = path.resolve(io.cwd, configPathOf(values));
  if (existsSync(configFile)) {
    try {
      const data = JSON.parse(readFileSync(configFile, "utf8").replace(/^\uFEFF/, "")) as { artifacts?: { dir?: unknown } };
      const dir = data.artifacts?.dir;
      return path.resolve(path.dirname(configFile), typeof dir === "string" && dir.trim() ? dir : DEFAULT_ARTIFACT_DIR);
    } catch {
      /* fall through to default */
    }
  }
  return path.resolve(io.cwd, DEFAULT_ARTIFACT_DIR);
}

async function cmdInit(io: CliIO, values: Values): Promise<number> {
  const runner = (values["runner"] ?? "fixture") as string;
  if (!(INIT_RUNNERS as readonly string[]).includes(runner)) {
    throw new UsageError(`--runner must be one of: ${INIT_RUNNERS.join(", ")}`);
  }
  const target = path.resolve(io.cwd, configPathOf(values));
  if (existsSync(target) && !values["force"]) {
    throw new UsageError(`${relative(io, target)} already exists`, ["Use --force to overwrite it."]);
  }
  await writeFile(target, configTemplate(runner as InitRunner), "utf8");
  const created = [relative(io, target)];
  if (runner === "command") {
    const agent = path.join(path.dirname(target), AGENT_FILE);
    if (!existsSync(agent) || values["force"]) {
      await writeFile(agent, AGENT_TEMPLATE, "utf8");
      created.push(relative(io, agent));
    }
  }
  if (values["json"]) {
    io.stdout(renderJson({ created, runner }));
    return EXIT_CODES.ok;
  }
  const lines = [`Created ${created.join(" and ")} (runner: ${runner})`, "", "Next steps:"];
  if (runner === "fixture") {
    lines.push("  memimpact run            # offline demo with a deterministic fixture runner");
  } else if (runner === "openai-compatible") {
    lines.push("  1. Edit runner.baseUrl and runner.model for your local server or provider.");
    lines.push("  2. For a hosted provider, add \"apiKeyEnv\": \"MEMIMPACT_API_KEY\" and export your OWN key:");
    lines.push("       export MEMIMPACT_API_KEY=...        (PowerShell: $env:MEMIMPACT_API_KEY = \"...\")");
    lines.push("  3. memimpact run");
  } else {
    lines.push(`  1. Replace the logic in ${AGENT_FILE} with a call to your agent.`);
    lines.push("  2. memimpact run");
  }
  lines.push("", "Run artifacts are written to .memimpact/ (git-ignored automatically). Never put API keys in the config.");
  io.stdout(lines.join("\n"));
  return EXIT_CODES.ok;
}

async function cmdValidate(io: CliIO, values: Values): Promise<number> {
  const loaded = await loadConfig(configPathOf(values), io.cwd);
  const { config } = loaded;
  const summary = {
    memories: config.memories.length,
    variants: config.variants.length,
    runner: config.runner.type,
    repetitions: config.repetitions,
  };
  if (values["json"]) {
    io.stdout(renderJson({ valid: true, config: relative(io, loaded.configPath), summary, warnings: loaded.warnings }));
    return EXIT_CODES.ok;
  }
  const lines = [
    `✓ Config is valid: ${relative(io, loaded.configPath)}`,
    `  ${summary.memories} memories · ${summary.variants} variants · runner ${summary.runner} · ${summary.repetitions} repetition(s) per condition`,
  ];
  for (const w of loaded.warnings) lines.push(`  warning: ${w}`);
  io.stdout(lines.join("\n"));
  return EXIT_CODES.ok;
}

function progressPrinter(io: CliIO, redactor: Redactor): (event: ProgressEvent) => void {
  return (event) => {
    if (event.type !== "run-end") return;
    const r = event.record;
    const status = r.status === "ok" ? "ok" : `FAILED: ${redactor.redact(r.error ?? "error")}`;
    io.stderr(`  ${event.condition} #${event.repetition}/${event.total} ${status} (${r.durationMs}ms)`);
  };
}

async function cmdRun(io: CliIO, values: Values): Promise<number> {
  const loaded = await loadConfig(configPathOf(values), io.cwd);
  const failOn = parseLevel(values["fail-on"], "--fail-on");
  let repetitions: number | undefined;
  if (values["repetitions"] !== undefined) {
    const n = Number(values["repetitions"]);
    if (!Number.isInteger(n) || n < 1 || n > 50) throw new UsageError("--repetitions must be an integer from 1 to 50");
    repetitions = n;
  }
  const json = Boolean(values["json"]);
  const quiet = Boolean(values["quiet"]);
  const selection = {
    variantIds: values["variant"] as string[] | undefined,
    memoryIds: values["memory"] as string[] | undefined,
    all: Boolean(values["all"]),
  };
  selectVariants(loaded, selection);
  const redactor = new Redactor({ envNames: secretEnvNames(loaded), env: io.env });
  const runner = createRunner(loaded, io.env);
  const info = runner.info();

  for (const w of loaded.warnings) io.stderr(`warning: ${w}`);
  if (info.external) {
    io.stderr(
      `notice: this experiment sends the task and memory content to an EXTERNAL provider (${info.endpoint ?? "unknown"}), using your own API key. Nothing else is uploaded by MemImpact.`,
    );
  } else if (info.type === "command") {
    io.stderr(`notice: the task and memories are passed to the local command "${info.command ?? ""}"; that command may forward them elsewhere.`);
  }
  if (!json && !quiet) io.stderr(`Running ${loaded.config.task.length > 60 ? `${loaded.config.task.slice(0, 57)}...` : loaded.config.task}`);

  const raw = await runExperiment(loaded, {
    runner,
    repetitions,
    ...selection,
    onProgress: !json && !quiet ? progressPrinter(io, redactor) : undefined,
  });
  const result = redactor.redactDeep(raw);

  const artifacts = loaded.config.artifacts;
  let savedTo: string | undefined;
  if (artifacts.save && !values["no-save"]) {
    const dir = path.resolve(loaded.baseDir, artifacts.dir);
    const stored = applyArtifactPrivacy(result, artifacts);
    const { runFile } = await saveExperiment(dir, stored, renderExperiment(stored, { color: false }));
    savedTo = relative(io, runFile);
  }

  if (json) io.stdout(renderJson(result));
  else {
    io.stdout(renderExperiment(result, { color: io.color, verbose: Boolean(values["verbose"]) }));
    if (savedTo) io.stdout(`\nSaved: ${savedTo} (local only; never uploaded)`);
  }
  if (json && savedTo) io.stderr(`saved: ${savedTo}`);

  if (result.summary.failedRuns > 0 || result.summary.variantErrors > 0) return EXIT_CODES.error;
  if (result.summary.expectationsFailed > 0) return EXIT_CODES.expectationFailed;
  if (failOn && result.summary.highest && levelRank(result.summary.highest) >= levelRank(failOn)) {
    if (!json) io.stderr(`--fail-on ${failOn}: highest impact is ${result.summary.highest.toUpperCase()}`);
    return EXIT_CODES.expectationFailed;
  }
  return EXIT_CODES.ok;
}

const RUN_REF = /^([^:]+):([A-Za-z0-9][A-Za-z0-9._-]*)(?:#(\d+))?$/;

async function resolveCompareInput(io: CliIO, values: Values, ref: string): Promise<{ label: string; run: RunRecord }> {
  const file = path.resolve(io.cwd, ref);
  if (existsSync(file)) {
    if (!statSync(file).isFile()) throw new UsageError(`${ref} is not a file`);
    const text = await readFile(file, "utf8");
    try {
      if (isExperimentResult(JSON.parse(text))) {
        throw new UsageError(`${ref} is an experiment artifact, not a single output`, ["Reference a run inside it as <experiment-id>:<condition>[#repetition]."]);
      }
    } catch (error) {
      if (error instanceof UsageError) throw error;
    }
    return { label: ref, run: { id: ref, condition: ref, repetition: 1, startedAt: "", durationMs: 0, memoryIds: [], status: "ok", output: text } };
  }
  const match = RUN_REF.exec(ref);
  if (!match || !EXPERIMENT_ID_PATTERN.test(match[1] as string)) {
    throw new UsageError(`"${ref}" is neither an existing file nor a run reference`, ["Run references look like <experiment-id>:<condition>[#repetition], e.g. 20261014-101500-a1b2c3:baseline"]);
  }
  const [, experimentId, condition, rep] = match as unknown as [string, string, string, string | undefined];
  const experiment = await loadExperiment(resolveArtifactDir(io, values), experimentId);
  if (!experiment.privacy.outputsStored) throw new UsageError(`Experiment ${experimentId} was saved with artifacts.storeOutputs = false; outputs are not available`);
  const runs = condition === "baseline" ? experiment.baseline.runs : experiment.variants.find((v) => v.id === condition)?.runs;
  if (!runs) {
    throw new UsageError(`Condition "${condition}" not found in ${experimentId}`, [`Available: baseline, ${experiment.variants.map((v) => v.id).join(", ")}`]);
  }
  const repetition = rep === undefined ? 1 : Number(rep);
  const run = runs.find((r) => r.repetition === repetition);
  if (!run) throw new UsageError(`Repetition #${repetition} not found for ${experimentId}:${condition}`);
  if (run.status !== "ok") throw new UsageError(`Run ${ref} failed during the experiment and has no output`);
  return { label: ref, run };
}

async function cmdCompare(io: CliIO, values: Values, positionals: string[]): Promise<number> {
  const structured = (values["structured"] ?? "auto") as string;
  if (!(STRUCTURED_MODES as readonly string[]).includes(structured)) throw new UsageError(`--structured must be one of: ${STRUCTURED_MODES.join(", ")}`);
  const failOn = parseLevel(values["fail-on"], "--fail-on");
  const a = await resolveCompareInput(io, values, positionals[0] as string);
  const b = await resolveCompareInput(io, values, positionals[1] as string);
  const comparison = compareRunSets([a.run], [b.run], {
    structured: structured as StructuredMode,
    decisionPaths: (values["decision-path"] as string[] | undefined) ?? [],
    ignorePaths: (values["ignore-path"] as string[] | undefined) ?? [],
  });
  const impact = assessImpact(comparison, DEFAULT_THRESHOLDS);
  const redactor = new Redactor({ env: io.env });
  const result: CompareResult = redactor.redactDeep({
    kind: "memimpact.comparison",
    schemaVersion: 1,
    a: a.label,
    b: b.label,
    comparison,
    impact,
    disclaimer: DISCLAIMER,
  });
  if (values["json"]) io.stdout(renderJson(result));
  else io.stdout(renderCompare(result, { color: io.color, verbose: Boolean(values["verbose"]) }));
  if (failOn && levelRank(impact.level) >= levelRank(failOn)) return EXIT_CODES.expectationFailed;
  return EXIT_CODES.ok;
}

async function cmdList(io: CliIO, values: Values): Promise<number> {
  const dir = resolveArtifactDir(io, values);
  const experiments = await listExperiments(dir);
  if (values["json"]) {
    io.stdout(
      renderJson(
        experiments.map((e) => ({
          experimentId: e.experimentId,
          name: e.name ?? null,
          createdAt: e.createdAt,
          variants: e.summary.variants,
          highest: e.summary.highest,
          byLevel: e.summary.byLevel,
        })),
      ),
    );
  } else {
    io.stdout(`${renderExperimentList(experiments)}\n${experiments.length} experiment(s) in ${relative(io, dir)}`);
  }
  return EXIT_CODES.ok;
}

async function cmdShow(io: CliIO, values: Values, positionals: string[]): Promise<number> {
  const experiment = await loadExperiment(resolveArtifactDir(io, values), positionals[0] as string);
  if (values["json"]) io.stdout(renderJson(experiment));
  else io.stdout(renderExperiment(experiment, { color: io.color, verbose: Boolean(values["verbose"]) }));
  return EXIT_CODES.ok;
}

function reportError(io: CliIO, error: unknown, json: boolean): number {
  const redactor = new Redactor({ env: io.env });
  const known = error instanceof MemImpactError;
  const message = redactor.redact(errorMessage(error));
  const details = known ? error.details.map((d) => redactor.redact(d)) : [];
  const kind = known ? error.kind : "runtime";
  if (json) {
    io.stdout(renderJson({ error: { kind, message, details } }));
  } else {
    io.stderr(`error: ${message}`);
    for (const d of details) io.stderr(`  ${d}`);
    if (!known && error instanceof Error && error.stack && io.env["MEMIMPACT_DEBUG"]) io.stderr(redactor.redact(error.stack));
  }
  return EXIT_CODES.error;
}

export async function runCli(argv: string[], io: CliIO): Promise<number> {
  const json = argv.includes("--json");
  try {
    const [first, ...rest] = argv;
    if (first === undefined || first === "--help" || first === "-h") {
      io.stdout(MAIN_HELP);
      return EXIT_CODES.ok;
    }
    if (first === "--version" || first === "-V" || first === "version") {
      io.stdout(VERSION);
      return EXIT_CODES.ok;
    }
    if (first === "help") {
      const topic = rest[0];
      if (topic === undefined) io.stdout(MAIN_HELP);
      else if (COMMAND_HELP[topic]) io.stdout(COMMAND_HELP[topic]);
      else throw new UsageError(`Unknown command "${topic}"`);
      return EXIT_CODES.ok;
    }
    if (!(first in COMMAND_OPTIONS)) {
      throw new UsageError(`Unknown command "${first}"`, ['Run "memimpact --help" to see available commands.']);
    }
    const command = first as CommandName;
    const { values, positionals } = parseCommand(command, rest);
    if (values["help"]) {
      io.stdout(COMMAND_HELP[command] ?? MAIN_HELP);
      return EXIT_CODES.ok;
    }
    if (values["no-color"]) io = { ...io, color: false };
    const [min, max] = POSITIONALS[command];
    if (positionals.length < min || positionals.length > max) {
      throw new UsageError(
        min === max && min === 0 ? `"${command}" takes no positional arguments (got: ${positionals.join(" ")})` : `"${command}" expects ${min === max ? min : `${min}-${max}`} argument(s)`,
        [COMMAND_HELP[command]?.split("\n")[0] ?? ""],
      );
    }
    switch (command) {
      case "init":
        return await cmdInit(io, values);
      case "validate":
        return await cmdValidate(io, values);
      case "run":
        return await cmdRun(io, values);
      case "compare":
        return await cmdCompare(io, values, positionals);
      case "list":
        return await cmdList(io, values);
      case "show":
        return await cmdShow(io, values, positionals);
    }
  } catch (error) {
    return reportError(io, error, json);
  }
}

export function defaultIO(): CliIO {
  return {
    stdout: (text) => process.stdout.write(`${text}\n`),
    stderr: (text) => process.stderr.write(`${text}\n`),
    cwd: process.cwd(),
    env: process.env,
    color: shouldUseColor(process.stdout),
  };
}
