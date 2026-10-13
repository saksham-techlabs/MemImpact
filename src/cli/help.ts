import { VERSION } from "../core/version.js";

export const MAIN_HELP = `memimpact ${VERSION} — local-first memory impact debugger for AI agents

Change one memory. Replay the same task. See exactly what changed.

Usage:
  memimpact <command> [options]

Commands:
  init                 Create memimpact.config.json (offline fixture demo by default)
  validate             Validate the config without running anything
  run                  Run the baseline and every variant, compare, and report
  compare <a> <b>      Compare two outputs (files or saved runs)
  list                 List saved experiments
  show <experiment>    Re-render a saved experiment report

Global options:
  -c, --config <path>  Config file (default: memimpact.config.json)
      --json           Machine-readable JSON on stdout
      --no-color       Disable colored output (NO_COLOR is also respected)
  -h, --help           Show help (use "memimpact help <command>" for details)
      --version        Print the version

Exit codes:
  0  completed; all expectations met
  1  completed, but an expectation or --fail-on threshold failed
  2  usage, configuration or runtime error (including failed runner calls)

Docs: README.md · docs/ · examples/`;

export const COMMAND_HELP: Record<string, string> = {
  init: `Usage: memimpact init [--runner fixture|openai-compatible|command] [--force] [-c <path>]

Creates a config file. The default "fixture" runner works fully offline so you
can try MemImpact immediately. "openai-compatible" targets a local
Ollama-compatible endpoint by default (edit baseUrl/model for your provider).
"command" also writes memimpact-agent.mjs, a sample agent script.

Options:
  --runner <type>   Runner template (default: fixture)
  --force           Overwrite an existing config file`,
  validate: `Usage: memimpact validate [-c <path>] [--json]

Validates the config strictly (unknown keys, duplicate IDs, unknown memory
references, no-op variants, secret-looking values) without calling any runner.`,
  run: `Usage: memimpact run [options]

Runs the task with the full memory set (baseline), then once per variant with
exactly one controlled memory change, and compares the outputs.

Options:
  -c, --config <path>     Config file (default: memimpact.config.json)
      --variant <id>      Run only this configured variant (repeatable)
      --memory <id>       Run variants targeting this memory; if none exist, an
                          automatic "remove" variant is generated (repeatable)
      --all               Configured variants plus an automatic "remove"
                          variant for every memory (leave-one-out ablation)
  -n, --repetitions <n>   Override repetitions per condition (1-50)
      --fail-on <level>   Exit 1 if any variant reaches low|medium|high
      --no-save           Do not write artifacts to the artifacts directory
      --json              Print the full experiment result as JSON
  -v, --verbose           Show full outputs, all fields and a line diff
  -q, --quiet             Hide progress output`,
  compare: `Usage: memimpact compare <a> <b> [options]

Compares two outputs with the same engine used by "run". Each argument is
either a file path (text or JSON output) or a saved run reference:

  <experiment-id>:<condition>[#repetition]
  e.g. 20261014-101500-a1b2c3:baseline   20261014-101500-a1b2c3:remove-db#2

A single pair cannot measure run-to-run variation, so the impact level is
reported as single-run evidence.

Options:
      --structured <mode>    auto|always|never (default: auto)
      --decision-path <p>    Treat JSON path as a decision field (repeatable)
      --ignore-path <p>      Ignore JSON path (repeatable)
      --fail-on <level>      Exit 1 if impact reaches low|medium|high
      --dir <path>           Artifacts directory for run references
      --json                 JSON output
  -v, --verbose              Show all fields`,
  list: `Usage: memimpact list [--dir <path>] [-c <path>] [--json]

Lists experiments saved in the artifacts directory (default: .memimpact next
to the config file).`,
  show: `Usage: memimpact show <experiment-id> [--dir <path>] [-c <path>] [--json] [-v]

Re-renders the report for a saved experiment.`,
};
