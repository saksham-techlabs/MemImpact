# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project uses
[Semantic Versioning](https://semver.org/).

## [0.1.0] - Unreleased

Initial version. Not yet published.

### Added

- CLI commands `init`, `validate`, `run`, `compare`, `list`, `show`, `help` and
  `--version`.
- Strict config validation with all errors reported at once. It rejects
  duplicate IDs, unknown memory references, no-op variants, unknown keys,
  secret-looking values and credential headers. Memories can also be loaded
  read-only from `memoriesFile`.
- Memory mutations: `remove`, `replace`, `modify` (literal find/replace) and
  `add`. Automatic leave-one-out variants via `run --all` and `run --memory`.
- Runners: deterministic `fixture`, `openai-compatible` (BYOK; works with
  hosted APIs and local servers such as Ollama) and `command` (a user-supplied
  executable, run without a shell, with a text or envelope protocol).
- Comparison engine: exact and normalized equality, Myers-diff word-sequence
  similarity, line and word changes, length change, Markdown sections,
  distinctive terms, structured JSON field comparison (with decision and
  ignore paths) and tool-call sequence comparison.
- Repetitions with a measured noise floor and noise-adjusted distance.
  Transparent `NONE`/`LOW`/`MEDIUM`/`HIGH` classification with evidence and
  an evidence basis (`single-run`, `above-noise`, `within-noise`,
  `no-difference`).
- Per-variant expectations (`minImpact`/`maxImpact`) and `--fail-on`, with
  exit codes `0`/`1`/`2`.
- Human and JSON reports. Local run artifacts in `.memimpact/` with an
  automatic `.gitignore` and privacy options `storeMemoryContent` and
  `storeOutputs`.
- Secret redaction for console output, JSON output, artifacts and errors.
- JSON Schema for the config, offline examples, documentation and a CI
  workflow for Ubuntu, Windows and macOS on Node 22 and 24.
