# Configuration reference

MemImpact reads one JSON file, `memimpact.config.json` by default. To use a
different file, pass `--config <path>`. Relative paths inside the config are
resolved from the config file's directory: `memoriesFile`, `artifacts.dir` and
`runner.cwd`.

Validation is strict. Unknown keys, wrong types, duplicate IDs, unknown memory
references, no-op variants and values that look like API keys are all errors,
and every error is reported at once. To check a config without running
anything, use `memimpact validate`.

For editor completion you can point `$schema` at the bundled schema:

```json
{ "$schema": "./node_modules/memimpact/schema/memimpact.config.schema.json" }
```

The CLI validator is authoritative. The JSON Schema covers shape only, not
cross-references.

## Top level

| Key | Type | Default | Description |
| --- | --- | --- | --- |
| `version` | `1` | required | Config format version |
| `name` | string | — | Shown in reports and `memimpact list` |
| `description` | string | — | Free text |
| `task` | string | required | The task replayed identically in every run |
| `system` | string | — | Optional system prompt, placed before the memory block |
| `memoryPreamble` | string | `"Stored memory about the user and project (use it when relevant):"` | Heading above the rendered memories |
| `memories` | Memory[] | required\* | The full memory set used for the baseline |
| `memoriesFile` | string | — | \*Alternative to `memories`: a JSON file with an array or `{ "memories": [...] }`. MemImpact reads it and never writes it |
| `variants` | Variant[] | required | Controlled changes. The array may be empty if you only use `run --all` |
| `runner` | Runner | required | How each run is executed |
| `repetitions` | integer 1–50 | `1` | Runs per condition (baseline and each variant) |
| `compare` | object | see below | Comparison options |
| `impact.thresholds` | `{low, medium, high}` | `0.05 / 0.2 / 0.5` | See [impact.md](impact.md) |
| `artifacts` | object | see below | Local storage options |

## Memory

```json
{ "id": "database-preference", "content": "User prefers PostgreSQL over MongoDB.", "tags": ["stack"], "source": "export-2026-10-01" }
```

`id` must be 1–64 characters long. It can contain letters, digits, `.`, `_`
and `-`, and must start with a letter or digit. `id`s are never shown to the
model. Runners only see `content`, and the command runner also receives
`id`s.

## Variants

Every variant has an `id` (unique, not `baseline`), a `type`, an optional
`description`, and an optional `expect`:

```json
"expect": { "minImpact": "medium", "maxImpact": "high" }
```

If the observed level falls outside the expected range, `memimpact run` exits
with code `1`.

| Type | Fields | Effect |
| --- | --- | --- |
| `remove` | `memoryId` | Drop the memory |
| `replace` | `memoryId`, `content` | Replace the memory's whole content. The new content must differ from the original |
| `modify` | `memoryId`, `find`, `replaceWith` | Replace every literal occurrence of `find` (no regex). `find` must occur in the memory. Use `""` as `replaceWith` to delete text |
| `add` | `memory` | Append a new memory. Its id must not already exist |

Each variant changes exactly one memory, so the baseline and the variant differ
in one controlled way. Mutations are applied to in-memory copies. MemImpact
never edits your config, your `memoriesFile` or any memory store.

### Automatic variants

`memimpact run --memory <id>` runs the configured variants that target that
memory. If none exist, it generates `auto-remove-<id>`.

`memimpact run --all` runs every configured variant. It also adds an automatic
`remove` variant for each memory that has no configured `remove` variant. This
is a leave-one-out ablation over the whole memory set.

## Runners

### `fixture`

A deterministic, rule-based stand-in for a model, used for demos, tests and CI.
Rules are checked in order and the first matching rule wins.

```json
{
  "type": "fixture",
  "rules": [
    { "when": { "contextIncludes": ["concise"] }, "output": "Short answer." },
    { "when": { "memoryAbsent": ["db"] }, "output": { "database": "MongoDB" }, "toolCalls": [{ "name": "search" }] },
    { "outputs": ["Long answer, phrasing A.", "Long answer, phrasing B."] }
  ]
}
```

`when` supports these conditions. All listed conditions must hold, and text
matching is case-insensitive.

