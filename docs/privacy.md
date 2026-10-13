# Privacy and data handling

Memory often contains personal or confidential information. This page lists
exactly what MemImpact does with it.

## What MemImpact itself does

- **No telemetry, no hosted backend and no account.** MemImpact makes no
  network requests of its own.
- **No automatic uploads.** Run artifacts are written to a local directory,
  `.memimpact/` by default, and are never sent anywhere.
- **Read-only inputs.** Your config file and `memoriesFile` are read and never
  modified. Variants are applied to in-memory copies. MemImpact has no code
  path that writes to a memory store, database or agent.

## When data leaves your machine

Data leaves your machine only through the runner **you** configure:

| Runner | Where the task and memory content go |
| --- | --- |
| `fixture` | Nowhere. Fully offline |
| `openai-compatible` with a `localhost` / `127.0.0.1` / `::1` URL | Your local server |
| `openai-compatible` with any other URL | That provider, using your API key. MemImpact prints a notice to stderr at the start of each `memimpact run` |
| `command` | The program you configured. It may forward data elsewhere, and MemImpact prints a notice saying so |

Each run sends the task, the optional system prompt and the content of the
memories in that condition.

## Run artifacts

`memimpact run` writes these files:

- `.memimpact/runs/<experiment-id>.json` holds the full result: task, memories,
  outputs, tool calls, comparisons and metadata.
- `.memimpact/reports/<experiment-id>.txt` holds the human-readable report.
- `.memimpact/.gitignore` contains `*`, so the directory is ignored by git even
  when your repository has no ignore rule for it.

To reduce what is stored:

```json
"artifacts": { "storeMemoryContent": false, "storeOutputs": false }
```

You can also pass `--no-save` or set `"artifacts": { "save": false }` to write
nothing. You can delete `.memimpact/` at any time.

Artifacts store the config file's **name** and a SHA-256 hash of its contents.
They do not store its absolute path.

## Secrets

See [SECURITY.md](../SECURITY.md). In short:

- API keys are only ever read from environment variables. They are never
  accepted in the config, and config values that look like keys are rejected.
- Before anything is printed or written to disk, MemImpact redacts the values
  of the configured key variable. It also redacts the values of any environment
  variable whose name contains `KEY`, `TOKEN`, `SECRET`, `PASSWORD`, `PASSWD`,
  `CREDENTIAL` or `AUTH`, as well as common key formats such as `sk-…`,
  `ghp_…`, `AIza…`, `xox…-`, `AKIA…` and `Bearer …`.
- Redaction is a safety net, not a guarantee. It cannot recognise a secret that
  has an unusual format and is not in an environment variable.
