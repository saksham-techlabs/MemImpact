# MemImpact

**A local-first memory impact debugger for AI agents.**

> Change one memory. Replay the same task. See exactly what changed.

MemImpact runs your agent's task twice: once with its full memory set (the
**baseline**) and once with exactly one controlled memory change (a
**variant**). It then compares the outputs, structured decisions and tool calls,
and writes an evidence-based report. That report tells you whether the memory
had an observable effect, and how large the effect was.

- **Local-first.** Runs on your machine. No hosted backend, no account, no telemetry.
- **Bring your own key or model.** Works with any OpenAI-compatible endpoint
  (hosted or local, e.g. Ollama), any executable you write, or a deterministic
  fixture.
- **Honest about randomness.** Repetitions, a measured noise floor, and explicit
  wording that separates an *observed difference* from *proven causation*.
- **Zero runtime dependencies.** TypeScript, Node.js 22+, MIT licensed.

> **Status:** v0.1.0, pre-release. Not yet published to npm. See [Installation](#installation).

---

## Contents

1. [Why memory impact debugging matters](#why-memory-impact-debugging-matters)
2. [A simple example](#a-simple-example)
3. [Installation](#installation)
4. [Quick start](#quick-start)
5. [Configuration](#configuration)
6. [Memory mutations](#memory-mutations)
7. [Runners](#runners)
8. [BYOK setup](#byok-setup)
9. [Comparison methods](#comparison-methods)
10. [Impact levels](#impact-levels)
11. [Repetitions and randomness](#repetitions-and-randomness)
12. [JSON output](#json-output)
13. [CLI reference and exit codes](#cli-reference-and-exit-codes)
14. [Privacy](#privacy)
15. [Security](#security)
16. [Limitations](#limitations)
17. [CI and research usage](#ci-and-research-usage)
18. [Roadmap](#roadmap)
19. [Contributing](#contributing)
20. [License](#license)

---

## Why memory impact debugging matters

Agents increasingly rely on stored memory: user preferences, corrections,
project facts, standing instructions, earlier decisions and long-term context.
When an agent behaves unexpectedly, or when you curate a memory store,
developers usually cannot answer these questions:

- Did this memory actually affect the agent's behavior?
- What exactly changed when it was present or absent?
- Did the structured decision change, or only the wording?
- Did the agent call different tools?
- Is the difference larger than the agent's normal run-to-run variation?

Reading prompts does not answer these questions. A controlled experiment does.
MemImpact makes that experiment one command.

## A simple example

The stored memory is: *"User prefers PostgreSQL over MongoDB."*

| | Memory set | Agent's answer |
| --- | --- | --- |
| Baseline | full memory set | `{"database": "PostgreSQL", "hosting": "Vercel"}` |
| Variant `remove-db-preference` | same set **without** that memory | `{"database": "MongoDB", "hosting": "Vercel"}` |

MemImpact reports:

```text
━━ Variant: remove-db-preference
  Memory change:  Removed memory "database-preference"
  Impact:         HIGH
  Evidence basis: Difference exceeds measured run-to-run variation (3 baseline / 3 variant runs)

  Observed changes
    - Decision field `database` changed: "PostgreSQL" → "MongoDB"
    - Mean word-sequence similarity 35.3% → raw distance 0.647; noise floor 0.039 from
      within-condition self-similarity; adjusted distance 0.608 (thresholds low 0.05, medium 0.2, high 0.5)

  Structured fields (JSON parsed in 3/3 baseline, 3/3 variant runs)
    database    CHANGED   "PostgreSQL" → "MongoDB"
    hosting     UNCHANGED "Vercel"

Important: Impact levels describe OBSERVED differences between baseline and variant runs under
this configured experiment. They are not proof of causal attribution ...
```

This excerpt is abridged from the bundled offline example in
[`examples/structured-decision`](examples/structured-decision).

## Installation

MemImpact requires **Node.js 22 or newer** and runs on Windows, macOS and Linux.

It is not published to npm yet. To use it today, install from source:

```bash
git clone https://github.com/saksham-techlabs/MemImpact.git memimpact
cd memimpact
npm install
npm run build
npm link            # optional: puts `memimpact` on your PATH
```

Without `npm link`, run `node /path/to/memimpact/dist/cli/main.js <command>`.

The package is structured for `npx memimpact …` once it is published.
Publishing has not happened yet.

## Quick start

```bash
mkdir memory-experiment && cd memory-experiment
memimpact init        # writes memimpact.config.json (offline fixture demo)
memimpact validate    # strict config validation, no runs
memimpact run         # baseline + variants, comparison, report
```

The default `init` template uses the deterministic **fixture** runner, so the
first run works without any model or API key. To point it at a real model:

```bash
memimpact init --runner openai-compatible --force   # local Ollama endpoint by default
memimpact init --runner command --force             # your own agent script (writes a sample)
```

Every `run` saves its result under `.memimpact/` (git-ignored automatically):

```bash
memimpact list                                    # saved experiments
memimpact show <experiment-id>                    # re-render a report
memimpact compare <id>:baseline <id>:remove-db-preference#2
```

## Configuration

```json
{
  "version": 1,
  "name": "database-preference",
  "task": "Design the database architecture for this SaaS. Reply with JSON containing database and hosting.",
  "memories": [
    { "id": "database-preference", "content": "User prefers PostgreSQL over MongoDB." },
    { "id": "hosting", "content": "Project is deployed on Vercel." }
  ],
  "variants": [
    { "id": "remove-db-preference", "type": "remove", "memoryId": "database-preference", "expect": { "minImpact": "high" } }
  ],
  "runner": {
    "type": "openai-compatible",
    "baseUrl": "http://localhost:11434/v1",
    "model": "llama3.2",
    "temperature": 0,
    "seed": 42
  },
  "repetitions": 3,
  "compare": { "decisionPaths": ["database", "hosting"] }
}
```

Validation is strict. It rejects unknown keys, duplicate IDs, references to
memories that do not exist, variants that would change nothing, and values that
look like API keys. All problems are reported in one pass.

- Full reference: [docs/configuration.md](docs/configuration.md)
- JSON Schema: [`schema/memimpact.config.schema.json`](schema/memimpact.config.schema.json)

Memories can also be loaded from a separate read-only file such as an export of
your agent's memory store: `"memoriesFile": "./memories.json"`.

## Memory mutations

Each variant applies **exactly one** controlled change to a copy of the memory
set:

| Type | Example | Effect |
| --- | --- | --- |
| `remove` | `{ "type": "remove", "memoryId": "db" }` | Memory is absent |
| `replace` | `{ "type": "replace", "memoryId": "db", "content": "User prefers MySQL." }` | Whole content replaced |
| `modify` | `{ "type": "modify", "memoryId": "db", "find": "PostgreSQL", "replaceWith": "MySQL" }` | Literal text edit |
| `add` | `{ "type": "add", "memory": { "id": "cache", "content": "Use Redis." } }` | New memory appended |

Two run flags generate variants for you:

- `memimpact run --all` adds an automatic `remove` variant for every memory.
  This is a leave-one-out ablation that shows which memories matter at all.
- `memimpact run --memory <id>` focuses on one memory and generates a removal
  if no variant targets it.

MemImpact **never** modifies your config, your memories file or any production
memory store.

## Runners

A runner executes one run: one task with one memory set. MemImpact is not
tied to any AI company.

| Runner | Use it for | Network |
| --- | --- | --- |
| `fixture` | Deterministic demos, tests, CI, learning the tool | None |
| `openai-compatible` | Hosted APIs that implement `POST /chat/completions`, plus local servers such as Ollama, llama.cpp server, LM Studio and vLLM | Only to the `baseUrl` you set |
| `command` | Your own agent, framework, wrapper or research harness, in any language | Whatever your program does |

The **command runner** spawns your program without a shell. It writes the run
input as JSON to stdin and reads the answer from stdout. The answer can be plain
text, or a JSON envelope with `output`, `toolCalls` and `usage`. The program is
not told whether it is running the baseline or a variant. See
[examples/command-agent](examples/command-agent).

## BYOK setup

You bring your own key. MemImpact has no API credentials of its own, and none
are needed for the fixture runner or keyless local servers.

1. In the config, name the environment variable that holds your key. Never put
   the key itself in the config:

   ```json
   "runner": { "type": "openai-compatible", "baseUrl": "https://api.openai.com/v1", "model": "<model>", "apiKeyEnv": "MEMIMPACT_API_KEY" }
   ```

2. Export your key in the shell:

   ```bash
   export MEMIMPACT_API_KEY="<your key>"          # macOS / Linux
   $env:MEMIMPACT_API_KEY = "<your key>"          # Windows PowerShell
   ```

3. Run `memimpact run`. Because the endpoint is not local, MemImpact prints a
   notice that the task and memory content will be sent to that provider.

If `apiKeyEnv` is omitted, MemImpact uses `MEMIMPACT_API_KEY` when it is set.
Otherwise it sends no `Authorization` header, which is what keyless local
servers expect.

Every request is billed by your provider. A full run makes
`repetitions × (1 + variants)` requests.

## Comparison methods

All comparisons are deterministic and local. No paid AI is used to judge the
outputs.

| Method | What it reports |
| --- | --- |
| Exact equality | byte-for-byte identical outputs |
| Normalized equality | identical after NFC, line-ending, whitespace and case normalization |
| Word-sequence similarity | Myers-diff based `2 × matches / total words`, from 0 to 100% |
| Line and word changes | added, removed and unchanged counts |
| Length change | characters and words, absolute and % |
| Sections | Markdown headings added, removed, changed or unchanged |
| Distinctive terms | words present in **every** baseline run and **no** variant run, and the reverse |
| Structured JSON | per-field `changed` / `unchanged` / `added` / `removed` / `mixed` across all repetitions, with `decisionPaths` and `ignorePaths` |
| Tool calls | sequence of tool names and arguments, plus tools only on one side |

JSON is detected when the whole output is JSON or when it contains a fenced
code block, either ` ```json ` or a plain ` ``` ` fence.

`memimpact compare a.txt b.txt` applies the same engine to any two files.
LLM-based semantic judging is not included in v0.1. If it is added later, it
will be optional and BYOK.

## Impact levels

| Level | Meaning (first matching rule) |
| --- | --- |
| **HIGH** | A decision field changed, **or** the tool-call sequence changed, **or** the noise-adjusted text distance is ≥ 0.5 |
| **MEDIUM** | Adjusted text distance ≥ 0.2, **or** a non-decision JSON field changed |
| **LOW** | Adjusted text distance ≥ 0.05, **or** a JSON field is *mixed* (values overlap between conditions, or vary within both) |
| **NONE** | Otherwise, including differences that are within the measured noise |

`adjusted distance = max(0, (1 − mean cross-condition similarity) − noise floor)`.

The thresholds are configurable defaults, not calibrated constants. Every
report lists the exact signals that produced its level. The full specification
is in [docs/impact.md](docs/impact.md).

## Repetitions and randomness

Language models can give different answers to the same prompt. A difference
between one baseline run and one variant run is therefore weak evidence. Here
is how MemImpact handles randomness:

- **Deterministic settings by default.** `temperature: 0` is sent unless you
  override it. `seed` is passed through if you set it. Not every provider
  honours these settings, and even then identical outputs are not guaranteed.
- **Repetitions.** With `repetitions: N`, MemImpact runs the baseline N times and
  each variant N times. It also measures how much runs differ *within* each
  condition.
- **Noise floor.** That within-condition variation is subtracted from the
  baseline-to-variant difference before classification. A difference that is no
  larger than the noise is classified NONE, with the evidence basis
  "within measured run-to-run variation".
- **Consistency for structured data.** A field counts as *changed* only if no
  value is shared between the baseline runs and the variant runs, and the
  values are stable on at least one side. Partially overlapping values, and
  values that vary on both sides (such as a free-text `reason` worded
  differently on every run), are reported as *mixed*. A mixed field can raise
  the level to LOW at most, and that LOW is labelled `within-noise`.
- **Explicit evidence basis.** Each verdict is labelled `single-run`,
  `above-noise`, `within-noise` or `no-difference`. `above-noise` compares the
  difference with the variation seen in your runs; it is not a statistical
  significance test.

Use `repetitions: 3` or more with real models. With `repetitions: 1`, the
report states that the memory's effect cannot be separated from run-to-run
variation. Reproducibility metadata is recorded with every experiment: ID,
timestamps, runner, model, endpoint, temperature, seed, memory IDs per run,
durations, provider-reported model name and token usage, and a config hash.

## JSON output

```bash
memimpact run --json > result.json
```

stdout contains a single JSON document. Progress and notices go to stderr. The
top-level shape is:

```jsonc
{
  "kind": "memimpact.experiment",
  "schemaVersion": 1,
  "experimentId": "20261014-101500-a1b2c3",
  "createdAt": "…", "finishedAt": "…", "durationMs": 12,
  "tool": { "name": "memimpact", "version": "0.1.0" },
  "config": { "file": "memimpact.config.json", "hash": "<sha256>" },
  "task": "…",
  "runner": { "type": "openai-compatible", "model": "…", "endpoint": "…", "external": true, "deterministic": false, "temperature": 0, "seed": 42 },
  "repetitions": 3,
  "memories": [ { "id": "…", "content": "…" } ],
  "baseline": { "memoryIds": [ … ], "runs": [ { "id": "baseline#1", "status": "ok", "output": "…", "usage": { … }, "durationMs": 830 } ] },
  "variants": [ {
    "id": "remove-db-preference", "type": "remove", "auto": false, "description": "Removed memory \"database-preference\"",
    "memoryIds": [ … ], "runs": [ … ],
    "comparison": { "noise": { … }, "representative": { … }, "structured": { "fields": [ … ] }, "tools": null, "terms": { … } },
    "impact": { "level": "high", "attribution": "above-noise", "evidence": [ "…" ], "signals": { … } },
    "expectation": { "passed": true, "message": "…" }
  } ],
  "summary": { "variants": 1, "byLevel": { "none": 0, "low": 0, "medium": 0, "high": 1 }, "highest": "high", "failedRuns": 0, "variantErrors": 0, "expectationsFailed": 0 },
  "privacy": { "memoryContentStored": true, "outputsStored": true },
  "disclaimer": "…"
}
```

`compare --json`, `validate --json` and `list --json` are also available. When
`--json` is set, errors are printed as `{"error": {"kind", "message", "details"}}`.

The package can also be used as a library: `import { loadConfig, runExperiment, createRunner } from "memimpact"`.

## CLI reference and exit codes

```text
memimpact init      [--runner fixture|openai-compatible|command] [--force]
memimpact validate  [-c <config>] [--json]
memimpact run       [-c <config>] [--variant <id>]… [--memory <id>]… [--all]
                    [-n <repetitions>] [--fail-on low|medium|high] [--no-save]
                    [--json] [-v|--verbose] [-q|--quiet]
memimpact compare   <a> <b> [--structured auto|always|never] [--decision-path <p>]…
                    [--ignore-path <p>]… [--fail-on <level>] [--dir <path>] [--json]
memimpact list      [--dir <path>] [--json]
memimpact show      <experiment-id> [--dir <path>] [--json] [-v]
memimpact help [command] · --help · --version
```

The `compare` arguments are file paths or saved-run references of the form
`<experiment-id>:<baseline|variant-id>[#repetition]`.

| Exit code | Meaning |
| --- | --- |
| `0` | Completed and all expectations met |
| `1` | Completed, but a variant's `expect` or the `--fail-on` threshold failed |
| `2` | Usage, configuration or runtime error, **including any failed runner call** (the report is still printed and saved) |

## Privacy

- MemImpact makes **no network requests of its own** and never uploads results.
- Data leaves your machine **only** through the runner you configure. A notice
  is printed when that runner is an external provider or an external command.
- Artifacts stay in `.memimpact/`, which contains a `.gitignore` with `*`, so
  nothing in it is committed by accident.
- `artifacts.storeMemoryContent: false` and `artifacts.storeOutputs: false`
  replace sensitive text in saved artifacts with hashes. Memory IDs, JSON field
  paths, tool names and the task are still stored. `--no-save` writes nothing
  at all. These options affect saved files only, not console or `--json`
  output.
- Your config, your `memoriesFile` and your memory stores are read-only to
  MemImpact.

Details: [docs/privacy.md](docs/privacy.md).

## Security

- **API keys come only from environment variables.** Config values that look
  like keys, credential headers, and secret-named `env` entries are rejected
  during validation.
- **Redaction before output.** Before anything is printed or written to disk,
  MemImpact redacts the values of the configured key variable. It also redacts
  values of any environment variable whose name contains
  KEY/TOKEN/SECRET/PASSWORD/CREDENTIAL/AUTH, and well-known key formats.
- **No shell.** The command runner uses `spawn` with `shell: false`, so `args`
  are never shell-expanded. Each process runs with a timeout and a 10 MB output
  cap.
- **Your command sees your environment.** By default the command runner
  inherits your full environment, including API keys, because most agents need
  them. Set `"inheritEnv": false` to pass only a minimal system environment.
- **A config is code.** A config chooses which command runs and which
  environment variable is sent as an API key to which `baseUrl`. Review a
  config from someone else before you run it.
- **No side effects on your systems.** MemImpact never executes model tool
  calls, edits memory stores, pushes code or deploys anything.

To report a vulnerability, see [SECURITY.md](SECURITY.md).

## Limitations

- **Observed difference is not proven causation.** MemImpact controls one
  variable, the memory change. It cannot rule out provider-side changes, caching
  or hidden state during the experiment. Treat results as evidence, not proof.
- **Lexical similarity.** Text comparison is word-based. Paraphrases look
  different, and small but critical wording changes (*do* versus *do not*) can
  look similar. For decisions that matter, ask for structured JSON and use
  `decisionPaths`.
- **Small samples.** A noise floor estimated from 3 runs is rough. The default
  thresholds are not calibrated against any benchmark.
- **Single-turn by default.** The OpenAI-compatible runner sends one
  system message and one user message. To test multi-turn agents, use the
  command runner with your own harness.
- **Cost and rate limits** belong to your provider. Runs are sequential.
- **No semantic or LLM judging** in v0.1.

## CI and research usage

Pin expectations in the config:

```json
{ "id": "remove-safety-rule", "type": "remove", "memoryId": "prod-read-only", "expect": { "minImpact": "high" } },
{ "id": "remove-irrelevant",  "type": "remove", "memoryId": "editor",         "expect": { "maxImpact": "none" } }
```

Then run it as a gate:

```yaml
- run: npx memimpact run --json --no-save > memimpact-result.json   # once published; or node dist/cli/main.js
```

The run exits `1` when an expectation fails and `2` when a runner call fails.
For research workflows:

- Use `--all` for leave-one-out ablation across a memory set.
- Use `--json` to feed results into analysis notebooks.
- Saved artifacts are self-describing (`schemaVersion: 1`) and carry the
  metadata needed to describe each run.

Use the `fixture` runner for CI checks that must be deterministic and free.
Use a real runner for scheduled evaluations.

## Roadmap

These are ideas, not commitments:

- Optional, BYOK semantic comparison (embedding similarity or LLM judge)
- Multi-turn conversation tasks for the OpenAI-compatible runner
- Statistical summaries for larger repetition counts (e.g. bootstrap intervals)
- Markdown and HTML report output
- Adapters for common memory-store export formats
- Concurrency controls for faster runs against providers that allow it

## Contributing

Contributions are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md). In short:

```bash
npm install
npm run check   # typecheck, lint, tests, build, internal validation, package smoke test
```

## License

[MIT](LICENSE) © Saksham Shrivastava