- `memoryPresent` and `memoryAbsent`: memory ids
- `contextIncludes` and `contextExcludes`: substrings of the joined memory contents
- `taskIncludes`: substrings of the task

`output` is a string or a JSON value. A JSON value is pretty-printed into the
output. `outputs` cycles by repetition number to simulate run-to-run variation.
If no rule matches, the run fails. Add a final rule without `when` as a default.

### `openai-compatible`

| Key | Default | Description |
| --- | --- | --- |
| `baseUrl` | required | e.g. `http://localhost:11434/v1`, `https://api.openai.com/v1`. Requests go to `{baseUrl}/chat/completions` |
| `model` | required | Model name as the endpoint expects it |
| `apiKeyEnv` | — | **Name** of the env var holding your key. If set, the variable must exist. If omitted, `MEMIMPACT_API_KEY` is used when set; otherwise no `Authorization` header is sent, which suits local servers |
| `temperature` | `0` | Sampling temperature |
| `seed` | — | Passed through if set. Not every provider honours it |
| `maxTokens` | — | Sent as `max_tokens` |
| `timeoutMs` | `120000` | Per-request timeout |
| `responseFormat` | `"text"` | `"json"` sends `response_format: {"type": "json_object"}` |
| `tools` | — | OpenAI-format tool definitions, passed through so tool *choices* can be compared. MemImpact never executes tools |
| `headers` | — | Extra **non-secret** headers. Credential headers (`Authorization`, `x-api-key`, `api-key`, `cookie`, or any name containing KEY/TOKEN/SECRET/…) are rejected |

The prompt sends one system message, made of `system` followed by the memory
block, and one user message containing `task`.

### `command`

| Key | Default | Description |
| --- | --- | --- |
| `command` | required | Executable: on `PATH` (e.g. `node`, `python3`) or an absolute path. It runs **without a shell** |
| `args` | `[]` | Arguments, passed verbatim |
| `cwd` | config dir | Working directory, relative to the config file |
| `timeoutMs` | `120000` | The process is killed after this. Processes it spawned itself may keep running |
| `protocol` | `"text"` | `"text"`: stdout is the output. `"envelope"`: stdout is `{ "output", "toolCalls"?, "usage"?, "model"? }` |
| `env` | — | Extra non-secret environment variables. Secret-looking names are rejected; export those in your shell instead |
| `inheritEnv` | `true` | When `true`, the command receives your full environment, including API keys. When `false`, only a minimal system environment is passed (`PATH`, `HOME`, temp dirs, …) |

The input arrives on stdin as JSON:
`{ memimpact: 1, task, system, memories, prompt: { system, user }, repetition }`.
The environment also contains `MEMIMPACT=1`. The agent is not told which
condition (baseline or variant) it is running.

On Windows, `.cmd` and `.bat` files cannot be spawned without a shell. Call the
underlying program instead (e.g. `node script.js`), or use
`"command": "cmd.exe", "args": ["/d", "/s", "/c", "your.cmd"]`.

## `compare`

| Key | Default | Description |
| --- | --- | --- |
| `structured` | `"auto"` | `auto`: compare JSON when every output contains JSON. `always`: same, but add a note when parsing fails. `never`: text only |
| `decisionPaths` | `[]` | JSON paths whose change means HIGH. An empty list treats every field as a decision field |
| `ignorePaths` | `[]` | JSON paths excluded from structured comparison, e.g. ids, timestamps and free-text explanations |

Paths use dot and bracket notation: `database`, `services[0].name`,
`a["key with spaces"]`. A pattern also matches every path nested under it.

## `artifacts`

| Key | Default | Description |
| --- | --- | --- |
| `dir` | `.memimpact` | Relative to the config file |
| `save` | `true` | Set `false`, or pass `--no-save`, to write nothing |
| `storeMemoryContent` | `true` | `false` replaces memory text in artifacts with `[omitted sha256:… length:…]` |
| `storeOutputs` | `true` | `false` replaces outputs, field values, tool arguments, distinctive terms and Markdown section titles in artifacts with hashes. `compare` cannot use these runs |

These privacy options affect files on disk only. Console and `--json` output
always show full results.
